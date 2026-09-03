use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::ThreadScopedOutgoingMessageSender;
use crate::thread_state::ThreadStateManager;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use codex_backend_client::ApiKeyTurnCost;
use codex_backend_client::ApiKeyTurnCostStatus;
use codex_backend_client::Client as BackendClient;
use codex_backend_client::RequestError;
use codex_config::types::OtelExporterKind;
use codex_core::config::Config;
use codex_login::AuthManager;
use codex_model_provider::SharedModelProvider;
use codex_model_provider::create_model_provider;
use codex_otel::SessionTelemetry;
use codex_otel::parse_turn_cost_microusd;
use codex_protocol::ThreadId;
use codex_protocol::auth::AuthMode;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;

const POLL_INTERVAL: Duration = Duration::from_secs(150);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OBSERVATION_CHANNEL_CAPACITY: usize = 16_384;
const MAX_TRACKED_TURNS: usize = 4_096;
const MAX_QUERY_TURNS: usize = 100;
const MAX_STALLED_POLL_ATTEMPTS: u8 = 5;
const MAX_DROPPED_TURNS: usize = OBSERVATION_CHANNEL_CAPACITY + MAX_TRACKED_TURNS;

#[derive(Default)]
struct DroppedTurnState {
    dropped: HashSet<String>,
    order: VecDeque<String>,
    active: HashSet<String>,
}

type DroppedTurns = Arc<StdMutex<DroppedTurnState>>;

pub(crate) struct TurnCostWorker {
    handle: TurnCostWorkerHandle,
    shutdown: CancellationToken,
    _task: JoinHandle<()>,
}

#[derive(Clone)]
pub(crate) struct TurnCostWorkerHandle {
    sender: mpsc::Sender<TurnCostObservation>,
    auth_manager: Arc<AuthManager>,
    auth_changes: tokio::sync::watch::Receiver<u64>,
    config: Arc<Config>,
    dropped_turns: DroppedTurns,
}

#[derive(Clone)]
pub(crate) struct TurnCostAvailabilityPolicy {
    config: Arc<Config>,
    auth_manager: Arc<AuthManager>,
    auth_changes: tokio::sync::watch::Receiver<u64>,
}

#[derive(Clone)]
pub(crate) struct TurnCostLateNotifier {
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
}

enum TurnCostObservationKind {
    Started {
        session_telemetry: Box<SessionTelemetry>,
    },
    ResponseCompleted,
    Finished {
        interrupted: bool,
    },
}

struct TurnCostObservation {
    thread_id: ThreadId,
    turn_id: String,
    auth_revision: u64,
    kind: TurnCostObservationKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnCostStatus {
    Running,
    Completed,
    Interrupted,
}

struct TurnCostEntry {
    thread_id: ThreadId,
    session_telemetry: SessionTelemetry,
    auth_revision: u64,
    expected_response_count: u64,
    status: TurnCostStatus,
    next_poll_at: Instant,
    attempt_count: u8,
}

struct WorkerRuntime {
    config: Arc<Config>,
    auth_manager: Arc<AuthManager>,
    backend: TurnCostBackend,
    turns: HashMap<String, TurnCostEntry>,
    late_notifier: TurnCostLateNotifier,
    dropped_turns: DroppedTurns,
}

enum TurnCostBackend {
    OpenAiApiKey(Arc<AuthManager>),
    ModelProvider(SharedModelProvider),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendAvailability {
    AwaitingAuthChange,
    RetryProbe,
    Ready,
    Disabled,
}

fn has_explicit_otel_exporter(config: &Config) -> bool {
    matches!(
        config.otel.exporter,
        OtelExporterKind::OtlpHttp { .. } | OtelExporterKind::OtlpGrpc { .. }
    ) || matches!(
        config.otel.metrics_exporter,
        OtelExporterKind::OtlpHttp { .. } | OtelExporterKind::OtlpGrpc { .. }
    )
}

fn current_unavailable_auth_reason(
    auth_manager: &AuthManager,
    provider_requires_openai_auth: bool,
) -> Option<TurnCostAvailability> {
    match auth_manager.get_api_auth_mode() {
        Some(
            AuthMode::Chatgpt
            | AuthMode::ChatgptAuthTokens
            | AuthMode::Headers
            | AuthMode::AgentIdentity
            | AuthMode::PersonalAccessToken,
        ) => Some(TurnCostAvailability::SubscriptionAuthentication),
        Some(AuthMode::ApiKey) => None,
        Some(AuthMode::BedrockApiKey) if provider_requires_openai_auth => {
            Some(TurnCostAvailability::BackendUnavailable)
        }
        Some(AuthMode::BedrockApiKey) => None,
        None if provider_requires_openai_auth => Some(TurnCostAvailability::BackendUnavailable),
        None => None,
    }
}

fn current_auth_snapshot(
    auth_manager: &AuthManager,
    auth_changes: &tokio::sync::watch::Receiver<u64>,
    provider_requires_openai_auth: bool,
) -> (u64, Option<TurnCostAvailability>) {
    loop {
        let revision_before = *auth_changes.borrow();
        let reason = current_unavailable_auth_reason(auth_manager, provider_requires_openai_auth);
        let revision_after = *auth_changes.borrow();
        if revision_before == revision_after {
            return (revision_after, reason);
        }
    }
}

fn new_dropped_turns() -> DroppedTurns {
    Arc::new(StdMutex::new(DroppedTurnState::default()))
}

fn evict_dropped_history(dropped_turns: &mut DroppedTurnState) {
    while dropped_turns.dropped.len() > MAX_DROPPED_TURNS {
        let Some(oldest) = dropped_turns.order.pop_front() else {
            break;
        };
        dropped_turns.dropped.remove(&oldest);
    }
}

fn register_active_turn(dropped_turns: &DroppedTurns, turn_id: &str) -> bool {
    let mut dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let inserted = dropped_turns.active.insert(turn_id.to_string());
    if inserted && dropped_turns.dropped.contains(turn_id) {
        dropped_turns.order.retain(|queued| queued != turn_id);
    }
    inserted
}

fn mark_turn_dropped(dropped_turns: &DroppedTurns, turn_id: &str) -> bool {
    let mut dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !dropped_turns.dropped.insert(turn_id.to_string()) {
        return false;
    }
    if !dropped_turns.active.contains(turn_id) {
        dropped_turns.order.push_back(turn_id.to_string());
    }
    // ponytail: live invalidations stay pinned; only completed history is evictable.
    evict_dropped_history(&mut dropped_turns);
    true
}

fn terminalize_dropped_turn(dropped_turns: &DroppedTurns, turn_id: &str) {
    let mut dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let newly_dropped = dropped_turns.dropped.insert(turn_id.to_string());
    let was_active = dropped_turns.active.remove(turn_id);
    if newly_dropped || was_active {
        dropped_turns.order.push_back(turn_id.to_string());
    }
    evict_dropped_history(&mut dropped_turns);
}

fn clear_dropped_turn(dropped_turns: &DroppedTurns, turn_id: &str) {
    let mut dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let was_active = dropped_turns.active.remove(turn_id);
    if dropped_turns.dropped.remove(turn_id) && !was_active {
        dropped_turns.order.retain(|queued| queued != turn_id);
    }
    evict_dropped_history(&mut dropped_turns);
}

impl TurnCostAvailabilityPolicy {
    pub(crate) fn new(config: Arc<Config>, auth_manager: Arc<AuthManager>) -> Self {
        let auth_changes = auth_manager.auth_change_receiver();
        Self {
            config,
            auth_manager,
            auth_changes,
        }
    }

    pub(crate) fn classify(&self, thread_config: &Config) -> TurnCostState {
        self.classify_with_revision(thread_config).0
    }

    pub(crate) fn classify_with_revision(&self, thread_config: &Config) -> (TurnCostState, u64) {
        let (auth_revision, auth_reason) = current_auth_snapshot(
            self.auth_manager.as_ref(),
            &self.auth_changes,
            thread_config.model_provider.requires_openai_auth,
        );
        let state = if auth_reason == Some(TurnCostAvailability::SubscriptionAuthentication) {
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::SubscriptionAuthentication,
            }
        } else if !has_explicit_otel_exporter(self.config.as_ref())
            || !has_explicit_otel_exporter(thread_config)
        {
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::CostObservationDisabled,
            }
        } else if self.config.model_provider.is_amazon_bedrock()
            || thread_config.model_provider.is_amazon_bedrock()
            || self.config.model_provider != thread_config.model_provider
        {
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::ProviderUnsupported,
            }
        } else {
            TurnCostState::Unavailable {
                reason: auth_reason.unwrap_or(TurnCostAvailability::AwaitingBackendPrice),
            }
        };
        (state, auth_revision)
    }
}

impl TurnCostLateNotifier {
    pub(crate) fn new(
        outgoing: Arc<OutgoingMessageSender>,
        thread_state_manager: ThreadStateManager,
    ) -> Self {
        Self {
            outgoing,
            thread_state_manager,
        }
    }

    async fn notify(&self, thread_id: ThreadId, turn_id: &str, cost: TurnCostState) {
        let connection_ids = self
            .thread_state_manager
            .subscribed_connection_ids(thread_id)
            .await;
        eprintln!("[probe-worker] notify turn={turn_id}: {} connections", connection_ids.len());
        if connection_ids.is_empty() {
            return;
        }
        ThreadScopedOutgoingMessageSender::new(
            Arc::clone(&self.outgoing),
            connection_ids,
            thread_id,
        )
        .send_server_notification(ServerNotification::TurnCostUpdated(
            TurnCostUpdatedNotification {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                cost,
            },
        ))
        .await;
    }
}

impl TurnCostWorker {
    pub(crate) fn spawn(
        config: Arc<Config>,
        auth_manager: Arc<AuthManager>,
        late_notifier: TurnCostLateNotifier,
    ) -> Option<Self> {
        if !has_explicit_otel_exporter(config.as_ref()) || config.model_provider.is_amazon_bedrock()
        {
            return None;
        }
        let backend = if config.model_provider.is_openai() {
            TurnCostBackend::OpenAiApiKey(Arc::clone(&auth_manager))
        } else {
            TurnCostBackend::ModelProvider(create_model_provider(
                config.model_provider.clone(),
                Some(Arc::clone(&auth_manager)),
            ))
        };
        let (sender, receiver) = mpsc::channel(OBSERVATION_CHANNEL_CAPACITY);
        let dropped_turns = new_dropped_turns();
        let shutdown = CancellationToken::new();
        let runtime = WorkerRuntime {
            config: Arc::clone(&config),
            auth_manager: Arc::clone(&auth_manager),
            backend,
            turns: HashMap::new(),
            late_notifier,
            dropped_turns: Arc::clone(&dropped_turns),
        };
        let worker_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            runtime.run(receiver, worker_shutdown).await;
        });
        Some(Self {
            handle: TurnCostWorkerHandle {
                sender,
                auth_changes: auth_manager.auth_change_receiver(),
                auth_manager,
                config,
                dropped_turns,
            },
            shutdown,
            _task: task,
        })
    }

    pub(crate) fn handle(&self) -> TurnCostWorkerHandle {
        self.handle.clone()
    }

    pub(crate) fn shutdown(&self) {
        self.shutdown.cancel();
    }
}

impl Drop for TurnCostWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl TurnCostWorkerHandle {
    pub(crate) fn observe_event(
        &self,
        thread_id: ThreadId,
        thread_config: &Config,
        event: &Event,
        classified_auth_revision: u64,
        session_telemetry: impl FnOnce() -> SessionTelemetry,
    ) -> Option<TurnCostState> {
        if thread_config.model_provider != self.config.model_provider {
            return None;
        }
        let (current_auth_revision, auth_reason) = current_auth_snapshot(
            self.auth_manager.as_ref(),
            &self.auth_changes,
            thread_config.model_provider.requires_openai_auth,
        );
        if current_auth_revision != classified_auth_revision || auth_reason.is_some() {
            return matches!(&event.msg, EventMsg::TurnStarted(_)).then_some(
                TurnCostState::Unavailable {
                    reason: auth_reason.unwrap_or(TurnCostAvailability::BackendUnavailable),
                },
            );
        }
        let kind = match &event.msg {
            EventMsg::TurnStarted(_) => TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry()),
            },
            EventMsg::RawResponseCompleted(_) => TurnCostObservationKind::ResponseCompleted,
            EventMsg::TurnComplete(_) => TurnCostObservationKind::Finished { interrupted: false },
            EventMsg::TurnAborted(_) => TurnCostObservationKind::Finished { interrupted: true },
            _ => return None,
        };
        if matches!(&kind, TurnCostObservationKind::Started { .. }) {
            register_active_turn(&self.dropped_turns, &event.id);
        }
        match self.sender.try_send(TurnCostObservation {
            thread_id,
            turn_id: event.id.clone(),
            auth_revision: classified_auth_revision,
            kind,
        }) {
            Ok(()) => None,
            Err(error) => {
                let observation = error.into_inner();
                let newly_dropped = mark_turn_dropped(&self.dropped_turns, &observation.turn_id);
                if matches!(observation.kind, TurnCostObservationKind::Finished { .. }) {
                    terminalize_dropped_turn(&self.dropped_turns, &observation.turn_id);
                }
                newly_dropped.then_some(TurnCostState::Unavailable {
                    reason: TurnCostAvailability::ObservationDropped,
                })
            }
        }
    }
}

impl WorkerRuntime {
    async fn run(self, receiver: mpsc::Receiver<TurnCostObservation>, shutdown: CancellationToken) {
        let auth_changes = Some(self.auth_manager.auth_change_receiver());
        let backend_availability = self.probe_backend().await;
        self.run_with_backend_availability(receiver, shutdown, auth_changes, backend_availability)
            .await;
    }

    async fn run_with_backend_availability(
        mut self,
        mut receiver: mpsc::Receiver<TurnCostObservation>,
        shutdown: CancellationToken,
        mut auth_changes: Option<tokio::sync::watch::Receiver<u64>>,
        mut backend_availability: BackendAvailability,
    ) {
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        let mut current_auth_revision = auth_changes
            .as_ref()
            .map(|auth_changes| *auth_changes.borrow())
            .unwrap_or_default();
        ticker.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                changed = async {
                    match auth_changes.as_mut() {
                        Some(auth_changes) => auth_changes.changed().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if changed.is_err() {
                        break;
                    }
                    let Some(auth_changes) = auth_changes.as_mut() else {
                        continue;
                    };
                    (current_auth_revision, backend_availability) =
                        self.refresh_auth_state(auth_changes).await;
                }
                observation = receiver.recv() => {
                    let Some(observation) = observation else {
                        break;
                    };
                    if let Some(auth_changes) = auth_changes.as_mut() {
                        loop {
                            let latest_auth_revision = *auth_changes.borrow();
                            if latest_auth_revision == current_auth_revision {
                                break;
                            }
                            (current_auth_revision, backend_availability) =
                                self.refresh_auth_state(auth_changes).await;
                        }
                    }
                    let finished = matches!(
                        &observation.kind,
                        TurnCostObservationKind::Finished { .. }
                    );
                    if self.discard_if_invalidated(&observation.turn_id) {
                        if finished {
                            clear_dropped_turn(&self.dropped_turns, &observation.turn_id);
                        }
                        continue;
                    }
                    if observation.auth_revision != current_auth_revision {
                        if matches!(&observation.kind, TurnCostObservationKind::Started { .. }) {
                            let reason = self.current_unavailable_auth_reason();
                            self.late_notifier
                                .notify(
                                    observation.thread_id,
                                    &observation.turn_id,
                                    TurnCostState::Unavailable { reason },
                                )
                                .await;
                            terminalize_dropped_turn(&self.dropped_turns, &observation.turn_id);
                        }
                        if finished {
                            clear_dropped_turn(&self.dropped_turns, &observation.turn_id);
                        }
                        continue;
                    }
                    if !matches!(
                        backend_availability,
                        BackendAvailability::Ready | BackendAvailability::RetryProbe
                    ) {
                        if matches!(&observation.kind, TurnCostObservationKind::Started { .. }) {
                            let reason = self.current_unavailable_auth_reason();
                            self.late_notifier
                                .notify(
                                    observation.thread_id,
                                    &observation.turn_id,
                                    TurnCostState::Unavailable { reason },
                                )
                                .await;
                            terminalize_dropped_turn(&self.dropped_turns, &observation.turn_id);
                        }
                        if finished {
                            clear_dropped_turn(&self.dropped_turns, &observation.turn_id);
                        }
                        continue;
                    }
                    self.record_observation(observation).await;
                }
                _ = ticker.tick() => {
                    eprintln!("[probe-worker] tick; ready={} entries={}", matches!(backend_availability, BackendAvailability::Ready), self.turns.len());
                    match backend_availability {
                        BackendAvailability::Ready => self.poll_due().await,
                        BackendAvailability::RetryProbe => {
                            let next_availability = self.probe_backend().await;
                            if matches!(
                                next_availability,
                                BackendAvailability::AwaitingAuthChange
                                    | BackendAvailability::Disabled
                            ) {
                                let reason = self.current_unavailable_auth_reason();
                                self.discard_all(reason).await;
                            }
                            backend_availability = next_availability;
                        }
                        BackendAvailability::AwaitingAuthChange
                        | BackendAvailability::Disabled => {}
                    }
                }
            }
        }
    }

    async fn refresh_auth_state(
        &mut self,
        auth_changes: &mut tokio::sync::watch::Receiver<u64>,
    ) -> (u64, BackendAvailability) {
        loop {
            while matches!(auth_changes.has_changed(), Ok(true)) {
                if auth_changes.changed().await.is_err() {
                    break;
                }
            }
            let (revision, reason) = current_auth_snapshot(
                self.auth_manager.as_ref(),
                auth_changes,
                self.config.model_provider.requires_openai_auth,
            );
            if matches!(auth_changes.has_changed(), Ok(true)) {
                continue;
            }
            self.terminalize_invalidated();
            self.discard_stale_entries(
                revision,
                reason.unwrap_or(TurnCostAvailability::BackendUnavailable),
            )
            .await;
            return (revision, self.probe_backend().await);
        }
    }

    async fn probe_backend(&self) -> BackendAvailability {
        let availability = self.probe_backend_inner().await;
        eprintln!("[probe-worker] probe -> {}", match availability { BackendAvailability::Ready => "ready", BackendAvailability::RetryProbe => "retry", BackendAvailability::AwaitingAuthChange => "awaiting-auth", BackendAvailability::Disabled => "disabled" });
        availability
    }

    async fn probe_backend_inner(&self) -> BackendAvailability {
        if current_unavailable_auth_reason(
            self.auth_manager.as_ref(),
            self.config.model_provider.requires_openai_auth,
        )
        .is_some()
        {
            return BackendAvailability::AwaitingAuthChange;
        }
        let probe_turn_ids = [uuid::Uuid::new_v4().to_string()];
        match tokio::time::timeout(REQUEST_TIMEOUT, self.query_turn_costs(&probe_turn_ids)).await {
            Ok(Ok(Some(_))) => BackendAvailability::Ready,
            Ok(Ok(None)) => match &self.backend {
                TurnCostBackend::OpenAiApiKey(_) => BackendAvailability::AwaitingAuthChange,
                TurnCostBackend::ModelProvider(_) => BackendAvailability::Disabled,
            },
            Ok(Err(error)) => match error.status().map(|status| status.as_u16()) {
                Some(401 | 403) if matches!(&self.backend, TurnCostBackend::OpenAiApiKey(_)) => {
                    tracing::debug!(
                        "turn cost worker waiting for auth change after backend availability check: {error}"
                    );
                    BackendAvailability::AwaitingAuthChange
                }
                Some(401 | 403 | 429) => BackendAvailability::RetryProbe,
                Some(400..=499) => {
                    tracing::debug!(
                        "turn cost worker disabled by backend availability check: {error}"
                    );
                    BackendAvailability::Disabled
                }
                _ => {
                    tracing::debug!(
                        "turn cost worker backend availability check failed temporarily: {error}"
                    );
                    BackendAvailability::RetryProbe
                }
            },
            Err(_) => {
                tracing::debug!(
                    "turn cost worker backend availability check timed out; will retry"
                );
                BackendAvailability::RetryProbe
            }
        }
    }

    async fn record_observation(&mut self, observation: TurnCostObservation) {
        let finished = matches!(&observation.kind, TurnCostObservationKind::Finished { .. });
        if self.discard_if_invalidated(&observation.turn_id) {
            if finished {
                clear_dropped_turn(&self.dropped_turns, &observation.turn_id);
            }
            return;
        }
        match observation.kind {
            TurnCostObservationKind::Started { session_telemetry } => {
                if self.turns.contains_key(&observation.turn_id) {
                    return;
                }
                if self.turns.len() >= MAX_TRACKED_TURNS {
                    if mark_turn_dropped(&self.dropped_turns, &observation.turn_id) {
                        self.late_notifier
                            .notify(
                                observation.thread_id,
                                &observation.turn_id,
                                TurnCostState::Unavailable {
                                    reason: TurnCostAvailability::ObservationDropped,
                                },
                            )
                            .await;
                    }
                    return;
                }
                self.turns.insert(
                    observation.turn_id,
                    TurnCostEntry {
                        thread_id: observation.thread_id,
                        session_telemetry: *session_telemetry,
                        auth_revision: observation.auth_revision,
                        expected_response_count: 0,
                        status: TurnCostStatus::Running,
                        next_poll_at: Instant::now(),
                        attempt_count: 0,
                    },
                );
            }
            TurnCostObservationKind::ResponseCompleted => {
                if let Some(entry) = self.turns.get_mut(&observation.turn_id)
                    && entry.status == TurnCostStatus::Running
                {
                    entry.expected_response_count = entry.expected_response_count.saturating_add(1);
                }
            }
            TurnCostObservationKind::Finished { interrupted } => {
                let Some(entry) = self.turns.get_mut(&observation.turn_id) else {
                    clear_dropped_turn(&self.dropped_turns, &observation.turn_id);
                    return;
                };
                if entry.status != TurnCostStatus::Running {
                    return;
                }
                entry.status = if interrupted {
                    TurnCostStatus::Interrupted
                } else {
                    TurnCostStatus::Completed
                };
                entry.next_poll_at = Instant::now();
            }
        }
    }

    async fn poll_due(&mut self) {
        self.discard_invalidated();
        let now = Instant::now();
        let due_turn_ids: Vec<String> = self
            .turns
            .iter()
            .filter(|(_, entry)| {
                entry.status != TurnCostStatus::Running && entry.next_poll_at <= now
            })
            .take(MAX_QUERY_TURNS)
            .map(|(turn_id, _)| turn_id.clone())
            .collect();
        eprintln!("[probe-worker] poll_due: due={} of {}", due_turn_ids.len(), self.turns.len());
        if !due_turn_ids.is_empty() {
            self.poll_api_key_entries(&due_turn_ids).await;
        }
    }

    async fn poll_api_key_entries(&mut self, turn_ids: &[String]) {
        let costs =
            match tokio::time::timeout(REQUEST_TIMEOUT, self.query_turn_costs(turn_ids)).await {
                Ok(Ok(Some(costs))) => costs,
                Ok(Ok(None)) => {
                    for turn_id in turn_ids {
                        self.discard_entry_if_auth_changed(turn_id).await;
                    }
                    return;
                }
                Ok(Err(error)) => {
                    eprintln!("[probe-worker] poll error {error}");
                    warn!("failed to query API-key turn costs: {error}");
                    self.retry_entries(turn_ids).await;
                    return;
                }
                Err(_) => {
                    eprintln!("[probe-worker] poll timed out");
                    warn!("timed out querying API-key turn costs");
                    self.retry_entries(turn_ids).await;
                    return;
                }
            };
        eprintln!("[probe-worker] poll returned {} costs", costs.len());
        let costs_by_turn: HashMap<String, ApiKeyTurnCost> = costs
            .into_iter()
            .map(|cost| (cost.turn_id.clone(), cost))
            .collect();
        for turn_id in turn_ids {
            let Some(cost) = costs_by_turn.get(turn_id) else {
                self.retry_entry(turn_id).await;
                continue;
            };
            self.process_api_key_cost(turn_id, cost).await;
        }
    }

    async fn query_turn_costs(
        &self,
        turn_ids: &[String],
    ) -> Result<Option<Vec<ApiKeyTurnCost>>, RequestError> {
        match &self.backend {
            TurnCostBackend::OpenAiApiKey(auth_manager) => {
                let Some(auth) = auth_manager.auth().await else {
                    return Ok(None);
                };
                if !auth.is_api_key_auth() {
                    return Ok(None);
                }
                let provider = self
                    .config
                    .model_provider
                    .to_api_provider(Some(AuthMode::ApiKey))
                    .map_err(|error| RequestError::Other(error.into()))?;
                let client = BackendClient::from_auth(self.config.chatgpt_base_url.clone(), &auth)
                    .map_err(RequestError::Other)?;
                client
                    .query_api_key_turn_costs(turn_ids, &provider.headers)
                    .await
                    .map(Some)
            }
            TurnCostBackend::ModelProvider(model_provider) => {
                if model_provider.info().requires_openai_auth {
                    let Some(auth) = model_provider.auth().await else {
                        return Ok(None);
                    };
                    if !auth.is_api_key_auth() {
                        return Ok(None);
                    }
                }
                let provider = model_provider
                    .api_provider()
                    .await
                    .map_err(|error| RequestError::Other(error.into()))?;
                let auth = model_provider
                    .api_auth()
                    .await
                    .map_err(|error| RequestError::Other(error.into()))?;
                let endpoint = provider.url_for_path("analytics/codex/turn-costs");
                let client = BackendClient::new(provider.base_url.clone())
                    .map_err(RequestError::Other)?
                    .with_auth_provider(auth);
                client
                    .query_api_key_turn_costs_at(&endpoint, turn_ids, &provider.headers)
                    .await
                    .map(Some)
            }
        }
    }

    async fn process_api_key_cost(&mut self, turn_id: &str, cost: &ApiKeyTurnCost) {
        eprintln!("[probe-worker] cost turn={turn_id} priced={} total={:?} events={:?}", cost.status == ApiKeyTurnCostStatus::Priced, cost.total_usd, cost.event_count);
        if self.discard_if_invalidated(turn_id) {
            eprintln!("[probe-worker] cost discarded (invalidated)");
            return;
        }
        if cost.status != ApiKeyTurnCostStatus::Priced {
            self.retry_entry(turn_id).await;
            return;
        }
        let response_count = cost
            .responses
            .as_ref()
            .map(|responses| responses.len() as u64)
            .or(cost.event_count);
        let (Some(total_usd), Some(response_count)) = (cost.total_usd.as_deref(), response_count)
        else {
            self.retry_entry(turn_id).await;
            return;
        };
        if parse_turn_cost_microusd(total_usd).is_none() {
            self.retry_entry(turn_id).await;
            return;
        }
        let Some(entry) = self.turns.get(turn_id) else {
            return;
        };
        if response_count < entry.expected_response_count {
            eprintln!("[probe-worker] cost retry: responses {response_count} < expected {}", entry.expected_response_count);
            self.retry_entry(turn_id).await;
            return;
        }
        if self.discard_entry_if_auth_changed(turn_id).await {
            eprintln!("[probe-worker] cost discarded (auth changed)");
            return;
        }
        let Some(entry) = self.turns.get(turn_id) else {
            eprintln!("[probe-worker] cost entry missing");
            return;
        };
        let mut session_telemetry = entry.session_telemetry.clone();
        if let Some(model) = cost.model.as_deref() {
            session_telemetry = session_telemetry.with_model(model, model);
        }
        let thread_id = entry.thread_id;
        let interrupted = entry.status == TurnCostStatus::Interrupted;
        session_telemetry.record_turn_cost(
            turn_id,
            total_usd,
            interrupted,
            cost.speed.as_deref(),
            cost.reasoning_effort.as_deref(),
        );
        self.late_notifier
            .notify(
                thread_id,
                turn_id,
                TurnCostState::Priced {
                    backend_total_usd: total_usd.to_string(),
                },
            )
            .await;
        self.remove_turn(turn_id);
    }

    async fn retry_entries(&mut self, turn_ids: &[String]) {
        for turn_id in turn_ids {
            self.retry_entry(turn_id).await;
        }
    }

    async fn retry_entry(&mut self, turn_id: &str) {
        if self.discard_entry_if_auth_changed(turn_id).await {
            return;
        }
        let thread_id = {
            let Some(entry) = self.turns.get_mut(turn_id) else {
                return;
            };
            entry.attempt_count = entry.attempt_count.saturating_add(1);
            if entry.attempt_count < MAX_STALLED_POLL_ATTEMPTS {
                entry.next_poll_at = Instant::now() + POLL_INTERVAL;
                return;
            }
            warn!(
                thread_id = %entry.thread_id,
                turn_id,
                attempts = MAX_STALLED_POLL_ATTEMPTS,
                "dropping turn cost event after repeated unsuccessful polls"
            );
            entry.thread_id
        };
        let reason = self.current_unavailable_auth_reason();
        self.late_notifier
            .notify(thread_id, turn_id, TurnCostState::Unavailable { reason })
            .await;
        self.remove_turn(turn_id);
    }

    async fn discard_all(&mut self, reason: TurnCostAvailability) {
        self.terminalize_invalidated();
        for (turn_id, thread_id) in self
            .turns
            .iter()
            .map(|(turn_id, entry)| (turn_id.clone(), entry.thread_id))
            .collect::<Vec<_>>()
        {
            self.late_notifier
                .notify(thread_id, &turn_id, TurnCostState::Unavailable { reason })
                .await;
            self.terminalize_turn(&turn_id);
        }
    }

    async fn discard_stale_entries(
        &mut self,
        current_auth_revision: u64,
        reason: TurnCostAvailability,
    ) {
        for (turn_id, thread_id) in self
            .turns
            .iter()
            .filter(|(_, entry)| entry.auth_revision != current_auth_revision)
            .map(|(turn_id, entry)| (turn_id.clone(), entry.thread_id))
            .collect::<Vec<_>>()
        {
            self.late_notifier
                .notify(thread_id, &turn_id, TurnCostState::Unavailable { reason })
                .await;
            self.terminalize_turn(&turn_id);
        }
    }

    async fn discard_entry_if_auth_changed(&mut self, turn_id: &str) -> bool {
        let Some(entry) = self.turns.get(turn_id) else {
            return false;
        };
        let thread_id = entry.thread_id;
        let entry_auth_revision = entry.auth_revision;
        let auth_changes = self.auth_manager.auth_change_receiver();
        let (current_auth_revision, auth_reason) = current_auth_snapshot(
            self.auth_manager.as_ref(),
            &auth_changes,
            self.config.model_provider.requires_openai_auth,
        );
        if entry_auth_revision == current_auth_revision && auth_reason.is_none() {
            return false;
        }
        self.late_notifier
            .notify(
                thread_id,
                turn_id,
                TurnCostState::Unavailable {
                    reason: auth_reason.unwrap_or(TurnCostAvailability::BackendUnavailable),
                },
            )
            .await;
        self.terminalize_turn(turn_id);
        true
    }

    fn current_unavailable_auth_reason(&self) -> TurnCostAvailability {
        current_unavailable_auth_reason(
            self.auth_manager.as_ref(),
            self.config.model_provider.requires_openai_auth,
        )
        .unwrap_or(TurnCostAvailability::BackendUnavailable)
    }

    fn remove_turn(&mut self, turn_id: &str) {
        let finished = self
            .turns
            .remove(turn_id)
            .is_some_and(|entry| entry.status != TurnCostStatus::Running);
        if finished {
            clear_dropped_turn(&self.dropped_turns, turn_id);
        }
    }

    fn terminalize_turn(&mut self, turn_id: &str) {
        self.turns.remove(turn_id);
        terminalize_dropped_turn(&self.dropped_turns, turn_id);
    }

    fn discard_if_invalidated(&mut self, turn_id: &str) -> bool {
        let invalidated = self
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .dropped
            .contains(turn_id);
        if invalidated {
            self.remove_turn(turn_id);
        }
        invalidated
    }

    fn discard_invalidated(&mut self) {
        let dropped_turns = self
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let invalidated_turns = self
            .turns
            .keys()
            .filter(|turn_id| dropped_turns.dropped.contains(*turn_id))
            .cloned()
            .collect::<Vec<_>>();
        drop(dropped_turns);
        for turn_id in invalidated_turns {
            self.remove_turn(&turn_id);
        }
    }

    fn terminalize_invalidated(&mut self) {
        let dropped_turns = self
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let invalidated_turns = self
            .turns
            .keys()
            .filter(|turn_id| dropped_turns.dropped.contains(*turn_id))
            .cloned()
            .collect::<Vec<_>>();
        drop(dropped_turns);
        for turn_id in invalidated_turns {
            self.terminalize_turn(&turn_id);
        }
    }
}

#[cfg(test)]
#[path = "turn_cost_worker_tests.rs"]
mod tests;

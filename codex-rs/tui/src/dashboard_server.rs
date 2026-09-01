//! Local HTTP server backing the `/dashboard` command: serves a minimal, static
//! HTML/CSS/JS page (see `dashboard_assets/index.html`) that polls `/data.json`
//! for the live state published from the chat widget.

use std::io::Cursor;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Mutex;

use chrono::Utc;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_protocol::TurnProfileSummary;
use serde::Deserialize;
use serde::Serialize;

use crate::activity_state::DashboardActivityState;
use crate::activity_state::DashboardActivityStatus as ProjectedActivityStatus;

const INDEX_HTML: &str = include_str!("dashboard_assets/index.html");
const SCHEMA_VERSION: u64 = 1;
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UNAVAILABLE_JSON: &[u8] = br#"{"state":null,"heartbeat_at":null}"#;

type DashboardResponse = tiny_http::Response<Cursor<Vec<u8>>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardState {
    pub(crate) schema_version: u64,
    pub(crate) revision: u64,
    pub(crate) generated_at: i64,
    pub(crate) context: DashboardContext,
    pub(crate) tokens: DashboardTokens,
    pub(crate) activity: DashboardActivity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardEnvelope {
    pub(crate) state: DashboardState,
    pub(crate) heartbeat_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardContext {
    pub(crate) model: String,
    pub(crate) used_tokens: Option<u64>,
    pub(crate) window_tokens: u64,
    pub(crate) used_percent: Option<i64>,
    pub(crate) categories: Option<Vec<DashboardCategory>>,
    pub(crate) saved_tokens: u64,
    pub(crate) sources: Vec<DashboardSource>,
    pub(crate) backtrack_points: usize,
    #[serde(default)]
    pub(crate) manual_memory: Option<DashboardManualMemory>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardCategory {
    pub(crate) label: String,
    pub(crate) tokens: u64,
    pub(crate) color: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardSource {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) estimated_tokens: u64,
    pub(crate) admitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardManualMemory {
    pub(crate) phase: DashboardManualMemoryPhase,
    pub(crate) state: Option<DashboardManualMemoryState>,
    pub(crate) request_chars_if_admitted: Option<usize>,
    pub(crate) eligible_chars_now: Option<usize>,
    pub(crate) limit_chars: Option<usize>,
    pub(crate) truncated: Option<bool>,
    pub(crate) unavailable_reason: Option<DashboardManualMemoryUnavailableReason>,
    #[serde(default)]
    pub(crate) admission_pending: bool,
}

impl DashboardManualMemory {
    pub(crate) fn loading() -> Self {
        Self {
            phase: DashboardManualMemoryPhase::Loading,
            state: None,
            request_chars_if_admitted: None,
            eligible_chars_now: None,
            limit_chars: None,
            truncated: None,
            unavailable_reason: None,
            admission_pending: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardManualMemoryPhase {
    Loading,
    Ready,
    Creating,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardManualMemoryState {
    Missing,
    AvailableNotAdmitted,
    Admitted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardManualMemoryUnavailableReason {
    AdmissionUnavailable,
    MemoryUnreadable,
    InvalidUtf8,
    MemoryPathNotFile,
    SourcesUnavailable,
    WorkerFailed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardTokens {
    pub(crate) session_total: Option<DashboardTokenTotals>,
    pub(crate) last_turn: Option<DashboardTokenTotals>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardTokenTotals {
    pub(crate) input: i64,
    pub(crate) cached_input: i64,
    pub(crate) output: i64,
    pub(crate) reasoning_output: i64,
    pub(crate) total: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardActivity {
    pub(crate) current: Option<DashboardCurrentTurn>,
    pub(crate) recent: Vec<DashboardRecentTurn>,
    pub(crate) automatic_pruning_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardCurrentTurn {
    pub(crate) status: DashboardActivityStatus,
    pub(crate) started_at: Option<i64>,
    pub(crate) cost: Option<DashboardCostState>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardRecentTurn {
    pub(crate) status: DashboardActivityStatus,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) time_to_first_token_ms: Option<i64>,
    pub(crate) profile: Option<DashboardTurnProfile>,
    pub(crate) cost: Option<DashboardCostState>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardActivityStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardTurnProfile {
    pub(crate) before_first_sampling_ms: u64,
    pub(crate) sampling_ms: u64,
    pub(crate) compaction_ms: u64,
    pub(crate) between_sampling_overhead_ms: u64,
    pub(crate) tool_blocking_ms: u64,
    pub(crate) after_last_sampling_ms: u64,
    pub(crate) sampling_request_count: u64,
    pub(crate) sampling_retry_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DashboardCostState {
    Unavailable { reason: DashboardCostAvailability },
    Priced { backend_total_usd: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardCostAvailability {
    SubscriptionAuthentication,
    CostObservationDisabled,
    ProviderUnsupported,
    AwaitingBackendPrice,
    BackendUnavailable,
    ObservationDropped,
}

#[cfg(test)]
std::thread_local! {
    // Capture call attempts before semantic de-duplication so same-state lifecycle rebinds remain
    // observable without sharing the process-global dashboard slot across parallel tests.
    static DASHBOARD_MANUAL_MEMORY_PUBLICATION_CAPTURE:
        std::cell::RefCell<Option<Vec<Option<DashboardManualMemory>>>> =
            const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn begin_manual_memory_publication_capture_for_test() {
    DASHBOARD_MANUAL_MEMORY_PUBLICATION_CAPTURE.with(|capture| {
        *capture.borrow_mut() = Some(Vec::new());
    });
}

#[cfg(test)]
pub(crate) fn take_manual_memory_publication_capture_for_test(
) -> Vec<Option<DashboardManualMemory>> {
    DASHBOARD_MANUAL_MEMORY_PUBLICATION_CAPTURE.with(|capture| {
        capture.borrow_mut().take().unwrap_or_default()
    })
}

#[cfg(test)]
fn capture_manual_memory_publication_for_test(context: &DashboardContext) {
    DASHBOARD_MANUAL_MEMORY_PUBLICATION_CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        if let Some(memories) = capture.as_mut() {
            memories.push(context.manual_memory.clone());
        }
    });
}

static DASHBOARD_STATE: Mutex<Option<DashboardState>> = Mutex::new(None);
static SERVER_URL: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn publish_state(
    context: DashboardContext,
    tokens: DashboardTokens,
    activity: DashboardActivityState,
) -> bool {
    #[cfg(test)]
    capture_manual_memory_publication_for_test(&context);
    let Ok(mut slot) = DASHBOARD_STATE.lock() else {
        return false;
    };
    publish_state_into(
        &mut slot,
        context,
        tokens,
        activity,
        Utc::now().timestamp_millis(),
    )
}

fn publish_state_into(
    slot: &mut Option<DashboardState>,
    context: DashboardContext,
    tokens: DashboardTokens,
    activity: DashboardActivityState,
    generated_at: i64,
) -> bool {
    let activity = map_activity(activity);
    let revision = match slot.as_ref() {
        Some(current)
            if current.context == context
                && current.tokens == tokens
                && current.activity == activity =>
        {
            return false;
        }
        Some(current) => current.revision.saturating_add(1),
        None => 1,
    };
    *slot = Some(DashboardState {
        schema_version: SCHEMA_VERSION,
        revision,
        generated_at,
        context,
        tokens,
        activity,
    });
    true
}

fn map_activity(activity: DashboardActivityState) -> DashboardActivity {
    DashboardActivity {
        current: activity.current.map(|row| DashboardCurrentTurn {
            status: map_activity_status(row.status),
            started_at: row.started_at.and_then(|seconds| seconds.checked_mul(1_000)),
            cost: row.cost.map(map_cost),
        }),
        recent: activity
            .recent
            .into_iter()
            .map(|row| DashboardRecentTurn {
                status: map_activity_status(row.status),
                duration_ms: row.duration_ms,
                time_to_first_token_ms: row.time_to_first_token_ms,
                profile: row.profile.map(map_profile),
                cost: row.cost.map(map_cost),
            })
            .collect(),
        automatic_pruning_enabled: activity.automatic_pruning_enabled,
    }
}

fn map_activity_status(status: ProjectedActivityStatus) -> DashboardActivityStatus {
    match status {
        ProjectedActivityStatus::Running => DashboardActivityStatus::Running,
        ProjectedActivityStatus::Completed => DashboardActivityStatus::Completed,
        ProjectedActivityStatus::Failed => DashboardActivityStatus::Failed,
        ProjectedActivityStatus::Interrupted => DashboardActivityStatus::Interrupted,
    }
}

fn map_profile(profile: TurnProfileSummary) -> DashboardTurnProfile {
    DashboardTurnProfile {
        before_first_sampling_ms: profile.before_first_sampling_ms,
        sampling_ms: profile.sampling_ms,
        compaction_ms: profile.compaction_ms,
        between_sampling_overhead_ms: profile.between_sampling_overhead_ms,
        tool_blocking_ms: profile.tool_blocking_ms,
        after_last_sampling_ms: profile.after_last_sampling_ms,
        sampling_request_count: profile.sampling_request_count,
        sampling_retry_count: profile.sampling_retry_count,
    }
}

fn map_cost(cost: TurnCostState) -> DashboardCostState {
    match cost {
        TurnCostState::Unavailable { reason } => DashboardCostState::Unavailable {
            reason: match reason {
                TurnCostAvailability::SubscriptionAuthentication => {
                    DashboardCostAvailability::SubscriptionAuthentication
                }
                TurnCostAvailability::CostObservationDisabled => {
                    DashboardCostAvailability::CostObservationDisabled
                }
                TurnCostAvailability::ProviderUnsupported => {
                    DashboardCostAvailability::ProviderUnsupported
                }
                TurnCostAvailability::AwaitingBackendPrice => {
                    DashboardCostAvailability::AwaitingBackendPrice
                }
                TurnCostAvailability::BackendUnavailable => {
                    DashboardCostAvailability::BackendUnavailable
                }
                TurnCostAvailability::ObservationDropped => {
                    DashboardCostAvailability::ObservationDropped
                }
            },
        },
        TurnCostState::Priced { backend_total_usd } => {
            DashboardCostState::Priced { backend_total_usd }
        }
    }
}

pub(crate) fn ensure_running() -> Option<String> {
    ensure_server_url(&SERVER_URL, || {
        let listener = tiny_http::Server::http(dashboard_bind_addr()).ok()?;
        let port = listener.server_addr().to_ip()?.port();
        let url = format!("http://127.0.0.1:{port}");
        std::thread::Builder::new()
            .name("elpis-dashboard".to_string())
            .spawn(move || serve(listener, port))
            .ok()?;
        Some(url)
    })
}

fn ensure_server_url(
    slot: &Mutex<Option<String>>,
    start: impl FnOnce() -> Option<String>,
) -> Option<String> {
    let mut server_url = slot.lock().ok()?;
    if let Some(url) = server_url.as_ref() {
        return Some(url.clone());
    }
    let url = start()?;
    *server_url = Some(url.clone());
    Some(url)
}

fn dashboard_bind_addr() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

fn serve(listener: tiny_http::Server, port: u16) {
    for request in listener.incoming_requests() {
        let state = DASHBOARD_STATE
            .lock()
            .ok()
            .and_then(|state| state.clone());
        let response = response_for_at(&request, port, state, Utc::now().timestamp_millis());
        let _ = request.respond(response);
    }
}

fn response_for_at(
    request: &tiny_http::Request,
    port: u16,
    state: Option<DashboardState>,
    heartbeat_at: i64,
) -> DashboardResponse {
    if !valid_host(request, port) {
        return response(403, "text/plain; charset=utf-8", b"forbidden".to_vec());
    }
    if request.method() != &tiny_http::Method::Get {
        return response(
            405,
            "text/plain; charset=utf-8",
            b"method not allowed".to_vec(),
        );
    }
    match request.url() {
        "/" | "/index.html" => response(
            200,
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes().to_vec(),
        ),
        "/data.json" => match state {
            Some(state) => data_response_with(state, heartbeat_at, serde_json::to_vec),
            None => unavailable_response(),
        },
        _ => response(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

fn valid_host(request: &tiny_http::Request, port: u16) -> bool {
    let mut hosts = request
        .headers()
        .iter()
        .filter(|header| header.field.equiv("Host"));
    let Some(host) = hosts.next() else {
        return false;
    };
    if hosts.next().is_some() {
        return false;
    }
    let value = host.value.as_str();
    value == format!("127.0.0.1:{port}")
        || value.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

fn data_response_with<E>(
    state: DashboardState,
    heartbeat_at: i64,
    encode: impl FnOnce(&DashboardEnvelope) -> Result<Vec<u8>, E>,
) -> DashboardResponse {
    let envelope = DashboardEnvelope {
        state,
        heartbeat_at,
    };
    match encode(&envelope) {
        Ok(body) => response(200, "application/json; charset=utf-8", body),
        Err(_) => unavailable_response(),
    }
}

fn unavailable_response() -> DashboardResponse {
    response(
        503,
        "application/json; charset=utf-8",
        UNAVAILABLE_JSON.to_vec(),
    )
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> DashboardResponse {
    let mut response = tiny_http::Response::from_data(body).with_status_code(status);
    for (name, value) in [
        ("Content-Type", content_type),
        ("Cache-Control", "no-store"),
        ("Content-Security-Policy", CSP),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
    ] {
        response = response.with_header(
            tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
                .expect("static dashboard response header is valid"),
        );
    }
    response
}

#[cfg(test)]
#[path = "dashboard_server_tests.rs"]
mod tests;

use super::*;
use crate::bespoke_event_handling::apply_bespoke_event_handling;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingEnvelope;
use crate::outgoing_message::OutgoingMessage;
use crate::outgoing_message::OutgoingMessageSender;
use crate::request_processors::observe_initial_turn_cost_after_forwarding;
use crate::request_processors::prepare_turn_cost_event;
use crate::thread_state::ConnectionCapabilities;
use crate::thread_state::ThreadState;
use crate::thread_state::ThreadStateManager;
use crate::thread_status::ThreadWatchManager;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use codex_backend_client::ApiKeyResponseCost;
use codex_config::types::AuthCredentialsStoreMode;
use codex_config::types::OtelExporterKind;
use codex_core::config::ConfigBuilder;
use codex_login::AuthDotJson;
use codex_login::AuthKeyringBackendKind;
use codex_login::CodexAuth;
use codex_login::TokenData;
use codex_login::auth::BedrockApiKeyAuth;
use codex_login::auth::save_auth;
use codex_login::login_with_api_key;
use codex_model_provider_info::AMAZON_BEDROCK_PROVIDER_ID;
use codex_model_provider_info::built_in_model_providers;
use codex_otel::MetricsClient;
use codex_otel::MetricsConfig;
use codex_otel::TelemetryAuthMode;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RawResponseCompletedEvent;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::TurnCompleteEvent;
use codex_protocol::protocol::TurnStartedEvent;
use core_test_support::load_default_config_for_test;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::MetricData;
use pretty_assertions::assert_eq;
use std::collections::HashMap;
use std::ops::Deref;
use std::ops::DerefMut;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::mpsc;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

const TURN_COST_PATH: &str = "/v1/analytics/codex/turn-costs";

#[tokio::test]
async fn worker_is_disabled_without_an_explicit_otel_exporter() {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));

    let (notifier, _, _) = test_late_notifier(ThreadId::new()).await;
    assert!(TurnCostWorker::spawn(Arc::new(config), auth_manager, notifier).is_none());
}

#[tokio::test]
async fn availability_policy_classifies_auth_exporter_and_provider_without_io() {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.otel.metrics_exporter = OtelExporterKind::OtlpGrpc {
        endpoint: "http://unused.invalid".to_string(),
        headers: HashMap::new(),
        tls: None,
    };
    config.model_provider = built_in_model_providers(None)
        .remove(AMAZON_BEDROCK_PROVIDER_ID)
        .expect("built-in Bedrock provider");
    let subscription_auth =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let policy = TurnCostAvailabilityPolicy::new(Arc::new(config.clone()), subscription_auth);

    assert_eq!(
        policy.classify(&config),
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        }
    );

    let bedrock_auth =
        AuthManager::from_auth_for_testing(CodexAuth::BedrockApiKey(BedrockApiKeyAuth {
            api_key: "bedrock-test".to_string(),
            region: "us-east-1".to_string(),
        }));
    let policy = TurnCostAvailabilityPolicy::new(Arc::new(config.clone()), bedrock_auth);
    assert_eq!(
        policy.classify(&config),
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::ProviderUnsupported,
        }
    );

    let api_key_auth = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let policy = TurnCostAvailabilityPolicy::new(Arc::new(config.clone()), api_key_auth);
    assert_eq!(
        policy.classify(&config),
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::ProviderUnsupported,
        }
    );

    let mut supported = config;
    supported.model_provider = built_in_model_providers(None)
        .remove("openai")
        .expect("built-in OpenAI provider");
    let policy = TurnCostAvailabilityPolicy::new(
        Arc::new(supported.clone()),
        AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test")),
    );
    assert_eq!(
        policy.classify(&supported),
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::AwaitingBackendPrice,
        }
    );

    supported.otel.metrics_exporter = OtelExporterKind::None;
    assert_eq!(
        policy.classify(&supported),
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::CostObservationDisabled,
        }
    );
}

#[tokio::test]
async fn activity_notifications_listener_path_orders_initial_cost_before_enqueue_and_counts_hidden_raw()
 {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = load_default_config_for_test(&codex_home).await;
    config.otel.metrics_exporter = OtelExporterKind::OtlpGrpc {
        endpoint: "http://unused.invalid".to_string(),
        headers: HashMap::new(),
        tls: None,
    };
    let thread_manager = Arc::new(
        codex_core::test_support::thread_manager_with_models_provider_and_home(
            CodexAuth::from_api_key("sk-thread"),
            config.model_provider.clone(),
            config.codex_home.to_path_buf(),
            Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
        ),
    );
    let codex_core::NewThread {
        thread_id, thread, ..
    } = thread_manager
        .start_thread(config.clone())
        .await
        .expect("test thread");
    let thread_state = Arc::new(tokio::sync::Mutex::new(ThreadState::default()));
    let started = turn_started_event();
    thread_state
        .lock()
        .await
        .track_current_turn_event(&started.id, &started.msg);

    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let policy = TurnCostAvailabilityPolicy::new(Arc::new(config.clone()), auth_manager.clone());
    let (observation_tx, mut observation_rx) = mpsc::channel(4);
    let worker = TurnCostWorkerHandle {
        sender: observation_tx,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager,
        config: Arc::new(config.clone()),
        dropped_turns: new_dropped_turns(),
    };
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel(4);
    let thread_outgoing = ThreadScopedOutgoingMessageSender::new(
        Arc::new(OutgoingMessageSender::new(outgoing_tx)),
        vec![ConnectionId(1)],
        thread_id,
    );

    let (initial_cost, initial_auth_revision, should_forward) = prepare_turn_cost_event(
        &policy,
        Some(&worker),
        &thread_outgoing,
        thread_id,
        &config,
        &started,
        || thread.session_telemetry(),
        /*raw_events_enabled*/ false,
    )
    .await;
    assert!(should_forward);
    assert_eq!(
        initial_cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::AwaitingBackendPrice,
        })
    );
    assert!(observation_rx.try_recv().is_err());

    apply_bespoke_event_handling(
        started.clone(),
        thread_id,
        thread.clone(),
        thread_manager,
        thread_outgoing.clone(),
        thread_state,
        ThreadWatchManager::new(),
        Arc::new(tokio::sync::Semaphore::new(/*permits*/ 1)),
        config.model_provider_id.clone(),
        initial_cost.clone(),
    )
    .await;
    assert!(matches!(
        recv_server_notification(&mut outgoing_rx).await,
        ServerNotification::TurnStarted(_)
    ));
    let ServerNotification::TurnCostUpdated(notification) =
        recv_server_notification(&mut outgoing_rx).await
    else {
        panic!("expected initial cost notification");
    };
    assert_eq!(
        notification,
        TurnCostUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: started.id.clone(),
            cost: TurnCostState::Unavailable {
                reason: TurnCostAvailability::AwaitingBackendPrice,
            },
        }
    );
    assert!(observation_rx.try_recv().is_err());

    observe_initial_turn_cost_after_forwarding(
        initial_cost.as_ref(),
        initial_auth_revision,
        Some(&worker),
        &thread_outgoing,
        thread_id,
        &config,
        &started,
        || thread.session_telemetry(),
    )
    .await;
    let observation = observation_rx
        .recv()
        .await
        .expect("started cost observation");
    assert_eq!(observation.auth_revision, initial_auth_revision);
    assert!(matches!(
        observation.kind,
        TurnCostObservationKind::Started { .. }
    ));

    let raw_response = raw_response_completed_event(&started.id);
    let (initial_cost, auth_revision, should_forward) = prepare_turn_cost_event(
        &policy,
        Some(&worker),
        &thread_outgoing,
        thread_id,
        &config,
        &raw_response,
        || panic!("raw response observation does not construct telemetry"),
        /*raw_events_enabled*/ false,
    )
    .await;
    assert_eq!(initial_cost, None);
    assert!(!should_forward);
    let observation = observation_rx
        .recv()
        .await
        .expect("raw response cost observation");
    assert_eq!(observation.auth_revision, auth_revision);
    assert!(matches!(
        observation.kind,
        TurnCostObservationKind::ResponseCompleted
    ));
    assert!(outgoing_rx.try_recv().is_err());
}

#[tokio::test]
async fn start_logout_between_classification_and_enqueue_emits_one_terminal_state() {
    assert_start_auth_transition_is_terminal(TestAuthTransition::Logout).await;
}

#[tokio::test]
async fn start_subscription_between_classification_and_enqueue_emits_one_terminal_state() {
    assert_start_auth_transition_is_terminal(TestAuthTransition::Subscription).await;
}

#[tokio::test]
async fn worker_starts_with_metrics_exporter_and_probes_the_backend() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TURN_COST_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "turns": []
        })))
        .expect(1)
        .mount(&server)
        .await;
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.chatgpt_base_url = server.uri();
    config.otel.exporter = OtelExporterKind::None;
    config.otel.metrics_exporter = OtelExporterKind::OtlpGrpc {
        endpoint: server.uri(),
        headers: HashMap::new(),
        tls: None,
    };
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));

    let (notifier, _, _) = test_late_notifier(ThreadId::new()).await;
    let worker = TurnCostWorker::spawn(Arc::new(config), auth_manager, notifier)
        .expect("metrics exporter should enable cost collection");
    wait_for_request_count(&server, 1).await;
    worker.shutdown();
    server.verify().await;
}

#[tokio::test]
async fn subscription_auth_never_enqueues_or_queries_monetary_cost() {
    let server = MockServer::start().await;
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.chatgpt_base_url = server.uri();
    config.otel.metrics_exporter = OtelExporterKind::OtlpGrpc {
        endpoint: server.uri(),
        headers: HashMap::new(),
        tls: None,
    };
    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let (late_notifier, _, mut notifications) = test_late_notifier(ThreadId::new()).await;
    let worker = TurnCostWorker::spawn(Arc::new(config.clone()), auth_manager, late_notifier)
        .expect("configured metrics should create the dormant worker");
    let handle = worker.handle();
    let thread_id = ThreadId::new();
    let event = turn_started_event();

    assert_eq!(
        handle.observe_event(thread_id, &config, &event, 0, || {
            panic!("subscription turn must not capture monetary-cost telemetry")
        }),
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        })
    );
    tokio::task::yield_now().await;

    assert!(
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty()
    );
    assert!(notifications.try_recv().is_err());
    worker.shutdown();
}

#[tokio::test]
async fn queued_start_is_terminalized_once_when_api_key_auth_is_cleared() {
    let server = MockServer::start().await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-test"),
        auth_home.path().to_path_buf(),
    );
    let auth_changes = Some(auth_manager.auth_change_receiver());
    let TestRuntime {
        runtime,
        thread_id,
        mut notifications,
        ..
    } = test_runtime(&server, auth_manager.clone()).await;
    let dropped_turns = runtime.dropped_turns.clone();
    assert!(register_active_turn(
        &dropped_turns,
        "turn-queued-before-logout",
    ));
    let (sender, receiver) = mpsc::channel(2);
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: "turn-queued-before-logout".to_string(),
            auth_revision: current_auth_revision(auth_manager.as_ref()),
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await
        .expect("worker observation channel");
    auth_manager.logout().await.expect("clear test auth");

    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                auth_changes,
                BackendAvailability::Ready,
            )
            .await;
    });

    assert_eq!(
        recv_cost_state(&mut notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    let dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(dropped_turns.dropped.contains("turn-queued-before-logout"));
    assert!(!dropped_turns.active.contains("turn-queued-before-logout"));
    drop(dropped_turns);
    tokio::task::yield_now().await;
    assert!(notifications.try_recv().is_err());
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert!(
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty()
    );
    shutdown.cancel();
    task.await.expect("worker task");
}

#[tokio::test(start_paused = true)]
async fn subscription_to_api_key_keeps_a_post_change_start_eligible() {
    let server = MockServer::start().await;
    let turn_id = "turn-after-api-key-login";
    mount_priced_turn_cost_response(&server, turn_id).await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::create_dummy_chatgpt_auth_for_testing(),
        auth_home.path().to_path_buf(),
    );
    let auth_changes = Some(auth_manager.auth_change_receiver());
    let TestRuntime {
        runtime,
        thread_id,
        mut notifications,
        ..
    } = test_runtime(&server, auth_manager.clone()).await;
    login_with_api_key(
        auth_home.path(),
        "sk-current",
        AuthCredentialsStoreMode::File,
        AuthKeyringBackendKind::default(),
    )
    .expect("write replacement API key");
    assert!(auth_manager.reload().await);
    let auth_revision = current_auth_revision(auth_manager.as_ref());
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    let (sender, receiver) = mpsc::channel(4);
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await
        .expect("post-change start observation");
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await
        .expect("post-change finish observation");

    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                auth_changes,
                BackendAvailability::AwaitingAuthChange,
            )
            .await;
    });
    wait_for_request_count(&server, 1).await;
    advance_until_request_count(&server, 2).await;

    let notification = recv_turn_cost_notification(&mut notifications).await;
    assert_eq!(notification.turn_id, turn_id);
    assert_eq!(
        notification.cost,
        TurnCostState::Priced {
            backend_total_usd: "0.25".to_string(),
        }
    );
    assert_eq!(turn_cost_metric_value(&metrics), Some(250_000));
    assert!(notifications.try_recv().is_err());
    shutdown.cancel();
    task.await.expect("worker task");
    server.verify().await;
}

#[tokio::test(start_paused = true)]
async fn api_key_rotation_discards_old_work_but_keeps_a_post_change_start_eligible() {
    let server = MockServer::start().await;
    let old_turn_id = "turn-before-api-key-rotation";
    let current_turn_id = "turn-after-api-key-rotation";
    mount_priced_turn_cost_response(&server, current_turn_id).await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-old"),
        auth_home.path().to_path_buf(),
    );
    let auth_changes = Some(auth_manager.auth_change_receiver());
    let mut test_runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = test_runtime.thread_id;
    let old_auth_revision = current_auth_revision(auth_manager.as_ref());
    let (old_session_telemetry, old_metrics) = test_session_telemetry(thread_id);
    test_runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: old_turn_id.to_string(),
            auth_revision: old_auth_revision,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(old_session_telemetry),
            },
        })
        .await;
    test_runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: old_turn_id.to_string(),
            auth_revision: old_auth_revision,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;
    login_with_api_key(
        auth_home.path(),
        "sk-current",
        AuthCredentialsStoreMode::File,
        AuthKeyringBackendKind::default(),
    )
    .expect("write rotated API key");
    let revision_before_rotation = current_auth_revision(auth_manager.as_ref());
    // `reload()` reports equality by auth mode, so one API key replacing another is "no
    // change" to it even though it loads the new key. The worker keys off the auth
    // revision, which the reload bumps, so that is the contract to assert.
    let _ = auth_manager.reload().await;
    assert_ne!(
        current_auth_revision(auth_manager.as_ref()),
        revision_before_rotation,
        "rotating the API key must bump the auth revision"
    );
    let current_auth_revision = current_auth_revision(auth_manager.as_ref());
    let (current_session_telemetry, current_metrics) = test_session_telemetry(thread_id);
    let (sender, receiver) = mpsc::channel(4);
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: current_turn_id.to_string(),
            auth_revision: current_auth_revision,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(current_session_telemetry),
            },
        })
        .await
        .expect("post-rotation start observation");
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: current_turn_id.to_string(),
            auth_revision: current_auth_revision,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await
        .expect("post-rotation finish observation");

    let TestRuntime {
        runtime,
        mut notifications,
        ..
    } = test_runtime;
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                auth_changes,
                BackendAvailability::Ready,
            )
            .await;
    });
    let old_notification = recv_turn_cost_notification(&mut notifications).await;
    assert_eq!(old_notification.turn_id, old_turn_id);
    assert_eq!(
        old_notification.cost,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    assert_eq!(turn_cost_metric_value(&old_metrics), None);
    wait_for_request_count(&server, 1).await;
    advance_until_request_count(&server, 2).await;

    let current_notification = recv_turn_cost_notification(&mut notifications).await;
    assert_eq!(current_notification.turn_id, current_turn_id);
    assert_eq!(
        current_notification.cost,
        TurnCostState::Priced {
            backend_total_usd: "0.25".to_string(),
        }
    );
    assert_eq!(turn_cost_metric_value(&current_metrics), Some(250_000));
    assert!(notifications.try_recv().is_err());
    shutdown.cancel();
    task.await.expect("worker task");
    server.verify().await;
}

#[tokio::test]
async fn subscription_auth_suppresses_an_already_tracked_price() {
    let server = MockServer::start().await;
    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-auth-changed";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;

    runtime
        .process_api_key_cost(turn_id, &priced_cost(turn_id, "0.25"))
        .await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        }
    );
    assert!(runtime.notifications.try_recv().is_err());
}

#[tokio::test]
async fn missing_openai_auth_suppresses_an_already_tracked_price() {
    let server = MockServer::start().await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-test"),
        auth_home.path().to_path_buf(),
    );
    let mut runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-logged-out";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;
    auth_manager.logout().await.expect("clear test auth");

    runtime
        .process_api_key_cost(turn_id, &priced_cost(turn_id, "0.25"))
        .await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    assert!(runtime.notifications.try_recv().is_err());
}

#[tokio::test]
async fn api_key_rotation_suppresses_an_already_tracked_price() {
    let server = MockServer::start().await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-old"),
        auth_home.path().to_path_buf(),
    );
    let mut runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-priced-after-api-key-rotation";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: current_auth_revision(auth_manager.as_ref()),
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: current_auth_revision(auth_manager.as_ref()),
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;
    login_with_api_key(
        auth_home.path(),
        "sk-current",
        AuthCredentialsStoreMode::File,
        AuthKeyringBackendKind::default(),
    )
    .expect("write rotated API key");
    let revision_before_rotation = current_auth_revision(auth_manager.as_ref());
    let _ = auth_manager.reload().await;
    assert_ne!(
        current_auth_revision(auth_manager.as_ref()),
        revision_before_rotation,
        "rotating the API key must bump the auth revision"
    );

    runtime
        .process_api_key_cost(turn_id, &priced_cost(turn_id, "0.25"))
        .await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    assert!(runtime.notifications.try_recv().is_err());
}

#[tokio::test]
async fn priced_cost_records_only_after_every_response_arrives() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-1";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    assert!(register_active_turn(&runtime.dropped_turns, turn_id));

    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    for _ in 0..2 {
        runtime
            .record_observation(TurnCostObservation {
                thread_id,
                turn_id: turn_id.to_string(),
                auth_revision: 0,
                kind: TurnCostObservationKind::ResponseCompleted,
            })
            .await;
    }
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;

    let mut cost = ApiKeyTurnCost {
        turn_id: turn_id.to_string(),
        status: ApiKeyTurnCostStatus::Priced,
        total_usd: Some("1.2500000".to_string()),
        event_count: Some(2),
        responses: Some(vec![ApiKeyResponseCost {
            response_id: "resp-one".to_string(),
            total_usd: "0.75".to_string(),
        }]),
        model: Some("gpt-5.6".to_string()),
        speed: Some("fast".to_string()),
        reasoning_effort: Some("high".to_string()),
    };
    runtime.process_api_key_cost(turn_id, &cost).await;

    assert!(runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert!(runtime.notifications.try_recv().is_err());

    cost.responses
        .as_mut()
        .expect("response costs")
        .push(ApiKeyResponseCost {
            response_id: "resp-two".to_string(),
            total_usd: "0.50".to_string(),
        });
    runtime.process_api_key_cost(turn_id, &cost).await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), Some(1_250_000));
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Priced {
            backend_total_usd: "1.2500000".to_string(),
        }
    );
    assert!(
        runtime.notifications.try_recv().is_err(),
        "price emitted more than once"
    );
    assert!(
        !runtime
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .contains(turn_id),
        "a priced completed turn must leave no active lifecycle"
    );
}

#[tokio::test]
async fn stalled_pending_cost_is_dropped_after_the_bounded_retry_budget() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-stalled";
    let (session_telemetry, _metrics) = test_session_telemetry(thread_id);
    assert!(register_active_turn(&runtime.dropped_turns, turn_id));
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Finished { interrupted: true },
        })
        .await;
    let pending = ApiKeyTurnCost {
        turn_id: turn_id.to_string(),
        status: ApiKeyTurnCostStatus::Pending,
        total_usd: None,
        event_count: None,
        responses: None,
        model: None,
        speed: None,
        reasoning_effort: None,
    };

    for _ in 1..MAX_STALLED_POLL_ATTEMPTS {
        runtime.process_api_key_cost(turn_id, &pending).await;
        assert!(runtime.turns.contains_key(turn_id));
    }
    runtime.process_api_key_cost(turn_id, &pending).await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    assert!(runtime.notifications.try_recv().is_err());
    assert!(
        !runtime
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .contains(turn_id),
        "retry exhaustion after a received finish must leave no active lifecycle"
    );
}

#[tokio::test(start_paused = true)]
async fn subscription_change_during_pending_query_terminalizes_before_retry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(TURN_COST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(10))
                .set_body_json(serde_json::json!({
                    "turns": [{
                        "turn_id": "turn-auth-changed-in-query",
                        "status": "pending"
                    }]
                })),
        )
        .expect(1)
        .mount(&server)
        .await;
    let auth_home = TempDir::new().expect("temporary auth home");
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-test"),
        auth_home.path().to_path_buf(),
    );
    let auth_revision = current_auth_revision(auth_manager.as_ref());
    let auth_changes = Some(auth_manager.auth_change_receiver());
    let mut test_runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = test_runtime.thread_id;
    let turn_id = "turn-auth-changed-in-query";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    test_runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    test_runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;
    let TestRuntime {
        runtime,
        mut notifications,
        ..
    } = test_runtime;
    let (_sender, receiver) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                auth_changes,
                BackendAvailability::Ready,
            )
            .await;
    });

    tokio::task::yield_now().await;
    tokio::time::advance(POLL_INTERVAL).await;
    wait_for_request_count(&server, 1).await;
    replace_auth_with_subscription(auth_home.path(), auth_manager.as_ref()).await;
    tokio::time::advance(Duration::from_secs(10)).await;

    assert_eq!(
        recv_cost_state(&mut notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        }
    );
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert!(notifications.try_recv().is_err());
    shutdown.cancel();
    task.await.expect("worker task");
    server.verify().await;
}

#[tokio::test]
async fn unavailable_backend_reports_typed_state_without_tracking_turn() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let TestRuntime {
        runtime,
        thread_id,
        mut notifications,
        ..
    } = test_runtime(&server, auth_manager).await;
    let dropped_turns = runtime.dropped_turns.clone();
    assert!(register_active_turn(
        &dropped_turns,
        "turn-backend-unavailable",
    ));
    let (sender, receiver) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                None,
                BackendAvailability::Disabled,
            )
            .await;
    });

    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: "turn-backend-unavailable".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(test_session_telemetry(thread_id).0),
            },
        })
        .await
        .expect("worker observation channel");

    assert_eq!(
        recv_cost_state(&mut notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::BackendUnavailable,
        }
    );
    let dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(dropped_turns.dropped.contains("turn-backend-unavailable"));
    assert!(!dropped_turns.active.contains("turn-backend-unavailable"));
    drop(dropped_turns);
    shutdown.cancel();
    task.await.expect("worker task");
}

#[tokio::test]
async fn unavailable_backend_preserves_subscription_auth_precedence() {
    let server = MockServer::start().await;
    let auth_manager =
        AuthManager::from_auth_for_testing(CodexAuth::create_dummy_chatgpt_auth_for_testing());
    let TestRuntime {
        runtime,
        thread_id,
        mut notifications,
        ..
    } = test_runtime(&server, auth_manager).await;
    let (sender, receiver) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let task = tokio::spawn(async move {
        runtime
            .run_with_backend_availability(
                receiver,
                task_shutdown,
                None,
                BackendAvailability::AwaitingAuthChange,
            )
            .await;
    });
    sender
        .send(TurnCostObservation {
            thread_id,
            turn_id: "turn-subscription-unavailable".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(test_session_telemetry(thread_id).0),
            },
        })
        .await
        .expect("worker observation channel");

    assert_eq!(
        recv_cost_state(&mut notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        }
    );
    assert!(notifications.try_recv().is_err());
    shutdown.cancel();
    task.await.expect("worker task");
}

#[tokio::test]
async fn malformed_and_overflow_costs_never_reach_telemetry_or_priced_ui() {
    for value in ["not-a-cost", "9223372036854.7758075"] {
        let server = MockServer::start().await;
        let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
        let mut runtime = test_runtime(&server, auth_manager).await;
        let thread_id = runtime.thread_id;
        let turn_id = "turn-invalid";
        let (session_telemetry, metrics) = test_session_telemetry(thread_id);
        runtime
            .record_observation(TurnCostObservation {
                thread_id,
                turn_id: turn_id.to_string(),
                auth_revision: 0,
                kind: TurnCostObservationKind::Started {
                    session_telemetry: Box::new(session_telemetry),
                },
            })
            .await;
        let invalid = ApiKeyTurnCost {
            turn_id: turn_id.to_string(),
            status: ApiKeyTurnCostStatus::Priced,
            total_usd: Some(value.to_string()),
            event_count: Some(0),
            responses: None,
            model: None,
            speed: None,
            reasoning_effort: None,
        };

        for _ in 0..MAX_STALLED_POLL_ATTEMPTS {
            runtime.process_api_key_cost(turn_id, &invalid).await;
        }

        assert!(!runtime.turns.contains_key(turn_id));
        assert_eq!(turn_cost_metric_value(&metrics), None);
        assert_eq!(
            recv_cost_state(&mut runtime.notifications).await,
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::BackendUnavailable,
            },
            "{value}"
        );
        assert!(runtime.notifications.try_recv().is_err(), "{value}");
    }
}

#[tokio::test]
async fn observation_channel_and_tracking_capacity_report_dropped() {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let config = Arc::new(
        ConfigBuilder::default()
            .codex_home(codex_home.path().to_path_buf())
            .build()
            .await
            .expect("test config"),
    );
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let (sender, mut receiver) = mpsc::channel(1);
    let dropped_turns = new_dropped_turns();
    let handle = TurnCostWorkerHandle {
        sender,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager: auth_manager.clone(),
        config: config.clone(),
        dropped_turns: dropped_turns.clone(),
    };
    let thread_id = ThreadId::new();
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    assert_eq!(
        handle.observe_event(thread_id, &config, &turn_started_event(), 0, || {
            session_telemetry
        }),
        None
    );
    assert_eq!(
        handle.observe_event(thread_id, &config, &turn_started_event(), 0, || {
            test_session_telemetry(thread_id).0
        }),
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::ObservationDropped,
        })
    );
    assert_eq!(
        handle.observe_event(
            thread_id,
            &config,
            &raw_response_completed_event("turn-1"),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        None,
        "only the first channel drop may emit a terminal state"
    );

    let server = MockServer::start().await;
    let mut runtime = test_runtime(&server, auth_manager).await;
    runtime.dropped_turns = dropped_turns;
    runtime
        .record_observation(receiver.recv().await.expect("queued start observation"))
        .await;
    assert!(!runtime.turns.contains_key("turn-1"));
    assert_eq!(
        handle.observe_event(
            thread_id,
            &config,
            &raw_response_completed_event("channel-filler"),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        None
    );
    assert_eq!(
        handle.observe_event(
            thread_id,
            &config,
            &raw_response_completed_event("turn-1"),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        None,
        "consuming invalidation must not allow a second terminal drop"
    );
    runtime
        .process_api_key_cost("turn-1", &priced_cost("turn-1", "0.25"))
        .await;
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert!(runtime.notifications.try_recv().is_err());

    let thread_id = runtime.thread_id;
    let shared_thread_id = ThreadId::new();
    let shared_telemetry = test_session_telemetry(shared_thread_id).0;
    for index in 0..MAX_TRACKED_TURNS {
        runtime.turns.insert(
            format!("tracked-{index}"),
            TurnCostEntry {
                thread_id: shared_thread_id,
                session_telemetry: shared_telemetry.clone(),
                auth_revision: 0,
                expected_response_count: 0,
                status: TurnCostStatus::Running,
                next_poll_at: Instant::now(),
                attempt_count: 0,
            },
        );
    }
    let (over_capacity_telemetry, over_capacity_metrics) = test_session_telemetry(thread_id);
    assert!(register_active_turn(
        &runtime.dropped_turns,
        "over-capacity",
    ));
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: "over-capacity".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(over_capacity_telemetry),
            },
        })
        .await;
    assert_eq!(
        recv_cost_state(&mut runtime.notifications).await,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::ObservationDropped,
        }
    );
    assert!(
        runtime
            .dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .contains("over-capacity"),
        "map-capacity rejection must stay pinned while the turn is running"
    );
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: "over-capacity".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(test_session_telemetry(thread_id).0),
            },
        })
        .await;
    assert!(
        runtime.notifications.try_recv().is_err(),
        "map capacity may terminalize a turn only once"
    );
    runtime
        .process_api_key_cost("over-capacity", &priced_cost("over-capacity", "0.25"))
        .await;
    assert!(!runtime.turns.contains_key("over-capacity"));
    assert_eq!(turn_cost_metric_value(&over_capacity_metrics), None);
    assert!(runtime.notifications.try_recv().is_err());
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: "over-capacity".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;
    let dropped_turns = runtime
        .dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(!dropped_turns.dropped.contains("over-capacity"));
    assert!(!dropped_turns.active.contains("over-capacity"));
}

#[tokio::test]
async fn terminal_discard_paths_demote_running_turns_without_later_observations() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = runtime.thread_id;
    let dropped_turns = runtime.dropped_turns.clone();

    for (turn_id, auth_revision) in [("turn-stale-discard", 0), ("turn-all-discard", 1)] {
        assert!(register_active_turn(&dropped_turns, turn_id));
        runtime
            .record_observation(TurnCostObservation {
                thread_id,
                turn_id: turn_id.to_string(),
                auth_revision,
                kind: TurnCostObservationKind::Started {
                    session_telemetry: Box::new(test_session_telemetry(thread_id).0),
                },
            })
            .await;
    }

    runtime
        .discard_stale_entries(1, TurnCostAvailability::BackendUnavailable)
        .await;
    runtime
        .discard_all(TurnCostAvailability::BackendUnavailable)
        .await;

    let dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(dropped_turns.dropped.contains("turn-stale-discard"));
    assert!(dropped_turns.dropped.contains("turn-all-discard"));
    assert!(!dropped_turns.active.contains("turn-stale-discard"));
    assert!(!dropped_turns.active.contains("turn-all-discard"));
    assert!(dropped_turns.dropped.len() <= MAX_DROPPED_TURNS);
}

#[tokio::test]
async fn failed_finished_sends_demote_drops_and_bound_history_without_later_finish() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-active-while-drop-history-overloads";
    let dropped_turns = runtime.dropped_turns.clone();
    let (sender, mut receiver) = mpsc::channel(1);
    let handle = TurnCostWorkerHandle {
        sender,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager,
        config: runtime.config.clone(),
        dropped_turns: dropped_turns.clone(),
    };
    let (session_telemetry, _metrics) = test_session_telemetry(thread_id);
    let started = Event {
        id: turn_id.to_string(),
        msg: turn_started_event().msg,
    };
    assert_eq!(
        handle.observe_event(thread_id, &runtime.config, &started, 0, || {
            session_telemetry
        }),
        None
    );
    runtime
        .record_observation(receiver.recv().await.expect("queued start observation"))
        .await;
    assert!(runtime.turns.contains_key(turn_id));
    assert_eq!(
        handle.observe_event(
            thread_id,
            &runtime.config,
            &raw_response_completed_event("channel-filler"),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        None
    );
    assert_eq!(
        handle.observe_event(
            thread_id,
            &runtime.config,
            &raw_response_completed_event(turn_id),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::ObservationDropped,
        })
    );

    runtime
        .process_api_key_cost(turn_id, &priced_cost(turn_id, "0.25"))
        .await;
    assert!(!runtime.turns.contains_key(turn_id));

    for index in 0..=MAX_DROPPED_TURNS {
        let terminal_turn_id = format!("failed-terminal-drop-{index}");
        assert!(register_active_turn(&dropped_turns, &terminal_turn_id));
        assert_eq!(
            handle.observe_event(
                thread_id,
                &runtime.config,
                &turn_finished_event(&terminal_turn_id),
                0,
                || panic!("finish observation does not construct telemetry"),
            ),
            Some(TurnCostState::Unavailable {
                reason: TurnCostAvailability::ObservationDropped,
            })
        );
    }
    let finished = turn_finished_event(turn_id);
    assert_eq!(
        handle.observe_event(thread_id, &runtime.config, &finished, 0, || panic!(
            "finish observation does not construct telemetry"
        ),),
        None,
        "a failed finish must not emit a second drop notification"
    );
    let dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(dropped_turns.active.is_empty());
    assert!(dropped_turns.dropped.len() <= MAX_DROPPED_TURNS);
    assert!(dropped_turns.order.len() <= MAX_DROPPED_TURNS);
}

#[tokio::test]
async fn failed_started_send_stays_active_until_received_finish() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-start-channel-drop";
    let dropped_turns = runtime.dropped_turns.clone();
    let (sender, mut receiver) = mpsc::channel(1);
    let handle = TurnCostWorkerHandle {
        sender,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager,
        config: runtime.config.clone(),
        dropped_turns: dropped_turns.clone(),
    };
    assert_eq!(
        handle.observe_event(
            thread_id,
            &runtime.config,
            &raw_response_completed_event("channel-filler"),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        None
    );
    let started = Event {
        id: turn_id.to_string(),
        msg: turn_started_event().msg,
    };
    assert_eq!(
        handle.observe_event(thread_id, &runtime.config, &started, 0, || {
            test_session_telemetry(thread_id).0
        }),
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::ObservationDropped,
        })
    );
    {
        let dropped_turns = dropped_turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(dropped_turns.dropped.contains(turn_id));
        assert!(dropped_turns.active.contains(turn_id));
    }

    receiver.recv().await.expect("queued channel filler");
    let finished = turn_finished_event(turn_id);
    assert_eq!(
        handle.observe_event(thread_id, &runtime.config, &finished, 0, || panic!(
            "finish observation does not construct telemetry"
        ),),
        None
    );
    runtime
        .record_observation(receiver.recv().await.expect("queued successful finish"))
        .await;
    let dropped_turns = dropped_turns
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(!dropped_turns.dropped.contains(turn_id));
    assert!(!dropped_turns.active.contains(turn_id));
}

#[tokio::test]
async fn dropped_response_observation_invalidates_tracked_turn_before_price() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager.clone()).await;
    let thread_id = runtime.thread_id;
    let turn_id = "turn-dropped";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;

    let (sender, _receiver) = mpsc::channel(1);
    let handle = TurnCostWorkerHandle {
        sender,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager,
        config: runtime.config.clone(),
        dropped_turns: runtime.dropped_turns.clone(),
    };
    assert_eq!(
        handle.observe_event(thread_id, &runtime.config, &turn_started_event(), 0, || {
            test_session_telemetry(thread_id).0
        }),
        None
    );
    assert_eq!(
        handle.observe_event(
            thread_id,
            &runtime.config,
            &raw_response_completed_event(turn_id),
            0,
            || panic!("response observation does not construct telemetry"),
        ),
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::ObservationDropped,
        })
    );
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Finished { interrupted: false },
        })
        .await;

    runtime
        .process_api_key_cost(
            turn_id,
            &ApiKeyTurnCost {
                turn_id: turn_id.to_string(),
                status: ApiKeyTurnCostStatus::Priced,
                total_usd: Some("0.25".to_string()),
                event_count: Some(0),
                responses: None,
                model: None,
                speed: None,
                reasoning_effort: None,
            },
        )
        .await;

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);
    assert!(runtime.notifications.try_recv().is_err());
}

#[tokio::test]
async fn late_notifier_targets_current_subscribers_without_broadcasting() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = runtime.thread_id;
    let (session_telemetry, _metrics) = test_session_telemetry(thread_id);
    runtime
        .record_observation(TurnCostObservation {
            thread_id,
            turn_id: "turn-unsubscribed".to_string(),
            auth_revision: 0,
            kind: TurnCostObservationKind::Started {
                session_telemetry: Box::new(session_telemetry),
            },
        })
        .await;
    assert!(
        runtime
            .thread_state_manager
            .unsubscribe_connection_from_thread(thread_id, ConnectionId(1))
            .await
    );
    runtime
        .process_api_key_cost(
            "turn-unsubscribed",
            &ApiKeyTurnCost {
                turn_id: "turn-unsubscribed".to_string(),
                status: ApiKeyTurnCostStatus::Priced,
                total_usd: Some("0.25".to_string()),
                event_count: Some(0),
                responses: None,
                model: None,
                speed: None,
                reasoning_effort: None,
            },
        )
        .await;
    assert!(runtime.notifications.try_recv().is_err());
    assert!(!runtime.turns.contains_key("turn-unsubscribed"));
}

fn turn_started_event() -> Event {
    Event {
        id: "turn-1".to_string(),
        msg: EventMsg::TurnStarted(TurnStartedEvent {
            turn_id: "turn-1".to_string(),
            trace_id: None,
            started_at: None,
            model_context_window: None,
            collaboration_mode_kind: Default::default(),
        }),
    }
}

fn raw_response_completed_event(turn_id: &str) -> Event {
    Event {
        id: turn_id.to_string(),
        msg: EventMsg::RawResponseCompleted(RawResponseCompletedEvent {
            response_id: "response-1".to_string(),
            token_usage: None,
        }),
    }
}

fn turn_finished_event(turn_id: &str) -> Event {
    Event {
        id: turn_id.to_string(),
        msg: EventMsg::TurnComplete(TurnCompleteEvent {
            turn_id: turn_id.to_string(),
            last_agent_message: None,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
            time_to_first_token_ms: None,
        }),
    }
}

fn priced_cost(turn_id: &str, total_usd: &str) -> ApiKeyTurnCost {
    ApiKeyTurnCost {
        turn_id: turn_id.to_string(),
        status: ApiKeyTurnCostStatus::Priced,
        total_usd: Some(total_usd.to_string()),
        event_count: Some(0),
        responses: None,
        model: None,
        speed: None,
        reasoning_effort: None,
    }
}

#[derive(Clone, Copy)]
enum TestAuthTransition {
    Logout,
    Subscription,
}

async fn assert_start_auth_transition_is_terminal(transition: TestAuthTransition) {
    let auth_home = TempDir::new().expect("temporary auth home");
    let mut config = ConfigBuilder::default()
        .codex_home(auth_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.otel.metrics_exporter = OtelExporterKind::OtlpGrpc {
        endpoint: "http://unused.invalid".to_string(),
        headers: HashMap::new(),
        tls: None,
    };
    let auth_manager = AuthManager::from_auth_for_testing_with_home(
        CodexAuth::from_api_key("sk-before-classification"),
        auth_home.path().to_path_buf(),
    );
    let policy = TurnCostAvailabilityPolicy::new(Arc::new(config.clone()), auth_manager.clone());
    let (observation_tx, mut observation_rx) = mpsc::channel(1);
    let worker = TurnCostWorkerHandle {
        sender: observation_tx,
        auth_changes: auth_manager.auth_change_receiver(),
        auth_manager: auth_manager.clone(),
        config: Arc::new(config.clone()),
        dropped_turns: new_dropped_turns(),
    };
    let thread_id = ThreadId::new();
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel(2);
    let thread_outgoing = ThreadScopedOutgoingMessageSender::new(
        Arc::new(OutgoingMessageSender::new(outgoing_tx)),
        vec![ConnectionId(1)],
        thread_id,
    );
    let event = turn_started_event();
    let (initial_cost, initial_auth_revision, should_forward) = prepare_turn_cost_event(
        &policy,
        Some(&worker),
        &thread_outgoing,
        thread_id,
        &config,
        &event,
        || test_session_telemetry(thread_id).0,
        /*raw_events_enabled*/ false,
    )
    .await;
    assert!(should_forward);
    assert_eq!(
        initial_cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::AwaitingBackendPrice,
        })
    );
    assert!(observation_rx.try_recv().is_err());

    let expected_reason = match transition {
        TestAuthTransition::Logout => {
            auth_manager.logout().await.expect("clear test auth");
            TurnCostAvailability::BackendUnavailable
        }
        TestAuthTransition::Subscription => {
            replace_auth_with_subscription(auth_home.path(), auth_manager.as_ref()).await;
            TurnCostAvailability::SubscriptionAuthentication
        }
    };
    assert_ne!(
        initial_auth_revision,
        current_auth_revision(auth_manager.as_ref())
    );
    let (_telemetry, metrics) = test_session_telemetry(thread_id);
    observe_initial_turn_cost_after_forwarding(
        initial_cost.as_ref(),
        initial_auth_revision,
        Some(&worker),
        &thread_outgoing,
        thread_id,
        &config,
        &event,
        || panic!("rejected start must not capture monetary telemetry"),
    )
    .await;

    let notification = recv_turn_cost_notification(&mut outgoing_rx).await;
    assert_eq!(notification.turn_id, event.id);
    assert_eq!(
        notification.cost,
        TurnCostState::Unavailable {
            reason: expected_reason,
        }
    );
    assert!(outgoing_rx.try_recv().is_err());
    assert!(observation_rx.try_recv().is_err());
    assert_eq!(turn_cost_metric_value(&metrics), None);
}

async fn replace_auth_with_subscription(auth_home: &std::path::Path, auth_manager: &AuthManager) {
    let jwt = "e30.e30.e30";
    save_auth(
        auth_home,
        &AuthDotJson {
            auth_mode: Some(AuthMode::Chatgpt),
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: codex_login::token_data::IdTokenInfo {
                    raw_jwt: jwt.to_string(),
                    ..Default::default()
                },
                access_token: jwt.to_string(),
                refresh_token: "test".to_string(),
                account_id: Some("account-id".to_string()),
            }),
            last_refresh: None,
            agent_identity: None,
            personal_access_token: None,
            bedrock_api_key: None,
        },
        AuthCredentialsStoreMode::File,
        AuthKeyringBackendKind::default(),
    )
    .expect("write replacement subscription auth");
    assert!(auth_manager.reload().await);
}

async fn mount_priced_turn_cost_response(server: &MockServer, turn_id: &str) {
    Mock::given(method("POST"))
        .and(path(TURN_COST_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "turns": [{
                "turn_id": turn_id,
                "status": "priced",
                "total_usd": "0.25",
                "event_count": 0
            }]
        })))
        .expect(2)
        .mount(server)
        .await;
}

fn current_auth_revision(auth_manager: &AuthManager) -> u64 {
    let receiver = auth_manager.auth_change_receiver();
    let revision = *receiver.borrow();
    revision
}

struct TestRuntime {
    runtime: WorkerRuntime,
    thread_id: ThreadId,
    thread_state_manager: ThreadStateManager,
    notifications: mpsc::Receiver<OutgoingEnvelope>,
}

impl Deref for TestRuntime {
    type Target = WorkerRuntime;

    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl DerefMut for TestRuntime {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}

async fn test_runtime(server: &MockServer, auth_manager: Arc<AuthManager>) -> TestRuntime {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.chatgpt_base_url = server.uri();
    let thread_id = ThreadId::new();
    let (late_notifier, thread_state_manager, notifications) = test_late_notifier(thread_id).await;
    TestRuntime {
        runtime: WorkerRuntime {
            config: Arc::new(config),
            auth_manager: auth_manager.clone(),
            backend: TurnCostBackend::OpenAiApiKey(auth_manager),
            turns: HashMap::new(),
            late_notifier,
            dropped_turns: new_dropped_turns(),
        },
        thread_id,
        thread_state_manager,
        notifications,
    }
}

async fn test_late_notifier(
    thread_id: ThreadId,
) -> (
    TurnCostLateNotifier,
    ThreadStateManager,
    mpsc::Receiver<OutgoingEnvelope>,
) {
    let (tx, rx) = mpsc::channel(8);
    let outgoing = Arc::new(OutgoingMessageSender::new(tx));
    let thread_state_manager = ThreadStateManager::new();
    thread_state_manager
        .connection_initialized(ConnectionId(1), ConnectionCapabilities::default())
        .await;
    thread_state_manager
        .connection_initialized(ConnectionId(2), ConnectionCapabilities::default())
        .await;
    thread_state_manager
        .try_ensure_connection_subscribed(thread_id, ConnectionId(1), false)
        .await
        .expect("test connection should subscribe");
    (
        TurnCostLateNotifier::new(outgoing, thread_state_manager.clone()),
        thread_state_manager,
        rx,
    )
}

async fn recv_cost_state(rx: &mut mpsc::Receiver<OutgoingEnvelope>) -> TurnCostState {
    recv_turn_cost_notification(rx).await.cost
}

async fn recv_turn_cost_notification(
    rx: &mut mpsc::Receiver<OutgoingEnvelope>,
) -> TurnCostUpdatedNotification {
    let ServerNotification::TurnCostUpdated(notification) = recv_server_notification(rx).await
    else {
        panic!("expected turn cost notification");
    };
    notification
}

async fn recv_server_notification(rx: &mut mpsc::Receiver<OutgoingEnvelope>) -> ServerNotification {
    // Wall-clock deadline for the same reason as `wait_for_request_count`: a tokio timeout
    // under a paused clock fires as soon as the runtime idles on the worker's real HTTP.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let envelope = loop {
        match rx.try_recv() {
            Ok(envelope) => break envelope,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                panic!("cost notification channel closed")
            }
            Err(mpsc::error::TryRecvError::Empty) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "timed out waiting for cost notification"
                );
                tokio::task::yield_now().await;
            }
        }
    };
    let message = match envelope {
        OutgoingEnvelope::ToConnection {
            connection_id: ConnectionId(1),
            message,
            ..
        } => message,
        OutgoingEnvelope::ToConnection { connection_id, .. } => {
            panic!("notification targeted non-subscriber {connection_id:?}")
        }
        OutgoingEnvelope::Broadcast { .. } => panic!("cost notification must not broadcast"),
    };
    let OutgoingMessage::AppServerNotification(envelope) = message else {
        panic!("unexpected outgoing message: {message:?}");
    };
    envelope.notification
}

fn test_session_telemetry(thread_id: ThreadId) -> (SessionTelemetry, MetricsClient) {
    let exporter = InMemoryMetricExporter::default();
    let config = MetricsConfig::in_memory("test", "elpis", env!("CARGO_PKG_VERSION"), exporter)
        .with_runtime_reader();
    let metrics = MetricsClient::new(config).expect("test metrics");
    let telemetry = SessionTelemetry::new(
        thread_id,
        "gpt-5.6",
        "gpt-5.6",
        /*account_id*/ None,
        /*account_email*/ None,
        Some(TelemetryAuthMode::ApiKey),
        "test".to_string(),
        /*log_user_prompts*/ false,
        "test".to_string(),
        SessionSource::Cli,
    )
    .with_metrics(metrics.clone());
    (telemetry, metrics)
}

fn turn_cost_metric_value(metrics: &MetricsClient) -> Option<u64> {
    let snapshot = metrics.snapshot().expect("metrics snapshot");
    let metric = snapshot
        .scope_metrics()
        .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
        .find(|metric| metric.name() == "codex.turn.cost_microusd")?;
    match metric.data() {
        AggregatedMetrics::U64(MetricData::Sum(sum)) => {
            sum.data_points().next().map(|point| point.value())
        }
        _ => panic!("unexpected turn-cost metric data type"),
    }
}

/// Advances the paused clock towards `POLL_INTERVAL` one second at a time, yielding between
/// steps, until the mock has seen `expected` requests. Jumping the whole interval at once
/// races an in-flight probe response against the worker's request timeout: on a slow
/// runner the timeout fires first, the worker drops to retry mode, and its next tick
/// re-probes instead of polling the cost.
async fn advance_until_request_count(server: &MockServer, expected: usize) {
    let step = Duration::from_secs(1);
    let mut advanced = Duration::ZERO;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        let requests = server.received_requests().await.unwrap_or_default();
        if requests.len() >= expected {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {expected} turn-cost requests; saw {}",
            requests.len()
        );
        if advanced < POLL_INTERVAL {
            tokio::time::advance(step).await;
            advanced += step;
        }
    }
}

/// Polls the mock server for `expected` requests against a wall-clock deadline. Several
/// callers run on a paused tokio clock while the worker does real HTTP to the mock, and a
/// tokio `timeout` there fires as soon as the runtime idles on that I/O, which made these
/// tests flaky on slow runners. A wall-clock deadline cannot be auto-advanced.
async fn wait_for_request_count(server: &MockServer, expected: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let requests = server.received_requests().await.unwrap_or_default();
        if requests.len() >= expected {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {expected} turn-cost requests; saw {}",
            requests.len()
        );
        tokio::task::yield_now().await;
    }
}

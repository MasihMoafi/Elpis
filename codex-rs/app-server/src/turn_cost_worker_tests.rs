use super::*;
use codex_backend_client::ApiKeyResponseCost;
use codex_config::types::OtelExporterKind;
use codex_core::config::ConfigBuilder;
use codex_login::CodexAuth;
use codex_otel::MetricsClient;
use codex_otel::MetricsConfig;
use codex_otel::TelemetryAuthMode;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::TurnStartedEvent;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::MetricData;
use pretty_assertions::assert_eq;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;
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

    assert!(TurnCostWorker::spawn(Arc::new(config), auth_manager).is_none());
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

    let worker = TurnCostWorker::spawn(Arc::new(config), auth_manager)
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
    let worker = TurnCostWorker::spawn(Arc::new(config.clone()), auth_manager)
        .expect("configured metrics should create the dormant worker");
    let handle = worker.handle();
    let thread_id = ThreadId::new();
    let event = turn_started_event();

    handle.observe_event(thread_id, &config, &event, || {
        panic!("subscription turn must not capture monetary-cost telemetry")
    });
    tokio::task::yield_now().await;

    assert!(
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty()
    );
    worker.shutdown();
}

#[tokio::test]
async fn priced_cost_records_only_after_every_response_arrives() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = ThreadId::new();
    let turn_id = "turn-1";
    let (session_telemetry, metrics) = test_session_telemetry(thread_id);

    runtime.record_observation(TurnCostObservation {
        thread_id,
        turn_id: turn_id.to_string(),
        kind: TurnCostObservationKind::Started {
            session_telemetry: Box::new(session_telemetry),
        },
    });
    for _ in 0..2 {
        runtime.record_observation(TurnCostObservation {
            thread_id,
            turn_id: turn_id.to_string(),
            kind: TurnCostObservationKind::ResponseCompleted,
        });
    }
    runtime.record_observation(TurnCostObservation {
        thread_id,
        turn_id: turn_id.to_string(),
        kind: TurnCostObservationKind::Finished { interrupted: false },
    });

    let mut cost = ApiKeyTurnCost {
        turn_id: turn_id.to_string(),
        status: ApiKeyTurnCostStatus::Priced,
        total_usd: Some("1.25".to_string()),
        event_count: Some(2),
        responses: Some(vec![ApiKeyResponseCost {
            response_id: "resp-one".to_string(),
            total_usd: "0.75".to_string(),
        }]),
        model: Some("gpt-5.6".to_string()),
        speed: Some("fast".to_string()),
        reasoning_effort: Some("high".to_string()),
    };
    runtime.process_api_key_cost(turn_id, &cost);

    assert!(runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), None);

    cost.responses
        .as_mut()
        .expect("response costs")
        .push(ApiKeyResponseCost {
            response_id: "resp-two".to_string(),
            total_usd: "0.50".to_string(),
        });
    runtime.process_api_key_cost(turn_id, &cost);

    assert!(!runtime.turns.contains_key(turn_id));
    assert_eq!(turn_cost_metric_value(&metrics), Some(1_250_000));
}

#[tokio::test]
async fn stalled_pending_cost_is_dropped_after_the_bounded_retry_budget() {
    let server = MockServer::start().await;
    let auth_manager = AuthManager::from_auth_for_testing(CodexAuth::from_api_key("sk-test"));
    let mut runtime = test_runtime(&server, auth_manager).await;
    let thread_id = ThreadId::new();
    let turn_id = "turn-stalled";
    let (session_telemetry, _metrics) = test_session_telemetry(thread_id);
    runtime.record_observation(TurnCostObservation {
        thread_id,
        turn_id: turn_id.to_string(),
        kind: TurnCostObservationKind::Started {
            session_telemetry: Box::new(session_telemetry),
        },
    });
    runtime.record_observation(TurnCostObservation {
        thread_id,
        turn_id: turn_id.to_string(),
        kind: TurnCostObservationKind::Finished { interrupted: true },
    });
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
        runtime.process_api_key_cost(turn_id, &pending);
        assert!(runtime.turns.contains_key(turn_id));
    }
    runtime.process_api_key_cost(turn_id, &pending);

    assert!(!runtime.turns.contains_key(turn_id));
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

async fn test_runtime(server: &MockServer, auth_manager: Arc<AuthManager>) -> WorkerRuntime {
    let codex_home = TempDir::new().expect("temporary Elpis home");
    let mut config = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .build()
        .await
        .expect("test config");
    config.chatgpt_base_url = server.uri();
    WorkerRuntime {
        config: Arc::new(config),
        backend: TurnCostBackend::OpenAiApiKey(auth_manager),
        turns: HashMap::new(),
    }
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

async fn wait_for_request_count(server: &MockServer, expected: usize) {
    timeout(Duration::from_secs(15), async {
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests.len() >= expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("timed out waiting for turn-cost request");
}

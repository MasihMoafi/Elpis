use super::*;

use crate::activity_state::DashboardActivityRow;
use crate::activity_state::DashboardActivityState;
use crate::activity_state::DashboardActivityStatus;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_protocol::TurnProfileSummary;
use pretty_assertions::assert_eq;
use serde_json::Value;
use tiny_http::Header;
use tiny_http::Method;
use tiny_http::Request;
use tiny_http::TestRequest;

const PORT: u16 = 43123;

fn context() -> DashboardContext {
    DashboardContext {
        model: "gpt-safe".to_string(),
        used_tokens: Some(120),
        window_tokens: 1_000,
        used_percent: Some(12),
        categories: Some(vec![DashboardCategory {
            label: "System prompt".to_string(),
            tokens: 20,
            color: "#d946ef".to_string(),
        }]),
        saved_tokens: 5,
        sources: vec![DashboardSource {
            name: "AGENTS.md".to_string(),
            category: "instructions".to_string(),
            estimated_tokens: 10,
            admitted: true,
        }],
        backtrack_points: 2,
    }
}

fn token_totals(total: i64) -> DashboardTokenTotals {
    DashboardTokenTotals {
        input: total - 4,
        cached_input: 1,
        output: 2,
        reasoning_output: 1,
        total,
    }
}

fn tokens() -> DashboardTokens {
    DashboardTokens {
        session_total: Some(token_totals(20)),
        last_turn: Some(token_totals(10)),
    }
}

fn empty_activity() -> DashboardActivityState {
    DashboardActivityState {
        current: None,
        recent: Vec::new(),
        automatic_pruning_enabled: Some(false),
    }
}

fn running_activity(started_at: Option<i64>, cost: Option<TurnCostState>) -> DashboardActivityState {
    DashboardActivityState {
        current: Some(DashboardActivityRow {
            status: DashboardActivityStatus::Running,
            started_at,
            duration_ms: None,
            time_to_first_token_ms: None,
            profile: None,
            cost,
        }),
        ..empty_activity()
    }
}

fn profile() -> TurnProfileSummary {
    TurnProfileSummary {
        before_first_sampling_ms: 1,
        sampling_ms: 2,
        compaction_ms: 3,
        between_sampling_overhead_ms: 4,
        tool_blocking_ms: 5,
        after_last_sampling_ms: 6,
        sampling_request_count: 7,
        sampling_retry_count: 8,
    }
}

fn completed_activity(cost: Option<TurnCostState>) -> DashboardActivityState {
    DashboardActivityState {
        current: None,
        recent: vec![DashboardActivityRow {
            status: DashboardActivityStatus::Completed,
            started_at: None,
            duration_ms: Some(50),
            time_to_first_token_ms: Some(8),
            profile: Some(profile()),
            cost,
        }],
        automatic_pruning_enabled: Some(false),
    }
}

fn state() -> DashboardState {
    let mut slot = None;
    assert!(publish_state_into(
        &mut slot,
        context(),
        tokens(),
        empty_activity(),
        1_000,
    ));
    slot.expect("first publication creates state")
}

fn request(method: Method, path: &str, hosts: &[&str]) -> Request {
    let mut request = TestRequest::new().with_method(method).with_path(path);
    for host in hosts {
        request = request.with_header(
            format!("Host: {host}")
                .parse::<Header>()
                .expect("valid test header"),
        );
    }
    request.into()
}

fn header<'a>(response: &'a DashboardResponse, name: &'static str) -> Option<&'a str> {
    response
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn body(response: DashboardResponse) -> Vec<u8> {
    response.into_reader().into_inner()
}

fn assert_security_headers(response: &DashboardResponse) {
    assert_eq!(header(response, "Cache-Control"), Some("no-store"));
    assert_eq!(header(response, "Content-Security-Policy"), Some(CSP));
    assert_eq!(header(response, "X-Content-Type-Options"), Some("nosniff"));
    assert_eq!(header(response, "X-Frame-Options"), Some("DENY"));
    assert_eq!(header(response, "Access-Control-Allow-Origin"), None);
}

fn assert_keys(value: &Value, expected: &[&str]) {
    let mut actual = value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(actual, expected);
}

#[test]
fn semantic_publication_versions_only_changed_facts() {
    let mut slot = None;
    let base_context = context();
    let base_tokens = tokens();

    assert!(publish_state_into(
        &mut slot,
        base_context.clone(),
        base_tokens.clone(),
        empty_activity(),
        1_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.schema_version), Some(1));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(1));
    assert_eq!(slot.as_ref().map(|state| state.generated_at), Some(1_000));

    assert!(!publish_state_into(
        &mut slot,
        base_context.clone(),
        base_tokens.clone(),
        empty_activity(),
        2_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(1));
    assert_eq!(slot.as_ref().map(|state| state.generated_at), Some(1_000));

    assert!(publish_state_into(
        &mut slot,
        base_context.clone(),
        base_tokens.clone(),
        running_activity(Some(12), None),
        3_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(2));
    assert_eq!(
        slot.as_ref()
            .and_then(|state| state.activity.current.as_ref())
            .and_then(|current| current.started_at),
        Some(12_000)
    );

    assert!(publish_state_into(
        &mut slot,
        base_context.clone(),
        base_tokens.clone(),
        completed_activity(None),
        4_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(3));

    assert!(publish_state_into(
        &mut slot,
        base_context,
        base_tokens,
        completed_activity(Some(TurnCostState::Priced {
            backend_total_usd: "1.250000".to_string(),
        })),
        5_000,
    ));
    let state = slot.as_ref().expect("state remains present");
    assert_eq!(state.revision, 4);
    assert_eq!(state.generated_at, 5_000);
    assert_eq!(
        state.activity.recent[0].cost,
        Some(DashboardCostState::Priced {
            backend_total_usd: "1.250000".to_string(),
        })
    );
}

#[test]
fn context_token_and_reset_changes_each_increment_once() {
    let mut slot = None;
    assert!(publish_state_into(
        &mut slot,
        context(),
        tokens(),
        running_activity(Some(12), None),
        1_000,
    ));

    let mut changed_context = context();
    changed_context.saved_tokens = 6;
    assert!(publish_state_into(
        &mut slot,
        changed_context.clone(),
        tokens(),
        running_activity(Some(12), None),
        2_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(2));

    let mut changed_tokens = tokens();
    changed_tokens.last_turn = Some(token_totals(11));
    assert!(publish_state_into(
        &mut slot,
        changed_context.clone(),
        changed_tokens.clone(),
        running_activity(Some(12), None),
        3_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(3));

    assert!(publish_state_into(
        &mut slot,
        changed_context,
        changed_tokens,
        empty_activity(),
        4_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(4));
    assert_eq!(slot.as_ref().map(|state| state.generated_at), Some(4_000));
}

#[test]
fn activity_wire_mapping_is_snake_case_and_checked() {
    let mut slot = None;
    assert!(publish_state_into(
        &mut slot,
        context(),
        tokens(),
        running_activity(
            Some(i64::MAX),
            Some(TurnCostState::Unavailable {
                reason: TurnCostAvailability::SubscriptionAuthentication,
            }),
        ),
        1_000,
    ));

    let value = serde_json::to_value(slot.as_ref().expect("state")).expect("serialize state");
    let current = &value["activity"]["current"];
    assert_keys(current, &["cost", "started_at", "status"]);
    assert_eq!(current["status"], "running");
    assert_eq!(current["started_at"], Value::Null);
    assert_eq!(current["cost"]["type"], "unavailable");
    assert_eq!(
        current["cost"]["reason"],
        "subscription_authentication"
    );

    let recent = completed_activity(Some(TurnCostState::Priced {
        backend_total_usd: "1.250000".to_string(),
    }));
    assert!(publish_state_into(
        &mut slot,
        context(),
        tokens(),
        recent,
        2_000,
    ));
    let value = serde_json::to_value(slot.expect("state")).expect("serialize state");
    let recent = &value["activity"]["recent"][0];
    assert_keys(
        recent,
        &[
            "cost",
            "duration_ms",
            "profile",
            "status",
            "time_to_first_token_ms",
        ],
    );
    assert_keys(
        &recent["profile"],
        &[
            "after_last_sampling_ms",
            "before_first_sampling_ms",
            "between_sampling_overhead_ms",
            "compaction_ms",
            "sampling_ms",
            "sampling_request_count",
            "sampling_retry_count",
            "tool_blocking_ms",
        ],
    );
    assert_eq!(recent["status"], "completed");
    assert_eq!(
        value["activity"]["recent"][0]["profile"]["sampling_request_count"],
        7
    );
    assert_eq!(
        value["activity"]["recent"][0]["cost"]["backend_total_usd"],
        "1.250000"
    );
    assert!(recent.get("started_at").is_none());
}

#[test]
fn every_unavailable_cost_reason_maps_to_its_snake_case_wire_value() {
    for (reason, expected) in [
        (
            TurnCostAvailability::SubscriptionAuthentication,
            "subscription_authentication",
        ),
        (
            TurnCostAvailability::CostObservationDisabled,
            "cost_observation_disabled",
        ),
        (
            TurnCostAvailability::ProviderUnsupported,
            "provider_unsupported",
        ),
        (
            TurnCostAvailability::AwaitingBackendPrice,
            "awaiting_backend_price",
        ),
        (
            TurnCostAvailability::BackendUnavailable,
            "backend_unavailable",
        ),
        (
            TurnCostAvailability::ObservationDropped,
            "observation_dropped",
        ),
    ] {
        let value = serde_json::to_value(map_cost(TurnCostState::Unavailable { reason }))
            .expect("serialize mapped cost");
        assert_eq!(value["type"], "unavailable");
        assert_eq!(value["reason"], expected);
    }
}

#[test]
fn response_heartbeat_changes_without_revision_churn() {
    let state = state();
    let first = response_for_at(
        &request(Method::Get, "/data.json", &["127.0.0.1:43123"]),
        PORT,
        Some(state.clone()),
        2_000,
    );
    let second = response_for_at(
        &request(Method::Get, "/data.json", &["localhost:43123"]),
        PORT,
        Some(state.clone()),
        3_000,
    );
    let first: Value = serde_json::from_slice(&body(first)).expect("first envelope");
    let second: Value = serde_json::from_slice(&body(second)).expect("second envelope");

    assert_eq!(first["state"]["revision"], 1);
    assert_eq!(second["state"]["revision"], 1);
    assert_eq!(first["heartbeat_at"], 2_000);
    assert_eq!(second["heartbeat_at"], 3_000);
    assert_eq!(state.revision, 1);
    assert_eq!(state.generated_at, 1_000);
}

#[test]
fn envelope_and_nested_wire_dtos_deserialize_for_frozen_fixtures() {
    let envelope = DashboardEnvelope {
        state: state(),
        heartbeat_at: 2_000,
    };
    let encoded = serde_json::to_value(&envelope).expect("serialize envelope");
    let decoded: DashboardEnvelope =
        serde_json::from_value(encoded).expect("deserialize envelope fixture");

    assert_eq!(decoded, envelope);
}

#[test]
fn unknown_facts_remain_null_and_state_has_only_safe_fields() {
    let mut slot = None;
    let mut unknown_context = context();
    unknown_context.used_tokens = None;
    unknown_context.used_percent = None;
    unknown_context.categories = None;
    assert!(publish_state_into(
        &mut slot,
        unknown_context,
        DashboardTokens {
            session_total: None,
            last_turn: None,
        },
        DashboardActivityState {
            automatic_pruning_enabled: None,
            ..empty_activity()
        },
        1_000,
    ));
    let value = serde_json::to_value(slot.expect("state")).expect("serialize state");

    assert_keys(
        &value,
        &[
            "activity",
            "context",
            "generated_at",
            "revision",
            "schema_version",
            "tokens",
        ],
    );
    assert_keys(
        &value["context"],
        &[
            "backtrack_points",
            "categories",
            "model",
            "saved_tokens",
            "sources",
            "used_percent",
            "used_tokens",
            "window_tokens",
        ],
    );
    assert_keys(&value["tokens"], &["last_turn", "session_total"]);
    assert_keys(
        &value["activity"],
        &["automatic_pruning_enabled", "current", "recent"],
    );
    assert_eq!(value["context"]["used_tokens"], Value::Null);
    assert_eq!(value["context"]["used_percent"], Value::Null);
    assert_eq!(value["context"]["categories"], Value::Null);
    assert_eq!(value["tokens"]["session_total"], Value::Null);
    assert_eq!(value["tokens"]["last_turn"], Value::Null);
    assert_eq!(
        value["activity"]["automatic_pruning_enabled"],
        Value::Null
    );
    let serialized = value.to_string();
    for forbidden in [
        "prompt",
        "agent_response",
        "tool_output",
        "account",
        "credential",
        "trace_id",
        "turn_id",
        "thread_id",
        "/home/private-user",
        "backendTotalUsd",
        "samplingRequestCount",
        "automaticPruningEnabled",
        "startedAt",
        "timeToFirstTokenMs",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn serialization_failure_is_safe_and_retains_state() {
    let state = state();
    let unavailable = data_response_with(state.clone(), 2_000, |_| Err::<Vec<u8>, ()>(()));
    assert_eq!(unavailable.status_code(), 503);
    assert_eq!(
        header(&unavailable, "Content-Type"),
        Some("application/json; charset=utf-8")
    );
    assert_security_headers(&unavailable);
    assert_eq!(body(unavailable).as_slice(), UNAVAILABLE_JSON);

    let recovered = data_response_with(state.clone(), 3_000, serde_json::to_vec);
    assert_eq!(recovered.status_code(), 200);
    let value: Value = serde_json::from_slice(&body(recovered)).expect("recovered envelope");
    assert_eq!(value["state"]["revision"], 1);
    assert_eq!(value["heartbeat_at"], 3_000);
    assert_eq!(state.revision, 1);
}

#[test]
fn data_is_unavailable_until_the_first_typed_state_publication() {
    let response = response_for_at(
        &request(Method::Get, "/data.json", &["localhost:43123"]),
        PORT,
        None,
        2_000,
    );

    assert_eq!(response.status_code(), 503);
    assert_eq!(
        header(&response, "Content-Type"),
        Some("application/json; charset=utf-8")
    );
    assert_security_headers(&response);
    assert_eq!(body(response).as_slice(), UNAVAILABLE_JSON);
}

#[test]
fn bind_host_method_and_path_guards_are_exact_and_read_only() {
    let bind = dashboard_bind_addr();
    assert_eq!(bind.ip().to_string(), "127.0.0.1");
    assert_eq!(bind.port(), 0);
    let state = state();

    for (host, path, content_type) in [
        ("127.0.0.1:43123", "/", "text/html; charset=utf-8"),
        ("LOCALHOST:43123", "/index.html", "text/html; charset=utf-8"),
        (
            "localhost:43123",
            "/data.json",
            "application/json; charset=utf-8",
        ),
    ] {
        let response = response_for_at(
            &request(Method::Get, path, &[host]),
            PORT,
            Some(state.clone()),
            2_000,
        );
        assert_eq!(response.status_code(), 200, "host={host} path={path}");
        assert_eq!(header(&response, "Content-Type"), Some(content_type));
        assert_security_headers(&response);
    }

    for hosts in [
        Vec::<&str>::new(),
        vec!["127.0.0.1:43123", "localhost:43123"],
        vec!["evil.example:43123"],
        vec!["localhost:43124"],
        vec!["localhost"],
    ] {
        let response = response_for_at(
            &request(Method::Get, "/", &hosts),
            PORT,
            Some(state.clone()),
            2_000,
        );
        assert_eq!(response.status_code(), 403, "hosts={hosts:?}");
        assert_security_headers(&response);
    }
    let foreign_post = response_for_at(
        &request(Method::Post, "/missing", &["evil.example:43123"]),
        PORT,
        Some(state.clone()),
        2_000,
    );
    assert_eq!(foreign_post.status_code(), 403);
    assert_security_headers(&foreign_post);

    for method in [
        Method::Head,
        Method::Post,
        Method::Put,
        Method::Delete,
        Method::Patch,
        Method::Options,
        Method::Trace,
    ] {
        let response = response_for_at(
            &request(method.clone(), "/data.json", &["localhost:43123"]),
            PORT,
            Some(state.clone()),
            2_000,
        );
        assert_eq!(response.status_code(), 405, "method={method:?}");
        assert_security_headers(&response);
    }

    for path in [
        "/missing",
        "/data.json?fresh=1",
        "/%64ata.json",
        "/index.html/",
    ] {
        let response = response_for_at(
            &request(Method::Get, path, &["localhost:43123"]),
            PORT,
            Some(state.clone()),
            2_000,
        );
        assert_eq!(response.status_code(), 404, "path={path}");
        assert_security_headers(&response);
    }

    assert_eq!(state.revision, 1);
    assert_eq!(state.generated_at, 1_000);
}

#[test]
fn failed_server_start_does_not_latch_and_success_is_reused() {
    let slot = std::sync::Mutex::new(None);
    let attempts = std::cell::Cell::new(0);

    assert_eq!(
        ensure_server_url(&slot, || {
            attempts.set(attempts.get() + 1);
            None
        }),
        None
    );
    assert_eq!(
        ensure_server_url(&slot, || {
            attempts.set(attempts.get() + 1);
            Some("http://127.0.0.1:43123".to_string())
        }),
        Some("http://127.0.0.1:43123".to_string())
    );
    assert_eq!(
        ensure_server_url(&slot, || {
            attempts.set(attempts.get() + 1);
            Some("unexpected".to_string())
        }),
        Some("http://127.0.0.1:43123".to_string())
    );
    assert_eq!(attempts.get(), 2);
}

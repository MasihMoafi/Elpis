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
const ACTIVITY_FIXTURE: &str =
    include_str!("dashboard_assets/fixtures/activity-state.json");

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
        manual_memory: None,
    }
}

fn ready_manual_memory(state: DashboardManualMemoryState) -> DashboardManualMemory {
    DashboardManualMemory {
        phase: DashboardManualMemoryPhase::Ready,
        state: Some(state),
        request_chars_if_admitted: Some(8_000),
        eligible_chars_now: Some(if state == DashboardManualMemoryState::Admitted {
            8_000
        } else {
            0
        }),
        limit_chars: Some(8_000),
        truncated: Some(true),
        unavailable_reason: None,
        admission_pending: false,
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
fn manual_memory_changes_increment_revision_without_churning_other_facts() {
    let mut slot = None;
    let mut dashboard_context = context();
    dashboard_context.manual_memory = Some(DashboardManualMemory {
        phase: DashboardManualMemoryPhase::Loading,
        state: None,
        request_chars_if_admitted: None,
        eligible_chars_now: None,
        limit_chars: None,
        truncated: None,
        unavailable_reason: None,
        admission_pending: false,
    });
    assert!(publish_state_into(
        &mut slot,
        dashboard_context.clone(),
        tokens(),
        empty_activity(),
        1_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(1));

    dashboard_context.manual_memory = Some(ready_manual_memory(
        DashboardManualMemoryState::Admitted,
    ));
    assert!(publish_state_into(
        &mut slot,
        dashboard_context.clone(),
        tokens(),
        empty_activity(),
        2_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(2));

    dashboard_context.manual_memory = Some(DashboardManualMemory {
        phase: DashboardManualMemoryPhase::Loading,
        admission_pending: true,
        ..DashboardManualMemory::loading()
    });
    assert!(publish_state_into(
        &mut slot,
        dashboard_context.clone(),
        tokens(),
        empty_activity(),
        3_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(3));

    dashboard_context.manual_memory = Some(DashboardManualMemory {
        phase: DashboardManualMemoryPhase::Unavailable,
        unavailable_reason: Some(DashboardManualMemoryUnavailableReason::WorkerFailed),
        ..DashboardManualMemory::loading()
    });
    assert!(publish_state_into(
        &mut slot,
        dashboard_context,
        tokens(),
        empty_activity(),
        4_000,
    ));
    assert_eq!(slot.as_ref().map(|state| state.revision), Some(4));
}

#[test]
fn manual_memory_wire_is_additive_snake_case_and_path_free() {
    let mut dashboard_context = context();
    dashboard_context.manual_memory = Some(ready_manual_memory(
        DashboardManualMemoryState::AvailableNotAdmitted,
    ));
    let mut slot = None;
    assert!(publish_state_into(
        &mut slot,
        dashboard_context,
        tokens(),
        empty_activity(),
        1_000,
    ));

    let value = serde_json::to_value(slot.expect("typed state")).expect("serialize state");
    let memory = &value["context"]["manual_memory"];
    assert_keys(
        memory,
        &[
            "admission_pending",
            "eligible_chars_now",
            "limit_chars",
            "phase",
            "request_chars_if_admitted",
            "state",
            "truncated",
            "unavailable_reason",
        ],
    );
    assert_eq!(memory["phase"], "ready");
    assert_eq!(memory["state"], "available_not_admitted");
    assert_eq!(memory["request_chars_if_admitted"], 8_000);
    assert_eq!(memory["eligible_chars_now"], 0);
    assert_eq!(memory["limit_chars"], 8_000);
    assert_eq!(memory["truncated"], true);
    assert_eq!(memory["unavailable_reason"], Value::Null);
    assert_eq!(memory["admission_pending"], false);

    let serialized = value.to_string();
    for forbidden in [
        "/home/private-user/.elpis/memories/MEMORY.md",
        "PLANTED_MEMORY_BODY",
        "raw admission parse failure",
        "memory_path",
        "body",
        "bytes",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn every_manual_memory_unavailable_reason_has_a_distinct_wire_value() {
    for (reason, expected) in [
        (
            DashboardManualMemoryUnavailableReason::AdmissionUnavailable,
            "admission_unavailable",
        ),
        (
            DashboardManualMemoryUnavailableReason::MemoryUnreadable,
            "memory_unreadable",
        ),
        (
            DashboardManualMemoryUnavailableReason::InvalidUtf8,
            "invalid_utf8",
        ),
        (
            DashboardManualMemoryUnavailableReason::MemoryPathNotFile,
            "memory_path_not_file",
        ),
        (
            DashboardManualMemoryUnavailableReason::SourcesUnavailable,
            "sources_unavailable",
        ),
        (
            DashboardManualMemoryUnavailableReason::WorkerFailed,
            "worker_failed",
        ),
    ] {
        let value = serde_json::to_value(reason).expect("serialize reason");
        assert_eq!(value, expected);
    }
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
            "manual_memory",
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
    assert_eq!(value["context"]["manual_memory"], Value::Null);
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

#[test]
fn activity_fixture_round_trips_only_typed_safe_facts() {
    for hostile in [
        "<img src=x onerror=1>",
        "<script>",
        "/home/private-user/secret",
    ] {
        assert!(ACTIVITY_FIXTURE.contains(hostile));
    }

    let raw: Value = serde_json::from_str(ACTIVITY_FIXTURE).expect("fixture is JSON");
    assert_eq!(raw["hostile"]["markup"], "<img src=x onerror=1>");
    assert_eq!(raw["hostile"]["script"], "<script>");
    assert_eq!(raw["hostile"]["path"], "/home/private-user/secret");

    let envelope: DashboardEnvelope =
        serde_json::from_str(ACTIVITY_FIXTURE).expect("fixture matches dashboard wire");
    assert_eq!(envelope.state.schema_version, 1);
    assert_eq!(envelope.state.context.manual_memory, None);
    assert_eq!(envelope.state.activity.recent.len(), 2);
    assert_eq!(
        envelope
            .state
            .activity
            .current
            .as_ref()
            .map(|turn| turn.status),
        Some(super::DashboardActivityStatus::Running)
    );
    assert_eq!(
        envelope
            .state
            .activity
            .current
            .as_ref()
            .and_then(|turn| turn.cost.as_ref()),
        Some(&DashboardCostState::Unavailable {
            reason: DashboardCostAvailability::AwaitingBackendPrice,
        })
    );

    let interrupted = &envelope.state.activity.recent[0];
    assert_eq!(
        interrupted.status,
        super::DashboardActivityStatus::Interrupted
    );
    assert_eq!(
        interrupted.cost.as_ref(),
        Some(&DashboardCostState::Unavailable {
            reason: DashboardCostAvailability::SubscriptionAuthentication,
        })
    );

    let completed = &envelope.state.activity.recent[1];
    assert_eq!(completed.status, super::DashboardActivityStatus::Completed);
    assert_eq!(completed.duration_ms, Some(930));
    assert_eq!(completed.time_to_first_token_ms, Some(240));
    let profile = completed.profile.as_ref().expect("measured profile");
    assert_eq!(profile.before_first_sampling_ms, 100);
    assert_eq!(profile.sampling_ms, 200);
    assert_eq!(profile.compaction_ms, 30);
    assert_eq!(profile.between_sampling_overhead_ms, 40);
    assert_eq!(profile.tool_blocking_ms, 500);
    assert_eq!(profile.after_last_sampling_ms, 60);
    assert_eq!(profile.sampling_request_count, 3);
    assert_eq!(profile.sampling_retry_count, 1);
    assert_eq!(
        completed.cost.as_ref(),
        Some(&DashboardCostState::Priced {
            backend_total_usd: "1.250000".to_string(),
        })
    );

    let typed = serde_json::to_string(&envelope).expect("serialize typed fixture");
    for hostile in [
        "<img src=x onerror=1>",
        "<script>",
        "/home/private-user/secret",
    ] {
        assert!(!typed.contains(hostile), "typed wire retained {hostile}");
    }
}

#[test]
fn dashboard_asset_exposes_truthful_activity_and_existing_views() {
    for id in [
        "tab-activity",
        "tab-context",
        "tab-tokens",
        "panel-activity",
        "panel-context",
        "panel-tokens",
        "activity-now",
        "activity-elapsed",
        "activity-current-cost",
        "activity-latest-status",
        "activity-latest-total",
        "activity-latest-ttft",
        "activity-latest-requests",
        "activity-latest-retries",
        "activity-latest-cost",
        "activity-profile",
        "activity-profile-empty",
        "activity-recent-rows",
        "activity-recent-empty",
        "activity-pruning",
        "updates-toggle",
        "refresh-now",
        "freshness-status",
        "ctx-used",
        "ctx-bar",
        "manual-memory-card",
        "manual-memory-state",
        "manual-memory-summary",
        "manual-memory-detail",
        "src-rows",
        "tok-input",
        "tok-last",
    ] {
        assert!(INDEX_HTML.contains(&format!("id=\"{id}\"")), "missing {id}");
    }

    for text in [
        "Running",
        "Idle",
        "Timing breakdown unavailable for this turn",
        "Cost unavailable for subscription authentication",
        "Cost unavailable — awaiting backend price",
        "Backend-reported",
        "Pause updates",
        "Resume updates",
        "Refresh now",
        "Fresh",
        "Stale",
        "Unavailable",
        "Experimental · On",
        "Experimental · Off",
        "Experimental · Unavailable",
        "Manual memory",
        "Available — not admitted",
        "Admission update pending",
        "Memory source discovery is unavailable",
        "The memory status worker failed",
    ] {
        assert!(INDEX_HTML.contains(text), "missing copy: {text}");
    }

    assert!(!INDEX_HTML.contains("Elpis is plan-based"));
    assert!(!INDEX_HTML.contains("$0"));
}

#[test]
fn dashboard_asset_has_no_dynamic_html_css_network_or_storage_sink() {
    for forbidden in [
        ".innerHTML",
        ".outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "localStorage",
        "sessionStorage",
        "http://",
        "https://",
        ".style.",
        "activity-state.json",
        "<img src=x onerror=1>",
        "/home/private-user",
    ] {
        assert!(!INDEX_HTML.contains(forbidden), "unsafe asset token: {forbidden}");
    }
    for safe in [
        "document.createElement",
        ".replaceChildren(",
        ".append(",
        ".textContent",
        "const STATUS_LABELS",
        "const COST_LABELS",
        "const CATEGORY_CLASSES",
        "const MEMORY_STATE_LABELS",
        "const MEMORY_REASON_LABELS",
        "function renderManualMemory(memory)",
    ] {
        assert!(INDEX_HTML.contains(safe), "missing safe DOM guard: {safe}");
    }
}

#[test]
fn dashboard_asset_renders_manual_memory_with_closed_safe_mappings() {
    for source in [
        "const MEMORY_PHASE_LABELS = Object.freeze({",
        "const MEMORY_STATE_LABELS = Object.freeze({",
        "const MEMORY_REASON_LABELS = Object.freeze({",
        "admission_unavailable: 'Memory admission status is unavailable'",
        "memory_unreadable: 'The memory file is unreadable'",
        "invalid_utf8: 'The memory file is not valid UTF-8'",
        "memory_path_not_file: 'The configured memory path is not a file'",
        "sources_unavailable: 'Memory source discovery is unavailable'",
        "worker_failed: 'The memory status worker failed'",
        "const stateLabel = ownValue(MEMORY_STATE_LABELS, memory.state)",
        "const reasonLabel = ownValue(MEMORY_REASON_LABELS, memory.unavailable_reason)",
        "memory.admission_pending === true",
        "renderManualMemory(context.manual_memory)",
        "setText('manual-memory-summary'",
        "setText('manual-memory-detail'",
    ] {
        assert!(INDEX_HTML.contains(source), "missing memory guard: {source}");
    }

    let renderer = INDEX_HTML
        .split("function renderManualMemory(memory) {")
        .nth(1)
        .and_then(|tail| tail.split("\n}\n\nfunction renderContext").next())
        .expect("manual memory renderer");
    for forbidden in [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "memory.path",
        "memory.body",
        "memory.bytes",
        "unavailable_reason +",
        "memory.state +",
        "stateElement.className = 'memory-state tone-ember'",
    ] {
        assert!(!renderer.contains(forbidden), "unsafe memory renderer: {forbidden}");
    }

    let observation = INDEX_HTML
        .split("<div class=\"memory-observation\"")
        .nth(1)
        .and_then(|tail| tail.split('>').next())
        .expect("manual memory observation");
    for repeated_announcement in ["role=\"status\"", "aria-live", "aria-atomic"] {
        assert!(
            !observation.contains(repeated_announcement),
            "polling memory row must stay quiet: {repeated_announcement}"
        );
    }
}

#[test]
fn dashboard_asset_validates_envelope_and_preserves_last_good_state() {
    for source in [
        "fetch('/data.json'",
        "if (!res.ok)",
        "envelope.state.schema_version !== 1",
        "!Number.isFinite(envelope.heartbeat_at)",
        "lastValidState = envelope.state",
        "lastHeartbeat = envelope.heartbeat_at",
        "const latest = recent.at(-1)",
        "if (!latest)",
        "[...recent].reverse().slice(0, 20)",
        "Array.isArray(context.categories)",
        "renderTokenTotals(tokens.session_total",
        "renderTokenTotals(tokens.last_turn",
        "lastHeartbeat - current.started_at",
        "Date.now() - heartbeatReceivedAt",
    ] {
        assert!(INDEX_HTML.contains(source), "missing envelope guard: {source}");
    }
    assert!(!INDEX_HTML.contains("lastHeartbeat = Date.now"));
    assert!(!INDEX_HTML.contains("current.started_at * 1000"));
    assert!(!INDEX_HTML.contains("current.started_at*1000"));
    let freshness = INDEX_HTML
        .split("function renderFreshness() {")
        .nth(1)
        .and_then(|tail| tail.split("\n}\n\nfunction renderState").next())
        .expect("freshness function");
    assert!(freshness.contains("Date.now() - lastHeartbeat"));
    assert!(!freshness.contains("heartbeatReceivedAt"));
}

#[test]
fn dashboard_asset_maps_every_unavailable_cost_without_a_price() {
    for mapping in [
        "subscription_authentication: 'Cost unavailable for subscription authentication'",
        "cost_observation_disabled: 'Cost unavailable — cost observation is disabled'",
        "provider_unsupported: 'Cost unavailable — provider unsupported'",
        "awaiting_backend_price: 'Cost unavailable — awaiting backend price'",
        "backend_unavailable: 'Cost unavailable — backend unavailable'",
        "observation_dropped: 'Cost unavailable — observation dropped'",
    ] {
        assert!(INDEX_HTML.contains(mapping), "missing cost map: {mapping}");
    }
    let unavailable_map = INDEX_HTML
        .split("const COST_LABELS = Object.freeze({")
        .nth(1)
        .and_then(|tail| tail.split("});").next())
        .expect("closed unavailable-cost map");
    assert!(!unavailable_map.contains("Backend-reported"));
    assert!(INDEX_HTML.contains("cost.type === 'priced'"));
    assert!(INDEX_HTML.contains("cost.type === 'unavailable'"));
}

#[test]
fn dashboard_asset_rejects_inherited_map_keys_and_stale_refreshes() {
    for source in [
        "function ownValue(map, key)",
        "Object.hasOwn(map, key)",
        "ownValue(STATUS_LABELS, status)",
        "ownValue(COST_LABELS, cost.reason)",
        "ownValue(CATEGORY_CLASSES, category.color)",
        "let refreshEpoch = 0",
        "let nextRequestId = 0",
        "let newestAcceptedRequestId = 0",
        "const requestEpoch = refreshEpoch",
        "const requestId = ++nextRequestId",
        "requestEpoch !== refreshEpoch",
        "requestId < newestAcceptedRequestId",
        "newestAcceptedRequestId = requestId",
        "refreshEpoch += 1",
        "const pollingEpoch = refreshEpoch",
        "!updatesPaused && pollingEpoch === refreshEpoch",
        "const elapsedEpoch = refreshEpoch",
        "!updatesPaused && elapsedEpoch === refreshEpoch",
        "byId('refresh-now').addEventListener('click', refresh)",
    ] {
        assert!(INDEX_HTML.contains(source), "missing race/map guard: {source}");
    }
    for unsafe_lookup in [
        "STATUS_LABELS[status]",
        "COST_LABELS[cost.reason]",
        "CATEGORY_CLASSES[category.color]",
    ] {
        assert!(
            !INDEX_HTML.contains(unsafe_lookup),
            "prototype-chain lookup remains: {unsafe_lookup}"
        );
    }

    assert_eq!(INDEX_HTML.matches("refreshEpoch += 1").count(), 1);
    assert_eq!(
        INDEX_HTML
            .matches("newestAcceptedRequestId = requestId")
            .count(),
        1
    );
    let validated = INDEX_HTML
        .find("envelope.state.schema_version !== 1")
        .expect("schema validation");
    let stale_guard = INDEX_HTML
        .find("requestEpoch !== refreshEpoch")
        .expect("epoch guard");
    let accepted = INDEX_HTML
        .find("newestAcceptedRequestId = requestId")
        .expect("accepted request update");
    let published = INDEX_HTML
        .find("lastValidState = envelope.state")
        .expect("state publication");
    assert!(validated < stale_guard);
    assert!(stale_guard < accepted);
    assert!(accepted < published);
}

#[test]
fn dashboard_asset_has_keyboard_responsive_and_timer_controls() {
    for source in [
        "role=\"tablist\"",
        "role=\"tab\"",
        "role=\"tabpanel\"",
        "aria-selected=\"true\"",
        "aria-selected=\"false\"",
        "tab.tabIndex",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        ":focus-visible",
        "@media (max-width:",
        "overflow-x:auto",
        "@media (prefers-reduced-motion: reduce)",
        "let pollTimer",
        "let elapsedTimer",
        "let freshnessTimer",
        "clearInterval(pollTimer)",
        "clearInterval(elapsedTimer)",
    ] {
        assert!(INDEX_HTML.contains(source), "missing interaction guard: {source}");
    }

    let activity_tab = INDEX_HTML.find("id=\"tab-activity\"").expect("Activity tab");
    let context_tab = INDEX_HTML.find("id=\"tab-context\"").expect("Context tab");
    assert!(activity_tab < context_tab, "Activity must be the first tab");
    let activity_tab_tag = INDEX_HTML[activity_tab..]
        .split('>')
        .next()
        .expect("Activity tab opening tag");
    assert!(activity_tab_tag.contains("aria-selected=\"true\""));
    let activity_panel = INDEX_HTML
        .split("<section class=\"panel\" id=\"panel-activity\"")
        .nth(1)
        .and_then(|tail| tail.split('>').next())
        .expect("Activity panel opening tag");
    assert!(!activity_panel.contains("hidden"));
    assert!(INDEX_HTML.contains(
        "id=\"freshness-status\" role=\"status\" aria-live=\"polite\""
    ));
}

#[test]
fn dashboard_asset_uses_the_elpis_observatory_visual_system() {
    for token in [
        "--night-ledger:#0d0b0f",
        "--smoked-plum:#181319",
        "--iron-rule:#33272f",
        "--bone:#f2e9e6",
        "--ash-rose:#aa9ba2",
        "--ember:#d45b6a",
        "--flare:#f08a78",
        "--verdigris:#70b9a4",
    ] {
        assert!(INDEX_HTML.contains(token), "missing palette token: {token}");
    }

    for id in [
        "observation-frame",
        "elpis-wordmark",
        "live-summary",
        "activity-signal",
        "activity-signal-label",
        "observation-spine",
        "phase-meter-before-first",
        "phase-meter-sampling",
        "phase-meter-compaction",
        "phase-meter-between",
        "phase-meter-tools",
        "phase-meter-after-last",
    ] {
        assert!(INDEX_HTML.contains(id), "missing observatory id: {id}");
    }

    for source in [
        "class=\"wrap observation-frame\" id=\"observation-frame\"",
        "class=\"live-summary\" id=\"live-summary\"",
        "class=\"signal signal-idle\" id=\"activity-signal\"",
        "class=\"observation-spine\" id=\"observation-spine\"",
        "const signalRunning = current && current.status === 'running'",
        "signal.className = signalRunning ? 'signal signal-running' : 'signal signal-idle'",
        "signalRunning ? 'elpising' : 'Idle'",
        "const phaseValues = PROFILE_FIELDS.map(([, field]) => profile[field]).filter(isCount)",
        "const phaseTotal = phaseValues.reduce((total, value) => total + value, 0)",
        "Number.isFinite(phaseTotal) && phaseTotal > 0",
        ": Math.max(1, ...phaseValues)",
        "if (isCount(value)) {",
        "document.createElement('meter')",
        "meter.id = meterId",
        "meter.className = 'phase-meter'",
        "meter.min = 0",
        "meter.max = meterMax",
        "meter.value = value",
        "meter.setAttribute('aria-hidden', 'true')",
    ] {
        assert!(INDEX_HTML.contains(source), "missing visual guard: {source}");
    }

    let profile_renderer = INDEX_HTML
        .split("function renderProfile(profile) {")
        .nth(1)
        .and_then(|tail| tail.split("\n}\n\nfunction renderRecent").next())
        .expect("profile renderer");
    let valid_phase = profile_renderer.find("if (isCount(value)) {").expect("phase guard");
    let meter_created = profile_renderer
        .find("document.createElement('meter')")
        .expect("native meter");
    let meter_min = profile_renderer.find("meter.min = 0").expect("finite minimum");
    let meter_max = profile_renderer
        .find("meter.max = meterMax")
        .expect("finite maximum");
    let meter_value = profile_renderer
        .find("meter.value = value")
        .expect("validated value");
    assert!(valid_phase < meter_created);
    assert!(meter_created < meter_min);
    assert!(meter_min < meter_max);
    assert!(meter_max < meter_value);

    assert_eq!(INDEX_HTML.matches("@keyframes").count(), 1);
    assert!(INDEX_HTML.contains("@keyframes elpising"));
    for forbidden in [
        "linear-gradient(",
        "radial-gradient(",
        "@import",
        "url(",
        "<svg",
        "<canvas",
        "meter.setAttribute('value'",
        "meter.setAttribute(\"value\"",
    ] {
        assert!(
            !INDEX_HTML.contains(forbidden),
            "visual asset added forbidden token: {forbidden}"
        );
    }
}

#[test]
fn dashboard_asset_uses_closed_semantic_tones_for_turn_statuses() {
    for source in [
        ".tone-ash{color:var(--ash-rose)}",
        ".tone-ember{color:var(--ember)}",
        ".tone-flare{color:var(--flare)}",
        ".tone-bone{color:var(--bone)}",
        "class=\"turn-primary tone-ash\" id=\"activity-now\"",
        "class=\"turn-primary tone-ash\" id=\"activity-latest-status\"",
        "const STATUS_TONE_CLASSES = Object.freeze({",
        "running: 'tone-flare'",
        "completed: 'tone-bone'",
        "failed: 'tone-ember'",
        "interrupted: 'tone-ember'",
        "function setTurnStatus(id, status, fallback)",
        "const toneClass = ownValue(STATUS_TONE_CLASSES, status) || 'tone-ash'",
        "element.className = 'turn-primary ' + toneClass",
        "setTurnStatus('activity-now', current ? current.status : null,",
        "current ? 'Unavailable' : 'Idle'",
        "setTurnStatus('activity-latest-status', null, 'Unavailable')",
        "setTurnStatus('activity-latest-status', latest.status, 'Unavailable')",
    ] {
        assert!(INDEX_HTML.contains(source), "missing status tone guard: {source}");
    }

    // The third verdigris use is the positive admitted-memory fact; freshness and admitted
    // source text retain the two original uses.
    assert_eq!(INDEX_HTML.matches("var(--verdigris)").count(), 3);
    for unsafe_class in [
        "element.className = 'turn-primary ' + status",
        "element.className = `turn-primary ${status}`",
        "STATUS_TONE_CLASSES[status]",
    ] {
        assert!(
            !INDEX_HTML.contains(unsafe_class),
            "server status can become a class: {unsafe_class}"
        );
    }
}

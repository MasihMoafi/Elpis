use super::TASK_COMPACT_METRIC;
use super::TaskAbortRequest;
use super::TaskCancellationBoundary;
use super::TaskCompletion;
use super::TaskCompletionOutcome;
use super::emit_compact_metric;
use super::emit_turn_network_proxy_metric;
use codex_otel::MetricsClient;
use codex_otel::MetricsConfig;
use codex_otel::SessionTelemetry;
use codex_otel::TURN_NETWORK_PROXY_METRIC;
use codex_protocol::ThreadId;
use codex_protocol::TurnProfileSummary;
use codex_protocol::protocol::ErrorEvent;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::TurnAbortedEvent;
use codex_protocol::protocol::TurnCompleteEvent;
use codex_protocol::protocol::TurnProfileEvent;
use codex_protocol::protocol::TurnProfileOutcome;
use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::data::AggregatedMetrics;
use opentelemetry_sdk::metrics::data::Metric;
use opentelemetry_sdk::metrics::data::MetricData;
use opentelemetry_sdk::metrics::data::ResourceMetrics;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::turn_timing::TurnProfile;

fn deterministic_profile() -> TurnProfile {
    TurnProfile {
        before_first_sampling_ms: 11,
        sampling_ms: 22,
        compaction_ms: 33,
        between_sampling_overhead_ms: 44,
        tool_blocking_ms: 55,
        after_last_sampling_ms: 66,
        sampling_request_count: 7,
        sampling_retry_count: 8,
    }
}

fn assert_exact_profile(profile: &TurnProfileSummary) {
    assert_eq!(profile.before_first_sampling_ms, 11);
    assert_eq!(profile.sampling_ms, 22);
    assert_eq!(profile.compaction_ms, 33);
    assert_eq!(profile.between_sampling_overhead_ms, 44);
    assert_eq!(profile.tool_blocking_ms, 55);
    assert_eq!(profile.after_last_sampling_ms, 66);
    assert_eq!(profile.sampling_request_count, 7);
    assert_eq!(profile.sampling_retry_count, 8);
}

async fn delivered_terminal_events(
    terminal_event: impl FnOnce(&str) -> EventMsg,
    profile: Option<TurnProfile>,
) -> [Event; 2] {
    let (session, turn_context, rx) =
        crate::session::tests::make_session_and_context_with_rx().await;
    let terminal_event = terminal_event(&turn_context.sub_id);
    let profile_event = super::build_turn_profile_event(
        turn_context.sub_id.clone(),
        &terminal_event,
        profile,
    );

    super::emit_terminal_event_sequence(
        session.as_ref(),
        turn_context.as_ref(),
        profile_event,
        terminal_event,
    )
    .await;

    let first = rx.recv().await.expect("transient profile event");
    let second = rx.recv().await.expect("durable terminal event");
    assert!(rx.try_recv().is_err(), "expected exactly two events");
    [first, second]
}

#[tokio::test]
async fn normal_completion_is_delivered_after_transient_profile() {
    let [profile_event, terminal_event] = delivered_terminal_events(
        |turn_id| {
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: turn_id.to_string(),
                last_agent_message: Some("unchanged".to_string()),
                error: None,
                started_at: Some(100),
                completed_at: Some(200),
                duration_ms: Some(231),
                time_to_first_token_ms: Some(12),
            })
        },
        Some(deterministic_profile()),
    )
    .await;

    let profile_event_id = profile_event.id.clone();
    let terminal_event_id = terminal_event.id.clone();
    assert_eq!(profile_event_id, terminal_event_id);
    let EventMsg::TurnProfile(TurnProfileEvent {
        turn_id,
        outcome,
        started_at,
        duration_ms,
        time_to_first_token_ms,
        profile,
    }) = profile_event.msg
    else {
        panic!("profile event should precede terminal event");
    };
    assert_eq!(turn_id, profile_event_id);
    assert_eq!(outcome, TurnProfileOutcome::Completed);
    assert_eq!(started_at, Some(100));
    assert_eq!(duration_ms, Some(231));
    assert_eq!(time_to_first_token_ms, Some(12));
    assert_exact_profile(profile.as_ref().expect("completed profile"));
    assert!(matches!(
        terminal_event.msg,
        EventMsg::TurnComplete(TurnCompleteEvent {
            turn_id,
            last_agent_message: Some(message),
            error: None,
            started_at: Some(100),
            completed_at: Some(200),
            duration_ms: Some(231),
            time_to_first_token_ms: Some(12),
        }) if turn_id == terminal_event_id && message == "unchanged"
    ));
}

#[tokio::test]
async fn failed_completion_derives_activity_outcome_from_terminal_error() {
    let [profile_event, terminal_event] = delivered_terminal_events(
        |turn_id| {
            EventMsg::TurnComplete(TurnCompleteEvent {
                turn_id: turn_id.to_string(),
                last_agent_message: None,
                error: Some(ErrorEvent {
                    message: "terminal failure".to_string(),
                    codex_error_info: None,
                }),
                started_at: Some(210),
                completed_at: Some(420),
                duration_ms: Some(210),
                time_to_first_token_ms: Some(21),
            })
        },
        Some(deterministic_profile()),
    )
    .await;

    assert!(matches!(
        profile_event.msg,
        EventMsg::TurnProfile(TurnProfileEvent {
            outcome: TurnProfileOutcome::Failed,
            started_at: Some(210),
            duration_ms: Some(210),
            time_to_first_token_ms: Some(21),
            ..
        })
    ));
    assert!(matches!(
        terminal_event.msg,
        EventMsg::TurnComplete(TurnCompleteEvent {
            error: Some(ErrorEvent { message, .. }),
            started_at: Some(210),
            completed_at: Some(420),
            duration_ms: Some(210),
            time_to_first_token_ms: Some(21),
            ..
        }) if message == "terminal failure"
    ));
}

#[tokio::test]
async fn abort_is_delivered_after_transient_profile_without_ttft() {
    let [profile_event, terminal_event] = delivered_terminal_events(
        |turn_id| {
            EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some(turn_id.to_string()),
                reason: codex_protocol::protocol::TurnAbortReason::Interrupted,
                started_at: Some(300),
                completed_at: Some(400),
                duration_ms: Some(231),
            })
        },
        Some(deterministic_profile()),
    )
    .await;

    let profile_event_id = profile_event.id.clone();
    let terminal_event_id = terminal_event.id.clone();
    assert_eq!(profile_event_id, terminal_event_id);
    let EventMsg::TurnProfile(TurnProfileEvent {
        outcome,
        time_to_first_token_ms,
        profile,
        ..
    }) = profile_event.msg
    else {
        panic!("profile event should precede terminal event");
    };
    assert_eq!(outcome, TurnProfileOutcome::Interrupted);
    assert_eq!(time_to_first_token_ms, None);
    assert_exact_profile(profile.as_ref().expect("completed profile"));
    assert!(matches!(
        terminal_event.msg,
        EventMsg::TurnAborted(TurnAbortedEvent {
            turn_id: Some(turn_id),
            reason: codex_protocol::protocol::TurnAbortReason::Interrupted,
            started_at: Some(300),
            completed_at: Some(400),
            duration_ms: Some(231),
        }) if turn_id == terminal_event_id
    ));
}

#[tokio::test]
async fn activity_is_delivered_when_profile_is_unavailable() {
    let [profile_event, terminal_event] = delivered_terminal_events(
        |turn_id| {
            EventMsg::TurnAborted(TurnAbortedEvent {
                turn_id: Some(turn_id.to_string()),
                reason: codex_protocol::protocol::TurnAbortReason::Interrupted,
                started_at: None,
                completed_at: Some(400),
                duration_ms: None,
            })
        },
        None,
    )
    .await;

    assert!(matches!(
        profile_event.msg,
        EventMsg::TurnProfile(TurnProfileEvent {
            outcome: TurnProfileOutcome::Interrupted,
            started_at: None,
            duration_ms: None,
            time_to_first_token_ms: None,
            profile: None,
            ..
        })
    ));
    assert!(matches!(terminal_event.msg, EventMsg::TurnAborted(_)));
}

fn test_session_telemetry() -> SessionTelemetry {
    let exporter = InMemoryMetricExporter::default();
    let metrics = MetricsClient::new(
        MetricsConfig::in_memory("test", "codex-core", env!("CARGO_PKG_VERSION"), exporter)
            .with_runtime_reader(),
    )
    .expect("in-memory metrics client");
    SessionTelemetry::new(
        ThreadId::new(),
        "gpt-5.4",
        "gpt-5.4",
        /*account_id*/ None,
        /*account_email*/ None,
        /*auth_mode*/ None,
        "test_originator".to_string(),
        /*log_user_prompts*/ false,
        "tty".to_string(),
        SessionSource::Cli,
    )
    .with_metrics_without_metadata_tags(metrics)
}

fn find_metric<'a>(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric {
    for scope_metrics in resource_metrics.scope_metrics() {
        for metric in scope_metrics.metrics() {
            if metric.name() == name {
                return metric;
            }
        }
    }
    panic!("metric {name} missing");
}

fn attributes_to_map<'a>(
    attributes: impl Iterator<Item = &'a KeyValue>,
) -> BTreeMap<String, String> {
    attributes
        .map(|kv| (kv.key.as_str().to_string(), kv.value.as_str().to_string()))
        .collect()
}

fn metric_point(resource_metrics: &ResourceMetrics, name: &str) -> (BTreeMap<String, String>, u64) {
    let metric = find_metric(resource_metrics, name);
    match metric.data() {
        AggregatedMetrics::U64(data) => match data {
            MetricData::Sum(sum) => {
                let points: Vec<_> = sum.data_points().collect();
                assert_eq!(points.len(), 1);
                let point = points[0];
                (attributes_to_map(point.attributes()), point.value())
            }
            _ => panic!("unexpected counter aggregation"),
        },
        _ => panic!("unexpected counter data type"),
    }
}

#[test]
fn emit_turn_network_proxy_metric_records_active_turn() {
    let session_telemetry = test_session_telemetry();

    emit_turn_network_proxy_metric(&session_telemetry, /*network_proxy_active*/ true);

    let snapshot = session_telemetry
        .snapshot_metrics()
        .expect("runtime metrics snapshot");
    let (attrs, value) = metric_point(&snapshot, TURN_NETWORK_PROXY_METRIC);

    assert_eq!(value, 1);
    assert_eq!(
        attrs,
        BTreeMap::from([("active".to_string(), "true".to_string()),])
    );
}

#[test]
fn emit_turn_network_proxy_metric_records_inactive_turn() {
    let session_telemetry = test_session_telemetry();

    emit_turn_network_proxy_metric(&session_telemetry, /*network_proxy_active*/ false);

    let snapshot = session_telemetry
        .snapshot_metrics()
        .expect("runtime metrics snapshot");
    let (attrs, value) = metric_point(&snapshot, TURN_NETWORK_PROXY_METRIC);

    assert_eq!(value, 1);
    assert_eq!(
        attrs,
        BTreeMap::from([("active".to_string(), "false".to_string()),])
    );
}

#[test]
fn emit_compact_metric_records_manual_remote_v2() {
    let session_telemetry = test_session_telemetry();

    emit_compact_metric(&session_telemetry, "remote_v2", /*manual*/ true);

    let snapshot = session_telemetry
        .snapshot_metrics()
        .expect("runtime metrics snapshot");
    let (attrs, value) = metric_point(&snapshot, TASK_COMPACT_METRIC);

    assert_eq!(value, 1);
    assert_eq!(
        attrs,
        BTreeMap::from([
            ("manual".to_string(), "true".to_string()),
            ("type".to_string(), "remote_v2".to_string()),
        ])
    );
}

#[test]
fn emit_compact_metric_records_auto_local() {
    let session_telemetry = test_session_telemetry();

    emit_compact_metric(&session_telemetry, "local", /*manual*/ false);

    let snapshot = session_telemetry
        .snapshot_metrics()
        .expect("runtime metrics snapshot");
    let (attrs, value) = metric_point(&snapshot, TASK_COMPACT_METRIC);

    assert_eq!(value, 1);
    assert_eq!(
        attrs,
        BTreeMap::from([
            ("manual".to_string(), "false".to_string()),
            ("type".to_string(), "local".to_string()),
        ])
    );
}

#[test]
fn prune_commit_rearms_cancellation_for_the_next_pass() {
    let boundary = TaskCancellationBoundary::default();

    assert!(boundary.try_commit());
    assert!(boundary.finish_commit());
    assert!(boundary.try_cancel());
}

#[test]
fn interrupt_during_prune_commit_stops_after_that_commit() {
    let boundary = TaskCancellationBoundary::default();

    assert!(boundary.try_commit());
    assert!(!boundary.try_cancel());
    assert!(!boundary.finish_commit());
}

#[tokio::test]
async fn abnormal_task_completion_is_latched_for_late_waiters() {
    let completion = Arc::new(TaskCompletion::default());
    let guard = completion.guard();

    drop(guard);

    assert_eq!(completion.request_abort(), TaskAbortRequest::Abnormal);
    assert_eq!(completion.wait().await, TaskCompletionOutcome::Abnormal);
}

#[tokio::test]
async fn requested_task_abort_is_not_misclassified_as_abnormal() {
    let completion = Arc::new(TaskCompletion::default());
    let guard = completion.guard();

    assert_eq!(
        completion.request_abort(),
        TaskAbortRequest::Requested
    );
    drop(guard);

    assert_eq!(
        completion.wait().await,
        TaskCompletionOutcome::IntentionalAbort
    );
}

#[tokio::test]
async fn clean_task_completion_wins_a_late_abort_request() {
    let completion = Arc::new(TaskCompletion::default());
    let guard = completion.guard();

    guard.finish();

    assert_eq!(completion.request_abort(), TaskAbortRequest::Finished);
    assert_eq!(completion.wait().await, TaskCompletionOutcome::Normal);
}

#[tokio::test]
async fn clean_exit_after_an_abort_request_is_intentional_abort() {
    let completion = Arc::new(TaskCompletion::default());
    let guard = completion.guard();

    assert_eq!(
        completion.request_abort(),
        TaskAbortRequest::Requested
    );
    guard.finish();

    assert_eq!(
        completion.wait().await,
        TaskCompletionOutcome::IntentionalAbort
    );
}

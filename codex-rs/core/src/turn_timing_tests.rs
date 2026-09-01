// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use codex_protocol::items::AgentMessageItem;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;
use pretty_assertions::assert_eq;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use super::TurnProfile;
use super::TurnProfilePhase;
use super::TurnProfileState;
use super::TurnTimingState;
use super::response_item_records_turn_ttft;
use crate::ResponseEvent;

#[tokio::test]
async fn turn_timing_state_records_ttft_only_once_per_turn() {
    let state = TurnTimingState::default();
    assert_eq!(
        state
            .record_ttft_for_response_event(&ResponseEvent::OutputTextDelta("hi".to_string()))
            .await,
        None
    );

    state.mark_turn_started(Instant::now()).await;
    assert_eq!(
        state
            .record_ttft_for_response_event(&ResponseEvent::Created)
            .await,
        None
    );
    assert!(
        state
            .record_ttft_for_response_event(&ResponseEvent::OutputTextDelta("hi".to_string()))
            .await
            .is_some()
    );
    assert_eq!(
        state
            .record_ttft_for_response_event(&ResponseEvent::OutputTextDelta("again".to_string()))
            .await,
        None
    );
}

#[tokio::test]
async fn turn_timing_state_records_ttfm_independently_of_ttft() {
    let state = TurnTimingState::default();
    state.mark_turn_started(Instant::now()).await;

    assert!(
        state
            .record_ttft_for_response_event(&ResponseEvent::OutputTextDelta("hi".to_string()))
            .await
            .is_some()
    );
    assert!(
        state
            .record_ttfm_for_turn_item(&TurnItem::AgentMessage(AgentMessageItem {
                id: "msg-1".to_string(),
                content: Vec::new(),
                phase: None,
            }))
            .await
            .is_some()
    );
    assert_eq!(
        state
            .record_ttfm_for_turn_item(&TurnItem::AgentMessage(AgentMessageItem {
                id: "msg-2".to_string(),
                content: Vec::new(),
                phase: None,
            }))
            .await,
        None
    );
}

#[tokio::test]
async fn turn_timing_state_records_turn_started_epoch_millis() {
    let state = TurnTimingState::default();
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_millis();

    let started_at_unix_ms = state.mark_turn_started(Instant::now()).await;

    let after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after unix epoch")
        .as_millis();
    assert!(u128::try_from(started_at_unix_ms).is_ok_and(|ms| before <= ms && ms <= after));
    assert_eq!(
        state.started_at_unix_secs().await,
        Some(started_at_unix_ms / 1000)
    );
}

#[test]
fn response_item_records_turn_ttft_for_first_output_signals() {
    assert!(response_item_records_turn_ttft(
        &ResponseItem::FunctionCall {
            id: None,
            name: "shell".to_string(),
            namespace: None,
            arguments: "{}".to_string(),
            call_id: "call-1".to_string(),
            internal_chat_message_metadata_passthrough: None,
        }
    ));
    assert!(response_item_records_turn_ttft(
        &ResponseItem::CustomToolCall {
            id: None,
            status: None,
            call_id: "call-2".to_string(),
            name: "custom".to_string(),
            namespace: None,
            input: "echo hi".to_string(),
            internal_chat_message_metadata_passthrough: None,
        }
    ));
    assert!(response_item_records_turn_ttft(&ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: "hello".to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }));
}

#[test]
fn response_item_records_turn_ttft_ignores_empty_non_output_items() {
    assert!(!response_item_records_turn_ttft(&ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: String::new(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }));
    assert!(!response_item_records_turn_ttft(
        &ResponseItem::FunctionCallOutput {
            id: None,
            call_id: "call-1".to_string(),
            output: FunctionCallOutputPayload::from_text("ok".to_string()),
            internal_chat_message_metadata_passthrough: None,
        }
    ));
}

#[test]
fn turn_profile_breaks_down_sampling_blocking_and_retry_overhead() {
    let started_at = Instant::now();
    let mut state = TurnProfileState::default();
    state.start(started_at);

    assert!(state.begin_sampling(started_at + Duration::from_millis(100)));
    state.end_phase(
        started_at + Duration::from_millis(600),
        TurnProfilePhase::Sampling,
    );
    assert!(state.begin_tool_blocking(started_at + Duration::from_millis(600)));
    state.end_phase(
        started_at + Duration::from_millis(900),
        TurnProfilePhase::ToolBlocking,
    );
    state.record_sampling_retry();
    assert!(state.begin_sampling(started_at + Duration::from_millis(1_000)));
    state.end_phase(
        started_at + Duration::from_millis(1_200),
        TurnProfilePhase::Sampling,
    );

    assert_eq!(
        state.complete(started_at + Duration::from_millis(1_300)),
        TurnProfile {
            before_first_sampling_ms: 100,
            sampling_ms: 700,
            compaction_ms: 0,
            between_sampling_overhead_ms: 100,
            tool_blocking_ms: 300,
            after_last_sampling_ms: 100,
            sampling_request_count: 2,
            sampling_retry_count: 1,
        }
    );
}

#[test]
fn turn_profile_counts_compaction_as_an_exclusive_phase() {
    let started_at = Instant::now();
    let mut state = TurnProfileState::default();
    state.start(started_at);

    assert!(state.begin_compaction(started_at + Duration::from_millis(100)));
    state.end_phase(
        started_at + Duration::from_millis(300),
        TurnProfilePhase::Compaction,
    );
    assert!(state.begin_sampling(started_at + Duration::from_millis(400)));
    state.end_phase(
        started_at + Duration::from_millis(700),
        TurnProfilePhase::Sampling,
    );
    assert!(state.begin_compaction(started_at + Duration::from_millis(800)));

    assert_eq!(
        state.complete(started_at + Duration::from_millis(1_100)),
        TurnProfile {
            before_first_sampling_ms: 200,
            sampling_ms: 300,
            compaction_ms: 500,
            between_sampling_overhead_ms: 0,
            tool_blocking_ms: 0,
            after_last_sampling_ms: 100,
            sampling_request_count: 1,
            sampling_retry_count: 0,
        }
    );
}

#[tokio::test]
async fn turn_profile_and_duration_share_a_completion_instant() {
    let state = TurnTimingState::default();
    state
        .mark_turn_started(Instant::now() - Duration::from_millis(100))
        .await;

    let (_, duration_ms, profile) = state.complete_profile_and_duration_ms().await;
    let profile = profile.expect("started turn should produce a completed profile");
    let classified_ms = profile.before_first_sampling_ms
        + profile.sampling_ms
        + profile.compaction_ms
        + profile.between_sampling_overhead_ms
        + profile.tool_blocking_ms
        + profile.after_last_sampling_ms;

    assert_eq!(
        duration_ms,
        Some(i64::try_from(classified_ms).expect("profile duration should fit i64"))
    );
}

#[tokio::test]
async fn unfinished_turn_timing_state_has_no_completed_profile() {
    let state = TurnTimingState::default();

    let (_, duration_ms, profile) = state.complete_profile_and_duration_ms().await;

    assert_eq!(duration_ms, None);
    assert_eq!(profile, None);
}

#[test]
fn turn_profile_rejects_prestart_and_overlapping_phases() {
    let started_at = Instant::now();
    let mut state = TurnProfileState::default();

    assert!(!state.begin_sampling(started_at));
    state.record_sampling_retry();
    state.start(started_at);
    assert!(state.begin_sampling(started_at + Duration::from_millis(10)));
    assert!(!state.begin_compaction(started_at + Duration::from_millis(20)));
    state.end_phase(
        started_at + Duration::from_millis(30),
        TurnProfilePhase::Compaction,
    );

    assert_eq!(
        state.complete(started_at + Duration::from_millis(50)),
        TurnProfile {
            before_first_sampling_ms: 10,
            sampling_ms: 40,
            sampling_request_count: 1,
            ..TurnProfile::default()
        }
    );
}

#[test]
fn turn_profile_is_immutable_after_completion() {
    let started_at = Instant::now();
    let mut state = TurnProfileState::default();
    state.start(started_at);
    assert!(state.begin_sampling(started_at + Duration::from_millis(10)));
    let completed = state.complete(started_at + Duration::from_millis(20));

    state.record_sampling_retry();
    assert!(!state.begin_sampling(started_at + Duration::from_millis(30)));
    state.end_phase(
        started_at + Duration::from_millis(40),
        TurnProfilePhase::Sampling,
    );

    assert_eq!(
        state.complete(started_at + Duration::from_millis(100)),
        completed
    );
}

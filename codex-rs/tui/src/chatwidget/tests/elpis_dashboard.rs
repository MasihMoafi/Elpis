//! Evals for what the dashboard reads from the ChatWidget: each turn's timing and cost state.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::activity_state::DashboardActivityStatus;
use codex_app_server_protocol::TurnActivityStatus;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use pretty_assertions::assert_eq;

fn cost_update(turn_id: &str, reason: TurnCostAvailability) -> ServerNotification {
    ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
        thread_id: "thread-1".to_string(),
        turn_id: turn_id.to_string(),
        cost: TurnCostState::Unavailable { reason },
    })
}

fn activity_update(turn_id: &str, duration_ms: i64, first_token_ms: i64) -> ServerNotification {
    ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
        thread_id: "thread-1".to_string(),
        turn_id: turn_id.to_string(),
        status: TurnActivityStatus::Completed,
        duration_ms: Some(duration_ms),
        time_to_first_token_ms: Some(first_token_ms),
    })
}

#[tokio::test]
async fn a_live_turn_records_its_timing_and_its_cost_state() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;

    handle_turn_started(&mut chat, "turn-1");
    chat.handle_server_notification(
        cost_update("turn-1", TurnCostAvailability::SubscriptionAuthentication),
        /*replay_kind*/ None,
    );
    let running = chat.dashboard_activity_state();
    assert_eq!(
        running.current.map(|row| row.status),
        Some(DashboardActivityStatus::Running)
    );

    handle_turn_completed(&mut chat, "turn-1", Some(1_234));
    chat.handle_server_notification(
        activity_update("turn-1", 1_234, 56),
        /*replay_kind*/ None,
    );

    let activity = chat.dashboard_activity_state();
    assert_eq!(activity.current, None);
    let [finished] = activity.recent.as_slice() else {
        panic!("one finished turn expected: {activity:?}");
    };
    assert_eq!(finished.status, DashboardActivityStatus::Completed);
    assert_eq!(finished.duration_ms, Some(1_234));
    assert_eq!(finished.time_to_first_token_ms, Some(56));
    assert_eq!(
        finished.cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        })
    );
}

#[tokio::test]
async fn replayed_or_foreign_updates_record_nothing() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;

    replay_turn_started(&mut chat, ReplayKind::ThreadSnapshot);
    chat.handle_server_notification(
        activity_update("turn-1", 10, 1),
        Some(ReplayKind::ThreadSnapshot),
    );
    assert_eq!(chat.dashboard_activity_state(), Default::default());

    // A live update for a turn that never started here is not invented into a row.
    chat.handle_server_notification(activity_update("turn-9", 10, 1), /*replay_kind*/ None);
    chat.handle_server_notification(
        cost_update("turn-9", TurnCostAvailability::CostObservationDisabled),
        /*replay_kind*/ None,
    );
    assert_eq!(chat.dashboard_activity_state(), Default::default());
}

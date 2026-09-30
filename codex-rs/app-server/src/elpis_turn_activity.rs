//! Elpis: per-turn timing and cost state for the dashboard's Activity tab.
//!
//! - `turn/activityUpdated` after each finished turn: status, duration and time to first token,
//!   read from 0.159's `TurnCompleteEvent` and `TurnAbortedEvent`. Ported from v0.3.0
//!   `bespoke_event_handling.rs`, which read them from its own `TurnProfile` event.
//! - `turn/costUpdated` when a turn starts. v0.3.0 `turn_cost_worker.rs` classified the cost
//!   and could later report a backend price; this build has no price path, so the cost is always
//!   unavailable and says why: a subscription login has no per-turn price, and any other login
//!   gets no price observation here.
//!
//! Both carry durations and states only, never message content.

use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::TurnActivityStatus;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use codex_protocol::ThreadId;
use codex_protocol::auth::AuthMode;

use crate::outgoing_message::ThreadScopedOutgoingMessageSender;

/// The finished turn's activity row. Sent after `turn/completed`, as v0.3.0 did.
pub(crate) fn turn_activity(
    thread_id: ThreadId,
    turn_id: &str,
    status: TurnActivityStatus,
    duration_ms: Option<i64>,
    time_to_first_token_ms: Option<i64>,
) -> ServerNotification {
    ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        status,
        duration_ms,
        time_to_first_token_ms,
    })
}

/// The cost state of a turn that starts under `auth_mode`. Sent after `turn/started`.
pub(crate) fn turn_cost(auth_mode: Option<AuthMode>) -> TurnCostState {
    let reason = if auth_mode.is_some_and(AuthMode::uses_codex_backend) {
        TurnCostAvailability::SubscriptionAuthentication
    } else {
        TurnCostAvailability::CostObservationDisabled
    };
    TurnCostState::Unavailable { reason }
}

pub(crate) async fn send_turn_cost(
    outgoing: &ThreadScopedOutgoingMessageSender,
    thread_id: ThreadId,
    turn_id: &str,
    auth_mode: Option<AuthMode>,
) {
    outgoing
        .send_server_notification(ServerNotification::TurnCostUpdated(
            TurnCostUpdatedNotification {
                thread_id: thread_id.to_string(),
                turn_id: turn_id.to_string(),
                cost: turn_cost(auth_mode),
            },
        ))
        .await;
}

#[cfg(test)]
#[path = "elpis_turn_activity_tests.rs"]
mod tests;

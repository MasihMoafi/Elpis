//! Elpis: what the ChatWidget keeps for the Context Ledger's CONTEXT WINDOW shares and the
//! dashboard's Activity tab.
//!
//! Copied from v0.3.0 `chatwidget.rs` and `chatwidget/protocol.rs`. Upstream files reach this
//! module through one-line seams marked `Elpis:`.

use codex_app_server_protocol::ThreadContextAttribution;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostUpdatedNotification;

use super::ChatWidget;
use crate::activity_state::DashboardActivityState;

impl ChatWidget {
    /// Keep the latest request's category shares. An update that carries none (a replay, or a
    /// request built before this process started) keeps the last known shares.
    pub(super) fn apply_context_attribution(
        &mut self,
        attribution: Option<ThreadContextAttribution>,
    ) {
        if let Some(attribution) = attribution {
            self.context_attribution = Some(attribution);
        }
    }

    pub(super) fn on_turn_started_activity(&mut self, turn_id: String, started_at: Option<i64>) {
        self.activity_state.start(turn_id, started_at);
    }

    pub(super) fn on_turn_activity_updated(
        &mut self,
        notification: TurnActivityUpdatedNotification,
    ) {
        self.activity_state.finish(
            &notification.turn_id,
            notification.status,
            notification.duration_ms,
            notification.time_to_first_token_ms,
        );
    }

    pub(super) fn on_turn_cost_updated(&mut self, notification: TurnCostUpdatedNotification) {
        self.activity_state
            .update_cost(&notification.turn_id, notification.cost);
    }

    /// A different thread starts with no activity rows.
    pub(super) fn reset_dashboard_for_thread_change(&mut self) {
        self.activity_state.reset();
    }

    pub(crate) fn dashboard_activity_state(&self) -> DashboardActivityState {
        self.activity_state.project()
    }
}

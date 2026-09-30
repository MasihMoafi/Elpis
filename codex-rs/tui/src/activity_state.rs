//! Elpis: the dashboard's Activity tab — the running turn and the last 20 finished ones.
//!
//! Copied from v0.3.0 `activity_state.rs`, less the turn profile breakdown, which this build's
//! app server does not report.

use std::collections::VecDeque;

use codex_app_server_protocol::TurnActivityStatus;
use codex_app_server_protocol::TurnCostState;

const ACTIVITY_RECENT_LIMIT: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DashboardActivityStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DashboardActivityRow {
    pub(crate) status: DashboardActivityStatus,
    pub(crate) started_at: Option<i64>,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) time_to_first_token_ms: Option<i64>,
    pub(crate) cost: Option<TurnCostState>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DashboardActivityState {
    pub(crate) current: Option<DashboardActivityRow>,
    pub(crate) recent: Vec<DashboardActivityRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActivityEntry {
    turn_id: String,
    row: DashboardActivityRow,
}

#[derive(Debug, Default)]
pub(crate) struct ActivityState {
    current: Option<ActivityEntry>,
    recent: VecDeque<ActivityEntry>,
}

impl ActivityState {
    pub(crate) fn start(&mut self, turn_id: String, started_at: Option<i64>) -> bool {
        let next = ActivityEntry {
            turn_id,
            row: DashboardActivityRow {
                status: DashboardActivityStatus::Running,
                started_at,
                duration_ms: None,
                time_to_first_token_ms: None,
                cost: None,
            },
        };
        if self.current.as_ref() == Some(&next) {
            return false;
        }
        self.current = Some(next);
        true
    }

    pub(crate) fn finish(
        &mut self,
        turn_id: &str,
        status: TurnActivityStatus,
        duration_ms: Option<i64>,
        time_to_first_token_ms: Option<i64>,
    ) -> bool {
        if self.current.as_ref().map(|entry| entry.turn_id.as_str()) != Some(turn_id) {
            return false;
        }
        let Some(current) = self.current.take() else {
            return false;
        };
        self.recent.push_back(ActivityEntry {
            turn_id: current.turn_id,
            row: DashboardActivityRow {
                status: match status {
                    TurnActivityStatus::Completed => DashboardActivityStatus::Completed,
                    TurnActivityStatus::Failed => DashboardActivityStatus::Failed,
                    TurnActivityStatus::Interrupted => DashboardActivityStatus::Interrupted,
                },
                started_at: None,
                duration_ms,
                time_to_first_token_ms,
                cost: current.row.cost,
            },
        });
        if self.recent.len() > ACTIVITY_RECENT_LIMIT {
            self.recent.pop_front();
        }
        true
    }

    pub(crate) fn update_cost(&mut self, turn_id: &str, cost: TurnCostState) -> bool {
        let row = self
            .current
            .iter_mut()
            .chain(self.recent.iter_mut().rev())
            .find(|entry| entry.turn_id.as_str() == turn_id)
            .map(|entry| &mut entry.row);
        let Some(row) = row else {
            return false;
        };
        if row.cost.as_ref() == Some(&cost) {
            return false;
        }
        row.cost = Some(cost);
        true
    }

    pub(crate) fn reset(&mut self) -> bool {
        let changed = self.current.is_some() || !self.recent.is_empty();
        self.current = None;
        self.recent.clear();
        changed
    }

    pub(crate) fn project(&self) -> DashboardActivityState {
        DashboardActivityState {
            current: self.current.as_ref().map(|entry| entry.row.clone()),
            recent: self.recent.iter().map(|entry| entry.row.clone()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_app_server_protocol::TurnCostAvailability;
    use pretty_assertions::assert_eq;

    fn unavailable(reason: TurnCostAvailability) -> TurnCostState {
        TurnCostState::Unavailable { reason }
    }

    #[test]
    fn activity_state_tracks_live_turns_and_their_cost_state() {
        let mut state = ActivityState::default();

        assert!(state.start("turn-a".to_string(), Some(10)));
        assert!(state.update_cost(
            "turn-a",
            unavailable(TurnCostAvailability::SubscriptionAuthentication),
        ));
        assert_eq!(
            state.project(),
            DashboardActivityState {
                current: Some(DashboardActivityRow {
                    status: DashboardActivityStatus::Running,
                    started_at: Some(10),
                    duration_ms: None,
                    time_to_first_token_ms: None,
                    cost: Some(unavailable(
                        TurnCostAvailability::SubscriptionAuthentication
                    )),
                }),
                recent: Vec::new(),
            }
        );

        assert!(state.finish(
            "turn-a",
            TurnActivityStatus::Completed,
            Some(20),
            Some(3),
        ));
        assert!(state.start("turn-b".to_string(), None));
        assert!(state.finish(
            "turn-b",
            TurnActivityStatus::Interrupted,
            None,
            None
        ));

        let projected = state.project();
        assert_eq!(projected.current, None);
        assert_eq!(projected.recent.len(), 2);
        assert_eq!(
            projected.recent[0].status,
            DashboardActivityStatus::Completed
        );
        assert_eq!(projected.recent[0].started_at, None);
        assert_eq!(projected.recent[0].duration_ms, Some(20));
        assert_eq!(projected.recent[0].time_to_first_token_ms, Some(3));
        assert_eq!(
            projected.recent[0].cost,
            Some(unavailable(
                TurnCostAvailability::SubscriptionAuthentication
            ))
        );
        assert_eq!(
            projected.recent[1].status,
            DashboardActivityStatus::Interrupted
        );
        assert_eq!(projected.recent[1].cost, None);
    }

    #[test]
    fn activity_state_is_bounded_and_unknown_cost_is_a_no_op() {
        let mut state = ActivityState::default();
        for index in 0..=ACTIVITY_RECENT_LIMIT {
            let turn_id = format!("turn-{index}");
            assert!(state.start(turn_id.clone(), None));
            assert!(state.finish(&turn_id, TurnActivityStatus::Completed, None, None));
        }

        let before = state.project();
        assert_eq!(before.recent.len(), ACTIVITY_RECENT_LIMIT);
        assert!(!state.update_cost(
            "turn-0",
            unavailable(TurnCostAvailability::CostObservationDisabled),
        ));
        assert!(!state.update_cost(
            "unknown",
            unavailable(TurnCostAvailability::CostObservationDisabled),
        ));
        assert_eq!(state.project(), before);
    }

    #[test]
    fn activity_state_preserves_missing_scalars_and_semantic_change_results() {
        let mut state = ActivityState::default();

        assert!(state.start("turn-a".to_string(), None));
        assert!(!state.start("turn-a".to_string(), None));
        assert!(state.finish("turn-a", TurnActivityStatus::Failed, None, None));
        assert!(!state.finish("turn-a", TurnActivityStatus::Failed, None, None));

        let row = &state.project().recent[0];
        assert_eq!(row.started_at, None);
        assert_eq!(row.duration_ms, None);
        assert_eq!(row.time_to_first_token_ms, None);
        assert_eq!(row.cost, None);
        assert!(state.reset());
        assert!(!state.reset());
    }
}

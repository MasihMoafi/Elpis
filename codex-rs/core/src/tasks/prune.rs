use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;
use super::TaskCancellationBoundary;
use crate::session::TurnInput;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct PruneTask {
    pub(crate) target_pct: Option<i64>,
    cancellation_boundary: TaskCancellationBoundary,
}

impl PruneTask {
    pub(crate) fn new(target_pct: Option<i64>) -> Self {
        Self {
            target_pct,
            cancellation_boundary: TaskCancellationBoundary::default(),
        }
    }
}

impl SessionTask for PruneTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Prune
    }

    fn span_name(&self) -> &'static str {
        "session_task.prune"
    }

    fn cancellation_boundary(&self) -> Option<TaskCancellationBoundary> {
        Some(self.cancellation_boundary.clone())
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        crate::session::context_prune::run_manual_context_prune_with_target(
            &session.clone_session(),
            &ctx,
            self.target_pct,
            Some(&cancellation_token),
            Some(&self.cancellation_boundary),
        )
        .await;
        Ok(None)
    }
}

use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;
use crate::session::TurnInput;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Default)]
pub(crate) struct PruneTask {
    pub(crate) target_pct: Option<i64>,
}

impl SessionTask for PruneTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Prune
    }

    fn span_name(&self) -> &'static str {
        "session_task.prune"
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
        )
        .await;
        Ok(None)
    }
}

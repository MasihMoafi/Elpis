use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;
use crate::session::TurnInput;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Default)]
pub(crate) struct PruneTask;

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
        _cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        crate::session::context_prune::run_manual_context_prune(&session.clone_session(), &ctx)
            .await;
        Ok(None)
    }
}

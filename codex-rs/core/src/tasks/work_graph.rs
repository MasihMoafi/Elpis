use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskResult;
use crate::session::step_context::StepContext;
use crate::session::TurnInput;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use crate::tools::handlers::work_graphs::PreparedWorkGraph;
use crate::tools::handlers::work_graphs::run_prepared_work_graph;
use codex_protocol::error::CodexErrorDetails;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub(crate) struct WorkGraphTask {
    step: Arc<StepContext>,
    prepared: Mutex<Option<PreparedWorkGraph>>,
}

impl WorkGraphTask {
    pub(crate) fn new(step: Arc<StepContext>, prepared: PreparedWorkGraph) -> Self {
        Self {
            step,
            prepared: Mutex::new(Some(prepared)),
        }
    }
}

impl SessionTask for WorkGraphTask {
    fn kind(&self) -> TaskKind {
        TaskKind::WorkGraph
    }

    fn span_name(&self) -> &'static str {
        "session_task.work_graph"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<Session>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        session.emit_turn_started(&ctx, TaskKind::WorkGraph).await;
        let prepared = self.prepared.lock().await.take().ok_or_else(|| {
            CodexErrorDetails::InvalidRequest("work graph already started".to_string())
        })?;
        run_prepared_work_graph(
            session,
            Arc::clone(&self.step),
            cancellation_token,
            prepared,
        )
        .await
        .map_err(|err| CodexErrorDetails::InvalidRequest(err.to_string()))?;
        Ok(None)
    }
}

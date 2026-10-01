//! Elpis: `workGraph/list`, copied from v0.3.0 `thread_processor.rs`. Work graphs live in the
//! Elpis-owned `work_graphs_1.sqlite` behind the state runtime.

use super::thread_processor::ThreadRequestProcessor;
use crate::error_code::internal_error;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::WorkGraphListParams;
use codex_app_server_protocol::WorkGraphListResponse;
use codex_app_server_protocol::WorkGraphSummary;
use codex_app_server_protocol::WorkGraphTaskSummary;

impl ThreadRequestProcessor {
    pub(crate) async fn work_graph_list(
        &self,
        params: WorkGraphListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let Some(state_db) = self.state_db.as_ref() else {
            return Ok(Some(WorkGraphListResponse { data: Vec::new() }.into()));
        };
        let graphs = state_db
            .list_work_graphs_for_root(params.root_thread_id.as_str())
            .await
            .map_err(|err| internal_error(format!("failed to list work graphs: {err}")))?;
        let mut data = Vec::with_capacity(graphs.len());
        for graph in graphs {
            let tasks = state_db
                .list_work_graph_tasks(graph.id.as_str())
                .await
                .map_err(|err| internal_error(format!("failed to list work graph tasks: {err}")))?
                .into_iter()
                .map(|task| WorkGraphTaskSummary {
                    id: task.task_id,
                    kind: task.kind.as_str().to_string(),
                    title: task.title,
                    status: task.status.as_str().to_string(),
                    dependencies: task.dependencies,
                    assigned_thread_id: task.assigned_thread_id,
                    result: task.result,
                    evidence: task.evidence,
                    failure_reason: task.failure_reason,
                })
                .collect();
            let event_count = state_db
                .list_work_graph_events(graph.id.as_str())
                .await
                .map_err(|err| internal_error(format!("failed to list work graph events: {err}")))?
                .len();
            data.push(WorkGraphSummary {
                id: graph.id,
                name: graph.name,
                status: graph.status.as_str().to_string(),
                max_concurrency: u32::try_from(graph.max_concurrency)
                    .map_err(|_| internal_error("work graph concurrency is too large"))?,
                error: graph.last_error,
                tasks,
                event_count: u32::try_from(event_count)
                    .map_err(|_| internal_error("work graph event count is too large"))?,
            });
        }
        Ok(Some(WorkGraphListResponse { data }.into()))
    }
}

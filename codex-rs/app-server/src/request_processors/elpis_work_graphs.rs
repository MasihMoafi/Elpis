//! Elpis: `workGraph/list`, copied from v0.3.0 `thread_processor.rs`. Work graphs live in the
//! Elpis-owned `work_graphs_1.sqlite` behind the state runtime.

use super::thread_processor::ThreadRequestProcessor;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use crate::outgoing_message::ConnectionRequestId;
use codex_app_server_protocol::ClientResponsePayload;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::WorkGraphListParams;
use codex_app_server_protocol::WorkGraphListResponse;
use codex_app_server_protocol::WorkGraphRunParams;
use codex_app_server_protocol::WorkGraphRunResponse;
use codex_app_server_protocol::WorkGraphSummary;
use codex_app_server_protocol::WorkGraphTaskSummary;

impl ThreadRequestProcessor {
    pub(crate) async fn work_graph_run(
        &self,
        _request_id: &ConnectionRequestId,
        params: WorkGraphRunParams,
        allow_task_routes: bool,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        if !allow_task_routes
            && params.tasks.iter().any(|task| {
                task.provider.is_some() || task.model.is_some() || task.reasoning_effort.is_some()
            })
        {
            return Err(invalid_request(
                "per-task provider/model/reasoning-effort selection requires workGraph/runWithProviders"
                    .to_string(),
            ));
        }
        let (thread_id, thread) = self.load_thread(&params.root_thread_id).await?;
        super::thread_input::ensure_direct_input_allowed(&thread).await?;
        let tasks: Vec<_> = params
            .tasks
            .into_iter()
            .map(|task| {
                serde_json::json!({
                    "id": task.id, "kind": task.kind, "title": task.title,
                    "instruction": task.instruction, "depends_on": task.depends_on,
                    "provider": task.provider, "model": task.model,
                    "reasoning_effort": task.reasoning_effort,
                    "environment_id": task.environment_id, "write_scopes": task.write_scopes,
                    "acceptance_criteria": task.acceptance_criteria,
                })
            })
            .collect();
        let arguments = serde_json::json!({
            "name": params.name, "tasks": tasks,
            "max_concurrency": params.max_concurrency,
            "max_runtime_seconds": params.max_runtime_seconds,
        })
        .to_string();
        let started = thread
            .run_work_graph(arguments)
            .await
            .map_err(|err| match err {
                codex_protocol::protocol::WorkGraphStartError::ThreadBusy => {
                    let mut error = invalid_request(
                        "thread is busy; wait for its current turn before running a workflow",
                    );
                    error.data = Some(serde_json::json!({"reason": "threadBusy"}));
                    error
                }
                codex_protocol::protocol::WorkGraphStartError::Rejected(message) => {
                    invalid_request(message)
                }
            })?;
        let response = WorkGraphRunResponse {
            graph_id: started.graph_id,
            thread_id: thread_id.to_string(),
            turn_id: started.turn_id,
        };
        Ok(Some(if allow_task_routes {
            ClientResponsePayload::WorkGraphRunWithProviders(response)
        } else {
            response.into()
        }))
    }

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
                    provider: task.provider,
                    model: task.model,
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

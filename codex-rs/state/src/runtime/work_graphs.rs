use super::*;
use crate::model::WorkGraphEventRow;
use crate::model::WorkGraphRow;
use crate::model::WorkGraphTaskRow;
use crate::validate_work_graph_tasks;
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeMap;

impl StateRuntime {
    pub async fn create_work_graph(
        &self,
        params: &WorkGraphCreateParams,
        tasks: &[WorkGraphTaskCreateParams],
    ) -> anyhow::Result<WorkGraph> {
        if params.id.trim().is_empty() {
            return Err(anyhow::anyhow!("work graph id must be non-empty"));
        }
        if params.name.trim().is_empty() {
            return Err(anyhow::anyhow!("work graph name must be non-empty"));
        }
        if params.max_concurrency == 0 {
            return Err(anyhow::anyhow!(
                "work graph max_concurrency must be at least 1"
            ));
        }
        validate_work_graph_tasks(tasks)?;

        let max_concurrency = i64::try_from(params.max_concurrency)
            .map_err(|_| anyhow::anyhow!("work graph max_concurrency is too large"))?;
        let now = Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            r#"
INSERT INTO work_graphs (
    id, root_thread_id, name, status, max_concurrency,
    created_at_ms, updated_at_ms, started_at_ms, completed_at_ms, last_error
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
            "#,
        )
        .bind(params.id.as_str())
        .bind(params.root_thread_id.as_str())
        .bind(params.name.as_str())
        .bind(WorkGraphStatus::Pending.as_str())
        .bind(max_concurrency)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        for task in tasks {
            let write_scopes_json = serde_json::to_string(&task.write_scopes)?;
            let acceptance_criteria_json = serde_json::to_string(&task.acceptance_criteria)?;
            sqlx::query(
                r#"
INSERT INTO work_graph_tasks (
    graph_id, task_id, ordinal, title, instruction, task_kind, status,
    write_scopes_json, acceptance_criteria_json, environment_id, workspace_path,
    assigned_thread_id, attempt_count, baseline_json, result_json, evidence_json,
    failure_reason, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
                "#,
            )
            .bind(params.id.as_str())
            .bind(task.task_id.as_str())
            .bind(task.ordinal)
            .bind(task.title.as_str())
            .bind(task.instruction.as_str())
            .bind(task.kind.as_str())
            .bind(WorkGraphTaskStatus::Pending.as_str())
            .bind(write_scopes_json)
            .bind(acceptance_criteria_json)
            .bind(task.environment_id.as_deref())
            .bind(task.workspace_path.as_deref())
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }

        for task in tasks {
            for dependency in &task.dependencies {
                sqlx::query(
                    r#"
INSERT INTO work_graph_dependencies (graph_id, task_id, depends_on_task_id)
VALUES (?, ?, ?)
                    "#,
                )
                .bind(params.id.as_str())
                .bind(task.task_id.as_str())
                .bind(dependency.as_str())
                .execute(&mut *tx)
                .await?;
            }
        }

        insert_work_graph_event(
            &mut tx,
            params.id.as_str(),
            None,
            "graph_created",
            Some(&serde_json::json!({
                "name": params.name,
                "task_count": tasks.len(),
                "max_concurrency": params.max_concurrency,
            })),
            now,
        )
        .await?;
        tx.commit().await?;

        self.get_work_graph(params.id.as_str())
            .await?
            .ok_or_else(|| anyhow::anyhow!("created work graph was not found"))
    }

    pub async fn get_work_graph(&self, graph_id: &str) -> anyhow::Result<Option<WorkGraph>> {
        let row = sqlx::query_as::<_, WorkGraphRow>(
            r#"
SELECT
    id, root_thread_id, name, status, max_concurrency,
    created_at_ms, updated_at_ms, started_at_ms, completed_at_ms, last_error
FROM work_graphs
WHERE id = ?
            "#,
        )
        .bind(graph_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(WorkGraph::try_from).transpose()
    }

    pub async fn list_work_graphs_for_root(
        &self,
        root_thread_id: &str,
    ) -> anyhow::Result<Vec<WorkGraph>> {
        let rows = sqlx::query_as::<_, WorkGraphRow>(
            r#"
SELECT
    id, root_thread_id, name, status, max_concurrency,
    created_at_ms, updated_at_ms, started_at_ms, completed_at_ms, last_error
FROM work_graphs
WHERE root_thread_id = ?
ORDER BY created_at_ms DESC, id ASC
            "#,
        )
        .bind(root_thread_id)
        .fetch_all(self.pool.as_ref())
        .await?;
        rows.into_iter().map(WorkGraph::try_from).collect()
    }

    pub async fn list_work_graph_tasks(
        &self,
        graph_id: &str,
    ) -> anyhow::Result<Vec<WorkGraphTask>> {
        let dependency_rows = sqlx::query(
            r#"
SELECT task_id, depends_on_task_id
FROM work_graph_dependencies
WHERE graph_id = ?
ORDER BY task_id ASC, depends_on_task_id ASC
            "#,
        )
        .bind(graph_id)
        .fetch_all(self.pool.as_ref())
        .await?;
        let mut dependencies = BTreeMap::<String, Vec<String>>::new();
        for row in dependency_rows {
            let task_id: String = row.try_get("task_id")?;
            let depends_on_task_id: String = row.try_get("depends_on_task_id")?;
            dependencies
                .entry(task_id)
                .or_default()
                .push(depends_on_task_id);
        }

        let rows = sqlx::query_as::<_, WorkGraphTaskRow>(
            r#"
SELECT
    graph_id, task_id, ordinal, title, instruction, task_kind, status,
    write_scopes_json, acceptance_criteria_json, environment_id, workspace_path,
    assigned_thread_id, attempt_count, baseline_json, result_json, evidence_json,
    failure_reason, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms
FROM work_graph_tasks
WHERE graph_id = ?
ORDER BY ordinal ASC, task_id ASC
            "#,
        )
        .bind(graph_id)
        .fetch_all(self.pool.as_ref())
        .await?;

        rows.into_iter()
            .map(|row| {
                let task_dependencies = dependencies
                    .remove(row.task_id.as_str())
                    .unwrap_or_default();
                row.into_task(task_dependencies)
            })
            .collect()
    }

    pub async fn list_work_graph_events(
        &self,
        graph_id: &str,
    ) -> anyhow::Result<Vec<crate::WorkGraphEvent>> {
        let rows = sqlx::query_as::<_, WorkGraphEventRow>(
            r#"
SELECT sequence, graph_id, task_id, event_type, payload_json, created_at_ms
FROM work_graph_events
WHERE graph_id = ?
ORDER BY sequence ASC
            "#,
        )
        .bind(graph_id)
        .fetch_all(self.pool.as_ref())
        .await?;
        rows.into_iter()
            .map(crate::WorkGraphEvent::try_from)
            .collect()
    }

    pub async fn fail_unfinished_work_graphs_for_root(
        &self,
        root_thread_id: &str,
        reason: &str,
    ) -> anyhow::Result<Vec<String>> {
        let rows = sqlx::query(
            r#"
SELECT id
FROM work_graphs
WHERE root_thread_id = ? AND status IN (?, ?)
ORDER BY created_at_ms ASC, id ASC
            "#,
        )
        .bind(root_thread_id)
        .bind(WorkGraphStatus::Pending.as_str())
        .bind(WorkGraphStatus::Running.as_str())
        .fetch_all(self.pool.as_ref())
        .await?;
        let graph_ids: Vec<String> = rows
            .into_iter()
            .map(|row| row.try_get("id"))
            .collect::<Result<_, _>>()?;

        for graph_id in &graph_ids {
            for task in self.list_work_graph_tasks(graph_id).await? {
                if !task.status.is_final() {
                    self.mark_work_graph_task_failed(graph_id, task.task_id.as_str(), reason)
                        .await?;
                }
            }
            self.finish_work_graph(graph_id, WorkGraphStatus::Failed, Some(reason))
                .await?;
        }
        Ok(graph_ids)
    }

    pub async fn mark_work_graph_running(&self, graph_id: &str) -> anyhow::Result<bool> {
        let now = Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graphs
SET status = ?, updated_at_ms = ?, started_at_ms = COALESCE(started_at_ms, ?),
    completed_at_ms = NULL, last_error = NULL
WHERE id = ? AND status = ?
            "#,
        )
        .bind(WorkGraphStatus::Running.as_str())
        .bind(now)
        .bind(now)
        .bind(graph_id)
        .bind(WorkGraphStatus::Pending.as_str())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(&mut tx, graph_id, None, "graph_started", None, now).await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn mark_work_graph_task_running_with_thread(
        &self,
        graph_id: &str,
        task_id: &str,
        thread_id: &str,
        baseline: Option<&Value>,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().timestamp_millis();
        let baseline_json = baseline.map(serde_json::to_string).transpose()?;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graph_tasks
SET status = ?, assigned_thread_id = ?, attempt_count = attempt_count + 1,
    updated_at_ms = ?, started_at_ms = COALESCE(started_at_ms, ?),
    completed_at_ms = NULL, failure_reason = NULL, baseline_json = ?
WHERE graph_id = ? AND task_id = ? AND status = ?
            "#,
        )
        .bind(WorkGraphTaskStatus::Running.as_str())
        .bind(thread_id)
        .bind(now)
        .bind(now)
        .bind(baseline_json)
        .bind(graph_id)
        .bind(task_id)
        .bind(WorkGraphTaskStatus::Pending.as_str())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(
                &mut tx,
                graph_id,
                Some(task_id),
                "task_started",
                Some(&serde_json::json!({ "thread_id": thread_id })),
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn mark_work_graph_task_blocked(
        &self,
        graph_id: &str,
        task_id: &str,
        reason: &str,
    ) -> anyhow::Result<bool> {
        self.finish_unassigned_work_graph_task(
            graph_id,
            task_id,
            WorkGraphTaskStatus::Blocked,
            "task_blocked",
            reason,
        )
        .await
    }

    pub async fn mark_work_graph_task_failed(
        &self,
        graph_id: &str,
        task_id: &str,
        reason: &str,
    ) -> anyhow::Result<bool> {
        self.finish_unassigned_work_graph_task(
            graph_id,
            task_id,
            WorkGraphTaskStatus::Failed,
            "task_failed",
            reason,
        )
        .await
    }

    pub async fn mark_work_graph_task_cancelled(
        &self,
        graph_id: &str,
        task_id: &str,
        reason: &str,
    ) -> anyhow::Result<bool> {
        self.finish_unassigned_work_graph_task(
            graph_id,
            task_id,
            WorkGraphTaskStatus::Cancelled,
            "task_cancelled",
            reason,
        )
        .await
    }

    async fn finish_unassigned_work_graph_task(
        &self,
        graph_id: &str,
        task_id: &str,
        status: WorkGraphTaskStatus,
        event_type: &str,
        reason: &str,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graph_tasks
SET status = ?, updated_at_ms = ?, completed_at_ms = ?, failure_reason = ?,
    assigned_thread_id = NULL
WHERE graph_id = ? AND task_id = ? AND status IN (?, ?)
            "#,
        )
        .bind(status.as_str())
        .bind(now)
        .bind(now)
        .bind(reason)
        .bind(graph_id)
        .bind(task_id)
        .bind(WorkGraphTaskStatus::Pending.as_str())
        .bind(WorkGraphTaskStatus::Running.as_str())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(
                &mut tx,
                graph_id,
                Some(task_id),
                event_type,
                Some(&serde_json::json!({ "reason": reason })),
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn report_work_graph_task_success(
        &self,
        graph_id: &str,
        task_id: &str,
        thread_id: &str,
        report: &WorkGraphTaskReport,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().timestamp_millis();
        let result_json = serde_json::to_string(&report.result)?;
        let evidence_json = serde_json::to_string(&report.evidence)?;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graph_tasks
SET status = ?, result_json = ?, evidence_json = ?, updated_at_ms = ?,
    completed_at_ms = ?, failure_reason = NULL
WHERE graph_id = ? AND task_id = ? AND status = ? AND assigned_thread_id = ?
            "#,
        )
        .bind(WorkGraphTaskStatus::Succeeded.as_str())
        .bind(result_json)
        .bind(evidence_json)
        .bind(now)
        .bind(now)
        .bind(graph_id)
        .bind(task_id)
        .bind(WorkGraphTaskStatus::Running.as_str())
        .bind(thread_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(
                &mut tx,
                graph_id,
                Some(task_id),
                "task_succeeded",
                Some(&serde_json::json!({
                    "thread_id": thread_id,
                    "evidence_count": report.evidence.len(),
                })),
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn report_work_graph_task_failure(
        &self,
        graph_id: &str,
        task_id: &str,
        thread_id: &str,
        reason: &str,
        report: Option<&Value>,
    ) -> anyhow::Result<bool> {
        let now = Utc::now().timestamp_millis();
        let result_json = report.map(serde_json::to_string).transpose()?;
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graph_tasks
SET status = ?, result_json = ?, updated_at_ms = ?, completed_at_ms = ?,
    failure_reason = ?
WHERE graph_id = ? AND task_id = ? AND status = ? AND assigned_thread_id = ?
            "#,
        )
        .bind(WorkGraphTaskStatus::Failed.as_str())
        .bind(result_json)
        .bind(now)
        .bind(now)
        .bind(reason)
        .bind(graph_id)
        .bind(task_id)
        .bind(WorkGraphTaskStatus::Running.as_str())
        .bind(thread_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(
                &mut tx,
                graph_id,
                Some(task_id),
                "task_failed",
                Some(&serde_json::json!({
                    "thread_id": thread_id,
                    "reason": reason,
                })),
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn finish_work_graph(
        &self,
        graph_id: &str,
        status: WorkGraphStatus,
        error: Option<&str>,
    ) -> anyhow::Result<bool> {
        if !status.is_final() {
            return Err(anyhow::anyhow!(
                "finish_work_graph requires a terminal status"
            ));
        }
        let now = Utc::now().timestamp_millis();
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            r#"
UPDATE work_graphs
SET status = ?, updated_at_ms = ?, completed_at_ms = ?, last_error = ?
WHERE id = ? AND status IN (?, ?)
            "#,
        )
        .bind(status.as_str())
        .bind(now)
        .bind(now)
        .bind(error)
        .bind(graph_id)
        .bind(WorkGraphStatus::Pending.as_str())
        .bind(WorkGraphStatus::Running.as_str())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            insert_work_graph_event(
                &mut tx,
                graph_id,
                None,
                match status {
                    WorkGraphStatus::Succeeded => "graph_succeeded",
                    WorkGraphStatus::Failed => "graph_failed",
                    WorkGraphStatus::Cancelled => "graph_cancelled",
                    WorkGraphStatus::Pending | WorkGraphStatus::Running => unreachable!(),
                },
                error
                    .map(|reason| serde_json::json!({ "reason": reason }))
                    .as_ref(),
                now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }
}

async fn insert_work_graph_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    graph_id: &str,
    task_id: Option<&str>,
    event_type: &str,
    payload: Option<&Value>,
    created_at_ms: i64,
) -> anyhow::Result<()> {
    let payload_json = payload.map(serde_json::to_string).transpose()?;
    sqlx::query(
        r#"
INSERT INTO work_graph_events (
    graph_id, task_id, event_type, payload_json, created_at_ms
) VALUES (?, ?, ?, ?, ?)
        "#,
    )
    .bind(graph_id)
    .bind(task_id)
    .bind(event_type)
    .bind(payload_json)
    .bind(created_at_ms)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    async fn runtime() -> (Arc<StateRuntime>, TempDir) {
        let home = TempDir::new().expect("tempdir should be created");
        let runtime = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
            .await
            .expect("state runtime should initialize");
        (runtime, home)
    }

    fn task(
        task_id: &str,
        ordinal: i64,
        dependencies: &[&str],
        scopes: &[&str],
    ) -> WorkGraphTaskCreateParams {
        WorkGraphTaskCreateParams {
            task_id: task_id.to_string(),
            ordinal,
            title: task_id.to_string(),
            instruction: format!("Implement {task_id}"),
            kind: WorkGraphTaskKind::Implement,
            dependencies: dependencies
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            write_scopes: scopes.iter().map(|value| (*value).to_string()).collect(),
            acceptance_criteria: vec!["test passes".to_string()],
            environment_id: None,
            workspace_path: None,
        }
    }

    async fn create_fixture(runtime: &StateRuntime) -> WorkGraph {
        runtime
            .create_work_graph(
                &WorkGraphCreateParams {
                    id: "graph-1".to_string(),
                    root_thread_id: "root-thread".to_string(),
                    name: "test graph".to_string(),
                    max_concurrency: 2,
                },
                &[
                    task("foundation", 0, &[], &["src/core"]),
                    task("ui", 1, &["foundation"], &["src/ui"]),
                    WorkGraphTaskCreateParams {
                        kind: WorkGraphTaskKind::Verify,
                        write_scopes: Vec::new(),
                        ..task("verify", 2, &["foundation", "ui"], &[])
                    },
                ],
            )
            .await
            .expect("graph should be created")
    }

    #[tokio::test]
    async fn persists_graph_tasks_dependencies_and_events() {
        let (runtime, _home) = runtime().await;
        let graph = create_fixture(&runtime).await;
        assert_eq!(graph.status, WorkGraphStatus::Pending);

        let tasks = runtime
            .list_work_graph_tasks(graph.id.as_str())
            .await
            .expect("tasks should load");
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[1].dependencies, vec!["foundation"]);
        assert_eq!(tasks[0].write_scopes, vec!["src/core"]);
        assert_eq!(
            runtime
                .list_work_graphs_for_root("root-thread")
                .await
                .expect("graphs for root")
                .into_iter()
                .map(|graph| graph.id)
                .collect::<Vec<_>>(),
            vec!["graph-1"]
        );
        assert!(
            runtime
                .list_work_graphs_for_root("another-root")
                .await
                .expect("graphs for another root")
                .is_empty()
        );

        let events = runtime
            .list_work_graph_events(graph.id.as_str())
            .await
            .expect("events should load");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "graph_created");
    }

    #[tokio::test]
    async fn only_assigned_worker_can_report_success() {
        let (runtime, _home) = runtime().await;
        let graph = create_fixture(&runtime).await;
        runtime
            .mark_work_graph_running(graph.id.as_str())
            .await
            .expect("graph should start");
        runtime
            .mark_work_graph_task_running_with_thread(
                graph.id.as_str(),
                "foundation",
                "assigned-thread",
                None,
            )
            .await
            .expect("task should start");

        let report = WorkGraphTaskReport {
            result: serde_json::json!({"summary": "complete"}),
            evidence: vec!["focused test passed".to_string()],
        };
        assert!(
            !runtime
                .report_work_graph_task_success(
                    graph.id.as_str(),
                    "foundation",
                    "wrong-thread",
                    &report,
                )
                .await
                .expect("wrong-thread report should be rejected")
        );
        assert!(
            runtime
                .report_work_graph_task_success(
                    graph.id.as_str(),
                    "foundation",
                    "assigned-thread",
                    &report,
                )
                .await
                .expect("assigned-thread report should be accepted")
        );
    }

    #[tokio::test]
    async fn next_run_fails_unfinished_graph_instead_of_requeueing_its_claim() {
        let (runtime, _home) = runtime().await;
        let graph = create_fixture(&runtime).await;
        runtime
            .mark_work_graph_running(graph.id.as_str())
            .await
            .expect("graph should start");
        runtime
            .mark_work_graph_task_running_with_thread(
                graph.id.as_str(),
                "foundation",
                "lost-thread",
                None,
            )
            .await
            .expect("task should start");

        let failed = runtime
            .fail_unfinished_work_graphs_for_root(
                "root-thread",
                "coordinator restarted while worker was active",
            )
            .await
            .expect("orphan should be failed");
        assert_eq!(failed, vec!["graph-1"]);
        let tasks = runtime
            .list_work_graph_tasks(graph.id.as_str())
            .await
            .expect("tasks should load");
        assert_eq!(tasks[0].status, WorkGraphTaskStatus::Failed);
        assert_eq!(tasks[1].status, WorkGraphTaskStatus::Failed);
        assert_eq!(tasks[0].attempt_count, 1);
        let graph = runtime
            .get_work_graph(graph.id.as_str())
            .await
            .expect("graph query")
            .expect("graph");
        assert_eq!(graph.status, WorkGraphStatus::Failed);
    }

    #[tokio::test]
    async fn cancelled_task_is_terminal_and_audited() {
        let (runtime, _home) = runtime().await;
        let graph = create_fixture(&runtime).await;
        runtime
            .mark_work_graph_task_running_with_thread(
                graph.id.as_str(),
                "foundation",
                "assigned-thread",
                None,
            )
            .await
            .expect("task should start");
        assert!(
            runtime
                .mark_work_graph_task_cancelled(
                    graph.id.as_str(),
                    "foundation",
                    "coordinator cancelled",
                )
                .await
                .expect("task should cancel")
        );
        let tasks = runtime
            .list_work_graph_tasks(graph.id.as_str())
            .await
            .expect("tasks");
        assert_eq!(tasks[0].status, WorkGraphTaskStatus::Cancelled);
        let events = runtime
            .list_work_graph_events(graph.id.as_str())
            .await
            .expect("events");
        assert_eq!(
            events.last().map(|event| event.event_type.as_str()),
            Some("task_cancelled")
        );
    }
}

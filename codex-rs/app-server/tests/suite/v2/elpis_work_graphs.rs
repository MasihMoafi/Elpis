use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use codex_app_server_protocol::WorkGraphListResponse;
use codex_protocol::ThreadId;
use codex_state::StateRuntime;
use codex_state::WorkGraphCreateParams;
use codex_state::WorkGraphTaskCreateParams;
use codex_state::WorkGraphTaskKind;
use codex_state::WorkGraphTaskReport;
use core_test_support::load_default_config_for_test;
use core_test_support::responses;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::Duration;
use tokio::time::timeout;

#[test_case::test_case("failed", true; "failed_worker_keeps_chat")]
#[test_case::test_case("failed", false; "spawn_failure_has_no_chat")]
#[test_case::test_case("blocked", false; "blocked_dependency_has_no_chat")]
#[test_case::test_case("cancelled", true; "cancelled_worker_keeps_chat")]
#[test_case::test_case("succeeded", true; "successful_worker_keeps_chat")]
#[test_case::test_case("reported_failure", true; "reported_failure_keeps_chat")]
#[tokio::test]
async fn work_graph_list_preserves_terminal_worker_chat(status: &str, started: bool) -> Result<()> {
    let home = TempDir::new()?;
    let provider = responses::start_mock_server().await;
    MockResponsesConfig::new(&provider.uri()).write(home.path())?;
    let config = load_default_config_for_test(&home).await;
    let db = StateRuntime::init(config.sqlite.clone(), config.model_provider_id.clone()).await?;
    let root_id = ThreadId::new().to_string();
    let worker_id = ThreadId::new().to_string();
    db.create_work_graph(
        &WorkGraphCreateParams {
            id: "terminal-chat".to_string(),
            root_thread_id: root_id.clone(),
            name: "Terminal chat retention".to_string(),
            max_concurrency: 1,
        },
        &[WorkGraphTaskCreateParams {
            task_id: "worker".to_string(),
            ordinal: 0,
            title: "Worker".to_string(),
            instruction: "Return evidence".to_string(),
            provider: None,
            model: None,
            kind: WorkGraphTaskKind::Explore,
            dependencies: Vec::new(),
            write_scopes: Vec::new(),
            acceptance_criteria: vec!["evidence exists".to_string()],
            environment_id: None,
            workspace_path: None,
        }],
    )
    .await?;
    if started {
        assert!(
            db.mark_work_graph_task_running_with_thread(
                "terminal-chat",
                "worker",
                &worker_id,
                None
            )
            .await?
        );
    }
    let reason = "worker stopped before reporting";
    let updated = match status {
        "failed" => {
            db.mark_work_graph_task_failed("terminal-chat", "worker", reason)
                .await?
        }
        "blocked" => {
            db.mark_work_graph_task_blocked("terminal-chat", "worker", reason)
                .await?
        }
        "cancelled" => {
            db.mark_work_graph_task_cancelled("terminal-chat", "worker", reason)
                .await?
        }
        "succeeded" => {
            db.report_work_graph_task_success(
                "terminal-chat",
                "worker",
                &worker_id,
                &WorkGraphTaskReport {
                    result: json!({"summary": "complete"}),
                    evidence: vec!["check passed".to_string()],
                },
            )
            .await?
        }
        "reported_failure" => {
            db.report_work_graph_task_failure("terminal-chat", "worker", &worker_id, reason, None)
                .await?
        }
        _ => unreachable!("test case status"),
    };
    assert!(updated);
    let expected_status = if status == "reported_failure" {
        "failed"
    } else {
        status
    };
    let expected_id = started.then_some(worker_id);

    // Start a separate app server after the transition, so the RPC must read the persisted ID.
    let mut app = TestAppServer::builder()
        .with_codex_home(home.path())
        .without_auto_env()
        .build_initialized()
        .await?;
    let id = app
        .send_request("workGraph/list", Some(json!({"rootThreadId": root_id})))
        .await?;
    let response: WorkGraphListResponse =
        timeout(Duration::from_secs(10), app.read_response(id)).await??;
    assert_eq!(response.data.len(), 1);
    assert_eq!(response.data[0].tasks.len(), 1);
    let task = &response.data[0].tasks[0];
    assert_eq!(task.status, expected_status);
    assert_eq!(task.assigned_thread_id, expected_id);
    if status != "succeeded" {
        assert_eq!(task.failure_reason.as_deref(), Some(reason));
    }
    let stored = db.list_work_graph_tasks("terminal-chat").await?;
    assert_eq!(stored[0].status.as_str(), expected_status);
    assert_eq!(stored[0].assigned_thread_id, expected_id);
    assert!(stored[0].completed_at.is_some());
    app.shutdown_gracefully().await?;
    Ok(())
}

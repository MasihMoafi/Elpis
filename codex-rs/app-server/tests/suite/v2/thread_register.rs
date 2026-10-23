use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::create_mock_responses_server_repeating_assistant;
use app_test_support::rollout_path;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SessionSource;
use codex_app_server_protocol::Thread;
use codex_app_server_protocol::ThreadForkParams;
use codex_app_server_protocol::ThreadForkResponse;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::ThreadListResponse;
use codex_app_server_protocol::ThreadReadResponse;
use codex_app_server_protocol::ThreadResumeParams;
use codex_app_server_protocol::ThreadResumeResponse;
use codex_app_server_protocol::UserInput;
use codex_state::SqliteConfig;
use codex_utils_absolute_path::test_support::PathExt;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const USER_MESSAGE: &str = "Codex CLI import: preserve my conversation";
const ASSISTANT_MESSAGE: &str = "This answer came from Codex CLI.";

// Write Codex's wire format directly: no Elpis-only session_id or SQLite fixture writes.
fn write_codex_rollout(home: &Path, thread_id: &str, paginated: bool) -> Result<PathBuf> {
    let timestamp = "2026-10-23T10:00:00Z";
    let mut meta = json!({
        "id": thread_id,
        "timestamp": timestamp,
        "cwd": home,
        "originator": "codex_cli_rs",
        "cli_version": "0.114.0",
        "source": "cli",
        "model_provider": "mock_provider"
    });
    if paginated {
        meta["history_mode"] = json!("paginated");
    }
    let mut lines = vec![
        json!({"timestamp": timestamp, "type": "session_meta", "payload": meta}),
        json!({"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "task_started", "turn_id": "imported-turn"
        }}),
        json!({"timestamp": timestamp, "type": "response_item", "payload": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": USER_MESSAGE}]
        }}),
        json!({"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "user_message", "message": USER_MESSAGE, "kind": "plain"
        }}),
        json!({"timestamp": timestamp, "type": "response_item", "payload": {
            "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": ASSISTANT_MESSAGE}]
        }}),
        json!({"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "agent_message", "message": ASSISTANT_MESSAGE, "phase": "final_answer"
        }}),
    ];
    if paginated {
        // Paginated history projects canonical items rather than legacy message events.
        for item in [
            json!({"type": "UserMessage", "id": "imported-user", "content": [
                {"type": "text", "text": USER_MESSAGE}
            ]}),
            json!({"type": "AgentMessage", "id": "imported-agent", "content": [
                {"type": "Text", "text": ASSISTANT_MESSAGE}
            ], "phase": "final_answer"}),
        ] {
            lines.push(
                json!({"timestamp": timestamp, "type": "event_msg", "payload": {
                    "type": "item_completed", "thread_id": thread_id,
                    "turn_id": "imported-turn", "item": item
                }}),
            );
        }
    }
    lines.push(
        json!({"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "task_complete", "turn_id": "imported-turn",
            "last_agent_message": ASSISTANT_MESSAGE
        }}),
    );
    if paginated {
        for (ordinal, line) in lines.iter_mut().enumerate() {
            line["ordinal"] = json!(ordinal);
        }
    }
    let contents = lines
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let path = rollout_path(home, "2026-10-23T10-00-00", thread_id);
    std::fs::create_dir_all(path.parent().expect("rollout parent"))?;
    std::fs::write(&path, format!("{contents}\n"))?;
    Ok(path)
}

fn assert_imported_history(thread: &Thread) {
    assert!(
        thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| {
                matches!(item, ThreadItem::UserMessage { content, .. }
                if content.contains(&UserInput::Text {
                    text: USER_MESSAGE.to_string(),
                    text_elements: Vec::new(),
                }))
            })
    );
    assert!(
        thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| {
                matches!(item, ThreadItem::AgentMessage { text, .. } if text == ASSISTANT_MESSAGE)
            })
    );
}

#[tokio::test]
async fn thread_register_copied_codex_rollout_lists_reads_resumes_and_forks_idempotently()
-> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    for paginated in [false, true] {
        let codex_home = TempDir::new()?;
        MockResponsesConfig::new(&server.uri()).write(codex_home.path())?;
        // Initialize first, so startup backfill cannot accidentally register our fixture.
        let mut mcp = TestAppServer::builder()
            .with_codex_home(codex_home.path())
            .build_initialized()
            .await?;
        let original_home = TempDir::new()?;
        let thread_id = Uuid::new_v4().to_string();
        let original = write_codex_rollout(original_home.path(), &thread_id, paginated)?;
        let contents = std::fs::read(&original)?;
        let copied = rollout_path(codex_home.path(), "2026-10-23T10-00-00", &thread_id);
        std::fs::create_dir_all(copied.parent().expect("rollout parent"))?;
        std::fs::copy(&original, &copied)?;
        let sqlite = SqliteConfig::new_for_testing(codex_home.path().abs());
        let pool = sqlite
            .open_read_only_pool(&sqlite.state_db_path(), None)
            .await?;
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads WHERE id = ?")
            .bind(&thread_id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(rows, 0, "the copied rollout must start without a DB row");

        for registration_path in [
            copied.clone(),
            copied.strip_prefix(codex_home.path())?.to_path_buf(),
        ] {
            let register_id = mcp
                .send_raw_request("thread/register", Some(json!({"path": registration_path})))
                .await?;
            let registered: ThreadReadResponse =
                timeout(READ_TIMEOUT, mcp.read_response(register_id)).await??;
            assert_eq!(registered.thread.id, thread_id);
            assert_eq!(registered.thread.session_id, thread_id);
            assert_eq!(registered.thread.source, SessionSource::Cli);
            let read_id = mcp
                .send_raw_request(
                    "thread/read",
                    Some(json!({"threadId": thread_id, "includeTurns": true})),
                )
                .await?;
            let read: ThreadReadResponse =
                timeout(READ_TIMEOUT, mcp.read_response(read_id)).await??;
            assert_imported_history(&read.thread);
        }
        // A second physical copy must not replace SQLite's selected rollout for this id.
        let duplicate = copied
            .parent()
            .expect("rollout parent")
            .join("duplicate")
            .join(copied.file_name().expect("rollout filename"));
        std::fs::create_dir_all(duplicate.parent().expect("duplicate parent"))?;
        std::fs::copy(&copied, &duplicate)?;
        let duplicate_id = mcp
            .send_raw_request("thread/register", Some(json!({"path": duplicate})))
            .await?;
        let error = timeout(
            READ_TIMEOUT,
            mcp.read_stream_until_error_message(RequestId::Integer(duplicate_id)),
        )
        .await??;
        assert!(
            error
                .error
                .message
                .contains("already selects a different rollout")
        );
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads WHERE id = ?")
            .bind(&thread_id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(rows, 1, "repeated registration/read must leave one row");
        let list_id = mcp
            .send_raw_request("thread/list", Some(json!({"useStateDbOnly": true})))
            .await?;
        let listed: ThreadListResponse =
            timeout(READ_TIMEOUT, mcp.read_response(list_id)).await??;
        assert_eq!(
            listed
                .data
                .iter()
                .filter(|thread| thread.id == thread_id)
                .count(),
            1
        );
        let fork_id = mcp
            .send_thread_fork_request(ThreadForkParams {
                thread_id: thread_id.clone(),
                ..Default::default()
            })
            .await?;
        let fork: ThreadForkResponse = timeout(READ_TIMEOUT, mcp.read_response(fork_id)).await??;
        assert_ne!(fork.thread.id, thread_id);
        assert_imported_history(&fork.thread);
        assert_eq!(std::fs::read(&copied)?, contents);
        assert_eq!(std::fs::read(&original)?, contents);

        let resume_id = mcp
            .send_thread_resume_request(ThreadResumeParams {
                thread_id: thread_id.clone(),
                ..Default::default()
            })
            .await?;
        let resumed: ThreadResumeResponse =
            timeout(READ_TIMEOUT, mcp.read_response(resume_id)).await??;
        assert_eq!(resumed.thread.id, thread_id);
        assert_imported_history(&resumed.thread);
        assert_eq!(std::fs::read(&original)?, contents);
        pool.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn thread_register_rejects_external_and_malformed_rollouts() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri()).write(codex_home.path())?;
    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .build_initialized()
        .await?;
    let outside_home = TempDir::new()?;
    let external_id = Uuid::new_v4().to_string();
    let outside = write_codex_rollout(outside_home.path(), &external_id, false)?;
    let malformed_id = Uuid::new_v4().to_string();
    let malformed = write_codex_rollout(codex_home.path(), &malformed_id, false)?;
    std::fs::write(&malformed, "not valid JSON\n")?;
    let partial = write_codex_rollout(codex_home.path(), &Uuid::new_v4().to_string(), false)?;
    let mut partial_contents = std::fs::read_to_string(&partial)?;
    partial_contents.push_str("{broken record}\n");
    std::fs::write(&partial, partial_contents)?;
    let mut cases = vec![
        (outside.clone(), "inside CODEX_HOME/sessions"),
        (malformed, "invalid rollout"),
        (partial, "invalid rollout: malformed records"),
    ];
    let mismatched = write_codex_rollout(codex_home.path(), &Uuid::new_v4().to_string(), false)?;
    let mismatched_path = rollout_path(
        codex_home.path(),
        "2026-10-23T10-00-00",
        &Uuid::new_v4().to_string(),
    );
    std::fs::rename(mismatched, &mismatched_path)?;
    cases.push((mismatched_path, "canonical filename with the session id"));
    #[cfg(unix)]
    {
        let link = rollout_path(codex_home.path(), "2026-10-23T10-00-00", &external_id);
        std::os::unix::fs::symlink(&outside, &link)?;
        cases.push((link, "inside CODEX_HOME/sessions"));
    }
    for (path, expected) in cases {
        let contents = std::fs::read(&path)?;
        let id = mcp
            .send_raw_request("thread/register", Some(json!({"path": path})))
            .await?;
        let error = timeout(
            READ_TIMEOUT,
            mcp.read_stream_until_error_message(RequestId::Integer(id)),
        )
        .await??;
        assert_eq!(error.error.code, -32600);
        assert!(error.error.message.contains(expected), "{error:?}");
        assert_eq!(std::fs::read(&path)?, contents);
    }
    let sqlite = SqliteConfig::new_for_testing(codex_home.path().abs());
    let pool = sqlite
        .open_read_only_pool(&sqlite.state_db_path(), None)
        .await?;
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
        .fetch_one(&pool)
        .await?;
    assert_eq!(rows, 0, "invalid registration must not create rows");
    pool.close().await;
    Ok(())
}

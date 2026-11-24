use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::create_mock_responses_server_repeating_assistant;
use codex_app_server_protocol::JSONRPCError;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SortDirection;
use codex_app_server_protocol::ThreadItemPayload;
use codex_app_server_protocol::ThreadItemsListParams;
use codex_app_server_protocol::ThreadItemsListResponse;
use codex_app_server_protocol::ThreadReadParams;
use codex_app_server_protocol::ThreadReadResponse;
use codex_app_server_protocol::ThreadResumeParams;
use codex_protocol::ThreadId;
use codex_protocol::items::TurnItem;
use codex_protocol::items::UserMessageItem;
use codex_protocol::models::BaseInstructions;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ItemCompletedEvent;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::ThreadHistoryMode;
use codex_protocol::protocol::ThreadMemoryMode;
use codex_protocol::protocol::TurnStartedEvent;
use codex_protocol::user_input::UserInput;
use codex_rollout::RolloutItem;
use codex_thread_store::CreateThreadParams;
use codex_thread_store::LiveThread;
use codex_thread_store::LocalThreadStore;
use codex_thread_store::LocalThreadStoreConfig;
use codex_thread_store::PersistContext;
use codex_thread_store::ThreadPersistenceMetadata;
use codex_utils_absolute_path::test_support::PathExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const TIMEOUT: Duration = Duration::from_secs(10);

async fn create_thread(
    store: &Arc<LocalThreadStore>,
    home: &Path,
    with_item: bool,
) -> Result<ThreadId> {
    let id = ThreadId::new();
    let live = LiveThread::create(
        store.clone(),
        CreateThreadParams {
            creator_user_id: None,
            creator_account_id: None,
            session_id: id.into(),
            thread_id: id,
            extra_config: None,
            forked_from_id: None,
            parent_thread_id: None,
            source: SessionSource::Cli,
            thread_source: None,
            originator: "test".to_string(),
            base_instructions: BaseInstructions::default(),
            dynamic_tools: Vec::new(),
            selected_capability_roots: Vec::new(),
            multi_agent_version: None,
            history_mode: ThreadHistoryMode::Paginated,
            history_base: None,
            subagent_history_start_ordinal: None,
            attached_thread: false,
            initial_window_id: codex_protocol::ContextWindowId::new_uuid_v7(),
            runtime_workspace_roots: None,
            metadata: ThreadPersistenceMetadata {
                cwd: Some(home.to_path_buf()),
                model_provider: "mock_provider".to_string(),
                memory_mode: ThreadMemoryMode::Enabled,
            },
        },
    )
    .await?;
    live.persist(PersistContext::Standard).await?;
    if with_item {
        live.append_items(&[
            RolloutItem::EventMsg(EventMsg::TurnStarted(TurnStartedEvent {
                turn_attribution: None,
                turn_id: "turn-1".to_string(),
                root_turn_id: None,
                trace_id: None,
                started_at: Some(10),
                model_context_window: None,
                collaboration_mode_kind: Default::default(),
            })),
            RolloutItem::EventMsg(EventMsg::ItemCompleted(ItemCompletedEvent {
                thread_id: id,
                turn_id: "turn-1".to_string(),
                item: TurnItem::UserMessage(UserMessageItem {
                    id: "retained-user".to_string(),
                    client_id: None,
                    content: vec![UserInput::Text {
                        text: "A retained fixture message".to_string(),
                        text_elements: Vec::new(),
                    }],
                }),
                started_at_ms: Some(0),
                completed_at_ms: 1,
                content_token_count: None,
            })),
        ])
        .await?;
    }
    live.shutdown().await?;
    Ok(id)
}

async fn read(mcp: &mut TestAppServer, id: ThreadId) -> Result<ThreadReadResponse> {
    let request = mcp
        .send_thread_read_request(ThreadReadParams {
            thread_id: id.to_string(),
            include_turns: false,
        })
        .await?;
    Ok(timeout(TIMEOUT, mcp.read_response(request)).await??)
}

async fn items_request(mcp: &mut TestAppServer, id: ThreadId) -> Result<i64> {
    Ok(mcp
        .send_thread_items_list_request(ThreadItemsListParams {
            thread_id: id.to_string(),
            turn_id: None,
            cursor: None,
            limit: Some(20),
            sort_direction: Some(SortDirection::Desc),
            defer_output: None,
        })
        .await?)
}

#[tokio::test]
async fn missing_source_is_read_only_and_only_retained_projection_is_available() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri()).write(home.path())?;
    let sqlite = codex_state::SqliteConfig::new_for_testing(home.path().abs());
    let state =
        codex_state::StateRuntime::init(sqlite.clone(), "mock_provider".to_string()).await?;
    let store = Arc::new(LocalThreadStore::new(
        LocalThreadStoreConfig {
            codex_home: home.path().to_path_buf(),
            sqlite: sqlite.clone(),
            default_model_provider_id: "mock_provider".to_string(),
        },
        Some(state.clone()),
    ));
    let recovered = create_thread(&store, home.path(), true).await?;
    let intact = create_thread(&store, home.path(), true).await?;
    let unavailable = create_thread(&store, home.path(), false).await?;
    let history = codex_state::open_thread_history_db(&sqlite).await?;
    let marker: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM thread_history_projection_state WHERE thread_id = ?",
    )
    .bind(recovered.to_string())
    .fetch_one(&history)
    .await?;
    let retained: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM thread_items WHERE thread_id = ? AND item_id = ?")
            .bind(recovered.to_string())
            .bind("retained-user")
            .fetch_one(&history)
            .await?;
    let empty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM thread_items WHERE thread_id = ?")
        .bind(unavailable.to_string())
        .fetch_one(&history)
        .await?;
    assert_eq!((marker, retained, empty), (1, 1, 0), "fixture projections");
    history.close().await;
    let selected = state
        .get_thread(recovered)
        .await?
        .expect("recovered metadata")
        .rollout_path;
    let empty_path = state
        .get_thread(unavailable)
        .await?
        .expect("empty metadata")
        .rollout_path;
    let alternate = home.path().join(format!(
        "rollout-2026-01-01T00-00-00-{}.jsonl",
        Uuid::now_v7()
    ));
    std::fs::copy(&selected, &alternate)?;
    std::fs::remove_file(&selected)?;
    std::fs::remove_file(&empty_path)?;
    drop(store);
    drop(state);

    let mut mcp = TestAppServer::builder()
        .with_codex_home(home.path())
        .without_auto_env()
        .build_initialized()
        .await?;
    let missing = read(&mut mcp, recovered).await?.thread;
    assert_eq!(missing.can_accept_direct_input, Some(false));
    assert!(
        missing
            .extra
            .expect("missing source capability")
            .missing_source_rollout
    );
    let item_id = items_request(&mut mcp, recovered).await?;
    let items: ThreadItemsListResponse = timeout(TIMEOUT, mcp.read_response(item_id)).await??;
    assert!(items.earliest_history_missing);
    assert!(items.data.iter().any(
        |entry| matches!(&entry.item.payload, ThreadItemPayload::UserMessage { id, content, .. }
            if id == "retained-user" && content.iter().any(|item| matches!(item,
                codex_app_server_protocol::UserInput::Text { text, .. } if text == "A retained fixture message")))
    ));

    let normal = read(&mut mcp, intact).await?.thread;
    assert_ne!(normal.can_accept_direct_input, Some(false));
    assert!(
        normal
            .extra
            .is_none_or(|extra| !extra.missing_source_rollout)
    );
    let item_id = items_request(&mut mcp, intact).await?;
    let items: ThreadItemsListResponse = timeout(TIMEOUT, mcp.read_response(item_id)).await??;
    assert!(!items.earliest_history_missing);
    assert!(!items.data.is_empty());

    let empty = read(&mut mcp, unavailable).await?.thread;
    assert_eq!(empty.can_accept_direct_input, Some(false));
    assert!(
        empty
            .extra
            .expect("missing source capability")
            .missing_source_rollout
    );
    let item_id = items_request(&mut mcp, unavailable).await?;
    let error: JSONRPCError = timeout(
        TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(item_id)),
    )
    .await??;
    assert!(error.error.message.contains("missing source rollout"));
    for path in [None, Some(alternate)] {
        let request = mcp
            .send_thread_resume_request(ThreadResumeParams {
                thread_id: recovered.to_string(),
                path,
                exclude_turns: true,
                ..Default::default()
            })
            .await?;
        let _: JSONRPCError = timeout(
            TIMEOUT,
            mcp.read_stream_until_error_message(RequestId::Integer(request)),
        )
        .await??;
    }
    mcp.shutdown_gracefully().await?;
    Ok(())
}

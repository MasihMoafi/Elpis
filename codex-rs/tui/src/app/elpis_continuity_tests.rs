//! Evals for the GOAL.md mirror and the ES.md turn checkpoint.

use super::*;
use crate::app::tests::make_test_app_with_channels;
use codex_app_server_protocol::CommandExecutionSource;
use codex_app_server_protocol::CommandExecutionStatus;
use codex_app_server_protocol::FileUpdateChange;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::PatchApplyStatus;
use codex_app_server_protocol::PatchChangeKind;
use codex_app_server_protocol::ThreadGoal;
use codex_app_server_protocol::ThreadGoalClearedNotification;
use codex_app_server_protocol::ThreadGoalUpdatedNotification;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnCompletedNotification;
use codex_app_server_protocol::TurnItemsView;
use codex_app_server_protocol::TurnStatus;
use pretty_assertions::assert_eq;

const RESULT_SENTINEL: &str = "ELPIS_CHECKPOINT_RESULT_5b1d7e";
const OBJECTIVE_SENTINEL: &str = "ELPIS_GOAL_OBJECTIVE_a93c20";

fn primary(app: &mut App) -> ThreadId {
    let thread_id = ThreadId::new();
    app.primary_thread_id = Some(thread_id);
    app.active_thread_id = Some(thread_id);
    thread_id
}

fn workspace(app: &App) -> std::path::PathBuf {
    let config = app.chat_widget.config_ref();
    crate::legacy_core::elpis_context::workspace_context_dir(
        Some(elpis_memory_dir(config).as_path()),
        config.cwd.as_path(),
    )
    .expect("workspace context directory")
}

fn item_completed(thread_id: ThreadId, turn_id: &str, item: ThreadItem) -> ServerNotification {
    ServerNotification::ItemCompleted(ItemCompletedNotification {
        item,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        completed_at_ms: 0,
    })
}

/// 0.159 sends `TurnCompleted` with no items; the checkpoint uses the buffered ones.
fn turn_completed(thread_id: ThreadId, turn_id: &str) -> ServerNotification {
    ServerNotification::TurnCompleted(TurnCompletedNotification {
        thread_id: thread_id.to_string(),
        turn: Turn {
            id: turn_id.to_string(),
            items: Vec::new(),
            items_view: TurnItemsView::NotLoaded,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1_000),
        },
    })
}

fn agent_message(text: &str) -> ThreadItem {
    ThreadItem::AgentMessage {
        id: "message".to_string(),
        text: text.to_string(),
        phase: None,
        memory_citation: None,
        delivery: None,
        questions: None,
    }
}

fn goal_updated(thread_id: ThreadId, objective: &str) -> ServerNotification {
    ServerNotification::ThreadGoalUpdated(ThreadGoalUpdatedNotification {
        thread_id: thread_id.to_string(),
        turn_id: None,
        goal: ThreadGoal {
            thread_id: thread_id.to_string(),
            objective: objective.to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: None,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: 1,
            updated_at: 2,
        },
    })
}

/// Positive: the primary thread's finished turn writes its result, changed file and command.
/// Negative: a child thread's completion leaves the primary workspace checkpoint alone.
#[tokio::test]
async fn a_finished_turn_checkpoints_its_result_files_and_commands() -> anyhow::Result<()> {
    let (mut app, _app_event_rx, _op_rx) = make_test_app_with_channels().await;
    let primary = primary(&mut app);
    let checkpoint = workspace(&app).join("ES.md");

    app.mirror_elpis_context_notification(&item_completed(
        ThreadId::new(),
        "child-turn",
        agent_message("child result"),
    ))
    .await;
    app.mirror_elpis_context_notification(&turn_completed(ThreadId::new(), "child-turn"))
        .await;
    assert!(!checkpoint.exists(), "a child thread wrote the workspace checkpoint");

    for item in [
        ThreadItem::FileChange {
            id: "change".to_string(),
            changes: vec![FileUpdateChange {
                path: "src/main.rs".to_string(),
                kind: PatchChangeKind::Update { move_path: None },
                diff: "the exact diff stays in the transcript".to_string(),
            }],
            status: PatchApplyStatus::Completed,
        },
        ThreadItem::CommandExecution {
            sandbox_type: None,
            model_context: None,
            id: "command".to_string(),
            plugin_id: None,
            script_path: None,
            command: "cargo test -p elpis".to_string(),
            cwd: app.chat_widget.config_ref().cwd.clone().into(),
            process_id: None,
            source: CommandExecutionSource::default(),
            status: CommandExecutionStatus::Completed,
            command_actions: Vec::new(),
            aggregated_output: None,
            exit_code: Some(0),
            duration_ms: Some(5),
        },
        agent_message(RESULT_SENTINEL),
    ] {
        app.mirror_elpis_context_notification(&item_completed(primary, "primary-turn", item))
            .await;
    }
    app.mirror_elpis_context_notification(&turn_completed(primary, "primary-turn"))
        .await;

    let content = std::fs::read_to_string(&checkpoint)?;
    assert!(content.contains(&format!("- Thread: `{primary}`")));
    assert!(content.contains("- Turn: `primary-turn`"));
    assert!(content.contains(RESULT_SENTINEL));
    assert!(content.contains("`src/main.rs` (completed)"));
    assert!(content.contains("`cargo test -p elpis` (completed, exit 0)"));
    assert!(!content.contains("the exact diff stays in the transcript"));
    assert!(!content.contains("child result"));

    let before = std::fs::read(&checkpoint)?;
    app.mirror_elpis_context_notification(&turn_completed(ThreadId::new(), "child-turn"))
        .await;
    assert_eq!(std::fs::read(&checkpoint)?, before);
    Ok(())
}

/// Positive: `/goal` on the primary thread writes GOAL.md, and clearing it removes the file.
/// Negative: another thread's goal leaves the workspace GOAL.md alone.
#[tokio::test]
async fn goal_md_mirrors_the_primary_threads_goal() -> anyhow::Result<()> {
    let (mut app, _app_event_rx, _op_rx) = make_test_app_with_channels().await;
    let primary = primary(&mut app);
    let goal = workspace(&app).join("GOAL.md");

    app.mirror_elpis_context_notification(&goal_updated(ThreadId::new(), "another objective"))
        .await;
    assert!(!goal.exists(), "another thread's goal was mirrored");

    app.mirror_elpis_context_notification(&goal_updated(primary, OBJECTIVE_SENTINEL))
        .await;
    let content = std::fs::read_to_string(&goal)?;
    assert!(content.contains(OBJECTIVE_SENTINEL));
    assert!(content.contains("- Status: active"));
    assert!(content.contains(&format!("- Thread: `{primary}`")));

    app.mirror_elpis_context_notification(&ServerNotification::ThreadGoalCleared(
        ThreadGoalClearedNotification {
            thread_id: primary.to_string(),
        },
    ))
    .await;
    assert!(!goal.exists(), "clearing /goal left GOAL.md behind");
    Ok(())
}

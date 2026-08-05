use anyhow::Context;
use anyhow::Result;
use codex_app_server_protocol::CommandExecutionStatus;
use codex_app_server_protocol::PatchApplyStatus;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnStatus;
use std::path::Path;
use std::path::PathBuf;

const GOAL_FILE: &str = "GOAL.md";
const SESSION_CHECKPOINT_FILE: &str = "ES.md";
const MAX_RESULT_CHARS: usize = 4_000;
const MAX_COMMAND_CHARS: usize = 240;

/// True for the statuses that mean the objective is over rather than paused.
fn goal_is_finished(status: &str) -> bool {
    matches!(status, "complete" | "completed" | "abandoned")
}

pub(crate) async fn write_goal(
    memories_root: Option<&Path>,
    cwd: &Path,
    thread_id: &str,
    objective: &str,
    status: &str,
    updated_at: i64,
) -> Result<Option<PathBuf>> {
    // A finished objective is history. Leaving the file behind meant the next session, and
    // any agent reading the workspace, still found a goal that was already met and worked
    // toward it.
    if goal_is_finished(status) {
        return clear_goal(memories_root, cwd, thread_id).await;
    }
    let Some(goal_path) = goal_path(memories_root, cwd) else {
        return Ok(None);
    };
    let parent = goal_path
        .parent()
        .context("Elpis goal path has no parent")?;
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("create Elpis context directory {}", parent.display()))?;

    let content = format!(
        "# Elpis Goal\n\n\
         - Workspace: `{}`\n\
         - Thread: `{thread_id}`\n\
         - Status: {status}\n\
         - Updated: {updated_at}\n\n\
         ## Objective\n\n\
         {}\n",
        cwd.display(),
        objective.trim(),
    );
    let temporary_path = goal_path.with_extension(format!("md.tmp-{thread_id}"));
    tokio::fs::write(&temporary_path, content)
        .await
        .with_context(|| {
            format!(
                "write Elpis goal temporary file {}",
                temporary_path.display()
            )
        })?;
    tokio::fs::rename(&temporary_path, &goal_path)
        .await
        .with_context(|| format!("replace Elpis goal file {}", goal_path.display()))?;
    Ok(Some(goal_path))
}

pub(crate) async fn clear_goal(
    memories_root: Option<&Path>,
    cwd: &Path,
    thread_id: &str,
) -> Result<Option<PathBuf>> {
    let _ = clear_session_checkpoint(memories_root, cwd).await;
    let Some(goal_path) = goal_path(memories_root, cwd) else {
        return Ok(None);
    };
    let content = match tokio::fs::read_to_string(&goal_path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("read Elpis goal file {}", goal_path.display()));
        }
    };
    if !content.contains(&format!("- Thread: `{thread_id}`")) {
        return Ok(None);
    }
    tokio::fs::remove_file(&goal_path)
        .await
        .with_context(|| format!("remove Elpis goal file {}", goal_path.display()))?;
    Ok(Some(goal_path))
}

pub(crate) async fn clear_session_checkpoint(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Result<Option<PathBuf>> {
    let Some(workspace_dir) = workspace_dir(memories_root, cwd) else {
        return Ok(None);
    };
    let checkpoint_path = workspace_dir.join(SESSION_CHECKPOINT_FILE);
    if checkpoint_path.exists() {
        tokio::fs::remove_file(&checkpoint_path)
            .await
            .with_context(|| {
                format!("remove Elpis checkpoint file {}", checkpoint_path.display())
            })?;
        Ok(Some(checkpoint_path))
    } else {
        Ok(None)
    }
}

/// Rebuild a completed turn from streamed `ItemCompleted` items.
///
/// `TurnCompleted` notifications arrive with `items: []`, so the checkpoint
/// uses the buffered items whose turn id matches the completed turn.
pub(crate) fn turn_with_buffered_items(turn: &Turn, buffered: Vec<(String, ThreadItem)>) -> Turn {
    let mut turn = turn.clone();
    if turn.items.is_empty() {
        turn.items = buffered
            .into_iter()
            .filter_map(|(turn_id, item)| (turn_id == turn.id).then_some(item))
            .collect();
    }
    turn
}

pub(crate) async fn write_session_checkpoint(
    memories_root: Option<&Path>,
    cwd: &Path,
    thread_id: &str,
    turn: &Turn,
) -> Result<Option<PathBuf>> {
    let Some(workspace_dir) = workspace_dir(memories_root, cwd) else {
        return Ok(None);
    };
    tokio::fs::create_dir_all(&workspace_dir)
        .await
        .with_context(|| format!("create Elpis context directory {}", workspace_dir.display()))?;

    let latest_result = turn.items.iter().rev().find_map(|item| match item {
        ThreadItem::AgentMessage { text, .. } if !text.trim().is_empty() => {
            Some(truncate_chars(text.trim(), MAX_RESULT_CHARS))
        }
        _ => None,
    });
    let mut changed_files = Vec::new();
    let mut commands = Vec::new();
    for item in &turn.items {
        match item {
            ThreadItem::FileChange {
                changes, status, ..
            } => {
                for change in changes {
                    let entry = format!("- `{}` ({})", change.path, patch_status(status));
                    if !changed_files.contains(&entry) {
                        changed_files.push(entry);
                    }
                }
            }
            ThreadItem::CommandExecution {
                command,
                status,
                exit_code,
                ..
            } => {
                let exit = exit_code.map_or_else(String::new, |code| format!(", exit {code}"));
                commands.push(format!(
                    "- `{}` ({}{exit})",
                    truncate_chars(command, MAX_COMMAND_CHARS),
                    command_status(status)
                ));
            }
            _ => {}
        }
    }

    let mut content = format!(
        "# Elpis Session Checkpoint\n\n\
         - Workspace: `{}`\n\
         - Thread: `{thread_id}`\n\
         - Turn: `{}`\n\
         - Status: {}\n\
         - Updated: {}\n\
         - Goal: [GOAL.md](GOAL.md) when present\n",
        cwd.display(),
        turn.id,
        turn_status(&turn.status),
        turn.completed_at.or(turn.started_at).unwrap_or_default(),
    );
    content.push_str("\n## Latest Result\n\n");
    content.push_str(
        latest_result
            .as_deref()
            .unwrap_or("No final agent result was recorded."),
    );
    content.push_str("\n\n## Changed Files\n\n");
    let changed_files = if changed_files.is_empty() {
        "- None recorded".to_string()
    } else {
        changed_files.join("\n")
    };
    content.push_str(&changed_files);
    content.push_str("\n\n## Commands\n\n");
    let commands = if commands.is_empty() {
        "- None recorded".to_string()
    } else {
        commands.join("\n")
    };
    content.push_str(&commands);
    content.push_str("\n\n## Exact Evidence\n\n- Full turn remains in the provider transcript.\n");

    let checkpoint_path = workspace_dir.join(SESSION_CHECKPOINT_FILE);
    let temporary_path = checkpoint_path.with_extension(format!("md.tmp-{thread_id}"));
    tokio::fs::write(&temporary_path, content)
        .await
        .with_context(|| {
            format!(
                "write Elpis checkpoint temporary file {}",
                temporary_path.display()
            )
        })?;
    tokio::fs::rename(&temporary_path, &checkpoint_path)
        .await
        .with_context(|| format!("replace Elpis checkpoint {}", checkpoint_path.display()))?;
    Ok(Some(checkpoint_path))
}

fn goal_path(memories_root: Option<&Path>, cwd: &Path) -> Option<PathBuf> {
    Some(workspace_dir(memories_root, cwd)?.join(GOAL_FILE))
}

fn workspace_dir(memories_root: Option<&Path>, cwd: &Path) -> Option<PathBuf> {
    crate::legacy_core::elpis_context::workspace_context_dir(memories_root, cwd)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

fn turn_status(status: &TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::Failed => "failed",
        TurnStatus::InProgress => "in-progress",
    }
}

fn command_status(status: &CommandExecutionStatus) -> &'static str {
    match status {
        CommandExecutionStatus::InProgress => "in-progress",
        CommandExecutionStatus::Completed => "completed",
        CommandExecutionStatus::Failed => "failed",
        CommandExecutionStatus::Declined => "declined",
    }
}

fn patch_status(status: &PatchApplyStatus) -> &'static str {
    match status {
        PatchApplyStatus::InProgress => "in-progress",
        PatchApplyStatus::Completed => "completed",
        PatchApplyStatus::Failed => "failed",
        PatchApplyStatus::Declined => "declined",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_app_server_protocol::FileUpdateChange;
    use codex_app_server_protocol::PatchChangeKind;
    use codex_app_server_protocol::TurnItemsView;
    use tempfile::tempdir;

    #[tokio::test]
    async fn goal_is_written_under_elpis_and_cleared_only_by_its_thread() -> Result<()> {
        let home = tempdir()?;
        let memories_root = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/My Project");

        let path = write_goal(
            Some(&memories_root),
            cwd,
            "thread-one",
            "Ship the context layer",
            "active",
            42,
        )
        .await?
        .context("goal path")?;

        let content = tokio::fs::read_to_string(&path).await?;
        assert!(path.starts_with(home.path().join(".elpis/context/workspaces")));
        assert!(content.contains("Ship the context layer"));
        assert!(content.contains("- Thread: `thread-one`"));
        assert_eq!(
            clear_goal(Some(&memories_root), cwd, "thread-two").await?,
            None
        );
        assert!(path.exists());
        assert_eq!(
            clear_goal(Some(&memories_root), cwd, "thread-one").await?,
            Some(path.clone())
        );
        assert!(!path.exists());
        Ok(())
    }

    /// A met objective left on disk is a standing instruction to redo work that is done.
    #[tokio::test]
    async fn completing_a_goal_removes_its_file() -> Result<()> {
        let home = tempdir()?;
        let memories_root = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/finished project");

        let path = write_goal(
            Some(&memories_root),
            cwd,
            "thread-one",
            "Ship the ledger",
            "active",
            1,
        )
        .await?
        .context("goal path")?;
        assert!(path.exists());

        write_goal(
            Some(&memories_root),
            cwd,
            "thread-one",
            "Ship the ledger",
            "complete",
            2,
        )
        .await?;
        assert!(!path.exists(), "a completed goal must not stay on disk");
        Ok(())
    }

    #[tokio::test]
    async fn session_checkpoint_keeps_result_and_file_evidence_without_raw_logs() -> Result<()> {
        let home = tempdir()?;
        let memories_root = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/project");
        let turn = Turn {
            id: "turn-one".to_string(),
            items: vec![
                ThreadItem::FileChange {
                    id: "change-one".to_string(),
                    changes: vec![FileUpdateChange {
                        path: "src/main.rs".to_string(),
                        kind: PatchChangeKind::Update { move_path: None },
                        diff: "large exact diff stays in transcript".to_string(),
                    }],
                    status: PatchApplyStatus::Completed,
                },
                ThreadItem::AgentMessage {
                    id: "message-one".to_string(),
                    text: "Implemented the checkpoint.".to_string(),
                    phase: None,
                },
            ],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(40),
            completed_at: Some(42),
            duration_ms: Some(2_000),
        };

        let path = write_session_checkpoint(Some(&memories_root), cwd, "thread-one", &turn)
            .await?
            .context("checkpoint path")?;
        let content = tokio::fs::read_to_string(path).await?;

        assert!(content.contains("Implemented the checkpoint."));
        assert!(content.contains("`src/main.rs` (completed)"));
        assert!(!content.contains("large exact diff stays in transcript"));
        assert!(content.contains("Full turn remains in the provider transcript."));
        Ok(())
    }

    #[test]
    fn empty_turn_completed_notification_uses_buffered_items_for_its_turn_only() {
        let empty_turn = Turn {
            id: "turn-two".to_string(),
            items: vec![],
            items_view: TurnItemsView::NotLoaded,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(40),
            completed_at: Some(42),
            duration_ms: Some(2_000),
        };
        let message = |id: &str, text: &str| ThreadItem::AgentMessage {
            id: id.to_string(),
            text: text.to_string(),
            phase: None,
        };
        let buffered = vec![
            ("turn-one".to_string(), message("stale", "Old turn result.")),
            ("turn-two".to_string(), message("fresh", "New turn result.")),
        ];

        let turn = turn_with_buffered_items(&empty_turn, buffered);

        assert_eq!(turn.items.len(), 1);
        assert!(matches!(
            &turn.items[0],
            ThreadItem::AgentMessage { text, .. } if text == "New turn result."
        ));
    }
}

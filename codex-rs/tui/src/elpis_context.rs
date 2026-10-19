//! Elpis: the portable continuity files under `<home>/context/workspaces/<workspace>/threads/<thread>/`.
//!
//! GOAL.md mirrors `/goal` and ES.md checkpoints every finished turn (result, changed files,
//! commands) for the Context Ledger's SESSION CONTINUITY row. `app/elpis_continuity.rs`
//! calls these writers from the app-server notifications. Copied from v0.3.0
//! `tui/src/elpis_context.rs`; only the test literals gained 0.159's `AgentMessage` fields.

use crate::legacy_core::elpis_context::continuity_belongs_to_thread as belongs_to_thread;
use crate::legacy_core::elpis_context::thread_context_dir;
use crate::legacy_core::elpis_context::thread_continuity_path;
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
const MAX_CHECKPOINT_CHARS: usize = 8_000;

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
    let Some(goal_path) = goal_path(memories_root, cwd, thread_id)? else {
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
    let Some(goal_path) = thread_continuity_path(memories_root, cwd, thread_id, GOAL_FILE)? else {
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
    if !belongs_to_thread(&content, thread_id) {
        return Ok(None);
    }
    clear_session_checkpoint(memories_root, cwd, thread_id).await?;
    clear_owned_file(memories_root, cwd, thread_id, GOAL_FILE, &goal_path).await
}

pub(crate) async fn clear_session_checkpoint(
    memories_root: Option<&Path>,
    cwd: &Path,
    thread_id: &str,
) -> Result<Option<PathBuf>> {
    let Some(workspace_dir) = thread_context_dir(memories_root, cwd, thread_id)? else {
        return Ok(None);
    };
    // Removing the checkpoint under an in-flight save makes the saver's commit
    // fail with "checkpoint changed during consolidation". The saver rewrites the
    // checkpoint itself, so skipping the removal is the safe outcome.
    let Some(_checkpoint_lock) =
        crate::legacy_core::memory_save::try_lock_checkpoint(&workspace_dir)?
    else {
        return Ok(None);
    };
    let Some(checkpoint_path) =
        thread_continuity_path(memories_root, cwd, thread_id, SESSION_CHECKPOINT_FILE)?
    else {
        return Ok(None);
    };
    let content = match tokio::fs::read_to_string(&checkpoint_path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("read Elpis checkpoint before clearing it"),
    };
    if belongs_to_thread(&content, thread_id) {
        clear_owned_file(
            memories_root,
            cwd,
            thread_id,
            SESSION_CHECKPOINT_FILE,
            &checkpoint_path,
        )
        .await
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
    let Some(workspace_dir) = thread_context_dir(memories_root, cwd, thread_id)? else {
        return Ok(None);
    };
    // The saver owns the consolidated checkpoint while it reads and updates it.
    // A late turn notification must not invalidate that snapshot or block the UI.
    let Some(_checkpoint_lock) =
        crate::legacy_core::memory_save::try_lock_checkpoint(&workspace_dir)?
    else {
        return Ok(None);
    };
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

    let checkpoint_path = workspace_dir.join(SESSION_CHECKPOINT_FILE);
    let previous_path =
        thread_continuity_path(memories_root, cwd, thread_id, SESSION_CHECKPOINT_FILE)?
            .unwrap_or_else(|| checkpoint_path.clone());
    let previous = match tokio::fs::read_to_string(&previous_path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("read previous checkpoint"),
    };
    if turn.status == TurnStatus::Interrupted
        && latest_result.is_none()
        && changed_files.is_empty()
        && commands.is_empty()
        && belongs_to_thread(&previous, thread_id)
    {
        return Ok(None);
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
    content.push_str("\n## Exact Evidence\n\n- Full turn remains in the provider transcript.\n");
    if belongs_to_thread(&previous, thread_id)
        && let Some((_, consolidated)) = previous.split_once("\n## Consolidated State\n\n")
    {
        let consolidated = consolidated
            .split_once("\n## Latest Result\n")
            .map_or(consolidated, |(state, _)| state)
            .trim();
        content.push_str("\n## Consolidated State\n\n");
        content.push_str(&truncate_chars(consolidated, 6_000));
        content.push('\n');
    }
    content.push_str("\n## Latest Result\n\n");
    let result_budget =
        MAX_RESULT_CHARS.min(MAX_CHECKPOINT_CHARS.saturating_sub(content.chars().count() + 128));
    content.push_str(&truncate_chars(
        latest_result
            .as_deref()
            .unwrap_or("No final agent result was recorded."),
        result_budget,
    ));
    append_recent_checkpoint_entries(&mut content, "Changed Files", &changed_files, 1_500);
    append_recent_checkpoint_entries(&mut content, "Commands", &commands, MAX_CHECKPOINT_CHARS);

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

fn append_recent_checkpoint_entries(
    content: &mut String,
    title: &str,
    entries: &[String],
    section_limit: usize,
) {
    let heading = format!("\n\n## {title}\n\n");
    let available = MAX_CHECKPOINT_CHARS.saturating_sub(content.chars().count());
    let budget = available.min(section_limit);
    let omitted = "- Earlier or oversized entries omitted; see full turn.\n";
    let mut used = heading.chars().count() + omitted.chars().count();
    if used > budget {
        return;
    }
    content.push_str(&heading);
    if entries.is_empty() {
        content.push_str("- None recorded");
        return;
    }
    let mut selected = Vec::new();
    for entry in entries.iter().rev() {
        let size = entry.chars().count() + 1;
        if used + size <= budget {
            used += size;
            selected.push(entry);
        }
    }
    if selected.len() < entries.len() {
        content.push_str(omitted);
    }
    for entry in selected.into_iter().rev() {
        content.push_str(entry);
        content.push('\n');
    }
}

fn goal_path(memories_root: Option<&Path>, cwd: &Path, thread_id: &str) -> Result<Option<PathBuf>> {
    Ok(thread_context_dir(memories_root, cwd, thread_id)?
        .map(|directory| directory.join(GOAL_FILE)))
}

/// Clearing a legacy-owned file leaves that file untouched. An empty thread-local file
/// prevents the read-only fallback from reviving it on the next request or resume.
async fn clear_owned_file(
    memories_root: Option<&Path>,
    cwd: &Path,
    thread_id: &str,
    file: &str,
    source: &Path,
) -> Result<Option<PathBuf>> {
    let Some(workspace) =
        crate::legacy_core::elpis_context::workspace_context_dir(memories_root, cwd)
    else {
        return Ok(None);
    };
    let legacy = workspace.join(file);
    let legacy_content = match tokio::fs::read_to_string(&legacy).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).context("read legacy continuity before clearing"),
    };
    if source == legacy && !belongs_to_thread(&legacy_content, thread_id) {
        // Discovery raced an older client's write. Legacy files are never ours to remove.
        return Ok(None);
    }
    if belongs_to_thread(&legacy_content, thread_id) {
        let Some(directory) = thread_context_dir(memories_root, cwd, thread_id)? else {
            return Ok(None);
        };
        tokio::fs::create_dir_all(&directory).await?;
        let target = directory.join(file);
        let temporary = target.with_extension(format!("md.tmp-{thread_id}"));
        tokio::fs::write(&temporary, "").await?;
        tokio::fs::rename(&temporary, &target).await?;
        Ok(Some(target))
    } else {
        tokio::fs::remove_file(source)
            .await
            .with_context(|| format!("remove Elpis continuity file {}", source.display()))?;
        Ok(Some(source.to_path_buf()))
    }
}

#[cfg(test)]
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

    const THREAD: &str = "019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10";
    const OTHER_THREAD: &str = "019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e11";

    #[tokio::test]
    async fn memory_commit_keeps_short_citations_and_separate_provenance() -> Result<()> {
        use crate::legacy_core::memory_save::{MemoryDecision, MemorySaveTiming, MemorySnapshot};
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("memories");
        let cwd = dir.path().join("project");
        let workspace = crate::legacy_core::elpis_context::workspace_context_dir(Some(&root), &cwd)
            .context("workspace")?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        let id = "01a08a44-2bba-7213-bce0-4a7e5f0423aa";
        let original = format!(
            "- Existing [8].\n- Lesson [{id}:1, {id}:10].\n- Repeat [{id}:1].\n- Keep [docs](guide.md), [unknown], and {id} outside citations."
        );
        let expected = format!(
            "- Existing [8].\n- Lesson [9, 10].\n- Repeat [9].\n- Keep [docs](guide.md), [unknown], and {id} outside citations."
        );
        // A citation is only accepted when the turn's evidence declares it, so the
        // saver cannot invent provenance. Supply the two cited items.
        let evidence = format!(
            r#"{{"evidence":[{{"id":"{id}:1","item":{{"role":"user"}}}},{{"id":"{id}:10","item":{{"role":"user"}}}}]}}"#
        );
        for _ in 0..2 {
            let baseline = MemorySnapshot::baseline_when_enabled(&root, &cwd, THREAD)?
                .context("enabled memory baseline")?;
            let snapshot = MemorySnapshot::open(&root, &cwd, THREAD)?.context("enabled saver")?;
            snapshot.commit(
                &baseline,
                &MemoryDecision {
                    checkpoint: "Work remains".into(),
                    memory: original.clone(),
                },
                "gpt-5.6-luna",
                THREAD,
                "turn",
                None,
                Some(evidence.as_str()),
                MemorySaveTiming::default(),
            )?;
            assert_eq!(std::fs::read_to_string(root.join("MEMORY.md"))?, expected);
        }
        let references = std::fs::read_to_string(root.join("memory-references/sources.md"))?;
        assert_eq!(references.matches(&format!("`{id}:1`")).count(), 1);
        assert_eq!(references.matches(&format!("`{id}:10`")).count(), 1);
        assert!(references.contains(&format!("| 9 | `{id}:1` |")));
        assert!(references.contains(&format!("| 10 | `{id}:10` |")));
        Ok(())
    }

    #[tokio::test]
    async fn clearing_a_goal_does_not_invalidate_an_in_flight_memory_save() -> Result<()> {
        use crate::legacy_core::memory_save::{MemoryDecision, MemorySaveTiming, MemorySnapshot};

        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = Path::new("/tmp/checkpoint-clear-race");
        let workspace = workspace_dir(Some(&root), cwd).context("workspace")?;
        let thread_workspace =
            thread_context_dir(Some(&root), cwd.as_ref(), THREAD)?.context("thread workspace")?;
        std::fs::create_dir_all(&thread_workspace)?;
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(
            thread_workspace.join("ES.md"),
            "- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`\nOriginal checkpoint",
        )
        .await?;
        tokio::fs::write(
            workspace.join("memory-autosave.json"),
            r#"{"enabled":true}"#,
        )
        .await?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, cwd, THREAD)?
            .context("enabled memory baseline")?;
        let snapshot = MemorySnapshot::open(&root, cwd, THREAD)?.context("enabled saver")?;
        assert!(
            clear_session_checkpoint(Some(&root), cwd, THREAD)
                .await?
                .is_none(),
            "clearing must defer to the in-flight save"
        );
        assert!(
            thread_workspace.join("ES.md").exists(),
            "the saver's snapshot source must survive a concurrent clear"
        );
        snapshot.commit(
            &baseline,
            &MemoryDecision {
                checkpoint: "- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`\nConsolidated plan."
                    .into(),
                memory: "Retain the verified lesson.".into(),
            },
            "gpt-5.6-luna",
            THREAD,
            "current-turn",
            None,
            None,
            MemorySaveTiming::default(),
        )?;
        drop(snapshot);
        assert!(
            clear_session_checkpoint(Some(&root), cwd, THREAD)
                .await?
                .is_some(),
            "clearing must work once the save released the checkpoint"
        );
        Ok(())
    }

    #[tokio::test]
    async fn tui_checkpoint_does_not_race_enabled_agent_memory_save() -> Result<()> {
        use crate::legacy_core::memory_save::{MemoryDecision, MemorySaveTiming, MemorySnapshot};

        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = Path::new("/tmp/checkpoint-race");
        let workspace = workspace_dir(Some(&root), cwd).context("workspace")?;
        let thread_workspace =
            thread_context_dir(Some(&root), cwd.as_ref(), THREAD)?.context("thread workspace")?;
        std::fs::create_dir_all(&thread_workspace)?;
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(thread_workspace.join("ES.md"), "Original checkpoint").await?;
        tokio::fs::write(
            workspace.join("memory-autosave.json"),
            r#"{"enabled":true}"#,
        )
        .await?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, cwd, THREAD)?
            .context("enabled memory baseline")?;
        let snapshot = MemorySnapshot::open(&root, cwd, THREAD)?.context("enabled saver")?;
        let turn = Turn {
            root_turn_id: None,
            id: "current-turn".into(),
            items: vec![ThreadItem::AgentMessage {
                id: "result".into(),
                text: "Response finished while the responding agent saves memory.".into(),
                phase: None,
                memory_citation: None,
                delivery: None,
                questions: None,
            }],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1_000),
        };
        let result = write_session_checkpoint(Some(&root), cwd, THREAD, &turn).await?;
        assert!(
            write_session_checkpoint(
                Some(&root),
                Path::new("/tmp/unrelated-checkpoint"),
                OTHER_THREAD,
                &turn
            )
            .await?
            .is_some(),
            "saving in one workspace must not suppress another workspace's checkpoint"
        );
        let decision = MemoryDecision {
            checkpoint: "Current consolidated plan and response evidence.".into(),
            memory: "Retain the user's verified correction.".into(),
        };
        snapshot.commit(
            &baseline,
            &decision,
            "gpt-5.6-luna",
            THREAD,
            "current-turn",
            None,
            None,
            MemorySaveTiming::default(),
        )?;
        assert!(
            result.is_none(),
            "TUI must leave the enabled memory writer in control"
        );
        drop(snapshot);
        assert!(
            write_session_checkpoint(Some(&root), cwd, THREAD, &turn)
                .await?
                .is_some()
        );
        let mirrored = tokio::fs::read_to_string(thread_workspace.join("ES.md")).await?;
        assert!(mirrored.contains(&decision.checkpoint));
        assert!(mirrored.contains("Response finished while the responding agent saves memory."));
        Ok(())
    }

    #[tokio::test]
    async fn memory_waits_for_checkpoint_writer_and_reads_its_finished_state() -> Result<()> {
        use crate::legacy_core::memory_save::{MemorySnapshot, try_lock_checkpoint};

        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = Path::new("/tmp/checkpoint-lock-order");
        let workspace = workspace_dir(Some(&root), cwd).context("workspace")?;
        let thread_workspace =
            thread_context_dir(Some(&root), cwd.as_ref(), THREAD)?.context("thread workspace")?;
        std::fs::create_dir_all(&thread_workspace)?;
        let lock = try_lock_checkpoint(&thread_workspace)?.context("writer lock")?;
        tokio::fs::write(
            workspace.join("memory-autosave.json"),
            r#"{"enabled":true}"#,
        )
        .await?;
        let writer = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tokio::fs::write(thread_workspace.join("ES.md"), "Newly finished checkpoint").await?;
            drop(lock);
            Ok::<(), anyhow::Error>(())
        };
        let (snapshot, written) = tokio::join!(
            MemorySnapshot::open_when_available(&root, cwd, THREAD),
            writer
        );
        written?;
        assert_eq!(
            snapshot?.context("enabled saver")?.checkpoint,
            "Newly finished checkpoint"
        );
        Ok(())
    }

    #[tokio::test]
    async fn manual_checkpoint_change_still_blocks_memory_commit() -> Result<()> {
        use crate::legacy_core::memory_save::{MemoryDecision, MemorySaveTiming, MemorySnapshot};

        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = Path::new("/tmp/manual-checkpoint");
        let workspace = workspace_dir(Some(&root), cwd).context("workspace")?;
        let thread_workspace =
            thread_context_dir(Some(&root), cwd.as_ref(), THREAD)?.context("thread workspace")?;
        std::fs::create_dir_all(&thread_workspace)?;
        tokio::fs::create_dir_all(&workspace).await?;
        tokio::fs::write(thread_workspace.join("ES.md"), "Original checkpoint").await?;
        tokio::fs::write(
            workspace.join("memory-autosave.json"),
            r#"{"enabled":true}"#,
        )
        .await?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, cwd, THREAD)?
            .context("enabled memory baseline")?;
        let snapshot = MemorySnapshot::open(&root, cwd, THREAD)?.context("enabled saver")?;
        tokio::fs::write(thread_workspace.join("ES.md"), "Newer manual correction").await?;
        let error = snapshot
            .commit(
                &baseline,
                &MemoryDecision {
                    checkpoint: "Stale proposed checkpoint".into(),
                    memory: "Lesson".into(),
                },
                "gpt-5.6-luna",
                THREAD,
                "turn",
                None,
                None,
                MemorySaveTiming::default(),
            )
            .expect_err("manual changes must remain protected");
        assert!(error.to_string().contains("checkpoint changed"));
        assert_eq!(
            tokio::fs::read_to_string(thread_workspace.join("ES.md")).await?,
            "Newer manual correction"
        );
        Ok(())
    }

    #[tokio::test]
    async fn goal_is_written_under_elpis_and_cleared_only_by_its_thread() -> Result<()> {
        let home = tempdir()?;
        let memories_root = home.path().join(".elpis/memories");
        let cwd = Path::new("/tmp/My Project");

        let path = write_goal(
            Some(&memories_root),
            cwd,
            THREAD,
            "Ship the context layer",
            "active",
            42,
        )
        .await?
        .context("goal path")?;

        let content = tokio::fs::read_to_string(&path).await?;
        assert!(path.starts_with(home.path().join(".elpis/context/workspaces")));
        assert!(content.contains("Ship the context layer"));
        assert!(content.contains("- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`"));
        let checkpoint = path.with_file_name(SESSION_CHECKPOINT_FILE);
        tokio::fs::write(
            &checkpoint,
            "# Elpis Session Checkpoint\n- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`\n",
        )
        .await?;
        assert_eq!(
            clear_goal(Some(&memories_root), cwd, OTHER_THREAD).await?,
            None
        );
        assert!(path.exists());
        assert!(
            checkpoint.exists(),
            "another thread must not clear the checkpoint"
        );
        assert_eq!(
            clear_goal(Some(&memories_root), cwd, THREAD).await?,
            Some(path.clone())
        );
        assert!(!path.exists());
        assert!(!checkpoint.exists());
        Ok(())
    }

    #[tokio::test]
    async fn clearing_a_goal_preserves_a_checkpoint_written_by_another_thread() -> Result<()> {
        let home = tempdir()?;
        let memories_root = home.path().join("memories");
        let cwd = Path::new("/tmp/shared-project");
        let goal = write_goal(Some(&memories_root), cwd, THREAD, "Finish", "active", 1)
            .await?
            .context("goal path")?;
        let checkpoint = goal.with_file_name(SESSION_CHECKPOINT_FILE);
        let content = "# Elpis Session Checkpoint\n- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e11`\n\n## Latest Result\nQuoted metadata:\n- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`\nOther work remains.\n";
        tokio::fs::write(&checkpoint, content).await?;
        clear_goal(Some(&memories_root), cwd, THREAD).await?;
        assert!(!goal.exists());
        assert_eq!(tokio::fs::read_to_string(&checkpoint).await?, content);
        clear_goal(Some(&memories_root), cwd, THREAD).await?;
        assert_eq!(tokio::fs::read_to_string(&checkpoint).await?, content);
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
            THREAD,
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
            THREAD,
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
            root_turn_id: None,
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
                    memory_citation: None,
                    delivery: None,
                    questions: None,
                },
            ],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(40),
            completed_at: Some(42),
            duration_ms: Some(2_000),
        };

        let path = write_session_checkpoint(Some(&memories_root), cwd, THREAD, &turn)
            .await?
            .context("checkpoint path")?;
        let content = tokio::fs::read_to_string(&path).await?;

        assert!(content.contains("Implemented the checkpoint."));
        assert!(content.contains("`src/main.rs` (completed)"));
        assert!(!content.contains("large exact diff stays in transcript"));
        assert!(content.contains("Full turn remains in the provider transcript."));
        let consolidated = "- [ ] Verify the release; passing tests are not user acceptance.";
        tokio::fs::write(
            &path,
            format!("- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10`\n\n## Consolidated State\n\n{consolidated}\n"),
        )
        .await?;
        for _ in 0..2 {
            write_session_checkpoint(Some(&memories_root), cwd, THREAD, &turn).await?;
            let updated = tokio::fs::read_to_string(&path).await?;
            assert_eq!(updated.matches(consolidated).count(), 1);
            assert_eq!(updated.matches("Implemented the checkpoint.").count(), 1);
            assert!(updated.chars().count() <= MAX_CHECKPOINT_CHARS);
        }
        Ok(())
    }

    #[tokio::test]
    async fn long_checkpoint_keeps_recent_files_and_evidence_within_admission_limit() -> Result<()>
    {
        let home = tempdir()?;
        let turn = Turn {
            root_turn_id: None,
            id: "long-turn".into(),
            items: vec![
                ThreadItem::AgentMessage {
                    id: "result".into(),
                    text: "Next: verify IDE; preserve user changes. ".repeat(150),
                    phase: None,
                    memory_citation: None,
                    delivery: None,
                    questions: None,
                },
                ThreadItem::FileChange {
                    id: "changes".into(),
                    changes: (0..100)
                        .map(|i| FileUpdateChange {
                            path: format!("src/{i}-{}.rs", "界".repeat(60)),
                            kind: PatchChangeKind::Update { move_path: None },
                            diff: String::new(),
                        })
                        .collect(),
                    status: PatchApplyStatus::Completed,
                },
            ],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1000),
        };
        let path =
            write_session_checkpoint(Some(home.path()), Path::new("/tmp/project"), THREAD, &turn)
                .await?
                .context("checkpoint path")?;
        let content = tokio::fs::read_to_string(path).await?;
        assert!(content.chars().count() <= 8_000);
        assert!(content.contains("Next: verify IDE; preserve user changes."));
        assert!(content.contains("## Exact Evidence"));
        assert!(content.contains("src/99-"));
        assert!(content.contains("omitted"));
        Ok(())
    }

    #[tokio::test]
    async fn empty_interruption_preserves_checkpoint_but_later_progress_replaces_it() -> Result<()>
    {
        let home = tempdir()?;
        let memories_root = home.path().join("memories");
        let cwd = Path::new("/tmp/project");
        let mut turn = Turn {
            root_turn_id: None,
            id: "completed-turn".into(),
            items: vec![ThreadItem::AgentMessage {
                id: "result".into(),
                text: "Tests passed; next verify the IDE.".into(),
                phase: None,
                memory_citation: None,
                delivery: None,
                questions: None,
            }],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1_000),
        };
        let path = write_session_checkpoint(Some(&memories_root), cwd, THREAD, &turn)
            .await?
            .context("checkpoint path")?;
        let previous = tokio::fs::read(&path).await?;
        turn.id = "interrupted-turn".into();
        turn.status = TurnStatus::Interrupted;
        turn.items.clear();
        write_session_checkpoint(Some(&memories_root), cwd, THREAD, &turn).await?;
        assert_eq!(tokio::fs::read(&path).await?, previous);

        turn.items.push(ThreadItem::AgentMessage {
            id: "progress".into(),
            text: "IDE verification found a startup error.".into(),
            phase: None,
            memory_citation: None,
            delivery: None,
            questions: None,
        });
        write_session_checkpoint(Some(&memories_root), cwd, THREAD, &turn).await?;
        let content = tokio::fs::read_to_string(&path).await?;
        assert!(content.contains("IDE verification found a startup error."));
        assert!(content.contains("- Status: interrupted"));

        turn.items.clear();
        let other_path = write_session_checkpoint(Some(&memories_root), cwd, OTHER_THREAD, &turn)
            .await?
            .context("first interruption still records its status")?;
        assert_eq!(tokio::fs::read_to_string(&path).await?, content);
        assert_ne!(
            path, other_path,
            "same-workspace threads own separate checkpoints"
        );
        let other_content = tokio::fs::read_to_string(&other_path).await?;
        assert!(other_content.contains("- Thread: `019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e11`"));
        assert!(!other_content.contains("IDE verification found"));
        write_session_checkpoint(Some(&memories_root), cwd, OTHER_THREAD, &turn).await?;
        assert_eq!(tokio::fs::read_to_string(&other_path).await?, other_content);
        Ok(())
    }

    #[test]
    fn empty_turn_completed_notification_uses_buffered_items_for_its_turn_only() {
        let empty_turn = Turn {
            root_turn_id: None,
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
            memory_citation: None,
            delivery: None,
            questions: None,
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

    #[tokio::test]
    async fn same_workspace_goals_and_legacy_clear_remain_thread_owned() -> Result<()> {
        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = home.path().join("project");
        let first = codex_protocol::ThreadId::new().to_string();
        let second = codex_protocol::ThreadId::new().to_string();
        let workspace = workspace_dir(Some(&root), &cwd).context("workspace")?;
        tokio::fs::create_dir_all(&workspace).await?;
        let legacy_goal = format!("- Thread: `{first}`\nLegacy goal");
        let legacy_checkpoint = format!("- Thread: `{first}`\nLegacy checkpoint");
        tokio::fs::write(workspace.join(GOAL_FILE), &legacy_goal).await?;
        tokio::fs::write(workspace.join(SESSION_CHECKPOINT_FILE), &legacy_checkpoint).await?;
        let second_goal = write_goal(Some(&root), &cwd, &second, "Second goal", "active", 1)
            .await?
            .context("second goal")?;
        assert!(clear_goal(Some(&root), &cwd, &first).await?.is_some());
        for _ in 0..2 {
            for name in [GOAL_FILE, SESSION_CHECKPOINT_FILE] {
                let path = thread_continuity_path(Some(&root), &cwd, &first, name)?
                    .context("suppression marker")?;
                assert!(tokio::fs::read_to_string(path).await?.is_empty());
            }
            assert!(clear_goal(Some(&root), &cwd, &first).await?.is_none());
        }
        assert_eq!(
            tokio::fs::read_to_string(workspace.join(GOAL_FILE)).await?,
            legacy_goal
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.join(SESSION_CHECKPOINT_FILE)).await?,
            legacy_checkpoint
        );
        assert!(
            tokio::fs::read_to_string(&second_goal)
                .await?
                .contains("Second goal")
        );
        let first_goal = write_goal(Some(&root), &cwd, &first, "First goal", "active", 2)
            .await?
            .context("first goal")?;
        assert_ne!(first_goal, second_goal);
        clear_goal(Some(&root), &cwd, &second).await?;
        assert!(
            tokio::fs::read_to_string(first_goal)
                .await?
                .contains("First goal")
        );
        Ok(())
    }

    #[tokio::test]
    async fn invalid_thread_ids_cannot_write_or_clear_continuity() -> Result<()> {
        let home = tempdir()?;
        let root = home.path().join("memories");
        for thread in [
            "",
            "../escape",
            "/absolute",
            "thread/../../escape",
            "not-a-thread",
        ] {
            assert!(
                write_goal(Some(&root), home.path(), thread, "goal", "active", 0)
                    .await
                    .is_err()
            );
            assert!(clear_goal(Some(&root), home.path(), thread).await.is_err());
            assert!(
                clear_session_checkpoint(Some(&root), home.path(), thread)
                    .await
                    .is_err()
            );
        }
        assert!(!root.exists());
        assert!(!home.path().join("context").exists());
        Ok(())
    }
    #[tokio::test]
    async fn legacy_owner_change_during_clear_never_deletes_the_other_threads_file() -> Result<()> {
        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = home.path();
        let workspace = workspace_dir(Some(&root), cwd).context("workspace")?;
        tokio::fs::create_dir_all(&workspace).await?;
        let path = workspace.join(GOAL_FILE);
        tokio::fs::write(&path, format!("- Thread: `{THREAD}`\nOriginal")).await?;
        let discovered = thread_continuity_path(Some(&root), cwd, THREAD, GOAL_FILE)?
            .context("own legacy goal")?;
        let newer = format!("- Thread: `{OTHER_THREAD}`\nNewer owner's goal");
        tokio::fs::write(&path, &newer).await?;
        assert!(
            clear_owned_file(Some(&root), cwd, THREAD, GOAL_FILE, &discovered)
                .await?
                .is_none()
        );
        assert_eq!(tokio::fs::read_to_string(path).await?, newer);
        Ok(())
    }
    #[tokio::test]
    async fn concurrent_same_workspace_goals_keep_both_objectives() -> Result<()> {
        let home = tempdir()?;
        let root = home.path().join("memories");
        let cwd = home.path();
        let (first, second) = tokio::join!(
            write_goal(Some(&root), cwd, THREAD, "First objective", "active", 1),
            write_goal(
                Some(&root),
                cwd,
                OTHER_THREAD,
                "Second objective",
                "active",
                1
            ),
        );
        let first = first?.context("first goal")?;
        let second = second?.context("second goal")?;
        assert_ne!(first, second);
        assert!(
            tokio::fs::read_to_string(&first)
                .await?
                .contains("First objective")
        );
        assert!(
            tokio::fs::read_to_string(&second)
                .await?
                .contains("Second objective")
        );
        clear_goal(Some(&root), cwd, THREAD).await?;
        assert!(
            tokio::fs::read_to_string(second)
                .await?
                .contains("Second objective")
        );
        Ok(())
    }
}

// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use anyhow::Context;
use codex_git_utils::GitBaselineDiff;
use codex_git_utils::diff_since_latest_init;
use codex_git_utils::ensure_git_baseline_repository;
use codex_git_utils::reset_git_repository;
use std::path::Path;

pub(crate) const MAX_DURABLE_MEMORY_CHARS: usize = 30_000;
pub(crate) const MAX_MEMORY_SUMMARY_CHARS: usize = 10_000;

/// Prepares the memory directory for git-baseline diffing.
///
/// This keeps an existing usable `.git/` baseline intact. It initializes a new git baseline when the
/// metadata is missing or unusable, and removes any stale generated `phase2_workspace_diff.md` file
/// so that the next diff does not include a previous prompt artifact.
pub async fn prepare_memory_workspace(root: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(root)
        .await
        .with_context(|| format!("create memory workspace {}", root.display()))?;
    remove_workspace_diff(root).await?;
    ensure_git_baseline_repository(root).await?;
    Ok(())
}

/// Returns the current workspace diff after removing any stale generated diff artifact.
///
/// The removed file is only `phase2_workspace_diff.md`; memory artifacts and `.git/` metadata are
/// left intact.
pub async fn memory_workspace_diff(root: &Path) -> anyhow::Result<GitBaselineDiff> {
    remove_workspace_diff(root).await?;
    diff_since_latest_init(root).await
}

/// Writes `phase2_workspace_diff.md` with a bounded git-style diff from the current baseline.
pub async fn write_workspace_diff(root: &Path, diff: &GitBaselineDiff) -> anyhow::Result<()> {
    let path = root.join(crate::workspace_diff::FILENAME);
    tokio::fs::write(&path, render_workspace_diff_file(diff))
        .await
        .with_context(|| format!("write memory workspace diff file {}", path.display()))
}

/// Marks the current memory root as the new baseline.
///
/// The generated diff file is removed before resetting the baseline. Deleted memory lines are first
/// appended to `archive.md` so explicit deletion or age-based fading does not destroy searchable
/// evidence. Archive failures stop the reset instead of silently losing memory.
pub async fn reset_memory_workspace_baseline(root: &Path) -> anyhow::Result<()> {
    remove_workspace_diff(root).await?;

    if let Ok(diff) = diff_since_latest_init(root).await {
        archive_deleted_memory_lines(root, &diff).await?;
    }

    reset_git_repository(root).await
}

async fn archive_deleted_memory_lines(root: &Path, diff: &GitBaselineDiff) -> anyhow::Result<()> {
    let deleted_lines = diff
        .unified_diff
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .map(|line| line[1..].to_string())
        .collect::<Vec<_>>();
    if deleted_lines.is_empty() {
        return Ok(());
    }

    let archive_path = root.join("archive.md");
    let mut archive_content = match tokio::fs::read_to_string(&archive_path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            "# Elpis Memory Archive\n\n".to_string()
        }
        Err(err) => {
            return Err(err)
                .with_context(|| format!("read memory archive {}", archive_path.display()));
        }
    };
    if !archive_content.ends_with('\n') {
        archive_content.push('\n');
    }
    archive_content.push_str(&format!("\n## Archived at {}\n\n", chrono::Utc::now()));
    for line in deleted_lines {
        archive_content.push_str(&line);
        archive_content.push('\n');
    }

    tokio::fs::write(&archive_path, archive_content)
        .await
        .with_context(|| format!("write memory archive {}", archive_path.display()))
}

/// Verifies that a completed consolidation run left the required memory artifacts in place.
pub async fn validate_consolidation_artifacts(root: &Path) -> anyhow::Result<()> {
    let memory_path = root.join("MEMORY.md");
    let memory = tokio::fs::read_to_string(&memory_path)
        .await
        .with_context(|| {
            format!(
                "read consolidated memory artifact {}",
                memory_path.display()
            )
        })?;
    anyhow::ensure!(
        memory.chars().count() <= MAX_DURABLE_MEMORY_CHARS,
        "consolidated memory artifact exceeds {MAX_DURABLE_MEMORY_CHARS} characters: {}",
        memory_path.display(),
    );

    let summary_path = root.join("memory_summary.md");
    let summary = tokio::fs::read_to_string(&summary_path)
        .await
        .with_context(|| format!("read memory summary artifact {}", summary_path.display()))?;
    anyhow::ensure!(
        summary.lines().next() == Some("v1"),
        "memory summary artifact does not start with v1: {}",
        summary_path.display()
    );
    anyhow::ensure!(
        summary.chars().count() <= MAX_MEMORY_SUMMARY_CHARS,
        "memory summary artifact exceeds {MAX_MEMORY_SUMMARY_CHARS} characters: {}",
        summary_path.display(),
    );

    Ok(())
}

/// Removes the generated `phase2_workspace_diff.md` prompt artifact.
///
/// This does not remove `.git/`, reset the baseline, or delete memory content. It is used before
/// diffing and before baseline reset so the generated diff file itself is not treated as memory
/// workspace input.
pub(super) async fn remove_workspace_diff(root: &Path) -> anyhow::Result<()> {
    let path = root.join(crate::workspace_diff::FILENAME);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err)
            .with_context(|| format!("remove memory workspace diff file {}", path.display())),
    }
}

fn render_workspace_diff_file(diff: &GitBaselineDiff) -> String {
    let mut rendered = String::from(
        "# Memory Workspace Diff\n\n\
         Generated by Codex before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n\
         ## Status\n",
    );
    if !diff.has_changes() {
        rendered.push_str("- none\n");
        return rendered;
    }

    for change in &diff.changes {
        rendered.push_str(&format!("- {} {}\n", change.status.label(), change.path));
    }
    rendered.push_str("\n## Diff\n\n```diff\n");
    append_bounded_diff(&mut rendered, &diff.unified_diff);
    rendered.push_str("```\n");
    rendered
}

fn append_bounded_diff(rendered: &mut String, diff: &str) {
    if diff.len() <= crate::workspace_diff::MAX_BYTES {
        rendered.push_str(diff);
        if !diff.ends_with('\n') {
            rendered.push('\n');
        }
        return;
    }

    let boundary = previous_char_boundary(diff, crate::workspace_diff::MAX_BYTES);
    rendered.push_str(&diff[..boundary]);
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    rendered.push_str(&format!(
        "\n[workspace diff truncated at {} bytes]\n",
        crate::workspace_diff::MAX_BYTES
    ));
}

fn previous_char_boundary(value: &str, max_bytes: usize) -> usize {
    if max_bytes >= value.len() {
        return value.len();
    }
    let mut index = max_bytes;
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

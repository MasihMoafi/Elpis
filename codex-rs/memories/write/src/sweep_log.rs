// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! A plain-language record of every consolidation sweep, written next to the memory files.
//!
//! Consolidation decides in the background what the user will and will not remember, and
//! until this existed it left no trace: on a real install it ran for five days, completed
//! every job, reported no error, and promoted nothing — and none of that was visible
//! without reading a SQLite database. Each sweep now appends one line saying what it did,
//! including the sweeps that did nothing, which are the ones worth noticing.

use std::path::Path;
use std::path::PathBuf;

use tokio::io::AsyncWriteExt;

const FILENAME: &str = "memory-sweeps.md";
const HEADER: &str = "# Memory sweep log\n\n\
     One line per consolidation sweep, newest last. `no change` is a normal outcome; a long\n\
     run of it means nothing is reaching durable memory.\n\n";

/// The log lives beside the memory directory, never inside it. The memory directory is a git
/// workspace whose dirtiness is what tells consolidation there is new material; a log written
/// into it would make every sweep look like new work and schedule the next one forever.
pub(crate) fn sweep_log_path(root: &Path) -> PathBuf {
    match root.parent() {
        Some(elpis_home) => elpis_home.join("logs").join(FILENAME),
        None => root.join(FILENAME),
    }
}

/// Appends one sweep outcome. Logging must never take the pipeline down, so failures are
/// warnings: a missing log is worth less than a broken sweep.
pub(crate) async fn record(root: &Path, outcome: &str) {
    if let Err(err) = append(root, outcome).await {
        tracing::warn!("failed writing the memory sweep log: {err}");
    }
}

async fn append(root: &Path, outcome: &str) -> std::io::Result<()> {
    let path = sweep_log_path(root);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let is_new = !tokio::fs::try_exists(&path).await?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await?;
    if is_new {
        file.write_all(HEADER.as_bytes()).await?;
    }
    file.write_all(format!("- {timestamp} — {outcome}\n").as_bytes())
        .await?;
    file.flush().await
}

/// Describes what a sweep did to durable memory in the terms a reader cares about: whether
/// the file they rely on actually changed.
pub(crate) fn describe_memory_change(before: Option<u64>, after: Option<u64>) -> String {
    match (before, after) {
        (Some(before), Some(after)) if before == after => {
            format!("MEMORY.md unchanged ({before} bytes)")
        }
        (Some(before), Some(after)) => format!("MEMORY.md {before} -> {after} bytes"),
        (None, Some(after)) => format!("MEMORY.md created ({after} bytes)"),
        (Some(before), None) => format!("MEMORY.md removed (was {before} bytes)"),
        (None, None) => "MEMORY.md still absent".to_string(),
    }
}

pub(crate) async fn memory_file_size(root: &Path) -> Option<u64> {
    tokio::fs::metadata(root.join("MEMORY.md"))
        .await
        .ok()
        .map(|metadata| metadata.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn records_every_sweep_including_the_ones_that_changed_nothing() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path().join("memories");

        record(&root, "no change; 60 candidates").await;
        record(&root, "promoted; MEMORY.md 100 -> 220 bytes").await;

        let log = tokio::fs::read_to_string(sweep_log_path(&root))
            .await
            .expect("sweep log");
        assert!(log.starts_with("# Memory sweep log"));
        assert!(log.contains("no change; 60 candidates"));
        assert!(log.contains("promoted; MEMORY.md 100 -> 220 bytes"));
        assert_eq!(
            log.lines().filter(|line| line.starts_with("- ")).count(),
            2,
            "each sweep should appear exactly once"
        );
    }

    #[test]
    fn describes_the_change_a_reader_cares_about() {
        assert_eq!(
            describe_memory_change(Some(10), Some(10)),
            "MEMORY.md unchanged (10 bytes)"
        );
        assert_eq!(
            describe_memory_change(Some(10), Some(40)),
            "MEMORY.md 10 -> 40 bytes"
        );
        assert_eq!(
            describe_memory_change(None, Some(40)),
            "MEMORY.md created (40 bytes)"
        );
    }
}

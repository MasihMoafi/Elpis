//! Local persistence for explicitly enabled automatic memory.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use serde::Deserialize;
use serde::Serialize;

pub const OUTPUT_CHARS: usize = 6_000;

#[derive(Default, Serialize)]
pub struct MemorySaveTiming {
    pub preparation_ms: u64,
    pub request_ms: u64,
    /// Local commit work up to the final receipt write.
    pub commit_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryDecision {
    pub checkpoint: String,
    pub memory: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    enabled: bool,
}

pub fn parse_decision(text: &str) -> anyhow::Result<MemoryDecision> {
    let decision: MemoryDecision = serde_json::from_str(text)?;
    anyhow::ensure!(!decision.checkpoint.trim().is_empty(), "empty checkpoint");
    for content in [&decision.checkpoint, &decision.memory] {
        anyhow::ensure!(
            content.chars().count() <= OUTPUT_CHARS,
            "memory output exceeds character budget"
        );
        anyhow::ensure!(
            !content.contains('\0'),
            "memory output contains a NUL character"
        );
    }
    Ok(decision)
}

pub struct MemorySnapshot {
    root: PathBuf,
    workspace: PathBuf,
    pub checkpoint: String,
    pub memory: String,
    pub goal: String,
    _lock: File,
    _checkpoint_lock: File,
}

#[derive(Debug, thiserror::Error)]
#[error("another memory save is already running")]
struct MemoryLockBusy;

pub fn try_lock_memory(root: &Path) -> anyhow::Result<Option<File>> {
    try_lock_file(root, "memory-save.lock")
}

pub fn try_lock_checkpoint(workspace: &Path) -> anyhow::Result<Option<File>> {
    try_lock_file(workspace, "checkpoint.lock")
}

fn try_lock_file(directory: &Path, name: &str) -> anyhow::Result<Option<File>> {
    std::fs::create_dir_all(directory)?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join(name))?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_optional(path: &Path) -> anyhow::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

impl MemorySnapshot {
    pub async fn open_when_available(root: &Path, cwd: &Path) -> anyhow::Result<Option<Self>> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            match Self::open(root, cwd) {
                Err(error)
                    if error.is::<MemoryLockBusy>() && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                result => return result,
            }
        }
    }

    pub fn open(root: &Path, cwd: &Path) -> anyhow::Result<Option<Self>> {
        let workspace = crate::elpis_context::workspace_context_dir(Some(root), cwd)
            .context("workspace memory path unavailable")?;
        let settings = read_optional(&workspace.join("memory-autosave.json"))?;
        if settings.is_empty() || !serde_json::from_str::<Settings>(&settings)?.enabled {
            return Ok(None);
        }
        // One writer across workspaces because MEMORY.md is shared. The OS releases
        // this lock on cancellation or process exit; there is no stale lock cleanup.
        let lock = try_lock_memory(root)?.ok_or(MemoryLockBusy)?;
        // Acquire shared memory first, so waiting savers do not block unrelated
        // workspace checkpoint writers. Both guards protect the snapshot through commit.
        let checkpoint_lock = try_lock_checkpoint(&workspace)?.ok_or(MemoryLockBusy)?;
        let memory = read_optional(&root.join("MEMORY.md"))?;
        let checkpoint = read_optional(&workspace.join("ES.md"))?;
        let goal = read_optional(&workspace.join("GOAL.md"))?;
        anyhow::ensure!(goal.chars().count() <= 8_000, "existing goal is oversized");
        anyhow::ensure!(
            memory.chars().count() <= 8_000,
            "existing memory is oversized; refusing to truncate it"
        );
        anyhow::ensure!(
            checkpoint.chars().count() <= 8_000,
            "existing checkpoint is oversized; refusing to truncate it"
        );
        Ok(Some(Self {
            root: root.into(),
            workspace,
            memory,
            checkpoint,
            goal,
            _lock: lock,
            _checkpoint_lock: checkpoint_lock,
        }))
    }

    pub fn commit(
        &self,
        decision: &MemoryDecision,
        thread: &str,
        turn: &str,
        usage: Option<&codex_protocol::protocol::TokenUsage>,
        evidence: Option<&str>,
        mut timing: MemorySaveTiming,
    ) -> anyhow::Result<()> {
        let commit_started = std::time::Instant::now();
        let memory_path = self.root.join("MEMORY.md");
        let checkpoint_path = self.workspace.join("ES.md");
        anyhow::ensure!(
            read_optional(&memory_path)? == self.memory,
            "memory was edited during consolidation"
        );
        anyhow::ensure!(
            read_optional(&checkpoint_path)? == self.checkpoint,
            "checkpoint changed during consolidation"
        );
        anyhow::ensure!(
            self.memory
                .trim()
                .trim_start_matches("# Elpis Memory")
                .trim()
                .is_empty()
                || !decision.memory.trim().is_empty(),
            "refusing to erase existing memory"
        );
        let checkpoint = format!(
            "# Elpis Session Checkpoint\n\n- Thread: `{thread}`\n- Turn: `{turn}`\n\n## Consolidated State\n\n{}\n",
            decision.checkpoint
        );
        // Save recovery evidence before replacing either human-readable file.
        let mut receipt = serde_json::json!({
            "status": "prepared", "evidence": evidence,
            "model": "gpt-5.6-luna", "thread": thread, "turn": turn,
            "previous_checkpoint": self.checkpoint, "previous_memory": self.memory,
            "checkpoint": decision.checkpoint, "memory": decision.memory, "usage": usage,
        });
        let receipt_dir = self.workspace.join("memory-saves");
        std::fs::create_dir_all(&receipt_dir)?;
        let receipt_path = receipt_dir.join(format!("{}.json", uuid::Uuid::new_v4()));
        atomic_write(&receipt_path, &serde_json::to_string_pretty(&receipt)?)?;
        atomic_write(&memory_path, &decision.memory)?;
        if let Err(error) = atomic_write(&checkpoint_path, &checkpoint) {
            atomic_write(&memory_path, &self.memory)
                .context("restore memory after checkpoint write failure")?;
            return Err(error);
        }
        receipt["status"] = "committed".into();
        timing.commit_ms = commit_started.elapsed().as_millis() as u64;
        receipt["timing"] = serde_json::to_value(timing)?;
        atomic_write(&receipt_path, &serde_json::to_string_pretty(&receipt)?)?;
        Ok(())
    }
}

fn atomic_write(path: &Path, text: &str) -> anyhow::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().context("missing parent")?)?;
    temporary.write_all(text.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn waits_for_short_memory_lock_but_bounds_contention_and_other_errors()
    -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("memories");
        let cwd = dir.path().join("project");
        let workspace = crate::elpis_context::workspace_context_dir(Some(&root), &cwd).unwrap();
        std::fs::create_dir_all(&workspace)?;
        let settings = workspace.join("memory-autosave.json");
        std::fs::write(&settings, "{\"enabled\":true}")?;
        let lock = try_lock_checkpoint(&workspace)?.unwrap();
        assert!(MemorySnapshot::open(&root, &cwd).is_err());
        assert!(
            try_lock_memory(&root)?.is_some(),
            "failed checkpoint acquisition retained the global lock"
        );
        let release = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            drop(lock);
        };
        let (snapshot, ()) =
            tokio::join!(MemorySnapshot::open_when_available(&root, &cwd), release);
        let snapshot = snapshot?.unwrap();
        assert!(try_lock_checkpoint(&workspace)?.is_none());
        assert!(try_lock_memory(&root)?.is_none());
        assert!(try_lock_checkpoint(&dir.path().join("other-workspace"))?.is_some());
        let started = tokio::time::Instant::now();
        let error = MemorySnapshot::open_when_available(&root, &cwd)
            .await
            .err()
            .unwrap();
        assert!(error.is::<MemoryLockBusy>());
        assert_eq!(started.elapsed(), std::time::Duration::from_secs(1));
        std::fs::write(&settings, "invalid settings")?;
        let started = tokio::time::Instant::now();
        let error = MemorySnapshot::open_when_available(&root, &cwd)
            .await
            .err()
            .unwrap();
        assert!(!error.is::<MemoryLockBusy>());
        assert!(started.elapsed().is_zero());
        drop(snapshot);
        assert!(try_lock_checkpoint(&workspace)?.is_some());
        assert!(try_lock_memory(&root)?.is_some());
        Ok(())
    }

    #[test]
    fn rejects_invalid_and_oversized_decisions() {
        for text in ["{}", "{\"checkpoint\":\"\",\"memory\":\"x\"}", "not json"] {
            assert!(parse_decision(text).is_err());
        }
        let text = serde_json::json!({"checkpoint":"界".repeat(OUTPUT_CHARS + 1),"memory":""});
        assert!(parse_decision(&text.to_string()).is_err());
    }

    #[test]
    fn saves_reopens_corrects_and_preserves_concurrent_edits() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("memories");
        let cwd = dir.path().join("project");
        let workspace = crate::elpis_context::workspace_context_dir(Some(&root), &cwd).unwrap();
        std::fs::create_dir_all(&workspace)?;
        assert!(MemorySnapshot::open(&root, &cwd)?.is_none());
        assert!(!workspace.join("memory-saves").exists());
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        let snapshot = MemorySnapshot::open(&root, &cwd)?.unwrap();
        assert!(MemorySnapshot::open(&root, &cwd).is_err());
        snapshot.commit(
            &MemoryDecision {
                checkpoint: "- [ ] Verify release".into(),
                memory: "- Cedar port 4812 [u1]".into(),
            },
            "thread",
            "turn1",
            None,
            None,
            MemorySaveTiming {
                preparation_ms: 12,
                request_ms: 34,
                commit_ms: 0,
            },
        )?;
        let receipt_path = std::fs::read_dir(workspace.join("memory-saves"))?
            .next()
            .unwrap()?
            .path();
        let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(receipt_path)?)?;
        assert_eq!(receipt["timing"]["preparation_ms"], 12);
        assert_eq!(receipt["timing"]["request_ms"], 34);
        assert!(receipt["timing"]["commit_ms"].is_u64());
        drop(snapshot);
        let snapshot = MemorySnapshot::open(&root, &cwd)?.unwrap();
        assert!(snapshot.memory.contains("4812"));
        snapshot.commit(
            &MemoryDecision {
                checkpoint: "- [ ] Verify release".into(),
                memory: "- Cedar port 5823 [u2]".into(),
            },
            "thread",
            "turn2",
            None,
            None,
            MemorySaveTiming {
                preparation_ms: 12,
                request_ms: 34,
                commit_ms: 0,
            },
        )?;
        drop(snapshot);
        let snapshot = MemorySnapshot::open(&root, &cwd)?.unwrap();
        assert!(!snapshot.memory.contains("4812"));
        std::fs::write(root.join("MEMORY.md"), "User edit")?;
        assert!(
            snapshot
                .commit(
                    &MemoryDecision {
                        checkpoint: "pending".into(),
                        memory: "replacement".into()
                    },
                    "thread",
                    "turn3",
                    None,
                    None,
                    MemorySaveTiming::default()
                )
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(root.join("MEMORY.md"))?,
            "User edit"
        );
        Ok(())
    }
}

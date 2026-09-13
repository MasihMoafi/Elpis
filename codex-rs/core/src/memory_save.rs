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
        let references_path = self.root.join("memory-references/sources.md");
        let references = read_optional(&references_path)?;
        let parsed_evidence: Option<serde_json::Value> =
            evidence.map(serde_json::from_str).transpose()?;
        let evidence_ids: std::collections::HashSet<&str> = parsed_evidence
            .as_ref()
            .and_then(|value| value.get("evidence"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("id").and_then(serde_json::Value::as_str))
            .collect();
        let previous_ids: std::collections::HashSet<&str> = evidence_citations(&self.memory)
            .chain(evidence_citations(&self.checkpoint))
            .collect();
        for citation in
            evidence_citations(&decision.memory).chain(evidence_citations(&decision.checkpoint))
        {
            anyhow::ensure!(
                evidence_ids.contains(citation)
                    || previous_ids.contains(citation)
                    || references.contains(&format!("`{citation}`")),
                "unsupported evidence citation; previous notes preserved"
            );
        }
        let (memory, updated_references) = shorten_memory_references(&decision.memory, &references);
        // Save recovery evidence before replacing either human-readable file.
        let mut receipt = serde_json::json!({
            "status": "prepared", "evidence": evidence,
            "model": "gpt-5.6-luna", "thread": thread, "turn": turn,
            "previous_checkpoint": self.checkpoint, "previous_memory": self.memory,
            "checkpoint": decision.checkpoint, "memory": memory,
            "model_memory": decision.memory, "usage": usage,
        });
        let receipt_dir = self.workspace.join("memory-saves");
        std::fs::create_dir_all(&receipt_dir)?;
        let receipt_path = receipt_dir.join(format!("{}.json", uuid::Uuid::new_v4()));
        atomic_write(&receipt_path, &serde_json::to_string_pretty(&receipt)?)?;
        if updated_references != references {
            std::fs::create_dir_all(
                references_path
                    .parent()
                    .context("missing reference directory")?,
            )?;
            // Publish provenance first. An interrupted save may leave unused references,
            // but never a saved citation whose source was not written.
            atomic_write(&references_path, &updated_references)?;
        }
        atomic_write(&memory_path, &memory)?;
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

fn evidence_citations(text: &str) -> impl Iterator<Item = &str> {
    text.split('[')
        .skip(1)
        .filter_map(|part| part.split_once(']').map(|(citation, _)| citation))
        .flat_map(|citation| citation.split(','))
        .map(str::trim)
        .filter(|citation| {
            // Include damaged UUID-based IDs as well as every format we shorten.
            is_evidence_id(citation)
                || citation.split_once(':').is_some_and(|(source, _)| {
                    source.len() >= 32
                        && source.as_bytes().get(8) == Some(&b'-')
                        && source
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                })
        })
}

fn is_evidence_id(value: &str) -> bool {
    let components: Vec<_> = value.split(':').collect();
    (2..=3).contains(&components.len())
        && components
            .last()
            .and_then(|s| s.parse::<usize>().ok())
            .is_some()
        && components[..components.len() - 1]
            .iter()
            .all(|s| uuid::Uuid::parse_str(s).is_ok())
}

fn shorten_memory_references(memory: &str, references: &str) -> (String, String) {
    let mut sources = std::collections::BTreeMap::new();
    let mut highest = 0_u64;
    for line in references.lines() {
        let columns: Vec<_> = line.split('|').map(str::trim).collect();
        if columns.len() == 4
            && let Ok(number) = columns[1].parse::<u64>()
        {
            highest = highest.max(number);
            sources.insert(columns[2].trim_matches('`').to_owned(), number);
        }
    }
    // Reserve existing short citations even when their provenance is external.
    for part in memory.split('[').skip(1) {
        if let Some((citation, _)) = part.split_once(']') {
            for value in citation.split(',') {
                if let Ok(number) = value.trim().parse::<u64>() {
                    highest = highest.max(number);
                }
            }
        }
    }
    let mut updated = references.to_owned();
    let mut output = String::new();
    let mut remaining = memory;
    while let Some((before, after)) = remaining.split_once('[') {
        output.push_str(before);
        output.push('[');
        let Some((citation, rest)) = after.split_once(']') else {
            output.push_str(after);
            remaining = "";
            break;
        };
        let mut rewritten = Vec::new();
        for part in citation.split(',') {
            let value = part.trim();
            if !is_evidence_id(value) {
                rewritten.push(part.to_owned());
                continue;
            }
            let number = if let Some(number) = sources.get(value) {
                *number
            } else {
                let Some(next) = highest.checked_add(1) else {
                    rewritten.push(part.to_owned());
                    continue;
                };
                highest = next;
                sources.insert(value.to_owned(), next);
                if updated.is_empty() {
                    updated.push_str(
                        "# Memory sources\n\n| Reference | Original evidence ID |\n| --- | --- |\n",
                    );
                } else if !updated.ends_with('\n') {
                    updated.push('\n');
                }
                updated.push_str(&format!("| {next} | `{value}` |\n"));
                next
            };
            rewritten.push(part.replacen(value, &number.to_string(), 1));
        }
        output.push_str(&rewritten.join(","));
        output.push(']');
        remaining = rest;
    }
    output.push_str(remaining);
    (output, updated)
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

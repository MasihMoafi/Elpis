//! Guarded local persistence for explicitly enabled agent-owned memory.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use serde::Deserialize;
use serde::Serialize;

pub const OUTPUT_CHARS: usize = 6_000;
const EXISTING_INPUT_CHARS: usize = 8_000;
const OMITTED_CHECKPOINT_MARKER: &str =
    "\n\n[...checkpoint middle omitted for memory consolidation...]\n\n";

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

#[derive(Debug, Default)]
pub struct MemoryUpdate {
    pub checkpoint: Option<String>,
    pub memory: Option<String>,
}

#[derive(Clone, Debug)]
pub struct MemoryBaseline {
    memory: String,
    checkpoint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    enabled: bool,
}

pub fn parse_decision(text: &str) -> anyhow::Result<MemoryDecision> {
    parse_decision_or_skip_oversized(text)?.context("memory output exceeds character budget")
}

/// Parse a memory decision while treating an otherwise-valid oversized generation as a skipped
/// save. The caller can then preserve the last valid snapshot instead of surfacing a maintenance
/// error or truncating durable notes.
/// Escape control characters that a generator left raw inside a JSON string.
///
/// A model writing prose into a string field emits its line breaks literally,
/// which strict JSON rejects. The same bytes outside a string are ordinary
/// whitespace and are left alone.
fn escape_raw_control_characters(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for character in text.chars() {
        if !in_string {
            in_string = character == '"';
            out.push(character);
        } else if escaped {
            escaped = false;
            out.push(character);
        } else {
            match character {
                '\\' => {
                    escaped = true;
                    out.push(character);
                }
                '"' => {
                    in_string = false;
                    out.push(character);
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                control if control.is_control() => {
                    out.push_str(&format!("\\u{:04x}", control as u32));
                }
                character => out.push(character),
            }
        }
    }
    out
}

pub fn parse_decision_or_skip_oversized(text: &str) -> anyhow::Result<Option<MemoryDecision>> {
    let decision: MemoryDecision = serde_json::from_str(&escape_raw_control_characters(text))?;
    anyhow::ensure!(!decision.checkpoint.trim().is_empty(), "empty checkpoint");
    for content in [&decision.checkpoint, &decision.memory] {
        anyhow::ensure!(
            !content.contains('\0'),
            "memory output contains a NUL character"
        );
    }
    if [&decision.checkpoint, &decision.memory]
        .into_iter()
        .any(|content| content.chars().count() > OUTPUT_CHARS)
    {
        return Ok(None);
    }
    Ok(Some(decision))
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
    pub fn baseline_when_enabled(
        root: &Path,
        cwd: &Path,
    ) -> anyhow::Result<Option<MemoryBaseline>> {
        let workspace = crate::elpis_context::workspace_context_dir(Some(root), cwd)
            .context("workspace memory path unavailable")?;
        let settings = read_optional(&workspace.join("memory-autosave.json"))?;
        if settings.is_empty() || !serde_json::from_str::<Settings>(&settings)?.enabled {
            return Ok(None);
        }
        Ok(Some(MemoryBaseline {
            memory: read_optional(&root.join("MEMORY.md"))?,
            checkpoint: read_optional(&workspace.join("ES.md"))?,
        }))
    }

    pub async fn open_when_available(root: &Path, cwd: &Path) -> anyhow::Result<Option<Self>> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            match Self::open(root, cwd) {
                Err(error) if error.is::<MemoryLockBusy>() => {
                    if tokio::time::Instant::now() >= deadline {
                        // A saver already owns the complete snapshot and its locks.
                        // Treat the overlapping boundary as coalesced rather than
                        // presenting normal contention as a failed save.
                        return Ok(None);
                    }
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
            memory.chars().count() <= EXISTING_INPUT_CHARS,
            "existing memory is oversized; refusing to truncate it"
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

    /// Return a bounded model-input view without changing the checkpoint held for conflict checks,
    /// rollback evidence, or the on-disk file. Keeping both ends preserves the current state and
    /// the latest result from legacy checkpoints that predate the save budget.
    pub(crate) fn checkpoint_for_prompt(&self) -> String {
        let notes = self
            .checkpoint
            .split_once("\n## Consolidated State\n\n")
            .map(|(_, notes)| notes)
            .unwrap_or(&self.checkpoint);
        bounded_checkpoint(notes)
    }

    pub fn commit(
        &self,
        baseline: &MemoryBaseline,
        decision: &MemoryDecision,
        model: &str,
        thread: &str,
        turn: &str,
        usage: Option<&codex_protocol::protocol::TokenUsage>,
        evidence: Option<&str>,
        timing: MemorySaveTiming,
    ) -> anyhow::Result<(String, String)> {
        self.commit_update(
            baseline,
            &MemoryUpdate {
                checkpoint: Some(decision.checkpoint.clone()),
                memory: Some(decision.memory.clone()),
            },
            model,
            thread,
            turn,
            usage,
            evidence,
            timing,
        )
    }

    pub fn commit_update(
        &self,
        baseline: &MemoryBaseline,
        update: &MemoryUpdate,
        writer: &str,
        thread: &str,
        turn: &str,
        usage: Option<&codex_protocol::protocol::TokenUsage>,
        evidence: Option<&str>,
        mut timing: MemorySaveTiming,
    ) -> anyhow::Result<(String, String)> {
        let commit_started = std::time::Instant::now();
        self.validate_baseline(baseline)?;
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
        let memory = update.memory.as_deref().unwrap_or(&self.memory);
        let checkpoint = update.checkpoint.as_ref().map(|checkpoint| {
            format!(
                "# Elpis Session Checkpoint\n\n- Thread: `{thread}`\n- Turn: `{turn}`\n\n## Consolidated State\n\n{checkpoint}\n"
            )
        });
        if update.memory.is_some() {
            anyhow::ensure!(
                self.memory
                    .trim()
                    .trim_start_matches("# Elpis Memory")
                    .trim()
                    .is_empty()
                    || !memory.trim().is_empty(),
                "refusing to erase existing memory"
            );
            anyhow::ensure!(
                memory.chars().count() <= OUTPUT_CHARS,
                "memory output exceeds character budget"
            );
            anyhow::ensure!(
                !memory.contains('\0'),
                "memory output contains a NUL character"
            );
        }
        if let Some(checkpoint) = update.checkpoint.as_deref() {
            anyhow::ensure!(!checkpoint.trim().is_empty(), "empty checkpoint");
            anyhow::ensure!(
                checkpoint.chars().count() <= OUTPUT_CHARS,
                "checkpoint output exceeds character budget"
            );
            anyhow::ensure!(
                !checkpoint.contains('\0'),
                "checkpoint output contains a NUL character"
            );
        }
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
        validate_unchanged_memory_citations(&self.memory, memory, &references)?;
        for citation in evidence_citations(memory).chain(
            update
                .checkpoint
                .as_deref()
                .into_iter()
                .flat_map(|text| evidence_citations(text)),
        ) {
            anyhow::ensure!(
                evidence_ids.contains(citation)
                    || previous_ids.contains(citation)
                    || references.contains(&format!("`{citation}`")),
                "unsupported evidence citation; previous notes preserved"
            );
        }
        let (memory, updated_references) = if update.memory.is_some() {
            shorten_memory_references(memory, &references)
        } else {
            (self.memory.clone(), references.clone())
        };
        // Save recovery evidence before replacing either human-readable file.
        let mut receipt = serde_json::json!({
            "status": "prepared", "evidence": parsed_evidence,
            "model": writer, "thread": thread, "turn": turn,
            "previous_checkpoint": self.checkpoint, "previous_memory": self.memory,
            "checkpoint": update.checkpoint, "memory": memory,
            "model_memory": update.memory, "usage": usage,
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
        if update.memory.is_some() {
            atomic_write(&memory_path, &memory)?;
        }
        if let Some(checkpoint) = &checkpoint
            && let Err(error) = atomic_write(&checkpoint_path, checkpoint)
        {
            if update.memory.is_some() {
                atomic_write(&memory_path, &self.memory)
                    .context("restore memory after checkpoint write failure")?;
            }
            return Err(error);
        }
        receipt["status"] = "committed".into();
        timing.commit_ms = commit_started.elapsed().as_millis() as u64;
        receipt["timing"] = serde_json::to_value(timing)?;
        atomic_write(&receipt_path, &serde_json::to_string_pretty(&receipt)?)?;
        Ok((
            memory,
            checkpoint.unwrap_or_else(|| self.checkpoint.clone()),
        ))
    }

    pub fn validate_baseline(&self, baseline: &MemoryBaseline) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.memory == baseline.memory,
            "memory changed after this turn began"
        );
        anyhow::ensure!(
            self.checkpoint == baseline.checkpoint,
            "checkpoint changed after this turn began"
        );
        Ok(())
    }
}

fn bounded_checkpoint(checkpoint: &str) -> String {
    let char_count = checkpoint.chars().count();
    if char_count <= EXISTING_INPUT_CHARS {
        return checkpoint.to_string();
    }

    let marker_chars = OMITTED_CHECKPOINT_MARKER.chars().count();
    let retained_chars = EXISTING_INPUT_CHARS.saturating_sub(marker_chars);
    let head_chars = retained_chars / 2;
    let tail_chars = retained_chars - head_chars;
    let tail_byte = checkpoint
        .char_indices()
        .nth(char_count - tail_chars)
        .map(|(index, _)| index)
        .unwrap_or(checkpoint.len());
    let mut bounded = checkpoint.chars().take(head_chars).collect::<String>();
    bounded.push_str(OMITTED_CHECKPOINT_MARKER);
    bounded.push_str(&checkpoint[tail_byte..]);
    bounded
}

fn validate_unchanged_memory_citations(
    previous: &str,
    proposed: &str,
    references: &str,
) -> anyhow::Result<()> {
    let known: std::collections::BTreeSet<_> = reference_rows(references)
        .map(|(_, number)| number)
        .collect();
    let previous: Vec<_> = previous
        .lines()
        .filter_map(short_cited_line)
        .filter(|(_, citations)| citations.is_subset(&known))
        .collect();
    for (fact, citations) in proposed.lines().filter_map(short_cited_line) {
        let mut matching = previous.iter().filter(|(text, _)| *text == fact).peekable();
        anyhow::ensure!(
            matching.peek().is_none()
                || (citations.is_subset(&known)
                    && matching.any(|(_, original)| original.is_subset(&citations))),
            "memory citation changed for unchanged text; previous notes preserved"
        );
    }
    Ok(())
}

fn short_cited_line(line: &str) -> Option<(&str, std::collections::BTreeSet<u64>)> {
    let line = line.trim_end().strip_suffix('.').unwrap_or(line.trim_end());
    let (fact, citations) = line.strip_suffix(']')?.rsplit_once('[')?;
    if !fact.ends_with(char::is_whitespace) {
        return None;
    }
    let citations = citations
        .split(',')
        .map(|citation| citation.trim().parse().ok())
        .collect::<Option<_>>()?;
    Some((fact.trim_end(), citations))
}

fn evidence_citations(text: &str) -> impl Iterator<Item = &str> {
    text.split('[')
        .skip(1)
        .filter_map(|part| part.split_once(']').map(|(citation, _)| citation))
        .flat_map(|citation| citation.split(','))
        .map(str::trim)
        .filter(|citation| is_evidence_citation(citation))
}

fn is_evidence_citation(citation: &str) -> bool {
    is_evidence_id(citation)
        || citation.split_once(':').is_some_and(|(source, _)| {
            source.len() >= 32
                && source.as_bytes().get(8) == Some(&b'-')
                && source
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
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

fn reference_rows(references: &str) -> impl Iterator<Item = (&str, u64)> {
    references.lines().filter_map(|line| {
        let columns: Vec<_> = line.split('|').map(str::trim).collect();
        let [_, number, source, _] = columns.as_slice() else {
            return None;
        };
        Some((source.trim_matches('`'), number.parse().ok()?))
    })
}

fn shorten_memory_references(memory: &str, references: &str) -> (String, String) {
    let mut sources = std::collections::BTreeMap::new();
    let mut highest = 0_u64;
    for (source, number) in reference_rows(references) {
        highest = highest.max(number);
        sources.insert(source.to_owned(), number);
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
            if !is_evidence_citation(value) {
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

    fn baseline(snapshot: &MemorySnapshot) -> MemoryBaseline {
        MemoryBaseline {
            memory: snapshot.memory.clone(),
            checkpoint: snapshot.checkpoint.clone(),
        }
    }

    #[test]
    fn a_raw_newline_inside_the_generated_json_still_saves() {
        // A background model writing prose into a JSON string emits the line
        // break literally. Strict JSON forbids that, and the whole save was
        // being thrown away over it.
        let raw = "{\"checkpoint\":\"done\",\"memory\":\"first line\nsecond line\"}";
        let decision = parse_decision_or_skip_oversized(raw)
            .expect("a raw line break must not lose the save")
            .expect("the decision is within budget");
        assert_eq!(decision.memory, "first line\nsecond line");
        assert_eq!(decision.checkpoint, "done");
    }

    #[test]
    fn legacy_damaged_citations_are_shortened_without_claiming_validity() {
        let source =
            "01a08a44-2bba-7213-bce24-4a7e5f0423aa:633f51dc-fc48-4f7e-811e-a4be39343ca8:424";
        assert!(!is_evidence_id(source));
        let original = format!("Keep the lesson [{source}]. Ordinary [draft] stays.");
        let (memory, references) = shorten_memory_references(&original, "");
        assert_eq!(memory, "Keep the lesson [1]. Ordinary [draft] stays.");
        assert!(references.contains(source));
        assert_eq!(
            shorten_memory_references(&memory, &references),
            (memory, references)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_short_memory_lock_but_coalesces_contention_and_surfaces_other_errors()
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
        let contended = MemorySnapshot::open_when_available(&root, &cwd).await?;
        assert!(contended.is_none());
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
    fn oversized_decision_is_skipped_without_replacing_valid_memory() -> anyhow::Result<()> {
        let text = serde_json::json!({
            "checkpoint": "x".repeat(OUTPUT_CHARS + 1),
            "memory": "new memory"
        });

        assert!(
            parse_decision_or_skip_oversized(&text.to_string())?.is_none(),
            "an oversized generation must preserve the last valid snapshot"
        );
        assert!(parse_decision_or_skip_oversized("not json").is_err());
        assert!(
            parse_decision_or_skip_oversized(
                &serde_json::json!({"checkpoint":"valid","memory":"valid"}).to_string()
            )?
            .is_some()
        );
        Ok(())
    }

    #[test]
    fn legacy_oversized_checkpoint_opens_without_mutating_source() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("memories");
        let cwd = dir.path().join("project");
        let workspace = crate::elpis_context::workspace_context_dir(Some(&root), &cwd).unwrap();
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        let checkpoint = format!(
            "# Elpis Session Checkpoint\n\n- Thread: `legacy`\n\n## Consolidated State\n\ncurrent-state\n{}\nlatest-result",
            "界".repeat(EXISTING_INPUT_CHARS + 1)
        );
        let checkpoint_path = workspace.join("ES.md");
        std::fs::write(&checkpoint_path, &checkpoint)?;

        let snapshot = MemorySnapshot::open(&root, &cwd)?.expect("enabled memory snapshot");
        let prompt_checkpoint = snapshot.checkpoint_for_prompt();

        assert_eq!(snapshot.checkpoint, checkpoint);
        assert_eq!(std::fs::read_to_string(&checkpoint_path)?, checkpoint);
        assert_eq!(prompt_checkpoint.chars().count(), EXISTING_INPUT_CHARS);
        assert!(prompt_checkpoint.starts_with("current-state"));
        assert!(prompt_checkpoint.ends_with("latest-result"));
        assert!(prompt_checkpoint.contains(OMITTED_CHECKPOINT_MARKER));

        snapshot.commit(
            &baseline(&snapshot),
            &MemoryDecision {
                checkpoint: "bounded replacement".into(),
                memory: String::new(),
            },
            "gpt-5.6-luna",
            "thread",
            "turn",
            None,
            None,
            MemorySaveTiming::default(),
        )?;
        let replaced = std::fs::read_to_string(checkpoint_path)?;
        assert!(replaced.contains("bounded replacement"));
        assert!(replaced.chars().count() <= EXISTING_INPUT_CHARS);

        assert_eq!(
            bounded_checkpoint("ordinary checkpoint"),
            "ordinary checkpoint"
        );
        Ok(())
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
            &baseline(&snapshot),
            &MemoryDecision {
                checkpoint: "- [ ] Verify release".into(),
                memory: "- Cedar port 4812 [u1]".into(),
            },
            "gpt-5.6-luna",
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
            &baseline(&snapshot),
            &MemoryDecision {
                checkpoint: "- [ ] Verify release".into(),
                memory: "- Cedar port 5823 [u2]".into(),
            },
            "gpt-5.6-luna",
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
                    &baseline(&snapshot),
                    &MemoryDecision {
                        checkpoint: "pending".into(),
                        memory: "replacement".into()
                    },
                    "gpt-5.6-luna",
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

    #[test]
    fn turn_start_baseline_rejects_external_edits_without_touching_any_file() -> anyhow::Result<()>
    {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("memories");
        let cwd = dir.path().join("project");
        let workspace = crate::elpis_context::workspace_context_dir(Some(&root), &cwd).unwrap();
        std::fs::create_dir_all(root.join("memory-references"))?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        std::fs::write(root.join("MEMORY.md"), "memory A")?;
        std::fs::write(workspace.join("ES.md"), "checkpoint A")?;
        std::fs::write(root.join("memory-references/sources.md"), "references A")?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, &cwd)?.unwrap();

        std::fs::write(root.join("MEMORY.md"), "memory B")?;
        std::fs::write(workspace.join("ES.md"), "checkpoint B")?;
        let snapshot = MemorySnapshot::open(&root, &cwd)?.unwrap();
        let result = snapshot.commit_update(
            &baseline,
            &MemoryUpdate {
                memory: Some("memory C".to_string()),
                checkpoint: Some("checkpoint C".to_string()),
            },
            "responding-agent",
            "thread",
            "turn",
            None,
            None,
            MemorySaveTiming::default(),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(root.join("MEMORY.md"))?, "memory B");
        assert_eq!(
            std::fs::read_to_string(workspace.join("ES.md"))?,
            "checkpoint B"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("memory-references/sources.md"))?,
            "references A"
        );
        assert!(!workspace.join("memory-saves").exists());
        Ok(())
    }
}

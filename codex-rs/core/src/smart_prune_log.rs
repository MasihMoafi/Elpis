//! Human-readable projections of the immutable Smart Prune evidence.

use std::path::Component;
use std::path::Path;

use anyhow::Context;
use anyhow::Result;
use codex_protocol::models::ResponseItem;
use serde::Deserialize;
use serde_json::Value;

use crate::session::smart_prune_audit::AttemptStatus;
use crate::smart_prune::AdmissionDecision;
use crate::smart_prune::MIN_SAVED_TOKENS;
use crate::smart_prune::MIN_SAVINGS_PERCENT;
use crate::smart_prune::parse_decision_manifest;
use crate::smart_prune::textual_tool_output;

#[derive(Clone, Debug)]
pub struct PruneLogItem {
    pub call_id: String,
    pub kept: Option<String>,
    pub description: String,
    pub source_tokens: usize,
    pub admitted_tokens: usize,
    pub decision: String,
    pub original: String,
    pub compact: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PruneLogRecord {
    pub attempt_id: String,
    pub thread_id: String,
    pub timestamp: String,
    pub chat_title: String,
    pub turn_id: String,
    pub turn_number: Option<usize>,
    pub model: String,
    pub reasoning_effort: String,
    pub items: Vec<PruneLogItem>,
    pub note: Option<String>,
}

impl PruneLogRecord {
    fn add_note(&mut self, note: String) {
        match &mut self.note {
            Some(existing) => {
                existing.push(' ');
                existing.push_str(&note);
            }
            None => self.note = Some(note),
        }
    }

    pub fn source_tokens(&self) -> usize {
        self.items.iter().map(|item| item.source_tokens).sum()
    }

    pub fn saved_tokens(&self) -> usize {
        self.items
            .iter()
            .map(|item| item.source_tokens.saturating_sub(item.admitted_tokens))
            .sum()
    }

    pub fn total_line(&self) -> String {
        let before = self.source_tokens();
        let saved = self.saved_tokens();
        let share = if before == 0 {
            0.0
        } else {
            saved as f64 * 100.0 / before as f64
        };
        format!("Saved {saved} of {before} tokens ({share:.1}%)")
    }

    pub fn turn_label(&self) -> String {
        self.turn_number.map_or_else(
            || "Turn number unavailable".to_string(),
            |number| format!("Turn {number}"),
        )
    }

    pub fn identifiers(&self) -> String {
        format!(
            "Chat: {} · Turn ID: {} · Attempt: {}",
            self.thread_id, self.turn_id, self.attempt_id
        )
    }

    pub fn heading(&self) -> String {
        format!(
            "{} · {} · {} · {} ({})",
            self.timestamp,
            one_line(&self.chat_title),
            self.turn_label(),
            one_line(&self.model),
            one_line(&self.reasoning_effort)
        )
    }

    pub fn readable(&self) -> String {
        let mut lines = vec![
            format!("## {}", markdown_text(&self.heading())),
            String::new(),
            "| Tool result | Before (tokens) | After (tokens) | Decision |".to_string(),
            "| --- | ---: | ---: | --- |".to_string(),
        ];
        for item in &self.items {
            lines.push(format!(
                "| {} | {} | {} | {} |",
                markdown_text(&item.description),
                item.source_tokens,
                item.admitted_tokens,
                markdown_text(&item.decision)
            ));
        }
        lines.push(String::new());
        if let Some(note) = &self.note {
            lines.push(markdown_text(note));
        }
        lines.push(self.total_line());
        lines.push(String::new());
        for item in &self.items {
            lines.push(format!("### {}", markdown_text(&item.description)));
            lines.push(String::new());
            if let Some(compact) = &item.compact {
                lines.push("Compact output received by the main model:".to_string());
                lines.push(String::new());
                lines.push(fenced_output(compact));
            } else {
                lines.push("The main model received the original output unchanged.".to_string());
            }
            lines.push(String::new());
            lines.push("<details>".to_string());
            lines.push("<summary>Original output (expand to compare)</summary>".to_string());
            lines.push(String::new());
            lines.push(fenced_output(&item.original));
            lines.push(String::new());
            lines.push("</details>".to_string());
            lines.push(String::new());
        }
        let ids = self
            .identifiers()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        lines.push(format!("<small>{ids}</small>"));
        format!("{}\n\n", lines.join("\n"))
    }
}

// A tool result can itself contain Markdown fences and HTML. Keep its exact text
// inside a fence longer than every run of backticks in that result.
fn fenced_output(text: &str) -> String {
    let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!(
        "{fence}text\n{text}{}{fence}",
        if text.ends_with('\n') { "" } else { "\n" }
    )
}

fn examples(lines: &[&str]) -> String {
    // Prefer the repeated content and the final fact over shell wrapper lines.
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    let mut common = None;
    let mut most = 0;
    for &line in lines.iter().filter(|line| !line.trim().is_empty()) {
        let count = counts.entry(line).or_default();
        *count += 1;
        if *count > most {
            most = *count;
            common = Some(line);
        }
    }
    let last = lines
        .iter()
        .rev()
        .copied()
        .find(|line| !line.trim().is_empty() && Some(*line) != common);
    [common, last]
        .into_iter()
        .flatten()
        .map(|line| {
            let brief = one_line(line).chars().take(100).collect::<String>();
            format!(
                "“{brief}{}”",
                if line.chars().count() > 100 {
                    "…"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

// Describe verifiable text changes rather than trusting a model's account of
// what it kept. Count occurrences so collapsing repeated lines is visible too.
fn removal_description(original: &str, compact: &str) -> String {
    let mut remaining = std::collections::HashMap::<&str, usize>::new();
    for line in compact.lines() {
        *remaining.entry(line).or_default() += 1;
    }
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut repeats = 0;
    for line in original.lines() {
        let repeated = !seen.insert(line);
        match remaining.get_mut(line) {
            Some(count) if *count > 0 => {
                *count -= 1;
                kept.push(line);
            }
            _ => {
                removed.push(line);
                repeats += usize::from(repeated);
            }
        }
    }
    let repetition = if repeats > 0 {
        format!(" ({repeats} repeated copies)")
    } else {
        String::new()
    };
    let mut description = format!(
        "compacted: Removed {} source lines{repetition}",
        removed.len()
    );
    if !removed.is_empty() {
        description.push_str(&format!(", including {}", examples(&removed)));
    }
    description.push_str(&format!(". Kept {} source lines verbatim", kept.len()));
    if !kept.is_empty() {
        description.push_str(&format!(", including {}", examples(&kept)));
    }
    description.push_str(". Reworded lines count as removed; compare the compact text below.");
    description
}

fn markdown_text(text: &str) -> String {
    one_line(text)
        .chars()
        .flat_map(|ch| {
            if matches!(
                ch,
                '\\' | '|' | '*' | '_' | '`' | '[' | ']' | '<' | '>' | '#'
            ) {
                vec!['\\', ch]
            } else {
                vec![ch]
            }
        })
        .collect()
}

fn one_line(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}

#[derive(Deserialize)]
struct Attempt {
    attempt_id: String,
    session_id: String,
    #[serde(default)]
    thread_id: Option<String>,
    timestamp: String,
    #[serde(default)]
    chat_title: Option<String>,
    turn_id: String,
    #[serde(default)]
    turn_number: Option<usize>,
    model: String,
    reasoning_effort: String,
    status: AttemptStatus,
    input: String,
    raw_response: Option<String>,
    error: Option<String>,
    admission_id: Option<String>,
}

#[derive(Deserialize)]
struct OptimizerInput {
    items: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    call_id: String,
    source_tokens_estimate: usize,
    invocation: Option<Value>,
    source_output: ResponseItem,
}

#[derive(Deserialize)]
struct Manifest {
    items: Vec<AdmittedItem>,
}

#[derive(Deserialize)]
struct AdmittedItem {
    call_id: String,
    source_tokens: usize,
    admitted_tokens: usize,
    admitted_artifact: String,
}

fn confined_read(root: &Path, relative: &Path) -> Result<Vec<u8>> {
    anyhow::ensure!(
        relative
            .components()
            .all(|c| matches!(c, Component::Normal(_))),
        "invalid audit path"
    );
    let path = root.join(relative).canonicalize()?;
    anyhow::ensure!(
        path.starts_with(root.canonicalize()?),
        "audit path leaves its directory"
    );
    Ok(std::fs::read(path)?)
}

fn tool_description(invocation: Option<&Value>) -> String {
    let Some(invocation) = invocation else {
        return "tool result (call details unavailable)".to_string();
    };
    let name = invocation
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let args = invocation
        .get("arguments")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let what = args
        .as_ref()
        .and_then(|args| {
            ["command", "cmd", "path", "file_path", "query", "url"]
                .iter()
                .find_map(|key| args.get(key).and_then(Value::as_str))
        })
        .map(str::to_string)
        .or_else(|| {
            args.as_ref()
                .and_then(|args| args.get("command").and_then(Value::as_array))
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
        })
        .or_else(|| {
            invocation
                .get("input")
                .and_then(Value::as_str)
                .map(|code| {
                    // Code Mode wraps shell/file calls in JavaScript. Show their literal
                    // arguments without interpreting or executing the wrapper.
                    static ARGUMENTS: std::sync::LazyLock<regex_lite::Regex> = std::sync::LazyLock::new(|| {
                        regex_lite::Regex::new(r#"\b(?:cmd|command|path|file_path)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"#).expect("literal argument pattern")
                    });
                    let arguments = ARGUMENTS.captures_iter(code).map(|capture| {
                        let literal = &capture[1];
                        serde_json::from_str::<String>(literal).unwrap_or_else(|_| literal[1..literal.len()-1].replace("\\'", "'"))
                    }).collect::<Vec<_>>();
                    if arguments.is_empty() { "code execution (see attempt for invocation)".to_string() }
                    else { arguments.join("; ") }
                })
        });
    match what {
        Some(what) => {
            let what = one_line(&what);
            let brief: String = what.chars().take(180).collect();
            format!(
                "{name}: {brief}{}",
                if what.chars().count() > 180 {
                    "…"
                } else {
                    ""
                }
            )
        }
        None => name.to_string(),
    }
}

/// Read one attempt, deriving replacements only from committed admission evidence.
pub fn read_attempt(log_dir: &Path, attempt_id: &str) -> Result<PruneLogRecord> {
    project_attempt(log_dir, read_attempt_data(log_dir, attempt_id)?)
}

fn read_attempt_data(log_dir: &Path, attempt_id: &str) -> Result<Attempt> {
    anyhow::ensure!(
        Path::new(attempt_id).components().count() == 1
            && matches!(
                Path::new(attempt_id).components().next(),
                Some(Component::Normal(_))
            ),
        "invalid attempt id"
    );
    let root = log_dir.join("smart-prune");
    let attempt: Attempt = serde_json::from_slice(&confined_read(
        &root,
        &Path::new("attempts").join(format!("{attempt_id}.json")),
    )?)?;
    anyhow::ensure!(
        attempt.attempt_id == attempt_id,
        "attempt identity mismatch"
    );
    Ok(attempt)
}

fn project_attempt(log_dir: &Path, attempt: Attempt) -> Result<PruneLogRecord> {
    let root = log_dir.join("smart-prune");
    let legacy_identity = attempt.thread_id.is_none();
    let input = serde_json::from_str::<OptimizerInput>(&attempt.input);
    let title = attempt
        .chat_title
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Chat title unavailable".to_string());
    let timestamp = chrono::DateTime::parse_from_rfc3339(&attempt.timestamp)?
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M:%S %:z")
        .to_string();
    let mut record = PruneLogRecord {
        attempt_id: attempt.attempt_id,
        thread_id: attempt.thread_id.unwrap_or(attempt.session_id),
        timestamp,
        chat_title: title,
        turn_id: attempt.turn_id,
        turn_number: attempt.turn_number.filter(|number| *number > 0),
        model: attempt.model,
        reasoning_effort: attempt.reasoning_effort,
        items: Vec::new(),
        note: legacy_identity
            .then(|| "Older audit: may include activity from this chat's agents.".to_string()),
    };
    let failure =
        crate::session::smart_prune::safe_failure_reason(attempt.status, attempt.error.as_deref());
    let input = match input {
        Ok(input) => input,
        Err(_) => {
            record.add_note(match failure {
                Some(why) => format!(
                    "Tool details unavailable in this attempt's evidence. failed: {why} Original kept."
                ),
                None => "Tool details unavailable in this attempt's evidence.".to_string(),
            });
            return Ok(record);
        }
    };
    if input.items.is_empty() {
        if let Some(why) = failure {
            record.add_note(format!("failed: {why} Original kept."));
        }
    }
    record.items = project_items(
        &root,
        input,
        attempt.raw_response.as_deref(),
        attempt.status,
        attempt.error.as_deref(),
        attempt.admission_id.as_deref(),
    )?;
    Ok(record)
}

/// Project a live outcome without requiring a readable attempt record.
/// Committed admission artifacts remain the source of replacement text and counts.
pub(crate) fn inline_items(
    log_dir: &Path,
    input: &str,
    raw_response: Option<&str>,
    status: AttemptStatus,
    error: Option<&str>,
    admission_id: Option<&str>,
) -> Result<Vec<PruneLogItem>> {
    project_items(
        &log_dir.join("smart-prune"),
        serde_json::from_str(input)?,
        raw_response,
        status,
        error,
        admission_id,
    )
}

fn project_items(
    root: &Path,
    input: OptimizerInput,
    raw_response: Option<&str>,
    status: AttemptStatus,
    error: Option<&str>,
    admission_id: Option<&str>,
) -> Result<Vec<PruneLogItem>> {
    let failure = crate::session::smart_prune::safe_failure_reason(status, error);
    let mut items = Vec::new();
    let expected_ids = input
        .items
        .iter()
        .map(|item| item.call_id.as_str())
        .collect::<Vec<_>>();
    let response = raw_response.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let decisions = raw_response.and_then(|raw| parse_decision_manifest(raw, &expected_ids));
    let admission_dir = admission_id
        .filter(|_| matches!(status, AttemptStatus::Admitted))
        .map(|id| Path::new("admissions").join(id));
    let manifest: Option<Manifest> = admission_dir
        .as_ref()
        .map(|dir| -> Result<Manifest> {
            Ok(serde_json::from_slice(&confined_read(
                root,
                &dir.join("manifest.json"),
            )?)?)
        })
        .transpose()?;
    for candidate in input.items {
        let kept = response
            .as_ref()
            .and_then(|response| response.get("items")?.as_array())
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["call_id"].as_str() == Some(candidate.call_id.as_str()))
            })
            .and_then(|item| item["reason"].as_str())
            .filter(|reason| !reason.trim().is_empty())
            .map(one_line);
        let kept_reason = match decisions.as_ref().and_then(|items| {
            items
                .iter()
                .find(|item| item.call_id() == candidate.call_id)
        }) {
            Some(AdmissionDecision::Unchanged { .. }) => kept
                .as_deref()
                .map(|reason| format!("kept: Pruner's reason: {reason}"))
                .unwrap_or_else(|| {
                    "kept: No reason was recorded; the original was retained.".to_string()
                }),
            Some(AdmissionDecision::Compact { .. }) => format!(
                "kept: The replacement saved fewer than {MIN_SAVED_TOKENS} tokens or {MIN_SAVINGS_PERCENT}% after its audit header."
            ),
            None => "kept: No usable replacement was recorded.".to_string(),
        };
        let mut item = PruneLogItem {
            call_id: candidate.call_id.clone(),
            kept,
            description: tool_description(candidate.invocation.as_ref()),
            source_tokens: candidate.source_tokens_estimate,
            admitted_tokens: candidate.source_tokens_estimate,
            decision: failure
                .map(|why| format!("failed: {why} Original kept."))
                .unwrap_or(kept_reason),
            original: textual_tool_output(&candidate.source_output)
                .map(|(_, text)| text.into_owned())
                .unwrap_or_else(|| "Non-text output".to_string()),
            compact: None,
        };
        if failure.is_none() {
            let lines = item.original.lines().collect::<Vec<_>>();
            item.decision.push_str(&format!(
                " Retained all {} source lines, including {}.",
                lines.len(),
                examples(&lines)
            ));
        }
        if let Some(admitted) = manifest
            .as_ref()
            .and_then(|m| m.items.iter().find(|i| i.call_id == candidate.call_id))
        {
            let dir = admission_dir
                .as_ref()
                .context("missing admission directory")?;
            let output: ResponseItem = serde_json::from_slice(&confined_read(
                root,
                &dir.join(&admitted.admitted_artifact),
            )?)?;
            let (_, text) = textual_tool_output(&output).context("non-text admission")?;
            item.source_tokens = admitted.source_tokens;
            item.admitted_tokens = admitted.admitted_tokens;
            item.compact = Some(text.into_owned());
            item.decision =
                removal_description(&item.original, item.compact.as_deref().unwrap_or_default());
        }
        items.push(item);
    }
    Ok(items)
}

/// Existing machine-only attempts remain browsable. Corrupt entries are counted explicitly.
pub fn load_chat(log_dir: &Path, thread_id: &str) -> Result<(Vec<PruneLogRecord>, usize)> {
    let directory = log_dir.join("smart-prune/attempts");
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(error) => return Err(error.into()),
    };
    let mut records = Vec::new();
    let mut unreadable = 0;
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        match read_attempt_data(log_dir, &id) {
            Ok(attempt)
                if attempt.thread_id.as_deref().unwrap_or(&attempt.session_id) == thread_id =>
            {
                match project_attempt(log_dir, attempt) {
                    Ok(record) => records.push(record),
                    Err(_) => unreadable += 1,
                }
            }
            Ok(_) => {}
            Err(_) => unreadable += 1,
        }
    }
    records.sort_by_cached_key(|record| {
        (
            chrono::DateTime::parse_from_str(&record.timestamp, "%Y-%m-%d %H:%M:%S %:z").ok(),
            record.attempt_id.clone(),
        )
    });
    Ok((records, unreadable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path, id: &str, session: &str, status: &str) {
        let attempts = root.join("smart-prune/attempts");
        std::fs::create_dir_all(&attempts).unwrap();
        let input = json!({"active_request":"fallback title", "items":[
            {"call_id":"shell-1", "source_tokens_estimate":1200,
             "invocation":{"name":"shell","arguments":"{\"command\":\"cargo test -p core\"}"},
             "source_output":{"type":"function_call_output","call_id":"shell-1","output":"EXACT ORIGINAL\nwith final fact"}},
            {"call_id":"read-1", "source_tokens_estimate":800,
             "invocation":{"name":"read_file","arguments":"{\"path\":\"src/app.rs\"}"},
             "source_output":{"type":"function_call_output","call_id":"read-1","output":"KEPT ORIGINAL"}}
        ]}).to_string();
        let attempt = json!({"attempt_id":id,"session_id":session,"timestamp":"2026-10-17T12:00:00Z",
            "chat_title":"Prune log fixture", "turn_id":"7", "model":"gpt-6-luna","reasoning_effort":"low",
            "status":status,"input":input,"error":null,"admission_id":"admission-1"});
        std::fs::write(attempts.join(format!("{id}.json")), attempt.to_string()).unwrap();
        let admission = root.join("smart-prune/admissions/admission-1");
        std::fs::create_dir_all(admission.join("items")).unwrap();
        std::fs::write(admission.join("manifest.json"), json!({"items":[{
            "call_id":"shell-1","source_tokens":1200,"admitted_tokens":200,"admitted_artifact":"items/compact.json"
        }]}).to_string()).unwrap();
        std::fs::write(
            admission.join("items/compact.json"),
            json!({"type":"function_call_output",
            "call_id":"shell-1","output":"EXACT COMPACT\nwith final fact"})
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn useful_record_names_the_chat_turn_and_shows_the_actual_comparison() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "useful", "chat-1", "admitted");
        let path = root.path().join("smart-prune/attempts/useful.json");
        let mut attempt: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        attempt["turn_id"] = json!("6f1d2e3a-0000-7000-8000-000000000001");
        attempt["turn_number"] = json!(3);
        let mut input: Value = serde_json::from_str(attempt["input"].as_str().unwrap()).unwrap();
        let kept = "FAIL parser\nFAIL writer\nFAIL reader\n3 failed; 480 passed";
        input["items"][0]["source_output"]["output"] =
            json!(format!("{}{}", "test routine ... ok\n".repeat(480), kept));
        attempt["input"] = json!(input.to_string());
        std::fs::write(path, attempt.to_string()).unwrap();
        let compact_path = root
            .path()
            .join("smart-prune/admissions/admission-1/items/compact.json");
        std::fs::write(
            compact_path,
            json!({"type":"function_call_output", "call_id":"shell-1", "output":kept}).to_string(),
        )
        .unwrap();
        let record = read_attempt(root.path(), "useful").unwrap();
        let md = record.readable();
        let heading = md.lines().next().unwrap();
        assert!(heading.contains("Turn 3"), "{heading}");
        assert!(heading.contains("Prune log fixture"));
        assert!(!heading.contains(&record.turn_id));
        assert!(record.items[0].decision.contains("480 source lines"));
        assert!(record.items[0].decision.contains("479 repeated"));
        assert!(record.items[0].decision.contains("test routine ... ok"));
        assert!(record.items[0].decision.contains("4 source lines verbatim"));
        assert!(record.items[0].decision.contains("FAIL parser"));
        assert!(md.contains("Compact output received by the main model"));
        assert!(md.contains(&format!("```text\n{kept}\n```")));
        assert!(md.contains("<details>\n<summary>Original output"));
        assert!(md.contains("test routine ... ok\ntest routine ... ok"));
        assert!(md.contains("</details>"));
        assert!(
            md.lines()
                .rev()
                .find(|line| !line.is_empty())
                .unwrap()
                .contains(&record.turn_id)
        );
    }

    #[test]
    fn output_cannot_close_its_code_fence_or_original_disclosure() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "fences", "chat-1", "admitted");
        let mut record = read_attempt(root.path(), "fences").unwrap();
        record.items[0].original = "```\n</details>\n<script>bad()</script>".to_string();
        record.items[0].compact = Some("```\n# output, not a heading".to_string());
        let md = record.readable();
        assert!(md.contains("````text\n```\n# output, not a heading\n````"));
        assert!(md.contains("````text\n```\n</details>\n<script>bad()</script>\n````"));
        assert_eq!(md.matches("<summary>Original output").count(), 2);
    }

    #[test]
    fn legacy_turn_ids_are_never_presented_as_chat_numbers() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "legacy", "chat-1", "unchanged");
        let record = read_attempt(root.path(), "legacy").unwrap();
        assert!(record.heading().contains("Turn number unavailable"));
        assert!(record.identifiers().contains("Turn ID: 7"));
    }

    #[test]
    fn comparison_counts_repetition_without_claiming_semantic_preservation() {
        let description =
            removal_description("repeat\nrepeat\nimportant fact", "repeat\nreworded fact");
        assert!(description.contains("Removed 2 source lines"));
        assert!(description.contains("important fact"));
        assert!(description.contains("Kept 1 source lines verbatim"));
        assert!(description.contains("Reworded lines count as removed"));
        assert!(
            removal_description("repeat\nrepeat\nrepeat", "repeat").contains("2 repeated copies")
        );
    }

    #[test]
    fn examples_show_repeated_content_and_the_final_fact_instead_of_shell_wrappers() {
        let original = format!(
            "Script completed\nWall time 0.1 seconds\nOutput:\n\n{}3 failed; 480 passed",
            "test routine ... ok\n".repeat(480)
        );
        let description = removal_description(&original, "Three tests failed.");
        assert!(description.contains("including “test routine ... ok”; “3 failed; 480 passed”"));
        assert!(!description.contains("including “Script completed”"));
    }

    #[test]
    fn kept_result_reports_the_recorded_content_specific_reason() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "reason", "chat-1", "unchanged");
        let path = root.path().join("smart-prune/attempts/reason.json");
        let mut attempt: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let reason =
            "This is the only exact entry point; changing it would hide the call to run_app.";
        attempt["raw_response"] = json!(json!({"items":[
            {"call_id":"shell-1","decision":"unchanged","content":null,"reason":"The complete failure text must remain exact."},
            {"call_id":"read-1","decision":"unchanged","content":null,"reason":reason}
        ]}).to_string());
        std::fs::write(path, attempt.to_string()).unwrap();
        let record = read_attempt(root.path(), "reason").unwrap();
        assert!(
            record.items[1].decision.contains(reason),
            "{}",
            record.items[1].decision
        );
        assert!(record.items[1].decision.contains("Pruner's reason:"));
        assert!(record.items[1].compact.is_none());
        assert_eq!(record.saved_tokens(), 0);
    }

    #[test]
    fn unchanged_response_schema_requests_a_content_specific_reason() {
        let schema = crate::smart_prune::decision_manifest_schema();
        let compact = &schema["properties"]["items"]["items"]["anyOf"][0];
        assert!(
            compact["required"]
                .as_array()
                .unwrap()
                .contains(&json!("reason"))
        );
        let unchanged = &schema["properties"]["items"]["items"]["anyOf"][1];
        assert!(
            unchanged["required"]
                .as_array()
                .unwrap()
                .contains(&json!("reason"))
        );
        assert_eq!(unchanged["properties"]["reason"]["type"], "string");
    }

    #[test]
    fn mixed_attempt_uses_admitted_numbers_and_preserves_both_outputs() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "one", "chat-1", "admitted");
        let record = read_attempt(root.path(), "one").unwrap();
        assert_eq!(record.chat_title, "Prune log fixture");
        assert_eq!(record.source_tokens(), 2000);
        assert_eq!(record.saved_tokens(), 1000);
        assert_eq!(record.total_line(), "Saved 1000 of 2000 tokens (50.0%)");
        assert_eq!(record.items[0].description, "shell: cargo test -p core");
        assert_eq!(record.items[1].description, "read_file: src/app.rs");
        assert_eq!(record.items[0].original, "EXACT ORIGINAL\nwith final fact");
        assert_eq!(
            record.items[0].compact.as_deref(),
            Some("EXACT COMPACT\nwith final fact")
        );
        assert!(record.items[1].compact.is_none());
        assert!(record.readable().contains("| 800 | 800 | kept:"));
        assert!(record.readable().contains("| 1200 | 200 | compacted:"));
        let mut escaped = record;
        escaped.chat_title = "Prune | <script>".to_string();
        escaped.items[0].description = "shell: x | cat".to_string();
        assert!(escaped.readable().contains(r"Prune \| \<script\>"));
        assert!(escaped.readable().contains(r"| shell: x \| cat |"));
    }

    #[test]
    fn unreadable_input_keeps_the_failure_and_legacy_attribution() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "one", "chat-1", "timed_out");
        let path = root.path().join("smart-prune/attempts/one.json");
        let mut attempt: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        attempt["input"] = json!("unreadable input");
        std::fs::write(path, attempt.to_string()).unwrap();
        let record = read_attempt(root.path(), "one").unwrap();
        let note = record.note.as_deref().unwrap();
        assert!(note.contains("Tool details unavailable"));
        assert!(note.contains("failed: The pruning model stopped responding"));
        assert!(note.contains("may include activity from this chat's agents"));
        assert!(record.items.is_empty());
        assert_eq!(record.saved_tokens(), 0);
    }

    #[test]
    fn kept_explanations_distinguish_the_model_choice_from_rejected_savings() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "one", "chat-1", "unchanged");
        let path = root.path().join("smart-prune/attempts/one.json");
        let mut attempt: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        attempt["raw_response"] = json!(json!({"items":[
            {"call_id":"shell-1","decision":"compact","content":"oversized replacement ".repeat(1000)},
            {"call_id":"read-1","decision":"unchanged","content":null}
        ]}).to_string());
        std::fs::write(path, attempt.to_string()).unwrap();
        let record = read_attempt(root.path(), "one").unwrap();
        assert_eq!(
            record.items[0].decision,
            "kept: The replacement saved fewer than 256 tokens or 20% after its audit header. Retained all 2 source lines, including “EXACT ORIGINAL”; “with final fact”."
        );
        assert_eq!(
            record.items[1].decision,
            "kept: No reason was recorded; the original was retained. Retained all 1 source lines, including “KEPT ORIGINAL”."
        );
        assert_eq!(record.saved_tokens(), 0);
    }

    #[test]
    fn code_mode_descriptions_show_commands_instead_of_javascript() {
        let call = json!({"name":"exec", "input": "const r = await tools.exec_command({cmd:\"cargo test -p core\"}); text(r.output)"});
        assert_eq!(tool_description(Some(&call)), "exec: cargo test -p core");
        let call =
            json!({"name":"exec", "input": "text(await tools.read_file({path:'src/app.rs'}))"});
        assert_eq!(tool_description(Some(&call)), "exec: src/app.rs");
        let call =
            json!({"name":"exec", "input":"await tools.exec_command({\"cmd\":\"cat داده.txt\"})"});
        assert_eq!(tool_description(Some(&call)), "exec: cat داده.txt");
        let call = json!({"name":"exec", "input": "await someDynamicCall()"});
        assert_eq!(
            tool_description(Some(&call)),
            "exec: code execution (see attempt for invocation)"
        );
    }

    #[test]
    fn cancellation_does_not_claim_or_show_an_uncommitted_replacement() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "cancelled", "chat-1", "cancelled");
        let record = read_attempt(root.path(), "cancelled").unwrap();
        assert_eq!(record.saved_tokens(), 0);
        assert!(record.items.iter().all(|i| i.compact.is_none()));
        assert!(record.readable().contains("failed: Pruning was cancelled"));
    }

    #[test]
    fn chat_list_filters_sorts_and_reports_corruption() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), "two", "chat-1", "admitted");
        fixture(root.path(), "one", "chat-1", "unchanged");
        fixture(root.path(), "other", "chat-2", "unchanged");
        let other = root.path().join("smart-prune/attempts/other.json");
        let mut child: Value = serde_json::from_slice(&std::fs::read(&other).unwrap()).unwrap();
        child["session_id"] = json!("chat-1");
        child["thread_id"] = json!("child-chat");
        std::fs::write(other, child.to_string()).unwrap();
        std::fs::write(root.path().join("smart-prune/attempts/broken.json"), "{").unwrap();
        let (records, unreadable) = load_chat(root.path(), "chat-1").unwrap();
        assert_eq!(
            records
                .iter()
                .map(|r| r.attempt_id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(unreadable, 1);
        assert!(load_chat(root.path(), "chat-3").unwrap().0.is_empty());
        assert_eq!(
            load_chat(root.path(), "child-chat").unwrap().0[0].attempt_id,
            "other"
        );
        assert!(read_attempt(root.path(), "../escape").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reader_rejects_admission_artifact_symlinks_outside_the_audit() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(root.path(), "one", "chat-1", "admitted");
        let path = root
            .path()
            .join("smart-prune/admissions/admission-1/items/compact.json");
        std::fs::rename(&path, outside.path().join("compact.json")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("compact.json"), &path).unwrap();
        assert!(read_attempt(root.path(), "one").is_err());
    }
}

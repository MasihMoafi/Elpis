//! Projects an Elpis rollout (JSONL) into the Trajectory page's document
//! (`docs/specs/trajectory-contract.ts`, version 1).
//!
//! Everything shown is recorded: times come from rollout timestamps and item timing, tokens from
//! the provider's usage records. A value the rollout does not hold stays `None`.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// The page's JSON document.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryDocument {
    pub version: u32,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    pub turns: Vec<TrajectoryTurn>,
    pub request_numbers: Vec<RequestNumber>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct TrajectoryTurn {
    pub turn: Option<u32>,
    pub groups: Vec<TrajectoryGroup>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct TrajectoryGroup {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub cells: Vec<TrajectoryCell>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMetrics {
    pub timing_recorded: bool,
    pub step_start_time: Option<i64>,
    pub first_token_time: Option<i64>,
    pub completed_time: Option<i64>,
    pub usage_provided: bool,
    pub output_tokens: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryCell {
    pub index: u32,
    pub kind: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opens_turn: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_seq: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_metrics: Option<AssistantMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    pub time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub think: Option<i64>,
}

/// Disjoint token buckets: uncached input, cache read, cache write, output, reasoning.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Usage {
    pub input: i64,
    #[serde(rename = "cacheRead")]
    pub cache_read: i64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: i64,
    pub output: i64,
    pub reasoning: i64,
}

impl Usage {
    /// Elpis records `input_tokens` including cached and cache-written input (OpenAI style; the
    /// Claude gateway adds both back in). The buckets here are disjoint, so nothing is counted twice.
    fn from_engine(value: &Value) -> Option<Self> {
        let number = |key: &str| value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0);
        value.get("input_tokens")?;
        let cache_read = number("cached_input_tokens");
        let cache_write = number("cache_write_input_tokens");
        Some(Self {
            input: (number("input_tokens") - cache_read - cache_write).max(0),
            cache_read,
            cache_write,
            output: number("output_tokens"),
            reasoning: number("reasoning_output_tokens"),
        })
    }

    fn add(&mut self, other: &Self) {
        self.input += other.input;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }

    /// Prompt tokens served from the provider cache, as a whole percentage of the prompt.
    pub fn cache_hit_percent(&self) -> Option<i64> {
        let prompt = self.input + self.cache_read + self.cache_write;
        (prompt > 0).then(|| ((self.cache_read as f64) * 100.0 / (prompt as f64)).round() as i64)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CacheVerdict {
    #[serde(rename = "hitPercent")]
    pub hit_percent: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestNumber {
    pub group: String,
    pub number: u32,
    pub purpose: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<usize>,
    pub turn: Option<u32>,
    pub step: u32,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative_usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheVerdict>,
}

/// A hit rate this many points below the previous request's counts as a cache break.
const CACHE_DROP_POINTS: i64 = 20;
/// An idle gap this long before a broken request is reported with it.
const IDLE_REPORT_MS: i64 = 5 * 60 * 1000;
const SUMMARY_CHARS: usize = 160;
const PRUNE_PREFIX: &str = "elpis.context-prune.v1:";

/// Where a placed tool cell lives, so its later output can fill it in.
type CellAt = (usize, usize, usize);

#[derive(Default)]
struct Builder {
    doc: TrajectoryDocument,
    turn_number: u32,
    step: u32,
    request_count: u32,
    model: Option<String>,
    system_prompt: Option<(usize, String)>,
    turn_started_ms: Option<i64>,
    turn_ttft_ms: Option<i64>,
    step_started_ms: Option<i64>,
    pending_text: Vec<String>,
    pending_reasoning: Vec<String>,
    pending_tools: Vec<TrajectoryCell>,
    pending_seq: Option<usize>,
    placed_calls: HashMap<String, CellAt>,
    pending_calls: HashMap<String, usize>,
    cumulative: Usage,
    previous_hit: Option<i64>,
    previous_request_end_ms: Option<i64>,
    changes: Vec<String>,
    world_state_seen: bool,
    uses_usage_records: bool,
}

/// Projects rollout text. A line that is not JSON ends the projection there, marked truncated.
pub fn project(text: &str) -> TrajectoryDocument {
    let mut builder = Builder {
        doc: TrajectoryDocument {
            version: 1,
            ..Default::default()
        },
        uses_usage_records: text.contains("\"type\":\"token_usage_record\""),
        ..Default::default()
    };
    for (seq, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            builder.doc.truncated = true;
            break;
        };
        builder.line(seq, &row);
    }
    builder.finish()
}

fn timestamp_ms(row: &Value) -> Option<i64> {
    let text = row.get("timestamp")?.as_str()?;
    parse_rfc3339_ms(text)
}

/// `2026-11-04T03:52:11.437Z` → Unix milliseconds. Only the UTC `Z` form the engine writes.
fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock = clock.split(':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
    let millis = format!("{fraction:0<3}")[..3].parse::<i64>().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

fn summary(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() > SUMMARY_CHARS {
        let cut: String = line.chars().take(SUMMARY_CHARS).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

fn message_text(payload: &Value) -> String {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Text the engine adds to a user-role message that the user did not type.
fn is_injected_context(text: &str) -> bool {
    let text = text.trim_start();
    [
        "<environment_context>",
        "<user_instructions>",
        "# AGENTS.md instructions",
        "## Elpis Admitted Context",
        "<turn_aborted>",
        "<user_shell_command>",
        "<permissions instructions>",
        "<skill>",
    ]
    .iter()
    .any(|marker| text.starts_with(marker))
}

fn group_millis(milliseconds: i64) -> String {
    let digits = milliseconds.max(0).to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{grouped} ms")
}

impl Builder {
    fn current_turn(&mut self) -> &mut TrajectoryTurn {
        if !matches!(self.doc.turns.last(), Some(turn) if turn.turn.is_some()) {
            self.turn_number += 1;
            self.doc.turns.push(TrajectoryTurn {
                turn: Some(self.turn_number),
                groups: Vec::new(),
            });
        }
        self.doc.turns.last_mut().expect("a turn was just ensured")
    }

    fn message_group(&mut self) -> &mut TrajectoryGroup {
        let turn = self.current_turn();
        if !matches!(turn.groups.last(), Some(group) if group.title == "Message") {
            turn.groups.push(TrajectoryGroup {
                title: "Message".to_string(),
                ..Default::default()
            });
        }
        turn.groups.last_mut().expect("a group was just ensured")
    }

    fn line(&mut self, seq: usize, row: &Value) {
        let at = timestamp_ms(row);
        let payload = row.get("payload").cloned().unwrap_or(Value::Null);
        match row.get("type").and_then(Value::as_str).unwrap_or_default() {
            "session_meta" => {
                let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_string);
                self.doc.thread_id = text("id").unwrap_or_default();
                self.doc.cwd = text("cwd");
                self.doc.provider = text("model_provider");
                if let Some(prompt) = payload
                    .pointer("/base_instructions/text")
                    .and_then(Value::as_str)
                {
                    self.system_prompt = Some((seq, prompt.to_string()));
                }
            }
            "turn_context" => {
                let model = payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let (Some(before), Some(after)) = (&self.model, &model)
                    && before != after
                {
                    self.changes
                        .push(format!("model change: {before} → {after}"));
                }
                if model.is_some() {
                    self.model.clone_from(&model);
                    self.doc.model = model;
                }
            }
            "world_state" => {
                // A full record restates everything (thread start, resume, compaction); a patch
                // (`full: false`) names only the sections that changed.
                let full = payload.get("full").and_then(Value::as_bool).unwrap_or(true);
                if self.world_state_seen && !full {
                    let changed = payload
                        .get("state")
                        .and_then(Value::as_object)
                        .map(|state| state.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    for section in changed {
                        let change = match section.as_str() {
                            "agents_md" => "AGENTS.md changed".to_string(),
                            "elpis_continuity" => "admitted context changed".to_string(),
                            "collaboration_mode" => "collaboration mode changed".to_string(),
                            other => format!("{other} changed"),
                        };
                        if !self.changes.contains(&change) {
                            self.changes.push(change);
                        }
                    }
                }
                self.world_state_seen = true;
            }
            "compacted" => self.compaction(seq, &payload, at),
            "response_item" => self.response_item(seq, &payload, at),
            "token_usage_record" if self.uses_usage_records => {
                if let Some(usage) = payload.get("usage").and_then(Usage::from_engine) {
                    self.request_end(seq, usage, at);
                }
            }
            "event_msg" => self.event(seq, &payload, at),
            _ => {}
        }
    }

    fn event(&mut self, seq: usize, payload: &Value, at: Option<i64>) {
        match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "task_started" => {
                self.flush_unrequested(at);
                self.turn_number += 1;
                self.doc.turns.push(TrajectoryTurn {
                    turn: Some(self.turn_number),
                    groups: Vec::new(),
                });
                self.step = 0;
                let started = payload
                    .get("started_at")
                    .and_then(Value::as_i64)
                    .map(|seconds| seconds * 1000)
                    .or(at);
                self.turn_started_ms = started;
                self.step_started_ms = started;
                self.turn_ttft_ms = None;
                if let Some(window) = payload.get("model_context_window").and_then(Value::as_i64) {
                    self.doc.context_window = Some(window);
                }
                if self.turn_number == 1
                    && let Some((prompt_seq, prompt)) = self.system_prompt.take()
                {
                    self.message_group().cells.push(TrajectoryCell {
                        kind: "system",
                        text: summary(&prompt),
                        source_seq: Some(prompt_seq),
                        system_prompt_detail: Some(prompt),
                        ..Default::default()
                    });
                }
            }
            "task_complete" | "turn_aborted" => {
                if let Some(ttft) = payload
                    .get("time_to_first_token_ms")
                    .and_then(Value::as_i64)
                {
                    self.turn_ttft_ms = Some(ttft);
                    self.backfill_first_token();
                }
                if payload.get("type").and_then(Value::as_str) == Some("turn_aborted") {
                    self.flush_unrequested(at);
                }
            }
            "token_count" if !self.uses_usage_records => {
                if let Some(usage) = payload
                    .pointer("/info/last_token_usage")
                    .and_then(Usage::from_engine)
                {
                    self.request_end(seq, usage, at);
                }
            }
            "item_completed" => {
                let id = payload.pointer("/item/id").and_then(Value::as_str);
                let started = payload.get("started_at_ms").and_then(Value::as_i64);
                let completed = payload.get("completed_at_ms").and_then(Value::as_i64);
                if let (Some(id), Some(started), Some(completed)) = (id, started, completed)
                    && let Some(cell) = self.call_cell(id)
                {
                    cell.started_at = Some(started);
                    cell.time_seconds = Some((completed - started).max(0) as f64 / 1000.0);
                }
            }
            _ => {}
        }
    }

    /// The first request of a turn takes the turn's recorded time to first token.
    fn backfill_first_token(&mut self) {
        let (Some(start), Some(ttft)) = (self.turn_started_ms, self.turn_ttft_ms) else {
            return;
        };
        let turn_number = self.turn_number;
        if let Some(turn) = self
            .doc
            .turns
            .iter_mut()
            .rev()
            .find(|turn| turn.turn == Some(turn_number))
            && let Some(cell) = turn
                .groups
                .iter_mut()
                .find(|group| group.title == "Step 1")
                .and_then(|group| group.cells.first_mut())
            && let Some(metrics) = cell.assistant_metrics.as_mut()
        {
            metrics.first_token_time = Some(start + ttft);
        }
    }

    fn call_cell(&mut self, call_id: &str) -> Option<&mut TrajectoryCell> {
        if let Some(&(turn, group, cell)) = self.placed_calls.get(call_id) {
            return self
                .doc
                .turns
                .get_mut(turn)?
                .groups
                .get_mut(group)?
                .cells
                .get_mut(cell);
        }
        let index = *self.pending_calls.get(call_id)?;
        self.pending_tools.get_mut(index)
    }

    fn response_item(&mut self, seq: usize, payload: &Value, at: Option<i64>) {
        let kind = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "message" => {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let text = message_text(payload);
                match role {
                    "assistant" => {
                        self.pending_seq.get_or_insert(seq);
                        self.pending_text.push(text);
                    }
                    "user" | "developer" | "system" => {
                        let injected = role != "user" || is_injected_context(&text);
                        let opens_turn = !injected
                            && !self
                                .message_group()
                                .cells
                                .iter()
                                .any(|cell| cell.kind == "user");
                        if !injected && let Some(at) = at {
                            self.step_started_ms.get_or_insert(at);
                        }
                        self.message_group().cells.push(TrajectoryCell {
                            kind: if injected { "context" } else { "user" },
                            text: summary(&text),
                            opens_turn: opens_turn.then_some(true),
                            source_seq: Some(seq),
                            input_detail: Some(text),
                            started_at: at,
                            ..Default::default()
                        });
                    }
                    _ => {}
                }
            }
            "reasoning" => {
                self.pending_seq.get_or_insert(seq);
                let text = payload
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    self.pending_reasoning.push(text);
                }
            }
            "function_call"
            | "custom_tool_call"
            | "local_shell_call"
            | "web_search_call"
            | "tool_search_call"
            | "image_generation_call" => {
                self.pending_seq.get_or_insert(seq);
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(match kind {
                        "local_shell_call" => "shell",
                        "web_search_call" => "web_search",
                        "tool_search_call" => "tool_search",
                        "image_generation_call" => "image_generation",
                        _ => "tool",
                    })
                    .to_string();
                let input = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .or_else(|| payload.get("action"))
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(call_id) = &call_id {
                    self.pending_calls
                        .insert(call_id.clone(), self.pending_tools.len());
                }
                self.pending_tools.push(TrajectoryCell {
                    kind: "tool",
                    text: format!("{name} {}", summary(&input)).trim_end().to_string(),
                    source_seq: Some(seq),
                    input_detail: Some(input),
                    call_id,
                    tool_name: Some(name),
                    started_at: at,
                    ..Default::default()
                });
            }
            "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
                let output = match payload.get("output").or_else(|| payload.get("tools")) {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Object(object)) => object
                        .get("body")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| Value::Object(object.clone()).to_string()),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                let is_error = output_failed(&output);
                if let Some(call_id) = payload.get("call_id").and_then(Value::as_str)
                    && let Some(cell) = self.call_cell(call_id)
                {
                    if cell.time_seconds.is_none()
                        && let (Some(start), Some(end)) = (cell.started_at, at)
                    {
                        cell.time_seconds = Some((end - start).max(0) as f64 / 1000.0);
                    }
                    cell.result = Some(summary(&output));
                    cell.output_detail = Some(output);
                    cell.is_error = is_error.then_some(true);
                }
                if let Some(at) = at {
                    self.step_started_ms = Some(at);
                }
            }
            _ => {}
        }
    }

    /// One model request finished: its assistant record opens the next Step group, followed by
    /// the tool calls it made.
    fn request_end(&mut self, seq: usize, usage: Usage, at: Option<i64>) {
        self.step += 1;
        self.request_count += 1;
        let step = self.step;
        let title = format!("Step {step}");
        let started = self.step_started_ms;
        let text = self.pending_text.join("\n\n");
        let calls = self.pending_tools.len();
        let row_text = if !text.trim().is_empty() {
            summary(&text)
        } else if calls > 0 {
            format!("{calls} tool call{}", if calls == 1 { "" } else { "s" })
        } else {
            "(no visible output)".to_string()
        };
        let first_token = (step == 1)
            .then(|| self.turn_started_ms.zip(self.turn_ttft_ms))
            .flatten()
            .map(|(start, ttft)| start + ttft);
        let assistant = TrajectoryCell {
            kind: "message",
            text: row_text,
            source_seq: self.pending_seq.take().or(Some(seq)),
            output_detail: (!text.is_empty()).then_some(text),
            thinking_detail: (!self.pending_reasoning.is_empty())
                .then(|| self.pending_reasoning.join("\n\n")),
            assistant_metrics: Some(AssistantMetrics {
                timing_recorded: started.is_some() && at.is_some(),
                step_start_time: started,
                first_token_time: first_token,
                completed_time: at,
                usage_provided: true,
                output_tokens: Some(usage.output),
            }),
            time_seconds: started
                .zip(at)
                .map(|(start, end)| (end - start).max(0) as f64 / 1000.0),
            started_at: started,
            input: Some(usage.input),
            cache_read: Some(usage.cache_read),
            cache_write: Some(usage.cache_write),
            output: Some(usage.output),
            think: Some(usage.reasoning),
            ..Default::default()
        };
        self.pending_text.clear();
        self.pending_reasoning.clear();
        let tools = std::mem::take(&mut self.pending_tools);
        self.pending_calls.clear();
        let turn_index = {
            self.current_turn();
            self.doc.turns.len() - 1
        };
        let turn = &mut self.doc.turns[turn_index];
        let group_index = turn.groups.len();
        let mut cells = vec![assistant];
        for (offset, tool) in tools.into_iter().enumerate() {
            if let Some(call_id) = &tool.call_id {
                self.placed_calls
                    .insert(call_id.clone(), (turn_index, group_index, offset + 1));
            }
            cells.push(tool);
        }
        turn.groups.push(TrajectoryGroup {
            title: title.clone(),
            description: None,
            cells,
        });

        self.cumulative.add(&usage);
        let hit = usage.cache_hit_percent();
        let broke = matches!((self.previous_hit, hit), (Some(before), Some(now)) if now + CACHE_DROP_POINTS < before);
        let cause = broke.then(|| {
            let mut causes = std::mem::take(&mut self.changes);
            if let (Some(previous), Some(start)) = (self.previous_request_end_ms, started) {
                let idle = start - previous;
                if idle >= IDLE_REPORT_MS {
                    causes.push(format!(
                        "idle {} min since the previous request",
                        idle / 60_000
                    ));
                }
            }
            if causes.is_empty() {
                "cause not recorded".to_string()
            } else {
                causes.join("; ")
            }
        });
        self.changes.clear();
        self.doc.request_numbers.push(RequestNumber {
            group: title,
            number: self.request_count,
            purpose: "assistant",
            seq: Some(seq),
            turn: Some(self.turn_number),
            step,
            status: "complete",
            started_at: started,
            completed_at: at,
            provider: self.doc.provider.clone(),
            model: self.model.clone(),
            usage: Some(usage),
            cumulative_usage: Some(self.cumulative),
            cache: hit.map(|hit_percent| CacheVerdict { hit_percent, cause }),
        });
        if hit.is_some() {
            self.previous_hit = hit;
        }
        self.previous_request_end_ms = at.or(self.previous_request_end_ms);
        self.step_started_ms = at;
    }

    /// Output that streamed without a usage record (an interrupted or still-running request).
    fn flush_unrequested(&mut self, at: Option<i64>) {
        if self.pending_text.is_empty()
            && self.pending_tools.is_empty()
            && self.pending_reasoning.is_empty()
        {
            return;
        }
        self.step += 1;
        self.request_count += 1;
        let title = format!("Step {}", self.step);
        let text = self.pending_text.join("\n\n");
        let mut cells = vec![TrajectoryCell {
            kind: "message",
            text: if text.trim().is_empty() {
                "(interrupted)".to_string()
            } else {
                summary(&text)
            },
            source_seq: self.pending_seq.take(),
            output_detail: (!text.is_empty()).then_some(text),
            is_error: Some(true),
            started_at: self.step_started_ms,
            time_seconds: None,
            ..Default::default()
        }];
        cells.extend(std::mem::take(&mut self.pending_tools));
        self.pending_text.clear();
        self.pending_reasoning.clear();
        self.pending_calls.clear();
        let turn = self.current_turn();
        turn.groups.push(TrajectoryGroup {
            title: title.clone(),
            description: None,
            cells,
        });
        self.doc.request_numbers.push(RequestNumber {
            group: title,
            number: self.request_count,
            purpose: "assistant",
            turn: Some(self.turn_number),
            step: self.step,
            status: if at.is_some() { "error" } else { "running" },
            started_at: self.step_started_ms,
            completed_at: None,
            provider: self.doc.provider.clone(),
            model: self.model.clone(),
            ..Default::default()
        });
    }

    fn compaction(&mut self, seq: usize, payload: &Value, at: Option<i64>) {
        self.flush_unrequested(at);
        let summary_text = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // Smart Prune writes its checkpoints as `compacted` items with this prefix
        // (docs/evals/dashboard/README.md); they are not compactions.
        let prune = summary_text.starts_with(PRUNE_PREFIX);
        let summary_text = summary_text
            .strip_prefix(PRUNE_PREFIX)
            .map(|rest| rest.trim_start().to_string())
            .unwrap_or(summary_text);
        self.doc.turns.push(TrajectoryTurn {
            turn: None,
            groups: vec![TrajectoryGroup {
                title: if prune {
                    format!("Smart Prune {seq}")
                } else {
                    format!("Compaction {seq}")
                },
                description: None,
                cells: vec![TrajectoryCell {
                    kind: "compacted",
                    text: if prune {
                        "Smart Prune checkpoint".to_string()
                    } else if summary_text.is_empty() {
                        "History compacted".to_string()
                    } else {
                        summary(&summary_text)
                    },
                    source_seq: Some(seq),
                    output_detail: (!summary_text.is_empty()).then_some(summary_text),
                    started_at: at,
                    ..Default::default()
                }],
            }],
        });
        self.changes
            .push(if prune { "Smart Prune" } else { "compaction" }.to_string());
    }

    fn finish(mut self) -> TrajectoryDocument {
        self.flush_unrequested(None);
        let mut index = 0;
        for turn in &mut self.doc.turns {
            for group in &mut turn.groups {
                let mut first = None::<i64>;
                let mut last = None::<i64>;
                for cell in &mut group.cells {
                    index += 1;
                    cell.index = index;
                    if let Some(start) = cell.started_at {
                        first = Some(first.map_or(start, |first: i64| first.min(start)));
                        let end = start + (cell.time_seconds.unwrap_or(0.0) * 1000.0) as i64;
                        last = Some(last.map_or(end, |last: i64| last.max(end)));
                    }
                }
                if group.title != "Message"
                    && let (Some(first), Some(last)) = (first, last)
                {
                    group.description = Some(group_millis(last - first));
                }
            }
        }
        self.doc
    }
}

/// A tool result that reports failure in the forms the engine writes.
fn output_failed(output: &str) -> bool {
    let start = output.trim_start();
    if start.starts_with("Error") || start.starts_with("error:") {
        return true;
    }
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(start) {
        if object.get("success").and_then(Value::as_bool) == Some(false) {
            return true;
        }
        if let Some(code) = object
            .get("metadata")
            .and_then(|metadata| metadata.get("exit_code"))
            .or_else(|| object.get("exit_code"))
            .and_then(Value::as_i64)
        {
            return code != 0;
        }
    }
    start
        .lines()
        .find_map(|line| line.strip_prefix("Exit code: "))
        .and_then(|code| code.trim().parse::<i64>().ok())
        .is_some_and(|code| code != 0)
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

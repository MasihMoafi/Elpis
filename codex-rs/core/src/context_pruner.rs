//! Layers 3 and 4 of Elpis's context pruning (see `docs/context.md`). The Ace pass handles
//! content that requires judgment — deciding
//! whether a search was a dead end (delete outright, no trace) or found something
//! that matters (keep one evidence-pointer line). That judgment comes from a model
//! call. It is deliberately selective distillation rather than a summary of every
//! action: useful evidence earns one compact conclusion, while dead ends leave no
//! model-visible trace.
//!
//! Two triggers drive the same pass, and both are needed. The steady trigger fires
//! whenever completed turns hold at least 5% of the context window in uncovered tool
//! output, and takes that whole backlog: this is what keeps a long session from
//! filling up in the first place. The pressure trigger fires once active use reaches
//! 30% and takes only the oldest output needed to get back to 20%, preserving a recent
//! verbatim suffix. Steady alone cannot catch a single turn that balloons past the
//! boundary; pressure alone lets a session climb to 30% before anything is reclaimed,
//! which is the state the steady pass exists to prevent.
//!
//! A pressure crossing is budgeted, not open-ended: `PressureEpisode` permits at most
//! `MAX_PRESSURE_PRUNE_PASSES_PER_EPISODE` Ace passes per crossing. A single pass is
//! capped at `MAX_PRUNE_BATCH_TOKENS`, which on a large window can be smaller than the
//! distance from 30% down to 20% — so without a budget, a session whose backlog grows
//! faster than one pass reclaims would spend an unbounded number of small passes
//! nibbling at the boundary instead of ever handing off. Once the budget is spent the
//! session defers to the existing compaction/rollover mechanism instead. The episode
//! re-arms (its budget resets) the next time active use is observed back under the
//! pressure boundary, so the next crossing gets its own fresh budget.
//!
//! The steady trigger never touches the turn in flight. The pressure trigger has to:
//! a single tool-driven turn can cross the boundary without ever ending, and cutting
//! at the latest user message would leave nothing eligible exactly then — so it cuts
//! by recency instead, keeping the newest 10% of the window verbatim. On any failure (model error,
//! timeout, unparseable output) the batch is left alone and can retry after the
//! backoff in `retry_delay_after_failures` elapses — an untouched batch is otherwise
//! re-selected identically on the next turn, so without the backoff one unluckily
//! shaped batch retries forever and pruning never advances.

use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_utils_output_truncation::approx_token_count;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

pub(crate) const AUTO_PRUNE_TRIGGER_PERCENT: i64 = 30;
/// Where a pressure pass stops reclaiming. The pass buys headroom, it does not empty
/// the window — but it has to buy enough of it. A single pass runs between sampling
/// steps, and a working turn adds several thousand tokens per step, so a target set
/// just under the 30% trigger is spent again almost immediately and the session saws
/// back across the boundary. Reclaiming to 20% leaves a margin that survives a few
/// steps, which is what keeps use near the trigger instead of well past it.
pub(crate) const AUTO_PRUNE_TARGET_PERCENT: i64 = 20;

/// How much of the newest tool evidence a pressure pass always leaves verbatim, as a
/// percentage of the context window. Unlike the steady pass, a pressure pass reaches
/// into the turn that is still running, so it needs its own floor: the observations the
/// next follow-up reasons over sit at the end of the history, and only what is behind
/// them may be rewritten.
pub(crate) const PRESSURE_KEEP_RECENT_PERCENT: i64 = 10;

/// Floor for the steady pass, as a percentage of the context window. Low enough that
/// routine exploration is distilled well before it can contribute to pressure, high
/// enough that a couple of small reads do not buy a model call.
pub(crate) const STEADY_PRUNE_FLOOR_PERCENT: i64 = 5;

/// Upper bound on automatic Pressure-triggered Ace passes run within one pressure
/// episode (one crossing of `AUTO_PRUNE_TRIGGER_PERCENT`). See the module docs for why
/// this is bounded rather than open-ended. Manual `/prune` sweeps are not subject to
/// this budget.
pub(crate) const MAX_PRESSURE_PRUNE_PASSES_PER_EPISODE: u32 = 2;

/// Luna is sufficient for the pass's bounded keep/delete classification and avoids
/// spending a larger model on routine context maintenance.
pub(crate) const PRUNE_MODEL_SLUG: &str = "gpt-5.6-luna";

/// Effort for the pruning pass. Keep/delete judgement over raw tool output is the
/// step that decides what the session can still see, so it runs at the model's
/// maximum rather than inheriting the user's turn setting.
pub(crate) const PRUNE_REASONING_EFFORT: ReasoningEffort = ReasoningEffort::Max;

/// Upper bound on one pass's batch, in approximate tokens. Beyond this a single pass
/// stops being a bounded maintenance call: latency grows, and a reply covering
/// hundreds of ids is far likelier to come back truncated or unparseable — which
/// reclaims nothing at all. Whatever is left over is simply the next pass's batch.
pub(crate) const MAX_PRUNE_BATCH_TOKENS: usize = 24_000;

/// Sentinel the model replies with when nothing in the batch is worth keeping.
/// Kept identical to the instruction in `prompts/templates/context_prune/prompt.md`.
const NOTHING_TO_KEEP: &str = "NOTHING_TO_KEEP";

static PRUNE_PASSES: AtomicUsize = AtomicUsize::new(0);
static PRUNE_SAVED_CHARS: AtomicUsize = AtomicUsize::new(0);

/// Number of Ace pruning passes applied during this Elpis process.
pub fn pass_count() -> usize {
    PRUNE_PASSES.load(Ordering::Relaxed)
}

/// Cumulative chars removed from request context by Ace during this Elpis
/// process.
pub fn saved_chars() -> usize {
    PRUNE_SAVED_CHARS.load(Ordering::Relaxed)
}

/// One completed pruning pass: the evidence-pointer text the model produced (may be
/// empty when the pass kept nothing), plus the exact tool-call ids it covers.
/// Applying a record replaces those items' raw content with a tiny receipt — the
/// record text is what carries "why it mattered" forward, not the raw output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PruneRecord {
    pub(crate) covered_call_ids: Vec<String>,
    pub(crate) text: String,
}

impl PruneRecord {
    fn is_empty(&self) -> bool {
        self.covered_call_ids.is_empty()
    }
}

/// Which trigger a pass is running under. Pressure outranks steady: when use is
/// already at 30% the reclaim target is what matters, not the backlog size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PruneTrigger {
    /// The user explicitly requested a selective pass with `/prune`.
    Manual,
    /// Completed turns hold at least `STEADY_PRUNE_FLOOR_PERCENT` of the window.
    Steady,
    /// Active use reached `AUTO_PRUNE_TRIGGER_PERCENT`.
    Pressure,
}

impl PruneTrigger {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Steady => "steady",
            Self::Pressure => "pressure",
        }
    }
}

/// The trigger that applies right now, or `None` when no pass should run.
///
/// The two triggers measure different regions, so they get their own backlog figures.
/// A turn that drives dozens of tools without ever ending has no completed turns at
/// all, so a shared `uncovered_tokens` of zero would rule out pressure exactly when
/// the window is filling fastest.
pub(crate) fn select_trigger(
    used_tokens: i64,
    uncovered_tokens: usize,
    pressure_uncovered_tokens: usize,
    context_window: i64,
) -> Option<PruneTrigger> {
    if context_window <= 0 {
        return None;
    }
    if pressure_uncovered_tokens > 0 && pressure_reached(used_tokens, context_window) {
        return Some(PruneTrigger::Pressure);
    }
    if uncovered_tokens == 0 {
        return None;
    }
    steady_floor_reached(uncovered_tokens, context_window).then_some(PruneTrigger::Steady)
}

/// Tracks how many automatic Pressure-triggered Ace passes have run since active use
/// last crossed `AUTO_PRUNE_TRIGGER_PERCENT`. One crossing is one episode; its budget
/// is `MAX_PRESSURE_PRUNE_PASSES_PER_EPISODE` passes. Dropping back under the boundary
/// re-arms it, so the next crossing gets a fresh budget. Manual passes never observe
/// or record against this — it only tracks the automatic Pressure trigger.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PressureEpisode {
    passes: u32,
}

impl PressureEpisode {
    pub(crate) fn passes(&self) -> u32 {
        self.passes
    }

    /// Re-arms the episode once active use is observed back under the boundary.
    /// Call this on every automatic check, regardless of which trigger fires.
    pub(crate) fn observe(&mut self, in_pressure: bool) {
        if !in_pressure {
            self.passes = 0;
        }
    }

    pub(crate) fn record_pass(&mut self) {
        self.passes = self.passes.saturating_add(1);
    }
}

/// Whether an automatic pass under `trigger` should actually run an Ace pass, given
/// how many Pressure passes the current episode has already spent. Steady and Manual
/// are never budgeted; only automatic Pressure passes draw down the episode.
pub(crate) fn should_run_automatic_pass(trigger: PruneTrigger, pressure_episode_passes: u32) -> bool {
    match trigger {
        PruneTrigger::Pressure => pressure_episode_passes < MAX_PRESSURE_PRUNE_PASSES_PER_EPISODE,
        PruneTrigger::Steady | PruneTrigger::Manual => true,
    }
}

/// True when uncovered completed-turn output is worth a steady pass on its own.
pub(crate) fn steady_floor_reached(uncovered_tokens: usize, context_window: i64) -> bool {
    if context_window <= 0 {
        return false;
    }
    let uncovered = i64::try_from(uncovered_tokens).unwrap_or(i64::MAX);
    uncovered.saturating_mul(100) >= context_window.saturating_mul(STEADY_PRUNE_FLOOR_PERCENT)
}

pub(crate) fn pressure_reached(used_tokens: i64, context_window: i64) -> bool {
    if context_window <= 0 {
        return false;
    }
    used_tokens.max(0).saturating_mul(100)
        >= context_window.saturating_mul(AUTO_PRUNE_TRIGGER_PERCENT)
}

/// Approximate number of active-context tokens a pressure pass should reclaim: the
/// distance from what the window currently holds down to `target_percent` of it, and
/// nothing beyond that. This is the amount to *remove*, not the amount to keep.
pub(crate) fn reclaim_target_tokens(
    used_tokens: i64,
    context_window: i64,
    target_percent: i64,
) -> usize {
    if context_window <= 0 {
        return 0;
    }
    let target_percent = target_percent.clamp(1, 100);
    let target_tokens = context_window.saturating_mul(target_percent) / 100;
    usize::try_from(used_tokens.saturating_sub(target_tokens).max(0)).unwrap_or(usize::MAX)
}

/// How long automatic pruning waits after `consecutive_failures` failed passes.
/// A failed pass covers nothing, so the very same batch is what the next turn
/// selects; retrying it immediately just spends another model call to fail the same
/// way. Backing off keeps a session usable while whatever caused the failure clears,
/// and the ceiling keeps the layer alive rather than disabling it for good.
pub(crate) fn retry_delay_after_failures(consecutive_failures: u32) -> Duration {
    const BASE_SECS: u64 = 30;
    const MAX_SECS: u64 = 600;
    let shift = consecutive_failures.saturating_sub(1).min(8);
    Duration::from_secs((BASE_SECS << shift).min(MAX_SECS))
}

fn prunable_text(item: &ResponseItem) -> Option<(&str, String)> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        }
        | ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => {
            let text = output.body.to_text()?;
            if text.trim().is_empty() {
                None
            } else {
                Some((call_id.as_str(), text))
            }
        }
        _ => None,
    }
}

/// The current user question is classification context, never part of the deletable
/// batch. Ace needs it to judge whether a tool result mattered.
pub(crate) fn latest_user_message_text(input: &[ResponseItem]) -> Option<String> {
    input.iter().rev().find_map(|item| {
        let ResponseItem::Message { role, content, .. } = item else {
            return None;
        };
        if role != "user" {
            return None;
        }
        let text = content
            .iter()
            .filter_map(|content| match content {
                ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

/// Everything before the latest user message: the only region either trigger may
/// rewrite. The current turn's own observations must survive for the next follow-up.
fn completed_turn_items(input: &[ResponseItem]) -> &[ResponseItem] {
    match input
        .iter()
        .rposition(|item| matches!(item, ResponseItem::Message { role, .. } if role == "user"))
    {
        Some(current_turn_start) => &input[..current_turn_start],
        None => &[],
    }
}

/// Region a pressure pass may rewrite: everything except the newest tool evidence,
/// which stays verbatim.
///
/// The steady pass stops at the latest user message, because between turns that is
/// exactly the boundary between settled work and the question being answered. A
/// pressure pass cannot use the same boundary. A single tool-driven turn can run for
/// dozens of steps and cross the pressure line without ever ending, and at that point
/// every byte in the window belongs to the current turn — so stopping at the turn
/// boundary leaves nothing eligible precisely when reclaiming matters most.
///
/// Instead the cut is made by recency: walking back from the end, the newest items
/// totalling `PRESSURE_KEEP_RECENT_PERCENT` of the window are kept verbatim, and the
/// prefix behind them is eligible.
///
/// The walk has to weigh every item, not only the prunable ones. Measuring the keep
/// budget in tool output alone means a window that is mostly messages and reasoning --
/// which is what a window looks like after a few passes have already distilled the
/// tool output down to pointers -- never accumulates enough to reach the budget, so
/// the walk falls off the front and reports nothing eligible. Pressure then stops
/// firing exactly when the window is fullest: observed across the third message of a
/// session, where the window fell from 57% remaining to 19% with zero passes.
fn pressure_eligible_items(input: &[ResponseItem], context_window: i64) -> &[ResponseItem] {
    if context_window <= 0 {
        return &[];
    }
    let keep_budget = usize::try_from(
        context_window.saturating_mul(PRESSURE_KEEP_RECENT_PERCENT) / 100,
    )
    .unwrap_or(usize::MAX);

    let mut kept = 0usize;
    for (index, item) in input.iter().enumerate().rev() {
        kept = kept.saturating_add(item_token_estimate(item));
        if kept >= keep_budget {
            return &input[..index];
        }
    }
    // The whole history fits inside the keep budget, so nothing is old enough to take.
    &[]
}

/// Rough size of any history item, for the recency cut only. Tool output is measured
/// from the text a pass would actually rewrite; everything else is measured from its
/// serialised form, which is what the request carries.
fn item_token_estimate(item: &ResponseItem) -> usize {
    if let Some((_, text)) = prunable_text(item) {
        return approx_token_count(&text);
    }
    serde_json::to_string(item)
        .map(|json| approx_token_count(&json))
        .unwrap_or(0)
}

/// Approximate tokens of uncovered tool output a pressure pass could take right now.
/// Measured over the pressure region rather than completed turns, so a long single
/// turn still reports a real backlog.
pub(crate) fn uncovered_pressure_tokens(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
    context_window: i64,
) -> usize {
    pressure_eligible_items(input, context_window)
        .iter()
        .filter_map(prunable_text)
        .filter(|(call_id, _)| !covered_call_ids.contains(*call_id))
        .map(|(_, text)| approx_token_count(&text))
        .sum()
}

/// Approximate tokens of turn-lifetime tool output from completed turns not already
/// covered by a prior record — the backlog the steady trigger measures. Durable rules,
/// messages, the current turn, and already-covered items are all excluded.
pub(crate) fn uncovered_completed_turn_tokens(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> usize {
    completed_turn_items(input)
        .iter()
        .filter_map(prunable_text)
        .filter(|(call_id, _)| !covered_call_ids.contains(*call_id))
        .map(|(_, text)| approx_token_count(&text))
        .sum()
}

/// The whole uncovered backlog from completed turns, oldest first. The steady pass
/// takes all of it rather than a size-bounded slice: at the 1% floor there is little
/// to take, and leaving remnants would only buy another model call next turn.
pub(crate) fn build_steady_prune_batch(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> Vec<(String, String)> {
    take_within_batch_budget(build_prune_candidates(
        completed_turn_items(input),
        covered_call_ids,
    ))
}

/// The whole uncovered backlog for an explicit `/prune`. Unlike automatic pruning,
/// this runs as a standalone task between turns, so the latest finished turn is also
/// eligible.
pub(crate) fn build_manual_prune_batch(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> Vec<(String, String)> {
    take_within_batch_budget(build_prune_candidates(input, covered_call_ids))
}

/// Oldest-first prefix of `candidates` that fits one pass. The first candidate is
/// always taken, so an oversized single output is still eligible instead of jamming
/// the queue behind an item no batch can ever accept.
fn take_within_batch_budget(candidates: Vec<(String, String, usize)>) -> Vec<(String, String)> {
    let mut selected = Vec::new();
    let mut selected_tokens = 0usize;
    for (call_id, evidence, output_tokens) in candidates {
        if !selected.is_empty()
            && selected_tokens.saturating_add(output_tokens) > MAX_PRUNE_BATCH_TOKENS
        {
            break;
        }
        selected.push((call_id, evidence));
        selected_tokens = selected_tokens.saturating_add(output_tokens);
    }
    selected
}

/// Oldest-first subset expected to reclaim at least `target_tokens`. Newer eligible
/// outputs remain verbatim, providing the recent-turn suffix the pressure pass must
/// preserve.
pub(crate) fn build_prune_batch_for_reclaim(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
    target_tokens: usize,
    context_window: i64,
) -> Vec<(String, String)> {
    if target_tokens == 0 {
        return Vec::new();
    }

    let mut selected = Vec::new();
    let mut selected_tokens = 0usize;
    for (call_id, evidence, output_tokens) in build_prune_candidates(
        pressure_eligible_items(input, context_window),
        covered_call_ids,
    ) {
        if !selected.is_empty()
            && selected_tokens.saturating_add(output_tokens) > MAX_PRUNE_BATCH_TOKENS
        {
            break;
        }
        selected.push((call_id, evidence));
        selected_tokens = selected_tokens.saturating_add(output_tokens);
        if selected_tokens >= target_tokens {
            break;
        }
    }
    selected
}

fn build_prune_candidates(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> Vec<(String, String, usize)> {
    let operations = input
        .iter()
        .filter_map(|item| match item {
            ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                call_id,
                ..
            } => {
                let tool = namespace
                    .as_deref()
                    .map_or_else(|| name.clone(), |namespace| format!("{namespace}.{name}"));
                Some((
                    call_id.as_str(),
                    format!("tool: {tool}\ninput: {arguments}"),
                ))
            }
            ResponseItem::CustomToolCall {
                name,
                namespace,
                input,
                call_id,
                ..
            } => {
                let tool = namespace
                    .as_deref()
                    .map_or_else(|| name.clone(), |namespace| format!("{namespace}.{name}"));
                Some((call_id.as_str(), format!("tool: {tool}\ninput: {input}")))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();

    input
        .iter()
        .filter_map(prunable_text)
        .filter(|(call_id, _)| !covered_call_ids.contains(*call_id))
        .map(|(call_id, text)| {
            let evidence = match operations.get(call_id) {
                Some(operation) => format!("{operation}\noutput:\n{text}"),
                None => format!("tool: <invocation unavailable>\noutput:\n{text}"),
            };
            (call_id.to_string(), evidence, approx_token_count(&text))
        })
        .collect()
}

/// Builds the user-message text sent to the pruning model: each batch entry tagged
/// with its call id so the model's output lines can be matched back to it.
pub(crate) fn build_prune_input(
    batch: &[(String, String)],
    active_question: Option<&str>,
) -> String {
    let question = active_question.unwrap_or("<unavailable>");
    let mut out = format!(
        "<active_user_question>\n{question}\n</active_user_question>\n\
         <evidence_batch>\n"
    );
    for (call_id, text) in batch {
        out.push_str(&format!("--- id: {call_id} ---\n{text}\n"));
    }
    out.push_str("</evidence_batch>\n");
    out
}

/// Parses one pass's raw model output into a record. A line only counts if it starts
/// with an id the batch actually contains — the model does not get to reference ids
/// it wasn't given. Every batch item ends up covered regardless of whether it earned
/// a line: items that didn't matter are deleted outright, not left dangling for a
/// future pass to re-litigate. Returns `None` unless the output is the exact sentinel
/// or every non-empty line has a known, unique id and non-empty conclusion, so the
/// caller leaves the batch alone rather than discarding evidence on a partial reply.
pub(crate) fn parse_prune_output(raw: &str, batch: &[(String, String)]) -> Option<PruneRecord> {
    if batch.is_empty() {
        return None;
    }
    let all_covered = || batch.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();

    if raw.trim() == NOTHING_TO_KEEP {
        return Some(PruneRecord {
            covered_call_ids: all_covered(),
            text: String::new(),
        });
    }

    let known_ids: HashSet<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
    let mut seen_ids = HashSet::new();
    let mut kept_lines = Vec::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Some((id, conclusion)) = line.split_once(':') else {
            return None;
        };
        let id = id.trim();
        if !known_ids.contains(id) || conclusion.trim().is_empty() || !seen_ids.insert(id) {
            return None;
        }
        kept_lines.push(line);
    }

    if kept_lines.is_empty() {
        return None;
    }

    Some(PruneRecord {
        covered_call_ids: all_covered(),
        text: kept_lines.join("\n"),
    })
}

/// Maps each `<id>: <content>` line in a record's text back to its call id, so the
/// per-item receipt below can carry the actual conclusion instead of a generic marker.
fn conclusions_by_call_id(record_text: &str) -> HashMap<&str, &str> {
    record_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(id, rest)| (id.trim(), rest.trim()))
        .collect()
}

/// Applies a validated deletion manifest to model-visible working history.
///
/// A tool result that earned a conclusion becomes a compact receipt with an exact
/// rollout pointer; its paired invocation remains so the operation is still legible.
/// A covered item with no conclusion is a dead end, so both invocation and output are
/// removed entirely. Exact originals remain in the durable rollout.
pub(crate) fn apply_prune_record_untracked(
    input: &mut Vec<ResponseItem>,
    record: &PruneRecord,
) -> usize {
    if record.is_empty() {
        return 0;
    }
    let covered: HashSet<&str> = record.covered_call_ids.iter().map(String::as_str).collect();
    let conclusions = conclusions_by_call_id(&record.text);
    let mut saved = 0usize;
    let mut rewritten = Vec::with_capacity(input.len());
    for mut item in std::mem::take(input) {
        let keep = match &mut item {
            ResponseItem::FunctionCall {
                call_id, arguments, ..
            } if covered.contains(call_id.as_str())
                && !conclusions.contains_key(call_id.as_str()) =>
            {
                saved += arguments.chars().count();
                false
            }
            ResponseItem::CustomToolCall { call_id, input, .. }
                if covered.contains(call_id.as_str())
                    && !conclusions.contains_key(call_id.as_str()) =>
            {
                saved += input.chars().count();
                false
            }
            ResponseItem::LocalShellCall {
                call_id: Some(call_id),
                ..
            } if covered.contains(call_id.as_str())
                && !conclusions.contains_key(call_id.as_str()) =>
            {
                false
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            }
            | ResponseItem::CustomToolCallOutput {
                call_id, output, ..
            } if covered.contains(call_id.as_str()) => {
                let Some(conclusion) = conclusions.get(call_id.as_str()) else {
                    saved += output.body.to_text().map_or(0, |text| text.chars().count());
                    continue;
                };
                let Some(text) = output.body.to_text() else {
                    rewritten.push(item);
                    continue;
                };
                let original_chars = text.chars().count();
                let receipt = format!(
                    "[ELPIS CONTEXT UPDATE]\nkept={conclusion}\nevidence=rollout://tool-call/{call_id}\noriginal_chars={original_chars}"
                );
                let new_chars = receipt.chars().count();
                if new_chars < original_chars {
                    saved += original_chars - new_chars;
                    output.body = FunctionCallOutputBody::Text(receipt);
                }
                true
            }
            _ => true,
        };
        if keep {
            rewritten.push(item);
        }
    }
    *input = rewritten;
    saved
}

pub(crate) fn record_applied_prune(saved: usize) {
    PRUNE_PASSES.fetch_add(1, Ordering::Relaxed);
    PRUNE_SAVED_CHARS.fetch_add(saved, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;

    fn tool_output(call_id: &str, text: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload::from_text(text.to_string()),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn tool_call(call_id: &str, name: &str, arguments: &str) -> ResponseItem {
        ResponseItem::FunctionCall {
            id: None,
            name: name.to_string(),
            namespace: None,
            arguments: arguments.to_string(),
            call_id: call_id.to_string(),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn user_message(text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: text.to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn pressure_trigger_starts_at_thirty_percent_use() {
        assert_eq!(select_trigger(299_999, 9_999, 9_999, 1_000_000), None);
        assert_eq!(
            select_trigger(300_000, 9_999, 9_999, 1_000_000),
            Some(PruneTrigger::Pressure)
        );
        assert_eq!(select_trigger(900_000, 0, 0, 1_000_000), None);
    }

    #[test]
    fn steady_trigger_fires_below_pressure_once_backlog_reaches_five_percent() {
        // The regression this guards: under pressure-only gating, a session with a
        // real backlog but modest use pruned nothing and grew until it hit 30% used.
        assert_eq!(
            select_trigger(200_000, 50_000, 0, 1_000_000),
            Some(PruneTrigger::Steady)
        );
        // Scenario: just below the 5% floor -> no steady prune.
        assert_eq!(select_trigger(200_000, 49_999, 0, 1_000_000), None);
        assert_eq!(select_trigger(200_000, 0, 0, 1_000_000), None);
    }

    #[test]
    fn steady_floor_is_five_percent_of_the_window() {
        let window = 1_000_000;
        // Scenario 1: just below 5% new eligible backlog -> no steady prune.
        assert!(!steady_floor_reached(49_999, window));
        // Scenario 2: exactly 5% -> one steady prune.
        assert!(steady_floor_reached(50_000, window));
    }

    #[test]
    fn steady_does_not_retrigger_until_another_five_percent_of_new_material_accumulates() {
        // Scenario 3: after a steady pass covers the backlog, already-covered material
        // must not count toward the next threshold -- only genuinely new material can.
        let window = 1_000_000;
        let mut covered = HashSet::new();
        let big = "x".repeat(4_000 * 4); // 4,000 approx tokens, first steady pass's batch
        let input = vec![
            user_message("previous turn"),
            tool_output("a", &big),
            user_message("current turn"),
        ];

        // Steady pass covers "a".
        covered.insert("a".to_string());
        let after_cover = uncovered_completed_turn_tokens(&input, &covered);
        assert_eq!(after_cover, 0);
        assert!(!steady_floor_reached(after_cover, window));

        // Only 49,999 tokens of genuinely new material arrive (still below the 5%
        // floor) -- no second steady prune yet.
        let small_new = "y".repeat(49_999 * 4);
        let input_with_small_new = vec![
            user_message("previous turn"),
            tool_output("a", &big),
            user_message("second turn"),
            tool_output("b", &small_new),
            user_message("current turn"),
        ];
        let uncovered_small = uncovered_completed_turn_tokens(&input_with_small_new, &covered);
        assert!(!steady_floor_reached(uncovered_small, window));

        // Once another ~5% of new material has accumulated, steady fires again.
        let enough_new = "y".repeat(50_000 * 4);
        let input_with_enough_new = vec![
            user_message("previous turn"),
            tool_output("a", &big),
            user_message("second turn"),
            tool_output("b", &enough_new),
            user_message("current turn"),
        ];
        let uncovered_enough = uncovered_completed_turn_tokens(&input_with_enough_new, &covered);
        assert!(steady_floor_reached(uncovered_enough, window));
    }

    #[test]
    fn pressure_maintenance_boundary_is_exactly_thirty_percent_used() {
        let window = 1_000_000;
        // Scenario 4: just below 30% used -> no pressure maintenance.
        assert!(!pressure_reached(299_999, window));
        // Scenario 5: exactly 30% used -> pressure maintenance.
        assert!(pressure_reached(300_000, window));
    }

    #[test]
    fn pressure_outranks_steady_when_both_conditions_are_true() {
        // Scenario 6: both a real steady backlog and pressure are true at once --
        // pressure must win.
        assert_eq!(
            select_trigger(
                /*used_tokens*/ 300_000,
                /*uncovered_tokens*/ 60_000,
                /*pressure_uncovered_tokens*/ 1,
                /*context_window*/ 1_000_000,
            ),
            Some(PruneTrigger::Pressure)
        );
    }

    #[test]
    fn pressure_reclaim_targets_twenty_percent_used() {
        // Scenario 7: pressure attempts to reduce context toward the 20% target.
        let window = 1_000_000;
        let used = 300_000;
        let reclaim = reclaim_target_tokens(used, window, AUTO_PRUNE_TARGET_PERCENT);
        assert_eq!(used - reclaim as i64, window * AUTO_PRUNE_TARGET_PERCENT / 100);
        assert_eq!(AUTO_PRUNE_TARGET_PERCENT, 20);
    }

    #[test]
    fn pressure_episode_permits_at_most_two_passes() {
        // Scenario 8: no more than 2 Ace passes occur during one pressure episode.
        let mut episode = PressureEpisode::default();
        assert!(should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
        episode.record_pass();
        assert_eq!(episode.passes(), 1);
        assert!(should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
        episode.record_pass();
        assert_eq!(episode.passes(), 2);
        // Budget spent: a third automatic pass must not run.
        assert!(!should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
        episode.record_pass();
        assert!(!should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
    }

    #[test]
    fn exhausted_pressure_episode_defers_to_native_compaction() {
        // Scenario 9: once the episode's Ace budget is spent, the caller must fall back
        // to the existing compaction/rollover mechanism rather than run another pass.
        // `should_run_automatic_pass` returning false is exactly the signal
        // `run_context_prune` uses to skip straight to `request_new_context_window`.
        let mut episode = PressureEpisode::default();
        episode.record_pass();
        episode.record_pass();
        assert!(!should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
    }

    #[test]
    fn pressure_episode_re_arms_only_after_dropping_back_under_the_boundary() {
        // Scenario 10: a pressure episode does not repeatedly retrigger without an
        // appropriate re-arm condition -- staying at or above the boundary must not
        // reset the budget on its own.
        let mut episode = PressureEpisode::default();
        episode.record_pass();
        episode.record_pass();
        assert_eq!(episode.passes(), 2);

        // Still in pressure: observing that must NOT re-arm the episode.
        episode.observe(/*in_pressure*/ true);
        assert_eq!(episode.passes(), 2);
        assert!(!should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));

        // Active use finally drops back under the boundary: this re-arms it.
        episode.observe(/*in_pressure*/ false);
        assert_eq!(episode.passes(), 0);
        assert!(should_run_automatic_pass(PruneTrigger::Pressure, episode.passes()));
    }

    #[test]
    fn pressure_still_fires_once_steady_has_already_covered_completed_turn_evidence() {
        // Scenario 11: pressure must still work when previous steady passes have
        // already covered the completed-turn backlog -- the pressure region reaches
        // further (into the running turn) than the steady region does.
        let window = 20_000;
        let input = vec![
            user_message("previous turn"),
            tool_output("already_covered", &"a".repeat(8_000)),
            user_message("the running turn"),
            tool_output("first", &"b".repeat(8_000)),
            tool_output("newest", &"c".repeat(8_000)),
        ];
        let mut covered = HashSet::new();
        covered.insert("already_covered".to_string());

        assert_eq!(uncovered_completed_turn_tokens(&input, &covered), 0);
        let pressure_uncovered = uncovered_pressure_tokens(&input, &covered, window);
        assert!(pressure_uncovered > 0);
        assert_eq!(
            select_trigger(
                /*used_tokens*/ 16_000,
                /*uncovered_tokens*/ 0,
                pressure_uncovered,
                window,
            ),
            Some(PruneTrigger::Pressure)
        );
    }

    #[test]
    fn manual_trigger_is_never_budgeted_by_the_pressure_episode() {
        // Scenario 12: existing manual pruning behavior remains unchanged -- Manual
        // always may run, regardless of how many pressure passes have been spent.
        assert!(should_run_automatic_pass(PruneTrigger::Manual, 0));
        assert!(should_run_automatic_pass(PruneTrigger::Manual, u32::MAX));
    }

    #[test]
    fn pruning_model_is_luna() {
        assert_eq!(PRUNE_MODEL_SLUG, "gpt-5.6-luna");
    }

    #[test]
    fn no_trigger_fires_for_non_positive_context_window() {
        assert_eq!(select_trigger(200_000, 1_000_000, 1_000_000, 0), None);
        assert_eq!(select_trigger(200_000, 1_000_000, 1_000_000, -1), None);
    }

    #[test]
    fn reclaim_target_is_the_distance_down_to_the_target_not_the_whole_window() {
        // The regression this guards: a pressure pass that asked for
        // `window * (1 - target)` tokens selected essentially the entire backlog on
        // every trigger, distilling recent evidence the session still needed.
        assert_eq!(
            reclaim_target_tokens(300_000, 1_000_000, AUTO_PRUNE_TARGET_PERCENT),
            100_000
        );
        assert_eq!(
            reclaim_target_tokens(199_999, 1_000_000, AUTO_PRUNE_TARGET_PERCENT),
            0
        );
        // An explicit `/prune <pct>` targets that much context remaining.
        assert_eq!(reclaim_target_tokens(300_000, 1_000_000, 10), 200_000);
        assert_eq!(reclaim_target_tokens(300_000, 1_000_000, 90), 0);
    }

    #[test]
    fn pressure_pass_never_reclaims_past_the_target() {
        let window = 1_000_000;
        let used = 300_000;
        let reclaim = reclaim_target_tokens(used, window, AUTO_PRUNE_TARGET_PERCENT);
        assert!(reclaim < used as usize);
        assert_eq!(
            used - reclaim as i64,
            window * AUTO_PRUNE_TARGET_PERCENT / 100
        );
    }

    #[test]
    fn prune_runs_at_max_effort() {
        assert_eq!(PRUNE_REASONING_EFFORT, ReasoningEffort::Max);
    }

    #[test]
    fn failed_passes_back_off_and_then_hold_at_the_ceiling() {
        assert_eq!(retry_delay_after_failures(1), Duration::from_secs(30));
        assert_eq!(retry_delay_after_failures(2), Duration::from_secs(60));
        assert_eq!(retry_delay_after_failures(3), Duration::from_secs(120));
        assert_eq!(retry_delay_after_failures(50), Duration::from_secs(600));
    }

    #[test]
    fn a_batch_stays_within_the_pass_budget_but_never_starves() {
        let big = "x".repeat(MAX_PRUNE_BATCH_TOKENS * 8);
        let input = vec![
            user_message("previous turn"),
            tool_output("a", &big),
            tool_output("b", &big),
            user_message("current turn"),
        ];
        let batch = build_steady_prune_batch(&input, &HashSet::new());
        // One oversized output is still eligible on its own; it does not drag a
        // second one into the same call, and it never jams the queue behind itself.
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].0, "a");
    }

    #[test]
    fn uncovered_backlog_excludes_covered_items_and_the_current_turn() {
        let input = vec![
            user_message("previous turn"),
            tool_output("a", &"a".repeat(4_000)),
            tool_output("b", &"b".repeat(4_000)),
            user_message("current turn"),
            tool_output("current", &"c".repeat(4_000)),
        ];

        let mut covered = HashSet::new();
        let both = uncovered_completed_turn_tokens(&input, &covered);
        covered.insert("a".to_string());
        let one = uncovered_completed_turn_tokens(&input, &covered);

        // Messages and the current turn's output never count toward the backlog, so
        // covering one of the two completed outputs halves it.
        assert!(both > 0);
        assert_eq!(one * 2, both);
    }

    #[test]
    fn steady_batch_takes_the_whole_backlog_but_skips_covered_ids() {
        let input = vec![
            user_message("previous turn"),
            tool_call("a", "exec_command", r#"{"cmd":"first"}"#),
            tool_output("a", "aaaa"),
            tool_call("b", "exec_command", r#"{"cmd":"second"}"#),
            tool_output("b", "bb"),
            user_message("current turn"),
        ];
        let covered: HashSet<String> = ["a".to_string()].into_iter().collect();
        let batch = build_steady_prune_batch(&input, &covered);
        assert_eq!(
            batch,
            vec![(
                "b".to_string(),
                "tool: exec_command\ninput: {\"cmd\":\"second\"}\noutput:\nbb".to_string()
            )]
        );
    }

    #[test]
    fn steady_batch_never_consumes_the_current_turn() {
        let input = vec![
            user_message("previous turn"),
            tool_output("old", "aaaa"),
            user_message("current turn"),
            tool_output("current", "bbbb"),
        ];

        let batch = build_steady_prune_batch(&input, &HashSet::new());

        assert_eq!(
            batch
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["old"]
        );
    }

    #[test]
    fn manual_batch_includes_the_latest_finished_turn() {
        let input = vec![
            user_message("latest finished turn"),
            tool_call("latest", "exec_command", r#"{"cmd":"inspect"}"#),
            tool_output("latest", "latest output"),
        ];

        let batch = build_manual_prune_batch(&input, &HashSet::new());

        assert_eq!(
            batch
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["latest"]
        );
    }

    #[test]
    fn pressure_batch_selects_oldest_output_needed_and_keeps_recent_suffix() {
        let input = vec![
            user_message("previous turn"),
            tool_output("old", &"a".repeat(8_000)),
            tool_output("middle", &"b".repeat(8_000)),
            user_message("current turn"),
            tool_output("recent", &"c".repeat(8_000)),
        ];

        let batch = build_prune_batch_for_reclaim(
            &input,
            &HashSet::new(),
            /*target_tokens*/ 3_000,
            /*context_window*/ 20_000,
        );

        assert_eq!(
            batch
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["old", "middle"]
        );
    }

    #[test]
    fn pressure_batch_reaches_into_a_turn_that_has_not_ended() {
        // The regression this guards: a single tool-driven turn crosses the pressure
        // boundary without ever completing. Cutting at the latest user message left
        // every one of its outputs ineligible, so a session could climb from 30% to
        // 85% used reclaiming nothing at all.
        let input = vec![
            user_message("the only turn"),
            tool_output("first", &"a".repeat(8_000)),
            tool_output("second", &"b".repeat(8_000)),
            tool_output("newest", &"c".repeat(8_000)),
        ];

        let batch = build_prune_batch_for_reclaim(
            &input,
            &HashSet::new(),
            /*target_tokens*/ usize::MAX,
            /*context_window*/ 20_000,
        );

        // The newest output is the suffix the next follow-up reasons over; the two
        // behind it are old enough to distill.
        assert_eq!(
            batch
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn pressure_fires_when_the_running_turn_holds_the_backlog() {
        // Completed-turn backlog is zero for a turn still in flight, which used to
        // rule out every trigger and leave pressure unreachable.
        let input = vec![
            user_message("the only turn"),
            tool_output("first", &"a".repeat(8_000)),
            tool_output("newest", &"b".repeat(8_000)),
        ];
        let pressure_uncovered =
            uncovered_pressure_tokens(&input, &HashSet::new(), /*context_window*/ 20_000);

        assert_eq!(
            uncovered_completed_turn_tokens(&input, &HashSet::new()),
            0,
            "a turn that has not ended has no completed-turn backlog"
        );
        assert!(pressure_uncovered > 0);
        assert_eq!(
            select_trigger(
                /*used_tokens*/ 12_000,
                /*uncovered_tokens*/ 0,
                pressure_uncovered,
                /*context_window*/ 20_000,
            ),
            Some(PruneTrigger::Pressure)
        );
    }

    fn assistant_message(text: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: text.to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn pressure_still_fires_once_the_window_is_mostly_prose() {
        // Late in a session the tool output has already been distilled to pointers and
        // the window is carrying messages and reasoning instead. Sizing the keep budget
        // from tool output alone never reached the budget here, so the walk fell off the
        // front of the history and reported nothing eligible -- pressure stopped firing
        // at the point it was needed most, and the window ran down unopposed.
        let window = 20_000; // keep budget is 10% of it: 2,000 tokens
        let input = vec![
            tool_output("stale", &"a".repeat(4_000)),
            assistant_message(&"b".repeat(12_000)),
        ];

        let uncovered = uncovered_pressure_tokens(&input, &HashSet::new(), window);
        assert!(
            uncovered > 0,
            "old tool output behind a wall of prose must stay eligible"
        );
        assert_eq!(
            select_trigger(
                /*used_tokens*/ 16_000,
                /*uncovered_tokens*/ 0,
                uncovered,
                window,
            ),
            Some(PruneTrigger::Pressure)
        );
    }

    #[test]
    fn latest_user_message_is_context_but_not_part_of_prune_batch() {
        let input = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "Find the source of the bug.".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            tool_output("a", "evidence"),
        ];
        assert_eq!(
            latest_user_message_text(&input).as_deref(),
            Some("Find the source of the bug.")
        );
        // The question is classification context; its own turn's output is not
        // eligible, so no batch forms from it alone.
        assert!(build_steady_prune_batch(&input, &HashSet::new()).is_empty());
    }

    #[test]
    fn parse_prune_output_accepts_only_known_unique_nonempty_lines() {
        let batch = vec![
            ("a".to_string(), "text a".to_string()),
            ("b".to_string(), "text b".to_string()),
        ];
        let raw = "a: found the answer at foo.rs:10 — this is why it mattered";
        let record = parse_prune_output(raw, &batch).expect("record");
        assert_eq!(
            record.covered_call_ids,
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(record.text.contains("foo.rs:10"));
    }

    #[test]
    fn parse_prune_output_rejects_partly_malformed_or_duplicate_manifests() {
        let batch = vec![
            ("a".to_string(), "text a".to_string()),
            ("b".to_string(), "text b".to_string()),
        ];
        assert_eq!(
            parse_prune_output(
                "a: valid line\nmade-up-id: unknown id must invalidate the pass",
                &batch
            ),
            None
        );
        assert_eq!(
            parse_prune_output("a: first conclusion\na: conflicting conclusion", &batch),
            None
        );
        assert_eq!(parse_prune_output("a:", &batch), None);
    }

    #[test]
    fn parse_prune_output_nothing_to_keep_covers_batch_with_empty_text() {
        let batch = vec![("a".to_string(), "text a".to_string())];
        let record = parse_prune_output("NOTHING_TO_KEEP", &batch).expect("record");
        assert_eq!(record.covered_call_ids, vec!["a".to_string()]);
        assert_eq!(record.text, "");
    }

    #[test]
    fn parse_prune_output_returns_none_on_unusable_reply() {
        let batch = vec![("a".to_string(), "text a".to_string())];
        assert_eq!(
            parse_prune_output("I looked at everything and it's fine.", &batch),
            None
        );
        assert_eq!(parse_prune_output("", &batch), None);
    }

    #[test]
    fn parse_prune_output_returns_none_for_empty_batch() {
        assert_eq!(parse_prune_output(NOTHING_TO_KEEP, &[]), None);
    }

    #[test]
    fn apply_prune_record_replaces_only_covered_items_and_reports_savings() {
        let large = "x".repeat(2_000);
        let mut input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"find X"}"#),
            tool_output("a", &large),
            tool_call("b", "exec_command", r#"{"cmd":"find Y"}"#),
            tool_output("b", &large),
        ];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: "a: found X at foo.rs:1 — mattered because Y".to_string(),
        };

        let saved = apply_prune_record_untracked(&mut input, &record);
        assert!(saved > 0);

        let ResponseItem::FunctionCallOutput { output, .. } = &input[1] else {
            panic!("function output");
        };
        let text = output.text_content().expect("text");
        assert!(text.contains("evidence=rollout://tool-call/a"));
        // The whole point of paying for the model pass: its conclusion must survive
        // into the receipt, not just a generic "covered" marker.
        assert!(text.contains("found X at foo.rs:1 — mattered because Y"));

        let ResponseItem::FunctionCallOutput { output, .. } = &input[3] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some(large.as_str()));
    }

    #[test]
    fn apply_prune_record_removes_dead_end_call_and_output_without_a_trace() {
        let large = "x".repeat(2_000);
        let mut input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"useful"}"#),
            tool_output("a", &large),
            tool_call("b", "exec_command", r#"{"cmd":"dead end"}"#),
            tool_output("b", &large),
        ];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string(), "b".to_string()],
            text: "a: found X at foo.rs:1 — mattered because Y".to_string(),
        };

        apply_prune_record_untracked(&mut input, &record);

        assert_eq!(input.len(), 2);
        assert!(matches!(
            &input[0],
            ResponseItem::FunctionCall { call_id, .. } if call_id == "a"
        ));
        assert!(matches!(
            &input[1],
            ResponseItem::FunctionCallOutput { call_id, .. } if call_id == "a"
        ));
    }

    #[test]
    fn apply_prune_record_is_a_no_op_for_empty_record() {
        let mut input = vec![tool_output("a", "aaaa")];
        assert_eq!(
            apply_prune_record_untracked(&mut input, &PruneRecord::default()),
            0
        );
        let ResponseItem::FunctionCallOutput { output, .. } = &input[0] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some("aaaa"));
    }

    #[test]
    fn apply_prune_record_never_grows_an_already_small_item() {
        let mut input = vec![tool_output("a", "ok")];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: "a: trivial".to_string(),
        };
        assert_eq!(apply_prune_record_untracked(&mut input, &record), 0);
        let ResponseItem::FunctionCallOutput { output, .. } = &input[0] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some("ok"));
    }
}

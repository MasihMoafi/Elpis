//! Elpis's optional Ace context-pruning mechanism (see `docs/context.md`). The Ace pass handles
//! content that requires judgment — deciding
//! whether a search was a dead end (delete outright, no trace) or found something
//! that matters (keep one evidence-pointer line). That judgment comes from a model
//! call. It is deliberately selective distillation rather than a summary of every
//! action: useful evidence earns one compact conclusion, while dead ends leave no
//! model-visible trace.
//!
//! Automatic pruning runs in **cycles with hysteresis**, not continuously. One cycle
//! opens when active use reaches `AUTO_PRUNE_TRIGGER_PERCENT` (30%), spends at most
//! `MAX_PRESSURE_PRUNE_PASSES_PER_CYCLE` Ace passes driving use down toward
//! `AUTO_PRUNE_TARGET_PERCENT` (20%), and then closes. Once closed, `PruneCycle` blocks
//! every automatic pass until measured use has climbed back to the 30% trigger — so the
//! 20–30% band is a healthy working region that no pass may touch. See
//! `docs/cache-friendly-pruning.md`.
//!
//! There is deliberately no second, backlog-sized trigger. An earlier "steady" trigger
//! fired whenever completed turns held a few percent of the window in uncovered tool
//! output, independent of how full the window actually was. That is what produced runs
//! of dozens of tiny passes inside the healthy band: each pass rewrote model-visible
//! history, and every rewrite discards the reusable prompt-cache prefix past the first
//! rewritten item. Pressure alone covers the case steady existed for, because its
//! eligible region is cut by recency rather than at a turn boundary — a single
//! tool-driven turn that balloons past 30% without ever ending is still prunable.
//!
//! A pass reaches into the turn in flight, so it keeps the newest
//! `PRESSURE_KEEP_RECENT_PERCENT` of the window verbatim: the observations the next
//! follow-up reasons over sit at the end of history, and only what is behind them may be
//! rewritten. On any failure (model error, timeout, unparseable output) the batch is left
//! alone and can retry after the backoff in `retry_delay_after_failures` elapses — an
//! untouched batch is otherwise re-selected identically on the next turn, so without the
//! backoff one unluckily shaped batch retries forever and pruning never advances.
//!
//! # Epochs
//!
//! An applied pass seals its rewritten region with a `prune_epoch_marker`: a small,
//! byte-stable developer message recording the epoch number and cumulative reclaim.
//! Everything up to and including the newest marker is the **frozen prefix**
//! (`frozen_prefix_len`), and `pressure_eligible_items` refuses to look inside it. That
//! makes "a later pass never rewrites an earlier epoch" a structural property of the
//! candidate region rather than a side effect of the covered-id filter, and it gives the
//! prompt cache a breakpoint-eligible boundary that survives the next pass
//! (`crate::prompt_cache`).

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

/// Upper bound on automatic Ace passes run within one pruning cycle (one crossing of
/// `AUTO_PRUNE_TRIGGER_PERCENT`). A single pass is capped at `MAX_PRUNE_BATCH_TOKENS`,
/// which on a large window can be smaller than the distance from 30% down to 20%, so a
/// cycle is allowed more than one pass to reach its target. Those passes are one logical
/// cycle: they run back-to-back without waiting for regrowth, and when they are spent the
/// cycle closes rather than continuing to nibble at the boundary. Manual `/prune` sweeps
/// are not subject to this budget.
pub(crate) const MAX_PRESSURE_PRUNE_PASSES_PER_CYCLE: u32 = 2;

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

/// Which trigger a pass is running under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PruneTrigger {
    /// The user explicitly requested a selective pass with `/prune`.
    Manual,
    /// Targeted pressure selection, used by automatic pressure and manual `/force-prune`.
    Pressure,
}

impl PruneTrigger {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Pressure => "pressure",
        }
    }
}

/// The trigger that applies right now, or `None` when no pass should run.
///
/// Pressure is the only automatic trigger: a pass runs when active use is at or past the
/// boundary *and* the eligible region actually holds something to reclaim. Backlog size
/// on its own never starts a pass — see the module docs for why that trigger was removed.
pub(crate) fn select_trigger(
    used_tokens: i64,
    pressure_uncovered_tokens: usize,
    context_window: i64,
) -> Option<PruneTrigger> {
    if context_window <= 0 || pressure_uncovered_tokens == 0 {
        return None;
    }
    pressure_reached(used_tokens, context_window).then_some(PruneTrigger::Pressure)
}

/// Hysteresis gate for automatic pruning.
///
/// The invariant this type exists to enforce:
///
/// > After a cycle closes, no further automatic pass may run until measured context use
/// > has grown from the target region back to `AUTO_PRUNE_TRIGGER_PERCENT`.
///
/// That is what makes 20–30% a healthy band instead of a place where a session saws
/// against the boundary, and it is what bounds how often model-visible history — and with
/// it the reusable prompt-cache prefix — is rewritten. Manual `/prune` never consults or
/// mutates this; it only gates the automatic path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum PruneCycle {
    /// No cycle has run yet, or a closed cycle has since seen use return to the trigger.
    /// A pass may open a cycle as soon as `pressure_reached` holds.
    #[default]
    Armed,
    /// A cycle is open and has spent `passes` of its budget. Its remaining passes run
    /// back-to-back, without waiting for regrowth: they are one logical cycle finishing
    /// the descent to the target.
    Open { passes: u32 },
    /// A cycle closed. Every automatic pass is blocked until use has been measured
    /// *below* the trigger (`fell_below_trigger`) and has then climbed back up to it.
    ///
    /// Both halves are required, and the pair is the hysteresis. A closed cycle sits at
    /// roughly the target, so the first half is satisfied on the very next check and the
    /// gate reduces to "wait for 30% again" — the ~10-point regrowth band.
    ///
    /// The first half also carries the case where a cycle stops *without* getting use
    /// down: budget spent, or nothing left to reclaim, while still past the boundary.
    /// There `pressure_reached` is trivially true, so re-arming on the trigger alone
    /// would start a fresh cycle on the very next step and the session would go straight
    /// back to nibbling. Requiring a sub-trigger measurement first hands that case to
    /// whatever can actually reclaim — compaction or rollover — exactly as before.
    Cooling { fell_below_trigger: bool },
}

impl PruneCycle {
    /// Feeds the current measurement in. Call this on every automatic check, before
    /// `may_run`. It is the only place a cycle re-arms.
    ///
    /// The two `Cooling` transitions are mutually exclusive by construction — one needs
    /// use below the trigger, the other needs it at or above — so a cooling cycle always
    /// spans at least two observations on opposite sides of the boundary before it can
    /// run again.
    pub(crate) fn observe(&mut self, used_tokens: i64, context_window: i64) {
        // A cycle whose budget is spent closes here rather than sitting blocked forever:
        // `observe` sees every automatic check, so this is where an exhausted cycle
        // becomes a cooling one that regrowth can eventually re-arm.
        if let Self::Open { passes } = self
            && *passes >= MAX_PRESSURE_PRUNE_PASSES_PER_CYCLE
        {
            self.close();
        }
        if let Self::Cooling { fell_below_trigger } = self {
            let in_pressure = pressure_reached(used_tokens, context_window);
            if !*fell_below_trigger && !in_pressure {
                *fell_below_trigger = true;
            } else if *fell_below_trigger && in_pressure {
                *self = Self::Armed;
            }
        }
    }

    /// Whether an automatic pass may run right now. `Cooling` is the hysteresis block.
    pub(crate) fn may_run(&self) -> bool {
        match self {
            Self::Armed => true,
            Self::Open { passes } => *passes < MAX_PRESSURE_PRUNE_PASSES_PER_CYCLE,
            Self::Cooling { .. } => false,
        }
    }

    /// True once a cycle has closed and use has still not been seen below the trigger:
    /// pruning could not buy the headroom this session needs, which is the case the
    /// existing compaction/rollover mechanism owns.
    pub(crate) fn stalled_in_pressure(&self) -> bool {
        matches!(
            self,
            Self::Cooling {
                fell_below_trigger: false
            }
        )
    }

    /// Records that a pass was applied, opening the cycle if it was armed.
    pub(crate) fn record_pass(&mut self) {
        *self = match self {
            Self::Armed => Self::Open { passes: 1 },
            Self::Open { passes } => Self::Open {
                passes: passes.saturating_add(1),
            },
            // Unreachable via `may_run`, but must never silently spend a blocked pass.
            Self::Cooling { fell_below_trigger } => Self::Cooling {
                fell_below_trigger: *fell_below_trigger,
            },
        };
    }

    /// Closes the cycle: the target was reached, the budget is spent, or there is
    /// nothing left to reclaim.
    pub(crate) fn close(&mut self) {
        *self = Self::Cooling {
            fell_below_trigger: false,
        };
    }
}

/// True once active use has fallen to `AUTO_PRUNE_TARGET_PERCENT` or below, which is the
/// signal for the running cycle to close.
pub(crate) fn target_reached(used_tokens: i64, context_window: i64) -> bool {
    if context_window <= 0 {
        return false;
    }
    used_tokens.max(0).saturating_mul(100)
        <= context_window.saturating_mul(AUTO_PRUNE_TARGET_PERCENT)
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

/// Text that opens every epoch marker. Matched on to locate the frozen prefix, so it
/// must stay in sync with `prune_epoch_marker`.
const PRUNE_EPOCH_MARKER_PREFIX: &str = "[elpis.context-prune.epoch ";

/// The checkpoint that seals one applied pass's rewritten region.
///
/// Deliberately tiny and deliberately **byte-stable**: its text is fixed by values that
/// never change once the pass is applied, so from here on the marker and everything
/// before it are immutable model-visible input. Two properties follow, and both matter:
///
/// * a later pass may not rewrite anything at or before it (`pressure_eligible_items`),
/// * it is a `Message` carrying an `input_text` block, which is one of the few item
///   shapes the Responses API accepts a `prompt_cache_breakpoint` on — so the epoch
///   boundary can be written to the prompt cache and read back after the next pass.
///
/// The role is `developer` rather than `user` on purpose: `latest_user_message_text`
/// resolves the active question by scanning for the last user message, and a marker
/// posing as one would feed the pruning model a checkpoint line instead of the question.
pub(crate) fn prune_epoch_marker(epoch: u64) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "developer".to_string(),
        content: vec![ContentItem::InputText {
            text: format!(
                "{PRUNE_EPOCH_MARKER_PREFIX}{epoch}] Earlier tool output in this thread has been \
                 distilled into the evidence notes above. Exact originals remain in the session \
                 rollout."
            ),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn is_prune_epoch_marker(item: &ResponseItem) -> bool {
    let ResponseItem::Message { role, content, .. } = item else {
        return false;
    };
    role == "developer"
        && content.iter().any(|block| {
            matches!(block, ContentItem::InputText { text } if text.starts_with(PRUNE_EPOCH_MARKER_PREFIX))
        })
}

/// Length of the frozen prefix: everything up to and including the newest epoch marker.
///
/// Zero before the first applied pass. This is the boundary the prompt cache is anchored
/// to and the boundary the next pass starts after, so both sides read it from here rather
/// than each deriving their own notion of "settled".
pub(crate) fn frozen_prefix_len(input: &[ResponseItem]) -> usize {
    input
        .iter()
        .rposition(is_prune_epoch_marker)
        .map_or(0, |index| index + 1)
}

/// Region a pressure pass may rewrite: after the frozen prefix, and before whatever the
/// session still needs verbatim.
///
/// The **front** cut is the epoch boundary. Sealed epochs are immutable by construction,
/// not merely by the covered-id filter happening to skip them — which is what lets the
/// prompt-cache breakpoint on the newest marker survive this pass.
///
/// The **back** cut is the later of two boundaries, because each one alone leaves a gap:
///
/// * **The latest user message.** Everything before it belongs to a completed turn and is
///   safe to distil however recently it landed. On its own this is useless for a single
///   tool-driven turn that runs for dozens of steps and crosses the pressure line without
///   ever ending: then every byte in the window belongs to the current turn, and stopping
///   here would leave nothing eligible precisely when reclaiming matters most.
/// * **A recency cut.** Walking back from the end, the newest items totalling
///   `PRESSURE_KEEP_RECENT_PERCENT` of the window stay verbatim, which is what protects a
///   running turn's observations. On its own *this* is what fails when one completed-turn
///   output is large relative to the window: it falls inside the keep budget and becomes
///   permanently unreachable even as the session sits well past the boundary.
///
/// Taking the later boundary means the keep budget only ever protects the turn in flight,
/// which is what it was for. Neither boundary can expose a running turn's newest
/// observations: past the latest user message the recency cut governs, and before it every
/// item is settled work.
///
/// The recency walk has to weigh every item, not only the prunable ones. Measuring the
/// keep budget in tool output alone means a window that is mostly messages and reasoning --
/// which is what a window looks like after a few passes have already distilled the
/// tool output down to pointers -- never accumulates enough to reach the budget, so
/// the walk falls off the front and reports nothing eligible. Pressure then stops
/// firing exactly when the window is fullest: observed across the third message of a
/// session, where the window fell from 57% remaining to 19% with zero passes.
fn pressure_eligible_items(input: &[ResponseItem], context_window: i64) -> &[ResponseItem] {
    if context_window <= 0 {
        return &[];
    }
    let frozen = frozen_prefix_len(input);
    let end = recency_cut(input, context_window).max(completed_turn_end(input));
    if end <= frozen {
        return &[];
    }
    &input[frozen..end]
}

/// Index one past the last item that belongs to a completed turn — i.e. the position of
/// the latest user message, or 0 when the thread has none.
fn completed_turn_end(input: &[ResponseItem]) -> usize {
    input
        .iter()
        .rposition(|item| matches!(item, ResponseItem::Message { role, .. } if role == "user"))
        .unwrap_or(0)
}

/// Index one past the oldest item that still fits inside the keep-recent budget: the
/// newest items totalling `PRESSURE_KEEP_RECENT_PERCENT` of the window stay verbatim.
fn recency_cut(input: &[ResponseItem], context_window: i64) -> usize {
    let keep_budget = usize::try_from(
        context_window.saturating_mul(PRESSURE_KEEP_RECENT_PERCENT) / 100,
    )
    .unwrap_or(usize::MAX);

    let mut kept = 0usize;
    for (index, item) in input.iter().enumerate().rev() {
        kept = kept.saturating_add(item_token_estimate(item));
        if kept >= keep_budget {
            return index;
        }
    }
    // The whole history fits inside the keep budget, so nothing is old enough to take.
    0
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

/// The whole uncovered backlog for an explicit `/prune`. Unlike automatic pruning,
/// this runs as a standalone task between turns, so the latest finished turn is also
/// eligible. Sealed epochs stay off limits here too.
pub(crate) fn build_manual_prune_batch(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> Vec<(String, String)> {
    let frozen = frozen_prefix_len(input);
    take_within_batch_budget(build_prune_candidates(&input[frozen..], covered_call_ids))
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

/// Applies a validated deletion manifest to model-visible working history, then seals
/// the rewritten region with a new epoch marker.
///
/// A tool result that earned a conclusion becomes a compact receipt with an exact
/// rollout pointer; its paired invocation remains so the operation is still legible.
/// A covered item with no conclusion is a dead end, so both invocation and output are
/// removed entirely. Exact originals remain in the durable rollout.
///
/// The marker goes immediately after the last covered item — the exact point past which
/// nothing was touched — so it is both the frozen-prefix boundary for the next pass and a
/// breakpoint-eligible anchor for the prompt cache. The epoch number is derived by
/// counting the markers already present, so the epoch sequence lives in history itself and
/// survives resume without any parallel counter to keep in step.
pub(crate) fn apply_prune_record_untracked(
    input: &mut Vec<ResponseItem>,
    record: &PruneRecord,
) -> usize {
    if record.is_empty() {
        return 0;
    }
    let epoch = input.iter().filter(|item| is_prune_epoch_marker(item)).count() as u64 + 1;
    let covered: HashSet<&str> = record.covered_call_ids.iter().map(String::as_str).collect();
    let conclusions = conclusions_by_call_id(&record.text);
    let mut saved = 0usize;
    let mut rewritten = Vec::with_capacity(input.len() + 1);
    // Index in `rewritten` just past the last covered item, whether it survived as a
    // receipt or was dropped outright. Stays `None` only if the record covered nothing
    // present in `input`, in which case there is no region to seal.
    let mut boundary: Option<usize> = None;
    for mut item in std::mem::take(input) {
        let mut is_covered = true;
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
                match conclusions.get(call_id.as_str()) {
                    // No conclusion: a dead end, so the output goes entirely.
                    None => {
                        saved += output.body.to_text().map_or(0, |text| text.chars().count());
                        false
                    }
                    Some(conclusion) => {
                        if let Some(text) = output.body.to_text() {
                            let original_chars = text.chars().count();
                            let receipt = format!(
                                "[ELPIS CONTEXT UPDATE]\nkept={conclusion}\nevidence=rollout://tool-call/{call_id}\noriginal_chars={original_chars}"
                            );
                            let new_chars = receipt.chars().count();
                            if new_chars < original_chars {
                                saved += original_chars - new_chars;
                                output.body = FunctionCallOutputBody::Text(receipt);
                            }
                        }
                        true
                    }
                }
            }
            _ => {
                is_covered = false;
                true
            }
        };
        if keep {
            rewritten.push(item);
        }
        if is_covered {
            boundary = Some(rewritten.len());
        }
    }
    if let Some(boundary) = boundary {
        rewritten.insert(boundary, prune_epoch_marker(epoch));
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
        assert_eq!(select_trigger(299_999, 9_999, 1_000_000), None);
        assert_eq!(
            select_trigger(300_000, 9_999, 1_000_000),
            Some(PruneTrigger::Pressure)
        );
        assert_eq!(select_trigger(900_000, 0, 1_000_000), None);
    }

    #[test]
    fn backlog_alone_never_starts_an_automatic_pass() {
        // The old steady trigger fired on backlog size regardless of how full the window
        // was, which is what produced runs of tiny passes inside the healthy band. Use
        // below the boundary must now select no trigger at all, however much uncovered
        // tool output is sitting there.
        let window = 1_000_000;
        for used in [0, 100_000, 200_000, 299_999] {
            assert_eq!(
                select_trigger(used, 500_000, window),
                None,
                "use at {used} is inside the healthy band and must not prune"
            );
        }
    }

    /// Drives the gate the way `run_context_prune` does: observe, then ask.
    fn may_prune(cycle: &mut PruneCycle, used: i64, window: i64) -> bool {
        cycle.observe(used, window);
        cycle.may_run()
    }

    #[test]
    fn no_new_cycle_starts_while_use_stays_inside_the_healthy_band() {
        // Properties 3 and 4: a cycle that reached its target blocks every automatic pass
        // from 20% up to 30%, and becomes eligible again exactly at 30%.
        let window = 1_000_000;
        let mut cycle = PruneCycle::default();

        // Pressure crossing: one pass takes use to the 20% target, which closes the cycle.
        assert!(may_prune(&mut cycle, 300_000, window));
        cycle.record_pass();
        cycle.close();

        // Normal agent work regrows the window one point at a time. Nothing may prune.
        for used in [200_000, 210_000, 250_000, 290_000, 299_999] {
            assert!(
                !may_prune(&mut cycle, used, window),
                "use at {used} is between the target and the trigger; no pass may run"
            );
        }

        // Back at the boundary: the next cycle is eligible.
        assert!(may_prune(&mut cycle, 300_000, window));
    }

    #[test]
    fn a_cycle_that_stalled_in_pressure_does_not_re_arm_on_the_trigger_alone() {
        // The failure this guards: a cycle whose budget ran out while use was still above
        // the boundary. `pressure_reached` is trivially true there, so re-arming on the
        // trigger alone would start a fresh cycle on the very next step -- exactly the
        // unbounded-pass behaviour the budget exists to stop.
        let window = 1_000_000;
        let mut cycle = PruneCycle::default();

        assert!(may_prune(&mut cycle, 350_000, window));
        cycle.record_pass();
        assert!(may_prune(&mut cycle, 340_000, window));
        cycle.record_pass();

        // Budget spent, use still above the boundary: blocked, and flagged for the
        // compaction/rollover hand-off rather than re-armed.
        assert!(!may_prune(&mut cycle, 340_000, window));
        assert!(cycle.stalled_in_pressure());
        assert!(!may_prune(&mut cycle, 360_000, window));

        // Something that can actually reclaim brings use back under the boundary; only
        // then does regrowth to the trigger re-arm pruning.
        assert!(!may_prune(&mut cycle, 150_000, window));
        assert!(!cycle.stalled_in_pressure());
        assert!(!may_prune(&mut cycle, 299_999, window));
        assert!(may_prune(&mut cycle, 300_000, window));
    }

    #[test]
    fn a_cycle_that_closed_below_the_trigger_always_re_arms_again() {
        // Guards a deadlock: if re-arming demanded a measurement down in the *target*
        // region rather than merely under the trigger, a cycle that closed at, say, 24%
        // and never returned to 20% could never prune again for the rest of the session.
        let window = 1_000_000;
        for closed_at in [0, 150_000, 200_000, 240_000, 299_999] {
            let mut cycle = PruneCycle::default();
            cycle.close();

            assert!(
                !may_prune(&mut cycle, closed_at, window),
                "a cycle that just closed must not run again immediately"
            );
            assert!(
                may_prune(&mut cycle, 300_000, window),
                "a cycle closed at {closed_at} must re-arm once use is back at the trigger"
            );
        }
    }

    #[test]
    fn one_cycle_may_spend_its_budget_back_to_back_without_waiting_for_regrowth() {
        // A single pass is capped at `MAX_PRUNE_BATCH_TOKENS`, which on a large window can
        // be less than the 30% -> 20% distance. Those follow-up passes are one logical
        // cycle finishing its descent, so they must not be blocked by the gate.
        let window = 1_000_000;
        let mut cycle = PruneCycle::default();

        assert!(may_prune(&mut cycle, 300_000, window));
        cycle.record_pass();
        // Still short of the target, so the cycle stays open and spends its second pass.
        assert!(may_prune(&mut cycle, 260_000, window));
        cycle.record_pass();
        // Budget spent: the cycle closes rather than nibbling further.
        assert!(!may_prune(&mut cycle, 240_000, window));
    }

    #[test]
    fn target_is_twenty_percent_used() {
        let window = 1_000_000;
        assert!(target_reached(200_000, window));
        assert!(target_reached(199_999, window));
        assert!(!target_reached(200_001, window));
        assert!(!target_reached(0, 0));
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
    fn pressure_reclaim_targets_twenty_percent_used() {
        // Scenario 7: pressure attempts to reduce context toward the 20% target.
        let window = 1_000_000;
        let used = 300_000;
        let reclaim = reclaim_target_tokens(used, window, AUTO_PRUNE_TARGET_PERCENT);
        assert_eq!(used - reclaim as i64, window * AUTO_PRUNE_TARGET_PERCENT / 100);
        assert_eq!(AUTO_PRUNE_TARGET_PERCENT, 20);
    }

    #[test]
    fn completed_turn_evidence_stays_reachable_even_inside_the_keep_recent_budget() {
        // The gap removing the steady trigger would otherwise have opened: one completed
        // output that is large relative to the window sits inside the 10% keep-recent
        // budget, so a recency-only cut makes it permanently unreachable -- and with no
        // backlog trigger left, nothing would ever reclaim it. The session then grows past
        // the boundary with pressure unable to select anything.
        let window = 10_000; // keep budget is 10% of it: 1,000 tokens
        let input = vec![
            user_message("first turn"),
            tool_call("old", "shell", r#"{"cmd":"dump"}"#),
            tool_output("old", &"x".repeat(8_000)), // ~2,000 tokens, alone over budget
            assistant_message("done"),
            user_message("second turn"),
        ];

        let uncovered = uncovered_pressure_tokens(&input, &HashSet::new(), window);
        assert!(
            uncovered > 0,
            "settled evidence before the latest user message must stay eligible"
        );
        assert_eq!(
            select_trigger(/*used_tokens*/ 5_000, uncovered, window),
            Some(PruneTrigger::Pressure)
        );
        assert_eq!(
            build_prune_batch_for_reclaim(&input, &HashSet::new(), 1, window)
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["old"]
        );
    }

    #[test]
    fn the_running_turns_newest_evidence_is_never_eligible() {
        // The other half of the boundary: past the latest user message the recency cut
        // governs, so the observations the next follow-up reasons over stay verbatim.
        let window = 10_000;
        let input = vec![
            user_message("the running turn"),
            tool_output("newest", &"x".repeat(8_000)),
        ];

        assert_eq!(uncovered_pressure_tokens(&input, &HashSet::new(), window), 0);
    }

    #[test]
    fn pressure_still_fires_inside_a_long_running_turn() {
        // Pressure must still work when earlier evidence is already covered: the eligible
        // region is cut by recency, so it reaches into the turn that is still running.
        // This is the case the removed steady trigger could never have handled anyway.
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

        let pressure_uncovered = uncovered_pressure_tokens(&input, &covered, window);
        assert!(pressure_uncovered > 0);
        assert_eq!(
            select_trigger(/*used_tokens*/ 16_000, pressure_uncovered, window),
            Some(PruneTrigger::Pressure)
        );
    }

    #[test]
    fn manual_pruning_is_never_gated_by_the_cycle() {
        // Existing manual behaviour is unchanged: `/prune` passes a requested trigger, so
        // `run_context_prune` never consults the cycle at all. Guard the property the
        // gate depends on -- a cooling cycle blocks only the automatic path.
        let mut cycle = PruneCycle::default();
        cycle.close();
        assert!(!cycle.may_run());
        assert_eq!(PruneTrigger::Manual.as_str(), "manual");
    }

    #[test]
    fn pruning_model_is_luna() {
        assert_eq!(PRUNE_MODEL_SLUG, "gpt-5.6-luna");
    }

    #[test]
    fn no_trigger_fires_for_non_positive_context_window() {
        assert_eq!(select_trigger(200_000, 1_000_000, 0), None);
        assert_eq!(select_trigger(200_000, 1_000_000, -1), None);
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
        let batch = build_manual_prune_batch(&input, &HashSet::new());
        // One oversized output is still eligible on its own; it does not drag a
        // second one into the same call, and it never jams the queue behind itself.
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].0, "a");
    }

    #[test]
    fn uncovered_pressure_backlog_excludes_covered_items() {
        let window = 40_000;
        let input = vec![
            user_message("previous turn"),
            tool_output("a", &"a".repeat(16_000)),
            tool_output("b", &"b".repeat(16_000)),
            user_message("current turn"),
            tool_output("current", &"c".repeat(16_000)),
        ];

        let mut covered = HashSet::new();
        let both = uncovered_pressure_tokens(&input, &covered, window);
        covered.insert("a".to_string());
        let one = uncovered_pressure_tokens(&input, &covered, window);

        // Covering one of the two eligible outputs removes exactly its share; the newest
        // output stays outside the eligible region either way.
        assert!(both > 0);
        assert_eq!(one * 2, both);
    }

    #[test]
    fn manual_batch_skips_covered_ids() {
        let input = vec![
            user_message("previous turn"),
            tool_call("a", "exec_command", r#"{"cmd":"first"}"#),
            tool_output("a", "aaaa"),
            tool_call("b", "exec_command", r#"{"cmd":"second"}"#),
            tool_output("b", "bb"),
        ];
        let covered: HashSet<String> = ["a".to_string()].into_iter().collect();
        let batch = build_manual_prune_batch(&input, &covered);
        assert_eq!(
            batch,
            vec![(
                "b".to_string(),
                "tool: exec_command\ninput: {\"cmd\":\"second\"}\noutput:\nbb".to_string()
            )]
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

        assert!(pressure_uncovered > 0);
        assert_eq!(
            select_trigger(
                /*used_tokens*/ 12_000,
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
            select_trigger(/*used_tokens*/ 16_000, uncovered, window),
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
        // The question is classification context, never part of the deletable batch: it
        // is a message, and only tool output is ever a candidate.
        assert_eq!(
            build_manual_prune_batch(&input, &HashSet::new())
                .iter()
                .map(|(call_id, _)| call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
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

        // The pass seals its region: the marker lands right after the last covered item,
        // so the untouched `b` pair now sits behind it.
        assert!(is_prune_epoch_marker(&input[2]));
        assert_eq!(frozen_prefix_len(&input), 3);

        let ResponseItem::FunctionCallOutput { output, .. } = &input[4] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some(large.as_str()));
    }

    #[test]
    fn each_applied_pass_seals_a_new_epoch_and_never_rewrites_an_earlier_one() {
        // The structural half of the invariant: a later pass may not select anything from
        // a sealed epoch, so the bytes before the newest marker -- and therefore the
        // prompt-cache prefix anchored to it -- survive that pass untouched.
        let large = "x".repeat(2_000);
        let mut input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"first"}"#),
            tool_output("a", &large),
        ];
        apply_prune_record_untracked(
            &mut input,
            &PruneRecord {
                covered_call_ids: vec!["a".to_string()],
                text: "a: kept".to_string(),
            },
        );
        let first_frozen = frozen_prefix_len(&input);
        let epoch_one = input[..first_frozen].to_vec();

        // More work arrives, then a second pass over only the new material.
        input.push(tool_call("b", "exec_command", r#"{"cmd":"second"}"#));
        input.push(tool_output("b", &large));
        // The sealed epoch is not even a candidate, regardless of the covered-id filter.
        let batch = build_manual_prune_batch(&input, &HashSet::new());
        assert_eq!(
            batch.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["b"]
        );

        apply_prune_record_untracked(
            &mut input,
            &PruneRecord {
                covered_call_ids: vec!["b".to_string()],
                text: "b: kept".to_string(),
            },
        );

        assert_eq!(input[..first_frozen], epoch_one[..]);
        assert!(frozen_prefix_len(&input) > first_frozen);
        assert_eq!(
            input.iter().filter(|item| is_prune_epoch_marker(item)).count(),
            2,
            "each pass seals exactly one epoch"
        );
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

        // The dead-end pair leaves no trace; what remains is the kept pair plus the epoch
        // marker that seals the rewritten region.
        assert_eq!(input.len(), 3);
        assert!(matches!(
            &input[0],
            ResponseItem::FunctionCall { call_id, .. } if call_id == "a"
        ));
        assert!(matches!(
            &input[1],
            ResponseItem::FunctionCallOutput { call_id, .. } if call_id == "a"
        ));
        assert!(is_prune_epoch_marker(&input[2]));
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

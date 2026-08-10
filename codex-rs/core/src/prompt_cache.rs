//! Prompt-cache breakpoints for the GPT-5.6+ Responses API.
//!
//! The Responses API caches a *prefix* of the prompt: `instructions`, then `tools`, then
//! `input` up to a breakpoint. A later request whose prefix is byte-identical up to a
//! breakpoint that was previously *written* reads it from cache.
//!
//! The default (implicit) mode places one automatic breakpoint on the latest message
//! **and honours any explicit breakpoints the request carries**. That last part is the
//! whole design here: Elpis stays on implicit and adds its own breakpoints, so it keeps
//! the free rolling-tail write for append-only turns *and* pins the boundaries it needs.
//! `prompt_cache_options.mode = "explicit"` would instead *replace* the automatic
//! breakpoint, costing the tail write to buy nothing extra, so it is not the default.
//!
//! Two boundaries are pinned:
//!
//! * the **stable prefix** -- instructions, tools, and the opening context bundle;
//! * the **frozen epoch boundary** -- the newest `context_pruner` epoch marker, past which
//!   the next pruning pass will start. Pinning it is what makes a pruning pass cheap: the
//!   pass invalidates everything after the boundary, and a cache entry written at the
//!   boundary is exactly what the following request falls back to.
//!
//! Without that second breakpoint, the only entries that survive a pass are ones the
//! server happened to write near the end of some much earlier prompt, so a pass drops the
//! session all the way back to the small initial prefix.
//!
//! A breakpoint is only valid on an `input_text`, `input_image`, or `input_file` content
//! block, so it can never be attached to a reasoning item, a tool call, or a tool output --
//! the bulk of an agent transcript. The epoch marker is a `Message` carrying `input_text`
//! precisely so that this boundary is addressable at all.
//!
//! See `docs/prompt-caching.md` and `docs/cache-friendly-pruning.md`.

use crate::context_pruner;
use codex_api::PromptCacheBreakpointPosition;
use codex_api::PromptCacheMode;
use codex_api::PromptCacheOptions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;

/// First `gpt-<major>.<minor>` family that accepts `prompt_cache_options` and
/// `prompt_cache_breakpoint`. Earlier models reject both fields outright, so they must
/// never be sent to anything below this.
const MIN_EXPLICIT_CACHE_FAMILY: (u32, u32) = (5, 6);

/// Whether `slug` names a model family at or past GPT-5.6.
///
/// Derived from the slug rather than from catalog metadata on purpose: the model catalog
/// is fetched remotely and a catalog that predates this field would silently disable the
/// feature for models that do support it.
pub(crate) fn model_supports_explicit_prompt_cache(slug: &str) -> bool {
    let Some(version) = slug.strip_prefix("gpt-") else {
        return false;
    };
    // Trim the variant suffix: `gpt-5.6-sol` -> `5.6`.
    let version = version.split('-').next().unwrap_or_default();
    let (major, minor) = version.split_once('.').unwrap_or((version, "0"));
    let (Ok(major), Ok(minor)) = (major.parse::<u32>(), minor.parse::<u32>()) else {
        return false;
    };
    (major, minor) >= MIN_EXPLICIT_CACHE_FAMILY
}

/// What one request should send for explicit prompt caching.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PromptCachePlan {
    pub(crate) options: Option<PromptCacheOptions>,
    pub(crate) breakpoints: Vec<PromptCacheBreakpointPosition>,
}

/// Applies the provider/model capability gate before planning request fields.
///
/// The Responses cache fields are not merely optional on unsupported backends: older model
/// families reject them, and non-OpenAI providers do not promise the same wire contract.
pub(crate) fn plan_prompt_cache_for_provider(
    is_openai: bool,
    model_slug: &str,
    input: &[ResponseItem],
    explicit_mode: bool,
) -> PromptCachePlan {
    if is_openai && model_supports_explicit_prompt_cache(model_slug) {
        plan_prompt_cache(input, explicit_mode)
    } else {
        PromptCachePlan::default()
    }
}

/// Places cache breakpoints on `input`.
///
/// Positions, all on message content blocks:
///
/// * **stable prefix** -- the last eligible block in the leading run of instruction and
///   tool-definition items. Nothing rewrites those, so it is the floor every request can
///   fall back to.
/// * **frozen epoch boundary** -- the last eligible block inside `frozen_prefix_len`,
///   which is the newest pruning epoch marker. A pruning pass rewrites only what comes
///   after it, so this entry survives the pass that invalidates everything else.
///
/// When `explicit_mode` is set the server's automatic latest-message breakpoint is
/// disabled, so a **rolling tail** position is added to replace it. On the default
/// implicit path it is deliberately omitted: the server writes that breakpoint itself, and
/// duplicating it would spend one of the four per-request cache writes for nothing.
///
/// The two boundaries usually coincide before the first pruning pass, in which case the
/// plan carries a single breakpoint.
///
/// Returns an empty plan when no eligible block exists. In `explicit_mode` that case must
/// not send `mode = "explicit"`: an explicit-mode request with zero breakpoints does not
/// use prompt caching at all, which is strictly worse than leaving the server on implicit.
pub(crate) fn plan_prompt_cache(input: &[ResponseItem], explicit_mode: bool) -> PromptCachePlan {
    let stable_end = input
        .iter()
        .position(|item| !is_stable_prefix_item(item))
        .unwrap_or(input.len());

    let mut breakpoints = Vec::new();
    let mut push = |position: Option<PromptCacheBreakpointPosition>| {
        if let Some(position) = position
            && !breakpoints.contains(&position)
        {
            breakpoints.push(position);
        }
    };

    push(last_eligible_block(&input[..stable_end]));
    push(last_eligible_block(
        &input[..context_pruner::frozen_prefix_len(input)],
    ));
    if explicit_mode {
        push(last_eligible_block(input));
    }

    if breakpoints.is_empty() {
        return PromptCachePlan::default();
    }
    PromptCachePlan {
        options: explicit_mode.then_some(PromptCacheOptions {
            mode: PromptCacheMode::Explicit,
        }),
        breakpoints,
    }
}

/// Items that belong to the request preamble rather than to the agent loop.
///
/// `AdditionalTools` carries the tool definitions in Responses Lite mode; messages carry
/// the developer instructions, AGENTS.md, and the opening user turn. The first reasoning
/// item, tool call, or assistant message ends the run.
fn is_stable_prefix_item(item: &ResponseItem) -> bool {
    match item {
        ResponseItem::AdditionalTools { .. } => true,
        ResponseItem::Message { role, .. } => role != "assistant",
        _ => false,
    }
}

/// Last block in `items` that the API accepts a breakpoint on.
fn last_eligible_block(items: &[ResponseItem]) -> Option<PromptCacheBreakpointPosition> {
    items.iter().enumerate().rev().find_map(|(item, entry)| {
        let ResponseItem::Message { content, .. } = entry else {
            return None;
        };
        let content = content.iter().rposition(|block| {
            matches!(
                block,
                ContentItem::InputText { .. } | ContentItem::InputImage { .. }
            )
        })?;
        Some(PromptCacheBreakpointPosition { item, content })
    })
}

#[cfg(test)]
#[path = "prompt_cache_tests.rs"]
mod tests;

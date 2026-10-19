//! Smart Prune on one Anthropic Messages request body.
//!
//! Only the `tool_result` blocks after the last assistant message are candidates. The proxy stores
//! each decision under its `tool_use_id` and applies it to the same block in every later
//! request. Thus the proxy changes a block only at its first exposure, and the prefix that
//! Anthropic caches stays the same after that.

use std::collections::HashMap;

use codex_core::MAX_PRUNE_BATCH_TOKENS;
use codex_core::MIN_SOURCE_TOKENS;
use codex_utils_string::approx_token_count;
use serde_json::Value;

/// A decision for one block: the admitted text, or `None` to send the source unchanged.
pub(crate) type Decisions = HashMap<String, Option<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) tool_use_id: String,
    pub(crate) source: String,
    pub(crate) source_tokens: usize,
}

/// Replaces each decided block with its stored form. Returns true when the body changed.
pub(crate) fn apply_decisions(body: &mut Value, decisions: &Decisions) -> bool {
    let mut changed = false;
    for block in tool_result_blocks_mut(body) {
        let Some(Some(admitted)) = block_id(block).and_then(|id| decisions.get(id)) else {
            continue;
        };
        let admitted = admitted.clone();
        changed |= set_block_text(block, admitted);
    }
    changed
}

/// The undecided, eligible blocks after the last assistant message, within one batch limit.
pub(crate) fn candidates(body: &Value, decisions: &Decisions) -> Vec<Candidate> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // The newest results follow the last assistant message. Claude Code can put a
    // `system` message after them, so the last message alone is not enough.
    let newest = messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map_or(messages, |index| &messages[index + 1..]);
    let mut selected = Vec::new();
    let mut selected_tokens = 0usize;
    for block in newest
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .flat_map(content_blocks)
    {
        let Some(id) = block_id(block) else { continue };
        if decisions.contains_key(id)
            || block.get("is_error").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(source) = block_text(block) else {
            continue;
        };
        let source_tokens = approx_token_count(&source);
        if source_tokens < MIN_SOURCE_TOKENS
            || selected_tokens.saturating_add(source_tokens) > MAX_PRUNE_BATCH_TOKENS
        {
            continue;
        }
        selected_tokens = selected_tokens.saturating_add(source_tokens);
        selected.push(Candidate {
            tool_use_id: id.to_string(),
            source,
            source_tokens,
        });
    }
    selected
}

/// Each `tool_result` block of the body that holds text, with its approximate tokens.
pub(crate) fn tool_results(body: &Value) -> Vec<(String, usize)> {
    body.get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .flat_map(content_blocks)
        .filter_map(|block| {
            let id = block_id(block)?;
            Some((id.to_string(), approx_token_count(&block_text(block)?)))
        })
        .collect()
}

/// The optimizer input. It has the same shape as the input of an Elpis session, so one
/// prompt serves both paths.
pub(crate) fn admission_input(body: &Value, candidates: &[Candidate]) -> String {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let active_request = messages
        .iter()
        .rev()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .find_map(user_text);
    let items = candidates
        .iter()
        .map(|candidate| {
            let invocation = messages
                .iter()
                .flat_map(content_blocks)
                .find(|block| {
                    block.get("type").and_then(Value::as_str) == Some("tool_use")
                        && block.get("id").and_then(Value::as_str)
                            == Some(candidate.tool_use_id.as_str())
                })
                .cloned();
            serde_json::json!({
                "call_id": candidate.tool_use_id,
                "source_tokens_estimate": candidate.source_tokens,
                "invocation": invocation,
                "source_output": candidate.source,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "active_request": active_request,
        "items": items,
    })
    .to_string()
}

fn content_blocks(message: &Value) -> impl Iterator<Item = &Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn tool_result_blocks_mut(body: &mut Value) -> impl Iterator<Item = &mut Value> {
    body.get_mut("messages")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|message| message.get_mut("content").and_then(Value::as_array_mut))
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
}

fn block_id(block: &Value) -> Option<&str> {
    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        return None;
    }
    block.get("tool_use_id").and_then(Value::as_str)
}

/// The text of a tool result, or `None` when it holds anything but text.
fn block_text(block: &Value) -> Option<String> {
    match block.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                (part.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| part.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.join("\n")),
        _ => None,
    }
}

/// Puts `text` in place of the block content. A text-part list becomes one text part that
/// keeps the `cache_control` of the last part, so a cache breakpoint is not lost.
fn set_block_text(block: &mut Value, text: String) -> bool {
    let replacement = match block.get("content") {
        Some(Value::Array(parts)) => {
            let mut part = serde_json::json!({ "type": "text", "text": text });
            if let Some(cache_control) = parts.last().and_then(|part| part.get("cache_control")) {
                part["cache_control"] = cache_control.clone();
            }
            Value::Array(vec![part])
        }
        _ => Value::String(text),
    };
    if block.get("content") == Some(&replacement) {
        return false;
    }
    block["content"] = replacement;
    true
}

fn user_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "prune_tests.rs"]
mod tests;

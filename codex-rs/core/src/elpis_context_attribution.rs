//! Elpis: estimated composition of each built request, for the Context Ledger's CONTEXT WINDOW
//! and the dashboard's Context tab.
//!
//! The classifier is copied from v0.3.0 `client_common.rs` (`context_attribution_snapshot` and
//! `context_attribution_for_input`). v0.3.0 carried the snapshot on `TokenCountEvent`; here the
//! latest snapshot is thread extension data, which the app server reads when it forwards token
//! usage (`app-server/src/elpis_turn_activity.rs`), so no core event changes shape.
//!
//! Values are local estimates from the exact `Prompt`. They are never scaled or padded to match
//! provider token usage, and they carry sizes only, never message content.

use codex_extension_api::ExtensionData;
use codex_protocol::models::ResponseItem;
use codex_utils_string::approx_token_count;
use codex_utils_string::approx_tokens_from_byte_count;

use crate::client_common::Prompt;
use crate::context_manager::estimate_item_token_count;

/// Estimated tokens per category in one fully built request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContextAttributionSnapshot {
    pub system_instructions: u64,
    pub developer_messages: u64,
    pub user_messages: u64,
    pub agent_messages: u64,
    pub reasoning: u64,
    pub tool_calls: u64,
    pub tool_results: u64,
    pub tool_definitions: u64,
    pub output_schema: u64,
    pub unrecognized_items: u64,
    pub estimated_total: u64,
}

/// The thread's latest snapshot, keyed by type in the thread's extension data.
#[derive(Debug, Clone)]
struct LatestContextAttribution(ContextAttributionSnapshot);

/// The latest request composition recorded for this thread, if a prompt has been built.
pub fn latest(thread_data: &ExtensionData) -> Option<ContextAttributionSnapshot> {
    thread_data
        .get::<LatestContextAttribution>()
        .map(|latest| latest.0.clone())
}

/// Record `input` classified against `prompt`'s instructions, tools and output schema.
///
/// Called with the prompt's own input right before a provider attempt, and with the retained
/// history once the response and its pending tools complete, as in v0.3.0.
pub(crate) fn record(thread_data: &ExtensionData, prompt: &Prompt, input: &[ResponseItem]) {
    thread_data.insert(LatestContextAttribution(classify(prompt, input)));
}

pub(crate) fn classify(prompt: &Prompt, input: &[ResponseItem]) -> ContextAttributionSnapshot {
    let mut snapshot = ContextAttributionSnapshot {
        system_instructions: u64::try_from(approx_token_count(&prompt.base_instructions.text))
            .unwrap_or(u64::MAX),
        tool_definitions: (!prompt.tools.is_empty())
            .then(|| serde_json::to_vec(&prompt.tools[..]).ok())
            .flatten()
            .map_or(0, |value| approx_tokens_from_byte_count(value.len())),
        output_schema: prompt
            .output_schema
            .as_ref()
            .and_then(|schema| serde_json::to_vec(schema).ok())
            .map_or(0, |value| approx_tokens_from_byte_count(value.len())),
        ..Default::default()
    };

    for item in input {
        let tokens = u64::try_from(estimate_item_token_count(item).max(0)).unwrap_or(u64::MAX);
        let target = match item {
            ResponseItem::Message { role, .. } if role == "system" => {
                &mut snapshot.system_instructions
            }
            ResponseItem::Message { role, .. } if role == "developer" => {
                &mut snapshot.developer_messages
            }
            ResponseItem::Message { role, .. } if role == "user" => &mut snapshot.user_messages,
            ResponseItem::Message { role, .. } if role == "assistant" => {
                &mut snapshot.agent_messages
            }
            ResponseItem::AgentMessage { .. } => &mut snapshot.agent_messages,
            ResponseItem::Reasoning { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::ContextCompaction { .. } => &mut snapshot.reasoning,
            ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. } => &mut snapshot.tool_calls,
            ResponseItem::FunctionCallOutput { .. }
            | ResponseItem::CustomToolCallOutput { .. }
            | ResponseItem::ToolSearchOutput { .. } => &mut snapshot.tool_results,
            ResponseItem::AdditionalTools { .. } => &mut snapshot.tool_definitions,
            ResponseItem::Message { .. }
            | ResponseItem::ConfigurationUpdate { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::Other => &mut snapshot.unrecognized_items,
        };
        *target = target.saturating_add(tokens);
    }

    snapshot.estimated_total = snapshot
        .system_instructions
        .saturating_add(snapshot.developer_messages)
        .saturating_add(snapshot.user_messages)
        .saturating_add(snapshot.agent_messages)
        .saturating_add(snapshot.reasoning)
        .saturating_add(snapshot.tool_calls)
        .saturating_add(snapshot.tool_results)
        .saturating_add(snapshot.tool_definitions)
        .saturating_add(snapshot.output_schema)
        .saturating_add(snapshot.unrecognized_items);
    snapshot
}

#[cfg(test)]
#[path = "elpis_context_attribution_tests.rs"]
mod tests;

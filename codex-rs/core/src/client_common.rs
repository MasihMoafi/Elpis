pub use codex_api::ResponseEvent;
use codex_protocol::error::Result;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::ContextAttributionSnapshot;
use codex_tools::ToolSpec;
use codex_utils_string::approx_token_count;
use codex_utils_string::approx_tokens_from_byte_count;
use futures::Stream;
use serde_json::Value;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// API request payload for a single model turn
#[derive(Debug, Clone)]
pub struct Prompt {
    /// Conversation context input items.
    pub input: Vec<ResponseItem>,

    /// Tools available to the model, including additional tools sourced from
    /// external MCP servers.
    pub(crate) tools: Vec<ToolSpec>,

    /// Whether parallel tool calls are permitted for this prompt.
    pub(crate) parallel_tool_calls: bool,

    pub base_instructions: BaseInstructions,

    /// Optional the output schema for the model's response.
    pub output_schema: Option<Value>,

    /// Whether the Responses API should strictly validate `output_schema`.
    pub output_schema_strict: bool,
}

impl Default for Prompt {
    fn default() -> Self {
        Self {
            input: Vec::new(),
            tools: Vec::new(),
            parallel_tool_calls: false,
            base_instructions: BaseInstructions::default(),
            output_schema: None,
            output_schema_strict: true,
        }
    }
}

impl Prompt {
    pub(crate) fn get_formatted_input_for_request(
        &self,
        use_responses_lite: bool,
    ) -> Vec<ResponseItem> {
        let mut input = self.input.clone();
        if use_responses_lite {
            strip_image_details(&mut input);
        }
        input
    }

    /// Classify the actual model-visible prompt after history, instructions, and
    /// tool definitions have been fixed for this provider attempt.
    pub(crate) fn context_attribution_snapshot(&self) -> ContextAttributionSnapshot {
        self.context_attribution_for_input(&self.input)
    }

    /// Reuse the request's instructions and tool schema while classifying the
    /// retained history after streamed responses and pending tools complete.
    pub(crate) fn context_attribution_for_input(
        &self,
        input: &[ResponseItem],
    ) -> ContextAttributionSnapshot {
        let mut snapshot = ContextAttributionSnapshot {
            system_instructions: u64::try_from(approx_token_count(&self.base_instructions.text))
                .unwrap_or(u64::MAX),
            tool_definitions: (!self.tools.is_empty())
                .then(|| serde_json::to_vec(&self.tools).ok())
                .flatten()
                .map_or(0, |value| approx_tokens_from_byte_count(value.len())),
            output_schema: self
                .output_schema
                .as_ref()
                .and_then(|schema| serde_json::to_vec(schema).ok())
                .map_or(0, |value| approx_tokens_from_byte_count(value.len())),
            ..Default::default()
        };

        for item in input {
            let tokens = crate::context_manager::estimate_response_item_tokens(item);
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
}

fn strip_image_details(items: &mut [ResponseItem]) {
    for item in items {
        match item {
            ResponseItem::Message { content, .. } => {
                for content_item in content {
                    if let ContentItem::InputImage { detail, .. } = content_item {
                        *detail = None;
                    }
                }
            }
            ResponseItem::FunctionCallOutput { output, .. }
            | ResponseItem::CustomToolCallOutput { output, .. } => {
                if let Some(content) = output.content_items_mut() {
                    for content_item in content {
                        if let FunctionCallOutputContentItem::InputImage { detail, .. } =
                            content_item
                        {
                            *detail = None;
                        }
                    }
                }
            }
            ResponseItem::AdditionalTools { .. }
            | ResponseItem::Reasoning { .. }
            | ResponseItem::AgentMessage { .. }
            | ResponseItem::LocalShellCall { .. }
            | ResponseItem::FunctionCall { .. }
            | ResponseItem::ToolSearchCall { .. }
            | ResponseItem::CustomToolCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::WebSearchCall { .. }
            | ResponseItem::ImageGenerationCall { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::Other => {}
        }
    }
}

pub struct ResponseStream {
    pub(crate) rx_event: mpsc::Receiver<Result<ResponseEvent>>,
    /// Signals the mapper task that the consumer stopped polling before the
    /// provider stream reached its own terminal event.
    pub(crate) consumer_dropped: CancellationToken,
}

impl Stream for ResponseStream {
    type Item = Result<ResponseEvent>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx_event.poll_recv(cx)
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        self.consumer_dropped.cancel();
    }
}

#[cfg(test)]
#[path = "client_common_tests.rs"]
mod tests;

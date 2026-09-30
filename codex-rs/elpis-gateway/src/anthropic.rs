//! Anthropic Messages.
//!
//! Adapted from v0.3.0's `anthropic_request` and `stream_anthropic_events`
//! (`core/src/chat_completions.rs`). A text block closes before a tool call is emitted, so each
//! Responses item completes in order.

use std::collections::HashMap;

use serde_json::Value;
use serde_json::json;

use crate::GatewayError;
use crate::conversation::Conversation;
use crate::conversation::Turn;
use crate::emitter::Emitter;
use crate::emitter::StreamError;
use crate::emitter::Usage;

/// The canonical request has no provider-neutral output limit, so Anthropic's required
/// `max_tokens` is fixed, as in v0.3.0.
const ANTHROPIC_MAX_TOKENS: u64 = 8192;

pub(crate) fn request(conversation: &Conversation) -> Result<Value, GatewayError> {
    let mut system = vec![conversation.instructions.clone()];
    let mut messages = Vec::<Value>::new();
    let mut current_role: Option<&str> = None;
    let mut current_content = Vec::<Value>::new();

    let flush = |messages: &mut Vec<Value>, role: &mut Option<&str>, content: &mut Vec<Value>| {
        if let Some(role) = role.take()
            && !content.is_empty()
        {
            messages.push(json!({"role": role, "content": std::mem::take(content)}));
        }
    };

    for turn in &conversation.turns {
        let (role, block) = match turn {
            Turn::System(text) => {
                system.push(text.clone());
                continue;
            }
            Turn::User(text) => ("user", json!({"type": "text", "text": text})),
            Turn::Assistant(text) => ("assistant", json!({"type": "text", "text": text})),
            Turn::ToolCall {
                call_id,
                name,
                arguments,
            } => (
                "assistant",
                json!({
                    "type": "tool_use",
                    "id": call_id,
                    "name": name,
                    "input": parse_object(arguments, "Anthropic tool input")?,
                }),
            ),
            Turn::ToolResult { call_id, output } => (
                "user",
                json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": output,
                }),
            ),
        };
        if current_role != Some(role) {
            flush(&mut messages, &mut current_role, &mut current_content);
            current_role = Some(role);
        }
        current_content.push(block);
    }
    flush(&mut messages, &mut current_role, &mut current_content);

    let system: Vec<Value> = system
        .into_iter()
        .filter(|text| !text.trim().is_empty())
        .map(|text| json!({"type": "text", "text": text}))
        .collect();
    let mut body = json!({
        "model": conversation.model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "stream": true,
        "messages": messages,
    });
    if !system.is_empty() {
        body["system"] = Value::Array(system);
    }
    if !conversation.tools.is_empty() {
        body["tools"] = Value::Array(
            conversation
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    Ok(body)
}

pub(crate) fn parse_object(text: &str, label: &str) -> Result<Value, GatewayError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| GatewayError::bad_request(format!("{label} is not valid JSON: {error}")))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(GatewayError::bad_request(format!(
            "{label} must be a JSON object"
        )))
    }
}

#[derive(Debug, Default)]
struct ToolAccumulator {
    name: String,
    call_id: String,
    arguments: String,
}

#[derive(Debug, Default)]
pub(crate) struct AnthropicStream {
    usage: Usage,
    stop_reason: Option<String>,
    tools: HashMap<u64, ToolAccumulator>,
    called_tool: bool,
}

impl AnthropicStream {
    pub(crate) fn on_event(
        &mut self,
        event: &str,
        data: &str,
        out: &mut Emitter,
    ) -> Result<(), StreamError> {
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|error| {
            StreamError::new(format!("invalid Anthropic stream payload: {error}"))
        })?;
        let kind = value.get("type").and_then(Value::as_str).unwrap_or(event);
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
        match kind {
            "message_start" => {
                let number = |key: &str| {
                    value
                        .pointer(&format!("/message/usage/{key}"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                };
                self.usage.input_tokens = number("input_tokens")
                    + number("cache_creation_input_tokens")
                    + number("cache_read_input_tokens");
                self.usage.cached_input_tokens = number("cache_read_input_tokens");
                self.usage.cache_write_tokens = number("cache_creation_input_tokens");
                self.usage.output_tokens = number("output_tokens");
            }
            "content_block_start" => {
                match value.pointer("/content_block/type").and_then(Value::as_str) {
                    Some("text") => {
                        out.text(
                            value
                                .pointer("/content_block/text")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        );
                    }
                    Some("tool_use") => {
                        out.close_message();
                        let arguments = value
                            .pointer("/content_block/input")
                            .filter(|input| input.as_object().is_some_and(|input| !input.is_empty()))
                            .map(Value::to_string)
                            .unwrap_or_default();
                        self.tools.insert(
                            index,
                            ToolAccumulator {
                                name: text_at(&value, "/content_block/name"),
                                call_id: text_at(&value, "/content_block/id"),
                                arguments,
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                match value.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        out.text(
                            value
                                .pointer("/delta/text")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                        );
                    }
                    Some("input_json_delta") => {
                        if let Some(tool) = self.tools.get_mut(&index) {
                            tool.arguments.push_str(
                                value
                                    .pointer("/delta/partial_json")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default(),
                            );
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(tool) = self.tools.remove(&index) {
                    let arguments = if tool.arguments.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        tool.arguments
                    };
                    if tool.name.is_empty()
                        || tool.call_id.is_empty()
                        || !serde_json::from_str::<Value>(&arguments).is_ok_and(|v| v.is_object())
                    {
                        return Err(StreamError::new(
                            "Anthropic returned an incomplete tool call",
                        ));
                    }
                    out.tool_call(&tool.name, &tool.call_id, &arguments)?;
                    self.called_tool = true;
                }
            }
            "message_delta" => {
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
                if let Some(output_tokens) = value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_i64)
                {
                    self.usage.output_tokens = output_tokens;
                }
            }
            "message_stop" => {
                if !self.tools.is_empty() {
                    return Err(StreamError::new(
                        "the Anthropic stream stopped inside a tool call",
                    ));
                }
                let end_turn = if self.called_tool {
                    Some(false)
                } else {
                    anthropic_end_turn(self.stop_reason.as_deref())
                };
                out.completed(Some(&self.usage), end_turn);
            }
            "error" => {
                let error_type = value
                    .pointer("/error/type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let message = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic stream error")
                    .to_string();
                return Err(if error_type == "overloaded_error" {
                    StreamError::with_code("server_is_overloaded", message)
                } else {
                    StreamError::new(message)
                });
            }
            _ => {}
        }
        Ok(())
    }
}

fn text_at(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn anthropic_end_turn(reason: Option<&str>) -> Option<bool> {
    match reason {
        Some("end_turn" | "stop_sequence") => Some(true),
        Some("tool_use" | "max_tokens" | "pause_turn" | "refusal") => Some(false),
        Some(_) | None => None,
    }
}

#[cfg(test)]
#[path = "anthropic_tests.rs"]
mod tests;

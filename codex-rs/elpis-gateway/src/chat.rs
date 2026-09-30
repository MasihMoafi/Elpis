//! OpenAI-compatible Chat Completions (OpenRouter, DeepSeek, local servers).
//!
//! Adapted from v0.3.0's `chat_completions_request` and `stream_chat_completions_events`
//! (`core/src/chat_completions.rs`). Differences, each deliberate: an assistant message that
//! precedes tool calls carries them instead of being followed by a second assistant message;
//! a stream must report a finish reason, so a cut-off stream fails instead of completing; tool
//! calls are accepted under any finish reason except `length`, because several providers report
//! `stop` for a turn that called tools.

use std::collections::BTreeMap;

use serde_json::Value;
use serde_json::json;

use crate::conversation::Conversation;
use crate::conversation::Turn;
use crate::emitter::Emitter;
use crate::emitter::StreamError;
use crate::emitter::Usage;
use crate::emitter::new_id;
use crate::vendor_error_message;

pub(crate) fn request(conversation: &Conversation) -> Value {
    let mut messages = Vec::<Value>::new();
    let instructions = conversation.instructions.trim();
    if !instructions.is_empty() {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    for turn in &conversation.turns {
        match turn {
            Turn::System(text) => messages.push(json!({"role": "system", "content": text})),
            Turn::User(text) => messages.push(json!({"role": "user", "content": text})),
            Turn::Assistant(text) => messages.push(json!({"role": "assistant", "content": text})),
            Turn::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                let call = json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                });
                match messages.last_mut() {
                    Some(previous) if previous["role"] == "assistant" => {
                        match previous
                            .get_mut("tool_calls")
                            .and_then(Value::as_array_mut)
                        {
                            Some(calls) => calls.push(call),
                            None => previous["tool_calls"] = json!([call]),
                        }
                    }
                    _ => messages.push(json!({
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [call],
                    })),
                }
            }
            Turn::ToolResult { call_id, output } => messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": output,
            })),
        }
    }

    let mut body = json!({
        "model": conversation.model,
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    if !conversation.tools.is_empty() {
        body["tools"] = Value::Array(
            conversation
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        },
                    })
                })
                .collect(),
        );
    }
    // OpenRouter's reasoning control, as v0.3.0 sent it. Core only sets an effort when the
    // model's catalog entry offers levels, which the gateway's catalog does only for models
    // whose listing says they accept `reasoning`.
    if let Some(effort) = &conversation.reasoning_effort {
        body["reasoning"] = json!({"effort": effort});
    }
    // Schema-dependent callers (titles, memory) need structured output on this wire too.
    if let Some(format) = &conversation.output_format {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {
                "name": format.name,
                "strict": format.strict,
                "schema": format.schema,
            },
        });
    }
    body
}

#[derive(Debug, Default)]
struct ToolAccumulator {
    name: String,
    call_id: String,
    arguments: String,
}

#[derive(Debug, Default)]
pub(crate) struct ChatStream {
    tools: BTreeMap<u64, ToolAccumulator>,
    finish_reason: Option<String>,
    usage: Option<Usage>,
}

impl ChatStream {
    pub(crate) fn on_event(&mut self, data: &str, out: &mut Emitter) -> Result<(), StreamError> {
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            return self.finish(out);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| StreamError::new(format!("invalid Chat stream payload: {error}")))?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            return Err(StreamError::new(vendor_error_message(
                &json!({ "error": error }),
                "the Chat provider reported an error",
            )));
        }
        if let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_string());
            }
            let calls = choice
                .pointer("/delta/tool_calls")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| StreamError::new("a Chat tool call is missing its index"))?;
                let tool = self.tools.entry(index).or_default();
                if let Some(id) = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    if !tool.call_id.is_empty() && tool.call_id != id {
                        return Err(StreamError::new("a Chat tool call changed its ID"));
                    }
                    tool.call_id = id.to_string();
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    tool.name.push_str(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
                    tool.arguments.push_str(arguments);
                }
            }
            if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
                out.text(text);
            }
        }
        if let Some(usage) = value.get("usage").filter(|usage| usage.is_object()) {
            self.usage = Some(chat_usage(usage));
        }
        Ok(())
    }

    pub(crate) fn on_end(&mut self, out: &mut Emitter) -> Result<(), StreamError> {
        self.finish(out)
    }

    fn finish(&mut self, out: &mut Emitter) -> Result<(), StreamError> {
        let Some(finish_reason) = self.finish_reason.take() else {
            return Err(StreamError::new(
                "the Chat stream ended before reporting a finish reason",
            ));
        };
        let tools = std::mem::take(&mut self.tools);
        if !tools.is_empty() && finish_reason == "length" {
            return Err(StreamError::new(
                "the Chat stream hit its length limit in the middle of a tool call",
            ));
        }
        let mut calls = Vec::with_capacity(tools.len());
        for tool in tools.into_values() {
            let arguments = if tool.arguments.trim().is_empty() {
                "{}".to_string()
            } else {
                tool.arguments
            };
            if tool.name.is_empty() || serde_json::from_str::<Value>(&arguments).is_err() {
                return Err(StreamError::new(
                    "the Chat stream returned an incomplete tool call",
                ));
            }
            let call_id = if tool.call_id.is_empty() {
                new_id("call")
            } else {
                tool.call_id
            };
            calls.push((tool.name, call_id, arguments));
        }
        out.close_message();
        for (name, call_id, arguments) in &calls {
            out.tool_call(name, call_id, arguments)?;
        }
        out.completed(self.usage.as_ref(), Some(calls.is_empty()));
        Ok(())
    }
}

fn chat_usage(usage: &Value) -> Usage {
    let number = |pointer: &str| usage.pointer(pointer).and_then(Value::as_i64).unwrap_or(0);
    Usage {
        input_tokens: number("/prompt_tokens"),
        cached_input_tokens: number("/prompt_tokens_details/cached_tokens"),
        cache_write_tokens: 0,
        output_tokens: number("/completion_tokens"),
        reasoning_output_tokens: number("/completion_tokens_details/reasoning_tokens"),
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;

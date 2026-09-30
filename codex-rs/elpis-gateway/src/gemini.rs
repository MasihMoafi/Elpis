//! Gemini `streamGenerateContent`.
//!
//! Adapted from v0.3.0's `gemini_request` and `stream_gemini_events`
//! (`core/src/chat_completions.rs`). Tool schemas go out as `parametersJsonSchema`, which takes
//! full JSON Schema, instead of `parameters`, whose OpenAPI subset rejects keys such as
//! `additionalProperties` that Elpis tool schemas use.

use std::collections::HashMap;
use std::collections::HashSet;

use serde_json::Value;
use serde_json::json;

use crate::GatewayError;
use crate::anthropic::parse_object;
use crate::conversation::Conversation;
use crate::conversation::GEMINI_SIGNATURE_PREFIX;
use crate::conversation::Turn;
use crate::emitter::Emitter;
use crate::emitter::StreamError;
use crate::emitter::Usage;
use crate::emitter::new_id;

pub(crate) fn request(conversation: &Conversation) -> Result<Value, GatewayError> {
    let mut system = vec![conversation.instructions.clone()];
    let mut contents = Vec::<Value>::new();
    let mut current_role: Option<&str> = None;
    let mut current_parts = Vec::<Value>::new();
    let mut call_names = HashMap::<&str, &str>::new();

    let flush = |contents: &mut Vec<Value>, role: &mut Option<&str>, parts: &mut Vec<Value>| {
        if let Some(role) = role.take()
            && !parts.is_empty()
        {
            contents.push(json!({"role": role, "parts": std::mem::take(parts)}));
        }
    };

    for turn in &conversation.turns {
        let (role, part) = match turn {
            Turn::System(text) => {
                system.push(text.clone());
                continue;
            }
            Turn::User(text) => ("user", json!({"text": text})),
            Turn::Assistant(text) => ("model", json!({"text": text})),
            Turn::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                call_names.insert(call_id.as_str(), name.as_str());
                let mut part = json!({
                    "functionCall": {
                        "id": call_id,
                        "name": name,
                        "args": parse_object(arguments, "Gemini function arguments")?,
                    }
                });
                if let Some(signature) = conversation.gemini_signatures.get(call_id) {
                    part["thoughtSignature"] = json!(signature);
                }
                ("model", part)
            }
            Turn::ToolResult { call_id, output } => {
                let name = call_names.get(call_id.as_str()).ok_or_else(|| {
                    GatewayError::bad_request(format!(
                        "Gemini function result `{call_id}` has no preceding function call"
                    ))
                })?;
                (
                    "user",
                    json!({
                        "functionResponse": {
                            "id": call_id,
                            "name": name,
                            "response": {"output": output},
                        }
                    }),
                )
            }
        };
        if current_role != Some(role) {
            flush(&mut contents, &mut current_role, &mut current_parts);
            current_role = Some(role);
        }
        current_parts.push(part);
    }
    flush(&mut contents, &mut current_role, &mut current_parts);

    let system: Vec<Value> = system
        .into_iter()
        .filter(|text| !text.trim().is_empty())
        .map(|text| json!({"text": text}))
        .collect();
    let mut body = json!({"contents": contents});
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts": system});
    }
    if !conversation.tools.is_empty() {
        let declarations: Vec<Value> = conversation
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parametersJsonSchema": tool.parameters,
                })
            })
            .collect();
        body["tools"] = json!([{"functionDeclarations": declarations}]);
        body["toolConfig"] = json!({"functionCallingConfig": {"mode": "AUTO"}});
    }
    Ok(body)
}

#[derive(Debug, Default)]
pub(crate) struct GeminiStream {
    usage: Option<Usage>,
    called_tool: bool,
    seen_calls: HashSet<String>,
}

impl GeminiStream {
    pub(crate) fn on_event(&mut self, data: &str, out: &mut Emitter) -> Result<(), StreamError> {
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| StreamError::new(format!("invalid Gemini stream payload: {error}")))?;
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Gemini stream error")
                .to_string();
            return Err(
                if error.get("status").and_then(Value::as_str) == Some("UNAVAILABLE") {
                    StreamError::with_code("server_is_overloaded", message)
                } else {
                    StreamError::new(message)
                },
            );
        }
        if let Some(metadata) = value.get("usageMetadata") {
            self.usage = Some(gemini_usage(metadata));
        }
        if let Some(reason) = value
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            return Err(StreamError::new(format!(
                "Gemini blocked the prompt: {reason}"
            )));
        }
        // Gemini may return several candidates; only the first is the answer, as in v0.3.0.
        let Some(candidate) = value
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
        else {
            return Ok(());
        };
        let parts = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for part in parts {
            // Thought summaries are the model's reasoning, not its answer.
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                out.text(text);
            }
            if let Some(call) = part.get("functionCall") {
                self.function_call(call, part.get("thoughtSignature"), out)?;
            }
        }
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            let end_turn = if self.called_tool {
                Some(false)
            } else {
                gemini_end_turn(reason)
            };
            out.completed(self.usage.as_ref(), end_turn);
        }
        Ok(())
    }

    fn function_call(
        &mut self,
        call: &Value,
        signature: Option<&Value>,
        out: &mut Emitter,
    ) -> Result<(), StreamError> {
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| StreamError::new("Gemini returned a function call without a name"))?;
        let arguments = call
            .get("args")
            .cloned()
            .unwrap_or_else(|| json!({}))
            .to_string();
        let id = call.get("id").and_then(Value::as_str);
        // Gemini can repeat a complete function call in a later chunk.
        if !self
            .seen_calls
            .insert(format!("{}:{name}:{arguments}", id.unwrap_or_default()))
        {
            return Ok(());
        }
        let call_id = id
            .filter(|id| !id.is_empty())
            .map_or_else(|| new_id("gemini_call"), str::to_string);
        if let Some(signature) = signature.and_then(Value::as_str) {
            out.reasoning_state(format!(
                "{GEMINI_SIGNATURE_PREFIX}{}",
                json!({"call_id": call_id, "signature": signature})
            ));
        }
        out.tool_call(name, &call_id, &arguments)?;
        self.called_tool = true;
        Ok(())
    }
}

fn gemini_usage(metadata: &Value) -> Usage {
    let number = |key: &str| metadata.get(key).and_then(Value::as_i64).unwrap_or(0);
    let thoughts = number("thoughtsTokenCount");
    Usage {
        input_tokens: number("promptTokenCount"),
        cached_input_tokens: number("cachedContentTokenCount"),
        cache_write_tokens: 0,
        output_tokens: number("candidatesTokenCount") + thoughts,
        reasoning_output_tokens: thoughts,
    }
}

fn gemini_end_turn(reason: &str) -> Option<bool> {
    match reason {
        "STOP" => Some(true),
        "FINISH_REASON_UNSPECIFIED" => None,
        "MAX_TOKENS"
        | "SAFETY"
        | "RECITATION"
        | "LANGUAGE"
        | "OTHER"
        | "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "MALFORMED_FUNCTION_CALL"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "NO_IMAGE"
        | "IMAGE_RECITATION" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
#[path = "gemini_tests.rs"]
mod tests;

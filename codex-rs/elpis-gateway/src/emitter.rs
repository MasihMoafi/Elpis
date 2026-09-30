//! Builds the Responses stream events core's parser reads (`codex-api/src/sse/responses.rs`).
//!
//! Every output item is announced with `response.output_item.added` before any delta, as the
//! Responses API does: core only streams text into an item that is already open. Tool calls are
//! restored to the names core registered, and freeform tools return as `custom_tool_call` items.

use codex_model_provider_info::GatewayWire;
use serde_json::Value;
use serde_json::json;

use crate::anthropic::AnthropicStream;
use crate::chat::ChatStream;
use crate::conversation::ToolMap;
use crate::gemini::GeminiStream;

/// A vendor stream that cannot be turned into a complete response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamError {
    /// A Responses error code core recognizes, such as `server_is_overloaded`. Without one,
    /// core treats the failure as retryable.
    pub(crate) code: Option<&'static str>,
    pub(crate) message: String,
}

impl StreamError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
        }
    }
}

/// Token counts in Responses terms: `input_tokens` includes cached input, and `output_tokens`
/// includes reasoning.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    pub(crate) input_tokens: i64,
    pub(crate) cached_input_tokens: i64,
    pub(crate) cache_write_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) reasoning_output_tokens: i64,
}

impl Usage {
    fn to_json(&self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "input_tokens_details": {
                "cached_tokens": self.cached_input_tokens,
                "cache_write_tokens": self.cache_write_tokens,
            },
            "output_tokens": self.output_tokens,
            "output_tokens_details": {"reasoning_tokens": self.reasoning_output_tokens},
            "total_tokens": self.input_tokens + self.output_tokens,
        })
    }
}

#[derive(Debug)]
struct OpenMessage {
    id: String,
    text: String,
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// Accumulates the Responses events for one response.
#[derive(Debug)]
pub(crate) struct Emitter {
    response_id: String,
    message: Option<OpenMessage>,
    tools: ToolMap,
    events: Vec<Value>,
    finished: bool,
}

impl Emitter {
    pub(crate) fn new(tools: ToolMap) -> Self {
        Self {
            response_id: new_id("resp"),
            message: None,
            tools,
            events: Vec::new(),
            finished: false,
        }
    }

    pub(crate) fn created(&mut self) {
        self.events.push(json!({
            "type": "response.created",
            "response": {"id": self.response_id, "status": "in_progress"},
        }));
    }

    /// Streams assistant text, opening the message item first when needed.
    pub(crate) fn text(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if self.message.is_none() {
            let id = new_id("msg");
            self.events.push(json!({
                "type": "response.output_item.added",
                "item": assistant_message(&id, ""),
            }));
            self.message = Some(OpenMessage {
                id,
                text: String::new(),
            });
        }
        if let Some(message) = self.message.as_mut() {
            message.text.push_str(delta);
            self.events.push(json!({
                "type": "response.output_text.delta",
                "item_id": message.id,
                "delta": delta,
            }));
        }
    }

    /// Completes the open assistant message, if any. Later text opens a new message.
    pub(crate) fn close_message(&mut self) {
        if let Some(message) = self.message.take() {
            self.events.push(json!({
                "type": "response.output_item.done",
                "item": assistant_message(&message.id, &message.text),
            }));
        }
    }

    /// Emits one complete tool call under the name core registered for `alias`.
    pub(crate) fn tool_call(
        &mut self,
        alias: &str,
        call_id: &str,
        arguments: &str,
    ) -> Result<(), StreamError> {
        self.close_message();
        let (added, done) = match self.tools.restore(alias) {
            Some(identity) if identity.custom => {
                let input = custom_tool_input(arguments)?;
                let id = new_id("ctc");
                let item = |input: &str| {
                    let mut item = json!({
                        "type": "custom_tool_call",
                        "id": id,
                        "call_id": call_id,
                        "name": identity.name,
                        "input": input,
                    });
                    if let Some(namespace) = &identity.namespace {
                        item["namespace"] = json!(namespace);
                    }
                    item
                };
                (item(""), item(&input))
            }
            identity => {
                let name = identity.map_or(alias, |identity| identity.name.as_str());
                let namespace = identity.and_then(|identity| identity.namespace.as_deref());
                let id = new_id("fc");
                let item = |arguments: &str| {
                    let mut item = json!({
                        "type": "function_call",
                        "id": id,
                        "name": name,
                        "arguments": arguments,
                        "call_id": call_id,
                    });
                    if let Some(namespace) = namespace {
                        item["namespace"] = json!(namespace);
                    }
                    item
                };
                (item(""), item(arguments))
            }
        };
        self.events
            .push(json!({"type": "response.output_item.added", "item": added}));
        self.events
            .push(json!({"type": "response.output_item.done", "item": done}));
        Ok(())
    }

    /// Emits a reasoning item carrying opaque vendor state, such as a Gemini thought signature.
    pub(crate) fn reasoning_state(&mut self, encrypted_content: String) {
        self.close_message();
        let item = json!({
            "type": "reasoning",
            "id": new_id("rs"),
            "summary": [],
            "encrypted_content": encrypted_content,
        });
        self.events
            .push(json!({"type": "response.output_item.added", "item": item.clone()}));
        self.events
            .push(json!({"type": "response.output_item.done", "item": item}));
    }

    pub(crate) fn completed(&mut self, usage: Option<&Usage>, end_turn: Option<bool>) {
        self.close_message();
        let mut response = json!({"id": self.response_id, "status": "completed"});
        if let Some(usage) = usage {
            response["usage"] = usage.to_json();
        }
        if let Some(end_turn) = end_turn {
            response["end_turn"] = json!(end_turn);
        }
        self.events
            .push(json!({"type": "response.completed", "response": response}));
        self.finished = true;
    }

    /// Ends the response with an error. Text already streamed stays visible, but core records
    /// the turn as failed rather than as a complete answer.
    pub(crate) fn failed(&mut self, error: &StreamError) {
        self.events.push(json!({
            "type": "response.failed",
            "response": {
                "id": self.response_id,
                "status": "failed",
                "error": {"code": error.code, "message": error.message},
            },
        }));
        self.finished = true;
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.finished
    }

    pub(crate) fn drain(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.events)
    }
}

fn assistant_message(id: &str, text: &str) -> Value {
    json!({
        "type": "message",
        "id": id,
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}],
    })
}

/// The raw input of a freeform tool, which the vendor saw as a function taking `{"input": …}`.
fn custom_tool_input(arguments: &str) -> Result<String, StreamError> {
    let value: Value = serde_json::from_str(arguments)
        .map_err(|error| StreamError::new(format!("invalid custom tool arguments: {error}")))?;
    match value {
        Value::String(input) => Ok(input),
        Value::Object(object) => object
            .get("input")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| StreamError::new("custom tool arguments must contain a string `input`")),
        _ => Err(StreamError::new(
            "custom tool arguments must contain a string `input`",
        )),
    }
}

/// A vendor's stream parser.
#[derive(Debug)]
enum VendorStream {
    Chat(ChatStream),
    Anthropic(AnthropicStream),
    Gemini(GeminiStream),
}

/// Turns one vendor stream into one Responses stream.
#[derive(Debug)]
pub(crate) struct Translation {
    vendor: VendorStream,
    out: Emitter,
}

impl Translation {
    pub(crate) fn new(wire: GatewayWire, tools: ToolMap) -> Self {
        let vendor = match wire {
            GatewayWire::Chat => VendorStream::Chat(ChatStream::default()),
            GatewayWire::AnthropicMessages => VendorStream::Anthropic(AnthropicStream::default()),
            GatewayWire::GeminiGenerateContent => VendorStream::Gemini(GeminiStream::default()),
        };
        Self {
            vendor,
            out: Emitter::new(tools),
        }
    }

    pub(crate) fn start(&mut self) -> Vec<Value> {
        self.out.created();
        self.out.drain()
    }

    /// Feeds one vendor SSE event (its `event:` name and `data:` payload).
    pub(crate) fn push(&mut self, event: &str, data: &str) -> Vec<Value> {
        if self.out.is_finished() {
            return Vec::new();
        }
        let result = match &mut self.vendor {
            VendorStream::Chat(stream) => stream.on_event(data, &mut self.out),
            VendorStream::Anthropic(stream) => stream.on_event(event, data, &mut self.out),
            VendorStream::Gemini(stream) => stream.on_event(data, &mut self.out),
        };
        if let Err(error) = result {
            self.out.failed(&error);
        }
        self.out.drain()
    }

    /// The vendor closed its stream.
    pub(crate) fn end(&mut self) -> Vec<Value> {
        if !self.out.is_finished() {
            let result = match &mut self.vendor {
                VendorStream::Chat(stream) => stream.on_end(&mut self.out),
                VendorStream::Anthropic(_) => Err(StreamError::new(
                    "the Anthropic stream ended without message_stop",
                )),
                VendorStream::Gemini(_) => Err(StreamError::new(
                    "the Gemini stream ended without a finish reason",
                )),
            };
            match result {
                Err(error) => self.out.failed(&error),
                Ok(()) if !self.out.is_finished() => self
                    .out
                    .failed(&StreamError::new("the provider stream ended early")),
                Ok(()) => {}
            }
        }
        self.out.drain()
    }

    pub(crate) fn fail(&mut self, message: &str) -> Vec<Value> {
        if !self.out.is_finished() {
            self.out.failed(&StreamError::new(message));
        }
        self.out.drain()
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.out.is_finished()
    }
}

#[cfg(test)]
#[path = "emitter_tests.rs"]
mod tests;

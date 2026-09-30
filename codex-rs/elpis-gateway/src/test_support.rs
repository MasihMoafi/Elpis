//! Helpers shared by the gateway's tests.

use codex_model_provider_info::GatewayWire;
use codex_protocol::models::ResponseItem;
use serde_json::Value;
use serde_json::json;

use crate::conversation::Conversation;
use crate::emitter::Translation;

/// A Responses request as core sends it.
pub(crate) fn responses_request(input: Value, tools: Value) -> Value {
    json!({
        "model": "fixture-model",
        "instructions": "Be exact.",
        "input": input,
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "reasoning": null,
        "store": false,
        "stream": true,
        "include": ["reasoning.encrypted_content"],
    })
}

/// The tools core sends a non-OpenAI model: plain functions plus the freeform patch tool.
pub(crate) fn core_tools() -> Value {
    json!([
        {
            "type": "function",
            "name": "exec_command",
            "description": "Runs a command.",
            "strict": false,
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"],
                "additionalProperties": false,
            },
        },
        {
            "type": "custom",
            "name": "apply_patch",
            "description": "Edits files.",
            "format": {"type": "grammar", "syntax": "lark", "definition": "start: begin_patch"},
        },
    ])
}

pub(crate) fn conversation(request: &Value) -> Conversation {
    Conversation::from_request(request).expect("the request translates")
}

/// Runs vendor SSE events (`(event name, data)`) through a translation. `close` ends the
/// vendor stream afterwards.
pub(crate) fn translate(
    wire: GatewayWire,
    request: &Value,
    events: &[(&str, &str)],
    close: bool,
) -> Vec<Value> {
    let mut translation = Translation::new(wire, conversation(request).tool_map);
    let mut out = translation.start();
    for (event, data) in events {
        out.extend(translation.push(event, data));
    }
    if close {
        out.extend(translation.end());
    }
    out
}

pub(crate) fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The completed items, read with core's own `ResponseItem` type. An item core cannot read
/// fails the test: core would drop it silently.
pub(crate) fn done_items(events: &[Value]) -> Vec<ResponseItem> {
    events
        .iter()
        .filter(|event| event["type"] == "response.output_item.done")
        .map(|event| {
            let item: ResponseItem = serde_json::from_value(event["item"].clone())
                .unwrap_or_else(|error| panic!("core cannot read {}: {error}", event["item"]));
            assert!(
                !matches!(item, ResponseItem::Other),
                "core reads {} as an unknown item",
                event["item"]
            );
            item
        })
        .collect()
}

/// The `response` of `response.completed`, checked against the fields core requires
/// (`ResponseCompleted` in `codex-api/src/sse/responses.rs`).
pub(crate) fn completed(events: &[Value]) -> Option<Value> {
    let response = events
        .iter()
        .find(|event| event["type"] == "response.completed")?
        .get("response")?
        .clone();
    assert!(response["id"].is_string(), "completed response has no id");
    if let Some(usage) = response.get("usage") {
        for field in ["input_tokens", "output_tokens", "total_tokens"] {
            assert!(usage[field].is_i64(), "usage.{field} is missing");
        }
        assert!(usage["input_tokens_details"]["cached_tokens"].is_i64());
        assert!(usage["output_tokens_details"]["reasoning_tokens"].is_i64());
    }
    Some(response)
}

/// The message of `response.failed`, if the response failed.
pub(crate) fn failure(events: &[Value]) -> Option<String> {
    events
        .iter()
        .find(|event| event["type"] == "response.failed")
        .map(|event| {
            event["response"]["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
}

pub(crate) fn streamed_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|event| event["type"] == "response.output_text.delta")
        .filter_map(|event| event["delta"].as_str())
        .collect()
}

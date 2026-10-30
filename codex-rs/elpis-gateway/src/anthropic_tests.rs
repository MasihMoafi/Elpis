use super::*;
use crate::test_support::completed;
use crate::test_support::conversation;
use crate::test_support::core_tools;
use crate::test_support::done_items;
use crate::test_support::failure;
use crate::test_support::responses_request;
use crate::test_support::streamed_text;
use crate::test_support::translate;
use codex_model_provider_info::GatewayWire;
use codex_protocol::models::ResponseItem;
use pretty_assertions::assert_eq;

#[test]
fn the_request_hoists_system_text_and_pairs_tool_use_with_results() {
    let history = json!([
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Rules."}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "List files."}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Listing."}]},
        {"type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
        {"type": "function_call_output", "call_id": "c1", "output": "a.txt"},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Thanks."}]},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");

    assert_eq!(
        body["system"],
        json!([{"type": "text", "text": "Be exact."}, {"type": "text", "text": "Rules."}])
    );
    assert_eq!(
        body["messages"],
        json!([
            {"role": "user", "content": [{"type": "text", "text": "List files."}]},
            {"role": "assistant", "content": [
                {"type": "text", "text": "Listing."},
                {"type": "tool_use", "id": "c1", "name": "exec_command", "input": {"cmd": "ls"}},
            ]},
            // The tool result and the next user text share one user turn, as Anthropic requires.
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": "a.txt"},
                {"type": "text", "text": "Thanks."},
            ]},
        ])
    );
    assert_eq!(body["max_tokens"], 8192);
    assert_eq!(body["stream"], true);
    assert_eq!(body["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(body["tools"][0]["name"], "exec_command");
    assert_eq!(body["tools"][0]["input_schema"]["required"], json!(["cmd"]));
    assert_eq!(body["tools"][1]["name"], "apply_patch");
    assert_eq!(body["tools"][1]["input_schema"]["required"], json!(["input"]));
}

#[test]
fn a_request_never_ends_with_an_assistant_message() {
    // Masih on 16 October 2026: "This model does not support assistant message prefill. The
    // conversation must end with a user message."
    let history = json!([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Go on."}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done so far."}]},
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Admitted context changed."}]},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(
        messages.last(),
        Some(&json!({"role": "user", "content": [{"type": "text", "text": "Admitted context changed."}]}))
    );
    assert!(!body["system"].to_string().contains("Admitted context changed."));

    let history = json!([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Go on."}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Done so far."}]},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");
    assert_eq!(
        body["messages"].as_array().and_then(|messages| messages.last()),
        Some(&json!({"role": "user", "content": [{"type": "text", "text": "Continue."}]}))
    );
}

#[test]
fn top_level_schema_rules_move_into_the_description() {
    // The rag MCP server's `query_knowledge_base` schema, which Anthropic refused with
    // "input_schema does not support oneOf, allOf, or anyOf at the top level".
    let rule = json!([
        {"type": "object", "properties": {}, "required": ["doc_path"]},
        {"type": "object", "properties": {}, "required": ["workspace_id"]},
    ]);
    let parameters = json!({
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
        "additionalProperties": false,
        "oneOf": rule,
    });
    let (description, schema) = anthropic_input_schema("Search.", &parameters);

    assert_eq!(
        schema,
        json!({
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": false,
        })
    );
    assert_eq!(
        description,
        format!("Search.\n\nThe input must also match exactly one of these JSON schemas: {rule}")
    );

    let (_, merged) = anthropic_input_schema(
        "",
        &json!({"allOf": [
            {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]},
            {"properties": {"b": {"type": "integer"}}},
        ]}),
    );
    assert_eq!(
        merged,
        json!({
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "integer"}},
            "required": ["a"],
        })
    );
}

#[test]
fn tool_input_that_is_not_an_object_is_refused_before_sending() {
    let history = json!([
        {"type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "[1, 2]"},
    ]);
    let error = request(&conversation(&responses_request(history, core_tools())))
        .expect_err("an array is not a tool input");

    assert_eq!(error.status, http::StatusCode::BAD_REQUEST);
}

fn event(kind: &'static str, data: Value) -> (&'static str, String) {
    (kind, data.to_string())
}

fn tool_turn() -> Vec<(&'static str, String)> {
    vec![
        event(
            "message_start",
            json!({"type": "message_start", "message": {"id": "msg_1", "usage": {
                "input_tokens": 10, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 1, "output_tokens": 1,
            }}}),
        ),
        event(
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Running ls."}}),
        ),
        event(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        event(
            "content_block_start",
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "exec_command", "input": {}}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"cmd\": "}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "\"ls\"}"}}),
        ),
        event(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 1}),
        ),
        event(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 12}}),
        ),
        event("message_stop", json!({"type": "message_stop"})),
    ]
}

fn run(events: &[(&'static str, String)], close: bool) -> Vec<Value> {
    let events: Vec<(&str, &str)> = events
        .iter()
        .map(|(kind, data)| (*kind, data.as_str()))
        .collect();
    translate(
        GatewayWire::AnthropicMessages,
        &responses_request(json!([]), core_tools()),
        &events,
        close,
    )
}

#[test]
fn a_tool_use_turn_reaches_core_as_text_then_a_function_call() {
    let out = run(&tool_turn(), /*close*/ true);

    assert_eq!(streamed_text(&out), "Running ls.");
    match done_items(&out).as_slice() {
        [
            ResponseItem::Message { .. },
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            },
        ] => {
            assert_eq!(name, "exec_command");
            assert_eq!(
                serde_json::from_str::<Value>(arguments).expect("json"),
                json!({"cmd": "ls"})
            );
            assert_eq!(call_id, "toolu_1");
        }
        other => panic!("unexpected items: {other:?}"),
    }
    let response = completed(&out).expect("completed");
    assert_eq!(response["end_turn"], false);
    // Anthropic reports cached and uncached input apart; core counts them together.
    assert_eq!(response["usage"]["input_tokens"], 16);
    assert_eq!(response["usage"]["input_tokens_details"]["cached_tokens"], 5);
    assert_eq!(response["usage"]["output_tokens"], 12);
}

#[test]
fn an_end_turn_answer_ends_the_turn() {
    let events = vec![
        event(
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "DONE"}}),
        ),
        event(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        event(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}),
        ),
        event("message_stop", json!({"type": "message_stop"})),
    ];
    let out = run(&events, /*close*/ true);

    assert_eq!(streamed_text(&out), "DONE");
    assert_eq!(completed(&out).expect("completed")["end_turn"], true);
}

#[test]
fn uncached_usage_does_not_create_cache_hits() {
    let events = vec![
        event(
            "message_start",
            json!({"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}),
        ),
        event(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}),
        ),
        event("message_stop", json!({"type":"message_stop"})),
    ];
    let out = run(&events, true);
    let response = completed(&out).expect("completed");
    assert_eq!(response["usage"]["input_tokens"], 10);
    assert_eq!(
        response["usage"]["input_tokens_details"]["cached_tokens"],
        0
    );
    assert_eq!(response["usage"]["output_tokens"], 12);
}

#[test]
fn a_stream_cut_before_message_stop_fails_without_a_tool_call() {
    let mut events = tool_turn();
    // Cut inside the tool input, then the connection closes.
    events.truncate(6);
    let out = run(&events, /*close*/ true);

    assert!(failure(&out).is_some());
    assert_eq!(completed(&out), None);
    assert!(
        done_items(&out)
            .iter()
            .all(|item| !matches!(item, ResponseItem::FunctionCall { .. }))
    );
}

#[test]
fn a_tool_input_cut_by_max_tokens_is_not_run() {
    let mut events = tool_turn();
    // Drop the second half of the JSON input.
    events.remove(6);
    let out = run(&events, /*close*/ true);

    assert!(failure(&out).is_some_and(|message| message.contains("incomplete tool call")));
    assert_eq!(completed(&out), None);
}

#[test]
fn an_overloaded_error_is_reported_as_overload() {
    let events = vec![event(
        "error",
        json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
    )];
    let out = run(&events, /*close*/ false);

    assert_eq!(failure(&out).as_deref(), Some("Overloaded"));
    let failed = out
        .iter()
        .find(|event| event["type"] == "response.failed")
        .expect("failed");
    assert_eq!(failed["response"]["error"]["code"], "server_is_overloaded");
}

#[test]
fn an_image_is_sent_as_an_image_block_also_inside_a_tool_result() {
    let history = json!([
        {"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "What is this?"},
            {"type": "input_image", "image_url": "data:image/png;base64,PIXELS"},
        ]},
        {"type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c1", "output": [
            {"type": "input_image", "image_url": "https://example.com/a.png"},
        ]},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");

    assert_eq!(
        body["messages"],
        json!([
            {"role": "user", "content": [
                {"type": "text", "text": "What is this?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "PIXELS"}},
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "c1", "name": "exec_command", "input": {}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "c1", "content": [
                    {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}},
                ]},
            ]},
        ])
    );
}

fn request_with_effort(model: &str, effort: Option<&str>, history: Value) -> Value {
    let mut raw = responses_request(history, core_tools());
    raw["model"] = json!(model);
    raw["reasoning"] = effort.map_or(Value::Null, |effort| json!({"effort": effort}));
    request(&conversation(&raw)).expect("the request translates")
}

fn hello() -> Value {
    json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hi"}]}])
}

#[test]
fn a_requested_effort_turns_thinking_on_with_the_field_the_model_family_takes() {
    let adaptive = request_with_effort("claude-opus-5-5", Some("high"), hello());
    assert_eq!(adaptive["thinking"], json!({"type": "adaptive"}));
    assert_eq!(adaptive["output_config"], json!({"effort": "high"}));
    assert_eq!(adaptive["max_tokens"], 8192);

    let budgeted = request_with_effort("claude-haiku-4-5-20251001", Some("medium"), hello());
    assert_eq!(
        budgeted["thinking"],
        json!({"type": "enabled", "budget_tokens": 4096})
    );
    assert_eq!(budgeted["output_config"], Value::Null);
    let max_tokens = budgeted["max_tokens"].as_u64().expect("max_tokens");
    assert!(max_tokens > 4096);
}

#[test]
fn thinking_stays_off_without_an_effort_or_for_models_that_cannot_think() {
    let thinking = json!([{"type": "reasoning", "summary": [], "encrypted_content":
        format!("{ANTHROPIC_THINKING_PREFIX}{}", json!({"type": "thinking", "thinking": "t", "signature": "s"}))}]);
    for (model, effort) in [
        ("claude-opus-5-5", None),
        ("claude-sonnet-4-20250514", Some("high")),
        ("claude-3-7-sonnet-latest", Some("high")),
        ("some-other-model", Some("high")),
    ] {
        let body = request_with_effort(model, effort, hello());
        assert_eq!(body["thinking"], Value::Null, "{model}");
        assert_eq!(body["output_config"], Value::Null, "{model}");
        assert_eq!(body["max_tokens"], 8192, "{model}");
    }
    let mut history = hello().as_array().cloned().expect("array");
    history.extend(thinking.as_array().cloned().expect("array"));
    let body = request_with_effort("claude-opus-5-5", None, json!(history));
    assert!(!body["messages"].to_string().contains("\"thinking\""));
}

#[test]
fn thinking_blocks_are_kept_and_replayed_before_the_tool_call() {
    let events = vec![
        event(
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me "}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "see."}}),
        ),
        event(
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG"}}),
        ),
        event(
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        event("message_stop", json!({"type": "message_stop"})),
    ];
    let out = run(&events, /*close*/ true);
    let state = out
        .iter()
        .find(|event| event["item"]["type"] == "reasoning" && event["type"] == "response.output_item.done")
        .and_then(|event| event["item"]["encrypted_content"].as_str())
        .expect("a reasoning item carries the thinking block")
        .to_string();

    let history = json!([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
        {"type": "reasoning", "summary": [], "encrypted_content": state},
        {"type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c1", "output": "ok"},
    ]);
    let body = request_with_effort("claude-opus-5-5", Some("low"), history);
    assert_eq!(
        body["messages"][1]["content"],
        json!([
            {"type": "thinking", "thinking": "Let me see.", "signature": "SIG"},
            {"type": "tool_use", "id": "c1", "name": "exec_command", "input": {}},
        ])
    );
}

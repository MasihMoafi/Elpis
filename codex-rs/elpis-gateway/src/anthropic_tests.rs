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
    assert_eq!(body["tools"][0]["name"], "exec_command");
    assert_eq!(body["tools"][0]["input_schema"]["required"], json!(["cmd"]));
    assert_eq!(body["tools"][1]["name"], "apply_patch");
    assert_eq!(body["tools"][1]["input_schema"]["required"], json!(["input"]));
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

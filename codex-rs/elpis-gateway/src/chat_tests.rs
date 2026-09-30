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

fn history() -> Value {
    json!([
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Rules."}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "List files."}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Listing."}]},
        {"type": "function_call", "call_id": "c1", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
        {"type": "function_call", "call_id": "c2", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
        {"type": "function_call_output", "call_id": "c1", "output": "a.txt"},
        {"type": "function_call_output", "call_id": "c2", "output": "/work"},
    ])
}

#[test]
fn the_request_carries_roles_tool_calls_and_results() {
    let body = request(&conversation(&responses_request(history(), core_tools())));

    assert_eq!(
        body["messages"],
        json!([
            {"role": "system", "content": "Be exact."},
            {"role": "system", "content": "Rules."},
            {"role": "user", "content": "List files."},
            // Calls join the assistant message they follow instead of a second assistant turn.
            {"role": "assistant", "content": "Listing.", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"}},
                {"id": "c2", "type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}},
            ]},
            {"role": "tool", "tool_call_id": "c1", "content": "a.txt"},
            {"role": "tool", "tool_call_id": "c2", "content": "/work"},
        ])
    );
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"], json!({"include_usage": true}));
    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    assert_eq!(names, vec!["exec_command", "apply_patch"]);
    assert_eq!(body.get("reasoning"), None);
    assert_eq!(body.get("response_format"), None);
}

#[test]
fn reasoning_effort_and_output_schema_are_sent_only_when_requested() {
    let mut raw = responses_request(json!([]), json!([]));
    raw["reasoning"] = json!({"effort": "high"});
    raw["text"] = json!({"format": {"type": "json_schema", "name": "title", "strict": true, "schema": {"type": "object"}}});
    let body = request(&conversation(&raw));

    assert_eq!(body["reasoning"], json!({"effort": "high"}));
    assert_eq!(
        body["response_format"],
        json!({"type": "json_schema", "json_schema": {"name": "title", "strict": true, "schema": {"type": "object"}}})
    );
}

fn chunk(value: Value) -> String {
    value.to_string()
}

#[test]
fn fragmented_parallel_tool_calls_round_trip_to_core() {
    let request = responses_request(json!([]), core_tools());
    let events = [
        chunk(json!({"id": "x", "choices": [{"index": 0, "delta": {"content": "Checking."}}]})),
        chunk(json!({"id": "x", "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": "call-a", "type": "function", "function": {"name": "exec_command", "arguments": "{\"cmd\""}},
            {"index": 1, "id": "call-b", "type": "function", "function": {"name": "apply_patch", "arguments": ""}},
        ]}}]})),
        chunk(json!({"id": "x", "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": ":\"ls\"}"}},
            {"index": 1, "function": {"arguments": "{\"input\":\"*** Begin Patch\"}"}},
        ]}, "finish_reason": "tool_calls"}]})),
        chunk(json!({"id": "x", "choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})),
        "[DONE]".to_string(),
    ];
    let events: Vec<(&str, &str)> = events.iter().map(|data| ("", data.as_str())).collect();
    let out = translate(GatewayWire::Chat, &request, &events, /*close*/ false);

    assert_eq!(streamed_text(&out), "Checking.");
    match done_items(&out).as_slice() {
        [
            ResponseItem::Message { .. },
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            },
            ResponseItem::CustomToolCall {
                name: patch_name,
                input,
                call_id: patch_call,
                ..
            },
        ] => {
            assert_eq!(
                (name.as_str(), arguments.as_str(), call_id.as_str()),
                ("exec_command", r#"{"cmd":"ls"}"#, "call-a")
            );
            assert_eq!(
                (patch_name.as_str(), input.as_str(), patch_call.as_str()),
                ("apply_patch", "*** Begin Patch", "call-b")
            );
        }
        other => panic!("unexpected items: {other:?}"),
    }
    let response = completed(&out).expect("completed");
    assert_eq!(response["end_turn"], false);
    assert_eq!(response["usage"]["total_tokens"], 5);
    assert_eq!(failure(&out), None);
}

#[test]
fn a_text_answer_ends_the_turn() {
    let request = responses_request(json!([]), json!([]));
    let first = chunk(json!({"choices": [{"index": 0, "delta": {"content": "DONE"}}]}));
    let last = chunk(json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}));
    let out = translate(
        GatewayWire::Chat,
        &request,
        &[("", first.as_str()), ("", last.as_str()), ("", "[DONE]")],
        /*close*/ false,
    );

    assert_eq!(streamed_text(&out), "DONE");
    assert_eq!(completed(&out).expect("completed")["end_turn"], true);
}

#[test]
fn a_stream_without_a_finish_reason_fails() {
    let request = responses_request(json!([]), json!([]));
    let partial = chunk(json!({"choices": [{"index": 0, "delta": {"content": "PARTIAL"}}]}));

    // Cut off with [DONE] and cut off by the connection closing.
    for (events, close) in [
        (vec![("", partial.as_str()), ("", "[DONE]")], false),
        (vec![("", partial.as_str())], true),
    ] {
        let out = translate(GatewayWire::Chat, &request, &events, close);
        assert!(failure(&out).is_some_and(|message| message.contains("finish reason")));
        assert_eq!(completed(&out), None);
    }
}

#[test]
fn truncated_or_length_limited_tool_calls_are_never_emitted() {
    let request = responses_request(json!([]), core_tools());
    let call = |arguments: &str, finish: &str| {
        chunk(json!({"choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": "call-a", "function": {"name": "exec_command", "arguments": arguments}},
        ]}, "finish_reason": finish}]}))
    };
    for data in [call("{\"cmd\":", "tool_calls"), call("{\"cmd\":\"ls\"}", "length")] {
        let out = translate(
            GatewayWire::Chat,
            &request,
            &[("", data.as_str()), ("", "[DONE]")],
            /*close*/ false,
        );
        assert!(failure(&out).is_some(), "{data} was accepted");
        assert!(
            done_items(&out)
                .iter()
                .all(|item| !matches!(item, ResponseItem::FunctionCall { .. })),
            "{data} produced a tool call"
        );
    }
}

#[test]
fn a_complete_tool_call_reported_as_stop_still_runs() {
    let request = responses_request(json!([]), core_tools());
    let data = chunk(json!({"choices": [{"index": 0, "delta": {"tool_calls": [
        {"index": 0, "id": "call-a", "function": {"name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"}},
    ]}, "finish_reason": "stop"}]}));
    let out = translate(
        GatewayWire::Chat,
        &request,
        &[("", data.as_str()), ("", "[DONE]")],
        /*close*/ false,
    );

    assert!(matches!(
        done_items(&out).as_slice(),
        [ResponseItem::FunctionCall { .. }]
    ));
    assert_eq!(completed(&out).expect("completed")["end_turn"], false);
}

#[test]
fn a_provider_error_in_the_stream_fails_with_its_message() {
    let request = responses_request(json!([]), json!([]));
    let data = chunk(json!({"error": {"message": "Rate limit exceeded: free-models-per-day", "code": 429}}));
    let out = translate(GatewayWire::Chat, &request, &[("", data.as_str())], /*close*/ false);

    assert_eq!(
        failure(&out).as_deref(),
        Some("Rate limit exceeded: free-models-per-day")
    );
}

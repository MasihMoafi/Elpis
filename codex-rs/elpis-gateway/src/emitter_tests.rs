use super::*;
use crate::test_support::completed;
use crate::test_support::conversation;
use crate::test_support::core_tools;
use crate::test_support::done_items;
use crate::test_support::event_types;
use crate::test_support::failure;
use crate::test_support::responses_request;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use pretty_assertions::assert_eq;

fn emitter() -> Emitter {
    Emitter::new(conversation(&responses_request(json!([]), core_tools())).tool_map)
}

#[test]
fn text_opens_its_message_before_the_first_delta() {
    let mut out = emitter();
    out.created();
    out.text("Hel");
    out.text("lo");
    out.completed(/*usage*/ None, Some(true));
    let events = out.drain();

    assert_eq!(
        event_types(&events),
        vec![
            "response.created",
            "response.output_item.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_item.done",
            "response.completed",
        ]
    );
    // Core seeds a message from its `added` text, so the opening item must be empty.
    assert_eq!(events[1]["item"]["content"][0]["text"], "");
    assert_eq!(events[1]["item"]["id"], events[4]["item"]["id"]);
    match done_items(&events).as_slice() {
        [ResponseItem::Message { role, content, .. }] => {
            assert_eq!(role, "assistant");
            assert_eq!(
                content,
                &vec![ContentItem::OutputText {
                    text: "Hello".to_string()
                }]
            );
        }
        other => panic!("unexpected items: {other:?}"),
    }
    assert_eq!(completed(&events).expect("completed")["end_turn"], true);
}

#[test]
fn a_freeform_tool_call_returns_to_core_as_a_custom_tool_call() {
    let mut out = emitter();
    out.text("Patching.");
    out.tool_call(
        "apply_patch",
        "call-1",
        &json!({"input": "*** Begin Patch\n*** End Patch"}).to_string(),
    )
    .expect("a complete call");
    let events = out.drain();

    match done_items(&events).as_slice() {
        [
            ResponseItem::Message { .. },
            ResponseItem::CustomToolCall {
                call_id,
                name,
                input,
                ..
            },
        ] => {
            assert_eq!(call_id, "call-1");
            assert_eq!(name, "apply_patch");
            assert_eq!(input, "*** Begin Patch\n*** End Patch");
        }
        other => panic!("unexpected items: {other:?}"),
    }
    // The call is announced empty and completed once, like the Responses API does.
    let added = events
        .iter()
        .find(|event| {
            event["type"] == "response.output_item.added"
                && event["item"]["type"] == "custom_tool_call"
        })
        .expect("the call is announced");
    assert_eq!(added["item"]["input"], "");
}

#[test]
fn a_function_call_keeps_core_names_and_arguments() {
    let mut out = emitter();
    out.tool_call("exec_command", "call-2", r#"{"cmd":"ls"}"#)
        .expect("a complete call");

    match done_items(&out.drain()).as_slice() {
        [
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                namespace,
                ..
            },
        ] => {
            assert_eq!(name, "exec_command");
            assert_eq!(arguments, r#"{"cmd":"ls"}"#);
            assert_eq!(call_id, "call-2");
            assert_eq!(namespace, &None);
        }
        other => panic!("unexpected items: {other:?}"),
    }
}

#[test]
fn freeform_arguments_without_input_are_an_error_not_a_patch() {
    let mut out = emitter();
    let error = out
        .tool_call("apply_patch", "call-3", r#"{"patch": "x"}"#)
        .expect_err("no input field");

    assert!(error.message.contains("input"), "{}", error.message);
    assert_eq!(done_items(&out.drain()).len(), 0);
}

#[test]
fn usage_and_end_turn_reach_the_completed_event() {
    let mut out = emitter();
    out.completed(
        Some(&Usage {
            input_tokens: 10,
            cached_input_tokens: 4,
            cache_write_tokens: 2,
            output_tokens: 7,
            reasoning_output_tokens: 3,
        }),
        Some(false),
    );
    let response = completed(&out.drain()).expect("completed");

    assert_eq!(response["usage"]["total_tokens"], 17);
    assert_eq!(response["usage"]["input_tokens_details"]["cached_tokens"], 4);
    assert_eq!(response["usage"]["output_tokens_details"]["reasoning_tokens"], 3);
    assert_eq!(response["end_turn"], false);
}

#[test]
fn a_failure_carries_its_code_and_ends_the_response() {
    let mut out = emitter();
    out.failed(&StreamError::with_code("server_is_overloaded", "busy"));
    let events = out.drain();

    assert!(out.is_finished());
    assert_eq!(failure(&events).as_deref(), Some("busy"));
    assert_eq!(events[0]["response"]["error"]["code"], "server_is_overloaded");
    assert_eq!(completed(&events), None);
}

#[test]
fn a_vendor_stream_that_just_stops_fails() {
    for wire in [
        GatewayWire::Chat,
        GatewayWire::AnthropicMessages,
        GatewayWire::GeminiGenerateContent,
    ] {
        let mut translation = Translation::new(wire, ToolMap::default());
        let mut events = translation.start();
        events.extend(translation.end());

        assert!(failure(&events).is_some(), "{wire:?} completed an empty stream");
        assert_eq!(completed(&events), None);
        assert!(translation.is_finished());
    }
}

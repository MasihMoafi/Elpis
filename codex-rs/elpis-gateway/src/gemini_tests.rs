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

fn signature_item(call_id: &str, signature: &str) -> Value {
    json!({
        "type": "reasoning",
        "summary": [],
        "encrypted_content": format!(
            "{GEMINI_SIGNATURE_PREFIX}{}",
            json!({"call_id": call_id, "signature": signature})
        ),
    })
}

#[test]
fn the_request_uses_gemini_roles_and_keeps_thought_signatures_on_their_call() {
    let history = json!([
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Rules."}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "List files."}]},
        signature_item("g1", "sig-1"),
        {"type": "function_call", "call_id": "g1", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
        {"type": "function_call_output", "call_id": "g1", "output": "a.txt"},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");

    assert_eq!(
        body["systemInstruction"],
        json!({"parts": [{"text": "Be exact."}, {"text": "Rules."}]})
    );
    assert_eq!(
        body["contents"],
        json!([
            {"role": "user", "parts": [{"text": "List files."}]},
            {"role": "model", "parts": [{
                "functionCall": {"id": "g1", "name": "exec_command", "args": {"cmd": "ls"}},
                "thoughtSignature": "sig-1",
            }]},
            {"role": "user", "parts": [{
                "functionResponse": {"id": "g1", "name": "exec_command", "response": {"output": "a.txt"}},
            }]},
        ])
    );
    let declarations = &body["tools"][0]["functionDeclarations"];
    assert_eq!(declarations[0]["name"], "exec_command");
    // Full JSON Schema, including keys Gemini's `parameters` subset would reject.
    assert_eq!(
        declarations[0]["parametersJsonSchema"]["additionalProperties"],
        false
    );
    assert_eq!(declarations[0].get("parameters"), None);
    assert_eq!(body["toolConfig"]["functionCallingConfig"]["mode"], "AUTO");
}

#[test]
fn a_function_result_without_its_call_is_refused() {
    let history = json!([
        {"type": "function_call_output", "call_id": "lost", "output": "a.txt"},
    ]);
    let error = request(&conversation(&responses_request(history, core_tools())))
        .expect_err("Gemini needs the function name");

    assert!(error.message.contains("lost"), "{}", error.message);
}

fn chunk(value: Value) -> String {
    value.to_string()
}

fn run(chunks: &[String], close: bool) -> Vec<Value> {
    let events: Vec<(&str, &str)> = chunks.iter().map(|data| ("", data.as_str())).collect();
    translate(
        GatewayWire::GeminiGenerateContent,
        &responses_request(json!([]), core_tools()),
        &events,
        close,
    )
}

fn call_chunk() -> String {
    chunk(json!({"candidates": [{"content": {"role": "model", "parts": [{
        "functionCall": {"id": "g7", "name": "exec_command", "args": {"cmd": "ls"}},
        "thoughtSignature": "sig-7",
    }]}}]}))
}

#[test]
fn a_function_call_keeps_its_signature_for_the_next_request() {
    let chunks = vec![
        chunk(json!({"candidates": [{"content": {"role": "model", "parts": [
            {"text": "thinking", "thought": true},
            {"text": "Running ls."},
        ]}}]})),
        call_chunk(),
        // Gemini may repeat a complete call.
        call_chunk(),
        chunk(json!({
            "candidates": [{"content": {"role": "model", "parts": []}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 9, "candidatesTokenCount": 4, "thoughtsTokenCount": 2, "totalTokenCount": 15},
        })),
    ];
    let out = run(&chunks, /*close*/ true);

    // Thought summaries are not the answer.
    assert_eq!(streamed_text(&out), "Running ls.");
    let items = done_items(&out);
    let (signature, call_id) = match items.as_slice() {
        [
            ResponseItem::Message { .. },
            ResponseItem::Reasoning {
                encrypted_content: Some(signature),
                ..
            },
            ResponseItem::FunctionCall { name, call_id, .. },
        ] => {
            assert_eq!(name, "exec_command");
            (signature.clone(), call_id.clone())
        }
        other => panic!("unexpected items: {other:?}"),
    };
    assert_eq!(call_id, "g7");
    let response = completed(&out).expect("completed");
    assert_eq!(response["end_turn"], false);
    assert_eq!(response["usage"]["output_tokens"], 6);
    assert_eq!(response["usage"]["output_tokens_details"]["reasoning_tokens"], 2);

    // Core replays the reasoning item; the signature returns on its own call.
    let history = json!([
        {"type": "reasoning", "summary": [], "encrypted_content": signature},
        {"type": "function_call", "call_id": call_id, "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
    ]);
    let body = request(&conversation(&responses_request(history, core_tools())))
        .expect("the request translates");
    assert_eq!(body["contents"][0]["parts"][0]["thoughtSignature"], "sig-7");
}

#[test]
fn a_stream_without_a_finish_reason_fails() {
    let out = run(&[call_chunk()], /*close*/ true);

    assert!(failure(&out).is_some_and(|message| message.contains("finish reason")));
    assert_eq!(completed(&out), None);
}

#[test]
fn a_blocked_prompt_fails_with_the_reason() {
    let out = run(
        &[chunk(json!({"promptFeedback": {"blockReason": "SAFETY"}}))],
        /*close*/ false,
    );

    assert_eq!(
        failure(&out).as_deref(),
        Some("Gemini blocked the prompt: SAFETY")
    );
}

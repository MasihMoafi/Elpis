use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

fn big(text: &str) -> String {
    format!("{text}\n{}", "row of build output\n".repeat(400))
}

fn request(last_user: Value) -> Value {
    json!({
        "model": "claude-test",
        "messages": [
            {"role": "user", "content": "Read the log."},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_old", "name": "Bash", "input": {"command": "cat a"}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_old", "content": big("old")},
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_new", "name": "Bash", "input": {"command": "cat b"}},
            ]},
            last_user,
        ],
    })
}

#[test]
fn only_the_last_user_message_has_candidates() {
    let body = request(json!({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_new", "content": big("new")},
    ]}));
    let found = candidates(&body, &Decisions::new());
    assert_eq!(
        found
            .iter()
            .map(|candidate| candidate.tool_use_id.as_str())
            .collect::<Vec<_>>(),
        vec!["toolu_new"]
    );
}

#[test]
fn small_error_image_and_decided_results_are_not_candidates() {
    let body = request(json!({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "small", "content": "ok"},
        {"type": "tool_result", "tool_use_id": "error", "is_error": true, "content": big("x")},
        {"type": "tool_result", "tool_use_id": "image", "content": [
            {"type": "text", "text": big("x")},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": ""}},
        ]},
        {"type": "tool_result", "tool_use_id": "decided", "content": big("x")},
    ]}));
    let decisions = Decisions::from([("decided".to_string(), None)]);
    assert_eq!(candidates(&body, &decisions), Vec::<Candidate>::new());
}

#[test]
fn a_stored_form_replaces_the_block_in_every_message() {
    let mut body = request(json!({"role": "user", "content": "next"}));
    let decisions = Decisions::from([("toolu_old".to_string(), Some("short".to_string()))]);
    assert!(apply_decisions(&mut body, &decisions));
    assert_eq!(body["messages"][2]["content"][0]["content"], json!("short"));
    // A second pass finds nothing to change.
    assert!(!apply_decisions(&mut body, &decisions));
}

#[test]
fn a_kept_source_is_not_changed() {
    let mut body = request(json!({"role": "user", "content": "next"}));
    let before = body.clone();
    let decisions = Decisions::from([("toolu_old".to_string(), None)]);
    assert!(!apply_decisions(&mut body, &decisions));
    assert_eq!(body, before);
}

#[test]
fn a_text_part_list_keeps_its_cache_breakpoint() {
    let mut body = json!({"messages": [{"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t", "content": [
            {"type": "text", "text": "a"},
            {"type": "text", "text": "b", "cache_control": {"type": "ephemeral"}},
        ]},
    ]}]});
    let decisions = Decisions::from([("t".to_string(), Some("short".to_string()))]);
    assert!(apply_decisions(&mut body, &decisions));
    assert_eq!(
        body["messages"][0]["content"][0]["content"],
        json!([{"type": "text", "text": "short", "cache_control": {"type": "ephemeral"}}])
    );
}

#[test]
fn the_input_names_the_request_the_invocation_and_the_source() {
    let body = request(json!({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_new", "content": big("new")},
    ]}));
    let found = candidates(&body, &Decisions::new());
    let input: Value = serde_json::from_str(&admission_input(&body, &found)).expect("json");
    assert_eq!(input["active_request"], json!("Read the log."));
    assert_eq!(input["items"][0]["call_id"], json!("toolu_new"));
    assert_eq!(
        input["items"][0]["invocation"]["input"],
        json!({"command": "cat b"})
    );
    assert_eq!(input["items"][0]["source_output"], json!(big("new")));
}

#[test]
fn a_system_message_after_the_results_does_not_hide_them() {
    let mut body = request(json!({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_new", "content": big("new")},
    ]}));
    body["messages"]
        .as_array_mut()
        .expect("messages")
        .push(json!({"role": "system", "content": [{"type": "text", "text": "[Truncated]"}]}));
    let found = candidates(&body, &Decisions::new());
    assert_eq!(
        found
            .iter()
            .map(|candidate| candidate.tool_use_id.as_str())
            .collect::<Vec<_>>(),
        vec!["toolu_new"]
    );
}

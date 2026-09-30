use super::*;
use codex_protocol::models::BaseInstructions;
use pretty_assertions::assert_eq;
use serde_json::json;

fn item(value: serde_json::Value) -> ResponseItem {
    serde_json::from_value(value).expect("valid response item")
}

fn message(role: &str, text: &str) -> ResponseItem {
    let kind = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    item(json!({"type": "message", "role": role, "content": [{"type": kind, "text": text}]}))
}

fn prompt() -> Prompt {
    Prompt {
        base_instructions: BaseInstructions {
            text: "You are Elpis. Follow the planted instruction marker.".to_string(),
            provenance: None,
        },
        ..Default::default()
    }
}

#[test]
fn a_planted_answer_moves_only_the_agent_share() {
    let question = message("user", "Describe the planted response marker.");
    let answer = message("assistant", "PLANTED_ANSWER_42 is in the retained answer.");
    let before = classify(&prompt(), std::slice::from_ref(&question));
    let after = classify(&prompt(), &[question, answer]);

    assert_eq!(before.agent_messages, 0);
    assert!(after.agent_messages > 0);
    assert_eq!(after.user_messages, before.user_messages);
    assert!(before.user_messages > 0);
    assert_eq!(after.system_instructions, before.system_instructions);
    assert!(before.system_instructions > 0);
    assert!(after.estimated_total > before.estimated_total);
}

#[test]
fn each_role_and_tool_item_lands_in_its_own_category() {
    let snapshot = classify(
        &prompt(),
        &[
            message("developer", "Developer guidance."),
            message("user", "A user request."),
            item(json!({
                "type": "function_call",
                "call_id": "c1",
                "name": "shell",
                "arguments": "{\"cmd\":\"ls\"}",
            })),
        ],
    );

    assert!(snapshot.developer_messages > 0);
    assert!(snapshot.user_messages > 0);
    assert!(snapshot.tool_calls > 0);
    assert_eq!(snapshot.agent_messages, 0);
    assert_eq!(snapshot.tool_results, 0);
    assert_eq!(snapshot.unrecognized_items, 0);
    assert_eq!(
        snapshot.estimated_total,
        snapshot.system_instructions
            + snapshot.developer_messages
            + snapshot.user_messages
            + snapshot.tool_calls
    );
}

#[test]
fn nothing_is_reported_before_a_request_is_recorded() {
    let thread_data = ExtensionData::new("thread");
    assert_eq!(latest(&thread_data), None);

    let input = [message("user", "First request.")];
    record(&thread_data, &prompt(), &input);
    assert_eq!(latest(&thread_data), Some(classify(&prompt(), &input)));

    let grown = [
        message("user", "First request."),
        message("assistant", "A reply."),
    ];
    record(&thread_data, &prompt(), &grown);
    assert_eq!(
        latest(&thread_data).map(|snapshot| snapshot.agent_messages),
        Some(classify(&prompt(), &grown).agent_messages)
    );
}

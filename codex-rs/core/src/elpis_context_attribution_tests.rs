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

fn reasoning(encrypted_len: usize) -> ResponseItem {
    item(json!({
        "type": "reasoning",
        "summary": [],
        "encrypted_content": "g".repeat(encrypted_len),
    }))
}

/// Seeded lengths: the edges, then many spread across real reasoning sizes (1.5k to 60k).
fn sampled_lengths() -> Vec<usize> {
    let mut lengths = vec![0, 1, 155, 156, 157, 1_559, 1_560, 1_592, 4_096, 68_620];
    let mut state: u64 = 0x5eed_2026_1024;
    for _ in 0..500 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        lengths.push(usize::try_from(state >> 48).unwrap_or(0));
    }
    lengths
}

#[test]
fn encrypted_reasoning_costs_one_token_per_fifteen_point_six_characters() {
    assert_eq!(encrypted_reasoning_tokens(""), 0);
    assert_eq!(encrypted_reasoning_tokens("g"), 1);
    assert_eq!(encrypted_reasoning_tokens(&"g".repeat(156)), 10);
    assert_eq!(encrypted_reasoning_tokens(&"g".repeat(1_560)), 100);
    assert_eq!(encrypted_reasoning_tokens(&"g".repeat(156_000)), 10_000);
}

#[test]
fn reasoning_is_counted_by_its_measured_cost_not_the_history_estimate() {
    // A reasoning item of the median size in his chat (about 7.3k characters, about 430 tokens of
    // reasoning reported by the provider).
    let item = reasoning(7_287);
    let snapshot = classify(&prompt(), std::slice::from_ref(&item));

    assert_eq!(snapshot.reasoning, 468);
    let history_estimate = u64::try_from(estimate_item_token_count(&item)).expect("positive");
    assert_eq!(history_estimate, 1_204);
    assert_eq!(
        snapshot.estimated_total,
        snapshot.system_instructions + snapshot.reasoning
    );
}

#[test]
fn reasoning_without_encrypted_content_weighs_nothing() {
    let plain = item(json!({
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "Plain summary text."}],
    }));
    assert_eq!(classify(&prompt(), &[plain]).reasoning, 0);
}

#[test]
fn compaction_keeps_the_shared_history_estimate() {
    let compaction = item(json!({
        "type": "compaction",
        "id": "c1",
        "encrypted_content": "g".repeat(68_620),
    }));
    let expected = u64::try_from(estimate_item_token_count(&compaction)).expect("positive");
    assert_eq!(classify(&prompt(), &[compaction]).reasoning, expected);
}

#[test]
fn reasoning_estimate_rules_hold_for_any_length() {
    let lengths = sampled_lengths();
    for &len in &lengths {
        let tokens = encrypted_reasoning_tokens(&"g".repeat(len));
        let exact = len as f64 / 15.6;
        // Rounded up, never by a whole token.
        assert!(
            tokens as f64 >= exact - 1e-9 && (tokens as f64) < exact + 1.0,
            "{len}"
        );
        // Every real reasoning item is at least 1.5k characters; there the old estimate is larger.
        if len >= 1_592 {
            let old = u64::try_from(estimate_item_token_count(&reasoning(len))).expect("positive");
            assert!(tokens < old, "{len}: {tokens} >= {old}");
        }
        // Classification adds exactly this and keeps the parts summing to the total.
        let snapshot = classify(&prompt(), &[reasoning(len), message("user", "Next.")]);
        assert_eq!(snapshot.reasoning, tokens);
        assert_eq!(
            snapshot.estimated_total,
            snapshot.system_instructions + snapshot.user_messages + snapshot.reasoning
        );
    }
    let mut sorted = lengths;
    sorted.sort_unstable();
    for pair in sorted.windows(2) {
        assert!(
            encrypted_reasoning_tokens(&"g".repeat(pair[0]))
                <= encrypted_reasoning_tokens(&"g".repeat(pair[1]))
        );
    }
}

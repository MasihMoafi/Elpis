use codex_protocol::models::ResponseItem;

/// Expires hidden reasoning only after its complete logical turn has ended.
///
/// The reasoning item must remain available across every model/tool sampling step in
/// the active turn. The exact item remains in the durable rollout; only model-visible
/// working history is changed here.
pub(crate) fn expire_reasoning_items_for_turn(
    input: &mut Vec<ResponseItem>,
    turn_id: &str,
) -> usize {
    let before = input.len();
    input.retain(|item| {
        !matches!(item, ResponseItem::Reasoning { .. }) || item.turn_id() != Some(turn_id)
    });
    before - input.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;

    fn output(call_id: &str, text: String) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload::from_text(text),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn reasoning(turn_id: &str) -> ResponseItem {
        let mut item = ResponseItem::Reasoning {
            id: None,
            summary: Vec::new(),
            content: None,
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        };
        item.set_turn_id_if_missing(turn_id);
        item
    }

    #[test]
    fn expire_reasoning_items_removes_only_the_completed_turn() {
        let mut input = vec![
            reasoning("turn-1"),
            output("keep", "ok".to_string()),
            reasoning("turn-2"),
            reasoning("turn-1"),
        ];

        assert_eq!(expire_reasoning_items_for_turn(&mut input, "turn-1"), 2);
        assert_eq!(input.len(), 2);
        assert!(matches!(input[0], ResponseItem::FunctionCallOutput { .. }));
        assert!(matches!(input[1], ResponseItem::Reasoning { .. }));
        assert_eq!(input[1].turn_id(), Some("turn-2"));
    }

    #[test]
    fn expire_reasoning_items_is_a_no_op_for_another_turn() {
        let mut input = vec![reasoning("turn-2"), output("keep", "ok".to_string())];
        assert_eq!(expire_reasoning_items_for_turn(&mut input, "turn-1"), 0);
        assert_eq!(input.len(), 2);
    }
}

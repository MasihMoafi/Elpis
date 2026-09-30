//! Elpis: hidden reasoning expires from working history once its turn has ended.
//!
//! Copied from v0.3.0 `core/src/context_cleaner.rs` and its `Session` method. The reasoning
//! item must remain available across every model/tool sampling step of the active turn. The
//! exact item remains in the durable rollout; only model-visible working history changes.
//! `tasks/regular.rs` calls this when a turn ends with an answer and no queued input.

use codex_protocol::models::ResponseItem;

use super::session::Session;

/// Whether `item` is hidden reasoning produced by the turn `turn_id`.
pub(crate) fn is_reasoning_of_turn(item: &ResponseItem, turn_id: &str) -> bool {
    matches!(item, ResponseItem::Reasoning { .. }) && item.turn_id() == Some(turn_id)
}

impl Session {
    /// Drops the finished turn's reasoning from working history; returns how many went.
    pub(crate) async fn expire_reasoning_items_for_turn(&self, turn_id: &str) -> usize {
        let mut state = self.state.lock().await;
        state
            .history
            .remove_items_where(|item| is_reasoning_of_turn(item, turn_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;
    use pretty_assertions::assert_eq;

    fn output(call_id: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: Some(call_id.to_string()),
            name: None,
            namespace: None,
            output: FunctionCallOutputPayload::from_text("ok".to_string()),
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
    fn only_reasoning_of_the_completed_turn_expires() {
        let items = [
            reasoning("turn-1"),
            output("keep"),
            reasoning("turn-2"),
            reasoning("turn-1"),
        ];
        let expired = items
            .iter()
            .map(|item| is_reasoning_of_turn(item, "turn-1"))
            .collect::<Vec<_>>();
        assert_eq!(expired, vec![true, false, false, true]);
    }

    #[test]
    fn another_turn_expires_nothing() {
        let items = [reasoning("turn-2"), output("keep")];
        assert!(!items.iter().any(|item| is_reasoning_of_turn(item, "turn-1")));
    }

    #[test]
    fn reasoning_without_a_turn_id_never_expires() {
        let item = ResponseItem::Reasoning {
            id: None,
            summary: Vec::new(),
            content: None,
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        };
        assert!(!is_reasoning_of_turn(&item, "turn-1"));
    }
}

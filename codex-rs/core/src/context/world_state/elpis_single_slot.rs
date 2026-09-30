//! Elpis: single-slot World State sections.
//!
//! A single-slot section keeps at most one copy of its fragment in model-visible history.
//! A refill or a withdrawal removes every earlier copy, and an unchanged slot keeps only its
//! newest copy. This is what makes a Context Ledger exclusion real: the excluded text leaves
//! the next request instead of staying in it behind a note asking the model to ignore it.
//! Ported from Elpis v0.3.0 (`WorldState::vacate_single_slot_fragments`).

use std::collections::BTreeSet;
use std::sync::Arc;

use codex_history::ResponseItemEnvelope;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;

use super::ErasedWorldStateSection;
use super::WorldState;

impl WorldState {
    /// Reconciles every single-slot section against retained history. `refilled` names the
    /// sections that rendered a new fragment in this update; their older copies all go. An
    /// empty slot loses every copy; an unchanged visible slot keeps only its newest copy.
    /// Returns whether history changed. History is cloned only when something is removed.
    pub(crate) fn vacate_single_slot_fragments(
        &self,
        items: &mut Arc<Vec<ResponseItemEnvelope>>,
        refilled: &BTreeSet<&str>,
    ) -> bool {
        let single_slots = self
            .sections
            .iter()
            .filter(|(_, section)| section.owns_single_history_slot())
            .map(|(id, section)| (*id, section.as_ref()))
            .collect::<Vec<_>>();
        if single_slots.is_empty() {
            return false;
        }
        let removals = stale_slot_contents(items.as_slice(), &single_slots, refilled);
        if removals.is_empty() {
            return false;
        }
        let items = Arc::make_mut(items);
        // Newest first, and content indices descending, so each removal keeps the remaining
        // indices valid.
        for (item_index, content_indices) in removals {
            let ResponseItem::Message {
                content,
                internal_chat_message_metadata_passthrough,
                ..
            } = &mut items[item_index].item
            else {
                continue;
            };
            // Content kinds are aligned with content entries; keep them aligned.
            let mut kinds = internal_chat_message_metadata_passthrough
                .as_mut()
                .and_then(|metadata| metadata.content_item_kinds.as_mut());
            let kinds_aligned = kinds
                .as_ref()
                .is_some_and(|kinds| kinds.len() == content.len());
            for content_index in content_indices {
                content.remove(content_index);
                if kinds_aligned && let Some(kinds) = kinds.as_mut() {
                    kinds.remove(content_index);
                }
            }
            if content.is_empty() {
                items.remove(item_index);
            }
        }
        true
    }
}

/// Finds the retained single-slot copies that must go, as `(item index, content indices)`
/// with both levels ordered newest first.
fn stale_slot_contents(
    items: &[ResponseItemEnvelope],
    single_slots: &[(&'static str, &(dyn ErasedWorldStateSection + 'static))],
    refilled: &BTreeSet<&str>,
) -> Vec<(usize, Vec<usize>)> {
    let mut newest_retained = BTreeSet::<&str>::new();
    let mut removals = Vec::new();
    for (item_index, envelope) in items.iter().enumerate().rev() {
        let ResponseItem::Message { role, content, .. } = &envelope.item else {
            continue;
        };
        let mut stale = Vec::new();
        for (content_index, content) in content.iter().enumerate().rev() {
            let ContentItem::InputText { text } = content else {
                continue;
            };
            let mut matched_slot = None;
            let mut remove = false;
            for (id, section) in single_slots {
                if !section.matches_retained_fragment(role, text) {
                    continue;
                }
                if refilled.contains(*id)
                    || !section.has_model_visible_content()
                    || newest_retained.contains(*id)
                {
                    remove = true;
                    break;
                }
                matched_slot = Some(*id);
            }
            if remove {
                stale.push(content_index);
            } else if let Some(id) = matched_slot {
                newest_retained.insert(id);
            }
        }
        if !stale.is_empty() {
            removals.push((item_index, stale));
        }
    }
    removals
}

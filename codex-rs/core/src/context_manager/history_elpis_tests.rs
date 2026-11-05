//! Elpis: single-slot history reconciliation.
//!
//! Each test reads model-visible history after the update. Between compactions a change is
//! appended and the earlier history stays byte-identical, so the prompt cache keeps it.

use super::*;
use crate::agents_md::LoadedAgentsMd;
use crate::context::UserInstructions;
use crate::context::world_state::AgentsMdState;
use crate::context::world_state::WorldState;
use codex_extension_api::PreviousWorldStateSection;
use codex_extension_api::RenderedWorldStateFragment;
use codex_extension_api::WorldStateSectionContribution;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ContentItemKind;
use codex_protocol::models::ResponseItem;
use codex_utils_output_truncation::TruncationPolicy;
use pretty_assertions::assert_eq;
use serde_json::json;

fn agents_md_world_state(instructions: Option<&str>) -> WorldState {
    let mut state = WorldState::default();
    match instructions {
        Some(text) => {
            let loaded = LoadedAgentsMd::from_text_for_testing(text);
            state.add_section(AgentsMdState::new(Some(&loaded)));
        }
        None => state.add_section(AgentsMdState::default()),
    }
    state
}

/// Applies one update the way the session does: render, then record what it produced.
/// Returns the number of fragments rendered.
fn apply_world_state(history: &mut ContextManager, world_state: &WorldState) -> usize {
    let (updates, _) = history.update_world_state(world_state);
    let emitted = updates.len();
    let items = crate::context_manager::updates::merge_world_state_updates(updates);
    history.record_items(items.iter(), TruncationPolicy::Tokens(10_000));
    emitted
}

fn history_texts(history: &ContextManager) -> Vec<String> {
    history
        .raw_items()
        .filter_map(|item| match item {
            ResponseItem::Message { content, .. } => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|content| match content {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                Some(text.clone())
            }
            _ => None,
        })
        .collect()
}

fn instruction_copies(history: &ContextManager) -> usize {
    history_texts(history)
        .iter()
        .filter(|text| UserInstructions::matches_text(text))
        .count()
}

fn instruction_lifecycle_notices(history: &ContextManager) -> usize {
    history_texts(history)
        .iter()
        .filter(|text| {
            text.contains("replace all previously provided") || text.contains("no longer apply")
        })
        .count()
}

/// Earlier history, as the provider's prompt cache sees it.
fn raw_history(history: &ContextManager) -> Vec<ResponseItem> {
    history.raw_items().cloned().collect()
}

/// A withdrawal is appended as a note: the earlier history stays byte-identical, so the prompt
/// cache keeps it (Masih, 5 Nov). The copy and the note leave at the next compaction.
#[test]
fn withdrawing_instructions_appends_a_note_and_keeps_the_earlier_history() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("project rule")));
    let before = raw_history(&history);
    let version_before_withdrawal = history.history_version();

    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(/*instructions*/ None)),
        1,
        "a withdrawal renders one note"
    );
    let after = raw_history(&history);
    assert_eq!(
        &after[..before.len()],
        &before[..],
        "a withdrawal must not change the earlier history"
    );
    assert_eq!(history.history_version(), version_before_withdrawal);
    let texts = history_texts(&history);
    assert!(
        texts.last().is_some_and(
            |text| text.contains(crate::context::world_state::AGENTS_MD_WITHDRAWN_NOTE)
        ),
        "the last message says the instructions were withdrawn: {texts:?}"
    );

    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(Some("project rule"))),
        1,
        "re-admitting appends the instructions again"
    );
    assert!(
        history_texts(&history)
            .last()
            .is_some_and(|text| text.contains("project rule"))
    );
}

/// A change appends the new text after the history; the old copy stays until compaction.
#[test]
fn changed_instructions_are_appended_after_the_earlier_history() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("old rule")));
    let before = raw_history(&history);
    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(Some("new rule"))),
        1
    );
    let after = raw_history(&history);
    assert_eq!(&after[..before.len()], &before[..]);
    assert!(
        history_texts(&history)
            .last()
            .is_some_and(|text| text.contains("new rule"))
    );
}

/// A withdrawal between sampling steps of one turn renders the note for the next request
/// without touching the history, and persists the change only once the step's baseline commits.
#[test]
fn step_withdrawal_renders_a_note_without_rewriting_history() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("project rule")));
    let before = raw_history(&history);

    let (snapshot, updates, rollout_item) =
        history.render_step_world_state(&agents_md_world_state(/*instructions*/ None));
    assert_eq!(updates.len(), 1, "the note");
    assert_eq!(raw_history(&history), before);
    assert!(
        rollout_item.is_some(),
        "the withdrawal changes the snapshot"
    );

    history.set_world_state_baseline(snapshot);
    let (updates, rollout_item) =
        history.update_world_state(&agents_md_world_state(/*instructions*/ None));
    assert!(updates.is_empty());
    assert!(
        rollout_item.is_none(),
        "an unchanged withdrawal is not persisted again"
    );
}

/// Compaction is where earlier copies and notes go: every single-slot copy leaves the
/// compacted history, and neighbouring content stays.
#[test]
fn compaction_removes_every_single_slot_copy() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("old rule")));
    apply_world_state(&mut history, &agents_md_world_state(/*instructions*/ None));
    apply_world_state(&mut history, &agents_md_world_state(Some("new rule")));
    assert_eq!(instruction_copies(&history), 3);
    let mut items = Arc::new(
        std::iter::once(ResponseItemEnvelope::new(developer_msg(&["kept"])))
            .chain(history.raw_items().cloned().map(ResponseItemEnvelope::new))
            .collect::<Vec<_>>(),
    );
    assert!(agents_md_world_state(Some("new rule")).vacate_all_single_slot_fragments(&mut items));
    let texts = items
        .iter()
        .filter_map(|envelope| match &envelope.item {
            ResponseItem::Message { content, .. } => Some(content.clone()),
            _ => None,
        })
        .flatten()
        .filter_map(|content| match content {
            ContentItem::InputText { text } => Some(text),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(texts, vec!["kept".to_string()]);
}

/// History rewrites drop the World State baseline while the rendered copy survives. The
/// section may resupply its text, but the request still carries exactly one copy.
#[test]
fn history_rewrites_keep_exactly_one_instruction_copy() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("project rule")));
    for pass in 0..3 {
        let retained = history.raw_items().cloned().collect::<Vec<_>>();
        history.replace(retained);
        apply_world_state(&mut history, &agents_md_world_state(Some("project rule")));
        assert_eq!(
            instruction_copies(&history),
            1,
            "rewrite {pass} left a duplicate instruction copy"
        );
    }
    assert_eq!(instruction_lifecycle_notices(&history), 0);
}

fn extension_single_slot(body: Option<&str>) -> WorldState {
    let body = body.map(str::to_string);
    let has_model_visible_content = body.is_some();
    let mut state = WorldState::default();
    state.add_extension_section(
        WorldStateSectionContribution::new("extension_single_slot", move |previous| {
            let snapshot = Some(json!({ "body": body }));
            if matches!(
                previous,
                PreviousWorldStateSection::Known(previous)
                    if previous.get("body").and_then(serde_json::Value::as_str)
                        == body.as_deref()
            ) {
                return (snapshot, None);
            }
            let fragment = body
                .as_ref()
                .map(|body| RenderedWorldStateFragment::new("developer", ("", ""), body.clone()));
            (snapshot, fragment)
        })
        .with_retained_fragment_matcher(|role, text| {
            role == "developer" && matches!(text, "extension before" | "extension after")
        })
        .with_single_history_slot(has_model_visible_content),
    );
    state
}

fn developer_msg(texts: &[&str]) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "developer".to_string(),
        content: texts
            .iter()
            .map(|text| ContentItem::InputText {
                text: (*text).to_string(),
            })
            .collect(),
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn first_message_kinds(history: &ContextManager) -> Option<Vec<ContentItemKind>> {
    match history.raw_items().next() {
        Some(ResponseItem::Message {
            internal_chat_message_metadata_passthrough,
            ..
        }) => internal_chat_message_metadata_passthrough
            .as_ref()
            .and_then(|metadata| metadata.content_item_kinds.clone()),
        _ => None,
    }
}

/// An extension slot replaces and then removes only its own content: neighbouring developer
/// text in the same message survives, with its content kind still aligned.
#[test]
fn extension_single_slot_replaces_then_removes_only_its_own_content() {
    let mut history = ContextManager::new();
    let (updates, _) = history.update_world_state(&extension_single_slot(Some("extension before")));
    let mut initial_items = crate::context_manager::updates::merge_world_state_updates(updates);
    let ResponseItem::Message {
        content,
        internal_chat_message_metadata_passthrough,
        ..
    } = &mut initial_items[0]
    else {
        panic!("the extension fragment must be a developer message");
    };
    content.insert(
        0,
        ContentItem::InputText {
            text: "neighboring developer content".to_string(),
        },
    );
    internal_chat_message_metadata_passthrough
        .as_mut()
        .and_then(|metadata| metadata.content_item_kinds.as_mut())
        .expect("merged fragments carry content kinds")
        .insert(0, ContentItemKind("neighbor.instructions".to_string()));
    history.record_items(initial_items.iter(), TruncationPolicy::Tokens(10_000));

    assert_eq!(
        apply_world_state(
            &mut history,
            &extension_single_slot(Some("extension after"))
        ),
        1
    );
    assert_eq!(
        history_texts(&history),
        vec![
            "neighboring developer content",
            "extension before",
            "extension after"
        ],
        "a refill is appended; the earlier copy stays until compaction"
    );

    // After a rewrite there is no baseline and no cached prefix to keep: restored copies are
    // reconciled to the newest, removing only the slot's own content and its content kind.
    let (updates, _) =
        ContextManager::new().update_world_state(&extension_single_slot(Some("extension before")));
    let mut restored = crate::context_manager::updates::merge_world_state_updates(updates);
    let ResponseItem::Message {
        content,
        internal_chat_message_metadata_passthrough,
        ..
    } = &mut restored[0]
    else {
        panic!("the extension fragment must be a developer message");
    };
    content.insert(
        0,
        ContentItem::InputText {
            text: "neighboring developer content".to_string(),
        },
    );
    internal_chat_message_metadata_passthrough
        .as_mut()
        .and_then(|metadata| metadata.content_item_kinds.as_mut())
        .expect("merged fragments carry content kinds")
        .insert(0, ContentItemKind("neighbor.instructions".to_string()));
    restored.push(developer_msg(&["extension after"]));
    history.replace(restored);
    let latest = extension_single_slot(Some("extension after"));
    let version_before_deduplication = history.history_version();
    apply_world_state(&mut history, &latest);
    assert!(
        history.history_version() > version_before_deduplication,
        "deduplicating restored content is a history rewrite"
    );
    assert_eq!(
        history_texts(&history),
        vec!["neighboring developer content", "extension after"],
        "only the newest slot copy may remain"
    );
    assert_eq!(
        first_message_kinds(&history),
        Some(vec![ContentItemKind("neighbor.instructions".to_string())]),
        "removing the slot's content must remove its content kind too"
    );

    let version_before_unchanged_update = history.history_version();
    let (fragments, rollout_item) = history.update_world_state(&latest);
    assert!(fragments.is_empty());
    assert_eq!(rollout_item, None);
    assert_eq!(
        history.history_version(),
        version_before_unchanged_update,
        "an unchanged reconciled slot must not rewrite history"
    );

    let before = raw_history(&history);
    assert_eq!(
        apply_world_state(&mut history, &extension_single_slot(/*body*/ None)),
        0
    );
    assert_eq!(
        raw_history(&history),
        before,
        "an emptied slot leaves the history alone until compaction"
    );
}

/// A section that does not own a slot keeps upstream's append-only behaviour.
#[test]
fn sections_without_a_slot_are_never_removed() {
    let mut history = ContextManager::new();
    history.replace(vec![
        developer_msg(&["extension before"]),
        developer_msg(&["extension after"]),
    ]);
    let mut state = WorldState::default();
    state.add_extension_section(
        WorldStateSectionContribution::new("extension_append_only", |_| (Some(json!({})), None))
            .with_retained_fragment_matcher(|role, text| {
                role == "developer" && matches!(text, "extension before" | "extension after")
            }),
    );
    history.update_world_state(&state);
    assert_eq!(
        history_texts(&history),
        vec!["extension before", "extension after"]
    );
}

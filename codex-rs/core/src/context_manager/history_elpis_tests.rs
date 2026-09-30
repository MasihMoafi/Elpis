//! Elpis: single-slot history reconciliation, ported from v0.3.0's history tests.
//!
//! Each test reads model-visible history after the update, so "off" has to mean the text is
//! gone and "on" has to mean exactly one copy.

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
    let (fragments, _) = history.update_world_state(world_state);
    let emitted = fragments.len();
    let items = crate::context_manager::updates::merge_contextual_fragments(fragments);
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

/// Off means absent: the copy an earlier turn appended must leave the request, and
/// switching the row back on restores exactly one copy.
#[test]
fn withdrawing_instructions_removes_the_earlier_copy_from_history() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("project rule")));
    assert_eq!(instruction_copies(&history), 1);

    let version_before_withdrawal = history.history_version();
    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(/*instructions*/ None)),
        0
    );
    assert_eq!(
        instruction_copies(&history),
        0,
        "a withdrawn instruction source must not remain in model-visible history"
    );
    assert!(
        !history_texts(&history)
            .iter()
            .any(|text| text.contains("project rule")),
        "withdrawn instruction text must be gone, not merely superseded"
    );
    assert!(
        history.history_version() > version_before_withdrawal,
        "removing a copy is a history rewrite"
    );

    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(Some("project rule"))),
        1
    );
    assert_eq!(instruction_copies(&history), 1);
    assert_eq!(instruction_lifecycle_notices(&history), 0);
}

/// A change supplies the new text once and removes the old copy, without a notice.
#[test]
fn changed_instructions_replace_the_earlier_copy() {
    let mut history = ContextManager::new();
    apply_world_state(&mut history, &agents_md_world_state(Some("old rule")));
    assert_eq!(
        apply_world_state(&mut history, &agents_md_world_state(Some("new rule"))),
        1
    );

    let texts = history_texts(&history);
    assert_eq!(instruction_copies(&history), 1);
    assert!(texts.iter().any(|text| text.contains("new rule")));
    assert!(!texts.iter().any(|text| text.contains("old rule")));
    assert_eq!(instruction_lifecycle_notices(&history), 0);
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
    let snapshot_body = body.clone();
    let mut state = WorldState::default();
    state.add_extension_section(
        WorldStateSectionContribution::new(
            "extension_single_slot",
            json!({ "body": snapshot_body }),
            move |previous| {
                if matches!(
                    previous,
                    PreviousWorldStateSection::Known(previous)
                        if previous.get("body").and_then(serde_json::Value::as_str)
                            == body.as_deref()
                ) {
                    return None;
                }
                body.as_ref().map(|body| {
                    RenderedWorldStateFragment::new("developer", ("", ""), body.clone())
                })
            },
        )
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
    let (fragments, _) =
        history.update_world_state(&extension_single_slot(Some("extension before")));
    let mut initial_items = crate::context_manager::updates::merge_contextual_fragments(fragments);
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
        vec!["neighboring developer content", "extension after"]
    );
    assert_eq!(
        first_message_kinds(&history),
        Some(vec![ContentItemKind("neighbor.instructions".to_string())]),
        "removing the slot's content must remove its content kind too"
    );

    // Restored history can hold several copies; an unchanged slot keeps only the newest.
    history.replace(vec![
        developer_msg(&["neighboring developer content"]),
        developer_msg(&["extension before"]),
        developer_msg(&["extension after"]),
    ]);
    let latest = extension_single_slot(Some("extension after"));
    history.set_world_state_baseline(latest.snapshot());
    let version_before_deduplication = history.history_version();
    let (fragments, rollout_item) = history.update_world_state(&latest);
    assert!(
        fragments.is_empty(),
        "an unchanged slot must not re-render"
    );
    assert_eq!(rollout_item, None);
    assert_eq!(
        history.history_version(),
        version_before_deduplication.saturating_add(1),
        "deduplicating restored content must invalidate history exactly once"
    );
    assert_eq!(
        history_texts(&history),
        vec!["neighboring developer content", "extension after"],
        "only the newest slot copy may remain"
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

    assert_eq!(
        apply_world_state(&mut history, &extension_single_slot(/*body*/ None)),
        0
    );
    assert_eq!(
        history_texts(&history),
        vec!["neighboring developer content"]
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
        WorldStateSectionContribution::new("extension_append_only", json!({}), |_| None)
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

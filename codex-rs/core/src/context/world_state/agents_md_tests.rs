// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;
use crate::context::world_state::WorldState;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn renders_full_state_and_omits_unchanged_state() {
    let loaded = LoadedAgentsMd::from_text_for_testing("use the project formatter");
    let mut state = WorldState::default();
    state.add_section(AgentsMdState::new(Some(&loaded)));

    assert_eq!(
        vec![user_message(
            "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nuse the project formatter\n</INSTRUCTIONS>",
        )],
        render_fragments(state.render_full()),
    );
    assert_eq!(
        Vec::<ResponseItem>::new(),
        render_fragments(state.render_diff(&state.snapshot()))
    );
    assert_eq!(
        state.snapshot().into_value(),
        json!({"agents_md": {"text": "use the project formatter"}}),
    );
}

/// A change supplies the new text; a withdrawal supplies nothing at all. The section owns
/// one history slot, so the earlier copy is removed rather than argued with.
#[test]
fn changed_state_is_supplied_once_and_removed_state_is_supplied_not_at_all() {
    let previous_loaded = LoadedAgentsMd::from_text_for_testing("old instructions");
    let mut previous = WorldState::default();
    previous.add_section(AgentsMdState::new(Some(&previous_loaded)));

    let current_loaded = LoadedAgentsMd::from_text_for_testing("new instructions");
    let mut current = WorldState::default();
    current.add_section(AgentsMdState::new(Some(&current_loaded)));
    assert_eq!(
        vec![user_message(
            "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nnew instructions\n</INSTRUCTIONS>",
        )],
        render_fragments(current.render_diff(&previous.snapshot())),
    );

    let mut removed = WorldState::default();
    removed.add_section(AgentsMdState::default());
    assert_eq!(
        Vec::<ResponseItem>::new(),
        render_fragments(removed.render_diff(&current.snapshot())),
    );
    assert!(!removed_state_has_content());
}

/// A previous state that cannot be recovered at all is the one case left where the current
/// instructions are supplied again -- still exactly once, and still without a notice,
/// because the slot is emptied before the new copy lands.
#[test]
fn unrecoverable_previous_state_supplies_the_current_instructions_once() {
    let loaded = LoadedAgentsMd::from_text_for_testing("current instructions");
    let current = AgentsMdState::new(Some(&loaded));
    assert_eq!(
        vec![user_message(
            "# AGENTS.md instructions\n\n<INSTRUCTIONS>\ncurrent instructions\n</INSTRUCTIONS>",
        )],
        render_fragments(vec![
            WorldStateSection::render_diff(&current, PreviousSectionState::Unknown)
                .expect("unknown state should be resupplied"),
        ]),
    );

    assert!(
        WorldStateSection::render_diff(&AgentsMdState::default(), PreviousSectionState::Unknown)
            .is_none(),
        "a section with nothing to say must say nothing"
    );
}

/// Round-trips the rendered fragment back into the snapshot that produced it, which is what
/// lets a lost baseline be answered exactly instead of guessed at.
#[test]
fn rendered_instructions_round_trip_back_into_their_snapshot() {
    for state in [
        AgentsMdState {
            instructions: Some(UserInstructions {
                directory: None,
                text: "plain instructions".to_string(),
            }),
        },
        AgentsMdState {
            instructions: Some(UserInstructions {
                directory: Some("/repo/workspace".to_string()),
                text: "scoped\ninstructions".to_string(),
            }),
        },
    ] {
        let rendered = state
            .instructions
            .as_ref()
            .map(ContextualUserFragment::render)
            .expect("instructions");
        assert_eq!(
            AgentsMdState::snapshot_from_retained_fragment("user", &rendered),
            Some(WorldStateSection::snapshot(&state)),
            "failed to recover state from {rendered:?}"
        );
    }
    assert_eq!(
        AgentsMdState::snapshot_from_retained_fragment("user", "not an instruction fragment"),
        None
    );
}

fn removed_state_has_content() -> bool {
    WorldStateSection::has_model_visible_content(&AgentsMdState::default())
}

/// Every history rewrite clears the world-state baseline while the rendered fragment
/// survives in retained history: context pruning, rollback, and the end-of-turn reasoning
/// expiry that runs after almost every ordinary turn. Treating that as "unknown" and
/// resupplying the instructions is what stacked copy after copy into the model's context.
#[test]
fn unchanged_instructions_are_not_resupplied_after_the_baseline_is_lost() {
    let loaded = LoadedAgentsMd::from_text_for_testing("use the project formatter");
    let mut state = WorldState::default();
    state.add_section(AgentsMdState::new(Some(&loaded)));
    let history = render_fragments(state.render_full());

    assert_eq!(
        Vec::<ResponseItem>::new(),
        render_fragments(state.render_history_diff(None, &history)),
    );
}

/// A genuine change supplies the new text once. It never narrates the change: the earlier
/// copy is removed from the slot, so there is nothing left to "replace" in words.
#[test]
fn changed_instructions_are_supplied_once_without_a_replacement_notice() {
    let previous_loaded = LoadedAgentsMd::from_text_for_testing("old instructions");
    let mut previous = WorldState::default();
    previous.add_section(AgentsMdState::new(Some(&previous_loaded)));
    let history = render_fragments(previous.render_full());

    let current_loaded = LoadedAgentsMd::from_text_for_testing("new instructions");
    let mut current = WorldState::default();
    current.add_section(AgentsMdState::new(Some(&current_loaded)));
    let expected = vec![user_message(
        "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nnew instructions\n</INSTRUCTIONS>",
    )];

    assert_eq!(
        expected,
        render_fragments(current.render_diff(&previous.snapshot())),
    );
    assert_eq!(
        expected,
        render_fragments(current.render_history_diff(None, &history)),
    );
}

/// Switching the ledger row off has to vacate the slot, not append a note saying the
/// earlier copy no longer counts -- that earlier copy is exactly what keeps the
/// instruction alive in the request.
#[test]
fn instructions_that_are_no_longer_admitted_render_nothing() {
    let loaded = LoadedAgentsMd::from_text_for_testing("project rule");
    let mut previous = WorldState::default();
    previous.add_section(AgentsMdState::new(Some(&loaded)));
    let history = render_fragments(previous.render_full());

    let mut disabled = WorldState::default();
    disabled.add_section(AgentsMdState::default());
    assert_eq!(
        Vec::<ResponseItem>::new(),
        render_fragments(disabled.render_diff(&previous.snapshot())),
    );
    assert_eq!(
        Vec::<ResponseItem>::new(),
        render_fragments(disabled.render_history_diff(None, &history)),
    );
}

fn render_fragments(fragments: Vec<Box<dyn ContextualUserFragment>>) -> Vec<ResponseItem> {
    fragments
        .into_iter()
        .map(ContextualUserFragment::into_boxed_response_item)
        .collect()
}

fn user_message(text: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText {
            text: text.to_string(),
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

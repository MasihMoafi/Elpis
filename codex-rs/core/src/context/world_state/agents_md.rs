use super::PreviousSectionState;
use super::WorldStateSection;
use crate::agents_md::LoadedAgentsMd;
use crate::context::ContextualUserFragment;
use crate::context::UserInstructions;
use serde::Deserialize;
use serde::Serialize;

/// The AGENTS.md instructions currently visible to the model.
#[derive(Clone, Debug, Default)]
pub(crate) struct AgentsMdState {
    instructions: Option<UserInstructions>,
}

/// Persisted model-visible AGENTS.md state, without filesystem provenance.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct AgentsMdSnapshot {
    directory: Option<String>,
    text: Option<String>,
}

impl AgentsMdState {
    pub(crate) fn new(loaded: Option<&LoadedAgentsMd>) -> Self {
        Self {
            instructions: loaded.map(LoadedAgentsMd::contextual_user_fragment),
        }
    }
}

impl WorldStateSection for AgentsMdState {
    const ID: &'static str = "agents_md";
    type Snapshot = AgentsMdSnapshot;

    fn snapshot(&self) -> Self::Snapshot {
        match &self.instructions {
            Some(instructions) => AgentsMdSnapshot {
                directory: instructions.directory.clone(),
                text: Some(instructions.text.clone()),
            },
            None => AgentsMdSnapshot::default(),
        }
    }

    fn matches_legacy_fragment(role: &str, text: &str) -> bool {
        role == "user" && UserInstructions::matches_text(text)
    }

    fn has_retained_fragment_matcher() -> bool {
        true
    }

    fn matches_retained_fragment(role: &str, text: &str) -> bool {
        Self::matches_legacy_fragment(role, text)
    }

    /// The rendered fragment carries the full instruction text, so a lost baseline can be
    /// answered exactly rather than guessed at.
    fn snapshot_from_retained_fragment(role: &str, text: &str) -> Option<Self::Snapshot> {
        if !Self::matches_retained_fragment(role, text) {
            return None;
        }
        parse_rendered_instructions(text)
    }

    fn owns_single_history_slot() -> bool {
        true
    }

    fn has_model_visible_content(&self) -> bool {
        self.instructions.is_some()
    }

    fn render_diff(
        &self,
        previous: PreviousSectionState<'_, Self::Snapshot>,
    ) -> Option<Box<dyn ContextualUserFragment>> {
        let current = self.snapshot();
        if matches!(previous, PreviousSectionState::Known(previous) if previous == &current) {
            return None;
        }

        // This section owns one history slot: any earlier copy is removed before this one
        // is recorded, and withdrawal empties the slot outright. There is therefore never
        // a previous copy left to supersede, so nothing has to be said about one.
        self.instructions
            .clone()
            .map(|instructions| Box::new(instructions) as Box<dyn ContextualUserFragment>)
    }
}

/// Inverse of `UserInstructions::render` for the shapes this section produces:
/// `# AGENTS.md instructions[ for <dir>]\n\n<INSTRUCTIONS>\n<text>\n</INSTRUCTIONS>`.
fn parse_rendered_instructions(text: &str) -> Option<AgentsMdSnapshot> {
    let (start_marker, end_marker) = UserInstructions::type_markers();
    let body = text
        .trim()
        .strip_prefix(start_marker)?
        .strip_suffix(end_marker)?;
    let (heading, instructions) = body.split_once("\n\n<INSTRUCTIONS>\n")?;
    let directory = heading.trim().strip_prefix("for ").map(str::to_string);
    // `body` appends exactly one newline after the text; removing more would recover a
    // different snapshot than the one that produced this fragment.
    Some(AgentsMdSnapshot {
        directory,
        text: Some(
            instructions
                .strip_suffix('\n')
                .unwrap_or(instructions)
                .to_string(),
        ),
    })
}

#[cfg(test)]
#[path = "agents_md_tests.rs"]
mod tests;

use super::PreviousSectionState;
use super::SectionTransition;
use super::WorldStateSection;
use super::WorldStateUpdate;
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

    fn matches_legacy_fragment(role: &str, text: &str) -> bool {
        role == "user" && UserInstructions::matches_text(text)
    }

    // Elpis: AGENTS.md owns one history slot, so a Context Ledger exclusion removes the
    // earlier copy from the next request instead of appending a note that it no longer applies.
    fn has_retained_fragment_matcher() -> bool {
        true
    }

    fn matches_retained_fragment(role: &str, text: &str) -> bool {
        Self::matches_legacy_fragment(role, text)
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
    ) -> SectionTransition<Self::Snapshot> {
        let current = match &self.instructions {
            Some(instructions) => AgentsMdSnapshot {
                directory: instructions.directory.clone(),
                text: Some(instructions.text.clone()),
            },
            None => AgentsMdSnapshot::default(),
        };
        if matches!(previous, PreviousSectionState::Known(previous) if previous == &current) {
            return (None, Vec::new());
        }

        (
            Some(current),
            self.instructions
                .clone()
                .into_iter()
                .map(WorldStateUpdate::fragment)
                .collect(),
        )
    }
}

#[cfg(test)]
#[path = "agents_md_tests.rs"]
mod tests;

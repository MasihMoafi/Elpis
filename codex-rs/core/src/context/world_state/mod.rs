// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
mod agents_md;
mod apps_instructions;
mod environment;
mod plugins_instructions;

use crate::context::ContextualUserFragment;
use codex_extension_api::PreviousWorldStateSection;
use codex_extension_api::RenderedWorldStateFragment;
use codex_extension_api::WorldStateSectionContribution;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use indexmap::IndexMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fmt;

pub(crate) use agents_md::AgentsMdState;
pub(crate) use apps_instructions::AppsInstructionsState;
pub(crate) use environment::EnvironmentsState;
pub(crate) use plugins_instructions::PluginsInstructionsState;

trait ErasedWorldStateSection: Send + Sync {
    fn snapshot(&self) -> Option<Value>;

    fn matches_legacy_fragment(&self, role: &str, text: &str) -> bool;

    fn has_retained_fragment_matcher(&self) -> bool;

    fn matches_retained_fragment(&self, role: &str, text: &str) -> bool;

    fn snapshot_from_retained_fragment(&self, role: &str, text: &str) -> Option<Value>;

    fn owns_single_history_slot(&self) -> bool;

    fn has_model_visible_content(&self) -> bool;

    fn render_diff(
        &self,
        previous: PreviousSectionState<'_, Value>,
    ) -> Option<Box<dyn ContextualUserFragment>>;
}

impl<S: WorldStateSection> ErasedWorldStateSection for S {
    fn snapshot(&self) -> Option<Value> {
        let mut snapshot = match serde_json::to_value(WorldStateSection::snapshot(self)) {
            Ok(snapshot) => snapshot,
            Err(err) => {
                tracing::error!(
                    section_id = S::ID,
                    %err,
                    "failed to serialize world-state section snapshot"
                );
                return None;
            }
        };
        remove_null_object_fields(&mut snapshot);
        if snapshot.is_null() {
            tracing::error!(
                section_id = S::ID,
                "world-state section snapshot cannot be null"
            );
            return None;
        }
        Some(snapshot)
    }

    fn matches_legacy_fragment(&self, role: &str, text: &str) -> bool {
        S::matches_legacy_fragment(role, text)
    }

    fn has_retained_fragment_matcher(&self) -> bool {
        S::has_retained_fragment_matcher()
    }

    fn matches_retained_fragment(&self, role: &str, text: &str) -> bool {
        S::matches_retained_fragment(role, text)
    }

    fn snapshot_from_retained_fragment(&self, role: &str, text: &str) -> Option<Value> {
        let snapshot = S::snapshot_from_retained_fragment(role, text)?;
        let mut snapshot = serde_json::to_value(snapshot)
            .inspect_err(|err| {
                tracing::warn!(
                    section_id = S::ID,
                    %err,
                    "failed to serialize world-state section snapshot recovered from history"
                );
            })
            .ok()?;
        remove_null_object_fields(&mut snapshot);
        (!snapshot.is_null()).then_some(snapshot)
    }

    fn owns_single_history_slot(&self) -> bool {
        S::owns_single_history_slot()
    }

    fn has_model_visible_content(&self) -> bool {
        WorldStateSection::has_model_visible_content(self)
    }

    fn render_diff(
        &self,
        previous: PreviousSectionState<'_, Value>,
    ) -> Option<Box<dyn ContextualUserFragment>> {
        let typed_snapshot;
        let previous = match previous {
            PreviousSectionState::Known(previous) => {
                match serde_json::from_value::<S::Snapshot>(previous.clone()) {
                    Ok(previous) => {
                        typed_snapshot = previous;
                        PreviousSectionState::Known(&typed_snapshot)
                    }
                    Err(err) => {
                        tracing::warn!(
                            section_id = S::ID,
                            %err,
                            "failed to restore world-state section snapshot"
                        );
                        PreviousSectionState::Unknown
                    }
                }
            }
            PreviousSectionState::Absent => PreviousSectionState::Absent,
            PreviousSectionState::Unknown => PreviousSectionState::Unknown,
        };
        WorldStateSection::render_diff(self, previous)
    }
}

struct ExtensionWorldStateSection(WorldStateSectionContribution);

impl ErasedWorldStateSection for ExtensionWorldStateSection {
    fn snapshot(&self) -> Option<Value> {
        let mut snapshot = self.0.snapshot().clone();
        remove_null_object_fields(&mut snapshot);
        (!snapshot.is_null()).then_some(snapshot)
    }

    fn matches_legacy_fragment(&self, role: &str, text: &str) -> bool {
        self.0.matches_legacy_fragment(role, text)
    }

    fn has_retained_fragment_matcher(&self) -> bool {
        self.0.has_retained_fragment_matcher()
    }

    fn matches_retained_fragment(&self, role: &str, text: &str) -> bool {
        self.0.matches_retained_fragment(role, text)
    }

    /// Extension-owned sections keep the conservative behaviour: without a way to recover
    /// their state from a rendered fragment, a lost baseline stays unknown.
    fn snapshot_from_retained_fragment(&self, _role: &str, _text: &str) -> Option<Value> {
        None
    }

    fn owns_single_history_slot(&self) -> bool {
        false
    }

    fn has_model_visible_content(&self) -> bool {
        true
    }

    fn render_diff(
        &self,
        previous: PreviousSectionState<'_, Value>,
    ) -> Option<Box<dyn ContextualUserFragment>> {
        let previous = match previous {
            PreviousSectionState::Absent => PreviousWorldStateSection::Absent,
            PreviousSectionState::Unknown => PreviousWorldStateSection::Unknown,
            PreviousSectionState::Known(previous) => PreviousWorldStateSection::Known(previous),
        };
        self.0
            .render_diff(previous)
            .map(|fragment| Box::new(WorldStateContextFragment(fragment)) as _)
    }
}

struct WorldStateContextFragment(RenderedWorldStateFragment);

impl ContextualUserFragment for WorldStateContextFragment {
    fn role(&self) -> &'static str {
        self.0.role()
    }

    fn markers(&self) -> (&'static str, &'static str) {
        self.0.markers()
    }

    fn body(&self) -> String {
        self.0.body().to_string()
    }

    fn type_markers() -> (&'static str, &'static str) {
        ("", "")
    }
}

/// What is known about a section's previously model-visible state.
pub(crate) enum PreviousSectionState<'a, T> {
    /// No persisted snapshot or matching fragment exists in retained history.
    Absent,
    /// Retained history contains the section, but its typed snapshot is unavailable.
    Unknown,
    /// The exact persisted snapshot is available.
    Known(&'a T),
}

/// A typed portion of the state visible to the model.
///
/// Implementations own how their current state is rendered relative to an
/// earlier snapshot of the same section. `ID` is persisted in rollouts and
/// must remain stable. `Snapshot` should contain only the comparison data
/// needed to decide what the model must be told next, and must not serialize
/// to null because merge-patch nulls represent deletion. Sections migrated
/// from older context can recognize their previous fragments through
/// `matches_legacy_fragment`.
pub(crate) trait WorldStateSection: Send + Sync + 'static {
    const ID: &'static str;
    type Snapshot: DeserializeOwned + Serialize;

    fn snapshot(&self) -> Self::Snapshot;

    fn matches_legacy_fragment(_role: &str, _text: &str) -> bool {
        false
    }

    /// Whether retained history must still contain this section's rendered fragment.
    fn has_retained_fragment_matcher() -> bool {
        false
    }

    /// Recognizes this section's rendered fragment in retained model history.
    fn matches_retained_fragment(_role: &str, _text: &str) -> bool {
        false
    }

    /// Recovers the previously model-visible snapshot from this section's own rendered
    /// fragment in retained history.
    ///
    /// History is rewritten routinely -- context pruning, rollback, and the end-of-turn
    /// reasoning expiry -- and each rewrite drops the persisted baseline while leaving the
    /// rendered fragment in place. Without recovery those rewrites look like "the model
    /// was told something, but we no longer know what", and the only safe answer is to say
    /// it all again. Sections whose fragment carries their full state can answer exactly
    /// instead, so an unchanged section stays byte-identical and provider-cacheable.
    fn snapshot_from_retained_fragment(_role: &str, _text: &str) -> Option<Self::Snapshot>
    where
        Self: Sized,
    {
        None
    }

    /// Whether this section owns exactly one slot in model-visible history.
    ///
    /// A single-slot section never accumulates: any earlier copy is removed before a new
    /// one is appended, and the slot is vacated outright once the section has no content.
    /// This is what makes withdrawal real rather than a note saying to ignore the copy
    /// that is still sitting in the request.
    fn owns_single_history_slot() -> bool
    where
        Self: Sized,
    {
        false
    }

    /// Whether this section currently has anything the model should see. Single-slot
    /// sections that answer `false` have their retained fragment removed from history.
    fn has_model_visible_content(&self) -> bool {
        true
    }

    fn render_diff(
        &self,
        previous: PreviousSectionState<'_, Self::Snapshot>,
    ) -> Option<Box<dyn ContextualUserFragment>>;
}

/// Live model-visible state, keyed by the same stable section IDs used in rollouts.
#[derive(Default)]
pub(crate) struct WorldState {
    sections: IndexMap<&'static str, Box<dyn ErasedWorldStateSection>>,
}

/// Compact comparison state for each model-visible world-state section.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(transparent)]
pub(crate) struct WorldStateSnapshot {
    sections: BTreeMap<String, Value>,
}

impl WorldStateSnapshot {
    pub(crate) fn into_value(self) -> Value {
        Value::Object(self.sections.into_iter().collect())
    }

    /// Returns the RFC 7386 merge patch that advances `previous` to `self`.
    pub(crate) fn merge_patch_from(&self, previous: &Self) -> Option<Value> {
        let previous = Value::Object(previous.sections.clone().into_iter().collect());
        let current = Value::Object(self.sections.clone().into_iter().collect());
        create_merge_patch(&previous, &current)
    }

    pub(crate) fn apply_merge_patch(&mut self, patch: &Value) -> serde_json::Result<()> {
        let mut current = self.clone().into_value();
        apply_merge_patch_value(&mut current, patch);
        *self = serde_json::from_value(current)?;
        Ok(())
    }
}

impl fmt::Debug for WorldState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorldState")
            .field("section_count", &self.sections.len())
            .finish()
    }
}

impl WorldState {
    pub(crate) fn add_section<S: WorldStateSection>(&mut self, section: S) {
        let id = S::ID;
        assert!(
            !self.sections.contains_key(id),
            "duplicate world-state section ID: {id}"
        );
        self.sections.insert(id, Box::new(section));
    }

    pub(crate) fn add_extension_section(&mut self, section: WorldStateSectionContribution) {
        let id = section.id();
        assert!(
            !self.sections.contains_key(id),
            "duplicate world-state section ID: {id}"
        );
        self.sections
            .insert(id, Box::new(ExtensionWorldStateSection(section)));
    }

    pub(crate) fn snapshot(&self) -> WorldStateSnapshot {
        WorldStateSnapshot {
            sections: self
                .sections
                .iter()
                .filter_map(|(id, section)| {
                    section
                        .snapshot()
                        .map(|snapshot| ((*id).to_string(), snapshot))
                })
                .collect(),
        }
    }

    /// Renders every section as new, without any known previous state.
    pub(crate) fn render_full(&self) -> Vec<Box<dyn ContextualUserFragment>> {
        drop_section_ids(self.render_with(|_, _| PreviousSectionState::Absent))
    }

    /// Renders each section against the exact persisted snapshot when available.
    pub(crate) fn render_diff(
        &self,
        previous: &WorldStateSnapshot,
    ) -> Vec<Box<dyn ContextualUserFragment>> {
        drop_section_ids(self.render_with(|id, _| match previous.sections.get(id) {
            Some(previous) => PreviousSectionState::Known(previous),
            None => PreviousSectionState::Absent,
        }))
    }

    /// Falls back to retained model history when no exact persisted snapshot is available.
    pub(crate) fn render_history_diff(
        &self,
        previous: Option<&WorldStateSnapshot>,
        items: &[ResponseItem],
    ) -> Vec<Box<dyn ContextualUserFragment>> {
        self.render_history_diff_with_ids(previous, items)
            .into_iter()
            .map(|(_, fragment)| fragment)
            .collect()
    }

    /// Same as [`Self::render_history_diff`], but names the section each fragment came
    /// from so history can refill exactly the slots that re-rendered.
    pub(crate) fn render_history_diff_with_ids(
        &self,
        previous: Option<&WorldStateSnapshot>,
        items: &[ResponseItem],
    ) -> Vec<(&'static str, Box<dyn ContextualUserFragment>)> {
        // A baseline that survived is authoritative. Where it did not, a section that can
        // read its own rendered fragment back out of history recovers the exact previous
        // state instead of guessing, so a routine history rewrite stops looking like a
        // change and stops resupplying content the model is already holding.
        let recovered: BTreeMap<&str, Value> = self
            .sections
            .iter()
            .filter(|(id, _)| previous.is_none_or(|previous| !previous.sections.contains_key(**id)))
            .filter_map(|(id, section)| {
                recovered_snapshot(items, section.as_ref()).map(|snapshot| (*id, snapshot))
            })
            .collect();

        self.render_with(|id, section| {
            if let Some(previous) = previous.and_then(|previous| previous.sections.get(id)) {
                if section.has_retained_fragment_matcher() && !has_retained_fragment(items, section)
                {
                    PreviousSectionState::Absent
                } else {
                    PreviousSectionState::Known(previous)
                }
            } else if let Some(recovered) = recovered.get(id) {
                PreviousSectionState::Known(recovered)
            } else if has_legacy_fragment(items, section) {
                PreviousSectionState::Unknown
            } else {
                PreviousSectionState::Absent
            }
        })
    }

    /// Empties the history slot of every single-slot section that is about to refill it or
    /// no longer has anything to say. Returns whether any item was changed.
    ///
    /// This is what keeps an admitted source to one effective copy and makes a withdrawn
    /// one actually disappear, instead of leaving earlier copies in the request and
    /// talking the model out of them.
    pub(crate) fn vacate_single_slot_fragments(
        &self,
        items: &mut Vec<ResponseItem>,
        refilled: &BTreeSet<&str>,
    ) -> bool {
        let vacating = self
            .sections
            .iter()
            .filter(|(id, section)| {
                section.owns_single_history_slot()
                    && (refilled.contains(*id) || !section.has_model_visible_content())
            })
            .map(|(_, section)| section.as_ref())
            .collect::<Vec<_>>();
        if vacating.is_empty() {
            return false;
        }

        let mut changed = false;
        items.retain_mut(|item| {
            let ResponseItem::Message { role, content, .. } = item else {
                return true;
            };
            let before = content.len();
            content.retain(|content| {
                let ContentItem::InputText { text } = content else {
                    return true;
                };
                !vacating
                    .iter()
                    .any(|section| section.matches_retained_fragment(role, text))
            });
            changed |= content.len() != before;
            !content.is_empty()
        });
        changed
    }

    fn render_with<'a>(
        &self,
        mut previous: impl FnMut(&str, &dyn ErasedWorldStateSection) -> PreviousSectionState<'a, Value>,
    ) -> Vec<(&'static str, Box<dyn ContextualUserFragment>)> {
        self.sections
            .iter()
            .filter_map(|(id, section)| {
                section
                    .render_diff(previous(id, section.as_ref()))
                    .map(|fragment| (*id, fragment))
            })
            .collect()
    }
}

fn drop_section_ids(
    rendered: Vec<(&'static str, Box<dyn ContextualUserFragment>)>,
) -> Vec<Box<dyn ContextualUserFragment>> {
    rendered.into_iter().map(|(_, fragment)| fragment).collect()
}

/// Reads a section's previous state back out of its own rendered fragment in history.
fn recovered_snapshot(
    items: &[ResponseItem],
    section: &dyn ErasedWorldStateSection,
) -> Option<Value> {
    items.iter().rev().find_map(|item| {
        let ResponseItem::Message { role, content, .. } = item else {
            return None;
        };
        content.iter().rev().find_map(|content| {
            let ContentItem::InputText { text } = content else {
                return None;
            };
            section.snapshot_from_retained_fragment(role, text)
        })
    })
}

fn has_retained_fragment(items: &[ResponseItem], section: &dyn ErasedWorldStateSection) -> bool {
    items.iter().any(|item| {
        matches!(
            item,
            ResponseItem::Message { role, content, .. }
                if content.iter().any(|content| {
                    matches!(
                        content,
                        ContentItem::InputText { text }
                            if section.matches_retained_fragment(role, text)
                    )
                })
        )
    })
}

fn has_legacy_fragment(items: &[ResponseItem], section: &dyn ErasedWorldStateSection) -> bool {
    items.iter().any(|item| {
        matches!(
            item,
            ResponseItem::Message { role, content, .. }
                if content.iter().any(|content| {
                    matches!(
                        content,
                        ContentItem::InputText { text }
                            if section.matches_legacy_fragment(role, text)
                    )
                })
        )
    })
}

fn remove_null_object_fields(value: &mut Value) {
    // RFC 7386 reserves object-valued nulls for deletion, but arrays are replaced whole.
    match value {
        Value::Object(values) => {
            values.retain(|_, value| !value.is_null());
            values.values_mut().for_each(remove_null_object_fields);
        }
        Value::Array(_) => {}
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn create_merge_patch(previous: &Value, current: &Value) -> Option<Value> {
    if previous == current {
        return None;
    }

    let Value::Object(current) = current else {
        return Some(current.clone());
    };
    let previous = previous.as_object();
    let mut patch = Map::new();

    if let Some(previous) = previous {
        for key in previous.keys() {
            if !current.contains_key(key) {
                patch.insert(key.clone(), Value::Null);
            }
        }
    }

    for (key, current_value) in current {
        let Some(previous_value) = previous.and_then(|previous| previous.get(key)) else {
            patch.insert(key.clone(), current_value.clone());
            continue;
        };
        if let Some(value_patch) = create_merge_patch(previous_value, current_value) {
            patch.insert(key.clone(), value_patch);
        }
    }

    Some(Value::Object(patch))
}

fn apply_merge_patch_value(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        target.clone_from(patch);
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    if let Value::Object(target) = target {
        for (key, value) in patch {
            if value.is_null() {
                target.remove(key);
            } else {
                apply_merge_patch_value(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
    }
}

#[cfg(test)]
#[path = "world_state_tests.rs"]
mod tests;

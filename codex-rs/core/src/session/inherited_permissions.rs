//! Elpis: a child agent holds the authority its parent had when it started or resumed it.
//! When the parent gives authority up, loaded children that still hold it give it up too.
//! A parent's grant is never passed on: children it starts later inherit it instead.

use super::session::Session;
use super::session::SessionConfiguration;
use super::session::SessionSettingsUpdate;
use super::step_settings::StepSettingsUpdate;
use crate::config::ConstraintResult;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_READ_ONLY;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE;
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use futures::future::BoxFuture;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use tracing::warn;

/// What a thread may do without asking: its approval policy and permission profile.
struct Authority {
    policy: AskForApproval,
    profile: PermissionProfile,
    profile_id: Option<String>,
}

impl Authority {
    fn of(configuration: &SessionConfiguration) -> Self {
        Self {
            policy: configuration.step_settings.approval_policy.value(),
            profile: configuration.permission_profile(),
            profile_id: configuration
                .active_permission_profile()
                .map(|profile| profile.id),
        }
    }

    /// The authority a settings update from `permission_update` sets.
    fn of_update(updates: &SessionSettingsUpdate) -> Option<Self> {
        Some(Self {
            policy: updates.step_settings.approval_policy?,
            profile: updates.permission_profile.clone()?,
            profile_id: updates
                .active_permission_profile
                .as_ref()
                .map(|profile| profile.id.clone()),
        })
    }

    fn is_full_access(&self) -> bool {
        self.policy == AskForApproval::Never && matches!(self.profile, PermissionProfile::Disabled)
    }

    /// Built-in profiles in order of what they allow. Other profiles are not compared.
    fn profile_rank(&self) -> Option<u8> {
        if matches!(self.profile, PermissionProfile::Disabled) {
            return Some(2);
        }
        match self.profile_id.as_deref()? {
            BUILT_IN_PERMISSION_PROFILE_WORKSPACE => Some(1),
            BUILT_IN_PERMISSION_PROFILE_READ_ONLY => Some(0),
            _ => None,
        }
    }

    /// Whether moving to `to` removes authority this has and adds none. Pairs this cannot
    /// order count as possible grants.
    fn can_lose_to(&self, to: &Self) -> bool {
        if self.is_full_access() {
            return !to.is_full_access();
        }
        self.policy == to.policy
            && matches!(
                (self.profile_rank(), to.profile_rank()),
                (Some(from_rank), Some(to_rank)) if to_rank < from_rank
            )
    }
}

/// Whether `updated` removes authority `current` has and adds none. Pairs this cannot
/// order count as possible grants.
pub(super) fn removes_authority(
    current: &SessionConfiguration,
    updated: &SessionConfiguration,
) -> bool {
    Authority::of(current).can_lose_to(&Authority::of(updated))
}

/// A thread's approval policy and permission profile, as an update for its children.
pub(super) fn permission_update(configuration: &SessionConfiguration) -> SessionSettingsUpdate {
    SessionSettingsUpdate {
        step_settings: StepSettingsUpdate {
            approval_policy: Some(configuration.step_settings.approval_policy.value()),
            ..Default::default()
        },
        permission_profile: Some(configuration.permission_profile()),
        active_permission_profile: configuration.active_permission_profile(),
        profile_workspace_roots: Some(
            configuration
                .permission_profile_state
                .profile_workspace_roots()
                .to_vec(),
        ),
        ..Default::default()
    }
}

/// A thread's reductions for its children, and what it still owes its own parent. Kept in the
/// thread's extension data, which each thread creates for itself, so session construction
/// stays as upstream has it.
#[derive(Default)]
struct Reductions {
    /// This thread's reductions in commit order; the Nth is numbered N. A later grant removes
    /// none of them: children that existed at a reduction still owe it.
    history: Mutex<Vec<SessionSettingsUpdate>>,
    owed: Mutex<Owed>,
}

/// What a thread owes its parent's reductions.
#[derive(Default)]
struct Owed {
    /// Retain the record until owed restrictions are applied, even if the parent unloads.
    /// Records reference ancestors only, so retaining one does not create a cycle.
    parent: Option<Arc<Reductions>>,
    /// Number of the latest parent reduction this thread has taken or already reflects; `None`
    /// until it first meets its parent's reductions.
    baseline: Option<usize>,
    /// The parent's permissions found at that first meeting, until this thread takes them.
    floor: Option<SessionSettingsUpdate>,
}

impl Owed {
    /// Starts over when `parent` is not the record the baseline counts in.
    fn meet(&mut self, parent: &Arc<Reductions>) {
        if !self
            .parent
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, parent))
        {
            *self = Self {
                parent: Some(Arc::clone(parent)),
                ..Self::default()
            };
        }
    }
}

impl Session {
    fn reductions(&self) -> Arc<Reductions> {
        self.services
            .thread_extension_data
            .get_or_init(Reductions::default)
    }

    /// Records an accepted permission change that removes authority, for this thread's
    /// children, and returns its number. Called under the lock that publishes the change, so
    /// numbers follow commit order and a child sees a reduction before this thread
    /// acknowledges it.
    pub(super) fn note_permission_change(
        &self,
        current: &SessionConfiguration,
        updated: &SessionConfiguration,
    ) -> Option<usize> {
        if !removes_authority(current, updated) {
            return None;
        }
        let reductions = self.reductions();
        let mut history = reductions
            .history
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        history.push(permission_update(updated));
        Some(history.len())
    }

    /// Runs before this thread acknowledges reduction `generation`. Loaded children it spawned
    /// that have not met its reductions are marked as predating this one, so they owe it even
    /// if this thread regains authority before they act. Children started later are not
    /// marked: they inherit what this thread allows when they start. The children are then
    /// lowered in the background, so idle children change promptly; each child's next tool
    /// call does the same if that has not happened yet.
    pub(super) async fn lower_loaded_children(&self, generation: usize) {
        let parent_thread_id = self.thread_id();
        let children = self
            .services
            .local_agent_runtime
            .loaded_thread_spawn_children(parent_thread_id)
            .await;
        let reductions = self.reductions();
        for child in &children {
            child
                .session
                .owe_parent_reductions_from(&reductions, generation);
        }
        drop(tokio::spawn(async move {
            for child in children {
                if let Err(error) = child
                    .session
                    .follow_parent_reductions(&child.session_source)
                    .await
                {
                    warn!(
                        %parent_thread_id,
                        child_thread_id = %child.session.thread_id(),
                        "child agent rejected its parent's permission reduction: {error}"
                    );
                }
            }
        }));
    }

    /// Marks this thread as existing before parent reduction `generation`, unless it has
    /// already met that parent record.
    fn owe_parent_reductions_from(&self, parent: &Arc<Reductions>, generation: usize) {
        let reductions = self.reductions();
        let mut owed = reductions
            .owed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        owed.meet(parent);
        if owed.baseline.is_none() {
            owed.baseline = Some(generation.saturating_sub(1));
        }
    }

    /// Takes what this thread owes its spawning ancestors' reductions. Tool calls, and the
    /// children they start or resume, wait for this, so authority a parent gave up is gone
    /// before a child acts again. A reduction this thread rejects fails the action. Callers
    /// hold none of this thread's session locks while an ancestor is read or changed, and an
    /// ancestor never waits on its children, so the waits cannot form a cycle.
    pub(crate) fn follow_parent_reductions<'a>(
        &'a self,
        session_source: &'a SessionSource,
    ) -> BoxFuture<'a, ConstraintResult<()>> {
        Box::pin(async move {
            let SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id, ..
            }) = session_source
            else {
                return Ok(());
            };
            let Some(parent) = self
                .services
                .local_agent_runtime
                .loaded_thread(*parent_thread_id)
                .await
            else {
                return self.take_recorded_parent_reductions().await;
            };
            parent
                .session
                .follow_parent_reductions(&parent.session_source)
                .await?;
            let (record, history, current) = parent.session.reduction_snapshot().await;
            self.take_parent_reductions(&record, history, current).await
        })
    }

    /// This thread's reduction record, its reductions and its current permissions, read
    /// together.
    async fn reduction_snapshot(
        &self,
    ) -> (
        Arc<Reductions>,
        Vec<SessionSettingsUpdate>,
        SessionSettingsUpdate,
    ) {
        let state = self.state.lock().await;
        let record = self.reductions();
        let history = record
            .history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        (
            record,
            history,
            permission_update(&state.session_configuration),
        )
    }

    /// Takes what this thread owes a parent with these reductions and current permissions.
    /// Each owed reduction is taken once, in order, and only where it removes authority, so
    /// nothing here raises this thread. At first meeting the thread owes the parent's current
    /// permissions where they are lower: it reflects the parent as of the action that started
    /// or resumed it. A reduction this thread rejects stays owed, also after the parent
    /// regains authority, so every later action fails until this thread can take it.
    async fn take_parent_reductions(
        &self,
        parent: &Arc<Reductions>,
        history: Vec<SessionSettingsUpdate>,
        current: SessionSettingsUpdate,
    ) -> ConstraintResult<()> {
        // A reload starts a fresh record, but cannot discharge restrictions from the old one.
        self.take_recorded_parent_reductions().await?;
        let reductions = self.reductions();
        {
            let mut owed = reductions
                .owed
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            owed.meet(parent);
            if owed.baseline.is_none() {
                owed.baseline = Some(history.len());
                owed.floor = Some(current);
            }
        }
        self.take_owed_reductions(history).await
    }

    async fn take_recorded_parent_reductions(&self) -> ConstraintResult<()> {
        let parent = self
            .reductions()
            .owed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .parent
            .clone();
        if let Some(parent) = parent {
            let history = parent
                .history
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            self.take_owed_reductions(history).await?;
        }
        Ok(())
    }

    async fn take_owed_reductions(
        &self,
        history: Vec<SessionSettingsUpdate>,
    ) -> ConstraintResult<()> {
        let reductions = self.reductions();
        let (floor, baseline) = {
            let owed = reductions
                .owed
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            (owed.floor.clone(), owed.baseline.unwrap_or_default())
        };
        if let Some(floor) = floor {
            self.take_parent_permissions(floor).await?;
            reductions
                .owed
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .floor = None;
        }
        for (index, updates) in history.into_iter().enumerate().skip(baseline) {
            self.take_parent_permissions(updates).await?;
            let mut owed = reductions
                .owed
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            owed.baseline = owed.baseline.max(Some(index + 1));
        }
        Ok(())
    }

    /// Takes a parent's permissions where they remove authority this thread holds. Permissions
    /// that remove none are skipped, even if this thread could not accept them.
    async fn take_parent_permissions(
        &self,
        updates: SessionSettingsUpdate,
    ) -> ConstraintResult<()> {
        let needed = {
            let state = self.state.lock().await;
            Authority::of_update(&updates)
                .is_some_and(|to| Authority::of(&state.session_configuration).can_lose_to(&to))
        };
        if needed {
            self.follow_parent_permission_reduction(updates).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "inherited_permissions_tests.rs"]
mod tests;

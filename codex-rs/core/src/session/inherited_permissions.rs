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
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
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
}

/// Whether `updated` removes authority `current` has and adds none. Pairs this cannot
/// order count as possible grants.
pub(super) fn removes_authority(
    current: &SessionConfiguration,
    updated: &SessionConfiguration,
) -> bool {
    let (from, to) = (Authority::of(current), Authority::of(updated));
    if from.is_full_access() {
        return !to.is_full_access();
    }
    from.policy == to.policy
        && matches!(
            (from.profile_rank(), to.profile_rank()),
            (Some(from), Some(to)) if to < from
        )
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

/// The latest reduction a thread accepted, numbered in commit order, and the number of the
/// latest parent reduction it applied. Kept in the thread's extension data, which each
/// thread creates for itself, so session construction stays as upstream has it.
#[derive(Default)]
struct Reductions {
    latest: Mutex<LatestReduction>,
    applied_parent: AtomicU64,
}

#[derive(Default)]
struct LatestReduction {
    generation: u64,
    /// `None` once the thread provably gains authority again. Children started after that
    /// inherit the new authority and must not be lowered to the earlier reduction.
    updates: Option<SessionSettingsUpdate>,
}

impl Session {
    fn reductions(&self) -> Arc<Reductions> {
        self.services
            .thread_extension_data
            .get_or_init(Reductions::default)
    }

    /// Notes an accepted permission change for this thread's children. Returns a numbered
    /// reduction for them, or forgets the pending one when the change provably grants
    /// authority. Called under the lock that publishes the change, so numbers follow commit
    /// order and a child can see a reduction before this thread acknowledges it.
    pub(super) fn note_permission_change(
        &self,
        current: &SessionConfiguration,
        updated: &SessionConfiguration,
    ) -> Option<(u64, SessionSettingsUpdate)> {
        let reduces = removes_authority(current, updated);
        if !reduces && !removes_authority(updated, current) {
            return None;
        }
        let reductions = self.reductions();
        let mut latest = reductions
            .latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !reduces {
            latest.updates = None;
            return None;
        }
        let updates = permission_update(updated);
        latest.generation += 1;
        latest.updates = Some(updates.clone());
        Some((latest.generation, updates))
    }

    /// Gives a recorded reduction to the loaded children this thread spawned, so idle children
    /// change promptly. This runs apart from the caller, which may hold this thread's locks.
    /// A child that has not applied it yet applies it before its next tool call instead; see
    /// `follow_parent_reductions`.
    pub(super) fn lower_loaded_children(&self, generation: u64, updates: SessionSettingsUpdate) {
        let runtime = self.services.local_agent_runtime.clone();
        let parent_thread_id = self.thread_id();
        drop(tokio::spawn(async move {
            for child in runtime.loaded_thread_spawn_children(parent_thread_id).await {
                if let Err(error) = child
                    .session
                    .apply_parent_reduction(generation, updates.clone())
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

    /// Applies the reductions this thread's spawning ancestors accepted and it has not applied
    /// yet. Tool calls, and the children they start or resume, wait for this, so authority a
    /// parent gave up is gone before a child acts again. A reduction this thread rejects fails
    /// the action. Callers hold none of this thread's session locks while an ancestor is read
    /// or changed, and an ancestor never waits on its children, so the waits cannot form a
    /// cycle.
    pub(super) fn follow_parent_reductions<'a>(
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
                return Ok(());
            };
            parent
                .session
                .follow_parent_reductions(&parent.session_source)
                .await?;
            let latest = {
                let reductions = parent.session.reductions();
                let latest = reductions
                    .latest
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let generation = latest.generation;
                latest.updates.clone().map(|updates| (generation, updates))
            };
            match latest {
                Some((generation, updates)) => {
                    self.apply_parent_reduction(generation, updates).await
                }
                None => Ok(()),
            }
        })
    }

    /// Applies one parent reduction once. A rejected reduction stays pending, so every later
    /// action fails until this thread can take it.
    async fn apply_parent_reduction(
        &self,
        generation: u64,
        updates: SessionSettingsUpdate,
    ) -> ConstraintResult<()> {
        let reductions = self.reductions();
        if reductions.applied_parent.load(Ordering::Acquire) >= generation {
            return Ok(());
        }
        self.follow_parent_permission_reduction(updates).await?;
        reductions
            .applied_parent
            .fetch_max(generation, Ordering::AcqRel);
        Ok(())
    }
}

#[cfg(test)]
#[path = "inherited_permissions_tests.rs"]
mod tests;

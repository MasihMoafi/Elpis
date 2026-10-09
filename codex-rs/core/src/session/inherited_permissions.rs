//! Elpis: a child agent holds the authority its parent had when it started or resumed it.
//! When the parent gives authority up, loaded children that still hold it give it up too.
//! A parent's grant is never passed on: children it starts later inherit it instead.

use super::session::Session;
use super::session::SessionConfiguration;
use super::session::SessionSettingsUpdate;
use super::step_settings::StepSettingsUpdate;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_READ_ONLY;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE;
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::AskForApproval;
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

impl Session {
    /// Gives this thread's reduced permissions to the loaded children it spawned. Each child
    /// rechecks under its own lock that the update only removes authority, so a child that
    /// holds less keeps what it has. This runs apart from the caller, which may hold this
    /// thread's locks while a child waits on this thread.
    pub(super) fn lower_loaded_children(&self, updates: SessionSettingsUpdate) {
        let runtime = self.services.local_agent_runtime.clone();
        let parent_thread_id = self.thread_id();
        drop(tokio::spawn(async move {
            for child in runtime.loaded_thread_spawn_children(parent_thread_id).await {
                if let Err(error) = child
                    .session
                    .follow_parent_permission_reduction(updates.clone())
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
}

#[cfg(test)]
#[path = "inherited_permissions_tests.rs"]
mod tests;

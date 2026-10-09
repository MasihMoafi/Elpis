//! Handles persistent thread-settings updates and serializes their persistence
//! with checkpoints written directly to storage.

use super::session::Session;
use super::session::SessionConfiguration;
use super::session::SessionSettingsCommit;
use super::session::SessionSettingsUpdate;
use super::step_settings::StepSettingsUpdate;
use crate::WithTurnExtensionData;
use crate::config::ConstraintResult;
use codex_history::RolloutItem;
use codex_protocol::capabilities::SelectedCapabilityRoot;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ThreadSettingsAppliedEvent;
use codex_protocol::protocol::ThreadSettingsOverrides;
use codex_protocol::protocol::ThreadSettingsSnapshot;
use codex_thread_store::ThreadStoreResult;
use std::sync::Arc;
use tokio::sync::SemaphorePermit;

impl Session {
    /// Captures and flushes current settings under the shared persistence permit.
    pub(crate) async fn checkpoint_thread_settings(&self) -> ThreadStoreResult<()> {
        let _settings_guard = acquire_persistence_lock(self).await;
        if let Some(live_thread) = self.live_thread() {
            live_thread
                .append_items(&[RolloutItem::EventMsg(applied_event(self).await)])
                .await?;
            live_thread.flush().await?;
        }
        Ok(())
    }
}

/// Applies standalone thread settings. The caller holds the persistence permit through notification.
pub(super) async fn update(
    session: &Session,
    overrides: impl Into<WithTurnExtensionData<ThreadSettingsOverrides>>,
) -> ConstraintResult<ThreadSettingsSnapshot> {
    let updates = prepare_update(overrides, &session.services.selected_capability_roots);
    let commit = commit_update(session, updates).await?;
    // Standalone settings changes supersede a pending automatic continuation.
    session.state.lock().await.last_started_turn_id = None;
    Ok(commit.snapshot)
}

/// Elpis: commits settings, then gives accepted permission changes to the running turn so
/// its later steps use them. A rejected update changes nothing.
async fn commit_update(
    session: &Session,
    updates: SessionSettingsUpdate,
) -> ConstraintResult<SessionSettingsCommit> {
    let Some(commit) = commit_update_if(session, updates, |_, _| true).await? else {
        unreachable!("unconditional settings updates must commit");
    };
    Ok(commit)
}

/// Elpis: `commit_update` when `should_commit` accepts the current and proposed settings,
/// judged under the lock that publishes them.
async fn commit_update_if(
    session: &Session,
    updates: SessionSettingsUpdate,
    should_commit: impl FnOnce(&SessionConfiguration, &SessionConfiguration) -> bool + Send,
) -> ConstraintResult<Option<SessionSettingsCommit>> {
    let policy_changed = updates.step_settings.approval_policy.is_some();
    let reviewer_changed = updates.step_settings.approvals_reviewer.is_some();
    let profile_changed = updates.permission_profile.is_some() || updates.sandbox_policy.is_some();
    let Some(commit) = session.update_settings_if(updates, should_commit).await? else {
        return Ok(None);
    };
    if policy_changed || reviewer_changed || profile_changed {
        let active = session.active_turn.lock().await;
        if let Some(task) = active.as_ref().and_then(|active| active.task.as_ref()) {
            let turn = &task.turn_context;
            if reviewer_changed {
                // 0.162's live reviewer slot: a later turn-settings update replaces it.
                let settings = turn.next_step_settings.load_full();
                turn.next_step_settings
                    .store(Arc::new(settings.with_approvals_reviewer(
                        commit.configuration.step_settings.approvals_reviewer,
                    )));
            }
            if policy_changed || profile_changed {
                let mut permissions = turn
                    .live_permissions
                    .load_full()
                    .as_deref()
                    .cloned()
                    .unwrap_or_default();
                if policy_changed {
                    permissions.approval_policy =
                        Some(commit.configuration.step_settings.approval_policy.value());
                }
                if profile_changed {
                    permissions.profile = Some(
                        commit
                            .configuration
                            .inferred_environment_config()
                            .permission_profile,
                    );
                }
                turn.live_permissions.store(Some(Arc::new(permissions)));
            }
        }
    }
    Ok(Some(commit))
}

impl Session {
    /// Elpis: takes a parent's reduced permissions when they remove authority this thread
    /// holds and add none, as an accepted update that also reaches its running turn.
    /// Returns whether this thread changed.
    pub(crate) async fn follow_parent_permission_reduction(
        &self,
        updates: SessionSettingsUpdate,
    ) -> ConstraintResult<bool> {
        let _settings_guard = acquire_persistence_lock(self).await;
        let Some(commit) = commit_update_if(
            self,
            updates,
            super::inherited_permissions::removes_authority,
        )
        .await?
        else {
            return Ok(false);
        };
        emit_applied(self, self.next_internal_sub_id(), commit.snapshot).await;
        Ok(true)
    }
}

/// Converts protocol overrides into the internal settings update shape.
pub(super) fn prepare_update(
    overrides: impl Into<WithTurnExtensionData<ThreadSettingsOverrides>>,
    roots: &[SelectedCapabilityRoot],
) -> SessionSettingsUpdate {
    let WithTurnExtensionData {
        request: overrides,
        turn_extension_init,
    } = overrides.into();
    let ThreadSettingsOverrides {
        environments: environment_requests,
        runtime_workspace_roots,
        profile_workspace_roots,
        approval_policy,
        approvals_reviewer,
        sandbox_policy,
        permission_profile,
        active_permission_profile,
        windows_sandbox_level,
        model,
        effort,
        summary,
        service_tier,
        collaboration_mode,
        personality,
        disabled_plugin_ids,
    } = overrides;
    SessionSettingsUpdate {
        turn_extension_init,
        step_settings: StepSettingsUpdate {
            model,
            effort,
            collaboration_mode,
            reasoning_summary: summary,
            service_tier,
            personality,
            approval_policy,
            approvals_reviewer,
        },
        environments: environment_requests.map(|requests| requests.select(roots)),
        runtime_workspace_roots,
        profile_workspace_roots,
        sandbox_policy,
        permission_profile,
        active_permission_profile,
        windows_sandbox_level,
        disabled_plugin_ids,
        ..Default::default()
    }
}

/// Acquires the shared permit before capturing or changing persistent settings.
pub(super) async fn acquire_persistence_lock(session: &Session) -> SemaphorePermit<'_> {
    session
        .thread_settings_persistence
        .acquire()
        .await
        .unwrap_or_else(|_| unreachable!("thread settings persistence semaphore is never closed"))
}

/// Applies persistent settings and emits the resulting thread-owned snapshot.
pub(super) async fn apply_update(
    session: &Session,
    submission_id: String,
    updates: SessionSettingsUpdate,
) -> ConstraintResult<()> {
    let _settings_guard = acquire_persistence_lock(session).await;
    // Elpis: settings steered into a running turn also reach its later steps.
    let commit = commit_update(session, updates).await?;
    emit_applied(session, submission_id, commit.snapshot).await;
    Ok(())
}

/// Emits the snapshot published by one successful settings update.
pub(super) async fn emit_applied(
    session: &Session,
    submission_id: String,
    snapshot: ThreadSettingsSnapshot,
) {
    let msg = EventMsg::ThreadSettingsApplied(ThreadSettingsAppliedEvent {
        thread_id: Some(session.thread_id()),
        thread_settings: snapshot,
    });
    session
        .send_event_raw_without_materializing_rollout(Event {
            id: submission_id,
            msg,
        })
        .await;
}

/// Builds a current thread-owned snapshot for storage checkpoints.
pub(super) async fn applied_event(session: &Session) -> EventMsg {
    EventMsg::ThreadSettingsApplied(ThreadSettingsAppliedEvent {
        thread_id: Some(session.thread_id()),
        thread_settings: session.thread_settings_snapshot().await,
    })
}

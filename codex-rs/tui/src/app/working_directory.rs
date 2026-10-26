//! Local directory transitions and managed worktrees with fresh or preserved conversation history.
//! Managed transitions and widget attachment run separately at the top of the event loop.

use super::managed_worktree_creation::check_background_terminals;
use super::session_lifecycle::ThreadAttachPresentation;
use super::*;
use crate::app_event::ManagedWorktreeTransition;
use crate::app_server_session::ForkGoalContinuation::DeferUntilNextTurn;
use crate::history_cell::McpInventoryLoadingCell as LoadingCell;
use crate::terminal_visualization_instructions::with_terminal_visualization_instructions;

enum DestinationConfig {
    Load,
    Prepared(Box<Config>),
}

fn directory_permission_profile_matches(
    config: &Config,
    actual: &PermissionProfile,
    active: Option<&ActivePermissionProfile>,
) -> bool {
    if let Some(expected) = config.permissions.active_permission_profile() {
        return active == Some(&expected);
    }
    // The local bridge may normalize a legacy sandbox to a built-in identity.
    // A named profile or proxy cannot be verified from a legacy sandbox response.
    if config.permissions.network.is_some() {
        return false;
    }
    let same_rules = |left: &PermissionProfile, right: &PermissionProfile| {
        left.network_sandbox_policy() == right.network_sandbox_policy()
            && left
                .file_system_sandbox_policy()
                .is_semantically_equivalent_to(
                    &right.file_system_sandbox_policy(),
                    config.cwd.as_path(),
                )
    };
    let matches_rules = |expected: &PermissionProfile| {
        let expected = expected
            .clone()
            .materialize_project_roots_with_workspace_roots(&config.workspace_roots);
        if same_rules(&expected, actual) {
            return true;
        }
        // The legacy response adds cwd metadata protections to canonical builtins.
        // Never project arbitrary rules: that could erase a custom read/deny carveout.
        let builtin = [
            PermissionProfile::read_only(),
            PermissionProfile::workspace_write(),
            PermissionProfile::Disabled,
        ]
        .into_iter()
        .any(|profile| {
            same_rules(
                &expected,
                &profile.materialize_project_roots_with_workspace_roots(&config.workspace_roots),
            )
        });
        builtin
            && expected
                .to_legacy_sandbox_policy(config.cwd.as_path())
                .ok()
                .is_some_and(|sandbox| {
                    same_rules(
                        &PermissionProfile::from_legacy_sandbox_policy_for_cwd(
                            &sandbox,
                            config.cwd.as_path(),
                        ),
                        actual,
                    )
                })
    };
    if let Some(active) = active {
        if active.extends.is_some() {
            return false;
        }
        let builtin = match active.id.as_str() {
            codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_READ_ONLY => {
                PermissionProfile::read_only()
            }
            codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE => {
                PermissionProfile::workspace_write()
            }
            codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS => {
                PermissionProfile::Disabled
            }
            _ => return false,
        };
        if !matches_rules(&builtin) {
            return false;
        }
    }
    matches_rules(&config.permissions.effective_permission_profile())
}

/// Session and configuration prepared before the event loop attaches a managed checkout.
pub(super) struct ManagedWorktreeAttach {
    started: AppServerStartedThread,
    config: Box<Config>,
    local_settings: crate::local_settings::LocalSettings,
    keymap: RuntimeKeymap,
    cwd: AbsolutePathBuf,
    name_error: Option<String>,
    selected_profile: Option<PermissionProfileSelection>,
}

/// A /cd request awaiting a fresh event-loop iteration.
pub(super) struct PendingWorkingDirectoryChange {
    pub(super) source_thread_id: ThreadId,
    pub(super) source_cwd: AbsolutePathBuf,
    pub(super) destination: AbsolutePathBuf,
}

impl App {
    pub(super) async fn finish_working_directory_change(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        pending: PendingWorkingDirectoryChange,
    ) {
        if self.primary_thread_id != Some(pending.source_thread_id)
            || self.config.cwd != pending.source_cwd
            || !self
                .chat_widget
                .can_change_working_directory(pending.source_thread_id)
        {
            return self.working_directory_error(
                "Changing directories requires an idle primary session without queued input.",
            );
        }
        if crate::uses_remote_workspace_or_environment(
            &self.app_server_target,
            self.environment_manager.as_ref(),
        ) {
            return self.working_directory_error(
                "Changing directories is not supported for remote workspaces or remote execution environments.",
            );
        }
        self.change_working_directory(tui, app_server, pending.destination)
            .await;
    }

    pub(super) fn working_directory_error(&mut self, message: impl Into<String>) {
        self.chat_widget.add_error_message(message.into());
    }

    pub(super) async fn switch_to_managed_worktree(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        transition: ManagedWorktreeTransition,
    ) -> Result<()> {
        let source_thread_id = transition.source_thread_id;
        let source_cwd = &transition.source_cwd;
        let checkout = &transition.checkout;
        let mode = transition.mode;
        if self.reconnect.offline
            || (mode == crate::app_event::ManagedWorktreeMode::Fork
                && self.chat_widget.has_misalignment_policy_violation())
        {
            self.chat_widget.add_error_message(format!(
                "Cannot continue into the new worktree while the session is offline or blocked by a policy warning. An unused checkout was created at {}; remove it with `git worktree remove <checkout-path>` from the source repository.",
                checkout.root.display()
            ));
            return Ok(());
        }
        if self.primary_thread_id != Some(source_thread_id)
            || self.config.cwd.as_path() != source_cwd.as_path()
            || !self
                .chat_widget
                .can_change_working_directory(source_thread_id)
        {
            self.chat_widget.add_error_message(format!(
                "The source conversation changed while creating the worktree. An unused checkout was created at {}; remove it with `git worktree remove <checkout-path>` from the source repository.",
                checkout.root.display()
            ));
            return Ok(());
        }
        let ManagedWorktreeTransition {
            manager,
            checkout,
            config,
            mode,
            name,
            ..
        } = transition;
        let checkout_root = checkout.root.clone();
        let cwd = AbsolutePathBuf::from_absolute_path(checkout.cwd.clone())
            .map_err(|error| color_eyre::eyre::eyre!(error.to_string()))?;
        self.change_working_directory_with_managed(
            tui,
            app_server,
            cwd,
            Some((manager, checkout, mode, name)),
            DestinationConfig::Prepared(config),
        )
        .await;
        if self.pending_managed_worktree_attach.is_none() {
            return Err(color_eyre::eyre::eyre!(
                "Could not start a session in the managed worktree. A checkout was retained at {}; remove it with `git worktree remove <checkout-path>` from the source repository if it is no longer needed.",
                checkout_root.display()
            ));
        }
        Ok(())
    }

    pub(super) async fn change_working_directory(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        cwd: AbsolutePathBuf,
    ) {
        self.change_working_directory_with_managed(
            tui,
            app_server,
            cwd,
            /*managed_worktree*/ None,
            DestinationConfig::Load,
        )
        .await;
    }

    async fn change_working_directory_with_managed(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        cwd: AbsolutePathBuf,
        managed_worktree: Option<(
            codex_worktree::WorktreeManager,
            codex_worktree::ManagedWorktree,
            crate::app_event::ManagedWorktreeMode,
            Option<String>,
        )>,
        destination_config: DestinationConfig,
    ) {
        if self.config.ephemeral || !cwd.as_path().is_dir() {
            return self.working_directory_error("This task cannot be safely replaced.");
        }
        let Some(thread_id) = self.chat_widget.thread_id() else {
            return;
        };
        if self.pending_server_profiles.contains_key(&thread_id) {
            return self.working_directory_error(
                "Wait for permissions to update before changing directories.",
            );
        }
        if self.app_server_target.thread_params_mode()
            == crate::app_server_session::ThreadParamsMode::Remote
            && self
                .chat_widget
                .config_ref()
                .permissions
                .active_permission_profile()
                .is_some_and(|profile| !profile.id.starts_with(':'))
        {
            return self.working_directory_error(
                "Changing directories with a named profile is not supported.",
            );
        }
        let selected_profile = self
            .agents_overview
            .requested_permission_profiles
            .get(&thread_id)
            .cloned();
        if selected_profile
            .as_ref()
            .is_some_and(|profile| !profile.profile_id.starts_with(':'))
        {
            return self.working_directory_error(
                "Changing directories with an unconfirmed named profile is not supported.",
            );
        }
        let cells = &self.transcript_cells;
        if cells.iter().any(|cell| cell.as_any().is::<LoadingCell>()) {
            return self.working_directory_error("MCP inventory is still loading.");
        }
        let agents = self.agent_navigation.ordered_threads();
        let closed_agents: HashSet<_> = agents
            .iter()
            .filter_map(|(id, agent)| agent.is_closed.then_some(*id))
            .collect();
        let active = self.thread_event_channels.iter().any(|(id, channel)| {
            *id != thread_id
                && !closed_agents.contains(id)
                && !channel
                    .store
                    .try_lock()
                    .is_ok_and(|store| store.active_turn_id().is_none())
        });
        if active || agents.iter().any(|(t, a)| *t != thread_id && a.is_running) {
            return self.working_directory_error("Cannot change: another agent is running.");
        }
        let open_agents: Vec<_> = agents
            .iter()
            .filter_map(|(id, agent)| (!agent.is_closed).then_some(*id))
            .collect();
        let is_new_worktree = matches!(
            managed_worktree.as_ref().map(|(_, _, mode, _)| mode),
            Some(crate::app_event::ManagedWorktreeMode::New)
        );
        let rollout = self.chat_widget.rollout_path();
        let mut has_rollout = rollout.as_deref().is_some_and(rollout_path_is_resumable);
        let channels = &self.thread_event_channels;
        if !has_rollout
            && !is_new_worktree
            && (!self.chat_widget.token_usage().is_zero()
                || channels.get(&thread_id).is_some_and(|channel| {
                    channel.store.try_lock().map_or(/*default*/ true, |store| {
                        !store.turns.is_empty()
                            || store.buffer.iter().any(|event| {
                                matches!(
                                    event,
                                    ThreadBufferedEvent::Notification(notification)
                                        if matches!(notification.as_ref(),
                                            ServerNotification::TurnStarted(_)
                                            | ServerNotification::TurnCompleted(_))
                                )
                            })
                    })
                }))
        {
            return self.working_directory_error("Conversation history is not saved.");
        }
        let mut ids: HashSet<_> = channels
            .keys()
            .copied()
            .filter(|id| !closed_agents.contains(id))
            .collect();
        ids.extend(open_agents);
        let mut tracked_ids: Vec<_> = std::iter::once(thread_id)
            .chain(ids.iter().copied().filter(|id| *id != thread_id))
            .collect();
        let mut config = match destination_config {
            DestinationConfig::Prepared(config) => *config,
            DestinationConfig::Load => match self.rebuild_config_for_cwd(cwd.to_path_buf()).await {
                Ok(config) => config,
                Err(err) => {
                    return self.working_directory_error(format!("Cannot load {cwd:?}: {err}"));
                }
            },
        };
        if config.active_project.trust_level.is_none() {
            if let Some(message) = check_background_terminals(
                app_server,
                &self.app_server_target,
                tracked_ids.iter().copied(),
            )
            .await
            {
                return self.working_directory_error(message);
            }
            if self
                .confirm_directory_trust(
                    tui,
                    app_server,
                    &mut config,
                    cwd.as_path(),
                    crate::onboarding::DirectoryTrustOptions {
                        cancel: Some(crate::onboarding::TrustCancelAction::CurrentTask),
                        ..Default::default()
                    },
                    /*startup_draft*/ None,
                )
                .await
                .is_err()
            {
                return;
            }
        }
        if let Some((_, checkout, crate::app_event::ManagedWorktreeMode::Fork, _)) =
            managed_worktree.as_ref()
            && with_terminal_visualization_instructions(
                &self.config,
                self.config.developer_instructions.clone(),
            ) != with_terminal_visualization_instructions(
                &config,
                config.developer_instructions.clone(),
            )
        {
            return self.working_directory_error(format!(
                "Cannot fork into this worktree because developer instructions differ. Start a new conversation instead. An unused checkout was created at {}; remove it with `git worktree remove <checkout-path>` from the source repository.",
                checkout.root.display()
            ));
        }
        if !has_rollout
            || is_new_worktree
            || (self.runtime_permission_profile_override.is_none()
                && self
                    .config
                    .permissions
                    .active_permission_profile()
                    .is_some_and(|profile| {
                        profile.id == codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE
                    }))
        {
            match crate::config_update::read_effective_config_if_supported(
                app_server.request_handle(),
                cwd.as_path(),
            )
            .await
            {
                Ok(Some(defaults)) => {
                    crate::projectless::apply_defaults(
                        &mut config,
                        &self.harness_overrides,
                        app_server,
                        &self.environment_manager,
                        &defaults,
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    return self
                        .working_directory_error(format!("Cannot read defaults: {error:#}"));
                }
            }
        }
        let scope = if config.active_project.is_untrusted() {
            RuntimePolicyOverrideScope::ExplicitOnly
        } else {
            RuntimePolicyOverrideScope::All
        };
        let profile = self
            .runtime_permission_profile_override
            .as_ref()
            .filter(|_| selected_profile.is_none())
            .filter(|profile| {
                scope == RuntimePolicyOverrideScope::All
                    || profile.turn_override == RuntimePermissionProfileTurnOverride::LegacySandbox
            })
            .cloned();
        if let Some(profile) = profile.as_ref()
            && profile
                .active_permission_profile
                .as_ref()
                .is_some_and(|active| !active.id.starts_with(':'))
            && (!profile.matches_config(&config)
                || config.permissions.profile_workspace_roots()
                    != self.config.permissions.profile_workspace_roots())
        {
            return self.working_directory_error("Permission profile has different settings.");
        }
        if let Some(profile) = profile.as_ref()
            && profile.turn_override == RuntimePermissionProfileTurnOverride::Preserve
            && profile.active_permission_profile.is_none()
            && !crate::app_server_session::permission_profile_is_safely_represented_by_sandbox_mode(
                &profile.permission_profile,
                cwd.as_path(),
            )
        {
            return self.working_directory_error("Permission profile cannot be preserved by /cd.");
        }
        if selected_profile.is_none()
            && let Err(error) = self.apply_runtime_policy_overrides(&mut config, scope)
        {
            return self.working_directory_error(format!("{error:#}"));
        }
        let actual = config.permissions.approval_policy.value();
        let approval = self
            .runtime_approval_policy_override
            .filter(|_| selected_profile.is_none())
            .filter(|value| {
                scope == RuntimePolicyOverrideScope::All
                    || matches!(value, RuntimeApprovalPolicyOverride::Explicit(_))
            })
            .map(RuntimeApprovalPolicyOverride::policy);
        if approval.is_some_and(|p| actual != p.to_core())
            || profile.is_some_and(|profile| !profile.matches_config(&config))
        {
            return;
        }
        let local_settings = self.local_settings.reloaded(&config);
        let keymap = match RuntimeKeymap::from_config(&local_settings.tui.keymap) {
            Ok(keymap) => keymap,
            Err(error) => return self.chat_widget.add_error_message(error),
        };
        config.service_tier = self.chat_widget.configured_service_tier();
        if is_new_worktree {
            apply_managed_new_thread_defaults(
                &mut config,
                app_server.managed_new_thread_defaults(),
                &self.cli_kv_overrides,
                &self.harness_overrides,
            );
        }
        // Config reads and folder consent can overlap work from another client.
        if !self
            .backfill_loaded_subagent_threads(app_server)
            .await
            .completed
        {
            return self.working_directory_error("Cannot check agent status.");
        }
        ids.extend(
            self.agent_navigation
                .ordered_threads()
                .iter()
                .filter_map(|(id, agent)| (!agent.is_closed).then_some(*id)),
        );
        tracked_ids = std::iter::once(thread_id)
            .chain(ids.iter().copied().filter(|id| *id != thread_id))
            .collect();
        for id in &tracked_ids {
            match app_server.thread_read(*id, /*include_turns*/ false).await {
                Ok(thread)
                    if matches!(
                        thread.status,
                        codex_app_server_protocol::ThreadStatus::Active { .. }
                    ) =>
                {
                    return self.working_directory_error("Cannot change: a task is running.");
                }
                Ok(_) => {}
                Err(error) => {
                    return self
                        .working_directory_error(format!("Cannot check task status: {error}"));
                }
            }
        }
        if let Some(message) =
            check_background_terminals(app_server, &self.app_server_target, tracked_ids).await
        {
            return self.working_directory_error(message);
        }
        has_rollout |= rollout.as_deref().is_some_and(rollout_path_is_resumable);
        let preserve_history = has_rollout && !is_new_worktree;
        let transitioned = if preserve_history {
            app_server
                .fork_thread_at(
                    &local_settings,
                    config.clone(),
                    thread_id,
                    /*last_turn_id*/ None,
                    /*before_turn_id*/ None,
                    DeferUntilNextTurn,
                    selected_profile.as_ref(),
                )
                .await
        } else {
            app_server
                .start_thread_with_session_start_source(
                    &local_settings,
                    &config,
                    /*session_start_source*/ None,
                    /*remote_cwd_override*/ None,
                    selected_profile.as_ref(),
                )
                .await
        };
        let mut transitioned = match transitioned {
            Ok(value) => value,
            Err(e) => return self.working_directory_error(format!("Failed to change: {e}")),
        };
        let session = &transitioned.session;
        let permissions_match = if let Some(selected) = &selected_profile {
            session
                .active_permission_profile
                .as_ref()
                .is_some_and(|active| active.id == selected.profile_id)
                && selected
                    .approval_policy
                    .is_none_or(|policy| session.approval_policy == policy)
                && selected
                    .approvals_reviewer
                    .is_none_or(|reviewer| session.approvals_reviewer == reviewer)
        } else {
            session.approval_policy.to_core() == config.permissions.approval_policy.value()
                && session.approvals_reviewer == config.approvals_reviewer
                && directory_permission_profile_matches(
                    &config,
                    &session.permission_profile,
                    session.active_permission_profile.as_ref(),
                )
        };
        if session.thread_id == thread_id
            || crate::session_resume::cwds_differ(session.cwd.as_path(), cwd.as_path())
            || session.runtime_workspace_roots != config.workspace_roots
            || !permissions_match
        {
            if session.thread_id != thread_id {
                let _ = app_server.thread_unsubscribe(session.thread_id).await;
                if preserve_history {
                    let _ = app_server.thread_archive(session.thread_id).await;
                }
            }
            return self.working_directory_error("Requested directory or permissions not applied.");
        }
        if let Some((manager, checkout, _, _)) = managed_worktree.as_ref()
            && let Err(error) =
                manager.bind_thread(&checkout.root, &transitioned.session.thread_id.to_string())
        {
            let replacement_id = transitioned.session.thread_id;
            let _ = app_server.thread_unsubscribe(replacement_id).await;
            if preserve_history {
                let _ = app_server.thread_archive(replacement_id).await;
            }
            return self.working_directory_error(format!(
                "Cannot register managed worktree ownership: {error}"
            ));
        }
        let name_error = if let Some(name) = managed_worktree
            .as_ref()
            .and_then(|(_, _, _, name)| name.as_ref())
        {
            match app_server
                .thread_set_name(transitioned.session.thread_id, name.clone())
                .await
            {
                Ok(()) => {
                    transitioned.session.thread_name = Some(name.clone());
                    None
                }
                Err(error) => Some(format!("Failed to name the worktree session: {error}")),
            }
        } else {
            None
        };
        if let Err(error) = app_server.thread_unsubscribe(thread_id).await {
            let replacement_id = transitioned.session.thread_id;
            let _ = app_server.thread_unsubscribe(replacement_id).await;
            if preserve_history {
                let _ = app_server.thread_archive(replacement_id).await;
            }
            return self.working_directory_error(format!("Cannot change directories: {error}"));
        }
        for tracked_id in ids.into_iter().filter(|id| *id != thread_id) {
            if let Err(error) = app_server.thread_unsubscribe(tracked_id).await {
                tracing::warn!("failed to unsubscribe tracked thread {tracked_id}: {error}");
            }
        }
        let attach = ManagedWorktreeAttach {
            started: transitioned,
            config: Box::new(config),
            local_settings,
            keymap,
            cwd,
            name_error,
            selected_profile,
        };
        if managed_worktree.is_some() {
            // Let the large synchronous ChatWidget constructor run on a fresh event-loop stack.
            // Keep the old config paired with the old widget until the continuation runs.
            self.startup_protected_input_boundary = true;
            self.pending_managed_worktree_attach = Some(Box::new(attach));
        } else {
            self.attach_working_directory(tui, app_server, attach).await;
        }
    }

    pub(super) async fn attach_working_directory(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        attach: ManagedWorktreeAttach,
    ) {
        let ManagedWorktreeAttach {
            started,
            config,
            local_settings,
            keymap,
            cwd,
            name_error,
            selected_profile,
        } = attach;
        self.local_settings = local_settings;
        self.refresh_server_version_overview_notice(CODEX_CLI_VERSION);
        self.config = *config;
        self.file_search
            .update_search_dir(self.config.cwd.to_path_buf());
        let notify = &self.local_settings.tui.notification_settings;
        tui.set_notification_settings(notify.method, notify.condition);
        if let Err(error) = tui.clear_ambient_pet_image() {
            tracing::warn!(%error, "failed to clear ambient pet image");
        }
        let attach_widget = App::replace_chat_widget_with_app_server_thread;
        let (lineage, message) = (ThreadAttachPresentation::SessionLineage, None);
        if let Err(error) = attach_widget(self, tui, started, lineage, message).await {
            return self.working_directory_error(format!("Could not restore session: {error}"));
        }
        if selected_profile.is_some() {
            self.adopt_inherited_server_selection();
        }
        if matches!(
            self.runtime_approval_policy_override,
            Some(RuntimeApprovalPolicyOverride::Restored(_))
        ) {
            self.runtime_approval_policy_override = Some(RuntimeApprovalPolicyOverride::Restored(
                self.config.permissions.approval_policy.value().into(),
            ));
        }
        if self
            .runtime_permission_profile_override
            .as_ref()
            .is_some_and(|profile| {
                profile.turn_override == RuntimePermissionProfileTurnOverride::Preserve
            })
        {
            self.runtime_permission_profile_override = Some(
                RuntimePermissionProfileOverride::from_restored_config(&self.config),
            );
        }
        if let Some(error) = name_error {
            self.chat_widget.add_error_message(error);
        }
        self.cancel_pending_key_chord();
        self.keymap = keymap;
        self.merge_startup_warnings(tui, &history_cell::StartupWarningsCell::default());
        self.restore_runtime_theme_from_config();
        self.runtime_working_directory_override = Some(cwd.to_path_buf());
        if let Some(message) = project_config_warning(&self.config) {
            self.chat_widget.add_warning_message(message);
        }
        let message = format!("Working directory changed to: {}", cwd.display());
        self.chat_widget.add_info_message(message, /*hint*/ None);
        if !self.config.bypass_hook_trust {
            let load_review = crate::startup_hooks_review::load_startup_hooks_review_entry;
            let hooks = load_review(app_server.request_handle(), cwd.to_path_buf()).await;
            if hooks.hooks.iter().any(crate::hooks_rpc::hook_needs_review) {
                self.chat_widget.open_hooks_browser(hooks);
            }
        }
        tui.frame_requester().schedule_frame();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::config_types::SandboxMode;
    use codex_protocol::models::PermissionProfileSnapshot;
    use codex_protocol::permissions::FileSystemAccessMode;
    use codex_protocol::permissions::FileSystemSandboxEntry;
    use codex_protocol::permissions::NetworkSandboxPolicy;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;

    #[tokio::test]
    async fn legacy_directory_admission_accepts_only_equivalent_builtin_permissions() -> Result<()>
    {
        let home = tempfile::tempdir()?;
        let mut config = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .harness_overrides(ConfigOverrides {
                cwd: Some(home.path().to_path_buf()),
                sandbox_mode: Some(SandboxMode::WorkspaceWrite),
                ..ConfigOverrides::default()
            })
            .build()
            .await?;
        assert_eq!(config.permissions.active_permission_profile(), None);
        let workspace = PermissionProfile::workspace_write();
        let builtin = ActivePermissionProfile::new(":workspace");
        assert!(directory_permission_profile_matches(
            &config, &workspace, None
        ));
        assert!(directory_permission_profile_matches(
            &config,
            &workspace,
            Some(&builtin)
        ));
        for id in [
            "custom-workspace",
            ":bypass-permissions",
            ":read-only",
            ":danger-full-access",
        ] {
            assert!(!directory_permission_profile_matches(
                &config,
                &workspace,
                Some(&ActivePermissionProfile::new(id))
            ));
        }
        let inherited = ActivePermissionProfile {
            extends: Some(":workspace".into()),
            ..builtin.clone()
        };
        assert!(!directory_permission_profile_matches(
            &config,
            &workspace,
            Some(&inherited)
        ));
        for (actual, id) in [
            (PermissionProfile::read_only(), ":read-only"),
            (PermissionProfile::Disabled, ":danger-full-access"),
            (
                PermissionProfile::workspace_write_with(
                    &[],
                    NetworkSandboxPolicy::Enabled,
                    false,
                    false,
                ),
                ":workspace",
            ),
            (
                PermissionProfile::workspace_write_with(
                    &[test_path_buf("/extra-workspace").abs()],
                    NetworkSandboxPolicy::Restricted,
                    false,
                    false,
                ),
                ":workspace",
            ),
        ] {
            assert!(!directory_permission_profile_matches(
                &config,
                &actual,
                Some(&ActivePermissionProfile::new(id))
            ));
        }
        // Real metadata expands the legacy response below broader writable /tmp,
        // unlike the empty-directory fixture above. Keep this comparison red on
        // the direct-only admission guard while retaining the lifecycle tests.
        let metadata = tempfile::tempdir()?;
        let source = metadata.path().join("source");
        let checkout = metadata.path().join("checkout");
        std::fs::create_dir_all(source.join(".codex"))?;
        std::fs::write(source.join(".codex/fixture.txt"), "committed metadata")?;
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "."],
            vec!["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"],
            vec![
                "worktree",
                "add",
                "--quiet",
                "--detach",
                checkout.to_str().expect("UTF-8 checkout path"),
            ],
        ] {
            let result = std::process::Command::new("git")
                .current_dir(&source)
                .args([
                    "-c",
                    "user.name=Worktree Test",
                    "-c",
                    "user.email=test@example.invalid",
                ])
                .args(args)
                .output()?;
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        assert!(checkout.join(".git").is_file());
        assert!(checkout.join(".codex").is_dir());
        let mut metadata_config = ConfigBuilder::default()
            .codex_home(metadata.path().join("home"))
            .harness_overrides(ConfigOverrides {
                cwd: Some(checkout),
                permission_profile: Some(workspace.clone()),
                ..ConfigOverrides::default()
            })
            .build()
            .await?;
        let expected = metadata_config.permissions.effective_permission_profile();
        let actual = PermissionProfile::from_legacy_sandbox_policy_for_cwd(
            &expected.to_legacy_sandbox_policy(metadata_config.cwd.as_path())?,
            metadata_config.cwd.as_path(),
        );
        assert!(
            !expected
                .file_system_sandbox_policy()
                .is_semantically_equivalent_to(
                    &actual.file_system_sandbox_policy(),
                    metadata_config.cwd.as_path(),
                ),
            "worktree metadata must reproduce the failed direct comparison"
        );
        for active in [None, Some(&builtin)] {
            assert!(directory_permission_profile_matches(
                &metadata_config,
                &actual,
                active
            ));
        }
        metadata_config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                actual.clone(),
            ))?;
        assert_eq!(
            RuntimePermissionProfileOverride::from_config(&metadata_config).permission_profile,
            workspace,
            "legacy capture must retarget default source metadata through the builtin"
        );
        assert_eq!(
            RuntimePermissionProfileOverride::from_restored_config(&metadata_config)
                .permission_profile,
            actual,
            "restored rules remain the raw server snapshot"
        );
        for id in [":workspace", "configured-workspace", ":bypass-permissions"] {
            metadata_config
                .permissions
                .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
                    actual.clone(),
                    ActivePermissionProfile::new(id),
                ))?;
            assert_eq!(
                RuntimePermissionProfileOverride::from_config(&metadata_config).permission_profile,
                actual,
                "an active identity must retain its rules: {id}"
            );
        }
        for access in [FileSystemAccessMode::Read, FileSystemAccessMode::Deny] {
            let mut file_system = expected.file_system_sandbox_policy();
            file_system.entries.push(FileSystemSandboxEntry::new(
                metadata_config.cwd.join("private").into(),
                access,
            ));
            let custom = PermissionProfile::from_runtime_permissions(
                &file_system,
                expected.network_sandbox_policy(),
            );
            metadata_config
                .permissions
                .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                    custom.clone(),
                ))?;
            for captured in [
                RuntimePermissionProfileOverride::from_config(&metadata_config),
                RuntimePermissionProfileOverride::from_restored_config(&metadata_config),
            ] {
                assert_eq!(captured.permission_profile, custom);
            }
            assert!(
                !directory_permission_profile_matches(&metadata_config, &actual, None),
                "legacy projection must not erase a custom {access:?} carveout"
            );
        }
        for unmatched in [
            PermissionProfile::workspace_write_with(
                &[],
                NetworkSandboxPolicy::Enabled,
                false,
                false,
            ),
            PermissionProfile::workspace_write_with(
                &[],
                NetworkSandboxPolicy::Restricted,
                true,
                true,
            ),
            PermissionProfile::workspace_write_with(
                &[metadata_config.cwd.join("extra-root")],
                NetworkSandboxPolicy::Restricted,
                false,
                false,
            ),
            PermissionProfile::External {
                network: NetworkSandboxPolicy::Enabled,
            },
        ] {
            metadata_config
                .permissions
                .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                    unmatched.clone(),
                ))?;
            assert_eq!(
                RuntimePermissionProfileOverride::from_config(&metadata_config).permission_profile,
                unmatched,
                "non-builtin source rules must remain unchanged"
            );
        }
        std::fs::write(
            home.path().join("config.toml"),
            "default_permissions = \"proxied\"\n[features]\nnetwork_proxy = true\n[permissions.proxied]\nextends = \":workspace\"\n[permissions.proxied.network]\nenabled = true\nproxy_url = \"http://127.0.0.1:43128\"\n",
        )?;
        let proxied = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .build()
            .await?;
        assert!(proxied.permissions.network.is_some());
        metadata_config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                actual.clone(),
            ))?;
        metadata_config.permissions.network = proxied.permissions.network.clone();
        assert_eq!(
            RuntimePermissionProfileOverride::from_config(&metadata_config).permission_profile,
            actual,
            "a proxy-backed source must retain its raw snapshot"
        );
        config.permissions.network = proxied.permissions.network;
        assert!(!directory_permission_profile_matches(
            &config,
            &workspace,
            Some(&builtin)
        ));
        config.permissions.network = None;
        config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
                workspace.clone(),
                ActivePermissionProfile::new("configured-workspace"),
            ))?;
        assert!(!directory_permission_profile_matches(
            &config,
            &workspace,
            Some(&builtin)
        ));
        assert!(directory_permission_profile_matches(
            &config,
            &workspace,
            Some(&ActivePermissionProfile::new("configured-workspace"))
        ));
        Ok(())
    }
}

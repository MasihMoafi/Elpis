//! Request-scoped settings and capabilities, with live grants bound to the originating turn.

use std::sync::Arc;

use super::session::Session;
use super::session::SessionConfiguration;
use crate::agents_md::LoadedAgentsMd;
use crate::config::ConstraintResult;
use crate::config::TokenBudgetConfig;
use crate::environment_selection::TurnEnvironmentSnapshot;
use crate::realtime_conversation::RealtimeConversationSnapshot;
use crate::session::step_settings::ResolvedStepSettings;
use crate::session::turn_context::TurnContext;
use crate::session::turn_context::TurnEnvironment;
use crate::tools::router::ToolRouter;
use codex_exec_server::ExecutorCapabilityDiscoverySnapshot;
use codex_exec_server::ResolvedSelectedCapabilityRoot;
use codex_extension_api::ExtensionData;
use codex_file_system::EnvironmentAccess;
use codex_mcp::McpBinding;
use codex_otel::SessionTelemetry;
use codex_protocol::config_types::ApprovalsReviewer;
use codex_protocol::items::ModelInvocationContext;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::TurnContextItem;
use tokio_util::sync::CancellationToken;

/// Request-scoped state that may change between model sampling requests.
#[derive(Clone)]
pub(crate) struct StepContext {
    pub(crate) turn: Arc<TurnContext>,
    /// Preempts this request and yields its code-mode observations when user input arrives.
    pub(crate) preempt: Option<CancellationToken>,
    /// Realtime call activity and instructions captured for this sampling request.
    pub(crate) realtime: RealtimeConversationSnapshot,
    /// One immutable settings version captured before request preparation.
    pub(crate) settings: Arc<ResolvedStepSettings>,
    /// Frozen turn preferences resolved against this step's captured model.
    pub(crate) token_budget: Option<TokenBudgetConfig>,
    /// Telemetry context tagged with this sampling request's model.
    pub(crate) session_telemetry: SessionTelemetry,
    pub(crate) environments: TurnEnvironmentSnapshot,
    /// Capability roots bound to ready environments in this exact step.
    pub(crate) selected_capability_roots: Vec<ResolvedSelectedCapabilityRoot>,
    /// Executor-materialized capability files shared by MCP and skills in this exact step.
    pub(crate) executor_capability_discovery: Option<Arc<ExecutorCapabilityDiscoverySnapshot>>,
    /// Keeps the extension inputs used to build this step's tools for its World State as well.
    // Elpis: shared, so a step updated with live permissions keeps the same step store.
    pub(crate) extension_data: Arc<ExtensionData>,
    /// The exact MCP connections, configuration, and catalog captured for this step.
    pub(crate) mcp: Arc<McpBinding>,
    /// The finalized tool plan advertised and executed for this exact sampling request.
    pub(crate) tool_router: Arc<ToolRouter>,
    /// The canonical AGENTS.md value observed with this environment snapshot.
    pub(crate) loaded_agents_md: Option<Arc<LoadedAgentsMd>>,
    /// Elpis: the thread permission profile accepted after this step's turn started, if any.
    /// Its environments already use it; children its actions start or resume inherit it.
    pub(crate) accepted_profile: Option<PermissionProfileSnapshot>,
}

impl StepContext {
    /// Whether new context windows should record tool declarations in history.
    pub(crate) fn incremental_tools_enabled(&self) -> bool {
        self.settings.model_info.use_responses_lite
            && self
                .turn
                .config
                .features
                .enabled(codex_features::Feature::IncrementalTools)
    }

    /// Pairs the step's environments with access using current session and originating-turn grants.
    pub(crate) fn environments(&self) -> Vec<(&TurnEnvironment, impl EnvironmentAccess + '_)> {
        self.environments
            .turn_environments()
            .map(|environment| {
                let grants = self
                    .turn
                    .granted_permissions(&environment.selection.environment_id);
                (environment, environment.fs_accessor(grants))
            })
            .collect()
    }

    /// Persist the context captured for this request, even after a live update.
    pub(crate) fn to_turn_context_item(&self) -> TurnContextItem {
        let mut item = self.turn.to_turn_context_item();
        item.realtime_active = Some(self.realtime.active);
        item
    }

    pub(crate) fn model_context(&self) -> ModelInvocationContext {
        ModelInvocationContext {
            model_slug: self.settings.model_info.slug.clone(),
            reasoning_effort: self
                .settings
                .effective_reasoning_effort()
                .map(|effort| effort.to_string()),
        }
    }
}

/// Elpis: an approval policy and thread profile accepted after a turn started. `None` keeps
/// the turn's own value. A reviewer accepted during the turn goes into 0.162's live step
/// settings instead, so whichever reviewer update is accepted last applies.
#[derive(Clone, Debug, Default)]
pub(super) struct LivePermissions {
    pub(super) approval_policy: Option<AskForApproval>,
    pub(super) profile: Option<PermissionProfileSnapshot>,
}

impl LivePermissions {
    /// The thread's accepted permissions, for work that outlived the turn it started in.
    fn of_thread(configuration: &SessionConfiguration) -> Self {
        Self {
            approval_policy: Some(configuration.step_settings.approval_policy.value()),
            profile: Some(
                configuration
                    .inferred_environment_config()
                    .permission_profile,
            ),
        }
    }

    /// Applies these permissions to captured settings and to the thread-owned environments.
    pub(super) fn apply(
        &self,
        settings: Arc<ResolvedStepSettings>,
        environments: &mut TurnEnvironmentSnapshot,
    ) -> ConstraintResult<Arc<ResolvedStepSettings>> {
        if let Some(profile) = &self.profile {
            environments.apply_live_permission_profile(profile);
        }
        match self.approval_policy {
            Some(policy) => settings.with_approval_policy(policy).map(Arc::new),
            None => Ok(settings),
        }
    }
}

/// Elpis: the permissions accepted for a turn so far. Readers that act for the turn after it
/// started use these, not the turn's starting configuration.
impl TurnContext {
    /// 0.162's live step settings with the approval policy accepted since the turn started.
    pub(crate) fn current_step_settings(&self) -> ConstraintResult<Arc<ResolvedStepSettings>> {
        let settings = self.next_step_settings.load_full();
        match self
            .live_permissions
            .load()
            .as_ref()
            .and_then(|permissions| permissions.approval_policy)
        {
            Some(policy) => settings.with_approval_policy(policy).map(Arc::new),
            None => Ok(settings),
        }
    }

    /// The reviewer accepted for this turn so far, held in 0.162's live step settings.
    pub(crate) fn current_approvals_reviewer(&self) -> ApprovalsReviewer {
        self.next_step_settings.load().approvals_reviewer()
    }

    /// The thread permission profile accepted for this turn so far.
    pub(crate) fn current_thread_permission_profile(&self) -> PermissionProfileSnapshot {
        self.live_permissions
            .load()
            .as_ref()
            .and_then(|permissions| permissions.profile.clone())
            .unwrap_or_else(|| {
                self.config
                    .permissions
                    .permission_profile_state()
                    .snapshot()
            })
    }

    /// Gives the turn's thread-owned environments the profile accepted since it started.
    pub(crate) fn apply_current_permission_profile(
        &self,
        environments: &mut TurnEnvironmentSnapshot,
    ) {
        if let Some(permissions) = self.live_permissions.load_full()
            && let Some(profile) = &permissions.profile
        {
            environments.apply_live_permission_profile(profile);
        }
    }

    /// Whether the turn's next action has Full Access. A selection the turn's constraints
    /// reject counts as restricted.
    pub(crate) fn has_current_full_access(&self) -> bool {
        let Ok(settings) = self.current_step_settings() else {
            return false;
        };
        let mut environments = self.initial_environments.clone();
        self.apply_current_permission_profile(&mut environments);
        environments.has_full_access(
            settings.approval_policy(),
            self.current_thread_permission_profile()
                .permission_profile(),
        )
    }

    /// What a child this turn starts or resumes inherits while the turn runs. For a fresh turn
    /// these are the thread's accepted permissions.
    pub(crate) fn inherited_permissions(&self) -> InheritedPermissions {
        let permissions = self.live_permissions.load_full();
        InheritedPermissions {
            approval_policy: permissions
                .as_ref()
                .and_then(|permissions| permissions.approval_policy)
                .unwrap_or_else(|| self.approval_policy()),
            approvals_reviewer: self.current_approvals_reviewer(),
            profile: self.current_thread_permission_profile(),
        }
    }
}

/// Elpis: the permissions a child started or resumed by an action inherits. Its model and
/// history still come from the action's own turn and step.
pub(crate) struct InheritedPermissions {
    pub(crate) approval_policy: AskForApproval,
    pub(crate) approvals_reviewer: ApprovalsReviewer,
    pub(crate) profile: PermissionProfileSnapshot,
}

impl StepContext {
    /// Elpis: what a child started or resumed by this step's action inherits. A tool call's
    /// step was refreshed with the permissions accepted when the call was dispatched, also when
    /// the step outlived its turn.
    pub(crate) fn inherited_permissions(&self) -> InheritedPermissions {
        InheritedPermissions {
            approval_policy: self.settings.approval_policy(),
            approvals_reviewer: self.settings.approvals_reviewer(),
            profile: self.accepted_profile.clone().unwrap_or_else(|| {
                self.turn
                    .config
                    .permissions
                    .permission_profile_state()
                    .snapshot()
            }),
        }
    }

    fn with_permissions(
        self: Arc<Self>,
        reviewer: ApprovalsReviewer,
        permissions: Option<&LivePermissions>,
    ) -> ConstraintResult<Arc<Self>> {
        let reviewer_changed = reviewer != self.settings.approvals_reviewer();
        if !reviewer_changed && permissions.is_none() {
            return Ok(self);
        }
        let mut current = self.as_ref().clone();
        if reviewer_changed {
            current.settings = Arc::new(current.settings.with_approvals_reviewer(reviewer));
        }
        if let Some(permissions) = permissions {
            current.settings =
                permissions.apply(Arc::clone(&current.settings), &mut current.environments)?;
            if let Some(profile) = &permissions.profile {
                current.accepted_profile = Some(profile.clone());
            }
        }
        Ok(Arc::new(current))
    }
}

impl Session {
    /// Elpis: a tool call's step under the permissions accepted now. Reductions this thread's
    /// parents accepted are applied first. While the step's turn runs, the step takes that
    /// turn's accepted changes. Once the turn has ended, as for a Code Mode cell that outlived
    /// it, the step takes the thread's, because the turn no longer receives changes.
    pub(crate) async fn with_current_permissions(
        &self,
        step: Arc<StepContext>,
    ) -> ConstraintResult<Arc<StepContext>> {
        self.follow_parent_reductions(&step.turn.session_source)
            .await?;
        let running = self
            .active_turn
            .lock()
            .await
            .as_ref()
            .and_then(|active| active.task.as_ref())
            .is_some_and(|task| Arc::ptr_eq(&task.turn_context, &step.turn));
        if running {
            let reviewer = step.turn.current_approvals_reviewer();
            let permissions = step.turn.live_permissions.load_full();
            return step.with_permissions(reviewer, permissions.as_deref());
        }
        let (reviewer, permissions) = {
            let state = self.state.lock().await;
            let configuration = &state.session_configuration;
            (
                configuration.step_settings.approvals_reviewer,
                LivePermissions::of_thread(configuration),
            )
        };
        step.with_permissions(reviewer, Some(&permissions))
    }
}

#[cfg(test)]
#[path = "live_permissions_tests.rs"]
mod tests;

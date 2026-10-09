//! Request-scoped settings and capabilities, with live grants bound to the originating turn.

use std::sync::Arc;

use crate::agents_md::LoadedAgentsMd;
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
use codex_protocol::items::ModelInvocationContext;
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

/// Only explicit, accepted permission selections may replace an in-flight step's authority.
#[derive(Clone, Debug, Default)]
pub(super) struct LivePermissions {
    pub(super) approval_policy: Option<codex_protocol::protocol::AskForApproval>,
    pub(super) approvals_reviewer: Option<codex_protocol::config_types::ApprovalsReviewer>,
    pub(super) profile: Option<codex_protocol::models::PermissionProfileSnapshot>,
}

impl StepContext {
    pub(crate) fn with_current_permissions(
        self: Arc<Self>,
    ) -> crate::config::ConstraintResult<Arc<Self>> {
        let Some(permissions) = self.turn.live_permissions.load_full() else {
            return Ok(self);
        };
        let mut current = self.as_ref().clone();
        current.settings = Arc::new(current.settings.with_live_permissions(&permissions)?);
        if let Some(profile) = &permissions.profile {
            current.environments.apply_live_permission_profile(profile);
        }
        Ok(Arc::new(current))
    }

    /// A permission change accepted during this turn also binds a child it spawns; the turn's
    /// config still holds the permissions it started with.
    pub(crate) fn apply_live_permissions_to_child(
        &self,
        config: &mut crate::config::Config,
    ) -> Result<(), String> {
        let Some(permissions) = self.turn.live_permissions.load_full() else {
            return Ok(());
        };
        if let Some(policy) = permissions.approval_policy {
            config
                .permissions
                .approval_policy
                .set(policy)
                .map_err(|err| format!("approval_policy is invalid: {err}"))?;
        }
        if let Some(reviewer) = permissions.approvals_reviewer {
            config.approvals_reviewer = reviewer;
        }
        if let Some(profile) = &permissions.profile {
            config
                .permissions
                .set_permission_profile_from_session_snapshot(profile.clone())
                .map_err(|err| format!("permission_profile is invalid: {err}"))?;
        }
        Ok(())
    }
}

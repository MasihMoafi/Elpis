// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Test-only helpers exposed for cross-crate integration tests.
//!
//! Production code should not depend on this module.
//! We prefer this to using a crate feature to avoid building multiple
//! permutations of the crate.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use codex_exec_server::EnvironmentManager;
use codex_extension_api::LoadUserInstructionsFuture;
use codex_extension_api::LoadedUserInstructions;
use codex_extension_api::UserInstructionsProvider;
use codex_http_client::HttpClientFactory;
use codex_http_client::OutboundProxyPolicy;
use codex_login::AuthManager;
use codex_login::CodexAuth;
use codex_model_provider::create_model_provider;
use codex_model_provider_info::ModelProviderInfo;
use codex_models_manager::bundled_models_response;
use codex_models_manager::collaboration_mode_presets;
use codex_models_manager::manager::SharedModelsManager;
use codex_models_manager::test_support::construct_model_info_offline_for_tests;
use codex_models_manager::test_support::get_model_offline_for_tests;
use codex_protocol::ThreadId;
use codex_protocol::config_types::CollaborationModeMask;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelPreset;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::SessionSource;
use once_cell::sync::Lazy;

use crate::CodexThread;
use crate::ThreadManager;
use crate::config::Config;
use crate::responses_metadata::CodexResponsesMetadata;
use crate::responses_metadata::CodexResponsesRequestKind;
use crate::responses_metadata::subagent_header_value;
use crate::responses_metadata::subagent_metadata_kind;
use crate::thread_manager;
use crate::unified_exec;

static TEST_MODEL_PRESETS: Lazy<Vec<ModelPreset>> = Lazy::new(|| {
    let mut response = bundled_models_response()
        .unwrap_or_else(|err| panic!("bundled models.json should parse: {err}"));
    response.models.sort_by_key(|model| model.priority);
    let mut presets: Vec<ModelPreset> = response.models.into_iter().map(Into::into).collect();
    ModelPreset::mark_default_by_picker_visibility(&mut presets);
    presets
});

#[derive(Debug, Clone, PartialEq)]
pub struct ContextPruneStateSnapshot {
    pub raw_history: Vec<ResponseItem>,
    pub covered_call_ids: HashSet<String>,
    pub saved_tokens: u64,
}

pub async fn context_prune_state_snapshot(thread: &CodexThread) -> ContextPruneStateSnapshot {
    let (raw_history, covered_call_ids, saved_tokens) =
        crate::session::context_prune::state_snapshot_for_test(&thread.session).await;
    ContextPruneStateSnapshot {
        raw_history,
        covered_call_ids,
        saved_tokens,
    }
}

async fn active_prune_boundary(thread: &CodexThread) -> crate::tasks::TaskCancellationBoundary {
    let active_turn = thread.session.active_turn.lock().await;
    active_turn
        .as_ref()
        .and_then(|turn| turn.task.as_ref())
        .and_then(|task| task.task.cancellation_boundary())
        .expect("an active prune task must expose a cancellation boundary")
}

pub async fn interrupt_active_prune_and_wait_for_cancellation(
    thread: &CodexThread,
) -> codex_protocol::error::Result<String> {
    let boundary = active_prune_boundary(thread).await;
    let submission_id = thread.submit(Op::Interrupt).await?;
    boundary.wait_for_cancellation_delivery().await;
    let decision = boundary.wait_for_decision().await;
    assert_eq!(
        decision,
        crate::tasks::TaskCancellationDecision::Cancelled,
        "interrupt arrived after the prune task committed"
    );
    Ok(submission_id)
}

pub async fn wait_for_active_prune_commit(thread: &CodexThread) {
    let decision = active_prune_boundary(thread).await.wait_for_decision().await;
    assert_eq!(
        decision,
        crate::tasks::TaskCancellationDecision::Committed,
        "the prune task was cancelled before committing"
    );
}

pub async fn interrupt_active_prune_and_wait_for_commit_protection(
    thread: &CodexThread,
) -> codex_protocol::error::Result<String> {
    let boundary = active_prune_boundary(thread).await;
    let submission_id = thread.submit(Op::Interrupt).await?;
    boundary.wait_for_cancel_request().await;
    assert_eq!(
        boundary.wait_for_decision().await,
        crate::tasks::TaskCancellationDecision::Committed,
        "interrupt displaced an already committed prune task"
    );
    Ok(submission_id)
}

pub struct ContextPruneCommitGate {
    boundary: crate::tasks::TaskCancellationBoundary,
    released: bool,
}

impl ContextPruneCommitGate {
    pub fn release(mut self) {
        self.boundary.release_commit_for_test();
        self.released = true;
    }
}

impl Drop for ContextPruneCommitGate {
    fn drop(&mut self) {
        if !self.released {
            self.boundary.release_commit_for_test();
        }
    }
}

pub async fn pause_active_prune_commit(thread: &CodexThread) -> ContextPruneCommitGate {
    let boundary = active_prune_boundary(thread).await;
    boundary.pause_commit_for_test();
    ContextPruneCommitGate {
        boundary,
        released: false,
    }
}

/// Test-only provider that supplies no user instructions.
#[derive(Debug, Default)]
pub struct EmptyUserInstructionsProvider;

impl UserInstructionsProvider for EmptyUserInstructionsProvider {
    fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_> {
        Box::pin(async { LoadedUserInstructions::default() })
    }
}

pub fn set_thread_manager_test_mode(enabled: bool) {
    thread_manager::set_thread_manager_test_mode_for_tests(enabled);
}

pub fn set_deterministic_process_ids(enabled: bool) {
    unified_exec::set_deterministic_process_ids_for_tests(enabled);
}

pub fn auth_manager_from_auth(auth: CodexAuth) -> Arc<AuthManager> {
    AuthManager::from_auth_for_testing(auth)
}

pub fn auth_manager_from_auth_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<AuthManager> {
    AuthManager::from_auth_for_testing_with_home(auth, codex_home)
}

pub fn with_code_mode_host_program(
    thread_manager: ThreadManager,
    host_program: PathBuf,
) -> ThreadManager {
    thread_manager.with_code_mode_host_program_for_tests(host_program)
}

pub fn thread_manager_with_models_provider(
    auth: CodexAuth,
    provider: ModelProviderInfo,
) -> ThreadManager {
    ThreadManager::with_models_provider_for_tests(auth, provider)
}

pub fn thread_manager_with_models_provider_and_home(
    auth: CodexAuth,
    provider: ModelProviderInfo,
    codex_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
) -> ThreadManager {
    ThreadManager::with_models_provider_and_home_for_tests(
        auth,
        provider,
        codex_home,
        environment_manager,
    )
}

pub fn thread_manager_with_models_provider_home_and_state(
    auth: CodexAuth,
    provider: ModelProviderInfo,
    codex_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
    state_db: Option<crate::StateDbHandle>,
) -> ThreadManager {
    ThreadManager::with_models_provider_home_and_state_for_tests(
        auth,
        provider,
        codex_home,
        environment_manager,
        state_db,
    )
}

pub async fn start_thread_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    user_shell_override: crate::shell::Shell,
    supports_openai_form_elicitation: bool,
) -> codex_protocol::error::Result<crate::NewThread> {
    thread_manager
        .start_thread_with_user_shell_override_for_tests(
            config,
            user_shell_override,
            supports_openai_form_elicitation,
        )
        .await
}

pub async fn resume_thread_from_rollout_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    rollout_path: PathBuf,
    auth_manager: Arc<AuthManager>,
    user_shell_override: crate::shell::Shell,
    supports_openai_form_elicitation: bool,
) -> codex_protocol::error::Result<crate::NewThread> {
    thread_manager
        .resume_thread_from_rollout_with_user_shell_override_for_tests(
            config,
            rollout_path,
            auth_manager,
            user_shell_override,
            supports_openai_form_elicitation,
        )
        .await
}

pub fn models_manager_with_provider(
    codex_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    provider: ModelProviderInfo,
) -> SharedModelsManager {
    let provider = create_model_provider(provider, Some(auth_manager));
    provider.models_manager(codex_home, /*config_model_catalog*/ None)
}

pub fn default_http_client_factory() -> HttpClientFactory {
    HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault)
}

pub fn get_model_offline(model: Option<&str>) -> String {
    get_model_offline_for_tests(model)
}

pub fn construct_model_info_offline(model: &str, config: &Config) -> ModelInfo {
    construct_model_info_offline_for_tests(model, &config.to_models_manager_config())
}

#[derive(Clone, Copy)]
pub enum TestCodexResponsesRequestKind {
    Turn,
    Prewarm,
    WebsocketConnection,
}

#[allow(clippy::too_many_arguments)]
pub fn responses_metadata(
    installation_id: &str,
    session_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    window_id: String,
    session_source: &SessionSource,
    parent_thread_id: Option<ThreadId>,
    request_kind: TestCodexResponsesRequestKind,
) -> CodexResponsesMetadata {
    let request_kind = match request_kind {
        TestCodexResponsesRequestKind::Turn => Some(CodexResponsesRequestKind::Turn),
        TestCodexResponsesRequestKind::Prewarm => Some(CodexResponsesRequestKind::Prewarm),
        TestCodexResponsesRequestKind::WebsocketConnection => None,
    };
    CodexResponsesMetadata {
        turn_id: request_kind.and(turn_id.map(ToString::to_string)),
        request_kind,
        parent_thread_id,
        subagent_header: subagent_header_value(session_source),
        subagent_kind: request_kind.and_then(|_| subagent_metadata_kind(session_source)),
        ..CodexResponsesMetadata::new(
            installation_id.to_string(),
            session_id.to_string(),
            thread_id.to_string(),
            window_id,
        )
    }
}

pub fn all_model_presets() -> &'static Vec<ModelPreset> {
    &TEST_MODEL_PRESETS
}

pub fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask> {
    collaboration_mode_presets::builtin_collaboration_mode_presets()
}

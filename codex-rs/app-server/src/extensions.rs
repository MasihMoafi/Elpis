// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::sync::Arc;
use std::sync::Weak;

use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadGoal;
use codex_app_server_protocol::ThreadGoalUpdatedNotification;
use codex_core::NewThread;
use codex_core::StartThreadOptions;
use codex_core::ThreadManager;
use codex_core::config::Config;
use codex_exec_server::EnvironmentManager;
use codex_extension_api::AgentSpawnFuture;
use codex_extension_api::AgentSpawner;
use codex_extension_api::ConfigContributor;
use codex_extension_api::ContextContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionEventSink;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistry;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::PreviousWorldStateSection;
use codex_extension_api::RenderedWorldStateFragment;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::WorldStateContributionInput;
use codex_extension_api::WorldStateSectionContribution;
use codex_goal_extension::GoalService;
use codex_login::AuthManager;
use codex_protocol::ThreadId;
use codex_protocol::error::CodexErr;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_rollout::state_db::StateDbHandle;
use codex_thread_store::ThreadStore;
use serde_json::json;

use crate::outgoing_message::OutgoingMessageSender;
use crate::thread_state::ThreadListenerCommand;
use crate::thread_state::ThreadStateManager;

pub(crate) struct ThreadExtensionDependencies {
    pub(crate) event_sink: Arc<dyn ExtensionEventSink>,
    pub(crate) auth_manager: Arc<AuthManager>,
    pub(crate) state_db: Option<StateDbHandle>,
    pub(crate) thread_manager: Weak<ThreadManager>,
    pub(crate) goal_service: Arc<GoalService>,
    pub(crate) environment_manager: Arc<EnvironmentManager>,
    pub(crate) executor_skill_provider: Arc<dyn codex_skills_extension::SkillProvider>,
    /// Process-scoped persistence backend for extensions that need stored thread history.
    pub(crate) thread_store: Arc<dyn ThreadStore>,
}

pub(crate) fn thread_extensions<S>(
    guardian_agent_spawner: S,
    dependencies: ThreadExtensionDependencies,
) -> Arc<ExtensionRegistry<Config>>
where
    S: AgentSpawner<StartThreadOptions, Spawned = NewThread, Error = CodexErr> + 'static,
{
    let ThreadExtensionDependencies {
        event_sink,
        auth_manager,
        state_db,
        thread_manager,
        goal_service,
        environment_manager,
        executor_skill_provider,
        thread_store: _thread_store,
    } = dependencies;
    let mut builder = ExtensionRegistryBuilder::<Config>::with_event_sink(event_sink);
    if let Some(state_db) = state_db {
        codex_goal_extension::install_with_backend(
            &mut builder,
            state_db,
            codex_otel::global(),
            thread_manager,
            goal_service,
            |config: &Config| config.features.enabled(codex_features::Feature::Goals),
        );
    }
    codex_guardian::install(&mut builder, guardian_agent_spawner);
    install_elpis_continuity(&mut builder);
    codex_mcp_extension::install(&mut builder);
    codex_mcp_extension::install_executor_plugins(&mut builder, environment_manager);
    codex_web_search_extension::install(&mut builder, auth_manager.clone());
    codex_image_generation_extension::install(&mut builder, auth_manager, |config: &Config| {
        Some(config.codex_home.clone())
    });
    let skill_providers = codex_skills_extension::SkillProviders::new()
        .with_executor_provider(executor_skill_provider)
        .with_orchestrator_provider(Arc::new(
            codex_skills_extension::OrchestratorSkillProvider::new(),
        ));
    codex_skills_extension::install_with_providers_and_metrics(
        &mut builder,
        skill_providers,
        codex_otel::global(),
        |config: &Config| codex_skills_extension::SkillsExtensionConfig {
            include_instructions: config.include_skill_instructions,
            bundled_skills_enabled: config.bundled_skills_enabled(),
            orchestrator_skills_enabled: config.orchestrator_skills_enabled,
            shadow_selection_enabled: config
                .features
                .enabled(codex_features::Feature::SkillSearch),
        },
    );
    Arc::new(builder.build())
}

#[derive(Default)]
struct ElpisContinuityExtension;

const ELPIS_CONTINUITY_WORLD_STATE_ID: &str = "elpis_continuity";
const GUARDIAN_REVIEWER_NAME: &str = "guardian";

#[derive(Clone)]
struct ElpisContinuityConfig {
    memories_root: Option<codex_utils_absolute_path::AbsolutePathBuf>,
    cwd: codex_utils_absolute_path::AbsolutePathBuf,
    dev_rule_roots: Vec<codex_utils_absolute_path::AbsolutePathBuf>,
    eligible: bool,
}

#[cfg(test)]
#[test]
fn guardian_reviewer_sessions_are_ineligible_for_elpis_continuity() {
    assert!(elpis_continuity_is_eligible(&SessionSource::Cli));
    assert!(!elpis_continuity_is_eligible(&SessionSource::SubAgent(
        SubAgentSource::Other(GUARDIAN_REVIEWER_NAME.to_string())
    )));
}

#[cfg(test)]
#[test]
fn elpis_continuity_matcher_requires_the_complete_generator_prefix() {
    let generated = format!(
        "{}[MEMORY.md (/tmp/MEMORY.md)]\n\naccepted memory",
        codex_core::elpis_context::ELPIS_CONTINUITY_PROMPT_PREFIX
    );
    assert!(is_elpis_continuity_fragment("developer", &generated));
    assert!(!is_elpis_continuity_fragment(
        "developer",
        "## Elpis Admitted Context\n\nneighboring developer content"
    ));
    assert!(!is_elpis_continuity_fragment("user", &generated));
}

impl ElpisContinuityConfig {
    fn from_config(config: &Config, eligible: bool) -> Self {
        Self {
            memories_root: Some(config.memory_dir.clone()),
            cwd: config.cwd.clone(),
            dev_rule_roots: config.dev_rule_roots(),
            eligible,
        }
    }
}

impl ContextContributor for ElpisContinuityExtension {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let Some(config) = input.thread_store.get::<ElpisContinuityConfig>() else {
                return Vec::new();
            };
            if !config.eligible {
                return Vec::new();
            }
            let body = codex_core::elpis_context::build_continuity_prompt_with_dev_rule_roots(
                config.memories_root.as_ref().map(|root| root.as_path()),
                config.cwd.as_path(),
                &config.dev_rule_roots,
            )
            .await;
            let has_model_visible_content = body.is_some();
            let snapshot_body = body.clone();
            vec![
                WorldStateSectionContribution::new(
                    ELPIS_CONTINUITY_WORLD_STATE_ID,
                    json!({ "body": snapshot_body }),
                    move |previous| {
                        if matches!(
                            previous,
                            PreviousWorldStateSection::Known(previous)
                                if previous.get("body").and_then(serde_json::Value::as_str)
                                    == body.as_deref()
                        ) {
                            return None;
                        }
                        body.as_ref().map(|body| {
                            RenderedWorldStateFragment::new("developer", ("", ""), body.clone())
                        })
                    },
                )
                .with_retained_fragment_matcher(|role, text| {
                    is_elpis_continuity_fragment(role, text)
                })
                .with_single_history_slot(has_model_visible_content),
            ]
        })
    }
}

impl ThreadLifecycleContributor<Config> for ElpisContinuityExtension {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            input
                .thread_store
                .insert(ElpisContinuityConfig::from_config(
                    input.config,
                    elpis_continuity_is_eligible(input.session_source),
                ));
        })
    }
}

impl ConfigContributor<Config> for ElpisContinuityExtension {
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    ) {
        let Some(previous) = thread_store.get::<ElpisContinuityConfig>() else {
            return;
        };
        thread_store.insert(ElpisContinuityConfig::from_config(
            new_config,
            previous.eligible,
        ));
    }
}

fn elpis_continuity_is_eligible(session_source: &SessionSource) -> bool {
    !matches!(
        session_source,
        SessionSource::SubAgent(SubAgentSource::Other(name)) if name == GUARDIAN_REVIEWER_NAME
    )
}

fn is_elpis_continuity_fragment(role: &str, text: &str) -> bool {
    role == "developer"
        && text.starts_with(codex_core::elpis_context::ELPIS_CONTINUITY_PROMPT_PREFIX)
}

fn install_elpis_continuity(builder: &mut ExtensionRegistryBuilder<Config>) {
    let extension = Arc::new(ElpisContinuityExtension);
    builder.thread_lifecycle_contributor(extension.clone());
    builder.config_contributor(extension.clone());
    builder.prompt_contributor(extension);
}

pub(crate) fn app_server_extension_event_sink(
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
) -> Arc<dyn ExtensionEventSink> {
    Arc::new(AppServerExtensionEventSink {
        outgoing,
        thread_state_manager,
    })
}

struct AppServerExtensionEventSink {
    outgoing: Arc<OutgoingMessageSender>,
    thread_state_manager: ThreadStateManager,
}

impl ExtensionEventSink for AppServerExtensionEventSink {
    fn emit(&self, event: Event) {
        match event.msg {
            EventMsg::ThreadGoalUpdated(thread_goal_event) => {
                let thread_id = thread_goal_event.thread_id;
                let turn_id = thread_goal_event.turn_id;
                let goal: ThreadGoal = thread_goal_event.goal.into();
                if let Some(listener_command_tx) = self
                    .thread_state_manager
                    .current_listener_command_tx(thread_id)
                {
                    let command = ThreadListenerCommand::EmitThreadGoalUpdated {
                        turn_id: turn_id.clone(),
                        goal: goal.clone(),
                    };
                    if listener_command_tx.send(command).is_ok() {
                        return;
                    }
                    tracing::warn!(
                        "failed to enqueue extension goal update for {thread_id}: listener command channel is closed"
                    );
                }
                let outgoing = Arc::clone(&self.outgoing);
                tokio::spawn(async move {
                    outgoing
                        .send_server_notification(ServerNotification::ThreadGoalUpdated(
                            ThreadGoalUpdatedNotification {
                                thread_id: thread_id.to_string(),
                                turn_id,
                                goal,
                            },
                        ))
                        .await;
                });
            }
            msg => {
                tracing::debug!(event_id = %event.id, ?msg, "dropping unsupported extension event");
            }
        }
    }
}

pub(crate) fn guardian_agent_spawner(
    thread_manager: Weak<ThreadManager>,
) -> impl AgentSpawner<StartThreadOptions, Spawned = NewThread, Error = CodexErr> {
    move |forked_from_thread_id: ThreadId,
          options: StartThreadOptions|
          -> AgentSpawnFuture<'static, NewThread, CodexErr> {
        let thread_manager = thread_manager.clone();
        Box::pin(async move {
            let thread_manager = thread_manager.upgrade().ok_or_else(|| {
                CodexErr::UnsupportedOperation("thread manager dropped".to_string())
            })?;
            thread_manager
                .spawn_subagent(forked_from_thread_id, options)
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use codex_protocol::protocol::ThreadGoal as CoreThreadGoal;
    use codex_protocol::protocol::ThreadGoalStatus;
    use codex_protocol::protocol::ThreadGoalUpdatedEvent;
    use pretty_assertions::assert_eq;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::*;

    #[tokio::test]
    async fn app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears() {
        let (outgoing_tx, _outgoing_rx) = mpsc::channel(4);
        let outgoing = Arc::new(OutgoingMessageSender::new(outgoing_tx));
        let thread_state_manager = ThreadStateManager::new();
        let thread_id = ThreadId::default();
        let (listener_command_tx, mut listener_command_rx) = mpsc::unbounded_channel();
        thread_state_manager.register_listener_command_tx(thread_id, listener_command_tx.clone());
        let sink = app_server_extension_event_sink(outgoing, thread_state_manager);

        for turn_id in ["turn-1", "turn-2"] {
            sink.emit(thread_goal_updated_event(thread_id, turn_id));
        }
        listener_command_tx
            .send(ThreadListenerCommand::EmitThreadGoalCleared)
            .expect("listener command channel should be open");

        let mut observed = Vec::new();
        for _ in 0..3 {
            let command = timeout(Duration::from_secs(1), listener_command_rx.recv())
                .await
                .expect("timed out waiting for listener command")
                .expect("listener command channel closed unexpectedly");
            match command {
                ThreadListenerCommand::EmitThreadGoalUpdated { turn_id, .. } => {
                    observed.push(turn_id.expect("extension goal updates should include turn ids"));
                }
                ThreadListenerCommand::EmitThreadGoalCleared => {
                    observed.push("cleared".to_string())
                }
                _ => panic!("unexpected listener command"),
            }
        }

        assert_eq!(
            vec![
                "turn-1".to_string(),
                "turn-2".to_string(),
                "cleared".to_string()
            ],
            observed
        );
    }

    fn thread_goal_updated_event(thread_id: ThreadId, turn_id: &str) -> Event {
        Event {
            id: turn_id.to_string(),
            msg: EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent {
                thread_id,
                turn_id: Some(turn_id.to_string()),
                goal: CoreThreadGoal {
                    thread_id,
                    objective: "wire extension events".to_string(),
                    status: ThreadGoalStatus::Active,
                    token_budget: Some(123),
                    tokens_used: 45,
                    time_used_seconds: 6,
                    created_at: 7,
                    updated_at: 8,
                },
            }),
        }
    }
}

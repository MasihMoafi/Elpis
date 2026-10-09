//! Elpis: the App side of the provider-aware `/model` picker.
//!
//! The picker (chatwidget/elpis_providers.rs) asks the App to list a provider's models and to
//! switch providers. A switch persists the new provider and model as the defaults and then
//! continues the conversation on the new provider in a fork, reusing `thread/fork` with a
//! `model_provider`: a loaded thread ignores new settings on `thread/resume` while this TUI holds
//! it, and a fork keeps the whole history while the old thread keeps its provider. A thread with
//! no turns yet has nothing to carry, so it is replaced by a fresh session on the new provider.

use super::session_lifecycle::ThreadAttachPresentation;
use super::*;
use crate::app_server_session::ForkGoalContinuation;
use crate::chatwidget::ElpisProviderEvent;

/// The fork error a thread with no turns yet produces (its rollout does not exist).
const NO_ROLLOUT: &str = "no rollout found";

impl App {
    pub(super) async fn handle_elpis_provider_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: ElpisProviderEvent,
    ) {
        match event {
            ElpisProviderEvent::OpenProviders => self.chat_widget.open_elpis_provider_popup(),
            ElpisProviderEvent::Browse { provider_id } => self.elpis_browse_provider(provider_id),
            ElpisProviderEvent::ModelsLoaded {
                provider_id,
                result,
            } => self
                .chat_widget
                .open_elpis_provider_models(provider_id, result),
            ElpisProviderEvent::OpenKeyPrompt { provider_id } => {
                self.chat_widget.open_elpis_api_key_prompt(provider_id);
            }
            ElpisProviderEvent::SaveKey { provider_id, key } => {
                self.chat_widget.save_elpis_provider_key(provider_id, key);
            }
            ElpisProviderEvent::Switch { provider_id, model } => {
                self.elpis_switch_provider(tui, app_server, provider_id, model)
                    .await;
            }
            ElpisProviderEvent::UseClaudeModel { model } => {
                self.chat_widget
                    .apply_model_and_effort(model, /*effort*/ None);
            }
        }
        tui.frame_requester().schedule_frame();
    }

    /// Lists a provider's models, off the event loop. A gateway provider is always asked
    /// directly, so a key saved a moment ago counts; another provider the app server started
    /// with uses the app server's list.
    fn elpis_browse_provider(&mut self, provider_id: String) {
        // A bridged subscription's models are already in the app server's list.
        if crate::chatwidget::bridged_provider(&provider_id).is_some() {
            self.chat_widget
                .open_elpis_provider_models(provider_id, Ok(Vec::new()));
            return;
        }
        let Some(provider) = self.config.model_providers.get(&provider_id).cloned() else {
            self.chat_widget
                .add_error_message(format!("Model provider `{provider_id}` not found"));
            return;
        };
        if crate::chatwidget::elpis_lists_from_app_server(&provider_id, &provider) {
            let presets = self.model_catalog.try_list_models().unwrap_or_default();
            self.chat_widget
                .open_elpis_provider_models(provider_id, Ok(presets));
            return;
        }
        let home = self.config.codex_home.to_path_buf();
        let tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result =
                crate::chatwidget::load_elpis_provider_models(home, provider_id.clone(), provider)
                    .await;
            tx.send(AppEvent::Elpis(
                crate::elpis_app_event::ElpisAppEvent::Provider(ElpisProviderEvent::ModelsLoaded {
                    provider_id,
                    result,
                }),
            ));
        });
    }

    async fn elpis_switch_provider(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        provider_id: String,
        model: String,
    ) {
        if provider_id == self.chat_widget.config_ref().model_provider_id {
            // The thread's own provider: an ordinary model change.
            self.app_event_tx.send(AppEvent::UpdateModel(model.clone()));
            self.app_event_tx
                .send(AppEvent::UpdateReasoningEffort(None));
            self.app_event_tx.send(AppEvent::PersistModelSelection {
                model,
                effort: None,
            });
            return;
        }
        let Some(provider) = self.config.model_providers.get(&provider_id).cloned() else {
            self.chat_widget
                .add_error_message(format!("Model provider `{provider_id}` not found"));
            return;
        };
        let name = if provider.name.trim().is_empty() {
            provider_id.clone()
        } else {
            provider.name.clone()
        };

        // The next launch starts here, with the provider's full model details.
        let edits = vec![
            crate::config_update::replace_config_value(
                "model_provider",
                serde_json::json!(provider_id),
            ),
            crate::config_update::replace_config_value("model", serde_json::json!(model)),
        ];
        if let Err(err) = self
            .persist_model_defaults(
                app_server.request_handle(),
                edits,
                "default provider and model",
            )
            .await
        {
            self.chat_widget.add_error_message(format!(
                "Could not save {name} as the default provider: {}",
                crate::config_update::format_config_error(&err)
            ));
        }
        // New sessions in this terminal use it too.
        self.harness_overrides.model_provider = Some(provider_id.clone());
        self.harness_overrides.model = Some(model.clone());
        self.config.model_provider_id = provider_id;
        self.config.model_provider = provider;
        self.config.model = Some(model.clone());
        self.config.model_reasoning_effort = None;

        let Some(thread_id) = self.chat_widget.thread_id() else {
            self.start_fresh_session(
                tui, app_server, /*session_start_source*/ None,
                /*initial_user_message*/ None, /*new_thread_name*/ None,
            )
            .await;
            return;
        };
        let mut fork_config = self.config.clone();
        if app_server.uses_remote_workspace() {
            fork_config
                .workspace_roots
                .clone_from(&self.chat_widget.config_ref().workspace_roots);
        }
        let selected_profile = self.selected_server_profile(thread_id);
        match app_server
            .fork_thread_at(
                &self.local_settings,
                fork_config,
                thread_id,
                /*last_turn_id*/ None,
                /*before_turn_id*/ None,
                ForkGoalContinuation::StartIfIdle,
                selected_profile.as_ref(),
            )
            .await
        {
            Ok(forked) => {
                self.detach_current_thread_for_navigation(
                    app_server,
                    Some(forked.session.thread_id),
                )
                .await;
                match self
                    .replace_chat_widget_with_app_server_thread(
                        tui,
                        forked,
                        ThreadAttachPresentation::SessionLineage,
                        /*initial_user_message*/ None,
                    )
                    .await
                {
                    Ok(()) => self.chat_widget.add_info_message(
                        format!("Now on {name} · {model}."),
                        Some(
                            "This conversation continues in a fork; the previous thread keeps \
                             its provider."
                                .to_string(),
                        ),
                    ),
                    Err(err) => self.chat_widget.add_error_message(format!(
                        "Could not open the conversation on {name}: {err}"
                    )),
                }
            }
            Err(err)
                if err
                    .chain()
                    .any(|cause| cause.to_string().contains(NO_ROLLOUT)) =>
            {
                // No turns yet: nothing to carry over.
                self.start_fresh_session(
                    tui, app_server, /*session_start_source*/ None,
                    /*initial_user_message*/ None, /*new_thread_name*/ None,
                )
                .await;
                self.chat_widget
                    .add_info_message(format!("Now on {name} · {model}."), /*hint*/ None);
            }
            Err(err) => self.chat_widget.add_error_message(format!(
                "Could not continue this conversation on {name}: {err}. New sessions (/new) \
                 start on it."
            )),
        }
    }
}

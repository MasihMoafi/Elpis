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

/// Whether the app server's own list holds `provider_id`'s models: the provider it started with,
/// or a bridged subscription whose models the bridge adds to that list.
fn elpis_lists_app_server_catalog(provider_id: &str) -> bool {
    crate::chatwidget::bridged_provider(provider_id).is_some()
        || crate::chatwidget::elpis_catalog_provider().as_deref() == Some(provider_id)
}

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
            ElpisProviderEvent::Browse { provider_id } => {
                self.elpis_browse_provider(app_server, provider_id);
            }
            ElpisProviderEvent::ModelsLoaded {
                provider_id,
                request_id,
                result,
            } => {
                // Every provider's live list is kept for effort lookups once a model there runs.
                if let Ok(presets) = &result
                    && crate::chatwidget::bridged_provider(&provider_id).is_none()
                {
                    self.chat_widget
                        .remember_provider_presets(provider_id.clone(), presets.clone());
                }
                // The app server's own list refreshes the shared catalog too, so a model added
                // since startup can be picked and its effort levels are known.
                if self.chat_widget.model_popup_request_is_current(request_id)
                    && elpis_lists_app_server_catalog(&provider_id)
                    && let Ok(presets) = &result
                    && self.chat_widget.replace_model_catalog(presets.clone())
                {
                    self.model_catalog = self.chat_widget.model_catalog();
                    if let Ok(models) = self.model_catalog.try_list_models() {
                        app_server.set_available_models(models);
                    }
                }
                self.chat_widget
                    .finish_elpis_models_loading(request_id, provider_id, result);
            }
            ElpisProviderEvent::PrefetchPresets { provider_id, offer } => {
                self.elpis_prefetch_presets(app_server, provider_id, offer);
            }
            ElpisProviderEvent::PresetsLoaded {
                provider_id,
                result,
                offer,
            } => match result {
                Ok(presets) => {
                    let current = provider_id == self.chat_widget.config_ref().model_provider_id;
                    self.chat_widget
                        .remember_provider_presets(provider_id, presets);
                    // Only for the provider still in use, and only while nothing else is open.
                    if offer && current && self.chat_widget.no_modal_or_popup_active() {
                        self.chat_widget.offer_effort_levels();
                    }
                }
                Err(error) => {
                    tracing::warn!(%provider_id, %error, "could not list provider models")
                }
            },
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
        }
        tui.frame_requester().schedule_frame();
    }

    /// Lists a provider's models live, off the event loop, behind a loading picker. A gateway
    /// provider is asked directly, so a key saved a moment ago counts; every other provider,
    /// including ChatGPT while another provider is the default, is listed by the app server.
    fn elpis_browse_provider(&mut self, app_server: &AppServerSession, provider_id: String) {
        let gateway = match crate::chatwidget::bridged_provider(&provider_id) {
            Some(_) => None,
            None => {
                let Some(provider) = self.config.model_providers.get(&provider_id).cloned() else {
                    self.chat_widget
                        .add_error_message(format!("Model provider `{provider_id}` not found"));
                    return;
                };
                codex_model_provider_info::gateway_route(&provider)
                    .is_some()
                    .then_some(provider)
            }
        };
        let request_id = self.chat_widget.begin_elpis_models_loading(&provider_id);
        let tx = self.app_event_tx.clone();
        let Some(provider) = gateway else {
            let model_provider =
                (!elpis_lists_app_server_catalog(&provider_id)).then(|| provider_id.clone());
            app_server.fetch_provider_models(provider_id, model_provider, request_id, tx);
            return;
        };
        let home = self.config.codex_home.to_path_buf();
        tokio::spawn(async move {
            let result =
                crate::chatwidget::load_elpis_provider_models(home, provider_id.clone(), provider)
                    .await;
            tx.send(AppEvent::Elpis(
                crate::elpis_app_event::ElpisAppEvent::Provider(ElpisProviderEvent::ModelsLoaded {
                    provider_id,
                    request_id,
                    result,
                }),
            ));
        });
    }

    /// Lists a provider's models for effort lookups only, the way `elpis_browse_provider` does.
    fn elpis_prefetch_presets(
        &mut self,
        app_server: &AppServerSession,
        provider_id: String,
        offer: bool,
    ) {
        let Some(provider) = self.config.model_providers.get(&provider_id).cloned() else {
            return;
        };
        let tx = self.app_event_tx.clone();
        let send = move |provider_id, result| {
            tx.send(AppEvent::Elpis(
                crate::elpis_app_event::ElpisAppEvent::Provider(
                    ElpisProviderEvent::PresetsLoaded {
                        provider_id,
                        result,
                        offer,
                    },
                ),
            ));
        };
        if codex_model_provider_info::gateway_route(&provider).is_some() {
            let home = self.config.codex_home.to_path_buf();
            tokio::spawn(async move {
                let result = crate::chatwidget::load_elpis_provider_models(
                    home,
                    provider_id.clone(),
                    provider,
                )
                .await;
                send(provider_id, result);
            });
            return;
        }
        let request_handle = app_server.request_handle();
        tokio::spawn(async move {
            let result = crate::app_server_session::list_live_models(
                request_handle,
                uuid::Uuid::new_v4(),
                Some(provider_id.clone()),
            )
            .await;
            send(provider_id, result);
        });
    }

    /// A switch landed on the new provider: carry the unsent input over, then offer the new
    /// model's effort levels, as Codex does after a model is picked.
    async fn finish_provider_switch(
        &mut self,
        source: Option<ThreadId>,
        input: Option<ThreadInputState>,
    ) {
        self.carry_input_after_provider_switch(source, input).await;
        self.chat_widget.offer_effort_levels();
    }

    /// Move only unsent input to the replacement chat. The source keeps its questions and
    /// running work, and the destination keeps its selected model and current turn state.
    async fn carry_input_after_provider_switch(
        &mut self,
        source: Option<ThreadId>,
        input: Option<ThreadInputState>,
    ) {
        let Some(mut input) = input else {
            return;
        };
        if self.chat_widget.thread_id() == source {
            return;
        }
        let Some(mut target) = self.chat_widget.capture_thread_input_state() else {
            return;
        };
        let mut source_store = match source.and_then(|id| self.thread_event_channels.get(&id)) {
            Some(channel) => Some(channel.store.lock().await),
            None => None,
        };
        // Replacement saves the latest source input, including notifications drained during
        // attachment. Moving from that store also prevents replay on the previous provider.
        source_store
            .as_mut()
            .and_then(|store| store.input_state.as_mut())
            .unwrap_or(&mut input)
            .move_draft_and_queue_to(&mut target);
        drop(source_store);
        self.chat_widget.restore_thread_input_state(
            Some(target),
            crate::chatwidget::ThreadInputStateRestoreMode {
                preserve_in_flight_turn: true,
            },
        );
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
            let input = self.chat_widget.capture_thread_input_state();
            self.start_fresh_session(
                tui, app_server, /*session_start_source*/ None,
                /*initial_user_message*/ None, /*new_thread_name*/ None,
            )
            .await;
            self.finish_provider_switch(/*source*/ None, input).await;
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
                let input = self.chat_widget.capture_thread_input_state();
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
                    Ok(()) => {
                        self.finish_provider_switch(Some(thread_id), input).await;
                        self.chat_widget.add_info_message(
                            format!("Now on {name} · {model}."),
                            Some(
                                "This conversation continues in a fork; the previous thread \
                                 keeps its provider."
                                    .to_string(),
                            ),
                        );
                    }
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
                // No turns yet: nothing to carry over but the owner's input.
                let input = self.chat_widget.capture_thread_input_state();
                self.start_fresh_session(
                    tui, app_server, /*session_start_source*/ None,
                    /*initial_user_message*/ None, /*new_thread_name*/ None,
                )
                .await;
                self.finish_provider_switch(Some(thread_id), input).await;
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

#[cfg(test)]
#[path = "elpis_providers_tests.rs"]
mod tests;

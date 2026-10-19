//! App-side handling of Elpis-owned events (`AppEvent::Elpis`).

use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use crate::legacy_core::config::edit::ConfigEdit;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS;

impl App {
    pub(super) async fn handle_elpis_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: ElpisAppEvent,
    ) -> Result<()> {
        match event {
            ElpisAppEvent::EnableYolo => self.enable_yolo(app_server).await,
            ElpisAppEvent::Provider(event) => {
                self.handle_elpis_provider_event(tui, app_server, event)
                    .await;
            }
            ElpisAppEvent::SaveBackgroundModel(choice) => self.save_background_model(choice).await,
            ElpisAppEvent::WorkGraphLoaded(result) => self.add_loaded_work_graph(result),
            ElpisAppEvent::OpenDashboard => {
                self.open_dashboard(tui, app_server);
                self.refresh_agents_overview_threads(app_server);
                if let Some(root) = self.primary_thread_id {
                    self.refresh_agent_picker_threads(app_server, root);
                }
            }
            ElpisAppEvent::RefreshDashboard => self.publish_dashboard_snapshot(app_server),
            ElpisAppEvent::RefreshDashboardAgents => {
                if crate::dashboard_server::is_running()
                    && let Some(root) = self.primary_thread_id
                {
                    self.refresh_agent_picker_threads(app_server, root);
                }
            }
            ElpisAppEvent::OpenUsage(card) => {
                self.open_escape_closable_pager(tui, card, "Usage")?
            }
            ElpisAppEvent::LoadSmartPruneLog(thread_id, request_id) => {
                if self.current_displayed_thread_id() != Some(thread_id) {
                    return Ok(());
                }
                let log_dir = self
                    .chat_widget
                    .config_ref()
                    .codex_home
                    .as_path()
                    .join("logs");
                let tx = self.app_event_tx.clone();
                tokio::spawn(async move {
                    let records = tokio::task::spawn_blocking(move || {
                        crate::legacy_core::smart_prune_log::load_chat(
                            &log_dir,
                            &thread_id.to_string(),
                        )
                        .map_err(|error| error.to_string())
                    })
                    .await
                    .unwrap_or_else(|error| Err(error.to_string()));
                    tx.send(AppEvent::Elpis(ElpisAppEvent::SmartPruneLogLoaded(
                        thread_id, request_id, records,
                    )));
                });
            }
            ElpisAppEvent::SmartPruneLogLoaded(thread_id, request_id, records) => {
                if self.current_displayed_thread_id() == Some(thread_id) {
                    self.chat_widget.finish_smart_prune_log(request_id, records);
                    tui.frame_requester().schedule_frame();
                }
            }
            ElpisAppEvent::OpenSmartPruneRecord(record) => {
                if self
                    .current_displayed_thread_id()
                    .is_some_and(|id| id.to_string() == record.thread_id)
                {
                    tui.enter_alt_screen()?;
                    self.reset_backtrack_state();
                    self.overlay = Some(crate::chatwidget::smart_prune_log::record_overlay(
                        &record,
                        &self.keymap.pager,
                    ));
                    tui.frame_requester().schedule_frame();
                }
            }
            ledger_event => self.handle_elpis_ledger_event(tui, ledger_event)?,
        }
        Ok(())
    }

    /// `/dashboard`: publish the current state, start the loopback server once and open the
    /// page in a browser, as v0.3.0 did.
    fn open_dashboard(&mut self, tui: &mut tui::Tui, app_server: &AppServerSession) {
        self.publish_dashboard_snapshot(app_server);
        match crate::dashboard_server::ensure_running() {
            Some(url) => match webbrowser::open(&url) {
                Ok(()) => self
                    .chat_widget
                    .add_info_message(format!("Opened the context dashboard at {url}"), None),
                Err(_) => self.chat_widget.add_info_message(
                    format!("The context dashboard is at {url}"),
                    Some("No browser could be opened; open the address yourself.".to_string()),
                ),
            },
            None => self
                .chat_widget
                .add_error_message("Could not start the local dashboard server".to_string()),
        }
        // The Agents map starts with the agents this session already knows.
        self.repaint_agents_overview();
        tui.frame_requester().schedule_frame();
    }

    /// Publishes the page's state and tells the dashboard server how to reach this App, so the
    /// Models, keys and Smart Prune pages act on the current session.
    fn publish_dashboard_snapshot(&self, app_server: &AppServerSession) {
        let totals = crate::elpis_ledger_events::context_usage_totals(&self.transcript_cells);
        self.chat_widget.publish_dashboard_snapshot(&totals);
        let config = self.chat_widget.config_ref();
        crate::dashboard_server::register_link(crate::dashboard_server::DashboardLink {
            tx: self.app_event_tx.clone(),
            home: config.codex_home.to_path_buf(),
            providers: config.model_providers.clone(),
            active_provider: config.model_provider_id.clone(),
            catalog: self.model_catalog.try_list_models().unwrap_or_default(),
            pruner_role_provider: self.chat_widget.pruner_role_provider().to_string(),
            runtime: tokio::runtime::Handle::try_current().ok(),
            app_server: Some(app_server.request_handle()),
            refresh_pending: Default::default(),
        });
    }

    /// `/yolo`: Full Access (no sandbox, never ask) for this chat, saved as the default for
    /// future chats.
    ///
    /// The per-chat switch goes through the upstream permission-selection path, which reports
    /// its own outcome. Unlike v0.3.0, approvals that are already pending are not accepted.
    async fn enable_yolo(&mut self, app_server: &mut AppServerSession) {
        if self.reject_pending_permission_change() {
            return;
        }
        if !self
            .select_permission_profile(
                app_server,
                PermissionProfileSelection {
                    profile_id: BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS.to_string(),
                    approval_policy: Some(AskForApproval::Never),
                    approvals_reviewer: Some(ApprovalsReviewer::User),
                    display_label: "Full Access".to_string(),
                },
            )
            .await
        {
            return;
        }
        let Some(thread_id) = self.chat_widget.thread_id() else {
            return;
        };
        let config = self.config.clone();
        if self
            .agents_overview
            .requested_permission_profiles
            .contains_key(&thread_id)
        {
            self.agents_overview
                .pending_yolo_defaults
                .insert(thread_id, config);
        } else {
            // Full Access was already confirmed, so reselecting it produces no new snapshot.
            self.save_confirmed_yolo_default(config).await;
        }
    }

    pub(super) async fn save_confirmed_yolo_default(&mut self, config: Config) {
        match Self::persist_full_access_default(&config).await {
            Ok(()) => self.chat_widget.add_info_message(
                "Full Access saved as the default for future chats.".to_string(),
                /*hint*/ None,
            ),
            Err(err) => self
                .chat_widget
                .add_error_message(format!("Full Access default could not be saved: {err}")),
        }
    }

    /// `/memory-model`: save the background model in config.toml, then use it in this
    /// session (the chat's config and the one new chats start from).
    async fn save_background_model(
        &mut self,
        choice: crate::elpis_background_model::BackgroundModelChoice,
    ) {
        let saved = ConfigEditsBuilder::for_config(&self.config)
            .with_edits(choice.edits())
            .apply()
            .await;
        match saved {
            Ok(()) => {
                choice.apply_to(&mut self.config);
                self.chat_widget.apply_background_model(&choice);
                self.chat_widget.add_info_message(
                    format!(
                        "Background model saved: {}. Smart Prune uses it when no pruning model is selected; memory uses the responding agent.",
                        crate::elpis_background_model::describe(self.chat_widget.config_ref())
                    ),
                    /*hint*/ None,
                );
            }
            Err(err) => self
                .chat_widget
                .add_error_message(format!("Background model was not changed: {err}")),
        }
    }

    /// Save Full Access as the config.toml default, as v0.3.0 did.
    async fn persist_full_access_default(config: &Config) -> anyhow::Result<()> {
        let mut edits = vec![ConfigEdit::ClearPath {
            segments: vec!["sandbox_mode".into()],
        }];
        for (key, value) in [
            (
                "default_permissions",
                BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS,
            ),
            ("approval_policy", "never"),
            ("approvals_reviewer", "user"),
        ] {
            edits.push(ConfigEdit::SetPath {
                segments: vec![key.into()],
                value: value.into(),
            });
        }
        ConfigEditsBuilder::for_config(config)
            .with_edits(edits)
            .apply()
            .await
    }
}

#[cfg(test)]
#[path = "elpis_events_tests.rs"]
mod tests;

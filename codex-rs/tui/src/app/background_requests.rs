// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Background app-server requests launched by the TUI app.
//!
//! This module owns fire-and-forget fetch/write helpers for MCP inventory, skills, plugins, rate
//! limits, add-credit nudges, and feedback uploads. Results are routed back through `AppEvent` so
//! the main event loop remains single-threaded.

use super::plugin_mentions::fetch_plugin_mentions;
use super::*;
use crate::app_event::ConnectorsSnapshot;
use crate::app_info::app_info_from_api;
use crate::config_update::format_config_error;
use codex_app_server_protocol::AppsListParams;
use codex_app_server_protocol::AppsListResponse;
use codex_app_server_protocol::ConsumeAccountRateLimitResetCreditParams;
use codex_app_server_protocol::ConsumeAccountRateLimitResetCreditResponse;
use codex_app_server_protocol::MarketplaceAddParams;
use codex_app_server_protocol::MarketplaceAddResponse;
use codex_app_server_protocol::MarketplaceRemoveParams;
use codex_app_server_protocol::MarketplaceRemoveResponse;
use codex_app_server_protocol::MarketplaceUpgradeParams;
use codex_app_server_protocol::MarketplaceUpgradeResponse;

use codex_app_server_protocol::RequestId;

use crate::hooks_rpc::fetch_hooks_list;
use crate::hooks_rpc::write_hook_trust;
use crate::hooks_rpc::write_hook_trusts;
use codex_utils_absolute_path::AbsolutePathBuf;

const TOKEN_ACTIVITY_FETCH_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(/*secs*/ 15);
const RATE_LIMIT_RESET_REQUEST_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(/*secs*/ 15);
const WORKSPACE_HEADLINE_FETCH_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(/*millis*/ 2000);

impl App {
    pub(super) fn current_manual_memory_target(
        &self,
        epoch: u64,
    ) -> Option<ManualMemoryRequestTarget> {
        let primary_root_thread_id = self.primary_thread_id?;
        let displayed_thread_id = self.current_displayed_thread_id()?;
        let config = self.chat_widget.config_ref();
        let (admission_path, memory_path) =
            crate::legacy_core::elpis_context::manual_memory_storage_paths(
                Some(config.memory_dir.as_path()),
                config.cwd.as_path(),
            )?;
        Some(ManualMemoryRequestTarget {
            view: ManualMemoryViewKey {
                epoch,
                primary_root_thread_id,
                displayed_thread_id,
                cwd: config.cwd.to_path_buf(),
                memory_path: memory_path.clone(),
            },
            storage: ManualMemoryStorageTarget {
                admission_path,
                memory_path,
            },
        })
    }

    pub(super) fn next_manual_memory_target(&mut self) -> Option<ManualMemoryRequestTarget> {
        let Some(epoch) = self.manual_memory_status.epoch.checked_add(1) else {
            tracing::error!("manual-memory view epoch exhausted");
            return None;
        };
        self.manual_memory_status.epoch = epoch;
        self.current_manual_memory_target(epoch)
    }

    pub(super) fn manual_memory_storage_target_for_cwd(
        &self,
        cwd: &Path,
    ) -> Option<ManualMemoryStorageTarget> {
        let config = self.chat_widget.config_ref();
        let (admission_path, memory_path) =
            crate::legacy_core::elpis_context::manual_memory_storage_paths(
                Some(config.memory_dir.as_path()),
                cwd,
            )?;
        Some(ManualMemoryStorageTarget {
            admission_path,
            memory_path,
        })
    }

    pub(super) fn pending_manual_memory_mutation_for(
        &self,
        storage: &ManualMemoryStorageTarget,
    ) -> Option<ManualMemoryMutation> {
        self.manual_memory_status
            .mutations
            .get(storage)
            .map(|owner| owner.mutation)
    }

    pub(super) fn seed_manual_memory_mutation_for_cwd(&mut self, cwd: &Path) {
        let pending = self
            .manual_memory_storage_target_for_cwd(cwd)
            .as_ref()
            .and_then(|storage| self.pending_manual_memory_mutation_for(storage));
        self.chat_widget
            .seed_manual_memory_pending_mutation(pending);
    }

    pub(super) fn prepare_manual_memory_lifecycle_change(
        &mut self,
    ) -> Option<crate::chatwidget::ThreadComposerState> {
        if !self.chat_widget.manual_memory_submission_blocked() {
            return None;
        }
        let storage = self
            .chat_widget
            .manual_memory_bound_target()
            .map(|target| target.storage.clone());
        self.chat_widget
            .restore_admission_blocked_input_to_composer();
        if let Some(storage) = storage
            && let Some(owner) = self.manual_memory_status.mutations.get_mut(&storage)
            && matches!(owner.mutation, ManualMemoryMutation::Admission { .. })
        {
            owner.allow_same_view_autosend = false;
        }
        self.chat_widget.manual_memory_lifecycle_composer_state()
    }

    pub(super) fn activate_manual_memory_view(&mut self) -> bool {
        let Some(target) = self.next_manual_memory_target() else {
            return false;
        };
        let pending_mutation = self.pending_manual_memory_mutation_for(&target.storage);
        self.chat_widget.bind_manual_memory_loading(
            target.clone(),
            /*pending_context_report*/ false,
            pending_mutation,
        );
        self.publish_current_dashboard_snapshot();
        self.launch_manual_memory_status(target)
    }

    pub(super) fn activate_manual_memory_view_if_changed(&mut self) -> bool {
        let Some(bound) = self.chat_widget.manual_memory_bound_target() else {
            return self.activate_manual_memory_view();
        };
        let Some(current) = self.current_manual_memory_target(bound.view.epoch) else {
            return false;
        };
        if current == *bound {
            return false;
        }
        self.activate_manual_memory_view()
    }

    pub(super) fn publish_current_dashboard_snapshot(&self) {
        let totals = crate::app_backtrack::context_usage_totals(&self.transcript_cells);
        self.chat_widget.publish_dashboard_snapshot(&totals);
    }

    pub(super) fn request_manual_memory_refresh_for_paths(
        &mut self,
        memories_root: &Path,
        cwd: &Path,
    ) -> bool {
        let Some((admission_path, memory_path)) =
            crate::legacy_core::elpis_context::manual_memory_storage_paths(
                Some(memories_root),
                cwd,
            )
        else {
            return false;
        };
        let storage = ManualMemoryStorageTarget {
            admission_path,
            memory_path,
        };
        if self
            .chat_widget
            .manual_memory_bound_target()
            .is_none_or(|target| target.storage != storage)
        {
            return false;
        }
        self.chat_widget.request_manual_memory_status_refresh();
        true
    }

    pub(super) fn launch_manual_memory_status(
        &mut self,
        target: ManualMemoryRequestTarget,
    ) -> bool {
        if self.manual_memory_status.in_flight.as_ref() == Some(&target) {
            return false;
        }
        self.manual_memory_status.in_flight = Some(target.clone());

        let instruction_source_paths = self.chat_widget.instruction_source_paths_as_path_bufs();
        let dev_rule_roots = self.chat_widget.config_ref().dev_rule_roots();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let worker_target = target.clone();
            let completion = match tokio::task::spawn_blocking(move || {
                Self::load_manual_memory_status(
                    &worker_target,
                    &instruction_source_paths,
                    &dev_rule_roots,
                )
            })
            .await
            {
                Ok(completion) => completion,
                Err(_) => {
                    tracing::warn!("manual-memory status worker failed");
                    ManualMemoryStatusCompletion::Unavailable(
                        ManualMemoryUnavailableReason::WorkerFailed,
                    )
                }
            };
            app_event_tx.send(AppEvent::ManualMemoryStatusLoaded(target, completion));
        });
        true
    }

    pub(super) fn load_manual_memory_status(
        target: &ManualMemoryRequestTarget,
        instruction_source_paths: &[PathBuf],
        dev_rule_roots: &[AbsolutePathBuf],
    ) -> ManualMemoryStatusCompletion {
        let Some(memories_root) = target.storage.memory_path.parent() else {
            return ManualMemoryStatusCompletion::Unavailable(
                ManualMemoryUnavailableReason::AdmissionUnavailable,
            );
        };
        let status = match crate::legacy_core::elpis_context::manual_memory_status(
            Some(memories_root),
            &target.view.cwd,
        ) {
            Ok(Some(status)) => status,
            Ok(None) => {
                return ManualMemoryStatusCompletion::Unavailable(
                    ManualMemoryUnavailableReason::AdmissionUnavailable,
                );
            }
            Err(error) => {
                return ManualMemoryStatusCompletion::Unavailable(error.reason.into());
            }
        };
        match crate::legacy_core::elpis_context::continuity_sources_from_manual_memory_status(
            Some(memories_root),
            &target.view.cwd,
            instruction_source_paths,
            dev_rule_roots,
            Some(&status),
        ) {
            Ok(sources) => ManualMemoryStatusCompletion::Ready { status, sources },
            Err(_) => ManualMemoryStatusCompletion::Unavailable(
                ManualMemoryUnavailableReason::SourcesUnavailable,
            ),
        }
    }

    fn manual_memory_root_for_target<'a>(
        target: &'a ManualMemoryRequestTarget,
    ) -> Option<&'a Path> {
        let memories_root = target.storage.memory_path.parent()?;
        let expected = crate::legacy_core::elpis_context::manual_memory_storage_paths(
            Some(memories_root),
            &target.view.cwd,
        )?;
        (target.view.memory_path.as_path() == target.storage.memory_path.as_path()
            && expected.0.as_path() == target.storage.admission_path.as_path()
            && expected.1.as_path() == target.storage.memory_path.as_path())
        .then_some(memories_root)
    }

    fn manual_memory_mutation_failure(
        mutation: ManualMemoryMutation,
        error: &std::io::Error,
    ) -> ManualMemoryMutationFailure {
        match error.kind() {
            std::io::ErrorKind::AlreadyExists => ManualMemoryMutationFailure::AlreadyExists,
            std::io::ErrorKind::NotFound
                if matches!(mutation, ManualMemoryMutation::Admission { .. }) =>
            {
                ManualMemoryMutationFailure::Missing
            }
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
                ManualMemoryMutationFailure::StorageUnavailable
            }
            _ => ManualMemoryMutationFailure::PersistenceFailed,
        }
    }

    pub(super) fn perform_manual_memory_create(
        target: &ManualMemoryRequestTarget,
    ) -> ManualMemoryMutationCompletion {
        let Some(memories_root) = Self::manual_memory_root_for_target(target) else {
            return ManualMemoryMutationCompletion::Failed(
                ManualMemoryMutationFailure::StorageUnavailable,
            );
        };
        match crate::legacy_core::elpis_context::create_manual_memory(
            Some(memories_root),
            &target.view.cwd,
        ) {
            Ok(_) => ManualMemoryMutationCompletion::Succeeded,
            Err(error) => ManualMemoryMutationCompletion::Failed(
                Self::manual_memory_mutation_failure(ManualMemoryMutation::Create, &error),
            ),
        }
    }

    pub(super) fn perform_manual_memory_admission(
        target: &ManualMemoryRequestTarget,
        admitted: bool,
    ) -> ManualMemoryMutationCompletion {
        let Some(memories_root) = Self::manual_memory_root_for_target(target) else {
            return ManualMemoryMutationCompletion::Failed(
                ManualMemoryMutationFailure::StorageUnavailable,
            );
        };
        let Some(source_name) = target
            .storage
            .memory_path
            .file_name()
            .and_then(|name| name.to_str())
        else {
            return ManualMemoryMutationCompletion::Failed(
                ManualMemoryMutationFailure::StorageUnavailable,
            );
        };
        match crate::legacy_core::elpis_context::set_continuity_source_admitted(
            Some(memories_root),
            &target.view.cwd,
            source_name,
            admitted,
        ) {
            Ok(()) => ManualMemoryMutationCompletion::Succeeded,
            Err(error) => {
                ManualMemoryMutationCompletion::Failed(Self::manual_memory_mutation_failure(
                    ManualMemoryMutation::Admission { admitted },
                    &error,
                ))
            }
        }
    }

    pub(super) fn launch_manual_memory_create(&self, target: ManualMemoryRequestTarget) {
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let worker_target = target.clone();
            let completion = match tokio::task::spawn_blocking(move || {
                Self::perform_manual_memory_create(&worker_target)
            })
            .await
            {
                Ok(completion) => completion,
                Err(_) => {
                    tracing::warn!("manual-memory create worker failed");
                    ManualMemoryMutationCompletion::Failed(
                        ManualMemoryMutationFailure::WorkerFailed,
                    )
                }
            };
            app_event_tx.send(AppEvent::ManualMemoryCreateFinished(target, completion));
        });
    }

    pub(super) fn launch_manual_memory_admission(
        &self,
        target: ManualMemoryRequestTarget,
        admitted: bool,
    ) {
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let worker_target = target.clone();
            let completion = match tokio::task::spawn_blocking(move || {
                Self::perform_manual_memory_admission(&worker_target, admitted)
            })
            .await
            {
                Ok(completion) => completion,
                Err(_) => {
                    tracing::warn!("manual-memory admission worker failed");
                    ManualMemoryMutationCompletion::Failed(
                        ManualMemoryMutationFailure::WorkerFailed,
                    )
                }
            };
            app_event_tx.send(AppEvent::ManualMemoryAdmissionFinished(
                target, admitted, completion,
            ));
        });
    }

    pub(super) fn fetch_mcp_inventory(
        &mut self,
        app_server: &AppServerSession,
        detail: McpServerStatusDetail,
        thread_id: Option<ThreadId>,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        let request_thread_id = self.mcp_inventory_request_thread_id(thread_id);
        tokio::spawn(async move {
            let result = fetch_all_mcp_server_statuses(request_handle, detail, request_thread_id)
                .await
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::McpInventoryLoaded {
                result,
                detail,
                thread_id,
            });
        });
    }

    fn mcp_inventory_request_thread_id(&self, thread_id: Option<ThreadId>) -> Option<ThreadId> {
        thread_id.filter(|thread_id| {
            self.active_thread_id == Some(*thread_id)
                && self
                    .agent_navigation
                    .get(thread_id)
                    .is_none_or(|entry| !entry.is_closed)
        })
    }

    /// Spawns a background task to fetch account rate limits and deliver the
    /// result as a `RateLimitsLoaded` event.
    ///
    /// The `origin` is forwarded to the completion handler so it can distinguish
    /// a startup prefetch (which updates cached snapshots and may surface a
    /// reset-credit notice) from a `/usage`-triggered refresh (which must
    /// finalize the corresponding status card).
    pub(super) fn refresh_rate_limits(
        &mut self,
        app_server: &AppServerSession,
        origin: RateLimitRefreshOrigin,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        let hard_stop_generation = self.rate_limit_hard_stop_generation;
        tokio::spawn(async move {
            let request = fetch_account_rate_limits(request_handle);
            let result = request.await.map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::RateLimitsLoaded {
                origin,
                hard_stop_generation,
                result,
            });
        });
    }

    pub(super) fn refresh_token_activity(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                TOKEN_ACTIVITY_FETCH_TIMEOUT,
                fetch_account_token_activity(request_handle),
            )
            .await
            .map_err(|_| "account/usage/read timed out in TUI".to_string())
            .and_then(|result| result.map_err(|err| err.to_string()));
            app_event_tx.send(AppEvent::TokenActivityLoaded { request_id, result });
        });
    }

    pub(super) fn refresh_status_line_workspace_headline(
        &mut self,
        app_server: &AppServerSession,
        request_id: u64,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                WORKSPACE_HEADLINE_FETCH_TIMEOUT,
                fetch_workspace_messages(request_handle),
            )
            .await
            .map_err(|_| "account/workspaceMessages/read timed out in TUI".to_string())
            .and_then(|result| {
                result
                    .map(crate::workspace_messages::workspace_headline_from_response)
                    .map_err(|err| err.to_string())
            });
            app_event_tx.send(AppEvent::StatusLineWorkspaceHeadlineUpdated { request_id, result });
        });
    }

    pub(super) fn send_add_credits_nudge_email(
        &mut self,
        app_server: &AppServerSession,
        credit_type: AddCreditsNudgeCreditType,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = send_add_credits_nudge_email(request_handle, credit_type)
                .await
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::AddCreditsNudgeEmailFinished { result });
        });
    }

    /// Starts the initial skills refresh without delaying the first interactive frame.
    ///
    /// Startup only needs skill metadata to populate skill mentions and the skills UI; the prompt can be
    /// rendered before that metadata arrives. The result is routed through the normal app event queue so
    /// the same response handler updates the chat widget and emits invalid `SKILL.md` warnings once the
    /// app-server RPC finishes. User-initiated skills refreshes still use the blocking app command path so
    /// callers that explicitly asked for fresh skill state do not race ahead of their own refresh.
    pub(super) fn refresh_startup_skills(&mut self, app_server: &AppServerSession) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        let cwd = self.config.cwd.to_path_buf();
        tokio::spawn(async move {
            let result = fetch_skills_list(request_handle, cwd)
                .await
                .map_err(|err| format!("{err:#}"));
            app_event_tx.send(AppEvent::SkillsListLoaded { result });
        });
    }

    pub(super) fn fetch_connectors_list(
        &mut self,
        app_server: &AppServerSession,
        force_refetch: bool,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        let thread_id = self
            .current_displayed_thread_id()
            .map(|thread_id| thread_id.to_string());
        tokio::spawn(async move {
            let result = fetch_connectors_list(request_handle, force_refetch, thread_id)
                .await
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::ConnectorsLoaded {
                result,
                is_final: true,
            });
        });
    }

    pub(super) fn fetch_plugins_list(&mut self, app_server: &AppServerSession, cwd: PathBuf) {
        self.chat_widget.on_plugins_list_fetch_started(cwd.clone());
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        let plugin_sharing_enabled = self.config.features.enabled(Feature::PluginSharing);
        let remote_plugin_enabled = self.config.features.enabled(Feature::RemotePlugin);
        tokio::spawn(async move {
            let result = fetch_plugins_list(request_handle.clone(), cwd.clone())
                .await
                .map_err(|err| err.to_string());
            let should_fetch_additional_remote_sections = result.is_ok();
            app_event_tx.send(AppEvent::PluginsLoaded {
                cwd: cwd.clone(),
                result,
            });
            if should_fetch_additional_remote_sections {
                let (marketplaces, section_errors) = fetch_additional_plugin_remote_sections(
                    request_handle,
                    cwd.clone(),
                    plugin_sharing_enabled,
                    remote_plugin_enabled,
                )
                .await;
                app_event_tx.send(AppEvent::PluginRemoteSectionsLoaded {
                    cwd,
                    marketplaces,
                    section_errors,
                });
            }
        });
    }

    pub(super) fn fetch_hooks_list(&mut self, app_server: &AppServerSession, cwd: PathBuf) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = fetch_hooks_list(request_handle, cwd.clone())
                .await
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::HooksLoaded { cwd, result });
        });
    }

    pub(super) fn fetch_plugin_detail(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        params: PluginReadParams,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = fetch_plugin_detail(request_handle, params)
                .await
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::PluginDetailLoaded { cwd, result });
        });
    }

    pub(super) fn fetch_marketplace_add(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        source: String,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let source_for_event = source.clone();
            let result = fetch_marketplace_add(request_handle, cwd, source)
                .await
                .map_err(|err| format!("Failed to add marketplace: {err}"));
            app_event_tx.send(AppEvent::MarketplaceAddLoaded {
                cwd: cwd_for_event,
                source: source_for_event,
                result,
            });
        });
    }

    pub(super) fn fetch_marketplace_remove(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        marketplace_name: String,
        marketplace_display_name: String,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let marketplace_name_for_event = marketplace_name.clone();
            let result = fetch_marketplace_remove(request_handle, marketplace_name)
                .await
                .map_err(|err| format!("Failed to remove marketplace: {err}"));
            app_event_tx.send(AppEvent::MarketplaceRemoveLoaded {
                cwd: cwd_for_event,
                marketplace_name: marketplace_name_for_event,
                marketplace_display_name,
                result,
            });
        });
    }

    pub(super) fn fetch_marketplace_upgrade(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        marketplace_name: Option<String>,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let result = fetch_marketplace_upgrade(request_handle, marketplace_name)
                .await
                .map_err(|err| format!("Failed to upgrade marketplace: {err}"));
            app_event_tx.send(AppEvent::MarketplaceUpgradeLoaded {
                cwd: cwd_for_event,
                result,
            });
        });
    }

    pub(super) fn fetch_plugin_install(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        location: PluginLocation,
        plugin_name: String,
        plugin_display_name: String,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let location_for_event = location.clone();
            let plugin_name_for_event = plugin_name.clone();
            let result = fetch_plugin_install(request_handle, location, plugin_name)
                .await
                .map_err(|err| format!("Failed to install plugin: {err}"));
            app_event_tx.send(AppEvent::PluginInstallLoaded {
                cwd: cwd_for_event,
                location: location_for_event,
                plugin_name: plugin_name_for_event,
                plugin_display_name,
                result,
            });
        });
    }

    pub(super) fn fetch_plugin_uninstall(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        plugin_display_name: String,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let plugin_id_for_event = plugin_id.clone();
            let result = fetch_plugin_uninstall(request_handle, plugin_id)
                .await
                .map_err(|err| format!("Failed to uninstall plugin: {err}"));
            app_event_tx.send(AppEvent::PluginUninstallLoaded {
                cwd: cwd_for_event,
                plugin_id: plugin_id_for_event,
                plugin_display_name,
                result,
            });
        });
    }

    pub(super) fn set_plugin_enabled(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        enabled: bool,
    ) {
        if let Some(queued_enabled) = self.pending_plugin_enabled_writes.get_mut(&plugin_id) {
            *queued_enabled = Some(enabled);
            return;
        }

        self.pending_plugin_enabled_writes
            .insert(plugin_id.clone(), None);
        self.spawn_plugin_enabled_write(app_server, cwd, plugin_id, enabled);
    }

    pub(super) fn spawn_plugin_enabled_write(
        &mut self,
        app_server: &AppServerSession,
        cwd: PathBuf,
        plugin_id: String,
        enabled: bool,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let cwd_for_event = cwd.clone();
            let plugin_id_for_event = plugin_id.clone();
            let result = write_plugin_enabled(request_handle, plugin_id, enabled)
                .await
                .map(|_| ())
                .map_err(|err| format!("Failed to update plugin config: {err}"));
            app_event_tx.send(AppEvent::PluginEnabledSet {
                cwd: cwd_for_event,
                plugin_id: plugin_id_for_event,
                enabled,
                result,
            });
        });
    }

    pub(super) fn set_hook_enabled(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        enabled: bool,
    ) {
        if let Some(queued_enabled) = self.pending_hook_enabled_writes.get_mut(&key) {
            *queued_enabled = Some(enabled);
            return;
        }

        self.pending_hook_enabled_writes.insert(key.clone(), None);
        self.spawn_hook_enabled_write(app_server, key, enabled);
    }

    pub(super) fn spawn_hook_enabled_write(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        enabled: bool,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let key_for_event = key.clone();
            let result = write_hook_enabled(request_handle, key, enabled)
                .await
                .map(|_| ())
                .map_err(|err| {
                    format!(
                        "Failed to update hook config: {}",
                        format_config_error(&err)
                    )
                });
            app_event_tx.send(AppEvent::HookEnabledSet {
                key: key_for_event,
                enabled,
                result,
            });
        });
    }

    pub(super) fn trust_hook(
        &mut self,
        app_server: &AppServerSession,
        key: String,
        current_hash: String,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = write_hook_trust(request_handle, key, current_hash)
                .await
                .map(|_| ())
                .map_err(|err| format!("Failed to trust hook: {}", format_config_error(&err)));
            app_event_tx.send(AppEvent::HookTrusted { result });
        });
    }

    pub(super) fn trust_hooks(
        &mut self,
        app_server: &AppServerSession,
        updates: Vec<HookTrustUpdate>,
    ) {
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = write_hook_trusts(request_handle, updates)
                .await
                .map(|_| ())
                .map_err(|err| format!("Failed to trust hooks: {}", format_config_error(&err)));
            app_event_tx.send(AppEvent::HookTrusted { result });
        });
    }

    pub(super) fn refresh_plugin_mentions(&mut self, app_server: &AppServerSession) {
        let cwd = self.config.cwd.to_path_buf();
        let request_handle = app_server.request_handle();
        let app_event_tx = self.app_event_tx.clone();
        if !self.config.features.enabled(Feature::Plugins) {
            app_event_tx.send(AppEvent::PluginMentionsLoaded { plugins: None });
            return;
        }

        tokio::spawn(async move {
            match fetch_plugin_mentions(request_handle, cwd).await {
                Ok(plugins) => {
                    app_event_tx.send(AppEvent::PluginMentionsLoaded {
                        plugins: Some(plugins),
                    });
                }
                Err(err) => {
                    tracing::warn!(error = %err, "plugin/list failed while refreshing plugin mention candidates");
                }
            }
        });
    }

    /// Process the completed MCP inventory fetch: clear the loading spinner, then
    /// render either the full tool/resource listing or an error into chat history.
    ///
    /// When the app-server reports zero servers, a special "empty" cell is shown
    /// instead of the full table.
    pub(super) fn handle_mcp_inventory_result(
        &mut self,
        result: Result<Vec<McpServerStatus>, String>,
        detail: McpServerStatusDetail,
        thread_id: Option<ThreadId>,
    ) {
        if thread_id.is_some() && thread_id != self.current_displayed_thread_id() {
            return;
        }

        self.chat_widget.clear_mcp_inventory_loading();
        self.clear_committed_mcp_inventory_loading();

        let statuses = match result {
            Ok(statuses) => statuses,
            Err(err) => {
                self.chat_widget
                    .add_error_message(format!("Failed to load MCP inventory: {err}"));
                return;
            }
        };

        if statuses.is_empty() {
            self.chat_widget
                .add_to_history(history_cell::empty_mcp_output());
            return;
        }

        self.chat_widget
            .add_to_history(history_cell::new_mcp_tools_output_from_statuses(
                &statuses, detail,
            ));
    }

    pub(super) fn clear_committed_mcp_inventory_loading(&mut self) {
        let Some(index) = self
            .transcript_cells
            .iter()
            .rposition(|cell| cell.as_any().is::<history_cell::McpInventoryLoadingCell>())
        else {
            return;
        };

        self.transcript_cells.remove(index);
        if let Some(Overlay::Transcript(overlay)) = &mut self.overlay {
            overlay.replace_cells(self.transcript_cells.clone());
        }
    }
}

pub(super) async fn fetch_all_mcp_server_statuses(
    request_handle: AppServerRequestHandle,
    detail: McpServerStatusDetail,
    thread_id: Option<ThreadId>,
) -> Result<Vec<McpServerStatus>> {
    let mut cursor = None;
    let mut statuses = Vec::new();
    let thread_id = thread_id.map(|id| id.to_string());

    loop {
        let request_id = RequestId::String(format!("mcp-inventory-{}", Uuid::new_v4()));
        let response: ListMcpServerStatusResponse = request_handle
            .request_typed(ClientRequest::McpServerStatusList {
                request_id,
                params: ListMcpServerStatusParams {
                    cursor: cursor.clone(),
                    limit: Some(100),
                    detail: Some(detail),
                    thread_id: thread_id.clone(),
                },
            })
            .await
            .wrap_err("mcpServerStatus/list failed in TUI")?;
        statuses.extend(response.data);
        if let Some(next_cursor) = response.next_cursor {
            cursor = Some(next_cursor);
        } else {
            break;
        }
    }

    Ok(statuses)
}

pub(super) async fn fetch_account_rate_limits(
    request_handle: AppServerRequestHandle,
) -> Result<GetAccountRateLimitsResponse> {
    let request_id = RequestId::String(format!("account-rate-limits-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::GetAccountRateLimits {
            request_id,
            params: None,
        })
        .await
        .wrap_err("account/rateLimits/read failed in TUI")
}

pub(super) async fn fetch_account_token_activity(
    request_handle: AppServerRequestHandle,
) -> Result<codex_app_server_protocol::GetAccountTokenUsageResponse> {
    let request_id = RequestId::String(format!("account-token-usage-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::GetAccountTokenUsage {
            request_id,
            params: None,
        })
        .await
        .wrap_err("account/usage/read failed in TUI")
}

pub(super) async fn consume_rate_limit_reset_credit_request(
    request_handle: AppServerRequestHandle,
    idempotency_key: String,
    credit_id: Option<String>,
) -> Result<ConsumeAccountRateLimitResetCreditResponse> {
    let request_id = RequestId::String(format!("consume-rate-limit-reset-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::ConsumeAccountRateLimitResetCredit {
            request_id,
            params: ConsumeAccountRateLimitResetCreditParams {
                idempotency_key,
                credit_id,
            },
        })
        .await
        .wrap_err("account/rateLimitResetCredit/consume failed in TUI")
}

pub(super) async fn fetch_workspace_messages(
    request_handle: AppServerRequestHandle,
) -> Result<codex_app_server_protocol::GetWorkspaceMessagesResponse> {
    let request_id = RequestId::String(format!("workspace-messages-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::GetWorkspaceMessages {
            request_id,
            params: None,
        })
        .await
        .wrap_err("account/workspaceMessages/read failed in TUI")
}

pub(super) async fn send_add_credits_nudge_email(
    request_handle: AppServerRequestHandle,
    credit_type: AddCreditsNudgeCreditType,
) -> Result<codex_app_server_protocol::AddCreditsNudgeEmailStatus> {
    let request_id = RequestId::String(format!("add-credits-nudge-{}", Uuid::new_v4()));
    let response: codex_app_server_protocol::SendAddCreditsNudgeEmailResponse = request_handle
        .request_typed(ClientRequest::SendAddCreditsNudgeEmail {
            request_id,
            params: SendAddCreditsNudgeEmailParams { credit_type },
        })
        .await
        .wrap_err("account/sendAddCreditsNudgeEmail failed in TUI")?;

    Ok(response.status)
}

pub(super) async fn fetch_skills_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<SkillsListResponse> {
    let request_id = RequestId::String(format!("startup-skills-list-{}", Uuid::new_v4()));
    // Use the cloneable request handle so startup can issue this RPC from a background task without
    // extending a borrow of `AppServerSession` across the first frame render.
    request_handle
        .request_typed(ClientRequest::SkillsList {
            request_id,
            params: SkillsListParams {
                cwds: vec![cwd],
                force_reload: true,
            },
        })
        .await
        .wrap_err("skills/list failed in TUI")
}

pub(super) async fn fetch_connectors_list(
    request_handle: AppServerRequestHandle,
    force_refetch: bool,
    thread_id: Option<String>,
) -> Result<ConnectorsSnapshot> {
    let request_id = RequestId::String(format!("apps-list-{}", Uuid::new_v4()));
    let response: AppsListResponse = request_handle
        .request_typed(ClientRequest::AppsList {
            request_id,
            params: AppsListParams {
                cursor: None,
                limit: None,
                thread_id,
                force_refetch,
            },
        })
        .await
        .wrap_err("app/list failed in TUI")?;
    Ok(ConnectorsSnapshot {
        connectors: response.data.into_iter().map(app_info_from_api).collect(),
    })
}

pub(super) async fn fetch_plugins_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse> {
    let mut response = request_plugin_list(request_handle, cwd)
        .await
        .wrap_err("plugin/list failed while loading the plugins menu")?;
    hide_cli_only_plugin_marketplaces(&mut response);
    Ok(response)
}

pub(super) async fn fetch_additional_plugin_remote_sections(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    plugin_sharing_enabled: bool,
    remote_plugin_enabled: bool,
) -> (Vec<PluginMarketplaceEntry>, Vec<PluginRemoteSectionError>) {
    let mut marketplaces = Vec::new();
    let mut section_errors = Vec::new();
    let mut sections = Vec::new();
    if !remote_plugin_enabled {
        sections.push((
            "vertical",
            "OpenAI Curated",
            vec![PluginListMarketplaceKind::Vertical],
        ));
    }
    sections.push((
        "workspace",
        "Workspace",
        vec![PluginListMarketplaceKind::WorkspaceDirectory],
    ));
    if plugin_sharing_enabled {
        sections.push((
            "shared-with-me",
            "Shared with me",
            vec![PluginListMarketplaceKind::SharedWithMe],
        ));
    } else {
        section_errors.push(plugin_sharing_disabled_remote_section_error());
    }

    for (section_id, label, marketplace_kinds) in sections {
        match request_plugin_list_for_kinds(request_handle.clone(), cwd.clone(), marketplace_kinds)
            .await
        {
            Ok(mut response) => {
                hide_cli_only_plugin_marketplaces(&mut response);
                marketplaces.extend(response.marketplaces);
            }
            Err(err) => {
                let message = format!("{err:#}");
                section_errors.push(PluginRemoteSectionError {
                    section_id: section_id.to_string(),
                    label: label.to_string(),
                    message: plugin_remote_section_error_message(label, &message),
                });
            }
        }
    }

    (marketplaces, section_errors)
}

fn plugin_remote_section_error_message(label: &str, err: &str) -> String {
    let next_step = plugin_remote_section_error_next_step(label, err);
    if next_step.is_empty() {
        err.to_string()
    } else {
        format!("{err} {next_step}")
    }
}

fn plugin_remote_section_error_next_step(label: &str, err: &str) -> &'static str {
    let err = err.to_ascii_lowercase();
    if err.contains("api key auth is not supported") {
        "Sign in with ChatGPT auth; API key auth cannot load remote plugin catalogs."
    } else if err.contains("authentication required")
        || err.contains("not signed in")
        || err.contains("not logged in")
    {
        "Sign in to ChatGPT, then try loading this section again."
    } else if err.contains("codex plugins are disabled")
        || err.contains("plugin sharing is disabled")
        || err.contains("plugin sharing is not enabled")
        || err.contains("feature disabled")
    {
        "Ask a workspace admin to enable Elpis plugins or plugin sharing."
    } else if err.contains("workspace") && (err.contains("access") || err.contains("mismatch")) {
        "Switch to the matching workspace or ask the sharer for access."
    } else if err.contains("not found") || err.contains("status 404") {
        "Check that you are signed in to the correct workspace and still have access."
    } else if err.contains("old build") || err.contains("update codex") || err.contains("stale") {
        "Update Elpis, then try opening the shared plugin again."
    } else if err.contains("service unavailable")
        || err.contains("temporarily unavailable")
        || err.contains("status 503")
        || err.contains("failed to send")
        || err.contains("request")
        || err.contains("status")
    {
        "Try again later; local plugin functionality is still available."
    } else if err.contains("disabled by admin") || err.contains("admin disabled") {
        "Ask a workspace admin to confirm plugin access."
    } else if label == "Shared with me" && err.contains("plugin") && err.contains("disabled") {
        "Ask the sharer or a workspace admin to confirm plugin access."
    } else {
        ""
    }
}

fn plugin_sharing_disabled_remote_section_error() -> PluginRemoteSectionError {
    PluginRemoteSectionError {
        section_id: "shared-with-me".to_string(),
        label: "Shared with me".to_string(),
        message: "Plugin sharing is disabled for this Elpis session. Enable plugin sharing to load shared plugins.".to_string(),
    }
}

const CLI_HIDDEN_PLUGIN_MARKETPLACES: &[&str] = &["openai-bundled"];

pub(super) fn hide_cli_only_plugin_marketplaces(response: &mut PluginListResponse) {
    response
        .marketplaces
        .retain(|marketplace| !CLI_HIDDEN_PLUGIN_MARKETPLACES.contains(&marketplace.name.as_str()));
}

pub(super) async fn request_plugin_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<PluginListResponse> {
    request_plugin_list_with_marketplace_kinds(request_handle, cwd, /*marketplace_kinds*/ None)
        .await
}

pub(super) async fn request_plugin_list_for_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Vec<PluginListMarketplaceKind>,
) -> Result<PluginListResponse> {
    request_plugin_list_with_marketplace_kinds(request_handle, cwd, Some(marketplace_kinds)).await
}

async fn request_plugin_list_with_marketplace_kinds(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    marketplace_kinds: Option<Vec<PluginListMarketplaceKind>>,
) -> Result<PluginListResponse> {
    let cwd = AbsolutePathBuf::try_from(cwd).wrap_err("plugin list cwd must be absolute")?;
    let request_id = RequestId::String(format!("plugin-list-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::PluginList {
            request_id,
            params: PluginListParams {
                cwds: Some(vec![cwd]),
                marketplace_kinds,
            },
        })
        .await
        .wrap_err("plugin/list failed in TUI")
}

pub(super) async fn fetch_plugin_detail(
    request_handle: AppServerRequestHandle,
    params: PluginReadParams,
) -> Result<PluginReadResponse> {
    let request_id = RequestId::String(format!("plugin-read-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::PluginRead { request_id, params })
        .await
        .wrap_err("plugin/read failed in TUI")
}

pub(super) async fn fetch_marketplace_add(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
    source: String,
) -> Result<MarketplaceAddResponse> {
    let cwd = AbsolutePathBuf::try_from(cwd).wrap_err("marketplace/add cwd must be absolute")?;
    let source = marketplace_add_source_for_request(cwd.as_path(), source);
    let request_id = RequestId::String(format!("marketplace-add-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::MarketplaceAdd {
            request_id,
            params: MarketplaceAddParams {
                source,
                ref_name: None,
                sparse_paths: None,
            },
        })
        .await
        .wrap_err("marketplace/add failed in TUI")
}

fn marketplace_add_source_for_request(cwd: &std::path::Path, source: String) -> String {
    let (base_source, suffix) = if let Some((base, ref_name)) = source.rsplit_once('#') {
        (base, Some(format!("#{ref_name}")))
    } else if let Some((base, ref_name)) = source.rsplit_once('@') {
        (base, Some(format!("@{ref_name}")))
    } else {
        (source.as_str(), None)
    };

    if matches!(base_source, "." | "..")
        || base_source.starts_with("./")
        || base_source.starts_with("../")
        || base_source.starts_with(".\\")
        || base_source.starts_with("..\\")
    {
        let mut resolved = AbsolutePathBuf::resolve_path_against_base(base_source, cwd)
            .to_string_lossy()
            .into_owned();
        if let Some(suffix) = suffix {
            resolved.push_str(&suffix);
        }
        return resolved;
    }

    source
}

pub(super) async fn fetch_marketplace_remove(
    request_handle: AppServerRequestHandle,
    marketplace_name: String,
) -> Result<MarketplaceRemoveResponse> {
    let request_id = RequestId::String(format!("marketplace-remove-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::MarketplaceRemove {
            request_id,
            params: MarketplaceRemoveParams { marketplace_name },
        })
        .await
        .wrap_err("marketplace/remove failed in TUI")
}

pub(super) async fn fetch_marketplace_upgrade(
    request_handle: AppServerRequestHandle,
    marketplace_name: Option<String>,
) -> Result<MarketplaceUpgradeResponse> {
    let request_id = RequestId::String(format!("marketplace-upgrade-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::MarketplaceUpgrade {
            request_id,
            params: MarketplaceUpgradeParams { marketplace_name },
        })
        .await
        .wrap_err("marketplace/upgrade failed in TUI")
}
pub(super) async fn fetch_plugin_install(
    request_handle: AppServerRequestHandle,
    location: PluginLocation,
    plugin_name: String,
) -> Result<PluginInstallResponse> {
    let request_id = RequestId::String(format!("plugin-install-{}", Uuid::new_v4()));
    let (marketplace_path, remote_marketplace_name) = location.into_request_params();
    request_handle
        .request_typed(ClientRequest::PluginInstall {
            request_id,
            params: PluginInstallParams {
                marketplace_path,
                remote_marketplace_name,
                plugin_name,
            },
        })
        .await
        .wrap_err("plugin/install failed in TUI")
}

pub(super) async fn fetch_plugin_uninstall(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
) -> Result<PluginUninstallResponse> {
    let request_id = RequestId::String(format!("plugin-uninstall-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::PluginUninstall {
            request_id,
            params: PluginUninstallParams { plugin_id },
        })
        .await
        .wrap_err("plugin/uninstall failed in TUI")
}

pub(super) async fn write_plugin_enabled(
    request_handle: AppServerRequestHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<ConfigWriteResponse> {
    let request_id = RequestId::String(format!("plugin-enable-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::ConfigValueWrite {
            request_id,
            params: ConfigValueWriteParams {
                key_path: format!("plugins.{plugin_id}"),
                value: serde_json::json!({ "enabled": enabled }),
                merge_strategy: MergeStrategy::Upsert,
                file_path: None,
                expected_version: None,
            },
        })
        .await
        .wrap_err("config/value/write failed while updating plugin enablement in TUI")
}

pub(super) async fn write_hook_enabled(
    request_handle: AppServerRequestHandle,
    key: String,
    enabled: bool,
) -> Result<ConfigWriteResponse> {
    let request_id = RequestId::String(format!("hooks-config-write-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::ConfigBatchWrite {
            request_id,
            params: ConfigBatchWriteParams {
                edits: vec![codex_app_server_protocol::ConfigEdit {
                    key_path: "hooks.state".to_string(),
                    value: serde_json::json!({
                        key: {
                            "enabled": enabled,
                        }
                    }),
                    merge_strategy: MergeStrategy::Upsert,
                }],
                file_path: None,
                expected_version: None,
                reload_user_config: true,
            },
        })
        .await
        .wrap_err("config/batchWrite failed while updating hook enablement in TUI")
}

/// Convert flat `McpServerStatus` responses into the per-server maps used by the
/// in-process MCP subsystem (tools keyed as `mcp__{server}__{tool}`, plus
/// per-server resource/template/auth maps). Test-only because the TUI
/// renders directly from `McpServerStatus` rather than these maps.
#[cfg(test)]
pub(super) type McpInventoryMaps = (
    HashMap<String, codex_protocol::mcp::Tool>,
    HashMap<String, Vec<codex_protocol::mcp::Resource>>,
    HashMap<String, Vec<codex_protocol::mcp::ResourceTemplate>>,
    HashMap<String, McpAuthStatus>,
);

#[cfg(test)]
pub(super) fn mcp_inventory_maps_from_statuses(statuses: Vec<McpServerStatus>) -> McpInventoryMaps {
    let mut tools = HashMap::new();
    let mut resources = HashMap::new();
    let mut resource_templates = HashMap::new();
    let mut auth_statuses = HashMap::new();

    for status in statuses {
        let server_name = status.name;
        auth_statuses.insert(
            server_name.clone(),
            match status.auth_status {
                codex_app_server_protocol::McpAuthStatus::Unsupported => McpAuthStatus::Unsupported,
                codex_app_server_protocol::McpAuthStatus::NotLoggedIn => McpAuthStatus::NotLoggedIn,
                codex_app_server_protocol::McpAuthStatus::BearerToken => McpAuthStatus::BearerToken,
                codex_app_server_protocol::McpAuthStatus::OAuth => McpAuthStatus::OAuth,
            },
        );
        resources.insert(server_name.clone(), status.resources);
        resource_templates.insert(server_name.clone(), status.resource_templates);
        for (tool_name, tool) in status.tools {
            tools.insert(format!("mcp__{server_name}__{tool_name}"), tool);
        }
    }

    (tools, resources, resource_templates, auth_statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::test_support::make_test_app;
    use codex_app_server_protocol::PluginMarketplaceEntry;
    use codex_protocol::mcp::Tool;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use pretty_assertions::assert_eq;

    fn test_absolute_path(path: &str) -> AbsolutePathBuf {
        AbsolutePathBuf::try_from(PathBuf::from(path)).expect("absolute test path")
    }

    #[test]
    fn marketplace_add_source_for_request_resolves_relative_local_paths() {
        let cwd = if cfg!(windows) {
            PathBuf::from(r"C:\workspace\project")
        } else {
            PathBuf::from("/workspace/project")
        };

        let resolved = marketplace_add_source_for_request(&cwd, "./marketplace".to_string());
        assert!(std::path::Path::new(&resolved).is_absolute());
        assert_eq!(resolved, cwd.join("marketplace").display().to_string());
        assert_eq!(
            marketplace_add_source_for_request(&cwd, "./marketplace#main".to_string()),
            format!("{}#main", cwd.join("marketplace").display())
        );
        assert_eq!(
            marketplace_add_source_for_request(&cwd, "owner/repo".to_string()),
            "owner/repo"
        );
        assert_eq!(
            marketplace_add_source_for_request(&cwd, "~/marketplace".to_string()),
            "~/marketplace"
        );
    }

    #[test]
    fn hide_cli_only_plugin_marketplaces_removes_openai_bundled() {
        let mut response = PluginListResponse {
            marketplaces: vec![
                PluginMarketplaceEntry {
                    name: "openai-bundled".to_string(),
                    path: Some(test_absolute_path("/marketplaces/openai-bundled")),
                    interface: None,
                    plugins: Vec::new(),
                },
                PluginMarketplaceEntry {
                    name: "openai-curated".to_string(),
                    path: Some(test_absolute_path("/marketplaces/openai-curated")),
                    interface: None,
                    plugins: Vec::new(),
                },
            ],
            marketplace_load_errors: Vec::new(),
            featured_plugin_ids: Vec::new(),
        };

        hide_cli_only_plugin_marketplaces(&mut response);

        assert_eq!(
            response.marketplaces,
            vec![PluginMarketplaceEntry {
                name: "openai-curated".to_string(),
                path: Some(test_absolute_path("/marketplaces/openai-curated")),
                interface: None,
                plugins: Vec::new(),
            }]
        );
    }

    #[test]
    fn plugin_location_request_params_select_exactly_one_location() {
        let local_path = test_absolute_path("/marketplaces/local");

        assert_eq!(
            PluginLocation::Local {
                marketplace_path: local_path.clone()
            }
            .into_request_params(),
            (Some(local_path), None)
        );
        assert_eq!(
            PluginLocation::Remote {
                marketplace_name: "workspace-directory".to_string()
            }
            .into_request_params(),
            (None, Some("workspace-directory".to_string()))
        );
    }

    #[test]
    fn plugin_remote_section_error_message_adds_concrete_next_steps() {
        let cases = [
            (
                "Workspace",
                "chatgpt authentication required for remote plugin catalog",
                "Sign in to ChatGPT, then try loading this section again.",
            ),
            (
                "OpenAI Curated",
                "chatgpt authentication required for remote plugin catalog; api key auth is not supported",
                "Sign in with ChatGPT auth; API key auth cannot load remote plugin catalogs.",
            ),
            (
                "Shared with me",
                "remote plugin catalog request failed with status 404: missing",
                "Check that you are signed in to the correct workspace and still have access.",
            ),
            (
                "Shared with me",
                "workspace access mismatch",
                "Switch to the matching workspace or ask the sharer for access.",
            ),
            (
                "Shared with me",
                "old build fallback",
                "Update Elpis, then try opening the shared plugin again.",
            ),
            (
                "Shared with me",
                "remote service unavailable",
                "Try again later; local plugin functionality is still available.",
            ),
            (
                "Workspace",
                "plugin disabled by admin",
                "Ask a workspace admin to confirm plugin access.",
            ),
            (
                "Shared with me",
                "plugin sharing is not enabled",
                "Ask a workspace admin to enable Elpis plugins or plugin sharing.",
            ),
        ];

        for (label, err, next_step) in cases {
            assert_eq!(
                plugin_remote_section_error_message(label, err),
                format!("{err} {next_step}")
            );
        }
    }

    #[test]
    fn plugin_sharing_disabled_remote_section_error_targets_shared_with_me() {
        assert_eq!(
            plugin_sharing_disabled_remote_section_error(),
            PluginRemoteSectionError {
                section_id: "shared-with-me".to_string(),
                label: "Shared with me".to_string(),
                message: "Plugin sharing is disabled for this Elpis session. Enable plugin sharing to load shared plugins.".to_string(),
            }
        );
    }

    #[test]
    fn mcp_inventory_maps_prefix_tool_names_by_server() {
        let statuses = vec![
            McpServerStatus {
                name: "docs".to_string(),
                server_info: None,
                tools: HashMap::from([(
                    "list".to_string(),
                    Tool {
                        description: None,
                        name: "list".to_string(),
                        title: None,
                        input_schema: serde_json::json!({"type": "object"}),
                        output_schema: None,
                        annotations: None,
                        icons: None,
                        meta: None,
                    },
                )]),
                resources: Vec::new(),
                resource_templates: Vec::new(),
                auth_status: codex_app_server_protocol::McpAuthStatus::Unsupported,
            },
            McpServerStatus {
                name: "disabled".to_string(),
                server_info: None,
                tools: HashMap::new(),
                resources: Vec::new(),
                resource_templates: Vec::new(),
                auth_status: codex_app_server_protocol::McpAuthStatus::Unsupported,
            },
        ];

        let (tools, resources, resource_templates, auth_statuses) =
            mcp_inventory_maps_from_statuses(statuses);
        let mut resource_names = resources.keys().cloned().collect::<Vec<_>>();
        resource_names.sort();
        let mut template_names = resource_templates.keys().cloned().collect::<Vec<_>>();
        template_names.sort();

        assert_eq!(
            tools.keys().cloned().collect::<Vec<_>>(),
            vec!["mcp__docs__list".to_string()]
        );
        assert_eq!(resource_names, vec!["disabled", "docs"]);
        assert_eq!(template_names, vec!["disabled", "docs"]);
        assert_eq!(
            auth_statuses.get("disabled"),
            Some(&McpAuthStatus::Unsupported)
        );
    }

    #[tokio::test]
    async fn mcp_inventory_omits_thread_id_for_closed_agent_thread() {
        let mut app = make_test_app().await;
        let thread_id = ThreadId::new();
        app.active_thread_id = Some(thread_id);
        app.agent_navigation.upsert(
            thread_id, /*agent_nickname*/ None, /*agent_role*/ None,
            /*is_closed*/ false,
        );

        assert_eq!(
            app.mcp_inventory_request_thread_id(Some(thread_id)),
            Some(thread_id)
        );

        app.agent_navigation.mark_closed(thread_id);

        assert_eq!(app.mcp_inventory_request_thread_id(Some(thread_id)), None);
    }
}

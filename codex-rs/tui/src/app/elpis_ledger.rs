//! Elpis: the App side of the Context Ledger — loading its sources and writing Manual Memory
//! and admission changes on blocking workers, and the `/context` report.
//!
//! Copied from v0.3.0 `app.rs` (the coordinator types), `app/background_requests.rs` (loader
//! and workers) and `app/event_dispatch.rs` (the event arms). Stage 1 leaves out what needs
//! the Elpis context engine: the dashboard, holding a submission until an admission write
//! lands, and refreshing after the agent saves a memory.

use super::*;
use crate::chatwidget::elpis_memory_dir;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_ledger_events::ManualMemoryMutation;
use crate::elpis_ledger_events::ManualMemoryMutationCompletion;
use crate::elpis_ledger_events::ManualMemoryMutationFailure;
use crate::elpis_ledger_events::ManualMemoryRequestTarget;
use crate::elpis_ledger_events::ManualMemoryStatusCompletion;
use crate::elpis_ledger_events::ManualMemoryStorageTarget;
use crate::elpis_ledger_events::ManualMemoryUnavailableReason;
use crate::elpis_ledger_events::ManualMemoryViewKey;

#[derive(Debug, Default)]
pub(crate) struct ManualMemoryStatusCoordinator {
    epoch: u64,
    in_flight: Option<ManualMemoryRequestTarget>,
    mutations: HashMap<ManualMemoryStorageTarget, ManualMemoryOwnedMutation>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManualMemoryMutationStage {
    Running,
    AwaitingStatus(ManualMemoryMutationCompletion),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManualMemoryOwnedMutation {
    origin: ManualMemoryRequestTarget,
    mutation: ManualMemoryMutation,
    stage: ManualMemoryMutationStage,
    allow_same_view_autosend: bool,
}

impl ManualMemoryOwnedMutation {
    fn running(origin: ManualMemoryRequestTarget, mutation: ManualMemoryMutation) -> Self {
        Self {
            origin,
            mutation,
            stage: ManualMemoryMutationStage::Running,
            allow_same_view_autosend: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ManualMemoryCompletionDisposition {
    Ignored,
    Detached,
    Refresh(ManualMemoryRequestTarget),
}

/// A pager keymap whose close binding starts with Escape.
///
/// The configured default closes on `q`/`Ctrl+C` only, so a report shown without
/// this would leave Escape to prime backtrack when idle or interrupt a running turn.
fn escape_first_pager_keymap(pager: &crate::keymap::PagerKeymap) -> crate::keymap::PagerKeymap {
    let mut keymap = pager.clone();
    let escape = crate::key_hint::plain(KeyCode::Esc);
    keymap.close.retain(|binding| binding != &escape);
    keymap.close.insert(0, escape);
    keymap
}

fn manual_memory_same_view_ignoring_epoch(
    left: &ManualMemoryViewKey,
    right: &ManualMemoryViewKey,
) -> bool {
    left.primary_root_thread_id == right.primary_root_thread_id
        && left.displayed_thread_id == right.displayed_thread_id
        && left.cwd == right.cwd
        && left.memory_path == right.memory_path
}

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
                Some(elpis_memory_dir(config).as_path()),
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

    pub(super) fn pending_manual_memory_mutation_for(
        &self,
        storage: &ManualMemoryStorageTarget,
    ) -> Option<ManualMemoryMutation> {
        self.manual_memory_status
            .mutations
            .get(storage)
            .map(|owner| owner.mutation)
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
        self.launch_manual_memory_status(target)
    }

    pub(super) fn launch_manual_memory_status(
        &mut self,
        target: ManualMemoryRequestTarget,
    ) -> bool {
        if self.manual_memory_status.in_flight.as_ref() == Some(&target) {
            return false;
        }
        let superseded_storage = self
            .manual_memory_status
            .in_flight
            .as_ref()
            .filter(|previous| previous.storage != target.storage)
            .map(|previous| previous.storage.clone())
            .filter(|storage| {
                self.manual_memory_status
                    .mutations
                    .get(storage)
                    .is_some_and(|owner| {
                        matches!(owner.stage, ManualMemoryMutationStage::AwaitingStatus(_))
                    })
            });
        if let Some(storage) = superseded_storage {
            self.manual_memory_status.mutations.remove(&storage);
        }
        self.manual_memory_status.in_flight = Some(target.clone());

        let instruction_source_paths = self.chat_widget.instruction_source_paths_as_path_bufs();
        // Elpis: list the development-rule roots the model's request reads.
        let dev_rule_roots = codex_config::dev_rule_roots_from_stack(
            &self.chat_widget.config_ref().config_layer_stack,
        );
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
            app_event_tx.send(AppEvent::Elpis(ElpisAppEvent::ManualMemoryStatusLoaded(
                target, completion,
            )));
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
            app_event_tx.send(AppEvent::Elpis(ElpisAppEvent::ManualMemoryCreateFinished(
                target, completion,
            )));
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
            app_event_tx.send(AppEvent::Elpis(
                ElpisAppEvent::ManualMemoryAdmissionFinished(target, admitted, completion),
            ));
        });
    }

    pub(super) fn begin_manual_memory_refresh(
        &mut self,
        origin: &ManualMemoryRequestTarget,
    ) -> bool {
        if self.chat_widget.manual_memory_bound_target() != Some(origin)
            || !self.chat_widget.manual_memory_refresh_requested()
        {
            return false;
        }
        let pending_context_report = self.chat_widget.manual_memory_context_report_pending();
        let Some(target) = self.next_manual_memory_target() else {
            return false;
        };
        let pending_mutation = self.pending_manual_memory_mutation_for(&target.storage);
        self.chat_widget.bind_manual_memory_loading(
            target.clone(),
            pending_context_report,
            pending_mutation,
        );
        self.launch_manual_memory_status(target);
        true
    }

    pub(super) fn claim_manual_memory_mutation(
        &mut self,
        origin: &ManualMemoryRequestTarget,
        mutation: ManualMemoryMutation,
    ) -> bool {
        if self.chat_widget.manual_memory_bound_target() != Some(origin)
            || self.chat_widget.manual_memory_pending_mutation() != Some(mutation)
            || self
                .manual_memory_status
                .mutations
                .contains_key(&origin.storage)
        {
            return false;
        }
        let pending_context_report = self.chat_widget.manual_memory_context_report_pending();
        let Some(target) = self.next_manual_memory_target() else {
            self.chat_widget.clear_manual_memory_pending_mutation();
            return false;
        };
        self.manual_memory_status.in_flight = None;
        self.manual_memory_status.mutations.insert(
            origin.storage.clone(),
            ManualMemoryOwnedMutation::running(origin.clone(), mutation),
        );
        self.chat_widget
            .bind_manual_memory_loading(target, pending_context_report, Some(mutation));
        true
    }

    pub(super) fn record_manual_memory_mutation_completion(
        &mut self,
        origin: &ManualMemoryRequestTarget,
        mutation: ManualMemoryMutation,
        completion: ManualMemoryMutationCompletion,
    ) -> ManualMemoryCompletionDisposition {
        let Some(owner) = self.manual_memory_status.mutations.get_mut(&origin.storage) else {
            return ManualMemoryCompletionDisposition::Ignored;
        };
        if owner.origin != *origin
            || owner.mutation != mutation
            || owner.stage != ManualMemoryMutationStage::Running
        {
            return ManualMemoryCompletionDisposition::Ignored;
        }
        owner.stage = ManualMemoryMutationStage::AwaitingStatus(completion);

        let current_storage = self
            .current_manual_memory_target(self.manual_memory_status.epoch)
            .map(|target| target.storage);
        if current_storage.as_ref() != Some(&origin.storage) {
            self.manual_memory_status.mutations.remove(&origin.storage);
            return ManualMemoryCompletionDisposition::Detached;
        }

        let pending_context_report = self.chat_widget.manual_memory_context_report_pending();
        let Some(target) = self.next_manual_memory_target() else {
            if matches!(mutation, ManualMemoryMutation::Admission { .. }) {
                self.chat_widget
                    .restore_admission_blocked_input_to_composer();
            }
            self.chat_widget.clear_manual_memory_pending_mutation();
            self.manual_memory_status.mutations.remove(&origin.storage);
            return ManualMemoryCompletionDisposition::Detached;
        };
        self.manual_memory_status.in_flight = None;
        self.chat_widget.bind_manual_memory_loading(
            target.clone(),
            pending_context_report,
            Some(mutation),
        );
        ManualMemoryCompletionDisposition::Refresh(target)
    }

    pub(super) fn finish_manual_memory_status(
        &mut self,
        target: &ManualMemoryRequestTarget,
        completion: ManualMemoryStatusCompletion,
    ) -> Option<bool> {
        if self.manual_memory_status.in_flight.as_ref() != Some(target) {
            return None;
        }
        let owned_mutation = self
            .manual_memory_status
            .mutations
            .get(&target.storage)
            .cloned();
        if owned_mutation
            .as_ref()
            .is_some_and(|owner| owner.stage == ManualMemoryMutationStage::Running)
        {
            self.manual_memory_status.in_flight = None;
            return None;
        }
        let status_confirms_admission = match (&completion, owned_mutation.as_ref()) {
            (
                ManualMemoryStatusCompletion::Ready { status, .. },
                Some(ManualMemoryOwnedMutation {
                    mutation: ManualMemoryMutation::Admission { admitted },
                    ..
                }),
            ) => match status.state {
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Admitted => {
                    *admitted
                }
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted => {
                    !*admitted
                }
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing => false,
            },
            _ => false,
        };
        if !self
            .chat_widget
            .apply_manual_memory_status_completion(target, completion)
        {
            return None;
        }
        self.manual_memory_status.in_flight = None;
        if let Some(owner) = owned_mutation
            && let ManualMemoryMutationStage::AwaitingStatus(mutation_completion) = owner.stage
        {
            self.manual_memory_status.mutations.remove(&target.storage);
            match owner.mutation {
                ManualMemoryMutation::Create => {
                    self.chat_widget.clear_manual_memory_pending_mutation();
                }
                ManualMemoryMutation::Admission { .. } => {
                    let same_view =
                        manual_memory_same_view_ignoring_epoch(&owner.origin.view, &target.view);
                    let may_send = mutation_completion == ManualMemoryMutationCompletion::Succeeded
                        && status_confirms_admission
                        && owner.allow_same_view_autosend
                        && same_view;
                    if !may_send {
                        self.chat_widget
                            .restore_admission_blocked_input_to_composer();
                    }
                    self.chat_widget.clear_manual_memory_pending_mutation();
                }
            }
        }
        Some(self.chat_widget.take_pending_context_report())
    }

    /// Open a report as a static pager that Escape dismisses.
    ///
    /// The pager's default close keys are `q`/`Ctrl+C`, so Escape is prepended;
    /// without an overlay to consume it, Escape would instead prime backtrack
    /// when idle or interrupt the turn mid-stream.
    pub(super) fn open_escape_closable_pager(
        &mut self,
        tui: &mut tui::Tui,
        cell: Box<dyn HistoryCell>,
        title: &str,
    ) -> Result<()> {
        tui.enter_alt_screen()?;
        self.reset_backtrack_state();
        self.overlay = Some(Overlay::new_static_with_renderables(
            vec![Box::new(cell)],
            title.to_string(),
            escape_first_pager_keymap(&self.keymap.pager),
        ));
        tui.frame_requester().schedule_frame();
        Ok(())
    }

    fn present_manual_memory_mutation_completion(
        &mut self,
        mutation: ManualMemoryMutation,
        completion: ManualMemoryMutationCompletion,
    ) {
        match completion {
            ManualMemoryMutationCompletion::Succeeded => {
                let message = match mutation {
                    ManualMemoryMutation::Create => "Manual Memory created.",
                    ManualMemoryMutation::Admission { admitted: true } => {
                        "Manual Memory will be included on the next turn."
                    }
                    ManualMemoryMutation::Admission { admitted: false } => {
                        "Manual Memory will be excluded on the next turn."
                    }
                };
                self.chat_widget.add_info_message(message.to_string(), None);
            }
            ManualMemoryMutationCompletion::Failed(reason) => {
                let message = match reason {
                    ManualMemoryMutationFailure::AlreadyExists => {
                        "Manual Memory already exists; its status was refreshed."
                    }
                    ManualMemoryMutationFailure::Missing => {
                        "Manual Memory does not exist; create it before including it."
                    }
                    ManualMemoryMutationFailure::StorageUnavailable => {
                        "Manual Memory storage is unavailable."
                    }
                    ManualMemoryMutationFailure::PersistenceFailed => {
                        "Manual Memory could not be saved; its status was refreshed."
                    }
                    ManualMemoryMutationFailure::WorkerFailed => {
                        "The Manual Memory worker failed; its status was refreshed."
                    }
                };
                self.chat_widget.add_error_message(message.to_string());
            }
        }
    }

    /// Mirrors the agent threads into the ledger's SUBAGENTS list, each with its latest activity.
    pub(super) fn sync_agent_ledger(&mut self) {
        let entries = self
            .agent_navigation
            .ordered_threads()
            .into_iter()
            .filter(|(id, _)| Some(*id) != self.primary_thread_id)
            .map(
                |(id, entry)| crate::chatwidget::agent_ledger::AgentLedgerEntry {
                    activity: self.agent_latest_activity(id),
                    task: entry
                        .agent_path
                        .clone()
                        .or_else(|| entry.agent_nickname.clone())
                        .unwrap_or_else(|| id.to_string()),
                    status: if entry.is_closed {
                        "Closed"
                    } else if entry.is_running {
                        "Running"
                    } else if !self.thread_event_channels.contains_key(&id) {
                        "History"
                    } else {
                        "Idle"
                    },
                },
            )
            .collect();
        self.chat_widget.set_agent_ledger(entries);
    }

    /// The agent's newest buffered activity (command, message, tool call), if its event store is
    /// free right now; a busy store is skipped and the next sync fills it in.
    fn agent_latest_activity(&self, thread_id: ThreadId) -> Option<String> {
        let channel = self.thread_event_channels.get(&thread_id)?;
        let store = channel.store.try_lock().ok()?;
        super::agent_status_feed::AgentStatusThreadPreview::from_store(String::new(), &store)
            .latest_activity()
    }

    /// Handles the Context Ledger's `ElpisAppEvent`s.
    pub(super) fn handle_elpis_ledger_event(
        &mut self,
        tui: &mut tui::Tui,
        event: ElpisAppEvent,
    ) -> Result<()> {
        match event {
            ElpisAppEvent::RequestContextUsageReport(origin)
            | ElpisAppEvent::ManualMemoryStatusRefreshRequested(origin) => {
                if self.begin_manual_memory_refresh(&origin) {
                    tui.frame_requester().schedule_frame();
                }
            }
            ElpisAppEvent::ManualMemoryStatusLoaded(target, completion) => {
                if self.finish_manual_memory_status(&target, completion) == Some(true) {
                    let totals =
                        crate::elpis_ledger_events::context_usage_totals(&self.transcript_cells);
                    // Only an explicit `/context` reaches this branch, so show it the
                    // way `/usage` does: a pager Escape dismisses, instead of transcript
                    // content that leaves Escape to prime backtrack or interrupt a turn.
                    // The report arrives asynchronously, so never displace a live overlay.
                    if self.overlay.is_none() {
                        let cell = self.chat_widget.context_usage_cell(totals);
                        self.open_escape_closable_pager(tui, cell, "Context")?;
                    } else {
                        self.chat_widget.add_context_usage_output(totals);
                    }
                }
                tui.frame_requester().schedule_frame();
            }
            ElpisAppEvent::ManualMemoryCreateRequested(target) => {
                if self.claim_manual_memory_mutation(&target, ManualMemoryMutation::Create) {
                    self.launch_manual_memory_create(target);
                }
                tui.frame_requester().schedule_frame();
            }
            ElpisAppEvent::ManualMemoryCreateFinished(target, completion) => {
                let disposition = self.record_manual_memory_mutation_completion(
                    &target,
                    ManualMemoryMutation::Create,
                    completion,
                );
                if let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition {
                    self.present_manual_memory_mutation_completion(
                        ManualMemoryMutation::Create,
                        completion,
                    );
                    self.launch_manual_memory_status(fresh);
                }
                tui.frame_requester().schedule_frame();
            }
            ElpisAppEvent::ManualMemoryAdmissionRequested(target, admitted) => {
                let mutation = ManualMemoryMutation::Admission { admitted };
                if self.claim_manual_memory_mutation(&target, mutation) {
                    self.launch_manual_memory_admission(target, admitted);
                }
                tui.frame_requester().schedule_frame();
            }
            ElpisAppEvent::ManualMemoryAdmissionFinished(target, admitted, completion) => {
                let mutation = ManualMemoryMutation::Admission { admitted };
                let disposition =
                    self.record_manual_memory_mutation_completion(&target, mutation, completion);
                if let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition {
                    self.present_manual_memory_mutation_completion(mutation, completion);
                    self.launch_manual_memory_status(fresh);
                }
                tui.frame_requester().schedule_frame();
            }
            ElpisAppEvent::EnableYolo
            | ElpisAppEvent::Provider(_)
            | ElpisAppEvent::SaveBackgroundModel(_)
            | ElpisAppEvent::OpenDashboard
            | ElpisAppEvent::WorkGraphLoaded(_)
            | ElpisAppEvent::RefreshDashboard
            | ElpisAppEvent::OpenUsage(_) => {
                unreachable!("handled in app/elpis_events.rs")
            }
        }
        Ok(())
    }
}

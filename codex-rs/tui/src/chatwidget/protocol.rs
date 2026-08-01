// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;

impl ChatWidget {
    pub(crate) fn handle_server_notification(
        &mut self,
        notification: ServerNotification,
        replay_kind: Option<ReplayKind>,
    ) {
        // Reject misrouted child updates before shared notification handling mutates parent state.
        if let ServerNotification::McpServerStatusUpdated(notification) = &notification
            && let (Some(notification_thread_id), Some(thread_id)) =
                (notification.thread_id.as_deref(), self.thread_id())
            && notification_thread_id != thread_id.to_string()
        {
            return;
        }

        let thread_id = self.thread_id().map(|id| id.to_string());
        let provider_name = if self.config.model_provider_id.trim().is_empty() {
            let name = self.config.model_provider.name.trim();
            if name.is_empty() {
                "configured".to_string()
            } else {
                name.to_string()
            }
        } else {
            self.config.model_provider_id.clone()
        };
        let custom_openai_base =
            self.config
                .model_provider
                .base_url
                .as_deref()
                .is_some_and(|base_url| {
                    let normalized = base_url.trim().trim_end_matches('/');
                    !normalized.is_empty() && normalized != DEFAULT_OPENAI_BASE_URL
                });
        let provider_route = crate::branding::ProviderRoute::for_provider(
            &self.config.model_provider_id,
            &self.config.model_provider.name,
            self.config.model_provider.wire_api,
            custom_openai_base,
        );
        let current_model = self.current_model().to_string();
        if crate::branding::sync_runtime_identity(
            thread_id.as_deref(),
            &provider_name,
            provider_route,
            &current_model,
            self.config.features.enabled(Feature::MemoryTool),
        ) {
            self.refresh_status_line();
        }

        let from_replay = replay_kind.is_some();
        let is_resume_initial_replay =
            matches!(replay_kind, Some(ReplayKind::ResumeInitialMessages));
        if is_resume_initial_replay && crate::branding::mark_resume_announced() {
            let evidence = thread_id
                .as_deref()
                .map_or_else(|| "thread:pending".to_string(), |id| format!("thread:{id}"));
            self.add_info_message(
                "Continuity restored after resume.".to_string(),
                Some(format!(
                    "Provider {provider_name} · model {current_model} · evidence {evidence}"
                )),
            );
            self.refresh_status_line();
        }

        let is_retry_error = matches!(
            &notification,
            ServerNotification::Error(ErrorNotification {
                will_retry: true,
                ..
            })
        );
        if !is_resume_initial_replay && !is_retry_error {
            self.restore_retry_status_header_if_present();
        }
        match notification {
            ServerNotification::ThreadTokenUsageUpdated(notification) => {
                self.update_context_prune_savings(
                    notification.token_usage.context_prune_saved_tokens,
                    from_replay,
                );
                crate::branding::record_context_usage(
                    notification.token_usage.last.total_tokens,
                    notification.token_usage.model_context_window,
                );
                self.set_token_info(Some(token_usage_info_from_app_server(
                    notification.token_usage,
                )));
                self.refresh_status_line();
            }
            ServerNotification::ThreadNameUpdated(notification) => {
                match ThreadId::from_string(&notification.thread_id) {
                    Ok(thread_id) => {
                        self.on_thread_name_updated(thread_id, notification.thread_name)
                    }
                    Err(err) => {
                        tracing::warn!(
                            thread_id = notification.thread_id,
                            error = %err,
                            "ignoring app-server ThreadNameUpdated with invalid thread_id"
                        );
                    }
                }
            }
            ServerNotification::ThreadGoalUpdated(notification) => {
                self.on_thread_goal_updated(notification.goal, notification.turn_id);
            }
            ServerNotification::ThreadGoalCleared(notification) => {
                self.on_thread_goal_cleared(notification.thread_id.as_str());
            }
            ServerNotification::ThreadSettingsUpdated(notification) => {
                let previous_provider = self.config.model_provider_id.clone();
                let next_provider = notification.thread_settings.model_provider.clone();
                let next_model = notification.thread_settings.model.clone();
                let evidence = format!("thread:{}", notification.thread_id);
                self.on_thread_settings_updated(notification);
                if previous_provider != next_provider {
                    crate::branding::record_provider_switch(&next_provider, &next_model);
                    self.add_info_message(
                        "Continuity preserved across provider switch.".to_string(),
                        Some(format!(
                            "{previous_provider} → {next_provider} · model {next_model} · evidence {evidence}"
                        )),
                    );
                    self.refresh_status_line();
                }
            }
            ServerNotification::TurnStarted(notification) => {
                self.turn_lifecycle.last_turn_id = Some(notification.turn.id);
                self.last_non_retry_error = None;
                if !matches!(replay_kind, Some(ReplayKind::ResumeInitialMessages)) {
                    self.on_task_started();
                }
            }
            ServerNotification::TurnCompleted(notification) => {
                self.handle_turn_completed_notification(notification, replay_kind);
            }
            ServerNotification::ItemStarted(notification) => {
                self.handle_item_started_notification(notification, replay_kind.is_some());
            }
            ServerNotification::ItemCompleted(notification) => {
                self.handle_item_completed_notification(notification, replay_kind);
            }
            ServerNotification::AgentMessageDelta(notification) => {
                self.on_agent_message_delta(notification.delta);
            }
            ServerNotification::PlanDelta(notification) => self.on_plan_delta(notification.delta),
            ServerNotification::ReasoningSummaryTextDelta(notification) => {
                self.on_agent_reasoning_delta(notification.delta);
            }
            ServerNotification::ReasoningTextDelta(notification) => {
                if self.config.show_raw_agent_reasoning {
                    self.on_agent_reasoning_delta(notification.delta);
                }
            }
            ServerNotification::ReasoningSummaryPartAdded(_) => self.on_reasoning_section_break(),
            ServerNotification::TerminalInteraction(notification) => {
                self.on_terminal_interaction(notification.process_id, notification.stdin)
            }
            ServerNotification::CommandExecutionOutputDelta(notification) => {
                self.on_exec_command_output_delta(&notification.item_id, &notification.delta);
            }
            ServerNotification::FileChangeOutputDelta(notification) => {
                self.on_patch_apply_output_delta(notification.item_id, notification.delta);
            }
            ServerNotification::TurnDiffUpdated(notification) => {
                self.on_turn_diff(notification.diff)
            }
            ServerNotification::TurnPlanUpdated(notification) => {
                self.on_plan_update(UpdatePlanArgs {
                    explanation: notification.explanation,
                    plan: notification
                        .plan
                        .into_iter()
                        .map(|step| UpdatePlanItemArg {
                            step: step.step,
                            status: match step.status {
                                TurnPlanStepStatus::Pending => UpdatePlanItemStatus::Pending,
                                TurnPlanStepStatus::InProgress => UpdatePlanItemStatus::InProgress,
                                TurnPlanStepStatus::Completed => UpdatePlanItemStatus::Completed,
                            },
                        })
                        .collect(),
                })
            }
            ServerNotification::HookStarted(notification) => {
                self.on_hook_started(notification.run);
            }
            ServerNotification::HookCompleted(notification) => {
                self.on_hook_completed(notification.run);
            }
            ServerNotification::Error(notification) => {
                if notification.will_retry {
                    if !from_replay {
                        self.on_stream_error(
                            notification.error.message,
                            notification.error.additional_details,
                        );
                    }
                } else {
                    self.last_non_retry_error = Some((
                        notification.turn_id.clone(),
                        notification.error.message.clone(),
                    ));
                    self.handle_non_retry_error(
                        notification.error.message,
                        notification.error.codex_error_info,
                    );
                }
            }
            ServerNotification::SkillsChanged(_) => {
                self.refresh_skills_for_current_cwd(/*force_reload*/ true);
            }
            ServerNotification::ModelRerouted(notification) => {
                if notification.reason
                    == codex_app_server_protocol::ModelRerouteReason::AutoModelRouting
                {
                    // Auto model routing is silent — keeps user UI displaying 'auto' without showing internal luna details
                } else {
                    crate::branding::record_model_reroute(
                        &notification.from_model,
                        &notification.to_model,
                    );
                    self.add_info_message(
                        "Continuity preserved after model reroute.".to_string(),
                        Some(format!(
                            "{} → {} · reason {:?} · evidence thread:{}/turn:{}",
                            notification.from_model,
                            notification.to_model,
                            notification.reason,
                            notification.thread_id,
                            notification.turn_id
                        )),
                    );
                }
                self.refresh_status_line();
            }
            ServerNotification::ModelVerification(notification) => {
                self.on_app_server_model_verification(&notification.verifications)
            }
            ServerNotification::ModelSafetyBufferingUpdated(notification) => {
                self.on_model_safety_buffering_updated(notification, replay_kind)
            }
            ServerNotification::Warning(notification) => self.on_warning(notification.message),
            ServerNotification::GuardianWarning(notification) => {
                self.on_warning(notification.message)
            }
            ServerNotification::DeprecationNotice(notification) => {
                self.on_deprecation_notice(notification.summary, notification.details)
            }
            ServerNotification::ConfigWarning(notification) => self.on_warning(
                notification
                    .details
                    .map(|details| format!("{}: {details}", notification.summary))
                    .unwrap_or(notification.summary),
            ),
            ServerNotification::McpServerStatusUpdated(notification) => {
                self.on_mcp_server_status_updated(notification)
            }
            ServerNotification::ItemGuardianApprovalReviewStarted(notification) => {
                self.on_guardian_review_notification(
                    notification.review_id,
                    notification.turn_id,
                    notification.started_at_ms,
                    notification.review,
                    /*completion*/ None,
                    notification.action,
                );
            }
            ServerNotification::ItemGuardianApprovalReviewCompleted(notification) => {
                self.on_guardian_review_notification(
                    notification.review_id,
                    notification.turn_id,
                    notification.started_at_ms,
                    notification.review,
                    Some((notification.completed_at_ms, notification.decision_source)),
                    notification.action,
                );
            }
            ServerNotification::ThreadClosed(_) => {
                if !from_replay {
                    self.on_shutdown_complete();
                }
            }
            ServerNotification::ServerRequestResolved(_)
            | ServerNotification::AccountUpdated(_)
            | ServerNotification::AccountRateLimitsUpdated(_)
            | ServerNotification::ThreadStarted(_)
            | ServerNotification::ThreadStatusChanged(_)
            | ServerNotification::ThreadArchived(_)
            | ServerNotification::ThreadDeleted(_)
            | ServerNotification::ThreadUnarchived(_)
            | ServerNotification::RawResponseItemCompleted(_)
            | ServerNotification::RawResponseCompleted(_)
            | ServerNotification::CommandExecOutputDelta(_)
            | ServerNotification::ProcessOutputDelta(_)
            | ServerNotification::ProcessExited(_)
            | ServerNotification::FileChangePatchUpdated(_)
            | ServerNotification::McpToolCallProgress(_)
            | ServerNotification::McpServerOauthLoginCompleted(_)
            | ServerNotification::AppListUpdated(_)
            | ServerNotification::EnvironmentConnected(_)
            | ServerNotification::EnvironmentDisconnected(_)
            | ServerNotification::RemoteControlStatusChanged(_)
            | ServerNotification::ExternalAgentConfigImportProgress(_)
            | ServerNotification::ExternalAgentConfigImportCompleted(_)
            | ServerNotification::FsChanged(_)
            | ServerNotification::TurnModerationMetadata(_)
            | ServerNotification::FuzzyFileSearchSessionUpdated(_)
            | ServerNotification::FuzzyFileSearchSessionCompleted(_)
            | ServerNotification::ThreadRealtimeStarted(_)
            | ServerNotification::ThreadRealtimeItemAdded(_)
            | ServerNotification::ThreadRealtimeOutputAudioDelta(_)
            | ServerNotification::ThreadRealtimeError(_)
            | ServerNotification::ThreadRealtimeClosed(_)
            | ServerNotification::ThreadRealtimeSdp(_)
            | ServerNotification::ThreadRealtimeTranscriptDelta(_)
            | ServerNotification::ThreadRealtimeTranscriptDone(_)
            | ServerNotification::WindowsWorldWritableWarning(_)
            | ServerNotification::WindowsSandboxSetupCompleted(_)
            | ServerNotification::AccountLoginCompleted(_) => {}
            ServerNotification::ContextCompacted(notification) => {
                let notice = crate::branding::record_compaction(
                    &notification.thread_id,
                    &notification.turn_id,
                );
                if from_replay {
                    if crate::branding::mark_snapshot_restore_announced() {
                        self.add_info_message(
                            "Compacted context restored.".to_string(),
                            Some(format!(
                                "{} · evidence {} · eviction count {}",
                                notice.reason, notice.evidence, notice.count
                            )),
                        );
                    }
                } else {
                    self.add_warning_message(format!(
                        "Elpis evicted context: {}. Evidence: {}. Eviction count: {}. \
                         Survived: goal, checkpoint, and admitted rules (see /usage).",
                        notice.reason, notice.evidence, notice.count
                    ));
                }
                self.refresh_status_line();
            }
        }
    }

    pub(super) fn handle_turn_completed_notification(
        &mut self,
        notification: TurnCompletedNotification,
        replay_kind: Option<ReplayKind>,
    ) {
        // User-message dedupe only suppresses the app-server echo of a prompt
        // this TUI already rendered locally. Once that turn ends, another
        // client can submit the same text and it still needs its own user cell.
        self.last_rendered_user_message_display = None;
        match notification.turn.status {
            TurnStatus::Completed => {
                self.last_non_retry_error = None;
                self.on_task_complete(
                    /*last_agent_message*/ None,
                    notification.turn.duration_ms,
                    replay_kind.is_some(),
                )
            }
            TurnStatus::Interrupted => {
                self.last_non_retry_error = None;
                let reason = if self
                    .turn_lifecycle
                    .take_budget_limited(notification.turn.id.as_str())
                {
                    TurnAbortReason::BudgetLimited
                } else {
                    TurnAbortReason::Interrupted
                };
                self.on_interrupted_turn(reason);
            }
            TurnStatus::Failed => {
                if let Some(error) = notification.turn.error {
                    if self.last_non_retry_error.as_ref()
                        == Some(&(notification.turn.id.clone(), error.message.clone()))
                    {
                        self.last_non_retry_error = None;
                    } else {
                        self.handle_non_retry_error(error.message, error.codex_error_info);
                    }
                } else {
                    self.last_non_retry_error = None;
                    self.finalize_turn();
                    self.request_redraw();
                    self.maybe_send_next_queued_input();
                }
            }
            TurnStatus::InProgress => {}
        }
    }

    fn handle_item_started_notification(
        &mut self,
        notification: ItemStartedNotification,
        from_replay: bool,
    ) {
        match notification.item {
            item @ ThreadItem::CommandExecution { .. } => self.on_command_execution_started(item),
            ThreadItem::FileChange { id: _, changes, .. } => {
                self.on_patch_apply_begin(file_update_changes_to_display(changes));
            }
            item @ ThreadItem::McpToolCall { .. } => self.on_mcp_tool_call_started(item),
            ThreadItem::WebSearch(item) => {
                self.on_web_search_begin(item.id);
            }
            ThreadItem::ImageGeneration(_) => {
                self.on_image_generation_begin();
            }
            ThreadItem::CollabAgentToolCall {
                id,
                tool,
                status,
                sender_thread_id,
                receiver_thread_ids,
                prompt,
                model,
                reasoning_effort,
                agents_states,
            } => self.on_collab_agent_tool_call(ThreadItem::CollabAgentToolCall {
                id,
                tool,
                status,
                sender_thread_id,
                receiver_thread_ids,
                prompt,
                model,
                reasoning_effort,
                agents_states,
            }),
            item @ ThreadItem::SubAgentActivity { .. } => self.on_sub_agent_activity(item),
            ThreadItem::EnteredReviewMode { review, .. } if !from_replay => {
                self.enter_review_mode_with_hint(review, /*from_replay*/ false);
            }
            _ => {}
        }
    }

    fn handle_item_completed_notification(
        &mut self,
        notification: ItemCompletedNotification,
        replay_kind: Option<ReplayKind>,
    ) {
        if let ThreadItem::AgentMessage {
            memory_citation: Some(citation),
            ..
        } = &notification.item
            && !citation.entries.is_empty()
        {
            crate::branding::record_memory_citation(citation.entries.len());
            self.refresh_status_line();
        }
        self.handle_thread_item(
            notification.item,
            notification.turn_id,
            replay_kind.map_or(ThreadItemRenderSource::Live, ThreadItemRenderSource::Replay),
        );
    }
}

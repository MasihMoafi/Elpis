// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn semantic_token_snapshot_changes_request_dashboard_refresh_once() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let info = make_token_info(120, 1_000);

    chat.set_token_info(Some(info.clone()));
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    chat.set_token_info(Some(info.clone()));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    chat.set_token_info(None);
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    chat.set_token_info(None);
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    chat.set_token_info(Some(info));
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    chat.clear_token_usage();
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    chat.clear_token_usage();
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
}

fn dashboard_token_usage_notification(
    chat: &ChatWidget,
    saved_tokens: u64,
    smart_prune_enabled: bool,
) -> ServerNotification {
    let usage = || codex_app_server_protocol::TokenUsageBreakdown {
        total_tokens: 120,
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_tokens: None,
        output_tokens: 20,
        reasoning_output_tokens: 0,
    };
    let mut smart_prune = codex_app_server_protocol::ThreadSmartPruneSnapshot::default();
    smart_prune.enabled = smart_prune_enabled;
    ServerNotification::ThreadTokenUsageUpdated(
        codex_app_server_protocol::ThreadTokenUsageUpdatedNotification {
            thread_id: chat
                .thread_id()
                .map(|thread_id| thread_id.to_string())
                .unwrap_or_default(),
            turn_id: "turn-1".to_string(),
            token_usage: codex_app_server_protocol::ThreadTokenUsage {
                total: usage(),
                last: usage(),
                model_context_window: Some(1_000),
                context_prune_saved_tokens: saved_tokens,
                smart_prune,
            },
        },
    )
}

#[tokio::test]
async fn token_savings_and_smart_prune_changes_each_refresh_exactly_once() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    for notification in [
        dashboard_token_usage_notification(&chat, 10, false),
        dashboard_token_usage_notification(&chat, 20, false),
        dashboard_token_usage_notification(&chat, 20, true),
    ] {
        chat.handle_server_notification(notification, /*replay_kind*/ None);
        assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
        assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
    }

    chat.handle_server_notification(
        dashboard_token_usage_notification(&chat, 20, true),
        /*replay_kind*/ None,
    );
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn only_effective_smart_prune_configuration_changes_refresh_dashboard() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    assert!(!chat.set_feature_enabled(Feature::AutomaticContextPruning, false));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    assert!(chat.set_feature_enabled(Feature::AutomaticContextPruning, true));
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));

    assert!(chat.set_feature_enabled(Feature::AutomaticContextPruning, true));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    assert!(!chat.set_feature_enabled(Feature::AutomaticContextPruning, false));
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
}

#[tokio::test]
async fn only_semantic_core_smart_prune_snapshots_refresh_dashboard() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    let notification = |smart_prune| {
        ServerNotification::ThreadSmartPruneUpdated(
            codex_app_server_protocol::ThreadSmartPruneUpdatedNotification {
                thread_id: thread_id.to_string(),
                smart_prune,
            },
        )
    };

    let initial = codex_app_server_protocol::ThreadSmartPruneSnapshot::default();
    chat.handle_server_notification(notification(initial.clone()), /*replay_kind*/ None);
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    chat.handle_server_notification(notification(initial), /*replay_kind*/ None);
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));

    let mut changed = codex_app_server_protocol::ThreadSmartPruneSnapshot::default();
    changed.enabled = true;
    chat.handle_server_notification(notification(changed), /*replay_kind*/ None);
    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
}

const SAFETY_BUFFERING_HEADER_TEXT: &str =
    "Our systems are thinking a bit more about this request before responding.";

fn thread_settings_for_test(
    model: &str,
    thread_id: ThreadId,
) -> codex_app_server_protocol::ThreadSettingsUpdatedNotification {
    codex_app_server_protocol::ThreadSettingsUpdatedNotification {
        thread_id: thread_id.to_string(),
        thread_settings: codex_app_server_protocol::ThreadSettings {
            cwd: test_path_buf("/tmp/thread-settings").abs(),
            approval_policy: AskForApproval::OnRequest,
            approvals_reviewer: codex_app_server_protocol::ApprovalsReviewer::AutoReview,
            sandbox_policy: codex_app_server_protocol::SandboxPolicy::ReadOnly {
                network_access: false,
            },
            active_permission_profile: Some(
                codex_app_server_protocol::ActivePermissionProfile::read_only(),
            ),
            model: model.to_string(),
            model_provider: "openai".to_string(),
            service_tier: Some(ServiceTier::Fast.request_value().to_string()),
            effort: Some(ReasoningEffortConfig::High),
            summary: None,
            collaboration_mode: CollaborationMode {
                mode: ModeKind::Plan,
                settings: codex_protocol::config_types::Settings {
                    model: model.to_string(),
                    reasoning_effort: Some(ReasoningEffortConfig::High),
                    developer_instructions: None,
                },
            },
            multi_agent_mode: Default::default(),
            personality: Some(Personality::Pragmatic),
        },
    }
}

fn configured_thread_session(thread_id: ThreadId) -> crate::session_state::ThreadSessionState {
    crate::session_state::ThreadSessionState {
        thread_id,
        forked_from_id: None,
        fork_parent_title: None,
        thread_name: None,
        model: "gpt-5.2".to_string(),
        model_provider_id: "openai".to_string(),
        service_tier: None,
        approval_policy: AskForApproval::Never,
        approvals_reviewer: ApprovalsReviewer::User,
        permission_profile: PermissionProfile::read_only(),
        active_permission_profile: None,
        cwd: test_path_buf("/tmp/thread-settings").abs(),
        runtime_workspace_roots: vec![test_path_buf("/tmp/thread-settings").abs()],
        instruction_source_paths: Vec::new(),
        reasoning_effort: None,
        collaboration_mode: None,
        personality: None,
        message_history: None,
        network_proxy: None,
        rollout_path: None,
    }
}

#[tokio::test]
async fn thread_switch_clears_thread_scoped_dashboard_usage() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let first_thread_id = ThreadId::new();
    chat.handle_thread_session(configured_thread_session(first_thread_id));
    let _ = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();

    chat.set_token_info(Some(make_token_info(120, 1_000)));
    assert!(chat.update_context_prune_savings(40, /*from_replay*/ true));
    let _ = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();

    chat.handle_thread_session(configured_thread_session(first_thread_id));
    assert!(chat.token_info.is_some());
    assert_eq!(chat.last_prune_saved_tokens, Some(40));
    let _ = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();

    chat.handle_thread_session(configured_thread_session(ThreadId::new()));

    assert!(chat.token_info.is_none());
    assert_eq!(chat.bottom_pane.context_window_used_tokens(), None);
    assert_eq!(chat.last_prune_saved_tokens, None);
    assert_eq!(chat.last_prune_saved_tokens.unwrap_or(0), 0);
    assert_eq!(
        std::iter::from_fn(|| rx.try_recv().ok())
            .filter(|event| matches!(event, AppEvent::RefreshContextDashboard))
            .count(),
        1
    );
}

fn start_safety_buffering_test_turn(
    chat: &mut ChatWidget,
    op_rx: &mut tokio::sync::mpsc::UnboundedReceiver<Op>,
) -> (ThreadId, &'static str, Op) {
    let thread_id = ThreadId::new();
    let turn_id = "turn-safety-buffering";
    chat.thread_id = Some(thread_id);
    chat.submit_user_message(UserMessage::from("Explain the request"));
    let turn = next_submit_op(op_rx);
    assert_matches!(&turn, Op::UserTurn { .. });
    chat.record_safety_buffering_turn(turn_id.to_string(), &turn);
    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: thread_id.to_string(),
            turn: AppServerTurn {
                id: turn_id.to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    (thread_id, turn_id, turn)
}

fn safety_buffering_notification(
    thread_id: ThreadId,
    turn_id: &str,
    faster_model: Option<&str>,
) -> ModelSafetyBufferingUpdatedNotification {
    ModelSafetyBufferingUpdatedNotification {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        model: "current-model".to_string(),
        use_cases: Vec::new(),
        reasons: Vec::new(),
        show_buffering_ui: true,
        faster_model: faster_model.map(str::to_string),
    }
}

#[tokio::test]
async fn safety_buffering_offers_one_retry_with_app_wording() {
    let (mut chat, mut rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let (thread_id, turn_id, _) = start_safety_buffering_test_turn(&mut chat, &mut op_rx);

    let notification = safety_buffering_notification(thread_id, turn_id, Some("faster-model"));
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(notification.clone()),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(notification),
        /*replay_kind*/ None,
    );

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("safety_buffering_retry_prompt", popup);

    chat.handle_key_event(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    chat.handle_key_event(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let opened_url = loop {
        match rx.try_recv() {
            Ok(AppEvent::OpenUrlInBrowser { url }) => break url,
            Ok(_) => continue,
            Err(err) => panic!("expected learn-more URL event: {err}"),
        }
    };
    assert_eq!(opened_url, "https://help.openai.com/en/articles/20001326");
    assert!(render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));

    chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let (event_thread_id, event_turn_id, model, turn, prompt) = loop {
        match rx.try_recv() {
            Ok(AppEvent::RetrySafetyBufferedTurn {
                thread_id,
                turn_id,
                model,
                turn,
                prompt,
            }) => break (thread_id, turn_id, model, turn, prompt),
            Ok(_) => continue,
            Err(err) => panic!("expected safety-buffering retry event: {err}"),
        }
    };
    assert_eq!(event_thread_id, thread_id);
    assert_eq!(event_turn_id, turn_id);
    assert_eq!(model, "faster-model");
    assert_matches!(turn, Op::UserTurn { .. });
    assert_eq!(prompt, UserMessage::from("Explain the request"));
    assert!(
        !render_bottom_popup(&chat, /*width*/ 80)
            .contains("Press enter to confirm or esc to go back")
    );
}

#[tokio::test]
async fn safety_buffering_does_not_offer_retry_in_side_conversation() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.set_side_conversation_active(/*active*/ true);
    let (thread_id, turn_id, _) = start_safety_buffering_test_turn(&mut chat, &mut op_rx);

    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(safety_buffering_notification(
            thread_id,
            turn_id,
            Some("faster-model"),
        )),
        /*replay_kind*/ None,
    );

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("safety_buffering_side_conversation_without_retry", popup);
}

#[tokio::test]
async fn safety_buffering_remains_visible_until_turn_completes() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let (thread_id, turn_id, _) = start_safety_buffering_test_turn(&mut chat, &mut op_rx);
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(safety_buffering_notification(
            thread_id,
            turn_id,
            Some("faster-model"),
        )),
        /*replay_kind*/ None,
    );
    assert!(chat.can_retry_safety_buffered_turn(turn_id));

    chat.on_agent_message_delta("Visible response".to_string());

    assert!(!chat.can_retry_safety_buffered_turn(turn_id));
    assert!(render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));

    handle_turn_completed(&mut chat, turn_id, /*duration_ms*/ None);

    assert!(!render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));
}

#[tokio::test]
async fn safety_buffering_without_retry_shows_short_app_message() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let (thread_id, turn_id, turn) = start_safety_buffering_test_turn(&mut chat, &mut op_rx);

    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(safety_buffering_notification(
            thread_id, turn_id, /*faster_model*/ None,
        )),
        /*replay_kind*/ None,
    );

    let render_popup = |chat: &ChatWidget| {
        normalize_snapshot_paths(render_bottom_popup(chat, /*width*/ 80))
    };
    let popup = render_popup(&chat);
    assert_chatwidget_snapshot!("safety_buffering_status_without_retry", popup,);

    let notification = safety_buffering_notification(thread_id, turn_id, Some("faster-model"));
    chat.record_safety_buffering_turn("other-turn".to_string(), &turn);
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(notification.clone()),
        /*replay_kind*/ None,
    );
    assert_eq!(render_popup(&chat), popup);

    chat.record_safety_buffering_turn(turn_id.to_string(), &turn);
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(notification),
        Some(ReplayKind::ThreadSnapshot),
    );
    assert_eq!(render_popup(&chat), popup);

    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert!(
        !render_bottom_popup(&chat, /*width*/ 80)
            .contains("Press enter to confirm or esc to go back")
    );
}

#[tokio::test]
async fn safety_buffering_ignores_hidden_stale_and_historical_updates() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let (thread_id, turn_id, _) = start_safety_buffering_test_turn(&mut chat, &mut op_rx);

    let mut hidden = safety_buffering_notification(thread_id, turn_id, Some("faster-model"));
    hidden.show_buffering_ui = false;
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(hidden),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(safety_buffering_notification(
            thread_id,
            "stale-turn",
            Some("faster-model"),
        )),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(safety_buffering_notification(
            thread_id,
            turn_id,
            Some("faster-model"),
        )),
        Some(ReplayKind::ResumeInitialMessages),
    );
    assert!(!render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));

    let mut hidden = safety_buffering_notification(thread_id, turn_id, Some("faster-model"));
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(hidden.clone()),
        /*replay_kind*/ None,
    );
    assert!(render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));
    hidden.show_buffering_ui = false;
    chat.handle_server_notification(
        ServerNotification::ModelSafetyBufferingUpdated(hidden),
        /*replay_kind*/ None,
    );

    assert_eq!(
        chat.bottom_pane
            .status_widget()
            .expect("status indicator should be visible")
            .details(),
        None
    );
    assert!(!render_bottom_popup(&chat, /*width*/ 80).contains(SAFETY_BUFFERING_HEADER_TEXT));
}

#[tokio::test]
async fn invalid_url_elicitation_is_declined() {
    let (mut chat, _app_event_tx, mut rx, _op_rx) = make_chatwidget_manual_with_sender().await;
    let visible_thread_id = ThreadId::new();
    let request_thread_id = ThreadId::new();
    chat.thread_id = Some(visible_thread_id);

    chat.handle_elicitation_request_now(
        codex_app_server_protocol::RequestId::Integer(9),
        codex_app_server_protocol::McpServerElicitationRequestParams {
            thread_id: request_thread_id.to_string(),
            turn_id: Some("turn-auth".to_string()),
            server_name: "payments".to_string(),
            request: codex_app_server_protocol::McpServerElicitationRequest::Url {
                meta: None,
                message: "Review the payment details to continue.".to_string(),
                url: "http://payments.example/checkout/123".to_string(),
                elicitation_id: "payment-123".to_string(),
            },
        },
    );

    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::SubmitThreadOp {
            thread_id: op_thread_id,
            op: Op::ResolveElicitation {
                server_name,
                request_id: codex_app_server_protocol::RequestId::Integer(9),
                decision: codex_app_server_protocol::McpServerElicitationAction::Decline,
                content: None,
                meta: None,
            },
        }) if op_thread_id == request_thread_id && server_name == "payments"
    );
}

#[tokio::test]
async fn thread_settings_updated_updates_visible_state_without_transcript() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.2")).await;
    set_fast_mode_test_catalog(&mut chat);
    let thread_id = ThreadId::new();
    chat.handle_thread_session(configured_thread_session(thread_id));
    let _ = drain_insert_history(&mut rx);

    chat.handle_server_notification(
        ServerNotification::ThreadSettingsUpdated(thread_settings_for_test("gpt-5.4", thread_id)),
        /*replay_kind*/ None,
    );

    assert_eq!(chat.current_model(), "gpt-5.4");
    assert_eq!(
        chat.current_reasoning_effort(),
        Some(ReasoningEffortConfig::High)
    );
    assert_eq!(
        chat.current_service_tier(),
        Some(ServiceTier::Fast.request_value())
    );
    assert_eq!(
        chat.config_ref().permissions.approval_policy.value(),
        AskForApproval::OnRequest.to_core()
    );
    assert_eq!(
        chat.config_ref().approvals_reviewer,
        ApprovalsReviewer::AutoReview
    );
    assert_eq!(
        chat.config_ref()
            .permissions
            .active_permission_profile()
            .expect("active profile")
            .id,
        codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_READ_ONLY
    );
    assert_eq!(chat.config_ref().personality, Some(Personality::Pragmatic));
    assert_eq!(chat.active_collaboration_mode_kind(), ModeKind::Plan);
    assert!(
        drain_insert_history(&mut rx).is_empty(),
        "ThreadSettingsUpdated should not render transcript history"
    );

    chat.handle_server_notification(
        ServerNotification::ThreadSettingsUpdated(thread_settings_for_test(
            "gpt-5.2",
            ThreadId::new(),
        )),
        /*replay_kind*/ None,
    );

    assert_eq!(chat.current_model(), "gpt-5.4");
}

#[tokio::test]
async fn thread_settings_updated_preserves_default_settings_for_plan_mode() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.2")).await;
    let thread_id = ThreadId::new();
    let mut session = configured_thread_session(thread_id);
    session.model = "gpt-default".to_string();
    session.reasoning_effort = Some(ReasoningEffortConfig::Low);
    chat.handle_thread_session(session);
    let _ = drain_insert_history(&mut rx);
    let default_mode = chat.current_collaboration_mode().clone();

    chat.handle_server_notification(
        ServerNotification::ThreadSettingsUpdated(thread_settings_for_test("gpt-plan", thread_id)),
        /*replay_kind*/ None,
    );

    assert_eq!(chat.active_collaboration_mode_kind(), ModeKind::Plan);
    assert_eq!(chat.current_model(), "gpt-plan");
    assert_eq!(
        chat.current_reasoning_effort(),
        Some(ReasoningEffortConfig::High)
    );
    assert_eq!(chat.current_collaboration_mode(), &default_mode);

    let default_mask = collaboration_modes::default_mask(chat.model_catalog.as_ref())
        .expect("expected default collaboration mode");
    chat.set_collaboration_mask(default_mask);

    assert_eq!(chat.active_collaboration_mode_kind(), ModeKind::Default);
    assert_eq!(chat.current_model(), "gpt-default");
    assert_eq!(
        chat.current_reasoning_effort(),
        Some(ReasoningEffortConfig::Low)
    );
}

#[tokio::test]
async fn collab_spawn_end_shows_requested_model_and_effort() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    let sender_thread_id = ThreadId::new();
    let spawned_thread_id = ThreadId::new();
    chat.set_collab_agent_metadata(
        spawned_thread_id,
        Some("Robie".to_string()),
        Some("explorer".to_string()),
    );

    chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            started_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "call-spawn".to_string(),
                tool: AppServerCollabAgentTool::SpawnAgent,
                status: AppServerCollabAgentToolCallStatus::InProgress,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: Vec::new(),
                prompt: Some("Explore the repo".to_string()),
                model: Some("gpt-5".to_string()),
                reasoning_effort: Some(ReasoningEffortConfig::High),
                agents_states: HashMap::new(),
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "call-spawn".to_string(),
                tool: AppServerCollabAgentTool::SpawnAgent,
                status: AppServerCollabAgentToolCallStatus::Completed,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: vec![spawned_thread_id.to_string()],
                prompt: Some("Explore the repo".to_string()),
                model: None,
                reasoning_effort: None,
                agents_states: HashMap::from([(
                    spawned_thread_id.to_string(),
                    AppServerCollabAgentState {
                        status: AppServerCollabAgentStatus::PendingInit,
                        message: None,
                    },
                )]),
            },
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    let rendered = cells
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        rendered.contains("Spawned Robie [explorer] (gpt-5 high)"),
        "expected spawn line to include agent metadata and requested model, got {rendered:?}"
    );
}

#[tokio::test]
async fn live_app_server_user_message_item_completed_does_not_duplicate_rendered_prompt() {
    let (mut chat, mut rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());

    chat.bottom_pane
        .set_composer_text("Hi, are you there?".to_string(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    match next_submit_op(&mut op_rx) {
        Op::UserTurn { .. } => {}
        other => panic!("expected Op::UserTurn, got {other:?}"),
    }

    let inserted = drain_insert_history(&mut rx);
    assert_eq!(inserted.len(), 1);
    assert!(lines_to_single_string(&inserted[0]).contains("Hi, are you there?"));

    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::UserMessage {
                id: "user-1".to_string(),
                client_id: None,
                content: vec![AppServerUserInput::Text {
                    text: "Hi, are you there?".to_string(),
                    text_elements: Vec::new(),
                }],
            },
        }),
        /*replay_kind*/ None,
    );

    assert!(drain_insert_history(&mut rx).is_empty());
}

#[tokio::test]
async fn live_app_server_turn_completed_clears_working_status_after_answer_item() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );

    assert!(chat.bottom_pane.is_task_running());
    let status = chat
        .bottom_pane
        .status_widget()
        .expect("status indicator should be visible");
    assert_eq!(status.header(), "elpising…");

    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::AgentMessage {
                id: "msg-1".to_string(),
                text: "Yes. What do you need?".to_string(),
                phase: Some(MessagePhase::FinalAnswer),
            },
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1);
    assert!(lines_to_single_string(&cells[0]).contains("Yes. What do you need?"));
    assert!(chat.bottom_pane.is_task_running());

    chat.handle_server_notification(
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::Completed,
                error: None,
                started_at: None,
                completed_at: Some(0),
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );

    assert!(!chat.bottom_pane.is_task_running());
    assert!(chat.bottom_pane.status_widget().is_none());
}

#[tokio::test]
async fn live_app_server_warning_notification_renders_message() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::Warning(WarningNotification {
            thread_id: None,
            message: "Exceeded skills context budget of 2%. All skill descriptions were removed and 2 additional skills were not included in the model-visible skills list.".to_string(),
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1, "expected one warning history cell");
    let rendered = lines_to_single_string(&cells[0]);
    let normalized = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        normalized.contains("Exceeded skills context budget of 2%."),
        "expected warning notification message, got {rendered}"
    );
    assert!(
        normalized.contains(
            "All skill descriptions were removed and 2 additional skills were not included in the model-visible skills list."
        ),
        "expected warning guidance, got {rendered}"
    );
}

#[tokio::test]
async fn live_auto_model_reroute_names_the_selected_model() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::ModelRerouted(codex_app_server_protocol::ModelReroutedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            from_model: "auto".to_string(),
            to_model: "gpt-5.6-sol".to_string(),
            reason: codex_app_server_protocol::ModelRerouteReason::AutoModelRouting,
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1, "expected one Auto routing history cell");
    let rendered = lines_to_single_string(&cells[0]);
    assert!(
        rendered.contains("Auto routed this turn to gpt-5.6-sol."),
        "expected visible Auto routed choice, got {rendered}"
    );
}

#[tokio::test]
async fn live_app_server_guardian_warning_notification_renders_message() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::GuardianWarning(GuardianWarningNotification {
            thread_id: "thread-1".to_string(),
            message: "Automatic approval review denied the requested action.".to_string(),
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1, "expected one warning history cell");
    let rendered = lines_to_single_string(&cells[0]);
    assert!(
        rendered.contains("Automatic approval review denied the requested action."),
        "expected guardian warning notification message, got {rendered}"
    );
}

#[tokio::test]
async fn live_app_server_config_warning_prefixes_summary() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::ConfigWarning(ConfigWarningNotification {
            summary: "Invalid configuration; using defaults.".to_string(),
            details: None,
            path: None,
            range: None,
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1, "expected one warning history cell");
    let rendered = lines_to_single_string(&cells[0]);
    assert!(
        rendered.contains("Invalid configuration; using defaults."),
        "expected config warning summary, got {rendered}"
    );
}

#[tokio::test]
async fn live_app_server_file_change_item_started_preserves_changes() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            started_at_ms: 0,
            item: AppServerThreadItem::FileChange {
                id: "patch-1".to_string(),
                changes: vec![FileUpdateChange {
                    path: "foo.txt".to_string(),
                    kind: PatchChangeKind::Add,
                    diff: "hello\n".to_string(),
                }],
                status: AppServerPatchApplyStatus::InProgress,
            },
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert!(!cells.is_empty(), "expected patch history to be rendered");
    let transcript = lines_to_single_string(cells.last().expect("patch cell"));
    assert!(
        transcript.contains("Added foo.txt") || transcript.contains("Edited foo.txt"),
        "expected patch summary to include foo.txt, got: {transcript}"
    );
}

#[tokio::test]
async fn live_app_server_command_execution_strips_shell_wrapper() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let script = r#"python3 -c 'print("Hello, world!")'"#;
    let command =
        shlex::try_join(["/bin/zsh", "-lc", script]).expect("round-trippable shell wrapper");

    chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            started_at_ms: 0,
            item: AppServerThreadItem::CommandExecution {
                id: "cmd-1".to_string(),
                command: command.clone(),
                cwd: test_path_buf("/tmp").abs().into(),
                process_id: None,
                source: AppServerCommandExecutionSource::UserShell,
                status: AppServerCommandExecutionStatus::InProgress,
                command_actions: vec![AppServerCommandAction::Unknown {
                    command: script.to_string(),
                }],
                aggregated_output: None,
                exit_code: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::CommandExecution {
                id: "cmd-1".to_string(),
                command,
                cwd: test_path_buf("/tmp").abs().into(),
                process_id: None,
                source: AppServerCommandExecutionSource::UserShell,
                status: AppServerCommandExecutionStatus::Completed,
                command_actions: vec![AppServerCommandAction::Unknown {
                    command: script.to_string(),
                }],
                aggregated_output: Some("Hello, world!\n".to_string()),
                exit_code: Some(0),
                duration_ms: Some(5),
            },
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(
        cells.len(),
        1,
        "expected one completed command history cell"
    );
    let blob = lines_to_single_string(cells.first().expect("command cell"));
    assert_chatwidget_snapshot!(
        "live_app_server_command_execution_strips_shell_wrapper",
        blob
    );
}

#[tokio::test]
async fn live_app_server_collab_wait_items_render_history() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let sender_thread_id =
        ThreadId::from_string("019cff70-2599-75e2-af72-b90000000001").expect("valid thread id");
    let receiver_thread_id =
        ThreadId::from_string("019cff70-2599-75e2-af72-b958ce5dc1cc").expect("valid thread id");
    let other_receiver_thread_id =
        ThreadId::from_string("019cff70-2599-75e2-af72-b96db334332d").expect("valid thread id");
    chat.set_collab_agent_metadata(
        receiver_thread_id,
        Some("Robie".to_string()),
        Some("explorer".to_string()),
    );
    chat.set_collab_agent_metadata(
        other_receiver_thread_id,
        Some("Ada".to_string()),
        Some("reviewer".to_string()),
    );

    chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            started_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "wait-1".to_string(),
                tool: AppServerCollabAgentTool::Wait,
                status: AppServerCollabAgentToolCallStatus::InProgress,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: vec![
                    receiver_thread_id.to_string(),
                    other_receiver_thread_id.to_string(),
                ],
                prompt: None,
                model: None,
                reasoning_effort: None,
                agents_states: HashMap::new(),
            },
        }),
        /*replay_kind*/ None,
    );

    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "wait-1".to_string(),
                tool: AppServerCollabAgentTool::Wait,
                status: AppServerCollabAgentToolCallStatus::Completed,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: vec![
                    receiver_thread_id.to_string(),
                    other_receiver_thread_id.to_string(),
                ],
                prompt: None,
                model: None,
                reasoning_effort: None,
                agents_states: HashMap::from([
                    (
                        receiver_thread_id.to_string(),
                        AppServerCollabAgentState {
                            status: AppServerCollabAgentStatus::Completed,
                            message: Some("Done".to_string()),
                        },
                    ),
                    (
                        other_receiver_thread_id.to_string(),
                        AppServerCollabAgentState {
                            status: AppServerCollabAgentStatus::Running,
                            message: None,
                        },
                    ),
                ]),
            },
        }),
        /*replay_kind*/ None,
    );

    let combined = drain_insert_history(&mut rx)
        .into_iter()
        .map(|lines| lines_to_single_string(&lines))
        .collect::<Vec<_>>()
        .join("\n");
    assert_chatwidget_snapshot!("app_server_collab_wait_items_render_history", combined);
}

#[tokio::test]
async fn live_app_server_collab_spawn_completed_renders_requested_model_and_effort() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let sender_thread_id =
        ThreadId::from_string("019cff70-2599-75e2-af72-b90000000002").expect("valid thread id");
    let spawned_thread_id =
        ThreadId::from_string("019cff70-2599-75e2-af72-b91781b41a8e").expect("valid thread id");

    chat.handle_server_notification(
        ServerNotification::ItemStarted(ItemStartedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            started_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "spawn-1".to_string(),
                tool: AppServerCollabAgentTool::SpawnAgent,
                status: AppServerCollabAgentToolCallStatus::InProgress,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: Vec::new(),
                prompt: Some("Explore the repo".to_string()),
                model: Some("gpt-5".to_string()),
                reasoning_effort: Some(ReasoningEffortConfig::High),
                agents_states: HashMap::new(),
            },
        }),
        /*replay_kind*/ None,
    );

    chat.handle_server_notification(
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 0,
            item: AppServerThreadItem::CollabAgentToolCall {
                id: "spawn-1".to_string(),
                tool: AppServerCollabAgentTool::SpawnAgent,
                status: AppServerCollabAgentToolCallStatus::Completed,
                sender_thread_id: sender_thread_id.to_string(),
                receiver_thread_ids: vec![spawned_thread_id.to_string()],
                prompt: Some("Explore the repo".to_string()),
                model: Some("gpt-5".to_string()),
                reasoning_effort: Some(ReasoningEffortConfig::High),
                agents_states: HashMap::from([(
                    spawned_thread_id.to_string(),
                    AppServerCollabAgentState {
                        status: AppServerCollabAgentStatus::PendingInit,
                        message: None,
                    },
                )]),
            },
        }),
        /*replay_kind*/ None,
    );

    let combined = drain_insert_history(&mut rx)
        .into_iter()
        .map(|lines| lines_to_single_string(&lines))
        .collect::<Vec<_>>()
        .join("\n");
    assert_chatwidget_snapshot!(
        "app_server_collab_spawn_completed_renders_requested_model_and_effort",
        combined
    );
}

#[tokio::test]
async fn live_app_server_failed_turn_does_not_duplicate_error_history() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );

    chat.handle_server_notification(
        ServerNotification::Error(ErrorNotification {
            error: AppServerTurnError {
                message: "permission denied".to_string(),
                codex_error_info: None,
                additional_details: None,
            },
            will_retry: false,
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
        }),
        /*replay_kind*/ None,
    );

    let first_cells = drain_insert_history(&mut rx);
    assert_eq!(first_cells.len(), 1);
    assert!(lines_to_single_string(&first_cells[0]).contains("permission denied"));

    chat.handle_server_notification(
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::Failed,
                error: Some(AppServerTurnError {
                    message: "permission denied".to_string(),
                    codex_error_info: None,
                    additional_details: None,
                }),
                started_at: None,
                completed_at: Some(0),
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );

    assert!(drain_insert_history(&mut rx).is_empty());
    assert!(!chat.bottom_pane.is_task_running());
}

#[tokio::test]
async fn live_app_server_failed_turn_consolidates_streamed_answer() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    handle_turn_started(&mut chat, "turn-1");
    while rx.try_recv().is_ok() {}

    handle_agent_message_delta(&mut chat, "```diff\n+ streamed patch\n```\n");
    chat.run_commit_tick();
    while rx.try_recv().is_ok() {}

    handle_error(
        &mut chat,
        "stream disconnected before completion",
        /*codex_error_info*/ None,
    );

    let mut saw_consolidate = false;
    while let Ok(event) = rx.try_recv() {
        if let AppEvent::ConsolidateAgentMessage { source, .. } = event {
            saw_consolidate = true;
            assert!(
                source.contains("streamed patch"),
                "expected partial stream source to be consolidated, got {source:?}"
            );
        }
    }

    assert!(
        saw_consolidate,
        "failed turn should consolidate streamed cells before clearing the stream controller"
    );
}

#[tokio::test]
async fn live_app_server_stream_recovery_restores_previous_status_header() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    drain_insert_history(&mut rx);

    chat.handle_server_notification(
        ServerNotification::Error(ErrorNotification {
            error: AppServerTurnError {
                message: "Reconnecting... 1/5".to_string(),
                codex_error_info: Some(CodexErrorInfo::Other),
                additional_details: None,
            },
            will_retry: true,
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
        }),
        /*replay_kind*/ None,
    );
    drain_insert_history(&mut rx);

    chat.handle_server_notification(
        ServerNotification::AgentMessageDelta(
            codex_app_server_protocol::AgentMessageDeltaNotification {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "item-1".to_string(),
                delta: "hello".to_string(),
            },
        ),
        /*replay_kind*/ None,
    );

    let status = chat
        .bottom_pane
        .status_widget()
        .expect("status indicator should be visible");
    assert_eq!(status.header(), "elpising…");
    assert_eq!(status.details(), None);
    assert!(chat.status_state.retry_status_header.is_none());
}

#[tokio::test]
async fn live_app_server_server_overloaded_error_renders_warning() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    drain_insert_history(&mut rx);

    chat.handle_server_notification(
        ServerNotification::Error(ErrorNotification {
            error: AppServerTurnError {
                message: "server overloaded".to_string(),
                codex_error_info: Some(CodexErrorInfo::ServerOverloaded),
                additional_details: None,
            },
            will_retry: false,
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1);
    assert_eq!(lines_to_single_string(&cells[0]), "⚠ server overloaded\n");
    assert!(!chat.bottom_pane.is_task_running());
}

#[tokio::test]
async fn live_app_server_cyber_policy_error_renders_dedicated_notice() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(0),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    drain_insert_history(&mut rx);

    chat.handle_server_notification(
        ServerNotification::Error(ErrorNotification {
            error: AppServerTurnError {
                message: "server fallback message".to_string(),
                codex_error_info: Some(CodexErrorInfo::CyberPolicy),
                additional_details: None,
            },
            will_retry: false,
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1);
    let rendered = lines_to_single_string(&cells[0]);
    assert!(rendered.contains("This content can't be shown"));
    assert!(rendered.contains("extra caution with cybersecurity requests"));
    assert!(!rendered.contains("server fallback message"));
    assert!(!chat.bottom_pane.is_task_running());
}

#[tokio::test]
async fn app_server_safety_access_errors_render_dedicated_notice() {
    let legacy_message = "Invalid prompt: we've limited access to this content for safety reasons.";
    let bio_policy_message = "This content was flagged for possible biological risk.";
    let cases = [
        ("legacy plain message", legacy_message.to_string()),
        (
            "legacy JSON message",
            json!({ "error": { "message": legacy_message } }).to_string(),
        ),
        ("bio policy plain message", bio_policy_message.to_string()),
        (
            "bio policy JSON message",
            json!({ "error": { "message": bio_policy_message } }).to_string(),
        ),
        (
            "bio policy code",
            json!({ "error": { "code": "bio_policy", "message": "copy may change" } }).to_string(),
        ),
    ];
    let mut rendered_cases = Vec::new();
    for (case, message) in cases {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
        chat.handle_non_retry_error(message, /*codex_error_info*/ None);

        let cells = drain_insert_history(&mut rx);
        assert_eq!(cells.len(), 1);
        let rendered = lines_to_single_string(&cells[0]);
        assert!(rendered.contains("This content can't be shown"));
        assert!(rendered.contains("biological research"));
        rendered_cases.push((case, rendered));
    }

    let canonical = &rendered_cases[0].1;
    for (case, rendered) in &rendered_cases[1..] {
        assert_eq!(rendered, canonical, "unexpected rendering for {case}");
    }
    insta::assert_snapshot!(
        "app_server_bio_policy_error_renders_dedicated_notice",
        rendered_cases.last().unwrap().1.as_str()
    );
}

#[tokio::test]
async fn live_app_server_model_verification_renders_warning() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::ModelVerification(ModelVerificationNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            verifications: vec![AppServerModelVerification::TrustedAccessForCyber],
        }),
        /*replay_kind*/ None,
    );

    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1);
    let rendered = lines_to_single_string(&cells[0]);
    assert!(rendered.contains("multiple flags for possible cybersecurity risk"));
    assert!(rendered.contains("extra safety checks are on"));
    assert!(rendered.contains("Trusted Access for Cyber"));
    assert!(rendered.contains("https://chatgpt.com/cyber"));
}

#[tokio::test]
async fn live_app_server_invalid_thread_name_update_is_ignored() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    chat.thread_name = Some("original name".to_string());

    chat.handle_server_notification(
        ServerNotification::ThreadNameUpdated(
            codex_app_server_protocol::ThreadNameUpdatedNotification {
                thread_id: "not-a-thread-id".to_string(),
                thread_name: Some("bad update".to_string()),
            },
        ),
        /*replay_kind*/ None,
    );

    assert_eq!(chat.thread_id, Some(thread_id));
    assert_eq!(chat.thread_name, Some("original name".to_string()));
}

#[tokio::test]
async fn live_app_server_thread_name_update_shows_resume_hint() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id =
        ThreadId::from_string("123e4567-e89b-12d3-a456-426614174000").expect("thread id");
    chat.thread_id = Some(thread_id);

    chat.handle_server_notification(
        ServerNotification::ThreadNameUpdated(
            codex_app_server_protocol::ThreadNameUpdatedNotification {
                thread_id: thread_id.to_string(),
                thread_name: Some("review-fix".to_string()),
            },
        ),
        /*replay_kind*/ None,
    );

    assert_eq!(chat.thread_name, Some("review-fix".to_string()));
    let cells = drain_insert_history(&mut rx);
    assert_eq!(cells.len(), 1);
    let rendered = lines_to_single_string(&cells[0]);
    assert_chatwidget_snapshot!("thread_name_update_resume_hint", rendered);
}

#[tokio::test]
async fn live_app_server_thread_closed_requests_immediate_exit() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::ThreadClosed(ThreadClosedNotification {
            thread_id: "thread-1".to_string(),
        }),
        /*replay_kind*/ None,
    );

    assert_matches!(rx.try_recv(), Ok(AppEvent::Exit(ExitMode::Immediate)));
}

#[tokio::test]
async fn live_activity_notifications_project_only_safe_scalars_and_typed_cost() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id =
        "prompt-secret-agent-response-secret-command-output-secret-account-provider-path-secret";
    let turn_id = "turn-secret-id";

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: thread_id.to_string(),
            turn: AppServerTurn {
                id: turn_id.to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: Some(42),
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::Error(ErrorNotification {
            error: AppServerTurnError {
                message: "raw-error-secret".to_string(),
                codex_error_info: None,
                additional_details: Some("trace-secret".to_string()),
            },
            will_retry: true,
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            cost: TurnCostState::Unavailable {
                reason: TurnCostAvailability::SubscriptionAuthentication,
            },
        }),
        /*replay_kind*/ None,
    );

    let unavailable = chat.dashboard_activity_state();
    let unavailable_debug = format!("{unavailable:?}");
    for private_value in [
        "prompt-secret",
        "agent-response-secret",
        "command-output-secret",
        "account-provider-path-secret",
        turn_id,
        "raw-error-secret",
        "trace-secret",
    ] {
        assert!(!unavailable_debug.contains(private_value));
    }
    let crate::activity_state::DashboardActivityState { current, recent } = unavailable;
    let current = current.expect("live turn should project as current");
    let crate::activity_state::DashboardActivityRow {
        status,
        started_at,
        duration_ms,
        time_to_first_token_ms,
        profile,
        cost,
    } = current;
    assert_eq!(
        status,
        crate::activity_state::DashboardActivityStatus::Running
    );
    assert_eq!(
        cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        })
    );
    assert_eq!(started_at, Some(42));
    assert_eq!(duration_ms, None);
    assert_eq!(time_to_first_token_ms, None);
    assert_eq!(profile, None);
    assert!(recent.is_empty());

    chat.handle_server_notification(
        ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            status: TurnActivityStatus::Completed,
            started_at: Some(42),
            duration_ms: Some(100),
            time_to_first_token_ms: Some(25),
            profile: None,
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: thread_id.to_string(),
            turn: AppServerTurn {
                id: "turn-priced".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: "turn-priced".to_string(),
            cost: TurnCostState::Priced {
                backend_total_usd: "1.250000".to_string(),
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: "turn-priced".to_string(),
            status: TurnActivityStatus::Completed,
            started_at: None,
            duration_ms: None,
            time_to_first_token_ms: None,
            profile: None,
        }),
        /*replay_kind*/ None,
    );

    let priced = chat.dashboard_activity_state();
    assert_eq!(
        priced.recent[0].cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        })
    );
    assert_eq!(
        priced.recent[1].cost,
        Some(TurnCostState::Priced {
            backend_total_usd: "1.250000".to_string(),
        })
    );
}

#[tokio::test]
async fn dropped_dashboard_publication_receiver_does_not_block_turn_completion() {
    let (mut chat, rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    drop(rx);

    chat.handle_server_notification(
        ServerNotification::TurnStarted(TurnStartedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::InProgress,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            status: TurnActivityStatus::Completed,
            started_at: None,
            duration_ms: None,
            time_to_first_token_ms: None,
            profile: None,
        }),
        /*replay_kind*/ None,
    );
    chat.handle_server_notification(
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: "thread-1".to_string(),
            turn: AppServerTurn {
                id: "turn-1".to_string(),
                items_view: codex_app_server_protocol::TurnItemsView::Full,
                items: Vec::new(),
                status: AppServerTurnStatus::Completed,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
        }),
        /*replay_kind*/ None,
    );

    assert!(!chat.bottom_pane.is_task_running());
    assert_eq!(chat.dashboard_activity_state().recent.len(), 1);
}

#[tokio::test]
async fn empty_activity_reset_still_requests_dashboard_publication() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.reset_activity();

    assert_matches!(rx.try_recv(), Ok(AppEvent::RefreshContextDashboard));
    assert_eq!(chat.dashboard_activity_state().current, None);
    assert!(chat.dashboard_activity_state().recent.is_empty());
}

#[tokio::test]
async fn unknown_activity_cost_does_not_request_dashboard_publication() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.handle_server_notification(
        ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
            thread_id: "thread-1".to_string(),
            turn_id: "unknown-turn".to_string(),
            cost: TurnCostState::Unavailable {
                reason: TurnCostAvailability::BackendUnavailable,
            },
        }),
        /*replay_kind*/ None,
    );

    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
    assert!(chat.dashboard_activity_state().recent.is_empty());
}

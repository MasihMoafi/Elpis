use super::*;
use crate::chatwidget::ManualMemoryPhase;

fn configured_app_ids(app: &mut App) -> ThreadId {
    let thread_id = ThreadId::new();
    app.primary_thread_id = Some(thread_id);
    app.active_thread_id = Some(thread_id);
    thread_id
}

fn ready_without_sources() -> ManualMemoryStatusCompletion {
    ManualMemoryStatusCompletion::Ready {
        status: crate::legacy_core::elpis_context::ManualMemoryStatus {
            state: crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing,
            bytes: 0,
            request_chars_if_admitted: 0,
            eligible_chars_now: 0,
            limit_chars: crate::legacy_core::elpis_context::MANUAL_MEMORY_LIMIT_CHARS,
            truncated: false,
        },
        sources: Vec::new(),
    }
}

#[tokio::test]
async fn manual_memory_view_activation_advances_epoch_and_replaces_the_old_read() {
    let mut app = make_test_app().await;
    let thread_id = configured_app_ids(&mut app);

    assert!(app.activate_manual_memory_view());
    let first = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("first manual-memory target");
    assert_eq!(first.view.epoch, 1);
    assert_eq!(first.view.primary_root_thread_id, thread_id);
    assert_eq!(first.view.displayed_thread_id, thread_id);
    assert_eq!(
        app.chat_widget.manual_memory_phase(),
        ManualMemoryPhase::Loading
    );
    assert_eq!(app.manual_memory_status.in_flight, Some(first.clone()));
    assert!(!app.launch_manual_memory_status(first));

    assert!(app.activate_manual_memory_view());
    let second = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("second manual-memory target");
    assert_eq!(second.view.epoch, 2);
    assert_eq!(app.manual_memory_status.in_flight, Some(second));
}

#[tokio::test]
async fn manual_memory_status_rejects_stale_targets_and_local_refresh_markers() {
    let mut app = make_test_app().await;
    configured_app_ids(&mut app);
    let target = app
        .current_manual_memory_target(4)
        .expect("manual-memory target");
    let ready = ready_without_sources();
    app.chat_widget
        .bind_manual_memory_loading(target.clone(), /*pending_context_report*/ false);
    app.manual_memory_status.in_flight = Some(target.clone());

    let mut stale_targets = Vec::new();
    let mut stale_epoch = target.clone();
    stale_epoch.view.epoch -= 1;
    stale_targets.push(stale_epoch);
    let mut stale_primary = target.clone();
    stale_primary.view.primary_root_thread_id = ThreadId::new();
    stale_targets.push(stale_primary);
    let mut stale_displayed = target.clone();
    stale_displayed.view.displayed_thread_id = ThreadId::new();
    stale_targets.push(stale_displayed);
    let mut stale_cwd = target.clone();
    stale_cwd.view.cwd.push("other-workspace");
    stale_targets.push(stale_cwd);
    let mut stale_memory_path = target.clone();
    stale_memory_path.view.memory_path.push("other-memory");
    stale_targets.push(stale_memory_path);

    for stale in stale_targets {
        assert_eq!(app.finish_manual_memory_status(&stale, ready.clone()), None);
    }

    app.chat_widget.request_manual_memory_status_refresh();
    assert!(app.chat_widget.manual_memory_refresh_requested());
    assert_eq!(
        app.finish_manual_memory_status(&target, ready.clone()),
        None
    );
    assert!(app.chat_widget.manual_memory_status().is_none());

    app.chat_widget
        .bind_manual_memory_loading(target.clone(), /*pending_context_report*/ false);
    app.manual_memory_status.in_flight = Some(target.clone());
    assert_eq!(app.finish_manual_memory_status(&target, ready), Some(false));
    assert_eq!(
        app.chat_widget.manual_memory_phase(),
        ManualMemoryPhase::Ready
    );

    app.chat_widget
        .bind_manual_memory_loading(target.clone(), /*pending_context_report*/ false);
    app.manual_memory_status.in_flight = Some(target.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &target,
            ManualMemoryStatusCompletion::Unavailable(
                ManualMemoryUnavailableReason::MemoryUnreadable,
            ),
        ),
        Some(false)
    );
    assert_eq!(
        app.chat_widget.manual_memory_phase(),
        ManualMemoryPhase::Unavailable
    );
    assert!(app.chat_widget.manual_memory_status().is_none());
    assert!(app.chat_widget.continuity_sources().is_empty());
    assert_eq!(
        app.chat_widget.manual_memory_unavailable_reason(),
        Some(ManualMemoryUnavailableReason::MemoryUnreadable)
    );
}

#[tokio::test]
async fn manual_memory_completion_caches_scalars_without_body_bytes_or_live_rereads()
-> anyhow::Result<()> {
    const BODY: &str = "PLANTED_MANUAL_MEMORY_BODY";
    let mut app = make_test_app().await;
    configured_app_ids(&mut app);
    let memories = app.chat_widget.config_ref().memory_dir.to_path_buf();
    let instruction_source_paths = app.chat_widget.instruction_source_paths_as_path_bufs();
    let dev_rule_roots = app.chat_widget.config_ref().dev_rule_roots();
    std::fs::create_dir_all(&memories)?;
    let target = app
        .current_manual_memory_target(9)
        .expect("manual-memory target");
    std::fs::write(&target.storage.memory_path, BODY)?;
    let completion =
        App::load_manual_memory_status(&target, &instruction_source_paths, &dev_rule_roots);
    assert!(
        !format!("{completion:?}").contains(BODY),
        "status events must not contain manual-memory body bytes"
    );
    assert!(
        !format!(
            "{:?}",
            AppEvent::ManualMemoryStatusLoaded(target.clone(), completion.clone())
        )
        .contains(BODY),
        "the AppEvent payload must not contain manual-memory body bytes"
    );

    app.chat_widget
        .bind_manual_memory_loading(target.clone(), /*pending_context_report*/ false);
    app.manual_memory_status.in_flight = Some(target.clone());
    assert_eq!(
        app.finish_manual_memory_status(&target, completion),
        Some(false)
    );
    let cached_sources = app.chat_widget.continuity_sources();
    let cached_status = app.chat_widget.manual_memory_status().cloned();

    std::fs::write(&target.storage.memory_path, "changed after cache fill")?;
    assert_eq!(app.chat_widget.continuity_sources(), cached_sources);
    assert_eq!(
        app.chat_widget.manual_memory_status(),
        cached_status.as_ref()
    );
    Ok(())
}

#[tokio::test]
async fn manual_memory_context_request_forces_a_new_epoch_before_it_can_settle() {
    let mut app = make_test_app().await;
    configured_app_ids(&mut app);
    let old = app
        .current_manual_memory_target(12)
        .expect("manual-memory target");
    app.manual_memory_status.epoch = old.view.epoch;
    app.chat_widget
        .bind_manual_memory_loading(old.clone(), /*pending_context_report*/ true);
    app.chat_widget.request_manual_memory_status_refresh();

    assert!(app.begin_manual_memory_refresh(&old));
    let fresh = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("fresh manual-memory target");
    assert_eq!(fresh.view.epoch, 13);
    assert!(app.chat_widget.manual_memory_context_report_pending());
    assert_eq!(app.manual_memory_status.in_flight.as_ref(), Some(&fresh));

    app.chat_widget.request_fresh_context_usage_report();
    assert_eq!(app.chat_widget.manual_memory_bound_target(), Some(&fresh));
    assert!(!app.chat_widget.manual_memory_refresh_requested());
}

#[tokio::test]
async fn manual_memory_thread_settings_cwd_transition_rebinds_and_clears_the_cache() {
    let root = tempdir().expect("temporary workspace");
    let old_cwd = root.path().join("old-workspace");
    let new_cwd = root.path().join("new-workspace");
    std::fs::create_dir_all(&old_cwd).expect("old workspace");
    std::fs::create_dir_all(&new_cwd).expect("new workspace");
    let mut app = make_test_app().await;
    let thread_id = configured_app_ids(&mut app);
    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, old_cwd.clone()));

    assert!(app.activate_manual_memory_view());
    let old_target = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("old manual-memory target");
    app.manual_memory_status.in_flight = Some(old_target.clone());
    assert_eq!(
        app.finish_manual_memory_status(&old_target, ready_without_sources()),
        Some(false)
    );
    assert!(app.chat_widget.manual_memory_status().is_some());

    let collaboration_mode = CollaborationMode {
        mode: ModeKind::Default,
        settings: Settings {
            model: "gpt-test".to_string(),
            reasoning_effort: None,
            developer_instructions: None,
        },
    };
    app.handle_thread_event_now(ThreadBufferedEvent::Notification(
        ServerNotification::ThreadSettingsUpdated(ThreadSettingsUpdatedNotification {
            thread_id: thread_id.to_string(),
            thread_settings: ThreadSettings {
                cwd: new_cwd.clone().abs(),
                approval_policy: AskForApproval::Never,
                approvals_reviewer: codex_app_server_protocol::ApprovalsReviewer::User,
                sandbox_policy: codex_app_server_protocol::SandboxPolicy::ReadOnly {
                    network_access: false,
                },
                active_permission_profile: None,
                model: "gpt-test".to_string(),
                model_provider: "test-provider".to_string(),
                service_tier: None,
                effort: None,
                summary: None,
                collaboration_mode,
                multi_agent_mode: Default::default(),
                personality: None,
            },
        }),
    ));

    let rebound = app
        .chat_widget
        .manual_memory_bound_target()
        .expect("rebound manual-memory target");
    assert_eq!(rebound.view.epoch, old_target.view.epoch + 1);
    assert_eq!(rebound.view.cwd, new_cwd);
    assert_ne!(rebound, &old_target);
    assert_eq!(
        app.chat_widget.manual_memory_phase(),
        ManualMemoryPhase::Loading
    );
    assert!(app.chat_widget.manual_memory_status().is_none());
    assert_eq!(app.manual_memory_status.in_flight.as_ref(), Some(rebound));
}

#[tokio::test]
async fn manual_memory_successful_goal_and_checkpoint_writes_request_refresh() -> anyhow::Result<()>
{
    let (mut app, mut app_event_rx, _op_rx) = make_test_app_with_channels().await;
    let thread_id = configured_app_ids(&mut app);

    let goal_target = app
        .current_manual_memory_target(21)
        .expect("goal manual-memory target");
    app.chat_widget
        .bind_manual_memory_loading(goal_target.clone(), /*pending_context_report*/ false);
    app.mirror_elpis_context_notification(&ServerNotification::ThreadGoalUpdated(
        codex_app_server_protocol::ThreadGoalUpdatedNotification {
            thread_id: thread_id.to_string(),
            turn_id: None,
            goal: codex_app_server_protocol::ThreadGoal {
                thread_id: thread_id.to_string(),
                objective: "refresh cached goal".to_string(),
                status: codex_app_server_protocol::ThreadGoalStatus::Active,
                token_budget: None,
                tokens_used: 0,
                time_used_seconds: 0,
                created_at: 1,
                updated_at: 1,
            },
        },
    ))
    .await;
    match app_event_rx.try_recv() {
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(target)) => {
            assert_eq!(target, goal_target);
        }
        other => panic!("expected GOAL refresh event, got {other:?}"),
    }
    assert!(app_event_rx.try_recv().is_err());

    let checkpoint_target = app
        .current_manual_memory_target(22)
        .expect("checkpoint manual-memory target");
    app.chat_widget.bind_manual_memory_loading(
        checkpoint_target.clone(),
        /*pending_context_report*/ false,
    );
    app.mirror_elpis_context_notification(&turn_completed_notification(
        thread_id,
        "turn-memory-refresh",
        TurnStatus::Completed,
    ))
    .await;
    match app_event_rx.try_recv() {
        Ok(AppEvent::ManualMemoryStatusRefreshRequested(target)) => {
            assert_eq!(target, checkpoint_target);
        }
        other => panic!("expected ES refresh event, got {other:?}"),
    }
    assert!(app_event_rx.try_recv().is_err());
    Ok(())
}

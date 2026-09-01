use super::*;
use crate::chatwidget::ManualMemoryPhase;

fn configured_app_ids(app: &mut App) -> ThreadId {
    let thread_id = ThreadId::new();
    app.primary_thread_id = Some(thread_id);
    app.active_thread_id = Some(thread_id);
    thread_id
}

fn ready_without_sources() -> ManualMemoryStatusCompletion {
    ready_with_state(crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Missing)
}

fn ready_with_state(
    state: crate::legacy_core::elpis_context::ManualMemoryAdmissionState,
) -> ManualMemoryStatusCompletion {
    ManualMemoryStatusCompletion::Ready {
        status: crate::legacy_core::elpis_context::ManualMemoryStatus {
            state,
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
async fn manual_memory_create_claim_is_synchronous_and_completion_forces_a_new_epoch() {
    let (mut app, mut app_event_rx, _op_rx) = make_test_app_with_channels().await;
    configured_app_ids(&mut app);
    let origin = app
        .current_manual_memory_target(8)
        .expect("manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.chat_widget.bind_manual_memory_loading(
        origin.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ None,
    );
    assert!(app.chat_widget.apply_manual_memory_status_completion(
        &origin,
        ready_without_sources(),
    ));

    assert!(app.chat_widget.begin_manual_memory_create());
    assert!(!app.chat_widget.begin_manual_memory_create());
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Creating);
    assert_eq!(
        app.chat_widget.manual_memory_pending_mutation(),
        Some(ManualMemoryMutation::Create)
    );
    assert_matches!(
        app_event_rx.try_recv(),
        Ok(AppEvent::ManualMemoryCreateRequested(target)) if target == origin
    );
    assert!(app_event_rx.try_recv().is_err());

    assert!(app.claim_manual_memory_mutation(&origin, ManualMemoryMutation::Create));
    let launched = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("mutation launch target");
    assert_eq!(launched.view.epoch, origin.view.epoch + 1);
    assert!(app
        .manual_memory_status
        .mutations
        .contains_key(&origin.storage));
    app.manual_memory_status.in_flight = Some(launched.clone());
    assert_eq!(
        app.finish_manual_memory_status(&launched, ready_without_sources()),
        None
    );
    assert!(app.chat_widget.manual_memory_status().is_none());
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Creating);

    let disposition = app.record_manual_memory_mutation_completion(
        &origin,
        ManualMemoryMutation::Create,
        ManualMemoryMutationCompletion::Succeeded,
    );
    let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition else {
        panic!("current-target completion must force a fresh status read");
    };
    assert_eq!(fresh.view.epoch, launched.view.epoch + 1);
    assert_eq!(app.chat_widget.manual_memory_bound_target(), Some(&fresh));
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Creating);

    app.manual_memory_status.in_flight = Some(fresh.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &fresh,
            ready_with_state(
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted,
            ),
        ),
        Some(false)
    );
    assert!(!app
        .manual_memory_status
        .mutations
        .contains_key(&origin.storage));
    assert_eq!(app.chat_widget.manual_memory_pending_mutation(), None);
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Ready);
}

#[tokio::test]
async fn manual_memory_mutation_and_status_failures_restore_without_sending() {
    let root = tempdir().expect("temporary workspace");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&cwd).expect("workspace");
    let (mut app, mut app_event_rx, mut op_rx) = make_test_app_with_channels().await;
    let thread_id = configured_app_ids(&mut app);
    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, cwd));
    while app_event_rx.try_recv().is_ok() {}
    let origin = app
        .current_manual_memory_target(20)
        .expect("manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.chat_widget.bind_manual_memory_loading(
        origin.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ None,
    );
    assert!(app.chat_widget.apply_manual_memory_status_completion(
        &origin,
        ready_with_state(
            crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted,
        ),
    ));
    assert!(app.chat_widget.begin_manual_memory_admission(true));
    let requested = match app_event_rx.try_recv() {
        Ok(AppEvent::ManualMemoryAdmissionRequested(target, true)) => target,
        other => panic!("expected admission request, got {other:?}"),
    };
    app.chat_widget
        .queue_user_message(crate::chatwidget::UserMessage::from("blocked draft"));
    assert!(op_rx.try_recv().is_err());

    assert!(app.claim_manual_memory_mutation(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
    ));
    let disposition = app.record_manual_memory_mutation_completion(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
        ManualMemoryMutationCompletion::Failed(
            ManualMemoryMutationFailure::PersistenceFailed,
        ),
    );
    let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition else {
        panic!("admission failure must still force a status read");
    };
    app.manual_memory_status.in_flight = Some(fresh.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &fresh,
            ready_with_state(
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted,
            ),
        ),
        Some(false)
    );

    assert_eq!(app.chat_widget.manual_memory_pending_mutation(), None);
    assert!(app.chat_widget.queued_user_message_texts().is_empty());
    assert!(op_rx.try_recv().is_err());

    assert!(app.chat_widget.begin_manual_memory_admission(true));
    let requested = match app_event_rx.try_recv() {
        Ok(AppEvent::ManualMemoryAdmissionRequested(target, true)) => target,
        other => panic!("expected second admission request, got {other:?}"),
    };
    app.chat_widget
        .queue_user_message(crate::chatwidget::UserMessage::from("status-failed draft"));
    assert!(app.claim_manual_memory_mutation(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
    ));
    let disposition = app.record_manual_memory_mutation_completion(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
        ManualMemoryMutationCompletion::Succeeded,
    );
    let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition else {
        panic!("admission result must force a status read");
    };
    app.manual_memory_status.in_flight = Some(fresh.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &fresh,
            ManualMemoryStatusCompletion::Unavailable(
                ManualMemoryUnavailableReason::AdmissionUnavailable,
            ),
        ),
        Some(false)
    );
    assert!(op_rx.try_recv().is_err());

    app.chat_widget
        .handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    match op_rx.try_recv() {
        Ok(Op::UserTurn { items, .. }) => assert!(matches!(
            items.as_slice(),
            [AppServerUserInput::Text { text, .. }]
                if text == "status-failed draft\nblocked draft"
        )),
        other => panic!("expected restored draft to submit only after Enter, got {other:?}"),
    }
}

#[tokio::test]
async fn manual_memory_admission_success_drains_only_after_matching_fresh_ready_status() {
    let root = tempdir().expect("temporary workspace");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&cwd).expect("workspace");
    let (mut app, mut app_event_rx, mut op_rx) = make_test_app_with_channels().await;
    let thread_id = configured_app_ids(&mut app);
    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, cwd));
    while app_event_rx.try_recv().is_ok() {}
    let origin = app
        .current_manual_memory_target(25)
        .expect("manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.chat_widget.bind_manual_memory_loading(
        origin.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ None,
    );
    assert!(app.chat_widget.apply_manual_memory_status_completion(
        &origin,
        ready_with_state(
            crate::legacy_core::elpis_context::ManualMemoryAdmissionState::AvailableNotAdmitted,
        ),
    ));
    assert!(app.chat_widget.begin_manual_memory_admission(true));
    let requested = match app_event_rx.try_recv() {
        Ok(AppEvent::ManualMemoryAdmissionRequested(target, true)) => target,
        other => panic!("expected admission request, got {other:?}"),
    };
    app.chat_widget
        .queue_user_message(crate::chatwidget::UserMessage::from("send after durable status"));
    assert!(app.claim_manual_memory_mutation(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
    ));
    let disposition = app.record_manual_memory_mutation_completion(
        &requested,
        ManualMemoryMutation::Admission { admitted: true },
        ManualMemoryMutationCompletion::Succeeded,
    );
    let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition else {
        panic!("admission success must force a status read");
    };
    assert!(op_rx.try_recv().is_err());
    app.manual_memory_status.in_flight = Some(fresh.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &fresh,
            ready_with_state(
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Admitted,
            ),
        ),
        Some(false)
    );

    match op_rx.try_recv() {
        Ok(Op::UserTurn { items, .. }) => assert!(matches!(
            items.as_slice(),
            [AppServerUserInput::Text { text, .. }] if text == "send after durable status"
        )),
        other => panic!("expected queued input after fresh durable status, got {other:?}"),
    }
    assert_eq!(app.chat_widget.manual_memory_pending_mutation(), None);
    assert!(app.chat_widget.queued_user_message_texts().is_empty());
}

#[tokio::test]
async fn manual_memory_same_target_switch_keeps_barrier_but_disables_late_autosend() {
    let root = tempdir().expect("temporary workspace");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&cwd).expect("workspace");
    let (mut app, _app_event_rx, mut op_rx) = make_test_app_with_channels().await;
    let thread_id = configured_app_ids(&mut app);
    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, cwd.clone()));
    let origin = app
        .current_manual_memory_target(30)
        .expect("manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.chat_widget.bind_manual_memory_loading(
        origin.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ Some(ManualMemoryMutation::Admission { admitted: true }),
    );
    app.manual_memory_status.mutations.insert(
        origin.storage.clone(),
        ManualMemoryOwnedMutation::running(
            origin.clone(),
            ManualMemoryMutation::Admission { admitted: true },
        ),
    );
    app.chat_widget
        .queue_user_message(crate::chatwidget::UserMessage::from("A draft"));

    let restored = app.prepare_manual_memory_lifecycle_change();
    assert!(restored.is_some());
    let owner = app
        .manual_memory_status
        .mutations
        .get(&origin.storage)
        .expect("stable mutation owner");
    assert!(!owner.allow_same_view_autosend);

    let other_thread = ThreadId::new();
    app.active_thread_id = Some(other_thread);
    app.seed_manual_memory_mutation_for_cwd(&cwd);
    assert_eq!(
        app.chat_widget.manual_memory_pending_mutation(),
        Some(ManualMemoryMutation::Admission { admitted: true })
    );
    assert!(app.chat_widget.manual_memory_submission_blocked());

    let other_cwd = root.path().join("other-project");
    std::fs::create_dir_all(&other_cwd).expect("other workspace");
    app.seed_manual_memory_mutation_for_cwd(&other_cwd);
    assert_eq!(app.chat_widget.manual_memory_pending_mutation(), None);
    assert!(!app.chat_widget.manual_memory_submission_blocked());

    app.active_thread_id = Some(thread_id);
    app.seed_manual_memory_mutation_for_cwd(&cwd);
    let disposition = app.record_manual_memory_mutation_completion(
        &origin,
        ManualMemoryMutation::Admission { admitted: true },
        ManualMemoryMutationCompletion::Succeeded,
    );
    let ManualMemoryCompletionDisposition::Refresh(fresh) = disposition else {
        panic!("A-B-A completion must refresh the current A view");
    };
    app.manual_memory_status.in_flight = Some(fresh.clone());
    assert_eq!(
        app.finish_manual_memory_status(
            &fresh,
            ready_with_state(
                crate::legacy_core::elpis_context::ManualMemoryAdmissionState::Admitted,
            ),
        ),
        Some(false)
    );
    assert!(op_rx.try_recv().is_err(), "late completion must not auto-send A's restored draft");
    assert_eq!(app.chat_widget.manual_memory_pending_mutation(), None);
}

#[tokio::test]
async fn manual_memory_closed_side_failover_restores_blocked_input_without_autosend(
) -> Result<()> {
    let (mut app, mut app_event_rx, mut op_rx) = make_test_app_with_channels().await;
    let mut app_server =
        crate::start_embedded_app_server_for_picker(app.chat_widget.config_ref()).await?;
    let started = app_server.start_thread(app.chat_widget.config_ref()).await?;
    let primary_thread_id = started.session.thread_id;
    app.enqueue_primary_thread_session(started.session, started.turns)
        .await?;
    let destination_paste = "D".repeat(1_005);
    app.chat_widget
        .apply_external_edit("destination draft: ".to_string());
    app.chat_widget.handle_paste(destination_paste.clone());
    app.store_active_thread_receiver().await;
    app.active_thread_id = None;
    app.chat_widget.restore_thread_input_state(
        None,
        crate::chatwidget::ThreadInputStateRestoreMode {
            preserve_in_flight_turn: true,
        },
    );

    let side_thread_id = ThreadId::new();
    let cwd = app.chat_widget.config_ref().cwd.to_path_buf();
    app.side_threads.insert(
        side_thread_id,
        SideThreadState::new(primary_thread_id),
    );
    app.ensure_thread_channel(side_thread_id);
    app.activate_thread_channel(side_thread_id).await;
    app.chat_widget
        .handle_side_thread_session(test_thread_session(side_thread_id, cwd));

    let origin = app
        .current_manual_memory_target(35)
        .expect("side manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.chat_widget.bind_manual_memory_loading(
        origin.clone(),
        /*pending_context_report*/ false,
        /*pending_mutation*/ Some(ManualMemoryMutation::Admission { admitted: true }),
    );
    app.manual_memory_status.mutations.insert(
        origin.storage.clone(),
        ManualMemoryOwnedMutation::running(
            origin,
            ManualMemoryMutation::Admission { admitted: true },
        ),
    );
    let side_paste = "S".repeat(1_005);
    app.chat_widget
        .apply_external_edit("side draft: ".to_string());
    app.chat_widget.handle_paste(side_paste.clone());
    app.chat_widget
        .queue_user_message(crate::chatwidget::UserMessage::from("blocked side draft"));
    assert_eq!(
        app.chat_widget.queued_user_message_texts(),
        vec!["blocked side draft"]
    );
    while app_event_rx.try_recv().is_ok() {}

    let mut tui = crate::tui::test_support::make_test_tui()?;
    app.handle_active_thread_event(
        &mut tui,
        &mut app_server,
        ThreadBufferedEvent::Notification(thread_closed_notification(side_thread_id)),
    )
    .await?;

    assert_eq!(app.active_thread_id, Some(primary_thread_id));
    assert_eq!(
        app.chat_widget.composer_text_with_pending(),
        format!(
            "blocked side draft\nside draft: {side_paste}\ndestination draft: {destination_paste}"
        )
    );
    assert!(app.chat_widget.queued_user_message_texts().is_empty());
    assert!(op_rx.try_recv().is_err());
    assert!(std::iter::from_fn(|| app_event_rx.try_recv().ok()).all(|event| {
        !matches!(event, AppEvent::CodexOp(Op::UserTurn { .. }))
    }));
    app_server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn manual_memory_completion_on_a_different_storage_target_detaches_without_rebinding() {
    let root = tempdir().expect("temporary workspace");
    let cwd_a = root.path().join("A");
    let cwd_b = root.path().join("B");
    std::fs::create_dir_all(&cwd_a).expect("A workspace");
    std::fs::create_dir_all(&cwd_b).expect("B workspace");
    let mut app = make_test_app().await;
    let thread_id = configured_app_ids(&mut app);
    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, cwd_a));
    let origin = app
        .current_manual_memory_target(40)
        .expect("A manual-memory target");
    app.manual_memory_status.epoch = origin.view.epoch;
    app.manual_memory_status.mutations.insert(
        origin.storage.clone(),
        ManualMemoryOwnedMutation::running(origin.clone(), ManualMemoryMutation::Create),
    );

    app.chat_widget
        .handle_thread_session(test_thread_session(thread_id, cwd_b));
    assert!(app.activate_manual_memory_view());
    let b_target = app
        .chat_widget
        .manual_memory_bound_target()
        .cloned()
        .expect("B manual-memory target");
    assert_ne!(b_target.storage, origin.storage);

    assert_eq!(
        app.record_manual_memory_mutation_completion(
            &origin,
            ManualMemoryMutation::Create,
            ManualMemoryMutationCompletion::Succeeded,
        ),
        ManualMemoryCompletionDisposition::Detached
    );
    assert_eq!(app.chat_widget.manual_memory_bound_target(), Some(&b_target));
    assert!(!app
        .manual_memory_status
        .mutations
        .contains_key(&origin.storage));
}

#[tokio::test]
async fn manual_memory_workers_map_collision_and_missing_file_without_payload_bytes(
) -> anyhow::Result<()> {
    const BODY: &str = "PRIVATE_MEMORY_BODY_MUST_NOT_CROSS_THE_EVENT";
    let mut app = make_test_app().await;
    configured_app_ids(&mut app);
    let memories = app.chat_widget.config_ref().memory_dir.to_path_buf();
    std::fs::create_dir_all(&memories)?;
    let target = app
        .current_manual_memory_target(1)
        .expect("manual-memory target");
    std::fs::write(&target.storage.memory_path, BODY)?;

    let collision = App::perform_manual_memory_create(&target);
    assert_eq!(
        collision,
        ManualMemoryMutationCompletion::Failed(ManualMemoryMutationFailure::AlreadyExists)
    );
    let collision_event = AppEvent::ManualMemoryCreateFinished(target.clone(), collision);
    let rendered = format!("{collision_event:?}");
    assert!(!rendered.contains(BODY));

    let mut mismatched_target = target.clone();
    mismatched_target.view.memory_path = memories.join("different-memory.md");
    assert_eq!(
        App::perform_manual_memory_create(&mismatched_target),
        ManualMemoryMutationCompletion::Failed(
            ManualMemoryMutationFailure::StorageUnavailable,
        )
    );

    std::fs::remove_file(&target.storage.memory_path)?;
    let missing = App::perform_manual_memory_admission(&target, true);
    assert_eq!(
        missing,
        ManualMemoryMutationCompletion::Failed(ManualMemoryMutationFailure::Missing)
    );
    Ok(())
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
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Loading);
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
        .bind_manual_memory_loading(
            target.clone(),
            /*pending_context_report*/ false,
            /*pending_mutation*/ None,
        );
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
    assert_eq!(app.finish_manual_memory_status(&target, ready.clone()), None);
    assert!(app.chat_widget.manual_memory_status().is_none());

    app.chat_widget
        .bind_manual_memory_loading(
            target.clone(),
            /*pending_context_report*/ false,
            /*pending_mutation*/ None,
        );
    app.manual_memory_status.in_flight = Some(target.clone());
    assert_eq!(app.finish_manual_memory_status(&target, ready), Some(false));
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Ready);

    app.chat_widget
        .bind_manual_memory_loading(
            target.clone(),
            /*pending_context_report*/ false,
            /*pending_mutation*/ None,
        );
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
async fn manual_memory_completion_caches_scalars_without_body_bytes_or_live_rereads(
) -> anyhow::Result<()> {
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
    let completion = App::load_manual_memory_status(
        &target,
        &instruction_source_paths,
        &dev_rule_roots,
    );
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
        .bind_manual_memory_loading(
            target.clone(),
            /*pending_context_report*/ false,
            /*pending_mutation*/ None,
        );
    app.manual_memory_status.in_flight = Some(target.clone());
    assert_eq!(
        app.finish_manual_memory_status(&target, completion),
        Some(false)
    );
    let cached_sources = app.chat_widget.continuity_sources();
    let cached_status = app.chat_widget.manual_memory_status().cloned();

    std::fs::write(&target.storage.memory_path, "changed after cache fill")?;
    assert_eq!(app.chat_widget.continuity_sources(), cached_sources);
    assert_eq!(app.chat_widget.manual_memory_status(), cached_status.as_ref());
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
        .bind_manual_memory_loading(
            old.clone(),
            /*pending_context_report*/ true,
            /*pending_mutation*/ None,
        );
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
    assert_eq!(app.chat_widget.manual_memory_phase(), ManualMemoryPhase::Loading);
    assert!(app.chat_widget.manual_memory_status().is_none());
    assert_eq!(app.manual_memory_status.in_flight.as_ref(), Some(rebound));
}

#[tokio::test]
async fn manual_memory_successful_goal_and_checkpoint_writes_request_refresh(
) -> anyhow::Result<()> {
    let (mut app, mut app_event_rx, _op_rx) = make_test_app_with_channels().await;
    let thread_id = configured_app_ids(&mut app);

    let goal_target = app
        .current_manual_memory_target(21)
        .expect("goal manual-memory target");
    app.chat_widget
        .bind_manual_memory_loading(
            goal_target.clone(),
            /*pending_context_report*/ false,
            /*pending_mutation*/ None,
        );
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
        /*pending_mutation*/ None,
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

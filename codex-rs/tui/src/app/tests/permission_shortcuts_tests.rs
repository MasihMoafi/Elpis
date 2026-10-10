use super::*;
use codex_arg0::Arg0DispatchPaths;
use pretty_assertions::assert_eq;

fn read_only_selection() -> PermissionProfileSelection {
    PermissionProfileSelection {
        profile_id: ":read-only".to_string(),
        approval_policy: Some(AskForApproval::OnRequest),
        approvals_reviewer: Some(ApprovalsReviewer::User),
        display_label: "Read Only".to_string(),
    }
}

#[tokio::test]
async fn full_access_shortcut_requires_confirmation_and_cancel_does_not_apply() -> Result<()> {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    app.config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
            PermissionProfile::workspace_write(),
            ActivePermissionProfile::new(":workspace"),
        ))?;
    app.config
        .permissions
        .approval_policy
        .set(AskForApproval::OnRequest.to_core())?;
    let mut server = start_config_write_test_app_server(&app).await?;
    let started = server.start_thread(&app.config).await?;
    let thread_id = started.session.thread_id;
    app.enqueue_primary_thread_session(started.session, started.turns)
        .await?;
    let before = RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref());
    let selection = PermissionProfileSelection {
        profile_id: ":danger-full-access".into(),
        approval_policy: Some(AskForApproval::Never),
        approvals_reviewer: Some(ApprovalsReviewer::User),
        display_label: "Full Access".into(),
    };
    while events.try_recv().is_ok() {}
    app.apply_permission_shortcut(&mut server, ThreadId::new(), selection.clone())
        .await;
    assert!(!app.chat_widget.has_active_view());
    app.chat_widget
        .set_feature_enabled(Feature::GuardianApproval, false);
    app.chat_widget.request_permission_profiles();
    let request_id = assert_matches!(events.try_recv(), Ok(AppEvent::FetchPermissionProfiles { request_id, .. }) => request_id);
    let discovery =
        crate::permission_discovery::PermissionDiscovery::local(app.chat_widget.config_ref());
    app.chat_widget
        .on_permission_profiles_loaded(request_id, Ok(discovery));
    app.chat_widget
        .handle_key_event(KeyEvent::from(KeyCode::Esc));
    for cancel in [true, false] {
        app.chat_widget
            .handle_key_event(KeyEvent::from(KeyCode::BackTab));
        let selected = assert_matches!(events.try_recv(), Ok(AppEvent::ApplyPermissionShortcut { selection, .. }) => selection);
        assert_eq!(selected.profile_id, selection.profile_id);
        app.apply_permission_shortcut(&mut server, thread_id, selected)
            .await;
        assert!(render_bottom_popup(&app.chat_widget, 100).contains("Enable full access?"));
        assert_eq!(
            RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref()),
            before
        );
        assert!(
            !app.agents_overview
                .requested_permission_profiles
                .contains_key(&thread_id)
        );
        assert!(
            events.try_recv().is_err(),
            "no settings request before confirmation"
        );
        if cancel {
            app.chat_widget
                .handle_key_event(KeyEvent::from(KeyCode::Down));
            app.chat_widget
                .handle_key_event(KeyEvent::from(KeyCode::Enter));
            assert_matches!(events.try_recv(), Ok(AppEvent::OpenPermissionsPopup));
            assert!(
                events.try_recv().is_err(),
                "cancel must not select Full Access"
            );
        } else {
            app.chat_widget
                .handle_key_event(KeyEvent::from(KeyCode::Enter));
            let accepted = assert_matches!(events.try_recv(), Ok(AppEvent::SelectPermissionProfile(selection)) => selection);
            assert!(events.try_recv().is_err(), "only one confirmed selection");
            app.select_permission_profile(&mut server, accepted).await;
            let notification = next_thread_settings_updated(&mut server, thread_id).await;
            app.enqueue_thread_notification(
                thread_id,
                ServerNotification::ThreadSettingsUpdated(notification),
            )
            .await?;
            assert_eq!(
                app.chat_widget
                    .config_ref()
                    .permissions
                    .permission_profile(),
                &PermissionProfile::Disabled
            );
            assert_eq!(
                app.chat_widget
                    .config_ref()
                    .permissions
                    .approval_policy
                    .value(),
                AskForApproval::Never.to_core()
            );
        }
    }
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn permission_shortcut_rejections_leave_state_unchanged() -> Result<()> {
    for experimental_api in [false, true] {
        let (mut app, mut events, _op_rx) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        app.active_thread_id = Some(thread_id);
        app.chat_widget
            .handle_thread_session_quiet(test_thread_session(
                thread_id,
                app.config.cwd.to_path_buf(),
            ));
        let original = RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref());
        let original_reviewer = app.config.approvals_reviewer;
        let client = crate::start_embedded_app_server_with(
            Arg0DispatchPaths::default(),
            app.config.clone(),
            Vec::new(),
            LoaderOverrides::without_managed_config_for_tests(),
            /*strict_config*/ false,
            CloudConfigBundleLoader::default(),
            codex_feedback::CodexFeedback::new(),
            /*log_db*/ None,
            /*state_db*/ None,
            Arc::clone(&app.environment_manager),
            Default::default(),
            |mut args| {
                args.experimental_api = experimental_api;
                codex_app_server_client::InProcessAppServerClient::start(args)
            },
        )
        .await?;
        let mut app_server = AppServerSession::new(
            codex_app_server_client::AppServerClient::InProcess(client),
            crate::app_server_session::ThreadParamsMode::Embedded,
        );
        while events.try_recv().is_ok() {}
        let transcript_len = app.transcript_cells.len();
        app.apply_permission_shortcut(&mut app_server, ThreadId::new(), read_only_selection())
            .await;
        assert_eq!(app.transcript_cells.len(), transcript_len);
        assert!(events.try_recv().is_err());
        app.apply_permission_shortcut(&mut app_server, thread_id, read_only_selection())
            .await;
        assert_eq!(
            RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref()),
            original
        );
        assert_eq!(app.config.approvals_reviewer, original_reviewer);
        insta::assert_snapshot!(
            if experimental_api {
                "permission_shortcut_server_error"
            } else {
                "permission_shortcut_unsupported"
            },
            next_history_message(&mut events).replace(&thread_id.to_string(), "<THREAD_ID>")
        );
        assert!(events.try_recv().is_err());
        app_server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn permission_shortcut_confirms_without_persisting() -> Result<()> {
    let (mut app, mut events, _op_rx) = make_test_app_with_channels().await;
    let codex_home = tempdir()?;
    app.config.codex_home = codex_home.path().to_path_buf().abs();
    app.config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
            PermissionProfile::workspace_write(),
            ActivePermissionProfile::new(":workspace"),
        ))?;
    let config_path = codex_home.path().join("config.toml");
    let contents = "approvals_reviewer = \"auto_review\"\n";
    std::fs::write(&config_path, contents)?;
    let mut app_server = start_config_write_test_app_server(&app).await?;
    let started = app_server.start_thread(&app.config).await?;
    let thread_id = started.session.thread_id;
    app.chat_widget
        .handle_thread_session_quiet(started.session.clone());
    app.enqueue_primary_thread_session(started.session, started.turns)
        .await?;
    let contents = std::fs::read_to_string(&config_path)?;
    while events.try_recv().is_ok() {}

    let before = RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref());
    app.apply_permission_shortcut(&mut app_server, thread_id, read_only_selection())
        .await;

    assert_eq!(
        RuntimePermissionProfileOverride::from_config(app.chat_widget.config_ref()),
        before
    );
    assert!(
        app.agents_overview
            .requested_permission_profiles
            .contains_key(&thread_id)
    );
    insta::assert_snapshot!(
        next_history_message(&mut events),
        @"• Permission selection requested: Read Only"
    );

    let notification = next_thread_settings_updated(&mut app_server, thread_id).await;
    let settings = notification.thread_settings.clone();
    app.enqueue_thread_notification(
        thread_id,
        ServerNotification::ThreadSettingsUpdated(notification),
    )
    .await?;
    assert!(!app.pending_server_profiles.contains_key(&thread_id));
    let profile = app
        .chat_widget
        .config_ref()
        .permissions
        .active_permission_profile();
    assert_eq!(
        settings.active_permission_profile,
        profile.clone().map(Into::into)
    );
    assert_eq!(profile, Some(ActivePermissionProfile::new(":read-only")));
    assert_eq!(app.config.approvals_reviewer, ApprovalsReviewer::User);
    assert_eq!(std::fs::read_to_string(config_path)?, contents);
    app_server.shutdown().await?;
    Ok(())
}

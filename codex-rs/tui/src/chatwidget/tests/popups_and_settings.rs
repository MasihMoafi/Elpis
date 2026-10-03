use super::*;
use crate::app_event::ConnectorsSnapshot;
use crate::bottom_pane::ExperimentalFeatureItem;
use crate::chatwidget::connectors::ConnectorsCacheState;
use codex_app_server_protocol::HookErrorInfo;
use codex_app_server_protocol::HooksListEntry;
use codex_app_server_protocol::HooksListResponse;
use codex_connectors::AppInfo;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn experimental_mode_plan_is_ignored_on_startup() {
    let codex_home = tempdir().expect("tempdir");
    let cfg = ConfigBuilder::default()
        .codex_home(codex_home.path().to_path_buf())
        .cli_overrides(vec![
            (
                "features.collaboration_modes".to_string(),
                TomlValue::Boolean(true),
            ),
            (
                "tui.experimental_mode".to_string(),
                TomlValue::String("plan".to_string()),
            ),
        ])
        .build()
        .await
        .expect("config");
    let resolved_model = get_model_offline_for_tests(cfg.model.as_deref());
    let session_telemetry = test_session_telemetry(&cfg, resolved_model.as_str());
    let init = ChatWidgetInit {
        requires_openai_auth: true,
        local_settings: crate::local_settings::LocalSettings::from(&cfg),
        config: cfg.clone(),
        frame_requester: FrameRequester::test_dummy(),
        app_event_tx: AppEventSender::new(unbounded_channel::<AppEvent>().0),
        workspace_command_runner: None,
        initial_user_message: None,
        enhanced_keys_supported: false,
        has_chatgpt_account: false,
        has_codex_backend_auth: false,
        model_catalog: test_model_catalog(&cfg),
        feedback: codex_feedback::CodexFeedback::new(),
        is_first_run: true,
        status_account_display: None,
        initial_plan_type: None,
        model: Some(resolved_model.clone()),
        startup_tooltip_override: None,
        status_line_invalid_items_warned: Arc::new(AtomicBool::new(false)),
        terminal_title_invalid_items_warned: Arc::new(AtomicBool::new(false)),
        session_telemetry,
    };

    let chat = ChatWidget::new_with_app_event(init);
    assert_eq!(chat.active_collaboration_mode_kind(), ModeKind::Default);
    assert_eq!(chat.current_model(), resolved_model);
}

#[tokio::test]
async fn hooks_popup_shows_list_diagnostics() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let cwd = chat.config.cwd.clone();

    chat.on_hooks_loaded(
        cwd.to_path_buf(),
        Ok(HooksListResponse {
            data: vec![HooksListEntry {
                cwd: cwd.to_path_buf(),
                hooks: Vec::new(),
                warnings: vec!["skipped invalid matcher for PreToolUse".to_string()],
                errors: vec![HookErrorInfo {
                    path: test_path_buf("/tmp/hooks.json"),
                    message: "failed to parse hooks config".to_string(),
                }],
            }],
        }),
    );

    let popup = normalize_snapshot_paths(render_bottom_popup(&chat, /*width*/ 112));
    assert_chatwidget_snapshot!("hooks_popup_shows_list_diagnostics", popup);
}

#[tokio::test]
async fn apps_notification_update_excludes_inaccessible_apps_from_mentions() {
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    set_chatgpt_auth(&mut chat);
    chat.config
        .features
        .enable(Feature::Apps)
        .expect("test config should allow feature update");
    chat.bottom_pane.set_connectors_enabled(/*enabled*/ true);
    chat.bottom_pane
        .set_composer_text("$".to_string(), Vec::new(), Vec::new());

    chat.on_connectors_loaded(
        Ok(ConnectorsSnapshot {
            connectors: vec![
                AppInfo {
                    id: "google_drive".to_string(),
                    name: "Google Drive".to_string(),
                    description: Some("Connected files".to_string()),
                    logo_url: None,
                    logo_url_dark: None,
                    icon_assets: None,
                    icon_dark_assets: None,
                    distribution_channel: None,
                    branding: None,
                    app_metadata: None,
                    labels: None,
                    install_url: Some("https://example.test/google-drive".to_string()),
                    is_accessible: true,
                    is_enabled: true,
                    plugin_display_names: Vec::new(),
                },
                AppInfo {
                    id: "arabica_uae".to_string(),
                    name: "% Arabica UAE".to_string(),
                    description: Some("Directory-only app".to_string()),
                    logo_url: None,
                    logo_url_dark: None,
                    icon_assets: None,
                    icon_dark_assets: None,
                    distribution_channel: None,
                    branding: None,
                    app_metadata: None,
                    labels: None,
                    install_url: Some("https://example.test/arabica".to_string()),
                    is_accessible: true,
                    is_enabled: true,
                    plugin_display_names: Vec::new(),
                },
            ],
        }),
        /*is_final*/ false,
    );

    assert!(chat.connectors_for_mentions().is_none());

    let mut installed = chat
        .connectors
        .partial_snapshot
        .as_ref()
        .expect("directory notification should remain available to /apps")
        .connectors
        .clone();
    installed[1].is_enabled = false;
    chat.on_connector_mentions_loaded(
        chat.connector_scope_generation(),
        Ok(ConnectorsSnapshot {
            connectors: installed,
        }),
    );

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert!(
        popup.contains("Google Drive"),
        "expected callable installed apps to appear in the mention popup, got:\n{popup}"
    );
    assert!(
        !popup.contains("% Arabica UAE"),
        "directory accessibility must not make an app callable, got:\n{popup}"
    );
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.insert_str("$arabica-uae ");
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_matches!(
        next_submit_op(&mut op_rx),
        Op::UserTurn { items, .. }
            if matches!(items.as_slice(), [
                UserInput::Text { .. },
                UserInput::Mention { name, path },
            ] if name == "Google Drive" && path == "app://google_drive")
    );

    chat.connectors.partial_snapshot = None;
    assert_matches!(&chat.connectors.cache, ConnectorsCacheState::Uninitialized);
    for (app_id, app_name) in [
        ("arabica_uae", "% Arabica UAE"),
        ("google_drive", "Google Drive"),
    ] {
        chat.on_plugin_install_loaded(
            chat.config.cwd.to_path_buf(),
            crate::app_event::PluginLocation::Remote {
                marketplace_name: "marketplace".to_string(),
            },
            "plugin".to_string(),
            "Plugin".to_string(),
            Ok(serde_json::from_value(serde_json::json!({
                "authPolicy": "ON_INSTALL",
                "appsNeedingAuth": [{ "id": app_id, "name": app_name }],
            }))
            .expect("valid plugin installation response")),
        );
        let auth_popup = render_bottom_popup(&chat, /*width*/ 80);
        assert!(auth_popup.contains("Already installed") && auth_popup.contains("Continue"));
        if app_id == "arabica_uae" {
            let snapshot = normalize_snapshot_paths(format!(
                "{popup}\n\n--- plugin authentication ---\n{auth_popup}"
            ));
            assert_chatwidget_snapshot!("apps_mentions_only_callable_installed", snapshot);
        }
    }
}

#[tokio::test]
async fn apps_installed_mentions_revoke_access_and_reject_stale_account_results() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    set_chatgpt_auth(&mut chat);
    chat.set_feature_enabled(Feature::Apps, /*enabled*/ true);
    let generation = chat.connector_scope_generation();
    let connector_id = "account-app";
    let connector =
        serde_json::from_str(r#"{"id":"account-app","name":"Account app","isAccessible":true}"#)
            .expect("valid installed app");
    let snapshot = ConnectorsSnapshot {
        connectors: vec![connector],
    };
    chat.on_connector_mentions_loaded(generation, Ok(snapshot.clone()));
    assert!(chat.connectors.installed_app_ids.contains(connector_id));

    chat.refresh_connector_mentions(/*force_refresh*/ false);
    rx.try_recv().expect("pre-disable mention refresh");
    chat.update_connector_enabled(connector_id, /*enabled*/ false);
    chat.on_connector_mentions_loaded(generation, Ok(snapshot.clone()));
    assert_eq!(chat.connectors_for_mentions(), Some([].as_slice()));
    rx.try_recv().expect("post-disable mention refresh");
    chat.on_connector_mentions_loaded(generation, Ok(snapshot.clone()));
    assert_eq!(
        chat.connectors_for_mentions(),
        Some(snapshot.connectors.as_slice())
    );

    chat.on_connectors_loaded(Ok(snapshot.clone()), /*is_final*/ true);
    for enabled in [false, true] {
        chat.update_connector_enabled(connector_id, enabled);
        assert_eq!(chat.connectors_for_mentions(), Some([].as_slice()));
        assert_matches!(
            rx.try_recv(),
            Ok(AppEvent::FetchInstalledConnectorMentions { force_refresh, .. })
                if force_refresh == enabled
        );
        let mut refreshed = snapshot.clone();
        refreshed.connectors[0].is_enabled = enabled;
        chat.on_connector_mentions_loaded(generation, Ok(refreshed));
    }

    chat.update_account_state(
        /*status_account_display*/ None, /*plan_type*/ None,
        /*has_chatgpt_account*/ true, /*has_codex_backend_auth*/ true,
    );

    assert_ne!(chat.connector_scope_generation(), generation);
    assert_matches!(&chat.connectors.cache, ConnectorsCacheState::Uninitialized);
    assert!(chat.connectors_for_mentions().is_none());
    assert!(chat.connectors.mention_refresh_in_flight);

    chat.on_connector_mentions_loaded(generation, Ok(snapshot));
    assert!(chat.connectors_for_mentions().is_none());
    assert!(chat.connectors.mention_refresh_in_flight);
    assert!(chat.connectors.installed_app_ids.is_empty());

    let (mut replacement, _, _) = make_chatwidget_manual(/*model_override*/ None).await;
    replacement.invalidate_connector_scope();
    assert_ne!(
        chat.connector_scope_generation(),
        replacement.connector_scope_generation()
    );
}

#[tokio::test]
async fn apps_refresh_failure_with_cached_snapshot_triggers_pending_force_refetch() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);
    chat.config
        .features
        .enable(Feature::Apps)
        .expect("test config should allow feature update");
    chat.bottom_pane.set_connectors_enabled(/*enabled*/ true);
    chat.connectors.prefetch_in_flight = true;
    chat.connectors.force_refetch_pending = true;

    let full_connectors = vec![AppInfo {
        id: "unit_test_apps_refresh_failure_pending_connector".to_string(),
        name: "Notion".to_string(),
        description: Some("Workspace docs".to_string()),
        logo_url: None,
        logo_url_dark: None,
        icon_assets: None,
        icon_dark_assets: None,
        distribution_channel: None,
        branding: None,
        app_metadata: None,
        labels: None,
        install_url: Some("https://example.test/notion".to_string()),
        is_accessible: true,
        is_enabled: true,
        plugin_display_names: Vec::new(),
    }];
    chat.connectors.cache = ConnectorsCacheState::Ready(ConnectorsSnapshot {
        connectors: full_connectors.clone(),
    });

    chat.on_connectors_loaded(
        Err("failed to load apps".to_string()),
        /*is_final*/ true,
    );

    assert!(chat.connectors.prefetch_in_flight);
    assert!(!chat.connectors.force_refetch_pending);
    assert_matches!(
        &chat.connectors.cache,
        ConnectorsCacheState::Ready(snapshot) if snapshot.connectors == full_connectors
    );
}

#[tokio::test]
async fn experimental_features_popup_snapshot() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    let features = vec![
        ExperimentalFeatureItem {
            key: Feature::JsRepl.key().to_string(),
            writable: true,
            name: "JavaScript REPL".to_string(),
            description: "Enable a persistent Node-backed JavaScript REPL for interactive website debugging and other inline JavaScript execution capabilities.".to_string(),
            enabled: false,
        },
        ExperimentalFeatureItem {
            key: Feature::ShellTool.key().to_string(),
            writable: true,
            name: "Shell tool".to_string(),
            description: "Allow the model to run shell commands.".to_string(),
            enabled: true,
        },
        ExperimentalFeatureItem {
            key: Feature::RealtimeConversation.key().to_string(),
            writable: true,
            name: "Voice conversations".to_string(),
            description: "Talk with Elpis using /voice.".to_string(),
            enabled: false,
        },
    ];
    let view = ExperimentalFeaturesView::new(
        features,
        ThreadId::new(),
        /*catalog_rx*/ None,
        chat.app_event_tx.clone(),
        crate::keymap::RuntimeKeymap::defaults().list,
    );
    chat.bottom_pane.show_view(Box::new(view));

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("experimental_features_popup", popup);

    let mut config = codex_config::types::TuiKeymap::default();
    config.list.accept = Some(codex_config::types::KeybindingsSpec::One(
        codex_config::types::KeybindingSpec("ctrl-x enter".to_string()),
    ));
    let keymap = crate::keymap::RuntimeKeymap::from_config(&config)
        .expect("valid experimental-feature chord");
    let view = ExperimentalFeaturesView::new(
        vec![ExperimentalFeatureItem {
            key: Feature::ShellTool.key().to_string(),
            writable: true,
            name: "Shell tool".to_string(),
            description: "Allow the model to run shell commands.".to_string(),
            enabled: true,
        }],
        ThreadId::new(),
        /*catalog_rx*/ None,
        chat.app_event_tx.clone(),
        keymap.list,
    );
    chat.bottom_pane.show_view(Box::new(view));
    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("experimental_features_popup_configured_key_chords", popup);
}

#[tokio::test]
async fn experimental_features_toggle_saves_on_exit() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    let mut keymap = crate::keymap::RuntimeKeymap::defaults().list;
    keymap.cancel = vec![crate::key_hint::plain(KeyCode::F(2))];
    let expected_feature = Feature::JsRepl;
    let view = ExperimentalFeaturesView::new(
        vec![ExperimentalFeatureItem {
            key: expected_feature.key().to_string(),
            writable: true,
            name: "JavaScript REPL".to_string(),
            description: "Enable a persistent Node-backed JavaScript REPL for interactive website debugging and other inline JavaScript execution capabilities.".to_string(),
            enabled: false,
        }],
        ThreadId::new(),
        /*catalog_rx*/ None,
        chat.app_event_tx.clone(),
        keymap,
    );
    chat.bottom_pane.show_view(Box::new(view));

    chat.handle_key_event(KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE));

    assert!(
        rx.try_recv().is_err(),
        "expected no updates until saving the popup"
    );

    chat.handle_key_event(KeyEvent::new(KeyCode::F(2), KeyModifiers::NONE));
    assert!(
        !chat.has_active_view(),
        "remapped cancel must save and close"
    );

    let mut updates = None;
    while let Ok(event) = rx.try_recv() {
        if let AppEvent::SaveExperimentalFeatures {
            updates: event_updates,
            ..
        } = event
        {
            updates = Some(event_updates);
            break;
        }
    }

    let updates = updates.expect("expected SaveExperimentalFeatures event");
    assert_eq!(updates, vec![(expected_feature.key().to_string(), true)]);
}

#[tokio::test]
async fn experimental_popup_loading_snapshot() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.open_experimental_popup();
    assert!(!chat.has_active_view());
    let cell = assert_matches!(rx.try_recv(), Ok(AppEvent::InsertHistoryCell(cell)) => cell);
    insta::assert_snapshot!(
        "experimental_features_startup",
        lines_to_single_string(&cell.display_lines(/*width*/ 80))
    );
    assert!(rx.try_recv().is_err());
    chat.thread_id = Some(ThreadId::new());
    chat.open_experimental_popup();
    let AppEvent::FetchExperimentalFeatures { response_tx, .. } = rx.try_recv().unwrap() else {
        panic!("expected experimental discovery request");
    };
    assert_chatwidget_snapshot!(
        "experimental_features_loading",
        render_bottom_popup(&chat, /*width*/ 80)
    );
    chat.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert!(response_tx.send(Ok(Vec::new())).is_err());
    assert!(!chat.has_active_view());
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn experimental_popup_available_snapshot() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.open_experimental_popup();
    let AppEvent::FetchExperimentalFeatures { response_tx, .. } = rx.try_recv().unwrap() else {
        panic!("expected experimental discovery request");
    };
    let features = [
        ("network_proxy", "Network proxy", "Apply network proxy restrictions to sandboxed sessions that already have network access."),
        ("prevent_idle_sleep", "Prevent sleep while running", "Keep your computer awake while Elpis is running a thread."),
    ]
    .into_iter()
    .map(|(name, display_name, description)| codex_app_server_protocol::ExperimentalFeature {
        name: name.to_string(),
        stage: codex_app_server_protocol::ExperimentalFeatureStage::Beta,
        display_name: Some(display_name.to_string()),
        description: Some(description.to_string()),
        announcement: None,
        enabled: false,
        default_enabled: false,
    })
    .collect();
    response_tx.send(Ok(features)).unwrap();
    chat.pre_draw_tick();
    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("experimental_features_available_popup", popup);
}

#[tokio::test]
async fn feature_enable_prompts_snapshot() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.set_feature_enabled(Feature::MemoryTool, /*enabled*/ false);

    chat.open_feature_enable_prompt(Feature::Collab);
    assert_chatwidget_snapshot!(
        "multi_agent_enable_prompt",
        render_bottom_popup(&chat, /*width*/ 80)
    );
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::EnableFeatureForNewThreads(Feature::Collab))
    );

    chat.open_memories_popup();
    assert_chatwidget_snapshot!(
        "memories_enable_prompt",
        render_bottom_popup(&chat, /*width*/ 80)
    );
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::EnableFeatureForNewThreads(Feature::MemoryTool))
    );
    assert!(rx.try_recv().is_err());
    assert!(!chat.has_active_view());
}

#[tokio::test]
async fn model_selection_popup_snapshot() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    chat.open_model_popup();

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("model_selection_popup", popup);
}

fn apply_model_list_response(chat: &mut ChatWidget, presets: Vec<ModelPreset>) {
    let request_id = chat.model_popup_request_id.expect("pending model request");
    assert!(chat.on_models_loaded(request_id, Ok(presets)));
}

#[tokio::test]
async fn model_picker_refresh_rejects_obsolete_and_unusable_replies() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let initial = chat.model_catalog.try_list_models().unwrap();
    let mut refreshed = initial.clone();
    refreshed[0].description = "Updated model details".to_string();
    chat.open_model_popup();
    let old_request = chat.model_popup_request_id.unwrap();
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.open_model_popup();
    let current_request = chat.model_popup_request_id.unwrap();
    assert!(!chat.on_models_loaded(old_request, Ok(refreshed.clone())));
    assert!(chat.model_popup_request_is_current(current_request));
    // Identical visible account fields still mark an account boundary.
    chat.update_account_state(
        chat.status_account_display.clone(),
        chat.plan_type,
        chat.has_chatgpt_account,
        chat.has_codex_backend_auth,
    );
    assert!(!chat.on_models_loaded(current_request, Ok(refreshed.clone())));
    assert_eq!(chat.model_catalog.try_list_models().unwrap(), initial);

    for result in [
        Err("unavailable".to_string()),
        Ok(Vec::new()),
        Ok(initial.clone()),
    ] {
        chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        chat.open_model_popup();
        let request_id = chat.model_popup_request_id.unwrap();
        let before = render_bottom_popup(&chat, /*width*/ 80);
        assert!(!chat.on_models_loaded(request_id, result));
        assert!(!chat.model_popup_request_is_current(request_id));
        assert_eq!(chat.model_catalog.try_list_models().unwrap(), initial);
        assert_eq!(render_bottom_popup(&chat, /*width*/ 80), before);
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.open_model_popup();
    apply_model_list_response(&mut chat, refreshed.clone());
    assert_eq!(chat.model_catalog.try_list_models().unwrap(), refreshed);
}

#[tokio::test]
async fn model_picker_refreshes_startup_catalog() {
    for (explicit_all_models, hidden_startup) in [(false, false), (true, false), (false, true)] {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        let mut startup = vec![get_available_model(&chat, "gpt-5.5")];
        let mut refreshed = chat.model_catalog.try_list_models().unwrap();
        let mut auto = startup[0].clone();
        auto.model = "codex-auto-test".to_string();
        auto.id = auto.model.clone();
        auto.description = "Auto model".to_string();
        refreshed.push(auto);
        startup[0].show_in_picker = !hidden_startup;
        chat.model_catalog = Arc::new(ModelCatalog::new(startup.clone()));
        chat.open_model_popup();
        assert!(
            std::iter::from_fn(|| rx.try_recv().ok())
                .any(|event| matches!(event, AppEvent::FetchModels { .. }))
        );
        if explicit_all_models {
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
            chat.open_all_models_popup();
        }

        apply_model_list_response(&mut chat, refreshed.clone());
        if hidden_startup {
            assert!(chat.no_modal_or_popup_active());
            chat.open_model_popup();
        }

        assert_eq!(chat.model_catalog.try_list_models().unwrap(), refreshed);
        insta::allow_duplicates! {
            assert_chatwidget_snapshot!(
                if explicit_all_models {
                    "model_selection_popup"
                } else {
                    "model_picker_refreshes_auto_models"
                },
                render_bottom_popup(&chat, /*width*/ 80)
            );
        }
    }
}

#[tokio::test]
async fn model_picker_queued_all_models_uses_refreshed_catalog() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let refreshed = chat.model_catalog.try_list_models().unwrap();
    let preset = get_available_model(&chat, "gpt-5.5");
    let mut auto = preset.clone();
    auto.model = "codex-auto-test".to_string();
    auto.id = auto.model.clone();
    chat.model_catalog = Arc::new(ModelCatalog::new(vec![auto, preset]));
    chat.open_model_popup();
    assert_matches!(rx.try_recv(), Ok(AppEvent::FetchModels { .. }));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert_eq!(chat.bottom_pane.active_view_id(), None);
    // Apply the model/list reply before the queued All models intent is handled.
    apply_model_list_response(&mut chat, refreshed);
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenAllModelsPopup));
    chat.open_all_models_popup();
    assert_chatwidget_snapshot!(
        "model_selection_popup",
        render_bottom_popup(&chat, /*width*/ 80)
    );
}

#[tokio::test]
async fn model_picker_refresh_preserves_highlight() {
    for (remove_selected, reasoning_submenu, expected) in [
        (false, false, "gpt-5.6-terra"),
        (true, false, "gpt-5.5"),
        (false, true, "gpt-5.6-terra"),
        (true, true, "gpt-5.5"),
    ] {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        let mut presets = vec![
            get_available_model(&chat, "gpt-5.5"),
            get_available_model(&chat, "gpt-5.6-terra"),
        ];
        for preset in &mut presets {
            preset.display_name = "Shared display name".to_string();
        }
        chat.model_catalog = Arc::new(ModelCatalog::new(presets.clone()));
        chat.open_model_popup();
        chat.handle_key_event(KeyEvent::from(KeyCode::Down));
        if reasoning_submenu {
            chat.open_reasoning_popup(presets[1].clone());
        }
        let before = render_bottom_popup(&chat, /*width*/ 80);
        presets.reverse();
        presets[0].display_name = "Renamed model".to_string();
        if remove_selected {
            presets.remove(/*index*/ 0);
        }
        apply_model_list_response(&mut chat, presets);
        if reasoning_submenu {
            assert_eq!(render_bottom_popup(&chat, /*width*/ 80), before);
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        }
        if !remove_selected {
            insta::allow_duplicates! {
                assert_chatwidget_snapshot!(
                    "model_picker_refresh_preserves_highlight",
                    render_bottom_popup(&chat, /*width*/ 80)
                );
            }
        }
        while rx.try_recv().is_ok() {}
        chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
        let selected = assert_matches!(rx.try_recv(), Ok(AppEvent::OpenReasoningPopup { model }) => model.model);
        assert_eq!(selected, expected);
    }
}

#[tokio::test]
async fn model_picker_refreshes_service_tier_controls() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.4")).await;
    chat.thread_id = Some(ThreadId::new());
    set_fast_mode_test_catalog(&mut chat);
    chat.set_feature_enabled(Feature::FastMode, /*enabled*/ true);
    chat.set_service_tier(Some(ServiceTier::Fast.request_value().to_string()));
    let mut refreshed = chat.model_catalog.try_list_models().unwrap();
    refreshed
        .iter_mut()
        .for_each(|model| model.service_tiers.clear());
    chat.open_model_popup();
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));

    apply_model_list_response(&mut chat, refreshed);

    assert_eq!(chat.current_service_tier(), None);
    chat.bottom_pane
        .set_composer_text("/fast".to_string(), Vec::new(), Vec::new());
    assert_chatwidget_snapshot!(
        "model_picker_refreshes_service_tier_controls",
        normalize_snapshot_paths(render_bottom_popup(&chat, /*width*/ 80))
    );
}

#[tokio::test]
async fn model_picker_refresh_preserves_dismissal_and_reasoning_submenu() {
    for (dismiss, explicit_all_models, accept_reasoning) in [
        (true, false, false),
        (false, false, false),
        (false, true, false),
        (false, false, true),
        (false, true, true),
    ] {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        let preset = get_available_model(&chat, "gpt-5.5");
        let refreshed = chat.model_catalog.try_list_models().unwrap();
        chat.model_catalog = Arc::new(ModelCatalog::new(vec![preset.clone()]));
        chat.open_model_popup();
        assert_matches!(rx.try_recv(), Ok(AppEvent::FetchModels { .. }));
        if explicit_all_models {
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
            chat.open_all_models_popup();
        }
        if dismiss {
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        } else {
            chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
            let model =
                assert_matches!(rx.try_recv(), Ok(AppEvent::OpenReasoningPopup { model }) => model);
            chat.open_reasoning_popup(model);
        }
        let before = render_bottom_popup(&chat, /*width*/ 80);

        apply_model_list_response(&mut chat, refreshed.clone());

        assert_eq!(chat.model_catalog.try_list_models().unwrap(), refreshed);
        assert_eq!(render_bottom_popup(&chat, /*width*/ 80), before);
        if !dismiss {
            chat.handle_key_event(KeyEvent::from(if accept_reasoning {
                KeyCode::Enter
            } else {
                KeyCode::Esc
            }));
        }
        if dismiss || accept_reasoning {
            assert!(chat.no_modal_or_popup_active());
        } else {
            insta::allow_duplicates! {
                assert_chatwidget_snapshot!(
                    "model_selection_popup",
                    render_bottom_popup(&chat, /*width*/ 80)
                );
            }
        }
    }
}

#[tokio::test]
async fn model_picker_refresh_dismisses_empty_choices() {
    for (explicit_all_models, reasoning_submenu) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        let mut preset = get_available_model(&chat, "gpt-5.5");
        chat.open_model_popup();
        if explicit_all_models {
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
            chat.open_all_models_popup();
        }
        if reasoning_submenu {
            chat.open_reasoning_popup(preset.clone());
        }
        let before = render_bottom_popup(&chat, /*width*/ 80);
        if explicit_all_models {
            preset.model = "codex-auto-test".to_string();
        } else {
            preset.show_in_picker = false;
        }
        while rx.try_recv().is_ok() {}
        apply_model_list_response(&mut chat, vec![preset]);
        if reasoning_submenu {
            assert_eq!(render_bottom_popup(&chat, /*width*/ 80), before);
            chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
        }
        assert_eq!(chat.bottom_pane.active_view_id(), None);
        let cell = assert_matches!(rx.try_recv(), Ok(AppEvent::InsertHistoryCell(cell)) => cell);
        insta::allow_duplicates! {
            insta::assert_snapshot!(
                lines_to_single_string(&cell.display_lines(/*width*/ 80)),
                @"• No additional models are available right now."
            );
        }
    }
}

#[tokio::test]
async fn skills_menu_default_mentions_shortcut_snapshot() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.open_skills_menu();

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("skills_menu_default_mentions_shortcut", popup);
}

#[tokio::test]
async fn model_picker_hides_show_in_picker_false_models_from_cache() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("test-visible-model")).await;
    chat.thread_id = Some(ThreadId::new());
    let preset = |slug: &str, show_in_picker: bool| ModelPreset {
        id: slug.to_string(),
        model: slug.to_string(),
        display_name: slug.to_string(),
        description: format!("{slug} description"),
        model_specialty: None,
        default_reasoning_effort: ReasoningEffortConfig::Medium,
        supported_reasoning_efforts: vec![ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Medium,
            description: "medium".to_string(),
        }],
        supports_personality: false,
        additional_speed_tiers: Vec::new(),
        service_tiers: Vec::new(),
        default_service_tier: None,
        available_access_programs: None,
        is_default: false,
        upgrade: None,
        show_in_picker,
        multi_agent_version: None,
        availability_nux: None,
        supported_in_api: true,
        input_modalities: default_input_modalities(),
    };

    chat.open_model_popup_with_presets(vec![
        preset("test-visible-model", true),
        preset("test-hidden-model", false),
    ]);
    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("model_picker_filters_hidden_models", popup);
    assert!(
        popup.contains("test-visible-model"),
        "expected visible model to appear in picker:\n{popup}"
    );
    assert!(
        !popup.contains("test-hidden-model"),
        "expected hidden model to be excluded from picker:\n{popup}"
    );
}

#[tokio::test]
async fn server_overloaded_error_does_not_switch_models() {
    let (mut chat, mut rx, mut op_rx) = make_chatwidget_manual(Some("gpt-5.2")).await;
    chat.set_model("gpt-5.2");
    while rx.try_recv().is_ok() {}
    while op_rx.try_recv().is_ok() {}

    handle_error(
        &mut chat,
        "server overloaded",
        Some(CodexErrorInfo::ServerOverloaded),
    );

    while let Ok(event) = rx.try_recv() {
        if let AppEvent::UpdateModel(model) = event {
            assert_eq!(
                model, "gpt-5.2",
                "did not expect model switch on server-overloaded error"
            );
        }
    }

    while let Ok(event) = op_rx.try_recv() {
        if let Op::OverrideTurnContext { model, .. } = event {
            assert!(
                model.is_none(),
                "did not expect OverrideTurnContext model update on server-overloaded error"
            );
        }
    }
}

#[tokio::test]
async fn model_reasoning_selection_popup_snapshot() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;

    set_chatgpt_auth(&mut chat);
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::High));

    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.supported_reasoning_efforts.insert(
        2,
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Max,
            description: "Maximum available reasoning".to_string(),
        },
    );
    preset
        .supported_reasoning_efforts
        .push(ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Ultra,
            description: "Ultra reasoning".to_string(),
        });
    preset
        .supported_reasoning_efforts
        .push(ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Persistent,
            description: "Continue working until put to sleep".to_string(),
        });
    chat.open_reasoning_popup(preset);

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("model_reasoning_selection_popup", popup);
}

#[tokio::test]
async fn model_advanced_reasoning_selection_popup_snapshot() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::Ultra));

    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.supported_reasoning_efforts.extend([
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Ultra,
            description: "Ultra reasoning".to_string(),
        },
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Max,
            description: "Maximum available reasoning".to_string(),
        },
    ]);
    chat.open_advanced_reasoning_popup(preset);

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("model_advanced_reasoning_selection_popup", popup);
}

#[tokio::test]
async fn model_reasoning_selection_popup_applies_custom_effort() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let custom_effort = ReasoningEffortConfig::Custom("future".to_string());
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::XHigh));

    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset
        .supported_reasoning_efforts
        .push(ReasoningEffortPreset {
            effort: custom_effort.clone(),
            description: "Maximum available reasoning".to_string(),
        });
    chat.open_reasoning_popup(preset);
    while rx.try_recv().is_ok() {}

    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let selected_effort_events = std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::UpdateReasoningEffort(effort) => Some((None, effort)),
            AppEvent::PersistModelSelection { model, effort } => Some((Some(model), effort)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        selected_effort_events,
        vec![
            (None, Some(custom_effort.clone())),
            (Some("gpt-5.5".to_string()), Some(custom_effort)),
        ]
    );
}

async fn select_ultra_with_multi_agent_thread_limit(max_threads: usize) -> (bool, Vec<String>) {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.config
        .multi_agent_v2
        .max_concurrent_threads_per_session = max_threads;
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::High));

    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.default_reasoning_effort = ReasoningEffortConfig::High;
    preset.supported_reasoning_efforts = vec![
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::High,
            description: "High reasoning".to_string(),
        },
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Ultra,
            description: "Ultra reasoning".to_string(),
        },
    ];
    chat.open_reasoning_popup(preset);
    while rx.try_recv().is_ok() {}

    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let advanced_preset = std::iter::from_fn(|| rx.try_recv().ok()).find_map(|event| match event {
        AppEvent::OpenAdvancedReasoningPopup { model } => Some(model),
        _ => None,
    });
    chat.open_advanced_reasoning_popup(advanced_preset.expect("advanced reasoning popup"));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let mut selected_ultra = false;
    let mut warnings = Vec::new();
    while let Ok(event) = rx.try_recv() {
        match event {
            AppEvent::ApplyAdvancedReasoning {
                effort: ReasoningEffortConfig::Ultra,
                ..
            } => {
                selected_ultra = true;
            }
            AppEvent::InsertHistoryCell(cell) => {
                warnings.push(lines_to_single_string(&cell.transcript_lines(/*width*/ 80)));
            }
            _ => {}
        }
    }

    (selected_ultra, warnings)
}

#[tokio::test]
async fn ultra_reasoning_selection_warns_for_high_multi_agent_concurrency() {
    let (selected_ultra, warnings) =
        select_ultra_with_multi_agent_thread_limit(/*max_threads*/ 8).await;

    assert!(selected_ultra);
    assert_eq!(warnings.len(), 1);
    assert_chatwidget_snapshot!(
        "ultra_reasoning_selection_high_multi_agent_concurrency_warning",
        &warnings[0]
    );
}

#[tokio::test]
async fn ultra_reasoning_selection_skips_warning_below_threshold() {
    let below_threshold = select_ultra_with_multi_agent_thread_limit(/*max_threads*/ 7).await;

    assert_eq!(below_threshold, (true, Vec::new()));
}

#[tokio::test]
async fn max_reasoning_selection_persists_model_selection() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::High));

    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.supported_reasoning_efforts = vec![ReasoningEffortPreset {
        effort: ReasoningEffortConfig::Max,
        description: "Maximum reasoning".to_string(),
    }];
    chat.open_advanced_reasoning_popup(preset);
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::UpdateReasoningEffort(Some(ReasoningEffortConfig::Max))
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::PersistModelSelection {
            model,
            effort: Some(ReasoningEffortConfig::Max),
        } if model == "gpt-5.5"
    )));
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::ApplyAdvancedReasoning { .. }))
    );
}

async fn assert_reasoning_shortcuts_update_effort(
    key_events: [KeyEvent; 2],
    expected_effort: ReasoningEffortConfig,
) {
    for key_event in key_events {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        chat.set_reasoning_effort(Some(ReasoningEffortConfig::Medium));

        chat.handle_key_event(key_event);

        let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, AppEvent::UpdateModel(_))),
            "did not expect model update event for {key_event:?}; events: {events:?}"
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                AppEvent::UpdateReasoningEffort(Some(effort)) if effort == &expected_effort
            )),
            "expected reasoning update event for {key_event:?}; events: {events:?}"
        );
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, AppEvent::PersistModelSelection { .. })),
            "expected no model persistence event for {key_event:?}; events: {events:?}"
        );
    }
}

#[tokio::test]
async fn reasoning_up_shortcuts_raise_reasoning_effort() {
    assert_reasoning_shortcuts_update_effort(
        [
            KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT),
            KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT),
        ],
        ReasoningEffortConfig::High,
    )
    .await;
}

#[tokio::test]
async fn reasoning_down_shortcuts_lower_reasoning_effort() {
    assert_reasoning_shortcuts_update_effort(
        [
            KeyEvent::new(KeyCode::Char(','), KeyModifiers::ALT),
            KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT),
        ],
        ReasoningEffortConfig::Low,
    )
    .await;
}

#[tokio::test]
async fn reasoning_shortcut_clears_armed_quit_shortcut() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::Medium));
    chat.arm_quit_shortcut(key_hint::ctrl(KeyCode::Char('c')));

    chat.handle_key_event(KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT));

    assert!(!chat.bottom_pane.quit_shortcut_hint_visible());
    assert!(chat.quit_shortcut_expires_at.is_none());
    assert!(chat.quit_shortcut_key.is_none());
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::Exit(_))),
        "did not expect reasoning shortcut to quit; events: {events:?}"
    );
}

#[tokio::test]
async fn reasoning_shortcut_is_ignored_with_model_popup_open() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::Medium));
    chat.open_model_popup();

    chat.handle_key_event(KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT));

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::UpdateReasoningEffort(_))),
        "did not expect reasoning update while popup is active; events: {events:?}"
    );
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, AppEvent::PersistModelSelection { .. })),
        "did not expect model persistence while popup is active; events: {events:?}"
    );
}

#[tokio::test]
async fn reasoning_up_shortcuts_reach_max_in_default_and_plan_modes() {
    for plan_mode in [false, true] {
        for key in [
            KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT),
            KeyEvent::new(KeyCode::Up, KeyModifiers::SHIFT),
        ] {
            let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
            chat.thread_id = Some(ThreadId::new());
            chat.show_welcome_banner = false;
            chat.local_settings.tui.status_line = Some(vec!["model-with-reasoning".to_string()]);
            let mut preset = get_available_model(&chat, "gpt-5.5");
            preset
                .supported_reasoning_efforts
                .push(ReasoningEffortPreset {
                    effort: ReasoningEffortConfig::Max,
                    description: "Maximum reasoning".to_string(),
                });
            if plan_mode {
                chat.set_feature_enabled(Feature::CollaborationModes, /*enabled*/ true);
                let plan_mask = collaboration_modes::plan_mask(chat.model_catalog.as_ref())
                    .expect("expected plan collaboration mode");
                chat.set_collaboration_mask(plan_mask);
            }
            chat.model_catalog = std::sync::Arc::new(ModelCatalog::new(vec![preset]));
            if plan_mode {
                chat.set_plan_mode_reasoning_effort(Some(ReasoningEffortConfig::XHigh));
            } else {
                chat.set_reasoning_effort(Some(ReasoningEffortConfig::XHigh));
            }

            chat.handle_key_event(key);

            let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            let update = events
                .into_iter()
                .find(|event| {
                    matches!(
                        (plan_mode, event),
                        (
                            false,
                            AppEvent::UpdateReasoningEffort(Some(ReasoningEffortConfig::Max))
                        ) | (
                            true,
                            AppEvent::UpdatePlanModeReasoningEffort(Some(
                                ReasoningEffortConfig::Max
                            ))
                        )
                    )
                })
                .expect("expected max reasoning update");
            match update {
                AppEvent::UpdateReasoningEffort(effort) => chat.set_reasoning_effort(effort),
                AppEvent::UpdatePlanModeReasoningEffort(effort) => {
                    chat.set_plan_mode_reasoning_effort(effort)
                }
                _ => unreachable!(),
            }

            if key.code == KeyCode::Char('.') {
                let width = 80;
                let height = chat.desired_height(width);
                let mut terminal =
                    ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height))
                        .expect("create terminal");
                terminal
                    .draw(|frame| chat.render(frame.area(), frame.buffer_mut()))
                    .expect("draw footer");
                let snapshot = normalized_backend_snapshot(terminal.backend());
                if plan_mode {
                    assert_chatwidget_snapshot!("reasoning_shortcut_max_plan_footer", snapshot);
                } else {
                    assert_chatwidget_snapshot!("reasoning_shortcut_max_footer", snapshot);
                }
            }
        }
    }
}

#[tokio::test]
async fn reasoning_up_shortcut_does_not_silently_enter_ultra() {
    for (model, model_path) in [
        ("gpt-5.5", "All models → gpt-5.5"),
        ("codex-auto-test", "codex-auto-test"),
    ] {
        let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        let mut preset = get_available_model(&chat, "gpt-5.5");
        preset.id = model.to_string();
        preset.model = model.to_string();
        preset.display_name = model.to_string();
        preset.supported_reasoning_efforts.extend([
            ReasoningEffortPreset {
                effort: ReasoningEffortConfig::Max,
                description: "Maximum reasoning".to_string(),
            },
            ReasoningEffortPreset {
                effort: ReasoningEffortConfig::Ultra,
                description: "Ultra reasoning".to_string(),
            },
        ]);
        chat.model_catalog = std::sync::Arc::new(ModelCatalog::new(vec![preset]));
        chat.set_model(model);

        chat.set_reasoning_effort(Some(ReasoningEffortConfig::Max));
        chat.handle_key_event(KeyEvent::new(KeyCode::Char('.'), KeyModifiers::ALT));

        let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().all(|event| !matches!(
            event,
            AppEvent::UpdateReasoningEffort(_) | AppEvent::ApplyAdvancedReasoning { .. }
        )));
        let messages = events
            .into_iter()
            .filter_map(|event| match event {
                AppEvent::InsertHistoryCell(cell) => {
                    Some(lines_to_single_string(&cell.display_lines(/*width*/ 140)))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        insta::allow_duplicates! {
            insta::assert_snapshot!(
                messages.join("").replace(model_path, "<model path>"),
                @"• Ultra is available under /model → <model path> → More reasoning…"
            );
        }
    }
}

#[tokio::test]
async fn reasoning_down_shortcut_can_leave_advanced_effort() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.supported_reasoning_efforts.extend([
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Ultra,
            description: "Ultra reasoning".to_string(),
        },
        ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Max,
            description: "Maximum reasoning".to_string(),
        },
    ]);
    chat.model_catalog = std::sync::Arc::new(ModelCatalog::new(vec![preset]));

    for (current, expected) in [
        (ReasoningEffortConfig::Ultra, ReasoningEffortConfig::Max),
        (ReasoningEffortConfig::Max, ReasoningEffortConfig::XHigh),
    ] {
        chat.set_reasoning_effort(Some(current));
        chat.handle_key_event(KeyEvent::new(KeyCode::Char(','), KeyModifiers::ALT));

        let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            event,
            AppEvent::UpdateReasoningEffort(Some(effort)) if effort == &expected
        )));
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, AppEvent::PersistModelSelection { .. }))
        );
    }
}

#[tokio::test]
async fn reasoning_popup_shows_extra_high_with_space() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;

    set_chatgpt_auth(&mut chat);

    let preset = get_available_model(&chat, "gpt-5.5");
    chat.open_reasoning_popup(preset);

    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(
        popup.contains("Extra high"),
        "expected popup to include 'Extra high'; popup: {popup}"
    );
    assert!(
        !popup.contains("Extrahigh"),
        "expected popup not to include 'Extrahigh'; popup: {popup}"
    );
}

#[tokio::test]
async fn single_reasoning_option_skips_selection() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    let single_effort = vec![ReasoningEffortPreset {
        effort: ReasoningEffortConfig::High,
        description: "Greater reasoning depth for complex or ambiguous problems".to_string(),
    }];
    let preset = ModelPreset {
        id: "model-with-single-reasoning".to_string(),
        model: "model-with-single-reasoning".to_string(),
        display_name: "model-with-single-reasoning".to_string(),
        description: "".to_string(),
        model_specialty: None,
        default_reasoning_effort: ReasoningEffortConfig::High,
        supported_reasoning_efforts: single_effort,
        supports_personality: false,
        additional_speed_tiers: Vec::new(),
        service_tiers: Vec::new(),
        default_service_tier: None,
        available_access_programs: None,
        is_default: false,
        upgrade: None,
        show_in_picker: true,
        multi_agent_version: None,
        availability_nux: None,
        supported_in_api: true,
        input_modalities: default_input_modalities(),
    };
    chat.open_reasoning_popup(preset);

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert!(
        !popup.contains("Select Reasoning Level"),
        "expected reasoning selection popup to be skipped"
    );

    let mut events = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        events.push(ev);
    }

    assert!(
        events
            .iter()
            .any(|ev| matches!(ev, AppEvent::UpdateReasoningEffort(Some(effort)) if *effort == ReasoningEffortConfig::High)),
        "expected reasoning effort to be applied automatically; events: {events:?}"
    );
}

#[tokio::test]
async fn advanced_only_reasoning_option_requires_explicit_selection() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let mut preset = get_available_model(&chat, "gpt-5.5");
    preset.default_reasoning_effort = ReasoningEffortConfig::Ultra;
    preset.supported_reasoning_efforts = vec![ReasoningEffortPreset {
        effort: ReasoningEffortConfig::Ultra,
        description: "Ultra reasoning".to_string(),
    }];
    chat.open_reasoning_popup(preset);

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("advanced_only_reasoning_selection_popup", popup);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().all(|event| !matches!(
        event,
        AppEvent::UpdateReasoningEffort(_)
            | AppEvent::ApplyAdvancedReasoning { .. }
            | AppEvent::PersistModelSelection { .. }
    )));
}

#[tokio::test]
async fn auto_model_advertising_advanced_effort_opens_reasoning_picker() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let mut preset = get_available_model(&chat, "gpt-5.6-terra");
    preset.id = "codex-auto-test".to_string();
    preset.model = "codex-auto-test".to_string();
    preset.display_name = "codex-auto-test".to_string();
    preset.default_reasoning_effort = ReasoningEffortConfig::Medium;
    preset
        .supported_reasoning_efforts
        .push(ReasoningEffortPreset {
            effort: ReasoningEffortConfig::Ultra,
            description: "Ultra reasoning".to_string(),
        });
    chat.open_model_popup_with_presets(vec![preset]);

    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(events.iter().all(|event| !matches!(
        event,
        AppEvent::UpdateReasoningEffort(_)
            | AppEvent::ApplyAdvancedReasoning { .. }
            | AppEvent::PersistModelSelection { .. }
    )));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AppEvent::OpenReasoningPopup { .. }))
    );
}

#[tokio::test]
async fn reasoning_popup_escape_returns_to_model_popup() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    chat.open_model_popup();

    let preset = get_available_model(&chat, "gpt-5.5");
    chat.open_reasoning_popup(preset);

    let before_escape = render_bottom_popup(&chat, /*width*/ 80);
    assert!(before_escape.contains("Select Reasoning Level"));

    chat.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    let after_escape = render_bottom_popup(&chat, /*width*/ 80);
    assert!(after_escape.contains("Choose a mind"));
    assert!(!after_escape.contains("Select Reasoning Level"));
}

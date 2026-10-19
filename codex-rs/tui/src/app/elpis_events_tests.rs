//! Evals for `/yolo`: Full Access for this chat, saved as the default for future chats.

use super::*;
use crate::app::tests::make_test_app_with_channels;
use pretty_assertions::assert_eq;
use tempfile::tempdir;

const RESTRICTED_HOME: &str =
    "sandbox_mode = \"workspace-write\"\napproval_policy = \"on-request\"\n";

async fn config_for_new_chat(home: &std::path::Path, project: &std::path::Path) -> Result<Config> {
    Ok(ConfigBuilder::default()
        .codex_home(home.to_path_buf())
        .harness_overrides(ConfigOverrides {
            cwd: Some(project.to_path_buf()),
            ..Default::default()
        })
        .loader_overrides(LoaderOverrides::without_managed_config_for_tests())
        .build()
        .await?)
}

fn is_full_access(config: &Config) -> bool {
    AskForApproval::from(config.permissions.approval_policy.value()) == AskForApproval::Never
        && config
            .permissions
            .active_permission_profile()
            .is_some_and(|profile| profile.id == BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS)
}

fn history_text(events: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> String {
    std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::InsertHistoryCell(cell) => Some(
                cell.display_lines(/*width*/ 120)
                    .into_iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn yolo_switches_this_chat_and_saves_full_access_for_future_chats() -> Result<()> {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let home = tempdir()?;
    let project = tempdir()?;
    std::fs::write(home.path().join("config.toml"), RESTRICTED_HOME)?;
    app.config = config_for_new_chat(home.path(), project.path()).await?;
    let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let started = server.start_thread(&app.config).await?;
    let thread_id = started.session.thread_id;
    app.enqueue_primary_thread_session(started.session, started.turns)
        .await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    while events.try_recv().is_ok() {}

    app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::Elpis(ElpisAppEvent::EnableYolo),
    )
    .await?;

    // Negative: the chat keeps its permissions until the engine acknowledges the change.
    assert!(
        !is_full_access(app.chat_widget.config_ref()),
        "Full Access must wait for the engine"
    );
    assert!(
        app.agents_overview
            .requested_permission_profiles
            .contains_key(&thread_id)
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("config.toml"))?,
        RESTRICTED_HOME,
        "an unconfirmed request must not change future chats"
    );
    // Positive: the engine's acknowledgement switches this chat to Full Access.
    let settings = crate::app::tests::next_thread_settings_updated(&mut server, thread_id).await;
    app.enqueue_thread_notification(
        thread_id,
        codex_app_server_protocol::ServerNotification::ThreadSettingsUpdated(settings),
    )
    .await?;
    assert!(
        is_full_access(app.chat_widget.config_ref()),
        "this chat should now run with Full Access"
    );
    let fresh = config_for_new_chat(home.path(), project.path()).await?;
    assert!(
        is_full_access(&fresh),
        "a new chat should start with Full Access"
    );
    let history = history_text(&mut events);
    assert!(
        history.contains("Permission selection requested: Full Access"),
        "history: {history}"
    );
    assert!(
        history.contains("Full Access saved as the default for future chats."),
        "history: {history}"
    );
    // Reselecting already confirmed Full Access emits no new snapshot but still saves the default.
    std::fs::write(home.path().join("config.toml"), RESTRICTED_HOME)?;
    app.enable_yolo(&mut server).await;
    assert!(is_full_access(
        &config_for_new_chat(home.path(), project.path()).await?
    ));
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn yolo_does_not_save_disconnected_rejected_or_superseded_choices() -> Result<()> {
    for case in ["disconnected", "rejected", "superseded"] {
        let (mut app, mut events, _ops) = make_test_app_with_channels().await;
        let home = tempdir()?;
        let project = tempdir()?;
        let file = home.path().join("config.toml");
        std::fs::write(&file, RESTRICTED_HOME)?;
        app.config = config_for_new_chat(home.path(), project.path()).await?;
        let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
        let thread_id = if case == "disconnected" {
            assert!(app.chat_widget.thread_id().is_none());
            None
        } else {
            let started = server.start_thread(&app.config).await?;
            let thread_id = started.session.thread_id;
            app.enqueue_primary_thread_session(started.session, started.turns)
                .await?;
            if case == "rejected" {
                // The replacement server has not loaded this thread, so it rejects its update.
                server.shutdown().await?;
                server = crate::start_embedded_app_server_for_picker(&app.config).await?;
            }
            Some(thread_id)
        };
        while events.try_recv().is_ok() {}
        app.enable_yolo(&mut server).await;
        assert_eq!(std::fs::read_to_string(&file)?, RESTRICTED_HOME, "{case}");
        if case == "superseded" {
            let thread_id = thread_id.expect("connected case");
            assert!(
                app.select_permission_profile(
                    &mut server,
                    PermissionProfileSelection {
                        profile_id: ":read-only".to_string(),
                        approval_policy: Some(AskForApproval::OnRequest),
                        approvals_reviewer: Some(ApprovalsReviewer::User),
                        display_label: "Read Only".to_string(),
                    }
                )
                .await
            );
            for _ in 0..2 {
                let settings =
                    crate::app::tests::next_thread_settings_updated(&mut server, thread_id).await;
                app.enqueue_thread_notification(
                    thread_id,
                    codex_app_server_protocol::ServerNotification::ThreadSettingsUpdated(settings),
                )
                .await?;
                assert_eq!(
                    std::fs::read_to_string(&file)?,
                    RESTRICTED_HOME,
                    "a superseded Full Access snapshot must not save"
                );
            }
            assert!(!is_full_access(app.chat_widget.config_ref()));
        } else {
            let history = history_text(&mut events);
            let expected = if case == "disconnected" {
                "Wait for the task to connect"
            } else {
                "Failed to select permissions"
            };
            assert!(history.contains(expected), "{case}: {history}");
            assert!(!history.contains("Full Access saved"), "{case}: {history}");
        }
        assert!(!is_full_access(
            &config_for_new_chat(home.path(), project.path()).await?
        ));
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn without_yolo_a_restricted_home_stays_restricted() -> Result<()> {
    let home = tempdir()?;
    let project = tempdir()?;
    std::fs::write(home.path().join("config.toml"), RESTRICTED_HOME)?;

    let fresh = config_for_new_chat(home.path(), project.path()).await?;

    assert!(!is_full_access(&fresh));
    assert_eq!(
        std::fs::read_to_string(home.path().join("config.toml"))?,
        RESTRICTED_HOME
    );
    Ok(())
}

/// Positive: `/memory-model <id>` saves the background model for this chat and future chats.
/// Negative: `/memory-model default` removes it again, so new chats keep the built-in default.
#[tokio::test]
async fn memory_model_saves_the_background_model_for_this_and_future_chats() -> Result<()> {
    use crate::elpis_background_model::BackgroundModelChoice;
    const MODEL: &str = "ELPIS_BACKGROUND_MODEL_3c90";
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let home = tempdir()?;
    let project = tempdir()?;
    app.config = config_for_new_chat(home.path(), project.path()).await?;
    let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;

    app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(BackgroundModelChoice {
            model: Some(MODEL.to_string()),
            provider: None,
        })),
    )
    .await?;

    assert_eq!(
        app.chat_widget.config_ref().background_model.as_deref(),
        Some(MODEL)
    );
    assert_eq!(app.config.background_model.as_deref(), Some(MODEL));
    let fresh = config_for_new_chat(home.path(), project.path()).await?;
    assert_eq!(fresh.background_model.as_deref(), Some(MODEL));
    let history = history_text(&mut events);
    assert!(
        history.contains(&format!("Background model saved: {MODEL}.")),
        "history: {history}"
    );

    app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(BackgroundModelChoice {
            model: None,
            provider: Some(None),
        })),
    )
    .await?;

    assert_eq!(app.chat_widget.config_ref().background_model, None);
    let fresh = config_for_new_chat(home.path(), project.path()).await?;
    assert_eq!(fresh.background_model, None);
    assert_eq!(fresh.background_provider, None);
    server.shutdown().await?;
    Ok(())
}

/// One HTTP exchange with the running dashboard server.
fn dashboard_http(port: u16, request_head: &str, body: &str) -> String {
    use std::io::Read;
    use std::io::Write;
    let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).expect("dashboard accepts");
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(60)))
        .expect("read timeout");
    write!(
        socket,
        "{request_head}\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("write request");
    let mut response = String::new();
    socket.read_to_string(&mut response).expect("read response");
    response
}

/// Positive: a background model picked on the dashboard's Models tab goes through the real
/// server and the App's `/memory-model` writer: config.toml keeps it, this chat uses it, and the
/// next poll of `/data.json` shows it. Negative: before the pick the page shows the built-in
/// default.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_model_picked_on_the_dashboard_is_saved_and_shown() -> Result<()> {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let home = tempdir()?;
    let project = tempdir()?;
    app.config = config_for_new_chat(home.path(), project.path()).await?;
    let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    let model = crate::test_support::TEST_MODEL_PRESETS
        .iter()
        .find(|preset| preset.show_in_picker)
        .expect("a visible preset")
        .model
        .clone();
    let url = crate::dashboard_server::ensure_running().expect("dashboard server");
    let (address, token) = url.split_once("#evidence=").expect("token in the address");
    let port: u16 = address
        .trim_start_matches("http://127.0.0.1:")
        .parse()
        .expect("port");
    let provider = app.chat_widget.config_ref().model_provider_id.clone();
    assert_eq!(app.chat_widget.dashboard_models().background.model, None);

    app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::Elpis(ElpisAppEvent::RefreshDashboard),
    )
    .await?;
    let answer = tokio::task::spawn_blocking({
        let body = format!(r#"{{"role":"background","provider":"{provider}","model":"{model}"}}"#);
        let head = format!("POST /models/{token} HTTP/1.1");
        move || dashboard_http(port, &head, &body)
    })
    .await?;
    assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");

    while let Ok(event) = events.try_recv() {
        app.handle_event(&mut tui, &mut server, event).await?;
    }
    assert_eq!(
        app.chat_widget.config_ref().background_model.as_deref(),
        Some(model.as_str())
    );
    let fresh = config_for_new_chat(home.path(), project.path()).await?;
    assert_eq!(fresh.background_model.as_deref(), Some(model.as_str()));
    assert_eq!(
        fresh.background_provider.as_deref(),
        Some(provider.as_str())
    );

    let data =
        tokio::task::spawn_blocking(move || dashboard_http(port, "GET /data.json HTTP/1.1", ""))
            .await?;
    let json = data
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();
    let state: serde_json::Value = serde_json::from_str(json).expect("data.json");
    assert_eq!(
        state["state"]["context"]["models"]["background"],
        serde_json::json!({ "provider": provider, "model": model })
    );
    server.shutdown().await?;
    Ok(())
}

use super::*;
use codex_app_server_client::AppServerClient;

#[tokio::test]
async fn config_routes_bare_and_section_commands_without_changing_settings_alias() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.dispatch_command(SlashCommand::Config);
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenConfigPanel(None)));

    chat.dispatch_command_with_args(SlashCommand::Config, "permissions".to_string(), Vec::new());
    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenConfigPanel(Some(section))) if section == "permissions");

    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command(SlashCommand::Experimental);
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::FetchExperimentalFeatures { .. })
    );
}

#[tokio::test]
async fn config_escape_restores_composer_draft() -> color_eyre::Result<()> {
    let home = tempfile::tempdir()?;
    let config = ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .build()
        .await?;
    let server =
        AppServerClient::InProcess(crate::tests::start_test_embedded_app_server(config).await?);
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.bottom_pane
        .set_composer_text("draft for later".to_string(), Vec::new(), Vec::new());
    chat.open_config_panel(server.request_handle(), None);
    chat.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    assert_eq!(chat.bottom_pane.composer_text(), "draft for later");
    assert!(chat.bottom_pane.no_modal_or_popup_active());
    Ok(())
}

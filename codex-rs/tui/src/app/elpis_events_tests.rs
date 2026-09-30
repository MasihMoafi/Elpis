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
    let mut tui = crate::tui::test_support::make_test_tui()?;

    app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::Elpis(ElpisAppEvent::EnableYolo),
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
        history.contains("Full Access saved as the default for future chats."),
        "history: {history}"
    );
    server.shutdown().await?;
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

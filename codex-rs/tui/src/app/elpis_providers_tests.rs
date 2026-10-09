//! Evals for input queued behind `/model` while a gateway provider's catalog loads.
//!
//! The catalog arrives through `ModelsLoaded` after the provider list has closed. The tests hold
//! that reply back, run the App events the picker really sends, and release the reply when they
//! choose, so the delay is deterministic. The lookup is a provider with no gateway route, which
//! fails at once without a network call; the successful reply is the test's own.

use super::*;
use crate::app::tests::make_test_app_with_channels;
use crate::app_command::AppCommand;
use crate::chatwidget::tests::helpers::render_bottom_popup;
use crate::elpis_app_event::ElpisAppEvent;
use codex_model_provider_info::ModelProviderInfo;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use pretty_assertions::assert_eq;

const GATEWAY: &str = codex_model_provider_info::OPENROUTER_PROVIDER_ID;

struct Fixture {
    app: Box<App>,
    events: tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
    ops: tokio::sync::mpsc::UnboundedReceiver<AppCommand>,
    server: AppServerSession,
    tui: tui::Tui,
    /// `ModelsLoaded` events taken off the channel but not yet delivered.
    held: Vec<AppEvent>,
}

impl Fixture {
    /// A running turn with `/model` and a follow-up queued behind it, then the turn completes:
    /// the provider list is open and the follow-up waits.
    async fn with_provider_list_open() -> Result<Self> {
        let (mut app, events, ops) = make_test_app_with_channels().await;
        // A provider with no gateway route: listing it fails at once, without the network.
        app.config.model_providers.insert(
            GATEWAY.to_string(),
            ModelProviderInfo {
                name: "Fixture gateway".to_string(),
                ..ModelProviderInfo::default()
            },
        );
        let mut server = crate::start_embedded_app_server_for_picker(&app.config).await?;
        let started = server.start_thread(&app.config).await?;
        let thread_id = started.session.thread_id;
        app.enqueue_primary_thread_session(started.session, started.turns)
            .await?;
        let mut fixture = Self {
            app,
            events,
            ops,
            server,
            tui: crate::tui::test_support::make_test_tui()?,
            held: Vec::new(),
        };
        fixture.notify(codex_app_server_protocol::ServerNotification::TurnStarted(
            codex_app_server_protocol::TurnStartedNotification {
                thread_id: thread_id.to_string(),
                turn: turn(codex_app_server_protocol::TurnStatus::InProgress),
            },
        ));
        fixture.queue("/model");
        fixture.queue("hello after catalog");
        fixture.notify(
            codex_app_server_protocol::ServerNotification::TurnCompleted(
                codex_app_server_protocol::TurnCompletedNotification {
                    thread_id: thread_id.to_string(),
                    turn: turn(codex_app_server_protocol::TurnStatus::Completed),
                },
            ),
        );
        assert!(
            fixture.popup().contains("Choose a provider"),
            "the queued /model should open the provider list:\n{}",
            fixture.popup()
        );
        assert!(fixture.app.chat_widget.has_queued_follow_up_messages());
        Ok(fixture)
    }

    fn notify(&mut self, notification: codex_app_server_protocol::ServerNotification) {
        self.app
            .chat_widget
            .handle_server_notification(notification, /*replay_kind*/ None);
    }

    fn queue(&mut self, text: &str) {
        self.app
            .chat_widget
            .restore_user_message_to_composer(text.into());
        self.key(KeyCode::Tab);
    }

    fn key(&mut self, code: KeyCode) {
        self.app
            .chat_widget
            .handle_key_event(KeyEvent::new(code, KeyModifiers::NONE));
    }

    fn popup(&self) -> String {
        render_bottom_popup(&self.app.chat_widget, /*width*/ 80)
    }

    /// Choose the second provider (the gateway one) in the provider list.
    async fn choose_the_gateway_provider(&mut self) -> Result<()> {
        self.key(KeyCode::Down);
        self.key(KeyCode::Enter);
        self.pump().await
    }

    /// Runs the App events the picker sends, as the event loop would, except the catalog reply,
    /// which is held back.
    async fn pump(&mut self) -> Result<()> {
        while let Ok(event) = self.events.try_recv() {
            match event {
                AppEvent::Elpis(ElpisAppEvent::Provider(ElpisProviderEvent::ModelsLoaded {
                    ..
                })) => self.held.push(event),
                AppEvent::Elpis(ElpisAppEvent::Provider(ElpisProviderEvent::Browse { .. }))
                | AppEvent::SettingsSelectionClosed
                | AppEvent::SettingsSelectionSettled => {
                    self.app
                        .handle_event(&mut self.tui, &mut self.server, event)
                        .await?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// The catalog lookup's own reply: its provider and the id it must carry.
    async fn catalog_reply(&mut self) -> (String, uuid::Uuid) {
        loop {
            if let Some(AppEvent::Elpis(ElpisAppEvent::Provider(
                ElpisProviderEvent::ModelsLoaded {
                    provider_id,
                    request_id,
                    ..
                },
            ))) = self.held.pop()
            {
                return (provider_id, request_id);
            }
            let event =
                tokio::time::timeout(std::time::Duration::from_secs(10), self.events.recv())
                    .await
                    .expect("the catalog lookup replies")
                    .expect("the event channel stays open");
            if matches!(
                event,
                AppEvent::Elpis(ElpisAppEvent::Provider(
                    ElpisProviderEvent::ModelsLoaded { .. }
                ))
            ) {
                self.held.push(event);
            }
        }
    }

    async fn deliver(
        &mut self,
        reply: &(String, uuid::Uuid),
        result: Result<Vec<codex_protocol::openai_models::ModelPreset>, String>,
    ) -> Result<()> {
        let event = AppEvent::Elpis(ElpisAppEvent::Provider(ElpisProviderEvent::ModelsLoaded {
            provider_id: reply.0.clone(),
            request_id: reply.1,
            result,
        }));
        self.app
            .handle_event(&mut self.tui, &mut self.server, event)
            .await?;
        self.pump().await
    }

    /// Whether the queued follow-up has been sent as a turn.
    fn follow_up_sent(&mut self) -> bool {
        std::iter::from_fn(|| self.ops.try_recv().ok())
            .any(|op| matches!(op, AppCommand::UserTurn { .. }))
    }

    fn follow_up_waits(&mut self) -> bool {
        self.app.chat_widget.has_queued_follow_up_messages() && !self.follow_up_sent()
    }
}

fn turn(status: codex_app_server_protocol::TurnStatus) -> codex_app_server_protocol::Turn {
    codex_app_server_protocol::Turn {
        id: "turn-1".to_string(),
        root_turn_id: None,
        items_view: codex_app_server_protocol::TurnItemsView::Full,
        items: Vec::new(),
        status,
        error: None,
        started_at: Some(0),
        completed_at: None,
        duration_ms: None,
    }
}

fn some_models(app: &App) -> Vec<codex_protocol::openai_models::ModelPreset> {
    app.model_catalog
        .try_list_models()
        .unwrap_or_default()
        .into_iter()
        .filter(|preset| preset.show_in_picker)
        .take(1)
        .collect()
}

/// Positive: between the provider list closing and the catalog arriving, a loading picker holds
/// the follow-up; the model list then replaces it and the follow-up still waits; picking a model
/// lets it go. Without the loading picker, `SettingsSelectionSettled` finds no popup open when
/// the provider list closes and sends the follow-up on the old model.
#[tokio::test]
async fn queued_input_waits_for_a_slow_catalog_and_for_the_pick() -> Result<()> {
    let mut fixture = Fixture::with_provider_list_open().await?;

    fixture.choose_the_gateway_provider().await?;
    assert!(
        fixture.popup().contains("Loading models…"),
        "no loading picker while the catalog is out:\n{}",
        fixture.popup()
    );
    assert!(
        fixture.follow_up_waits(),
        "the follow-up left before the catalog arrived"
    );

    let reply = fixture.catalog_reply().await;
    let models = some_models(&fixture.app);
    let name = models[0].display_name.clone();
    fixture.deliver(&reply, Ok(models)).await?;
    let popup = fixture.popup();
    assert!(
        popup.contains("Choose a mind") && popup.contains(&name),
        "{popup}"
    );
    assert!(
        fixture.follow_up_waits(),
        "the follow-up left while the model list was open"
    );

    fixture.key(KeyCode::Enter);
    fixture.pump().await?;
    assert!(
        fixture.follow_up_sent(),
        "picking a model should let the follow-up go"
    );
    Ok(())
}

/// A failed lookup shows its error as a picker; the follow-up waits for the owner to dismiss it,
/// then goes.
#[tokio::test]
async fn a_failed_lookup_lets_the_queue_continue_once_dismissed() -> Result<()> {
    let mut fixture = Fixture::with_provider_list_open().await?;
    fixture.choose_the_gateway_provider().await?;
    assert!(fixture.follow_up_waits());

    let reply = fixture.catalog_reply().await;
    fixture
        .deliver(&reply, Err("vendor unreachable".to_string()))
        .await?;
    assert!(
        fixture.popup().contains("vendor unreachable"),
        "{}",
        fixture.popup()
    );
    assert!(fixture.follow_up_waits());

    fixture.key(KeyCode::Esc);
    fixture.pump().await?;
    assert!(fixture.follow_up_sent());
    Ok(())
}

/// Cancelling the loading picker lets the follow-up go at once. The catalog that arrives later
/// opens nothing: not over the empty composer, and not over a newer picker.
async fn late_catalog_after_cancelling(newer_picker: bool) -> Result<()> {
    let mut fixture = Fixture::with_provider_list_open().await?;
    fixture.choose_the_gateway_provider().await?;
    assert!(fixture.follow_up_waits());

    fixture.key(KeyCode::Esc);
    fixture.pump().await?;
    assert!(fixture.follow_up_sent());
    assert!(fixture.app.chat_widget.no_modal_or_popup_active());

    let reply = fixture.catalog_reply().await;
    let models = some_models(&fixture.app);
    if newer_picker {
        fixture.app.chat_widget.open_elpis_provider_popup();
    }
    fixture.deliver(&reply, Ok(models)).await?;
    let popup = fixture.popup();
    assert!(
        !popup.contains("Choose a mind"),
        "the late catalog opened a popup:\n{popup}"
    );
    assert_eq!(
        fixture.app.chat_widget.no_modal_or_popup_active(),
        !newer_picker,
        "{popup}"
    );
    if newer_picker {
        assert!(popup.contains("Choose a provider"), "{popup}");
    }
    Ok(())
}

#[tokio::test]
async fn cancelling_the_loading_picker_drops_the_late_catalog() -> Result<()> {
    late_catalog_after_cancelling(/*newer_picker*/ false).await
}

#[tokio::test]
async fn a_late_catalog_does_not_replace_a_newer_picker() -> Result<()> {
    late_catalog_after_cancelling(/*newer_picker*/ true).await
}

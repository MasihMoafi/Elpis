//! The first turn of a fresh thread keeps the header and both messages on the full screen, also
//! when a follow-up is queued while the turn runs.

use super::tests::attach_thread;
use super::tests::buffer_text;
use super::*;
use crate::app::tests::make_test_app_with_channels;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnItemsView;
use codex_app_server_protocol::TurnStartedNotification;
use codex_app_server_protocol::TurnStatus;
use codex_app_server_protocol::UserInput;
use tokio::sync::mpsc::UnboundedReceiver;

fn drain_history(app: &mut App, tui: &mut tui::Tui, events: &mut UnboundedReceiver<AppEvent>) {
    while let Ok(event) = events.try_recv() {
        if let AppEvent::InsertHistoryCell(cell) = event {
            app.insert_history_cell(tui, cell);
        }
    }
}

fn draw(app: &mut App, tui: &mut tui::Tui, size: Size) -> Result<String> {
    tui.screen_size_for_event(&TuiEvent::Resize(size))?;
    app.render_owned_transcript(tui, size)?;
    Ok(buffer_text(
        crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal),
    ))
}

#[tokio::test]
async fn queued_follow_up_during_the_first_turn_leaves_the_header_and_messages_on_screen()
-> Result<()> {
    for (width, height, animations, warning_open) in [
        (125, 40, true, false),
        (125, 40, false, false),
        (100, 30, true, false),
        (125, 40, true, true),
    ] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        app.local_settings.tui.animations = animations;
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        let thread_id = ThreadId::new();
        attach_thread(&mut app, thread_id);
        let size = Size::new(width, height);
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(/*owned*/ true)?;
        // A fresh thread: the header and the composer.
        app.queue_clear_ui_header(&mut tui);
        if warning_open {
            // This folder's project-local config is untrusted: the start shows that warning.
            app.insert_history_cell(
                &mut tui,
                Box::new(history_cell::StartupWarningsCell::new(vec![
                    "Project-local config is disabled until the project is trusted.".into(),
                ])),
            );
            app.chat_widget.open_warnings(&app.transcript_cells);
        }
        draw(&mut app, &mut tui, size)?;
        if warning_open {
            // Read, then closed with Esc before typing.
            app.chat_widget.handle_key_event(KeyCode::Esc.into());
            draw(&mut app, &mut tui, size)?;
        }

        // The first message goes through the composer; the server starts the turn and echoes it.
        app.chat_widget
            .apply_external_edit("how do generators work?".into());
        app.chat_widget
            .handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        app.chat_widget.handle_server_notification(
            ServerNotification::TurnStarted(TurnStartedNotification {
                thread_id: thread_id.to_string(),
                turn: Turn {
                    id: "turn-1".into(),
                    root_turn_id: None,
                    items_view: TurnItemsView::Full,
                    items: Vec::new(),
                    status: TurnStatus::InProgress,
                    error: None,
                    started_at: None,
                    completed_at: None,
                    duration_ms: None,
                },
            }),
            /*replay_kind*/ None,
        );
        app.chat_widget.handle_server_notification(
            ServerNotification::ItemCompleted(ItemCompletedNotification {
                thread_id: thread_id.to_string(),
                turn_id: "turn-1".into(),
                completed_at_ms: 0,
                item: ThreadItem::UserMessage {
                    id: "user-1".into(),
                    client_id: None,
                    content: vec![UserInput::Text {
                        text: "how do generators work?".into(),
                        text_elements: Vec::new(),
                    }],
                },
            }),
            /*replay_kind*/ None,
        );
        drain_history(&mut app, &mut tui, &mut events);
        draw(&mut app, &mut tui, size)?;

        // A follow-up typed while the turn runs waits in the queue.
        app.keymap.composer.queue = vec![crate::key_hint::plain(KeyCode::Tab)];
        app.chat_widget
            .apply_keymap_update(Default::default(), &app.keymap);
        app.chat_widget
            .apply_external_edit("is concurrency covered in this course?".into());
        app.chat_widget
            .handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(
            app.chat_widget.queued_user_message_texts(),
            vec!["is concurrency covered in this course?"],
        );
        let screen = draw(&mut app, &mut tui, size)?;

        let missing: Vec<_> = [
            ">_ Elpis",
            "how do generators work?",
            "Queued follow-up inputs",
            "is concurrency covered in this course?",
            "CONTEXT LEDGER",
            "esc to interrupt",
        ]
        .into_iter()
        .filter(|needle| !screen.contains(needle))
        .collect();
        assert!(
            missing.is_empty(),
            "not on the {width}x{height} screen (animations {animations}, warning open {warning_open}): {missing:?}\n{screen}"
        );
        tui.set_owned_screen(/*owned*/ false)?;
    }
    Ok(())
}

/// A startup warning's panel takes the bottom of the screen. The Ledger stays beside it (the panel
/// is not a modal), so a warning never makes the start look as if the Ledger were missing.
#[tokio::test]
async fn startup_warning_keeps_the_ledger_on_screen() -> Result<()> {
    let mut app = crate::app::test_support::make_test_app().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    let size = Size::new(/*width*/ 120, /*height*/ 36);
    let mut tui = crate::tui::test_support::make_test_tui()?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.queue_clear_ui_header(&mut tui);
    app.insert_history_cell(
        &mut tui,
        Box::new(history_cell::StartupWarningsCell::new(vec![
            "Project-local config is disabled until the project is trusted.".into(),
        ])),
    );
    app.chat_widget.open_warnings(&app.transcript_cells);

    let screen = draw(&mut app, &mut tui, size)?;

    assert!(screen.contains("Warnings · 1 of 1 · Startup"), "{screen}");
    assert!(screen.contains("CONTEXT LEDGER"), "{screen}");
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

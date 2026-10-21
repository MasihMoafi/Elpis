//! Rewind failures must be visible and must never mutate history or send a restored draft.

use super::*;
use crate::app::owned_transcript::tests::attach_thread;
use crate::app::owned_transcript::tests::user_cell;
use crate::app::tests::make_test_app_with_channels;
use crate::app_backtrack::BacktrackSelection;
use pretty_assertions::assert_eq;

fn running_notification(thread_id: ThreadId) -> ServerNotification {
    ServerNotification::TurnStarted(codex_app_server_protocol::TurnStartedNotification {
        thread_id: thread_id.to_string(),
        turn: codex_app_server_protocol::Turn {
            id: "running".into(),
            root_turn_id: None,
            items: Vec::new(),
            items_view: codex_app_server_protocol::TurnItemsView::Full,
            status: codex_app_server_protocol::TurnStatus::InProgress,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        },
    })
}

fn error_text(events: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> String {
    std::iter::from_fn(|| events.try_recv().ok())
        .map(|event| match event {
            AppEvent::InsertHistoryCell(cell) => cell
                .display_lines(/*width*/ 120)
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
            AppEvent::RevertSessionForPromptEdit { .. } => panic!("rejected rewind sent a request"),
            _ => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn rewind_rejects_every_selected_position_while_a_turn_runs() {
    for selected in 0..3 {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        attach_thread(&mut app, thread_id);
        app.transcript_cells = vec![user_cell("first"), user_cell("middle"), user_cell("last")];
        let prompt = ["first", "middle", "last"][selected];
        let selection = BacktrackSelection {
            thread_id,
            nth_user_message: selected,
            prompt: prompt.into(),
        };
        // Positive: the idle selection requests exactly the real revert path.
        app.apply_backtrack_selection(selection.clone());
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::RevertSessionForPromptEdit { .. }))
        );
        app.chat_widget
            .handle_server_notification(running_notification(thread_id), /*replay_kind*/ None);
        // Negative: starting work after selection cannot rewind an earlier completed turn.
        app.apply_backtrack_selection(selection);
        assert!(
            error_text(&mut events).contains("Wait for the active turn to finish before rewinding")
        );
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 3);
        assert!(app.chat_widget.composer_is_empty());
    }
}

#[tokio::test]
async fn rewind_offline_enter_explains_the_refusal_and_preserves_preview() -> Result<()> {
    for owned in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = vec![user_cell("selected")];
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(owned)?;
        app.handle_backtrack_esc_key(&mut tui);
        app.handle_backtrack_esc_key(&mut tui);
        assert!(app.backtrack.overlay_preview_active);
        app.reconnect.offline = true;
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(error_text(&mut events).contains("Reconnect before rewinding"));
        let footer = app
            .prompt_navigation_footer(/*width*/ 120)
            .expect("preview footer");
        assert!(
            footer.text.lines[0]
                .to_string()
                .contains("reconnect to rewind")
        );
        assert!(app.backtrack.overlay_preview_active);
        assert_eq!(app.backtrack.nth_user_message, 0);
        assert!(app.chat_widget.composer_is_empty());
        // Positive: the same selection can be requested after reconnection.
        app.reconnect.offline = false;
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::RevertSessionForPromptEdit { .. }))
        );
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn rewind_stale_thread_and_missing_selection_report_why() {
    for stale_thread in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        attach_thread(&mut app, thread_id);
        app.transcript_cells = vec![user_cell("selected")];
        let selection = BacktrackSelection {
            thread_id,
            nth_user_message: 0,
            prompt: "selected".into(),
        };
        app.apply_backtrack_selection(selection.clone());
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::RevertSessionForPromptEdit { .. }))
        );
        if stale_thread {
            attach_thread(&mut app, ThreadId::new());
        } else {
            app.transcript_cells.clear();
        }
        app.apply_backtrack_selection(selection);
        assert!(error_text(&mut events).contains(if stale_thread {
            "The selected conversation changed"
        } else {
            "The selected message is no longer loaded"
        }));
        assert!(app.chat_widget.composer_is_empty());
    }
}

#[tokio::test]
async fn rewind_escape_during_work_explains_why_and_still_interrupts() -> Result<()> {
    for owned in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        attach_thread(&mut app, thread_id);
        app.transcript_cells = vec![user_cell("earlier prompt")];
        app.chat_widget
            .handle_server_notification(running_notification(thread_id), /*replay_kind*/ None);
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(owned)?;
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Esc.into()))
            .await?;
        let mut interrupted = false;
        let mut message = String::new();
        while let Ok(event) = events.try_recv() {
            match event {
                AppEvent::CodexOp(crate::app_command::AppCommand::Interrupt) => interrupted = true,
                AppEvent::InsertHistoryCell(cell) => {
                    message.push_str(
                        &cell
                            .display_lines(/*width*/ 120)
                            .iter()
                            .map(|line| line.to_string())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    );
                }
                AppEvent::RevertSessionForPromptEdit { .. } => panic!("running rewind requested"),
                _ => {}
            }
        }
        assert!(interrupted);
        assert!(message.contains("Wait for the active turn to finish before rewinding"));
        assert!(!app.backtrack.overlay_preview_active);
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn rewind_enter_rechecks_work_started_after_browsing_began() -> Result<()> {
    for owned in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        attach_thread(&mut app, thread_id);
        app.transcript_cells = vec![user_cell("earlier prompt")];
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(owned)?;
        for _ in 0..2 {
            app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Esc.into()))
                .await?;
        }
        assert!(app.backtrack.overlay_preview_active);
        app.chat_widget
            .handle_server_notification(running_notification(thread_id), /*replay_kind*/ None);
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(
            error_text(&mut events).contains("Wait for the active turn to finish before rewinding")
        );
        assert!(app.backtrack.overlay_preview_active);
        assert!(app.chat_widget.composer_is_empty());
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn rewind_dispatch_rechecks_work_started_after_confirmation() -> Result<()> {
    let (mut app, mut events, _operations) = make_test_app_with_channels().await;
    let thread_id = ThreadId::new();
    attach_thread(&mut app, thread_id);
    app.transcript_cells = vec![user_cell("earlier prompt")];
    app.chat_widget
        .handle_server_notification(running_notification(thread_id), /*replay_kind*/ None);
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    // Both direct rewind and an already-open whole-turn popup must recheck active work.
    for confirmed in [false, true] {
        let selected_cell = Arc::clone(&app.transcript_cells[0]);
        let prompt = "earlier prompt".into();
        let event = if confirmed {
            AppEvent::ConfirmWholeTurnPromptEdit {
                thread_id,
                selected_cell,
                prompt,
                turn_id: "earlier".into(),
                turn_fingerprint: [0; 32],
                latest_turn_id: Some("earlier".into()),
            }
        } else {
            AppEvent::RevertSessionForPromptEdit {
                thread_id,
                selected_cell,
                prompt,
            }
        };
        Box::pin(app.handle_event(&mut tui, &mut server, event)).await?;
        assert!(
            error_text(&mut events).contains("Wait for the active turn to finish before rewinding")
        );
        assert!(app.chat_widget.composer_is_empty());
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
    }
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn rewind_dispatch_reports_disconnection_after_selection() -> Result<()> {
    let (mut app, mut events, _operations) = make_test_app_with_channels().await;
    let thread_id = ThreadId::new();
    attach_thread(&mut app, thread_id);
    app.transcript_cells = vec![user_cell("selected")];
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    app.reconnect.offline = true;
    Box::pin(app.handle_event(
        &mut tui,
        &mut server,
        AppEvent::RevertSessionForPromptEdit {
            thread_id,
            selected_cell: Arc::clone(&app.transcript_cells[0]),
            prompt: "selected".into(),
        },
    ))
    .await?;
    assert!(error_text(&mut events).contains("Reconnect before rewinding"));
    assert!(app.chat_widget.composer_is_empty());
    assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn rewind_enter_before_history_loaded_reports_why() -> Result<()> {
    for owned in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = vec![user_cell("selected")];
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(owned)?;
        app.handle_backtrack_esc_key(&mut tui);
        app.handle_backtrack_esc_key(&mut tui);
        app.backtrack.nth_user_message = usize::MAX;
        app.scrollback_has_older_history = true;
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(error_text(&mut events).contains("Wait for history to load"));
        assert!(app.backtrack.overlay_preview_active);
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
        assert!(app.chat_widget.composer_is_empty());
        // Once a prompt is loaded and selected, the same Enter requests its rewind.
        app.apply_backtrack_selection_internal(0);
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::RevertSessionForPromptEdit { .. }))
        );
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn rewind_enter_after_real_disconnect_explains_restricted_input() -> Result<()> {
    for owned in [false, true] {
        let (mut app, mut events, _operations) = make_test_app_with_channels().await;
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = vec![user_cell("selected")];
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(owned)?;
        app.handle_backtrack_esc_key(&mut tui);
        app.handle_backtrack_esc_key(&mut tui);
        app.app_server_target = AppServerTarget::Remote {
            endpoint: crate::resolve_remote_addr("ws://127.0.0.1:4500")?,
        };
        assert!(app.begin_reconnect());
        app.handle_tui_event(&mut tui, &mut server, TuiEvent::Key(KeyCode::Enter.into()))
            .await?;
        assert!(error_text(&mut events).contains("Reconnect before rewinding"));
        assert!(app.chat_widget.composer_is_empty());
        assert_eq!(crate::app_backtrack::user_count(&app.transcript_cells), 1);
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

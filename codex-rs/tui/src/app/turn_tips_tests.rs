//! Foreground lifecycle, actual exposure, and dedicated-row geometry.

use super::*;
use crate::app::owned_transcript::tests::attach_thread;
use crate::app::owned_transcript::tests::buffer_text;
use crate::app::owned_transcript::tests::user_cell;
use crossterm::event::MouseButton::Left;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind::Down;
use crossterm::event::MouseEventKind::Drag;
use pretty_assertions::assert_eq;

fn notification(method: &str, thread: ThreadId, turn: usize, status: &str) -> ServerNotification {
    serde_json::from_value(serde_json::json!({
        "method": method,
        "params": { "threadId": thread.to_string(), "turn": {
            "id": turn.to_string(), "items": [], "itemsView": "full", "status": status,
            "error": null, "startedAt": null, "completedAt": null, "durationMs": 500,
        }},
    }))
    .unwrap()
}

fn answer(thread: ThreadId, turn: usize) -> ServerNotification {
    serde_json::from_value(serde_json::json!({
        "method": "item/completed", "params": {
            "threadId": thread.to_string(), "turnId": turn.to_string(), "completedAtMs": 0,
            "item": {"type": "agentMessage", "id": "answer", "text": "Done.",
                "phase": "final_answer", "memoryCitation": null, "delivery": null, "questions": null},
        },
    })).unwrap()
}

fn deliver(app: &mut App, notification: ServerNotification) {
    app.handle_thread_event_now(ThreadBufferedEvent::Notification(Box::new(notification)));
}

#[tokio::test]
async fn turn_tip_placements_and_completion_barrier() -> Result<()> {
    let mut screens = Vec::new();
    for (working, rows, width, height) in [
        (true, 1, 80, 12),
        (true, 1, 80, 6),
        (false, 1, 80, 12),
        (false, 30, 80, 12),
        (false, 1, 80, 9),
        (false, 1, 80, 10),
        (false, 1, 80, 11),
        (false, 1, 12, 12),
        (false, 1, 80, 4),
    ] {
        let (mut app, mut events, _ops) = crate::app::tests::make_test_app_with_channels().await;
        let thread = ThreadId::new();
        attach_thread(&mut app, thread);
        app.local_settings.tui.show_tooltips = true;
        app.local_settings.tui.animations = false;
        app.turn_tips.starts = 2;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        tui.set_owned_screen(/*owned*/ true)?;
        let size = Size::new(width, height);
        tui.terminal.resize(size)?;
        while events.try_recv().is_ok() {}
        app.transcript_cells = vec![
            user_cell("Show a response."),
            Arc::new(history_cell::PlainHistoryCell::new(
                (0..rows)
                    .map(|row| format!("Response row {row}").into())
                    .collect(),
            )),
        ];
        deliver(
            &mut app,
            notification("turn/started", thread, /*turn*/ 3, "inProgress"),
        );
        app.turn_tips.current.as_mut().unwrap().started_at = Instant::now() - WORKING_DELAY;
        app.turn_tips.current.as_mut().unwrap().template = Some("Try /help.");
        if !working {
            deliver(&mut app, answer(thread, /*turn*/ 3));
            deliver(
                &mut app,
                notification("turn/completed", thread, /*turn*/ 3, "completed"),
            );
            app.render_owned_transcript(&mut tui, size)?;
            assert!(!app.turn_tips.current.as_ref().unwrap().shown);
        }
        let mut saw_barrier = false;
        while let Ok(event) = events.try_recv() {
            match event {
                AppEvent::InsertHistoryCell(cell) => {
                    assert!(!saw_barrier);
                    app.insert_history_cell(&mut tui, cell);
                }
                AppEvent::TurnTipReady { thread_id, turn_id } => {
                    app.turn_tips
                        .ready(thread_id, &turn_id, app.transcript_cells.last());
                    saw_barrier = true;
                }
                _ => {}
            }
        }
        assert_eq!(saw_barrier, !working);
        app.render_owned_transcript(&mut tui, size)?;
        let screen = crate::chatwidget::tests::helpers::normalize_completion_timestamps(
            app.transcript_cells.last().unwrap().as_ref(),
            buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
                &tui.terminal,
            )),
        );
        let shown = screen.contains("└ Tip:");
        if shown && !working {
            assert!(screen.contains("• Done."), "{screen}");
        }
        assert_eq!(app.turn_tips.current.as_ref().unwrap().shown, shown);
        assert_eq!(
            app.turn_tips.completions_shown,
            usize::from(!working && shown)
        );
        screens.push(format!(
            "working={working}, response rows={rows}, {width}x{height}\n{screen}"
        ));
        if shown {
            let narrow = Size::new(/*width*/ 8, height);
            tui.terminal.resize(narrow)?;
            app.render_owned_transcript(&mut tui, narrow)?;
            assert!(
                !buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
                    &tui.terminal
                ))
                .contains("Tip:")
            );
            tui.terminal.resize(size)?;
            app.render_owned_transcript(&mut tui, size)?;
            assert_eq!(app.turn_tips.completions_shown, usize::from(!working));
        }
        if !working && shown {
            assert!(
                !app.transcript_cells
                    .iter()
                    .flat_map(|cell| cell.raw_lines())
                    .any(|line| line.to_string().contains("Try /help"))
            );
            let response_row = screen
                .lines()
                .position(|line| line.contains("• Done."))
                .unwrap() as u16;
            for (kind, column, row) in [
                (
                    crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                    0,
                    response_row,
                ),
                (
                    crossterm::event::MouseEventKind::Drag(crossterm::event::MouseButton::Left),
                    width - 1,
                    height - 1,
                ),
            ] {
                app.transcript_view.handle_mouse(
                    crossterm::event::MouseEvent {
                        kind,
                        column,
                        row,
                        modifiers: KeyModifiers::NONE,
                    },
                    &app.transcript_cells,
                );
            }
            let selected = app
                .transcript_view
                .selected_text(&app.transcript_cells)
                .unwrap();
            assert!(selected.contains("Done."));
            assert!(
                selected.contains(&app.transcript_cells.last().unwrap().raw_lines()[0].to_string())
            );
            assert!(!selected.contains("Try /help"));
            app.transcript_view.end_selection(&app.transcript_cells);
            app.transcript_view.begin_search();
            app.transcript_view.paste_search("Try /help");
            while app.transcript_view.advance_search(&app.transcript_cells) {}
            app.render_owned_transcript(&mut tui, size)?;
            assert!(
                buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
                    &tui.terminal
                ))
                .contains("No matches")
            );
            app.transcript_view.cancel_search();
            app.transcript_cells
                .push(Arc::new(history_cell::PlainHistoryCell::new(vec![
                    "Unrelated output".into(),
                ])));
            assert!(
                app.turn_tip(width, Instant::now(), &tui.frame_requester())
                    .is_none()
            );
        }
        tui.set_owned_screen(/*owned*/ false)?;
    }
    insta::assert_snapshot!(
        "turn_tip_placements",
        crate::chatwidget::tests::helpers::normalize_snapshot_paths(screens.join("\n\n"))
    );
    Ok(())
}

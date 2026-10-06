//! Elpis: Esc never leaves typed text in the air on the full screen.
//!
//! The Esc that leaves the Context Ledger does not start a rewind, and a typed character leaves
//! transcript browsing and goes into the composer.

use super::tests::attach_thread;
use super::tests::user_cell;
use super::*;
use crate::app::tests::make_test_app_with_channels;

async fn press(app: &mut App, tui: &mut tui::Tui, server: &mut AppServerSession, key: KeyEvent) {
    app.handle_tui_event(tui, server, TuiEvent::Key(key))
        .await
        .expect("key event");
}

/// Types at a human pace: each key, then the frame that flushes a held character.
async fn type_text(app: &mut App, tui: &mut tui::Tui, server: &mut AppServerSession, text: &str) {
    for character in text.chars() {
        press(
            app,
            tui,
            server,
            KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
        )
        .await;
        std::thread::sleep(crate::bottom_pane::ChatComposer::recommended_paste_flush_delay());
        app.chat_widget
            .handle_paste_burst_tick(tui.frame_requester());
    }
}

/// A full-screen chat with earlier prompts to rewind to and the Context Ledger drawn.
async fn chat() -> Result<(App, tui::Tui, AppServerSession)> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    let server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    attach_thread(&mut app, ThreadId::new());
    app.transcript_cells = vec![user_cell("first prompt"), user_cell("second prompt")];
    let mut tui = crate::tui::test_support::make_test_tui()?;
    tui.set_owned_screen(/*owned*/ true)?;
    // A drawn frame records the width; the Ledger takes keys only once it is drawn.
    app.chat_widget.note_rendered_width(/*width*/ 120);
    Ok((*app, tui, server))
}

#[tokio::test]
async fn tab_esc_esc_then_typing_reaches_the_composer() -> Result<()> {
    let (mut app, mut tui, mut server) = chat().await?;
    press(&mut app, &mut tui, &mut server, KeyCode::Tab.into()).await;
    assert!(app.chat_widget.context_ledger_has_focus());
    press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
    assert!(!app.chat_widget.context_ledger_has_focus());
    // Leaving the Ledger is not the first Esc of a rewind.
    assert!(!app.backtrack.primed);
    press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
    assert!(!app.backtrack.overlay_preview_active);

    type_text(&mut app, &mut tui, &mut server, "abc").await;
    assert_eq!(app.chat_widget.composer_text_with_pending(), "abc");
    assert!(!app.backtrack.overlay_preview_active);
    tui.set_owned_screen(/*owned*/ false)?;
    server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn typing_while_browsing_leaves_browsing_and_keeps_every_letter() -> Result<()> {
    // "hello" starts with a prompt key (h) and holds a scroll key (l); letters still win.
    for text in ["abc", "hello", "gg jk"] {
        let (mut app, mut tui, mut server) = chat().await?;
        press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
        press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
        assert!(
            app.backtrack.overlay_preview_active,
            "Esc Esc on an empty composer browses the transcript"
        );

        type_text(&mut app, &mut tui, &mut server, text).await;
        assert_eq!(app.chat_widget.composer_text_with_pending(), text);
        assert!(!app.backtrack.overlay_preview_active, "{text:?}");
        tui.set_owned_screen(/*owned*/ false)?;
        server.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn arrows_still_move_through_prompts_while_browsing() -> Result<()> {
    let (mut app, mut tui, mut server) = chat().await?;
    press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
    press(&mut app, &mut tui, &mut server, KeyCode::Esc.into()).await;
    let selected = app.backtrack.nth_user_message;
    press(&mut app, &mut tui, &mut server, KeyCode::Left.into()).await;
    assert!(app.backtrack.overlay_preview_active);
    assert_ne!(app.backtrack.nth_user_message, selected);
    assert!(app.chat_widget.composer_text_with_pending().is_empty());
    tui.set_owned_screen(/*owned*/ false)?;
    server.shutdown().await?;
    Ok(())
}

//! The rule between the transcript and the Context Ledger is a handle: pressing it and dragging
//! resizes the Ledger, and a drag that starts anywhere else does not.

use super::tests::attach_thread;
use super::tests::buffer_text;
use super::*;
use crate::app::tests::make_test_app_with_channels;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;

const SIZE: Size = Size::new(/*width*/ 125, /*height*/ 40);

fn mouse(kind: MouseEventKind, column: u16, row: u16) -> TuiEvent {
    TuiEvent::Mouse(MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    })
}

/// Columns of the Ledger as drawn: the screen's width minus the column of its rule.
fn ledger_width_on_screen(tui: &tui::Tui) -> u16 {
    let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
    let title_row = (0..SIZE.height)
        .find(|&y| {
            (0..SIZE.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .contains("CONTEXT LEDGER")
        })
        .expect("the Ledger title is drawn");
    let rule_x = (0..SIZE.width)
        .find(|&x| buffer[(x, title_row)].symbol() == "│")
        .expect("the Ledger rule is drawn");
    SIZE.width - rule_x
}

async fn drag(
    app: &mut App,
    tui: &mut tui::Tui,
    app_server: &mut AppServerSession,
    from: (u16, u16),
    to: (u16, u16),
) -> Result<()> {
    for event in [
        mouse(MouseEventKind::Down(MouseButton::Left), from.0, from.1),
        mouse(
            MouseEventKind::Drag(MouseButton::Left),
            (from.0 + to.0) / 2,
            to.1,
        ),
        mouse(MouseEventKind::Drag(MouseButton::Left), to.0, to.1),
        mouse(MouseEventKind::Up(MouseButton::Left), to.0, to.1),
    ] {
        app.handle_tui_event(tui, app_server, event).await?;
    }
    tui.screen_size_for_event(&TuiEvent::Resize(SIZE))?;
    app.render_owned_transcript(tui, SIZE)?;
    Ok(())
}

#[tokio::test]
async fn dragging_the_rule_resizes_the_ledger_and_the_transcript_follows() -> Result<()> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    app.transcript_cells = vec![super::tests::user_cell("a question for the transcript")];
    let mut app_server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);
    let rule_x = SIZE.width - original;

    // Press on the rule and drag 20 columns left: the Ledger grows by 20.
    drag(
        &mut app,
        &mut tui,
        &mut app_server,
        (rule_x, 10),
        (rule_x - 20, 10),
    )
    .await?;
    assert_eq!(ledger_width_on_screen(&tui), original + 20);

    // Dragging far left or far right stops where both sides stay usable.
    let grown_rule_x = SIZE.width - ledger_width_on_screen(&tui);
    drag(
        &mut app,
        &mut tui,
        &mut app_server,
        (grown_rule_x, 10),
        (0, 10),
    )
    .await?;
    let widest = ledger_width_on_screen(&tui);
    assert!(
        widest > original + 20 && SIZE.width - widest >= 40,
        "widest {widest}"
    );
    drag(
        &mut app,
        &mut tui,
        &mut app_server,
        (SIZE.width - widest, 10),
        (SIZE.width - 1, 10),
    )
    .await?;
    let narrowest = ledger_width_on_screen(&tui);
    assert!(
        narrowest < original && narrowest >= 24,
        "narrowest {narrowest}"
    );

    // The transcript reflows into what the Ledger leaves: its text sits left of the rule.
    let screen = buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
        &tui.terminal,
    ));
    assert!(screen.contains("a question for the transcript"), "{screen}");
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

#[tokio::test]
async fn a_drag_that_starts_elsewhere_leaves_the_ledger_alone() -> Result<()> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    app.transcript_cells = vec![super::tests::user_cell("a question for the transcript")];
    let mut app_server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);

    // From the transcript, from inside the Ledger, and from the rule above the Ledger's start.
    for from in [
        (5, 10),
        (SIZE.width - original + 5, 10),
        (SIZE.width - original, 0),
    ] {
        drag(&mut app, &mut tui, &mut app_server, from, (30, 12)).await?;
        assert_eq!(ledger_width_on_screen(&tui), original, "drag from {from:?}");
    }
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

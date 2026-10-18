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

    // Dragging far left or to the minimum keeps both sides usable.
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
        (SIZE.width - 28, 10),
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

#[tokio::test]
async fn ledger_drag_saves_width_on_release() -> Result<()> {
    let (mut app, mut events, _operations) = make_test_app_with_channels().await;
    let home = tempfile::tempdir()?;
    let config_path = home.path().join("work.config.toml");
    std::fs::write(&config_path, "[tui]\nanimations = false\n")?;
    app.local_settings.user_config_path = AbsolutePathBuf::try_from(config_path.clone())?;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);
    let rule_x = SIZE.width - original;
    for event in [
        mouse(MouseEventKind::Down(MouseButton::Left), rule_x, 10),
        mouse(MouseEventKind::Drag(MouseButton::Left), rule_x - 12, 10),
    ] {
        app.handle_tui_event(&mut tui, &mut server, event).await?;
    }
    // Moving the pointer does not write; releasing commits the preference.
    while let Ok(event) = events.try_recv() {
        Box::pin(app.handle_event(&mut tui, &mut server, event)).await?;
    }
    let before: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path)?)?;
    assert!(before["tui"].get("context_ledger_width").is_none());
    app.handle_tui_event(
        &mut tui,
        &mut server,
        mouse(MouseEventKind::Up(MouseButton::Left), rule_x - 12, 10),
    )
    .await?;
    while let Ok(event) = events.try_recv() {
        Box::pin(app.handle_event(&mut tui, &mut server, event)).await?;
    }
    let saved: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path)?)?;
    assert_eq!(
        saved["tui"]
            .get("context_ledger_width")
            .and_then(toml::Value::as_integer),
        Some(i64::from(original + 12))
    );
    assert_eq!(saved["tui"]["animations"].as_bool(), Some(false));
    assert!(!home.path().join("config.toml").exists());
    server.shutdown().await?;
    tui.set_owned_screen(false)?;
    Ok(())
}

#[tokio::test]
async fn ledger_close_button_hides_and_key_reopens_at_previous_width() -> Result<()> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);
    let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
    let close = (0..SIZE.height)
        .flat_map(|y| (0..SIZE.width).map(move |x| (x, y)))
        .find(|&(x, y)| buffer[(x, y)].symbol() == "×")
        .expect("Ledger has a visible close button");
    assert_eq!(close.0, SIZE.width - 2);
    let mut modified = mouse(MouseEventKind::Down(MouseButton::Left), close.0, close.1);
    if let TuiEvent::Mouse(event) = &mut modified {
        event.modifiers = KeyModifiers::CONTROL;
    }
    app.handle_tui_event(&mut tui, &mut server, modified)
        .await?;
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), original);
    app.handle_tui_event(
        &mut tui,
        &mut server,
        mouse(
            MouseEventKind::Down(MouseButton::Left),
            close.0 - 1,
            close.1,
        ),
    )
    .await?;
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), original);
    app.handle_tui_event(
        &mut tui,
        &mut server,
        mouse(MouseEventKind::Down(MouseButton::Left), close.0, close.1),
    )
    .await?;
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), 0);
    app.handle_tui_event(
        &mut tui,
        &mut server,
        TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
    )
    .await?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    assert_eq!(ledger_width_on_screen(&tui), original);
    server.shutdown().await?;
    tui.set_owned_screen(false)?;
    Ok(())
}

#[tokio::test]
async fn ledger_drag_snap_close_can_be_reversed_and_preserves_saved_width() -> Result<()> {
    let (mut app, mut events, _operations) = make_test_app_with_channels().await;
    let home = tempfile::tempdir()?;
    let path = home.path().join("config.toml");
    std::fs::write(&path, "[tui]\ncontext_ledger_width = 62\n")?;
    app.local_settings.user_config_path = AbsolutePathBuf::try_from(path.clone())?;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);
    // Save a normal drag first, then try snapping it closed.
    drag(
        &mut app,
        &mut tui,
        &mut server,
        (SIZE.width - original, 10),
        (SIZE.width - 62, 10),
    )
    .await?;
    for (kind, x, expected) in [
        (MouseEventKind::Down(MouseButton::Left), SIZE.width - 62, 62),
        (MouseEventKind::Drag(MouseButton::Left), SIZE.width - 28, 28),
        (MouseEventKind::Drag(MouseButton::Left), SIZE.width - 21, 28),
        (MouseEventKind::Drag(MouseButton::Left), SIZE.width - 20, 0),
        (MouseEventKind::Drag(MouseButton::Left), SIZE.width - 1, 0),
        (MouseEventKind::Drag(MouseButton::Left), SIZE.width - 28, 62),
        (MouseEventKind::Up(MouseButton::Left), SIZE.width - 28, 62),
    ] {
        app.handle_tui_event(&mut tui, &mut server, mouse(kind, x, 10))
            .await?;
        app.render_owned_transcript(&mut tui, SIZE)?;
        assert_eq!(
            app.chat_widget.context_ledger_width(SIZE.width),
            expected,
            "{kind:?} at {x}"
        );
    }
    drag(
        &mut app,
        &mut tui,
        &mut server,
        (SIZE.width - 62, 10),
        (SIZE.width - 1, 10),
    )
    .await?;
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), 0);
    while let Ok(event) = events.try_recv() {
        Box::pin(app.handle_event(&mut tui, &mut server, event)).await?;
    }
    let saved: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
    assert_eq!(saved["tui"]["context_ledger_width"].as_integer(), Some(62));
    app.handle_tui_event(
        &mut tui,
        &mut server,
        TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
    )
    .await?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    assert_eq!(ledger_width_on_screen(&tui), 62);
    server.shutdown().await?;
    tui.set_owned_screen(false)?;
    Ok(())
}

#[tokio::test]
async fn ledger_saved_width_is_loaded_at_the_next_start() -> Result<()> {
    let home = tempfile::tempdir()?;
    std::fs::write(
        home.path().join("config.toml"),
        "[tui]\ncontext_ledger_width = 67\n",
    )?;
    let config = crate::legacy_core::config::ConfigBuilder::default()
        .codex_home(home.path().to_path_buf())
        .loader_overrides(
            crate::legacy_core::config::LoaderOverrides::without_managed_config_for_tests(),
        )
        .build()
        .await?;
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    app.config = config;
    crate::app::tests::set_test_initial_prompt(&mut app, String::new());
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), 67);
    assert_eq!(app.chat_widget.context_ledger_width(90), 50);
    assert_eq!(app.chat_widget.context_ledger_width(70), 0);
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), 67);
    Ok(())
}

/// Snapshot the actual owned-screen header after opening with the keyboard and, when
/// requested, resizing with the mouse. The last three cells are the gap, × and margin.
async fn ledger_header_snapshot(terminal_width: u16, preferred: Option<u16>) -> Result<String> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    attach_thread(&mut app, ThreadId::new());
    let size = Size::new(terminal_width, 40);
    let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(size)?;
    tui.set_owned_screen(true)?;
    app.handle_tui_event(
        &mut tui,
        &mut server,
        TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
    )
    .await?;
    app.render_owned_transcript(&mut tui, size)?;
    if let Some(width) = preferred {
        let original = app.chat_widget.context_ledger_width(terminal_width);
        for event in [
            mouse(
                MouseEventKind::Down(MouseButton::Left),
                terminal_width - original,
                10,
            ),
            mouse(
                MouseEventKind::Drag(MouseButton::Left),
                terminal_width - width,
                10,
            ),
            mouse(
                MouseEventKind::Up(MouseButton::Left),
                terminal_width - width,
                10,
            ),
        ] {
            app.handle_tui_event(&mut tui, &mut server, event).await?;
        }
        app.render_owned_transcript(&mut tui, size)?;
        assert_eq!(app.chat_widget.context_ledger_width(terminal_width), width);
    }
    let width = app.chat_widget.context_ledger_width(terminal_width);
    let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
    let y = (0..size.height)
        .find(|&y| buffer[(terminal_width - 2, y)].symbol() == "×")
        .expect("Ledger close button");
    let header = (terminal_width - width..terminal_width)
        .map(|x| buffer[(x, y)].symbol())
        .collect::<String>();
    // Closing still uses the exact visible button after text truncation.
    app.handle_tui_event(
        &mut tui,
        &mut server,
        mouse(
            MouseEventKind::Down(MouseButton::Left),
            terminal_width - 2,
            y,
        ),
    )
    .await?;
    assert_eq!(app.chat_widget.context_ledger_width(terminal_width), 0);
    server.shutdown().await?;
    tui.set_owned_screen(false)?;
    Ok(header.trim_end().to_string())
}

#[tokio::test]
async fn ledger_header_gap_narrowest() -> Result<()> {
    insta::assert_snapshot!(ledger_header_snapshot(120, Some(28)).await?, @"│ CONTEXT LEDGER  contex… ×");
    Ok(())
}

#[tokio::test]
async fn ledger_header_gap_default() -> Result<()> {
    insta::assert_snapshot!(ledger_header_snapshot(150, None).await?, @"│ CONTEXT LEDGER  context not measured · ≈0 sour… ×");
    Ok(())
}

#[tokio::test]
async fn ledger_header_gap_80_columns() -> Result<()> {
    insta::assert_snapshot!(ledger_header_snapshot(80, None).await?, @"│ CONTEXT LEDGER  context no… ×");
    Ok(())
}

#[tokio::test]
async fn ledger_header_gap_120_columns() -> Result<()> {
    insta::assert_snapshot!(ledger_header_snapshot(120, None).await?, @"│ CONTEXT LEDGER  context not measured · ≈0 … ×");
    Ok(())
}

#[tokio::test]
async fn ledger_header_gap_140_columns() -> Result<()> {
    insta::assert_snapshot!(ledger_header_snapshot(140, None).await?, @"│ CONTEXT LEDGER  context not measured · ≈0 sour… ×");
    Ok(())
}

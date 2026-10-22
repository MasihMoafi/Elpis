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
const LEDGER_TOGGLE_LABEL: &str = "[━━━●] ON";

#[tokio::test]
async fn closed_ledger_returns_the_full_width_to_the_transcript() -> Result<()> {
    for width in [80, 120, 200] {
        let (mut app, _events, _ops) = make_test_app_with_channels().await;
        crate::chatwidget::tests::helpers::hide_context_ledger(&mut app.chat_widget);
        app.local_settings.tui.animations = false;
        app.transcript_cells = vec![Arc::new(crate::history_cell::PlainHistoryCell::new(
            vec![Line::from("X".repeat(600)); 100],
        ))];
        let mut tui = crate::tui::test_support::make_test_tui_with_size(Size::new(width, 40))?;
        tui.set_owned_screen(true)?;
        for height in 10..=40 {
            let size = Size::new(width, height);
            tui.terminal.resize(size)?;
            // Settle the transcript's own scrollbar before measuring its last text cell.
            app.render_owned_transcript(&mut tui, size)?;
            let bottom = app.render_owned_transcript(&mut tui, size)?;
            let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
            let body_right = width - u16::from(app.transcript_view.reserves_scrollbar());
            assert!(
                (0..bottom.y).any(|y| buffer[(body_right - 1, y)].symbol() == "X"),
                "{width}x{height}: closed Ledger left reserved columns"
            );
            for y in 0..bottom.y {
                for x in 0..body_right {
                    assert!(!matches!(buffer[(x, y)].symbol(), "│" | "╱" | "╲" | "●"));
                }
            }
        }
        // The open Ledger retains its usual column and transcript wrapping.
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        let size = Size::new(width, 40);
        tui.terminal.resize(size)?;
        app.render_owned_transcript(&mut tui, size)?;
        let bottom = app.render_owned_transcript(&mut tui, size)?;
        let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
        let text_right = bottom.width - u16::from(app.transcript_view.reserves_scrollbar());
        assert!((0..bottom.y).any(|y| buffer[(text_right - 1, y)].symbol() == "X"));
        tui.set_owned_screen(false)?;
    }
    Ok(())
}

#[tokio::test]
async fn ledger_wheel_and_focused_paging_leave_the_real_transcript_viewport_in_place() -> Result<()>
{
    for size in [Size::new(80, 24), Size::new(120, 40), Size::new(200, 60)] {
        let (mut app, _events, _ops) = make_test_app_with_channels().await;
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = vec![super::tests::user_cell(&"transcript line\n".repeat(200))];
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui_with_size(size)?;
        tui.set_owned_screen(true)?;
        app.render_owned_transcript(&mut tui, size)?;
        app.handle_tui_event(
            &mut tui,
            &mut server,
            TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
        )
        .await?;
        assert!(app.chat_widget.context_ledger_has_focus());
        for event in [
            TuiEvent::Key(KeyEvent::from(KeyCode::PageUp)),
            mouse(MouseEventKind::ScrollUp, size.width - 5, 4),
        ] {
            app.handle_tui_event(&mut tui, &mut server, event).await?;
            assert!(
                app.transcript_view.is_following(),
                "ledger input scrolled the conversation"
            );
        }
        app.handle_tui_event(&mut tui, &mut server, mouse(MouseEventKind::ScrollUp, 2, 4))
            .await?;
        assert!(
            !app.transcript_view.is_following(),
            "a wheel over the conversation still scrolls it"
        );
        server.shutdown().await?;
        tui.set_owned_screen(false)?;
    }
    Ok(())
}

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
async fn only_the_rule_drags_the_ledger_including_its_top_row() -> Result<()> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    app.transcript_cells = vec![super::tests::user_cell("a question for the transcript")];
    let mut app_server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.render_owned_transcript(&mut tui, SIZE)?;
    let original = ledger_width_on_screen(&tui);

    // From the transcript, inside the Ledger, and outside its handle on the top row.
    for from in [
        (5, 10),
        (SIZE.width - original + 5, 10),
        (SIZE.width - original + 2, 0),
    ] {
        drag(&mut app, &mut tui, &mut app_server, from, (30, 12)).await?;
        assert_eq!(ledger_width_on_screen(&tui), original, "drag from {from:?}");
    }
    drag(
        &mut app,
        &mut tui,
        &mut app_server,
        (SIZE.width - original, 0),
        (SIZE.width - original - 4, 0),
    )
    .await?;
    assert_eq!(ledger_width_on_screen(&tui), original + 4);
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
        .flat_map(|y| (SIZE.width - original..SIZE.width).map(move |x| (x, y)))
        .find(|&(x, y)| buffer[(x, y)].symbol() == "[")
        .expect("Ledger has a visible toggle");
    let button_left = SIZE.width - LEDGER_TOGGLE_LABEL.chars().count() as u16 - 1;
    let mut modified = mouse(MouseEventKind::Down(MouseButton::Left), close.0, close.1);
    if let TuiEvent::Mouse(event) = &mut modified {
        event.modifiers = KeyModifiers::CONTROL;
    }
    app.handle_tui_event(&mut tui, &mut server, modified)
        .await?;
    assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), original);
    for (x, y) in [
        (button_left - 1, close.1),
        (SIZE.width - 1, close.1),
        (close.0, close.1 + 1),
    ] {
        app.handle_tui_event(
            &mut tui,
            &mut server,
            mouse(MouseEventKind::Down(MouseButton::Left), x, y),
        )
        .await?;
        assert_eq!(app.chat_widget.context_ledger_width(SIZE.width), original);
    }
    for x in button_left..SIZE.width - 1 {
        app.handle_tui_event(
            &mut tui,
            &mut server,
            mouse(MouseEventKind::Down(MouseButton::Left), x, close.1),
        )
        .await?;
        assert_eq!(
            app.chat_widget.context_ledger_width(SIZE.width),
            0,
            "cell {x}"
        );
        app.handle_tui_event(
            &mut tui,
            &mut server,
            TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
        )
        .await?;
        app.render_owned_transcript(&mut tui, SIZE)?;
        assert_eq!(ledger_width_on_screen(&tui), original);
    }
    assert_eq!(close.0, button_left);
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
/// requested, resizing with the mouse. The switch has its own row above the title and context status.
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
        .find(|&y| {
            (0..terminal_width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
                .contains("CONTEXT LEDGER")
        })
        .expect("Ledger toggle");
    let close_x = (terminal_width - width..terminal_width)
        .find(|&x| buffer[(x, y)].symbol() == "[")
        .expect("Ledger toggle");
    assert_eq!(y, 1);
    let header = [0, y]
        .into_iter()
        .map(|row| {
            (terminal_width - width..terminal_width)
                .map(|x| buffer[(x, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");
    for row in 0..size.height {
        assert_eq!(
            buffer[(terminal_width - 1, row)].symbol(),
            " ",
            "right margin, row {row}"
        );
    }
    // Closing still uses the exact visible button after text truncation.
    app.handle_tui_event(
        &mut tui,
        &mut server,
        mouse(MouseEventKind::Down(MouseButton::Left), close_x, y),
    )
    .await?;
    assert_eq!(app.chat_widget.context_ledger_width(terminal_width), 0);
    server.shutdown().await?;
    tui.set_owned_screen(false)?;
    Ok(header.trim_end().to_string())
}

#[tokio::test]
async fn ledger_switch_ends_the_title_row_at_all_supported_widths() -> Result<()> {
    for (width, preferred) in [
        (80, None),
        (120, None),
        (140, None),
        (150, None),
        (200, None),
        (120, Some(28)),
    ] {
        let header = ledger_header_snapshot(width, preferred).await?;
        assert!(
            header.contains("CONTEXT LEDGER") && header.contains(LEDGER_TOGGLE_LABEL),
            "{header}"
        );
        let mut lines = header.lines();
        assert_eq!(lines.next().unwrap().trim_start_matches('│').trim(), "");
        let title = lines.next().unwrap();
        assert!(
            title.contains("CONTEXT LEDGER") && title.ends_with(LEDGER_TOGGLE_LABEL),
            "{header}"
        );
        assert!(!header.contains(['×', '╳']));
    }
    Ok(())
}

#[tokio::test]
async fn ledger_toggle_uses_the_shared_on_style_in_both_themes() -> Result<()> {
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut tui = crate::tui::test_support::make_test_tui_with_size(SIZE)?;
    tui.set_owned_screen(true)?;
    for (fg, bg) in [
        ((17, 17, 17), (255, 255, 255)),
        ((238, 238, 238), (17, 17, 17)),
    ] {
        crate::terminal_palette::with_test_default_colors(
            crate::terminal_probe::DefaultColors { fg, bg },
            || -> Result<()> {
                app.render_owned_transcript(&mut tui, SIZE)?;
                let buffer =
                    crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
                let y = (0..SIZE.height)
                    .find(|&y| {
                        (0..SIZE.width)
                            .map(|x| buffer[(x, y)].symbol())
                            .collect::<String>()
                            .contains(LEDGER_TOGGLE_LABEL)
                    })
                    .expect("Ledger toggle");
                let button_left = SIZE.width - LEDGER_TOGGLE_LABEL.chars().count() as u16 - 1;
                for (offset, symbol) in LEDGER_TOGGLE_LABEL.chars().enumerate() {
                    let cell = &buffer[(button_left + offset as u16, y)];
                    assert_eq!(cell.symbol(), symbol.to_string());
                    assert_eq!(cell.fg, crate::style::context_style().fg.unwrap());
                }
                assert_eq!(buffer[(button_left - 1, y)].symbol(), " ");
                assert_eq!(buffer[(SIZE.width - 1, y)].symbol(), " ");
                assert_eq!(buffer[(SIZE.width - 1, y)].symbol(), " ");
                Ok(())
            },
        )?;
    }
    tui.set_owned_screen(false)?;
    Ok(())
}

#[tokio::test]
async fn ledger_toggle_hits_only_its_header_cells_owned_width_matrix() -> Result<()> {
    for (terminal_width, preferred) in [(80, None), (120, None), (150, None), (120, Some(28))] {
        let (mut app, _events, _operations) = make_test_app_with_channels().await;
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        attach_thread(&mut app, ThreadId::new());
        let size = Size::new(terminal_width, 40);
        let mut server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        let mut tui = crate::tui::test_support::make_test_tui_with_size(size)?;
        tui.set_owned_screen(true)?;
        app.render_owned_transcript(&mut tui, size)?;
        if let Some(width) = preferred {
            let initial = app.chat_widget.context_ledger_width(terminal_width);
            for event in [
                mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    terminal_width - initial,
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
        let left = terminal_width - app.chat_widget.context_ledger_width(terminal_width);
        let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
        let row = |y| {
            (left..terminal_width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        };
        let title_y = (0..size.height)
            .find(|&y| row(y).contains("CONTEXT LEDGER"))
            .expect("visible title");
        let close_y = title_y;
        assert_eq!(title_y, 1);
        assert_eq!(row(0).trim_start_matches('│').trim(), "");
        assert!(row(title_y).trim_end().ends_with(LEDGER_TOGGLE_LABEL));
        assert!(!row(title_y).contains(['×', '╳']));
        let close_x = (left..terminal_width)
            .find(|&x| buffer[(x, close_y)].symbol() == "[")
            .expect("toggle");
        app.handle_tui_event(
            &mut tui,
            &mut server,
            mouse(MouseEventKind::Down(MouseButton::Left), left + 3, title_y),
        )
        .await?;
        assert!(
            app.chat_widget.context_ledger_width(terminal_width) > 0,
            "the title label does not switch the panel off"
        );
        app.handle_tui_event(
            &mut tui,
            &mut server,
            mouse(MouseEventKind::Down(MouseButton::Left), close_x, close_y),
        )
        .await?;
        assert_eq!(app.chat_widget.context_ledger_width(terminal_width), 0);
        server.shutdown().await?;
        tui.set_owned_screen(false)?;
    }
    Ok(())
}

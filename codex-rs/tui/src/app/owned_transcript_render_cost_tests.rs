//! Elpis: typing on the full screen draws each character in the next frame, with the Context
//! Ledger visible, and the cost of that frame does not grow with the length of the chat.
//!
//! Keys take the real event path (`App::handle_tui_event`). Each frame makes the calls that the
//! draw event makes, on a fixed screen.

use super::tests::attach_thread;
use super::tests::buffer_text;
use super::tests::user_cell;
use super::*;
use crate::app::tests::make_test_app_with_channels;
use crate::history_cell::AgentMarkdownCell;
use crate::history_cell::HistoryCell;
use crate::history_cell::PlainHistoryCell;
use std::time::Duration;

const SCREEN: Size = Size::new(/*width*/ 120, /*height*/ 40);

#[tokio::test]
async fn inline_mode_leaves_room_above_a_crowded_ledger() -> Result<()> {
    let screen = Size::new(/*width*/ 120, /*height*/ 20);
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut tui = crate::tui::test_support::make_test_tui_with_size(screen)?;
    app.render_chat_widget_frame(&mut tui, screen)?;
    assert_eq!(
        app.chat_widget.width_beside_context_ledger(screen.width),
        screen.width,
        "the Ledger must leave room for replies"
    );
    Ok(())
}

/// Full screen: the Ledger starts at the top right, above the session header and transcript,
/// while the composer keeps its own height to the Ledger's left.
#[tokio::test]
async fn full_screen_ledger_starts_at_the_top_beside_the_composer() -> Result<()> {
    let screen = Size::new(/*width*/ 120, /*height*/ 20);
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    let mut tui = crate::tui::test_support::make_test_tui_with_size(screen)?;
    tui.set_owned_screen(/*owned*/ true)?;
    // The session header the full screen draws first: a blank row, the title and the cwd.
    app.queue_clear_ui_header(&mut tui);
    // The first thing after the header, as the tips are on a new session.
    app.transcript_cells
        .push(Arc::new(PlainHistoryCell::new(vec![
            "first line of the transcript".into(),
        ])));
    let bottom_area = app.render_chat_widget_frame(&mut tui, screen)?;
    let ledger_width = app.chat_widget.context_ledger_width(screen.width);
    assert!(
        ledger_width > 0,
        "a crowded Ledger must not hide on the full screen"
    );
    let rule_x = screen.width - ledger_width;
    assert_eq!(
        bottom_area.width, rule_x,
        "the composer must stop at the Ledger"
    );
    assert!(
        bottom_area.height < screen.height / 2,
        "the composer grew to the Ledger's height: {bottom_area:?}"
    );
    let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
    let screen_text = buffer_text(buffer);
    let row = |y: u16, columns: std::ops::Range<u16>| {
        columns.map(|x| buffer[(x, y)].symbol()).collect::<String>()
    };
    let title_row = (0..screen.height)
        .find(|&y| row(y, 0..rule_x).contains(">_ Elpis"))
        .unwrap_or_else(|| panic!("the session header is missing\n{screen_text}"));
    let cwd = app
        .config
        .cwd
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    assert!(
        row(title_row + 1, 0..rule_x).contains(&cwd),
        "the cwd row must follow the title\n{screen_text}"
    );
    let close_row = (0..screen.height)
        .find(|&y| row(y, rule_x + 1..screen.width).contains("╳"))
        .unwrap_or_else(|| panic!("the Ledger Close button is missing\n{screen_text}"));
    let ledger_title = (0..screen.height)
        .find(|&y| row(y, rule_x + 1..screen.width).contains("CONTEXT LEDGER"))
        .unwrap_or_else(|| panic!("the Ledger title is missing\n{screen_text}"));
    let first_line = (title_row + 2..screen.height)
        .find(|&y| row(y, 0..rule_x).contains("first line of the transcript"))
        .unwrap_or_else(|| panic!("the transcript must stay beside the Ledger\n{screen_text}"));
    assert_eq!(
        close_row, 0,
        "the Ledger Close row starts at the top\n{screen_text}"
    );
    assert_eq!(
        ledger_title,
        close_row + 1,
        "the Ledger title follows its Close row\n{screen_text}"
    );
    assert!(
        first_line > ledger_title,
        "the transcript stays below the Ledger heading\n{screen_text}"
    );
    for y in close_row..screen.height {
        assert_eq!(buffer[(rule_x, y)].symbol(), "│", "row {y}\n{screen_text}");
    }
    let close_x = (rule_x + 1..screen.width)
        .find(|&x| buffer[(x, close_row)].symbol() == "╳")
        .expect("the Close glyph has a screen position");
    assert!(
        app.chat_widget
            .handle_context_ledger_mouse(crossterm::event::MouseEvent {
                kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
                column: close_x,
                row: close_row,
                modifiers: KeyModifiers::NONE,
            })
    );
    assert_eq!(app.chat_widget.context_ledger_width(screen.width), 0);
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

#[tokio::test]
async fn full_screen_ledger_keeps_mouse_selection_in_the_transcript_column() -> Result<()> {
    use crossterm::event::MouseButton;
    use crossterm::event::MouseEvent;
    use crossterm::event::MouseEventKind;

    let screen = Size::new(120, 20);
    let (mut app, _events, _operations) = make_test_app_with_channels().await;
    crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
    attach_thread(&mut app, ThreadId::new());
    app.transcript_cells = vec![Arc::new(PlainHistoryCell::new(vec![
        Line::from(
            "transcript row"
        );
        40
    ]))];
    let mut tui = crate::tui::test_support::make_test_tui_with_size(screen)?;
    tui.set_owned_screen(/*owned*/ true)?;
    app.render_chat_widget_frame(&mut tui, screen)?;
    let bottom = app.render_chat_widget_frame(&mut tui, screen)?;
    let mut click = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: bottom.width + 2,
        row: 0,
        modifiers: KeyModifiers::NONE,
    };

    app.transcript_view
        .handle_selection_mouse(click, &app.transcript_cells);
    assert!(!app.transcript_view.has_active_interaction());
    click.column = 0;
    app.transcript_view
        .handle_selection_mouse(click, &app.transcript_cells);
    assert!(app.transcript_view.has_active_interaction());
    tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

#[tokio::test]
async fn full_screen_ledger_fits_zero_and_narrow_frames() -> Result<()> {
    for screen in [
        Size::new(0, 0),
        Size::new(0, 4),
        Size::new(1, 4),
        Size::new(79, 8),
    ] {
        let (mut app, _events, _operations) = make_test_app_with_channels().await;
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = long_chat(1);
        let mut tui = crate::tui::test_support::make_test_tui_with_size(screen)?;
        tui.set_owned_screen(/*owned*/ true)?;
        app.render_chat_widget_frame(&mut tui, screen)?;
        let bottom = app.render_chat_widget_frame(&mut tui, screen)?;
        assert!(bottom.right() <= screen.width);
        assert!(bottom.bottom() <= screen.height);
        assert_eq!(bottom.width, screen.width);
        tui.set_owned_screen(/*owned*/ false)?;
    }
    Ok(())
}

#[tokio::test]
async fn full_screen_composer_click_returns_focus_from_the_ledger() -> Result<()> {
    use crossterm::event::MouseButton;
    use crossterm::event::MouseEvent;
    use crossterm::event::MouseEventKind;

    let mut chat = Chat::new(0).await?;
    let cursor = chat.tui.terminal.last_known_cursor_pos;
    // Alt+C, not Tab: the test fixtures bind Tab to queueing.
    chat.app
        .handle_tui_event(
            &mut chat.tui,
            &mut chat.server,
            TuiEvent::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
        )
        .await?;
    assert!(chat.app.chat_widget.context_ledger_has_focus());
    let mut click = MouseEvent {
        kind: MouseEventKind::ScrollDown,
        column: cursor.x,
        row: cursor.y,
        modifiers: KeyModifiers::NONE,
    };
    chat.app
        .handle_tui_event(&mut chat.tui, &mut chat.server, TuiEvent::Mouse(click))
        .await?;
    assert!(chat.app.chat_widget.context_ledger_has_focus());
    click.kind = MouseEventKind::Down(MouseButton::Left);
    chat.app
        .handle_tui_event(&mut chat.tui, &mut chat.server, TuiEvent::Mouse(click))
        .await?;
    assert!(!chat.app.chat_widget.context_ledger_has_focus());
    assert!(chat.app.chat_widget.context_ledger_width(SCREEN.width) > 0);
    chat.tui.set_owned_screen(/*owned*/ false)?;
    Ok(())
}

/// One user prompt, one command output and one long Markdown answer per turn.
fn long_chat(turns: usize) -> Vec<Arc<dyn HistoryCell>> {
    let mut cells: Vec<Arc<dyn HistoryCell>> = Vec::with_capacity(turns * 3);
    for turn in 0..turns {
        cells.push(user_cell(&format!("prompt number {turn} with a few words")));
        cells.push(Arc::new(PlainHistoryCell::new(
            (0..30)
                .map(|row| format!("  output row {row} of turn {turn}").into())
                .collect(),
        )));
        let mut answer = format!("## Answer {turn}\n\n");
        for paragraph in 0..6 {
            answer.push_str(&format!(
                "Paragraph {paragraph} of answer {turn} has enough words to wrap several times \
                 across the transcript width, so wrapping it again costs real work. \
                 It also has `inline code` and **bold** text.\n\n"
            ));
        }
        answer.push_str("| a | b |\n|---|---|\n");
        for row in 0..10 {
            answer.push_str(&format!("| row {row} | value {row} |\n"));
        }
        answer.push_str("\n```rust\nfn main() {}\n```\n");
        cells.push(Arc::new(AgentMarkdownCell::new(
            answer,
            std::path::Path::new("/tmp/project"),
        )));
    }
    cells
}

/// Whether a row of the last frame is the composer, showing exactly `typed` after its prompt.
fn composer_shows(tui: &tui::Tui, typed: &str) -> bool {
    let prefix = format!("› {typed}");
    buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
        &tui.terminal,
    ))
    .lines()
    .any(|line| {
        // Beside the Ledger, the row goes on past the Ledger's rule with the Ledger's text.
        line.strip_prefix(&prefix)
            .and_then(|rest| rest.split('│').next())
            .is_some_and(|draft_rest| draft_rest.trim().is_empty())
    })
}

fn assert_ledger_visible(tui: &tui::Tui) {
    let buffer = crate::custom_terminal::test_support::last_rendered_buffer(&tui.terminal);
    assert_eq!(
        buffer.area.width, SCREEN.width,
        "the frame must use the test screen"
    );
    assert!(
        buffer_text(buffer).contains("CONTEXT LEDGER"),
        "the Context Ledger must be visible in every frame of this test"
    );
}

/// One scheduled frame, as `App::handle_tui_event` handles `TuiEvent::Draw`, on a fixed screen.
/// (A test terminal cannot report a fixed size, so the draw event itself is not used.)
fn draw(app: &mut App, tui: &mut tui::Tui) -> Result<()> {
    if app
        .chat_widget
        .handle_paste_burst_tick(tui.frame_requester())
    {
        return Ok(());
    }
    app.chat_widget.pre_draw_tick();
    // The test backend reports its own size, so give the terminal the test screen each frame,
    // then take the frame's size the way the draw event does.
    tui.terminal.resize(SCREEN)?;
    let size = tui.screen_size_for_event(&TuiEvent::Draw)?;
    assert_eq!(size, SCREEN);
    app.render_chat_widget_frame(tui, size)?;
    Ok(())
}

/// A full-screen chat with `turns` turns behind the composer and the Context Ledger beside it.
struct Chat {
    app: Box<App>,
    server: AppServerSession,
    tui: tui::Tui,
    turns: usize,
    typed: String,
}

impl Chat {
    async fn new(turns: usize) -> Result<Self> {
        let (mut app, _events, _operations) = make_test_app_with_channels().await;
        crate::chatwidget::tests::helpers::show_context_ledger(&mut app.chat_widget);
        let server = Box::pin(crate::start_embedded_app_server_for_picker(&app.config)).await?;
        attach_thread(&mut app, ThreadId::new());
        app.transcript_cells = long_chat(turns);
        let mut tui = crate::tui::test_support::make_test_tui_with_size(SCREEN)?;
        tui.set_owned_screen(/*owned*/ true)?;
        // The first frame lays out the whole transcript once; later frames must not.
        draw(&mut app, &mut tui)?;
        assert_ledger_visible(&tui);
        Ok(Self {
            app,
            server,
            tui,
            turns,
            typed: String::new(),
        })
    }

    /// Types one character at a human pace. The frames that follow must show the typed text on
    /// the composer row. Returns the time to draw them.
    async fn type_char(&mut self, character: char) -> Result<Duration> {
        self.app
            .handle_tui_event(
                &mut self.tui,
                &mut self.server,
                TuiEvent::Key(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)),
            )
            .await?;
        self.typed.push(character);
        // A person types slower than the paste-burst window, so the held character is due by
        // the time the scheduled frame arrives.
        std::thread::sleep(crate::bottom_pane::ChatComposer::recommended_paste_flush_delay());
        // As in Codex, the frame that flushes a held character only requests the next frame,
        // which the scheduler sends at once. So the character must show within two frames.
        let started = std::time::Instant::now();
        for _ in 0..2 {
            draw(&mut self.app, &mut self.tui)?;
            if composer_shows(&self.tui, &self.typed) {
                break;
            }
        }
        let elapsed = started.elapsed();
        assert_ledger_visible(&self.tui);
        assert!(
            composer_shows(&self.tui, &self.typed),
            "after typing {:?} with {} turns, the frame is:\n{}",
            self.typed,
            self.turns,
            buffer_text(crate::custom_terminal::test_support::last_rendered_buffer(
                &self.tui.terminal
            ))
        );
        Ok(elapsed)
    }

    async fn close(mut self) -> Result<()> {
        self.tui.set_owned_screen(/*owned*/ false)?;
        self.server.shutdown().await?;
        Ok(())
    }
}

#[tokio::test]
async fn each_typed_character_draws_at_once_beside_the_ledger() -> Result<()> {
    let mut chat = Chat::new(/*turns*/ 3).await?;
    for character in "hello there".chars() {
        chat.type_char(character).await?;
    }
    chat.close().await
}

#[tokio::test]
async fn frame_cost_after_a_key_does_not_grow_with_the_chat() -> Result<()> {
    // 300 turns are 600 messages. Twenty times the turns may cost a little more for bookkeeping,
    // but a frame that lays out the whole chat again costs many times more. The two chats take
    // turns at each key, so other work on the machine slows both alike, and each keeps its
    // fastest frame.
    let mut short = Chat::new(/*turns*/ 15).await?;
    let mut long = Chat::new(/*turns*/ 300).await?;
    let mut short_best = Duration::MAX;
    let mut long_best = Duration::MAX;
    for character in "abcdefghij".chars() {
        short_best = short_best.min(short.type_char(character).await?);
        long_best = long_best.min(long.type_char(character).await?);
    }
    short.close().await?;
    long.close().await?;
    eprintln!(
        "fastest frame after a key: {short_best:?} with 15 turns, {long_best:?} with 300 turns"
    );
    assert!(
        long_best < short_best * 2,
        "a frame after a key took {short_best:?} with 15 turns and {long_best:?} with 300 turns"
    );
    // The launch target is 100 ms from key press to painted frame, in an optimized build.
    // Unoptimized test builds are slower, so this is only a coarse ceiling.
    assert!(
        long_best < Duration::from_millis(100),
        "a frame after a key took {long_best:?} with 300 turns"
    );
    Ok(())
}

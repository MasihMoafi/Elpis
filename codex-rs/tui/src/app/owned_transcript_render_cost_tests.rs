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

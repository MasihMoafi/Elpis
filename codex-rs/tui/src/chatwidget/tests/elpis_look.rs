//! Evals for the Elpis look: the product name on every title, the orange palette, the
//! composer rail, the identity line above the composer and the paced "Elpising…" status.
//!
//! Each behaviour has a positive case (the Elpis look is there) and a negative case
//! (the upstream Codex look is gone, or the thing Elpis must not disturb is intact).

use super::*;
use crate::history_cell::SessionHeaderHistoryCell;
use crate::status_indicator_widget::StatusIndicatorWidget;
use crate::status_indicator_widget::StatusTimer;
use crate::terminal_palette::with_test_default_colors;
use crate::terminal_probe::DefaultColors;
use pretty_assertions::assert_eq;

const DARK: DefaultColors = DefaultColors {
    fg: (222, 222, 219),
    bg: (17, 18, 20),
};

fn text_of(lines: &[Line<'static>]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect()
}

fn rows(buffer: &Buffer) -> Vec<String> {
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
        .map(|row| row.iter().map(ratatui::buffer::Cell::symbol).collect())
        .collect()
}

fn render_widget(widget: &ChatWidget, width: u16) -> Buffer {
    let renderable = widget.as_renderable();
    let height = renderable.desired_height(width);
    let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
    let mut buffer = Buffer::empty(area);
    renderable.render(area, &mut buffer);
    buffer
}

fn is_orange(color: ratatui::style::Color) -> bool {
    matches!(color, ratatui::style::Color::Rgb(r, g, b) if r >= g && g > b && r > 150)
}

#[test]
fn session_header_names_elpis_and_never_openai_codex() {
    let header = SessionHeaderHistoryCell::new(
        "gpt-test".to_string(),
        /*reasoning_effort*/ None,
        PathBuf::from("/tmp/project"),
        "test",
    );
    let full = text_of(&header.display_lines(/*width*/ 80));
    let raw = text_of(&header.raw_lines());

    let greeting = Arc::new(std::sync::OnceLock::new());
    greeting
        .set(crate::empty_state_animation::Greeting {
            phrase: "Pull up a prompt.",
        })
        .expect("greeting");
    let mut compact = SessionHeaderHistoryCell::new(
        "gpt-test".to_string(),
        /*reasoning_effort*/ None,
        PathBuf::from("/tmp/project"),
        "test",
    );
    crate::history_cell::set_session_greeting(&mut compact, &greeting);
    let compact = text_of(&compact.display_lines(/*width*/ 80));

    assert!(
        full.iter()
            .any(|row| row.trim_start().starts_with("◆ Elpis (vtest)")),
        "{full:?}"
    );
    assert!(compact.iter().any(|row| row.contains("◆ Elpis (vtest)")));
    assert_eq!(raw[0], "Elpis (vtest)");
    for row in full.iter().chain(&compact).chain(&raw) {
        assert!(!row.contains("OpenAI Codex"), "upstream title left: {row}");
        assert!(!row.contains(">_"), "upstream prompt glyph left: {row}");
    }
    // Codex 0.159 dropped the enclosing card, so there is no card to replace with the
    // v0.3.0 rail; the header must still carry no card corners.
    assert!(
        full.iter()
            .all(|row| !row.contains('╭') && !row.contains('╰'))
    );
}

#[test]
fn accent_is_elpis_orange_not_upstream_blue() {
    with_test_default_colors(DARK, || {
        let accent = crate::style::accent_style_for(Some(DARK.bg))
            .fg
            .expect("accent color");
        assert!(is_orange(accent), "{accent:?}");
        assert!(
            !matches!(accent, ratatui::style::Color::Rgb(r, g, b)
                if (r, g, b) == crate::style::CHATGPT_BLUE_200),
            "{accent:?}"
        );
    });
}

#[test]
fn working_status_reads_elpising_in_an_orange_gradient_without_a_spinner() {
    with_test_default_colors(DARK, || {
        let (tx, _rx) = unbounded_channel::<AppEvent>();
        for animations in [false, true] {
            let widget = StatusIndicatorWidget::new(
                AppEventSender::new(tx.clone()),
                FrameRequester::test_dummy(),
                animations,
                Default::default(),
            );
            let mut timer = StatusTimer::default();
            timer.pause_at(Instant::now());
            let area = Rect::new(0, 0, 80, 1);
            let mut buffer = Buffer::empty(area);
            widget.with_timer(&timer).render(area, &mut buffer);
            let row = &rows(&buffer)[0];
            assert!(row.starts_with("Elpising… (0s"), "{row}");
            assert!(!row.contains("Working"), "{row}");
            for column in 0..8 {
                assert!(
                    is_orange(buffer[(column, 0)].fg),
                    "column {column} is {:?}",
                    buffer[(column, 0)].fg
                );
            }
        }
    });
}

#[test]
fn other_status_headers_are_not_renamed() {
    let (tx, _rx) = unbounded_channel::<AppEvent>();
    let mut widget = StatusIndicatorWidget::new(
        AppEventSender::new(tx),
        FrameRequester::test_dummy(),
        /*animations_enabled*/ false,
        Default::default(),
    );
    widget.update_header("Compacting context".to_string());
    let mut timer = StatusTimer::default();
    timer.pause_at(Instant::now());
    let area = Rect::new(0, 0, 80, 1);
    let mut buffer = Buffer::empty(area);
    widget.with_timer(&timer).render(area, &mut buffer);
    assert!(rows(&buffer)[0].starts_with("Compacting context (0s"));
}

#[tokio::test]
async fn elpising_sweeps_fast_then_rests_between_sweeps() {
    let (tx, _rx) = unbounded_channel::<AppEvent>();
    let (frame_requester, mut frames) = FrameRequester::test_channel();
    let widget = StatusIndicatorWidget::new(
        AppEventSender::new(tx),
        frame_requester,
        /*animations_enabled*/ true,
        Default::default(),
    );
    let area = Rect::new(0, 0, 80, 1);
    let mut next_frame_after = |elapsed: Duration| {
        let mut timer = StatusTimer::default();
        timer.reset(elapsed);
        let before = Instant::now();
        widget
            .with_timer(&timer)
            .render(area, &mut Buffer::empty(area));
        let mut deadline = None;
        while let Ok(at) = frames.try_recv() {
            deadline = Some(at);
        }
        deadline
            .expect("an animated status schedules a frame")
            .saturating_duration_since(before)
    };

    // Mid-sweep: the next frame is one 40 ms motion tick away.
    assert!(next_frame_after(Duration::ZERO) < Duration::from_millis(100));
    // At rest: nothing redraws until the next sweep, seconds later.
    assert!(next_frame_after(Duration::from_secs(1)) >= Duration::from_secs(3));
}

#[tokio::test]
async fn run_state_reads_elpising_while_working_and_ready_when_idle() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.status_state.terminal_title_status_kind = TerminalTitleStatusKind::Working;
    chat.bottom_pane.set_task_running(/*running*/ true);
    assert_eq!(chat.run_state_status_text(), "Elpising…");
    chat.bottom_pane.set_task_running(/*running*/ false);
    assert_eq!(chat.run_state_status_text(), "Ready");
}

#[tokio::test]
async fn composer_wears_the_orange_rail_and_keeps_the_draft_intact() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane.insert_str("keep my draft");
    let buffer = with_test_default_colors(DARK, || render_widget(&chat, /*width*/ 80));
    let rows = rows(&buffer);
    let draft_row = rows
        .iter()
        .position(|row| row.contains("keep my draft"))
        .expect("draft row");
    // The rail runs down the composer's left edge; the prompt glyph takes the draft row,
    // as in v0.3.0.
    let rail_row = draft_row as u16 - 1;
    assert_eq!(buffer[(0, rail_row)].symbol(), "│");
    assert!(is_orange(buffer[(0, rail_row)].fg));
    // The rail is drawn around the text, never over it.
    assert!(
        rows[draft_row].contains("› keep my draft"),
        "{}",
        rows[draft_row]
    );
}

#[tokio::test]
async fn placeholder_invites_elpis_not_codex() {
    let (chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let rows = rows(&render_widget(&chat, /*width*/ 80));
    assert!(
        rows.iter()
            .any(|row| row.contains("Ask Elpis to do anything"))
    );
    assert!(rows.iter().all(|row| !row.contains("Ask Codex")));
}

#[tokio::test]
async fn identity_line_sits_directly_above_the_composer() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.refresh_status_surfaces();
    let buffer = with_test_default_colors(DARK, || render_widget(&chat, /*width*/ 80));
    let rows = rows(&buffer);
    let model = chat.current_model().to_string();
    let identity = rows
        .iter()
        .position(|row| row.starts_with(&format!(" Elpis · model {model} · location ")))
        .unwrap_or_else(|| panic!("no identity line in {rows:#?}"));
    let composer_top = rows
        .iter()
        .position(|row| row.starts_with('│'))
        .expect("composer rail");
    assert_eq!(identity + 1, composer_top, "{rows:#?}");
    assert!(is_orange(buffer[(1, identity as u16)].fg));
    // The upstream footer status line stays off: the identity line replaces it, so the
    // model is named once, not again in the footer.
    assert_eq!(
        rows.iter()
            .filter(|row| row.contains(model.as_str()))
            .count(),
        1,
        "{rows:#?}"
    );
}

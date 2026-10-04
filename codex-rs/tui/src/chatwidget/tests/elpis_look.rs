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

fn is_teal(color: ratatui::style::Color) -> bool {
    matches!(color, ratatui::style::Color::Rgb(r, g, b) if g > r && b > r)
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
async fn composer_wears_the_teal_box_and_keeps_the_draft_intact() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane.insert_str("keep my draft");
    let buffer = with_test_default_colors(DARK, || render_widget(&chat, /*width*/ 80));
    let rows = rows(&buffer);
    let draft_row = rows
        .iter()
        .position(|row| row.contains("keep my draft"))
        .expect("draft row");
    // A thin teal rule box frames the composer in the cells that Codex leaves blank around the
    // draft. The first column stays Codex's prompt column, so the box has no left side.
    let top_row = draft_row as u16 - 1;
    assert_eq!(buffer[(0, top_row)].symbol(), "─");
    assert_eq!(buffer[(0, draft_row as u16)].symbol(), "›");
    assert!(is_teal(buffer[(0, top_row)].fg));
    for (row, line) in rows.iter().enumerate() {
        assert!(
            !matches!(buffer[(0, row as u16)].symbol(), "│" | "┌" | "└"),
            "the box drew in the prompt column: {line:?}"
        );
    }
    // The box is drawn around the text, never over it.
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
        .position(|row| {
            row.starts_with(&format!(" Elpis · model {model} ")) && row.contains(" · location ")
        })
        .unwrap_or_else(|| panic!("no identity line in {rows:#?}"));
    // The box's top rule; the box has no left side, which is Codex's prompt column.
    let composer_top = rows
        .iter()
        .position(|row| row.starts_with('─'))
        .expect("composer box");
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

#[tokio::test]
async fn identity_line_names_the_conversation_once_it_has_a_title() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    chat.refresh_status_surfaces();
    let identity_row = |chat: &ChatWidget| {
        let buffer = with_test_default_colors(DARK, || render_widget(chat, /*width*/ 120));
        rows(&buffer)
            .into_iter()
            .find(|row| row.starts_with(" Elpis · model "))
            .expect("identity line")
    };

    let untitled = identity_row(&chat);
    assert!(!untitled.contains("Fix login refresh bug"), "{untitled}");

    chat.on_thread_name_updated(thread_id, Some("  Fix login refresh bug ".to_string()));
    assert!(
        identity_row(&chat)
            .trim_end()
            .ends_with("· Fix login refresh bug"),
        "{}",
        identity_row(&chat)
    );
}

#[tokio::test]
async fn identity_line_shows_the_reasoning_effort_as_it_changes() {
    // Alt+, and Alt+. change the effort; the identity line is where that shows (Elpis turns the
    // upstream status line off).
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let identity_row = |chat: &ChatWidget| {
        let buffer = with_test_default_colors(DARK, || render_widget(chat, /*width*/ 120));
        rows(&buffer)
            .into_iter()
            .find(|row| row.starts_with(" Elpis · model "))
            .expect("identity line")
    };
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::Low));
    let low = identity_row(&chat);
    assert!(
        low.contains(&format!(
            "gpt-5.5 {} · location",
            chat.reasoning_display_name()
        )),
        "{low}"
    );

    chat.set_reasoning_effort(Some(ReasoningEffortConfig::High));
    let high = identity_row(&chat);
    assert_ne!(
        low, high,
        "the effort change left the identity line unchanged"
    );
    assert!(
        high.contains(&format!(
            "gpt-5.5 {} · location",
            chat.reasoning_display_name()
        )),
        "{high}"
    );
}

#[tokio::test]
async fn footer_shows_the_goal_state_beside_the_context_indicator() {
    // Upstream draws the goal state only in its status line, which Elpis turns off.
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.set_feature_enabled(Feature::Goals, /*enabled*/ true);
    chat.show_welcome_banner = false;
    let screen = |chat: &ChatWidget| {
        let buffer = with_test_default_colors(DARK, || render_widget(chat, /*width*/ 140));
        rows(&buffer).join("\n")
    };
    assert!(!screen(&chat).contains("Pursuing goal"));

    chat.handle_server_notification(
        ServerNotification::ThreadGoalUpdated(
            codex_app_server_protocol::ThreadGoalUpdatedNotification {
                thread_id: "thread-1".to_string(),
                turn_id: None,
                goal: codex_app_server_protocol::ThreadGoal {
                    thread_id: "thread-1".to_string(),
                    objective: "Keep improving the benchmark".to_string(),
                    status: codex_app_server_protocol::ThreadGoalStatus::Active,
                    token_budget: Some(50_000),
                    tokens_used: 40_000,
                    time_used_seconds: 30 * 60,
                    created_at: 0,
                    updated_at: 0,
                },
            },
        ),
        /*replay_kind*/ None,
    );

    let shown = screen(&chat);
    assert!(shown.contains("Pursuing goal (40K / 50K)"), "{shown}");
}

#[tokio::test]
async fn composer_box_shares_the_ledger_rule_and_closes_itself_without_the_ledger() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let rows_now = |chat: &ChatWidget| {
        rows(&with_test_default_colors(DARK, || {
            render_widget(chat, /*width*/ 120)
        }))
    };
    let beside = rows_now(&chat);
    let top = beside
        .iter()
        .find(|row| row.starts_with('─'))
        .expect("composer box");
    assert!(top.contains("─┐ CONTEXT LEDGER"), "{beside:#?}");
    assert!(beside.iter().all(|row| !row.contains("││")), "{beside:#?}");

    chat.close_context_ledger();
    let alone = rows_now(&chat);
    let top = alone
        .iter()
        .find(|row| row.starts_with('─'))
        .expect("composer box");
    assert!(top.trim_end().ends_with('┐'), "{alone:#?}");
}

#[tokio::test]
async fn full_screen_hides_a_crowded_ledger_until_it_is_opened() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let short = ratatui::layout::Size::new(/*width*/ 120, /*height*/ 20);
    let tall = ratatui::layout::Size::new(/*width*/ 120, /*height*/ 80);

    chat.fit_context_ledger_to_screen(Some(tall));
    assert!(chat.context_ledger_width(120) > 0, "room: the Ledger shows");
    chat.fit_context_ledger_to_screen(Some(short));
    assert_eq!(
        chat.context_ledger_width(120),
        0,
        "crowded: the Ledger hides"
    );
    chat.fit_context_ledger_to_screen(/*screen*/ None);
    assert!(
        chat.context_ledger_width(120) > 0,
        "inline mode always shows it"
    );

    chat.fit_context_ledger_to_screen(Some(short));
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    chat.fit_context_ledger_to_screen(Some(short));
    assert!(
        chat.context_ledger_width(120) > 0,
        "Alt+C opens a crowded Ledger"
    );
}

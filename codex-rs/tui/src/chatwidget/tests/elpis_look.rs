//! Acceptance checks for native Codex presentation with Elpis names and the retained Ledger.

use super::*;
use crate::history_cell::SessionHeaderHistoryCell;
use pretty_assertions::assert_eq;

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

    let narrow = text_of(&header.display_lines(/*width*/ 24));

    assert!(
        full.iter()
            .any(|row| row.trim_start().starts_with(">_ Elpis (vtest)")),
        "{full:?}"
    );
    assert!(narrow.iter().any(|row| row.contains(">_ Elpis (vtest)")));
    assert_eq!(raw[0], "Elpis (vtest)");
    for row in full.iter().chain(&narrow).chain(&raw) {
        assert!(!row.contains("OpenAI Codex"), "upstream title left: {row}");
    }
    // Codex 0.159 dropped the enclosing card, so there is no card to replace with the
    // v0.3.0 rail; the header must still carry no card corners.
    assert!(
        full.iter()
            .all(|row| !row.contains('╭') && !row.contains('╰'))
    );
}

#[tokio::test]
async fn run_state_uses_native_working_and_ready_labels() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.status_state.terminal_title_status_kind = TerminalTitleStatusKind::Working;
    chat.bottom_pane.set_task_running(/*running*/ true);
    assert_eq!(chat.run_state_status_text(), "Elpising");
    chat.bottom_pane.set_task_running(/*running*/ false);
    assert_eq!(chat.run_state_status_text(), "Ready");
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
async fn a_crowded_ledger_hides_until_it_is_opened() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    show_context_ledger(&mut chat);
    let short = ratatui::layout::Size::new(/*width*/ 120, /*height*/ 20);
    let tall = ratatui::layout::Size::new(/*width*/ 120, /*height*/ 80);

    chat.fit_context_ledger_to_screen(tall);
    assert!(chat.context_ledger_width(120) > 0, "room: the Ledger shows");
    chat.fit_context_ledger_to_screen(short);
    assert_eq!(
        chat.context_ledger_width(120),
        0,
        "crowded: the Ledger hides"
    );
    chat.fit_context_ledger_to_screen(tall);
    assert!(
        chat.context_ledger_width(120) > 0,
        "more room restores the Ledger"
    );

    chat.fit_context_ledger_to_screen(short);
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT));
    chat.fit_context_ledger_to_screen(short);
    assert!(
        chat.context_ledger_width(120) > 0,
        "Alt+C opens a crowded Ledger"
    );
}

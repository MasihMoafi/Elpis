//! Exercise recovery through emitted terminal bytes, including a cleared physical screen.

use super::*;
use pretty_assertions::assert_eq;

fn screen_text(terminal: &Terminal<VT100Backend>) -> String {
    terminal
        .backend()
        .vt100()
        .screen()
        .contents()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned()
}

#[test]
fn empty_active_frame_repaints_the_previous_screen() {
    let area = Rect::new(0, 0, 80, 12);
    let mut terminal = Terminal::with_options(VT100Backend::new(80, 12)).expect("terminal");
    terminal.set_viewport_area(area);
    terminal
        .draw(|frame| {
            Paragraph::new(
                ">_ Elpis\nfirst prompt\nCONTEXT LEDGER\nQueued follow-up inputs\nsecond prompt",
            )
            .render(area, frame.buffer_mut());
        })
        .expect("first frame");
    let expected = screen_text(&terminal);

    // The emulator loses its contents independently of the diff buffers. Recovery must emit
    // the whole screen even though the recovered cells equal the last rendered frame.
    write!(terminal.backend_mut(), "\x1b[2J\x1b[Hstale cells").expect("clear physical screen");
    terminal
        .draw(|frame| assert!(frame.redraw_if_empty()))
        .expect("recover empty active frame");
    assert_eq!(screen_text(&terminal), expected);

    terminal
        .draw(|frame| {
            Paragraph::new("next response").render(area, frame.buffer_mut());
            assert!(!frame.redraw_if_empty());
        })
        .expect("next normal frame");
    assert_eq!(screen_text(&terminal), "next response");
}

#[test]
fn empty_first_active_frame_shows_progress() {
    let area = Rect::new(0, 0, 80, 12);
    let mut terminal = Terminal::with_options(VT100Backend::new(80, 12)).expect("terminal");
    terminal.set_viewport_area(area);
    terminal
        .draw(|frame| assert!(frame.redraw_if_empty()))
        .expect("recover first empty frame");
    assert_eq!(screen_text(&terminal), "Elpising…");
}

#[test]
fn empty_idle_frame_can_clear_the_screen() {
    let area = Rect::new(0, 0, 80, 12);
    let mut terminal = Terminal::with_options(VT100Backend::new(80, 12)).expect("terminal");
    terminal.set_viewport_area(area);
    terminal
        .draw(|frame| Paragraph::new("previous response").render(area, frame.buffer_mut()))
        .expect("first frame");
    // Idle screens do not request recovery.
    terminal.draw(|_| {}).expect("idle empty frame");
    assert_eq!(screen_text(&terminal), "");
}

#[test]
fn nonempty_active_frame_keeps_incremental_drawing() {
    let area = Rect::new(0, 0, 80, 12);
    let mut terminal = Terminal::with_options(CaptureBackend::new(80, 12)).expect("terminal");
    terminal.set_viewport_area(area);
    let render = |frame: &mut Frame<'_>| {
        Paragraph::new("Elpising").render(area, frame.buffer_mut());
        assert!(!frame.redraw_if_empty());
    };
    terminal.draw(render).expect("first frame");
    terminal.backend_mut().output.clear();
    terminal.draw(render).expect("unchanged frame");
    // Ordinary draws finish with color/style resets even when there are no cell updates.
    assert_eq!(terminal.backend().output(), "\x1b[39m\x1b[49m\x1b[0m");
}

#[test]
fn empty_zero_sized_frame_does_not_request_another_draw() {
    let mut terminal = Terminal::with_options(CaptureBackend::new(80, 12)).expect("terminal");
    terminal
        .draw(|frame| assert!(!frame.redraw_if_empty()))
        .expect("zero sized viewport");
}

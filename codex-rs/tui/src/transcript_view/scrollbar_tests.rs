//! The scrollbar appears only after the conversation overflows, follows the visible messages,
//! and jumps to the message under the pointer.

use super::*;
use crate::history_cell::PlainHistoryCell;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use pretty_assertions::assert_eq;

fn messages(count: usize) -> Vec<Arc<dyn HistoryCell>> {
    (0..count)
        .map(|index| {
            Arc::new(PlainHistoryCell::new(vec![
                format!("message {index:02}").into(),
            ])) as Arc<dyn HistoryCell>
        })
        .collect()
}

fn press(kind: MouseEventKind, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column: 11,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

/// Draw the body beside a one-column track the way the full-screen transcript does.
fn draw(view: &mut TranscriptView, cells: &[Arc<dyn HistoryCell>]) -> (Buffer, bool) {
    let mut buffer = Buffer::empty(Rect::new(
        /*x*/ 0, /*y*/ 0, /*width*/ 12, /*height*/ 5,
    ));
    let width = u16::from(view.reserves_scrollbar());
    view.render(
        Rect::new(/*x*/ 0, /*y*/ 0, 12 - width, 5),
        &mut buffer,
        cells,
    );
    let reserved =
        view.render_scrollbar(Rect::new(/*x*/ 11, /*y*/ 0, width, 5), &mut buffer, cells);
    (buffer, reserved)
}

fn track(buffer: &Buffer) -> String {
    (0..5).map(|y| buffer[(11, y)].symbol()).collect()
}

#[test]
fn short_conversations_keep_every_column_for_text() {
    let cells = messages(3);
    let mut view = TranscriptView::default();
    let (buffer, reserved) = draw(&mut view, &cells);
    assert!(!reserved);
    assert!(!view.reserves_scrollbar());
    assert_eq!(track(&buffer), "     ");
    assert!(
        !view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 0), &cells)
    );
}

#[test]
fn overflowing_conversation_shows_a_thumb_over_the_visible_messages() {
    let cells = messages(20);
    let mut view = TranscriptView::default();
    assert!(
        draw(&mut view, &cells).1,
        "first overflow reserves the column"
    );
    let (buffer, reserved) = draw(&mut view, &cells);
    assert!(!reserved);
    let latest = track(&buffer);
    assert!(latest.starts_with('│') && latest.ends_with('┃'), "{latest}");
    view.jump_to_beginning(&cells);
    let beginning = track(&draw(&mut view, &cells).0);
    assert!(
        beginning.starts_with('┃') && beginning.ends_with('│'),
        "{beginning}"
    );
}

#[test]
fn dragging_the_thumb_jumps_to_that_message_and_the_last_row_returns_to_latest() {
    let mut cells = messages(20);
    let mut view = TranscriptView::default();
    draw(&mut view, &cells);
    draw(&mut view, &cells);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 0), &cells));
    draw(&mut view, &cells);
    assert_eq!(view.visible.first().map(|row| row.index), Some(0));
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Drag(MouseButton::Left), 2), &cells));
    draw(&mut view, &cells);
    let middle = view.visible.first().unwrap().index;
    assert!((7..12).contains(&middle), "estimated middle entry {middle}");
    cells.extend(messages(20));
    draw(&mut view, &cells);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Drag(MouseButton::Left), 2), &cells));
    draw(&mut view, &cells);
    assert_eq!(
        view.visible.first().unwrap().index,
        middle,
        "new output does not move the drag target"
    );
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Drag(MouseButton::Left), 4), &cells));
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Up(MouseButton::Left), 4), &cells));
    draw(&mut view, &cells);
    assert!(view.is_following());
    assert!(
        !view.handle_scrollbar_mouse(press(MouseEventKind::Drag(MouseButton::Left), 1), &cells)
    );
}

#[test]
fn dragging_inside_one_long_message_reaches_its_middle() {
    let cells: Vec<Arc<dyn HistoryCell>> = vec![Arc::new(PlainHistoryCell::new(
        (0..100).map(|row| format!("row {row:02}").into()).collect(),
    ))];
    let mut view = TranscriptView::default();
    draw(&mut view, &cells);
    draw(&mut view, &cells);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 2), &cells));
    draw(&mut view, &cells);
    let first = view.visible.first().expect("long message remains visible");
    assert_eq!(first.index, 0);
    assert_eq!(first.row, 40);
}

#[test]
fn short_prompt_does_not_take_half_the_track_before_a_long_answer() {
    let mut cells = messages(1);
    cells.push(Arc::new(PlainHistoryCell::new(
        (0..100).map(|row| format!("row {row:02}").into()).collect(),
    )));
    let mut view = TranscriptView::default();
    draw(&mut view, &cells);
    draw(&mut view, &cells);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 0), &cells));
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Up(MouseButton::Left), 0), &cells));
    draw(&mut view, &cells);
    assert_eq!(view.visible.first().unwrap().index, 0);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 2), &cells));
    draw(&mut view, &cells);
    let first = view.visible.first().unwrap();
    assert_eq!(first.index, 1);
    assert!((35..45).contains(&first.row), "answer row {}", first.row);
}

#[test]
fn measured_heights_are_discarded_when_a_message_is_replaced() {
    let mut cells = messages(1);
    cells.push(Arc::new(PlainHistoryCell::new(vec!["long".into(); 100])));
    let mut view = TranscriptView::default();
    draw(&mut view, &cells);
    draw(&mut view, &cells);
    assert!(track(&draw(&mut view, &cells).0).starts_with('│'));
    cells[1] = Arc::new(PlainHistoryCell::new(vec!["short".into()]));
    view.jump_to_latest();
    assert_eq!(track(&draw(&mut view, &cells).0), "┃┃┃┃┃");
}

#[test]
fn scrollbar_can_reach_the_middle_of_a_live_answer() {
    let cells = messages(1);
    let mut view = TranscriptView::default();
    view.sync_live_tail(12, None, |_| {
        Some((0..100).map(|row| format!("row {row:02}").into()).collect())
    });
    draw(&mut view, &cells);
    view.sync_live_tail(11, None, |_| {
        Some((0..100).map(|row| format!("row {row:02}").into()).collect())
    });
    draw(&mut view, &cells);
    assert!(view.handle_scrollbar_mouse(press(MouseEventKind::Down(MouseButton::Left), 2), &cells));
    draw(&mut view, &cells);
    let first = view.visible.first().unwrap();
    assert_eq!(first.index, cells.len());
    assert!(
        (35..45).contains(&first.row),
        "live answer row {}",
        first.row
    );
}

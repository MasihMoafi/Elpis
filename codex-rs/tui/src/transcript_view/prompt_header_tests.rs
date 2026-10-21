//! Sticky context follows the visible turn while leaving source text and hit rows intact.

use super::*;
use crate::history_cell::new_spoken_user_prompt;
use crate::history_cell::new_user_prompt;
use crate::transcript_view::tests::cell;
use crate::transcript_view::tests::render;
use crate::transcript_view::tests::text;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use pretty_assertions::assert_eq;
use ratatui::style::Modifier;

fn user(message: &str) -> Arc<dyn HistoryCell> {
    Arc::new(new_user_prompt(
        message.into(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    ))
}

#[test]
fn pinned_user_prompt_mouse_copy_preserves_original_spaces_newlines_and_farsi() {
    for message in [
        "copy   these words\nسلام دنیا، پیام خودم",
        "سلام دنیا،\n  پیام   خودم",
        "› literal marker and e\u{301} 界界\nsecond line",
    ] {
        for width in [28, 80] {
            let cells = vec![user(message), cell("answer\n".repeat(20))];
            let mut view = TranscriptView {
                copy_on_select: true,
                ..Default::default()
            };
            let before = render(&mut view, &cells, width, /*height*/ 5);
            assert_eq!(view.area.y, 1);
            let header = text(&before).lines().next().unwrap().to_owned();
            let end_column = crate::width::display_width(header.trim_end_matches('…')) as u16;
            for (kind, column) in [
                (MouseEventKind::Down(MouseButton::Left), 2),
                (MouseEventKind::Drag(MouseButton::Left), end_column),
            ] {
                assert!(matches!(
                    view.handle_mouse(
                        MouseEvent {
                            kind,
                            column,
                            row: 0,
                            modifiers: KeyModifiers::NONE
                        },
                        &cells
                    ),
                    Some(ViewAction::Changed)
                ));
            }
            let selected = view
                .selected_text(&cells)
                .expect("pinned user text must be selectable");
            // The old code returns None here: the pinned prompt is above view.area.
            assert!(message.starts_with(&selected), "{selected:?}");
            if width == 80 {
                assert_eq!(selected, message);
            }
            let painted = render(&mut view, &cells, width, /*height*/ 5);
            assert!(painted[(2, 0)].modifier.contains(Modifier::REVERSED));
            let Some(ViewAction::CopyOnSelect(copied)) = view.handle_mouse(
                MouseEvent {
                    kind: MouseEventKind::Up(MouseButton::Left),
                    column: end_column,
                    row: 0,
                    modifiers: KeyModifiers::NONE,
                },
                &cells,
            ) else {
                panic!("release must copy the pinned prompt")
            };
            assert_eq!(copied, selected);
            view.copy_selected_text_with(
                &cells,
                &copied,
                /*clear_selection*/ false,
                |text, format| {
                    assert_eq!(text, selected);
                    assert_eq!(format, crate::clipboard_copy::CopyFormat::PlainText);
                    Ok(crate::clipboard_copy::CopyStatus::Confirmed)
                },
            )
            .unwrap();
        }
    }
}

#[test]
fn pinned_user_prompt_copies_only_selected_words_with_copy_on_select_enabled_or_disabled() {
    let cells = vec![
        user("prefix copy   these words\nسلام دنیا\nsuffix"),
        cell("answer\n".repeat(20)),
    ];
    for automatic in [false, true] {
        for backwards in [false, true] {
            let mut view = TranscriptView {
                copy_on_select: automatic,
                ..Default::default()
            };
            render(&mut view, &cells, /*width*/ 80, /*height*/ 5);
            let (from, to) = if backwards { (25, 9) } else { (9, 25) };
            for (kind, column) in [
                (MouseEventKind::Down(MouseButton::Left), from),
                (MouseEventKind::Drag(MouseButton::Left), to),
            ] {
                view.handle_mouse(
                    MouseEvent {
                        kind,
                        column,
                        row: 0,
                        modifiers: KeyModifiers::NONE,
                    },
                    &cells,
                );
            }
            let action = view.handle_mouse(
                MouseEvent {
                    kind: MouseEventKind::Up(MouseButton::Left),
                    column: to,
                    row: 0,
                    modifiers: KeyModifiers::NONE,
                },
                &cells,
            );
            match (automatic, action) {
                (true, Some(ViewAction::CopyOnSelect(copied))) => {
                    assert_eq!(copied, "copy   these words")
                }
                (false, Some(ViewAction::Changed)) => {}
                _ => panic!("release must honor copy_on_select"),
            }
            let Some(ViewAction::Copy(copied)) = view.handle_key(
                KeyEvent::new(KeyCode::Insert, KeyModifiers::CONTROL),
                &cells,
            ) else {
                panic!("explicit copy must still work")
            };
            assert_eq!(copied, "copy   these words");
        }
    }
}

#[test]
fn pinned_prompt_mouse_copy_keeps_reply_selection_unchanged() {
    let cells = vec![user("my own prompt"), cell("alpha beta gamma\n".repeat(20))];
    let mut view = TranscriptView {
        copy_on_select: true,
        ..Default::default()
    };
    render(&mut view, &cells, /*width*/ 30, /*height*/ 5);
    for (kind, column) in [
        (MouseEventKind::Down(MouseButton::Left), 0),
        (MouseEventKind::Drag(MouseButton::Left), 5),
    ] {
        view.handle_mouse(
            MouseEvent {
                kind,
                column,
                row: 1,
                modifiers: KeyModifiers::NONE,
            },
            &cells,
        );
    }
    let Some(ViewAction::CopyOnSelect(copied)) = view.handle_mouse(
        MouseEvent {
            kind: MouseEventKind::Up(MouseButton::Left),
            column: 5,
            row: 1,
            modifiers: KeyModifiers::NONE,
        },
        &cells,
    ) else {
        panic!("reply selection must still copy")
    };
    assert_eq!(copied, "alpha");
}

#[test]
fn prompt_header_tracks_reading_and_yields_to_visible_prompts_and_short_screens() {
    let mut cells = vec![
        user("First question"),
        cell("one\ntwo\nthree\nfour\nfive"),
        user("Second café\nquestion"),
        user("\u{0007}"),
        cell("six\nseven\neight\nnine\nten"),
    ];
    let mut view = TranscriptView::default();
    let mut snapshots = Vec::new();
    snapshots.push(format!(
        "Latest\n{}",
        text(&render(
            &mut view, &cells, /*width*/ 30, /*height*/ 5
        ))
    ));
    assert_eq!(view.area.y, 1);
    view.jump_to_entry(&cells, /*index*/ 1);
    snapshots.push(format!(
        "Earlier answer\n{}",
        text(&render(
            &mut view, &cells, /*width*/ 30, /*height*/ 5
        ))
    ));
    assert_eq!(view.visible[0].index, 1);
    cells.insert(/*index*/ 0, user("Prepend history"));
    view.history_loaded(&cells, 0..1);
    snapshots.push(format!(
        "After prepend\n{}",
        text(&render(
            &mut view, &cells, /*width*/ 30, /*height*/ 5
        ))
    ));
    view.jump_to_entry(&cells, /*index*/ 1);
    snapshots.push(format!(
        "Prompt visible\n{}",
        text(&render(
            &mut view, &cells, /*width*/ 30, /*height*/ 5
        ))
    ));
    assert_eq!(view.area.y, 0);
    view.jump_to_latest();
    snapshots.push(format!(
        "Short screen\n{}",
        text(&render(
            &mut view, &cells, /*width*/ 30, /*height*/ 3
        ))
    ));
    assert_eq!(view.area.y, 0);
    insta::assert_snapshot!(snapshots.join("\n\n"));
}

#[test]
fn header_sanitizes_controls_and_truncates_by_display_width() {
    let cells = vec![user("\x1b[31m界 café\r\nnext question"), cell("answer")];
    let line = line(&cells, /*first*/ 1, /*width*/ 18).unwrap();
    assert!(line.width() <= 18);
    insta::assert_snapshot!(line.to_string());
}

#[test]
fn pinned_prompt_matches_the_original_prompt_style() {
    for prompt in [
        new_user_prompt("keep going".into(), Vec::new(), Vec::new(), Vec::new()),
        new_spoken_user_prompt("keep going".into()),
    ] {
        let width = 30;
        let mut expected = Buffer::empty(Rect::new(
            /*x*/ 0, /*y*/ 0, width, /*height*/ 3,
        ));
        TextLayout::new(prompt.transcript_hyperlink_lines(width), width).render(
            expected.area,
            &mut expected,
            /*start_row*/ 0,
        );
        let cells: Vec<Arc<dyn HistoryCell>> = vec![
            Arc::new(prompt),
            cell("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight"),
        ];
        let mut view = TranscriptView::default();
        let actual = render(&mut view, &cells, width, /*height*/ 7);

        assert_eq!(
            &actual.content[..usize::from(width)],
            &expected.content[usize::from(width)..usize::from(width * 2)]
        );
        assert_eq!(view.area.y, 1);
    }
}

#[test]
fn mouse_selection_preserves_header_reservation_at_turn_boundaries() {
    let cells = vec![
        user("First question"),
        cell("first answer"),
        user("Second question"),
        cell("done 10:16 AM"),
    ];
    for width in [40, 15] {
        for height in [6, 7, 8] {
            for drag in [false, true] {
                let mut view = TranscriptView::default();
                let before = render(&mut view, &cells, width, height);
                let down = MouseEvent {
                    kind: MouseEventKind::Down(MouseButton::Left),
                    column: 5,
                    row: height - 1,
                    modifiers: KeyModifiers::NONE,
                };
                view.handle_mouse(down, &cells);
                assert_eq!(
                    render(&mut view, &cells, width, height),
                    before,
                    "mouse down at {width}x{height}"
                );
                if !drag {
                    view.handle_mouse(
                        MouseEvent {
                            kind: MouseEventKind::Up(MouseButton::Left),
                            ..down
                        },
                        &cells,
                    );
                    assert_eq!(
                        (
                            render(&mut view, &cells, width, height),
                            view.selected_text(&cells),
                            view.is_following(),
                        ),
                        (before, None, true),
                        "empty release at {width}x{height}"
                    );
                    continue;
                }
                let end = MouseEvent {
                    kind: MouseEventKind::Drag(MouseButton::Left),
                    column: 13,
                    ..down
                };
                view.handle_mouse(end, &cells);
                let selected = render(&mut view, &cells, width, height);
                assert_eq!(text(&selected), text(&before));
                assert_eq!(view.selected_text(&cells).as_deref(), Some("10:16 AM"));
                view.handle_mouse(
                    MouseEvent {
                        kind: MouseEventKind::Up(MouseButton::Left),
                        ..end
                    },
                    &cells,
                );
                assert_eq!(render(&mut view, &cells, width, height), selected);
                let Some(ViewAction::Copy(copied)) = view.handle_key(
                    KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                    &cells,
                ) else {
                    panic!("copy selection at {width}x{height}");
                };
                assert_eq!(copied, "10:16 AM");
                assert_eq!(
                    selected
                        .content
                        .iter()
                        .filter(|cell| cell.modifier.contains(Modifier::REVERSED))
                        .map(ratatui::buffer::Cell::symbol)
                        .collect::<String>(),
                    copied
                );
            }
        }
    }
}

#[test]
fn paused_header_reservation_survives_copy_until_scroll_or_resize() {
    let cells = vec![
        user("First question"),
        cell("first answer"),
        user("Second question"),
        cell("done 10:16 AM"),
    ];
    for scroll in [false, true] {
        let mut view = TranscriptView::default();
        let before = render(&mut view, &cells, /*width*/ 40, /*height*/ 7);
        view.begin_selection(&cells, /*column*/ 0, /*row*/ 6, /*clicks*/ 2);
        assert_eq!(
            text(&render(
                &mut view, &cells, /*width*/ 40, /*height*/ 7
            )),
            text(&before)
        );
        let selected = view.selected_text(&cells).expect("selected word");
        assert_eq!(selected, "done");
        view.copy_selected_text_with(
            &cells,
            &selected,
            /*clear_selection*/ true,
            |_, _format| Ok(crate::clipboard_copy::CopyStatus::Confirmed),
        )
        .expect("confirmed copy");
        let bookmark = view.bookmark(&cells);
        view.set_presentation(/*detailed*/ true, HistoryRenderMode::Rich);
        view.jump_to_entry(&cells, /*index*/ 0);
        render(&mut view, &cells, /*width*/ 40, /*height*/ 7);
        view.restore_bookmark(bookmark);
        assert_eq!(
            (
                render(&mut view, &cells, /*width*/ 40, /*height*/ 7),
                view.is_following(),
            ),
            (before, false)
        );
        let height = if scroll {
            view.scroll(&cells, /*rows*/ -1);
            7
        } else {
            8
        };
        render(&mut view, &cells, /*width*/ 40, height);
        assert_eq!(view.area.y, 1);
    }
}

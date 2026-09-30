//! Evals for the Elpis composer behaviour in `elpis_composer.rs`.
//!
//! Each behaviour has a positive case (the Elpis behaviour happens) and a negative case (the
//! input the behaviour must leave alone still takes its ordinary path).

use super::super::tests::new_test_composer;
use super::*;
use pretty_assertions::assert_eq;

fn press(composer: &mut ChatComposer, code: KeyCode) -> (InputResult, bool) {
    composer.handle_key_event(KeyEvent::new(code, KeyModifiers::NONE))
}

fn composer_with_text(text: &str, running: bool) -> ChatComposer {
    let (mut composer, _rx) = new_test_composer();
    composer.set_task_running(running);
    composer.draft.textarea.set_text_clearing_elements(text);
    composer
        .draft
        .textarea
        .set_cursor(composer.draft.textarea.text().len());
    composer
}

// U20: backslash then Enter continues the line.

#[test]
fn backslash_enter_replaces_marker_with_newline_during_a_turn() {
    let mut composer = composer_with_text("first line", /*running*/ true);

    let (backslash_result, _) = press(&mut composer, KeyCode::Char('\\'));
    assert_eq!(InputResult::None, backslash_result);

    let (enter_result, needs_redraw) = press(&mut composer, KeyCode::Enter);

    assert_eq!(InputResult::None, enter_result);
    assert!(needs_redraw);
    assert_eq!("first line\n", composer.draft.textarea.text());
}

#[test]
fn backslash_enter_replaces_marker_with_newline_while_idle() {
    let mut composer = composer_with_text("first line", /*running*/ false);

    let (backslash_result, _) = press(&mut composer, KeyCode::Char('\\'));
    assert_eq!(InputResult::None, backslash_result);

    let (enter_result, _) = press(&mut composer, KeyCode::Enter);

    assert_eq!(InputResult::None, enter_result);
    assert_eq!("first line\n", composer.draft.textarea.text());
}

#[test]
fn backslash_enter_requires_marker_immediately_before_cursor() {
    let mut composer = composer_with_text("keep \\ literal", /*running*/ false);

    let (result, _) = press(&mut composer, KeyCode::Enter);

    assert!(
        matches!(&result, InputResult::Submitted { text, .. } if text == "keep \\ literal"),
        "a backslash away from the cursor must not stop Enter from sending, got {result:?}"
    );
}

#[test]
fn backslash_enter_keeps_backslash_literal_in_active_paste_burst() {
    let (mut composer, _rx) = new_test_composer();
    composer
        .draft
        .paste_burst
        .begin_with_retro_grabbed(String::new(), Instant::now());

    for ch in ['a', '\\'] {
        let (result, _) = press(&mut composer, KeyCode::Char(ch));
        assert_eq!(InputResult::None, result);
    }

    let (enter_result, _) = press(&mut composer, KeyCode::Enter);
    assert_eq!(InputResult::None, enter_result);
    assert!(composer.draft.textarea.text().is_empty());

    std::thread::sleep(PasteBurst::recommended_active_flush_delay());
    assert!(composer.flush_paste_burst_if_due());
    assert_eq!("a\\\n", composer.draft.textarea.text());
}

#[test]
fn backslash_away_from_cursor_still_queues_during_a_turn() {
    let mut composer = composer_with_text("keep \\ literal", /*running*/ true);

    let (result, _) = press(&mut composer, KeyCode::Enter);

    assert_eq!(
        InputResult::Queued {
            text: "keep \\ literal".to_string(),
            text_elements: Vec::new(),
            action: QueuedInputAction::Plain,
            pending_pastes: Vec::new(),
        },
        result
    );
}

// Enter queues a follow-up during a turn instead of steering it.

#[test]
fn enter_queues_the_draft_during_a_turn() {
    let mut composer = composer_with_text("queued follow-up", /*running*/ true);

    let (result, _) = press(&mut composer, KeyCode::Enter);

    assert_eq!(
        InputResult::Queued {
            text: "queued follow-up".to_string(),
            text_elements: Vec::new(),
            action: QueuedInputAction::Plain,
            pending_pastes: Vec::new(),
        },
        result
    );
    assert!(composer.draft.textarea.is_empty());
}

#[test]
fn enter_sends_the_draft_while_idle() {
    let mut composer = composer_with_text("send now", /*running*/ false);

    let (result, _) = press(&mut composer, KeyCode::Enter);

    assert!(
        matches!(&result, InputResult::Submitted { text, .. } if text == "send now"),
        "an idle Enter must send, not queue, got {result:?}"
    );
}

#[test]
fn enter_inside_a_paste_burst_during_a_turn_stays_a_newline() {
    let (mut composer, _rx) = new_test_composer();
    composer.set_task_running(/*running*/ true);
    composer
        .draft
        .paste_burst
        .begin_with_retro_grabbed(String::new(), Instant::now());

    for ch in ['a', 'b'] {
        let (result, _) = press(&mut composer, KeyCode::Char(ch));
        assert_eq!(InputResult::None, result);
    }

    let (enter_result, _) = press(&mut composer, KeyCode::Enter);
    assert_eq!(InputResult::None, enter_result);

    std::thread::sleep(PasteBurst::recommended_active_flush_delay());
    assert!(composer.flush_paste_burst_if_due());
    assert_eq!("ab\n", composer.draft.textarea.text());
}

#[test]
fn slash_command_during_a_turn_is_not_queued() {
    let mut composer = composer_with_text("/diff", /*running*/ true);

    let (result, _) = press(&mut composer, KeyCode::Enter);

    assert!(
        !matches!(result, InputResult::Queued { .. }),
        "a slash command runs now rather than waiting behind the turn, got {result:?}"
    );
}

// Footer hints: the idle Elpis tip.

fn rendered(composer: &ChatComposer) -> String {
    let area = Rect::new(0, 0, 80, 6);
    let mut buf = Buffer::empty(area);
    composer.render(area, &mut buf);
    (area.top()..area.bottom())
        .map(|row| {
            (area.left()..area.right())
                .map(|column| buf[(column, row)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn elpis_tip_replaces_the_idle_footer_only_when_visible() {
    let (mut composer, _rx) = new_test_composer();
    let hidden = rendered(&composer);
    assert!(!hidden.contains("open the Context Ledger"), "{hidden}");

    composer.set_elpis_tip_visible(/*visible*/ true);
    let shown = rendered(&composer);

    assert!(
        shown.contains("tab  open the Context Ledger and choose what stays in context"),
        "{shown}"
    );
    assert!(!shown.contains("? for shortcuts"), "{shown}");
}

#[test]
fn quit_reminder_outranks_the_elpis_tip() {
    let (mut composer, _rx) = new_test_composer();
    composer.set_elpis_tip_visible(/*visible*/ true);

    composer.show_quit_shortcut_hint(key_hint::ctrl(KeyCode::Char('c')), /*has_focus*/ true);
    let screen = rendered(&composer);

    assert!(screen.contains("again to quit"), "{screen}");
    assert!(!screen.contains("open the Context Ledger"), "{screen}");
}

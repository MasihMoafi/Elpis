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

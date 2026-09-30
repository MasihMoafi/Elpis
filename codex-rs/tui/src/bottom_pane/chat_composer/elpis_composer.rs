//! Elpis: composer behaviour v0.3.0 kept inside the upstream composer.
//!
//! Copied from Elpis v0.3.0 `bottom_pane/chat_composer.rs`, tag `stage0-stop-bleeding`.
//! Upstream files reach this module through one-line seams marked `Elpis:`.
//!
//! - U20 line continuation: a plain `Enter` immediately after a backslash replaces that marker
//!   with a newline before submission or queuing is considered. The replacement uses the same
//!   [`TextArea`] edit primitive as the editor newline path. Active paste bursts keep
//!   backslashes literal.
//! - Enter queues a follow-up while a turn runs instead of steering the running turn, and the
//!   queued-messages preview says Up pulls them all back. The ChatWidget half (Up recall) lives
//!   in `chatwidget/elpis_composer.rs`.

use super::*;

/// The hint under queued follow-ups: Up pulls every one of them back, Enter sends.
pub(in crate::bottom_pane) fn queued_follow_ups_hint_line() -> Line<'static> {
    Line::from(vec![
        "    ".into(),
        key_hint::plain(KeyCode::Up).into(),
        " edit all · enter send".into(),
    ])
    .dim()
}

impl ChatComposer {
    /// Turns a trailing backslash followed by plain Enter into a newline without submitting.
    ///
    /// A lone ASCII character may still be held by [`PasteBurst`] when Enter arrives. Flush only
    /// that normal typed-character state; an active paste buffer must retain its literal
    /// backslashes and its existing multiline handling.
    pub(super) fn try_insert_backslash_newline(&mut self, key_event: KeyEvent) -> bool {
        if !matches!(
            key_event,
            KeyEvent {
                code: KeyCode::Enter,
                modifiers: KeyModifiers::NONE,
                kind: KeyEventKind::Press | KeyEventKind::Repeat,
                ..
            }
        ) {
            return false;
        }

        match self.draft.paste_burst.pending_typed_char() {
            Some('\\') => {
                if let Some(typed) = self.draft.paste_burst.flush_before_modified_input() {
                    self.insert_str(&typed);
                }
            }
            Some(_) => return false,
            None if self.draft.paste_burst.is_active() => return false,
            None => {}
        }

        let cursor = self.draft.textarea.cursor();
        let text = self.draft.textarea.text();
        if cursor == 0 || !text[..cursor].ends_with('\\') {
            return false;
        }

        self.draft
            .textarea
            .replace_range(cursor - '\\'.len_utf8()..cursor, "\n");
        true
    }

    /// Enter queues the draft as a follow-up while a turn runs, as v0.3.0 did, instead of
    /// steering the running turn.
    ///
    /// A slash command still runs now, and Enter inside a paste burst stays a newline exactly as
    /// it does on the ordinary send path. Returns `None` when Enter should take that path.
    pub(super) fn queue_submission_during_turn(&mut self) -> Option<(InputResult, bool)> {
        if !self.is_task_running
            || self
                .slash_input()
                .should_parse_on_dequeue(self.draft.textarea.text())
        {
            return None;
        }
        if self.handle_paste_enter(tokio::time::Instant::now().into_std()) {
            return Some((InputResult::None, true));
        }
        Some(self.handle_submission(/*should_queue*/ true))
    }
}

#[cfg(test)]
#[path = "elpis_composer_tests.rs"]
mod tests;

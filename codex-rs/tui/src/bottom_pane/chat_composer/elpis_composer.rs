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
//! - Footer hints: an idle, empty composer shows one Elpis tip in place of the ambient footer;
//!   the context indicator is followed by "Tab Context Ledger"; the queue hint names Enter. The
//!   ChatWidget decides when the tip is visible (`chatwidget/elpis_composer.rs`).

use super::*;
use crate::bottom_pane::BottomPane;

/// The keymap action whose key the footer names as the queue key: Enter queues during a turn.
pub(super) const QUEUE_HINT_ACTION: &str = "submit";

/// Things Elpis has that its upstream does not.
///
/// Inherited hints were both misleading and useless here: one told the reader that shift+tab
/// opens Plan mode when in Elpis it cycles permissions. Nothing generic belongs in this slot;
/// a tip earns its line only by pointing at something Elpis added.
///
/// v0.3.0 also listed `/auto`, `/model` (any provider), `/dev`, `/goal` (carried across
/// sessions) and `ES.md` (written after every turn). This build has none of those, so their
/// tips would be false and are left out until the features return.
const ELPIS_TIPS: &[(&str, &str)] = &[
    (
        "tab",
        "open the Context Ledger and choose what stays in context",
    ),
    (
        "memory",
        "activate saved memories by selecting MEMORY.md in the Context Ledger",
    ),
];

/// Rotates the tip between composers so a long-running install eventually sees all of them.
fn next_elpis_tip_index() -> usize {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Builds the one-line tip that replaces the ambient footer without adding layout height.
fn elpis_tip_line(index: usize) -> Line<'static> {
    let (name, description) = ELPIS_TIPS[index % ELPIS_TIPS.len()];
    Line::from(vec![name.into(), "  ".into(), description.into()])
}

/// Whether the idle tip replaces the footer, and which tip this composer shows.
pub(super) struct ElpisFooterTip {
    visible: bool,
    index: usize,
}

impl ElpisFooterTip {
    pub(super) fn new() -> Self {
        Self {
            visible: false,
            index: if cfg!(test) {
                0
            } else {
                next_elpis_tip_index()
            },
        }
    }
}

/// Follows the context indicator with v0.3.0's reminder that Tab opens the Context Ledger,
/// styled like the indicator it follows.
pub(super) fn push_context_ledger_hint(line: &mut Line<'static>) {
    let hint = if line.spans.is_empty() {
        "Tab Context Ledger"
    } else {
        " · Tab Context Ledger"
    };
    line.spans
        .push(Span::styled(hint, crate::style::secondary_text_style()));
}

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
    /// Slash-led drafts queue too and are validated when they run, as in v0.3.0; Enter inside a
    /// paste burst stays a newline exactly as it does on the ordinary send path. Returns `None`
    /// when Enter should take that path.
    pub(super) fn queue_submission_during_turn(&mut self) -> Option<(InputResult, bool)> {
        // MCP startup also marks the composer busy; only an agent turn queues.
        if !self.is_task_running || !self.elpis_turn_running {
            return None;
        }
        if self.handle_paste_enter(tokio::time::Instant::now().into_std()) {
            return Some((InputResult::None, true));
        }
        Some(self.handle_submission(/*should_queue*/ true))
    }

    /// Updates whether the idle Elpis tip replaces the ambient footer row.
    ///
    /// Returns `true` only when the rendered footer can change so callers can avoid scheduling
    /// redundant redraws.
    fn set_elpis_tip_visible(&mut self, visible: bool) -> bool {
        if self.elpis_tip.visible == visible {
            return false;
        }
        self.elpis_tip.visible = visible;
        true
    }

    #[cfg(test)]
    fn elpis_tip_visible(&self) -> bool {
        self.elpis_tip.visible
    }

    /// The tip to paint in the footer row, when it is visible and nothing outranks it: a flash,
    /// or a footer mode with something to say (quit reminder, Esc hint, search, shortcut help).
    pub(super) fn elpis_tip_footer_line(&self, hint_rect: Rect) -> Option<Line<'static>> {
        if !self.elpis_tip.visible
            || self.footer.flash_visible()
            || !matches!(self.footer_mode(), FooterMode::ComposerEmpty)
        {
            return None;
        }
        let available_width = hint_rect.width.saturating_sub(FOOTER_INDENT_COLS as u16) as usize;
        Some(truncate_line_with_ellipsis_if_overflow(
            elpis_tip_line(self.elpis_tip.index),
            available_width,
        ))
    }
}

impl BottomPane {
    /// Tells the composer whether an agent turn is running, so Enter queues only then.
    pub(crate) fn set_elpis_turn_running(&mut self, running: bool) {
        self.composer.elpis_turn_running = running;
    }

    /// Applies the ChatWidget's decision on whether the idle Elpis tip is showing.
    pub(crate) fn set_elpis_tip_visible(&mut self, visible: bool) {
        if self.composer.set_elpis_tip_visible(visible) {
            self.request_redraw();
        }
    }

    #[cfg(test)]
    pub(crate) fn elpis_tip_visible(&self) -> bool {
        self.composer.elpis_tip_visible()
    }
}

#[cfg(test)]
#[path = "elpis_composer_tests.rs"]
mod tests;

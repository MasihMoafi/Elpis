//! Browsing lifecycle: retain the origin, load earlier prompts, and cancel without rewinding.

use super::*;
use crate::transcript_view::TranscriptBookmark;

pub(super) enum BrowsingOrigin {
    Owned(TranscriptBookmark),
    Overlay(TranscriptBookmark),
    Inline,
}

impl App {
    /// A page can start inside an answer, leaving its oldest prompt far from the viewport edge.
    pub(crate) fn browsing_needs_history(&self) -> bool {
        self.backtrack.overlay_preview_active
            && matches!(self.backtrack.nth_user_message, 0 | usize::MAX)
            && match &self.overlay {
                Some(Overlay::Transcript(overlay)) => !overlay.has_active_interaction(),
                _ => !self.transcript_view.has_active_interaction(),
            }
    }

    /// Elpis: on the full screen, browsing hides the composer, so a typed character must not be
    /// lost to browsing keys (`h`, `j`, `k`, `l`, `g`). It leaves browsing and reaches the
    /// composer; arrows, Page Up/Down, Enter and Esc keep their browsing meaning. The second
    /// stroke of a pending chord (`ctrl+x h`) stays with the chord.
    pub(crate) fn typed_key_leaves_browsing(&self, tui: &tui::Tui, key: KeyEvent) -> bool {
        tui.is_owned_screen()
            && !self.key_chord_matcher.is_pending()
            && self.overlay.is_none()
            && self.backtrack.overlay_preview_active
            && !self.transcript_view.has_active_interaction()
            && self.chat_widget.no_modal_or_popup_active()
            && matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
            && crate::key_hint::is_plain_text_key_event(key)
    }

    pub(crate) fn cancel_primed_browsing_for_event(&mut self, event: &TuiEvent) {
        let interrupts_escape_pair = match event {
            TuiEvent::Key(key) => key.code != KeyCode::Esc && key.kind != KeyEventKind::Release,
            TuiEvent::Mouse(mouse) => mouse.kind != crossterm::event::MouseEventKind::Moved,
            TuiEvent::Paste(text) => !text.is_empty(),
            TuiEvent::Draw
            | TuiEvent::Resume
            | TuiEvent::Resize(_)
            | TuiEvent::FocusGained
            | TuiEvent::FocusLost => false,
        };
        if self.backtrack.primed
            && !self.backtrack.overlay_preview_active
            && self.backtrack.nth_user_message == usize::MAX
            && interrupts_escape_pair
        {
            self.reset_backtrack_state();
        }
    }

    pub(super) fn remember_browsing_origin(&mut self, tui: &tui::Tui) {
        if self.backtrack.origin.is_some() {
            return;
        }
        self.backtrack.origin = Some(match &mut self.overlay {
            Some(Overlay::Transcript(overlay)) => BrowsingOrigin::Overlay(overlay.bookmark()),
            _ if tui.is_owned_screen() => {
                BrowsingOrigin::Owned(self.transcript_view.bookmark(&self.transcript_cells))
            }
            _ => BrowsingOrigin::Inline,
        });
    }

    pub(crate) fn cancel_transcript_browsing(&mut self, tui: &mut tui::Tui) {
        let origin = self.backtrack.origin.take();
        self.reset_backtrack_state();
        match origin {
            Some(BrowsingOrigin::Owned(bookmark)) => {
                self.transcript_view.restore_bookmark(bookmark);
            }
            Some(BrowsingOrigin::Overlay(bookmark)) => {
                if let Some(Overlay::Transcript(overlay)) = &mut self.overlay {
                    overlay.restore_bookmark(bookmark);
                }
            }
            Some(BrowsingOrigin::Inline) => self.close_transcript_overlay(tui),
            None => {}
        }
        tui.frame_requester().schedule_frame();
    }

    pub(super) fn set_browsing_details(&mut self, detailed: bool) {
        let mode = self.chat_widget.history_render_mode();
        if let Some(Overlay::Transcript(overlay)) = &mut self.overlay {
            overlay.set_presentation(detailed, mode);
        } else {
            self.transcript_view.set_presentation(detailed, mode);
            if let Some(index) =
                nth_user_position(&self.transcript_cells, self.backtrack.nth_user_message)
            {
                self.transcript_view
                    .jump_to_entry(&self.transcript_cells, index);
            }
        }
        self.apply_backtrack_selection_internal(self.backtrack.nth_user_message);
    }

    pub(super) fn browsing_details(&self) -> bool {
        match &self.overlay {
            Some(Overlay::Transcript(overlay)) => overlay.is_detailed(),
            _ => self.transcript_view.is_detailed(),
        }
    }
}

//! Elpis: the ChatWidget half of the v0.3.0 composer behaviour.
//!
//! Copied from Elpis v0.3.0 `chatwidget/interaction.rs` (`handle_key_event`, Up recall), tag
//! `stage0-stop-bleeding`. The composer half lives in `bottom_pane/chat_composer/elpis_composer.rs`.
//! Upstream files reach this module through one-line seams marked `Elpis:`.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;

use super::ChatWidget;
use crate::key_hint;

impl ChatWidget {
    /// Up pulls every queued follow-up, plus the current draft, back into the composer together,
    /// leaving nothing queued. With nothing queued, Up keeps its ordinary history meaning.
    ///
    /// Steers already handed to the running turn stay with it: the turn has them, so recalling
    /// them here would send them twice.
    pub(super) fn recall_queued_follow_ups_on_up(&mut self, key_event: KeyEvent) -> bool {
        if key_event.kind != KeyEventKind::Press
            || !key_hint::plain(KeyCode::Up).is_press(key_event)
            || !self.has_queued_follow_up_messages()
            || !self.bottom_pane.no_modal_or_popup_active()
        {
            return false;
        }
        let in_flight_steers = std::mem::take(&mut self.input_queue.pending_steers);
        let restored = self.drain_pending_messages_for_restore();
        self.input_queue.pending_steers = in_flight_steers;
        self.input_queue.recovered_queue &= !self.input_queue.pending_steers.is_empty();
        if let Some(composer) = restored {
            self.restore_composer_state(composer);
            self.refresh_startup_recovery();
            self.refresh_pending_input_preview();
            self.request_redraw();
        }
        true
    }
}

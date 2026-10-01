//! Elpis: the ChatWidget half of the v0.3.0 composer behaviour.
//!
//! Copied from Elpis v0.3.0 `chatwidget/interaction.rs` (`handle_key_event`, Up recall) and
//! `chatwidget/settings.rs` (the footer tip policy), tag `stage0-stop-bleeding`. The composer half
//! lives in `bottom_pane/chat_composer/elpis_composer.rs`. Upstream files reach this module
//! through one-line seams marked `Elpis:`.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;

use super::ChatWidget;
use super::user_messages::ShellEscapePolicy;
use crate::app_command::AppCommand;
use crate::bottom_pane::QueuedInputAction;
use crate::key_hint;
use crate::key_hint::KeyBindingListExt;

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

    /// Delivers queued follow-ups during a running turn, so a turn that never ends cannot hold
    /// them back (v0.3.0 `interaction.rs`):
    ///
    /// - Enter on an empty composer interrupts the turn; the interrupt then sends the queue.
    /// - Esc hands the next plain queued message to the running turn as a steer, without
    ///   cancelling it. A queued slash or shell command, a review turn or a shell-only turn falls
    ///   through to the ordinary interrupt.
    pub(super) fn send_queued_follow_ups_on_key(&mut self, key_event: KeyEvent) -> bool {
        if !self.has_queued_follow_up_messages()
            || !self.bottom_pane.is_task_running()
            || !self.bottom_pane.no_modal_or_popup_active()
            || self.input_queue.suppress_queue_autosend
        {
            return false;
        }
        if key_hint::plain(KeyCode::Enter).is_press(key_event)
            && self.bottom_pane.composer_is_empty()
        {
            if !self.input_queue.submit_pending_steers_after_interrupt {
                self.input_queue.submit_pending_steers_after_interrupt = true;
                if self.submit_op(AppCommand::interrupt()) {
                    self.pause_active_goal_for_interrupt();
                } else {
                    self.input_queue.submit_pending_steers_after_interrupt = false;
                }
            }
            return true;
        }
        if self.chat_keymap.interrupt_turn.is_pressed(key_event)
            && self.input_queue.pending_steers.is_empty()
            && self.input_queue.rejected_steers_queue.is_empty()
            && self.next_queued_input_is_plain()
            && self.turn_lifecycle.agent_turn_running
            && !self.review.is_review_mode
            && !self.only_user_shell_commands_running()
            && !self.should_handle_vim_insert_escape(key_event)
        {
            self.steer_next_queued_input();
            return true;
        }
        false
    }

    fn next_queued_input_is_plain(&self) -> bool {
        self.input_queue
            .queued_user_messages
            .front()
            .is_some_and(|queued| queued.action == QueuedInputAction::Plain)
    }

    /// Hands exactly one queued message to the running turn, which receives it at the next
    /// tool/result boundary.
    fn steer_next_queued_input(&mut self) {
        if let Some((queued_message, history_record)) = self.pop_next_queued_user_message() {
            let source = queued_message.source;
            self.submit_user_message_with_history_and_shell_escape_policy(
                queued_message.into_user_message(),
                history_record,
                ShellEscapePolicy::Allow,
                source,
            );
        }
        self.refresh_pending_input_preview();
    }

    /// During an agent turn, a typed command that must wait (`/compact`, `/review`) is queued to run
    /// after the turn instead of being rejected, matching how Enter queues plain follow-ups.
    /// Returns `true` when the command was queued.
    pub(super) fn queue_command_blocked_by_turn(
        &mut self,
        cmd: crate::slash_command::SlashCommand,
        args: Option<&str>,
        typed_live: bool,
    ) -> bool {
        if !typed_live || !self.turn_lifecycle.agent_turn_running || cmd.available_during_task() {
            return false;
        }
        let text = match args.map(str::trim).filter(|args| !args.is_empty()) {
            Some(args) => format!("/{} {args}", cmd.command()),
            None => format!("/{}", cmd.command()),
        };
        self.queue_user_message_with_options(
            super::user_messages::UserMessage::from(text),
            QueuedInputAction::ParseSlash,
            Vec::new(),
        );
        self.request_redraw();
        true
    }

    /// Returns whether the footer should show an Elpis tip instead of ambient status.
    ///
    /// Only an empty, idle composer qualifies: once the reader is typing, or a turn is running,
    /// or anything is asking for input, the footer has something more useful to say.
    fn should_show_elpis_tip(&self) -> bool {
        self.bottom_pane.composer_text().trim().is_empty()
            && self.bottom_pane.composer_input_enabled()
            && !self.bottom_pane.is_task_running()
            && self.bottom_pane.no_modal_or_popup_active()
    }

    /// Synchronizes the footer presentation with the current tip policy.
    pub(super) fn refresh_elpis_tip(&mut self) {
        self.bottom_pane
            .set_elpis_tip_visible(self.should_show_elpis_tip());
    }
}

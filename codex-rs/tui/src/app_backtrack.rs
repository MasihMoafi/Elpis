//! Backtracking and detailed transcript event routing.
//!
//! This file owns backtrack mode (Esc/Enter navigation in the transcript overlay) and also
//! mediates a key rendering boundary for the transcript overlay.
//!
//! Overall goal: keep the main chat view and the transcript overlay in sync while allowing users
//! to edit an earlier prompt in place. Confirming a selection reverts before
//! the selected turn and restores its prompt in the composer.
//!
//! Backtrack operates as a small state machine:
//! - The first `Esc` in the main view "primes" the feature and captures a base thread id.
//! - A subsequent `Esc` starts compact transcript browsing and highlights the latest user prompt.
//! - Left/Right choose prompts, Ctrl+T toggles details, and Esc restores the browsing origin.
//! - `Enter` requests a revert before the selected prompt and reopens it for editing.
//!
//! Owned sessions use the shared transcript viewport for `Ctrl+T`; inline sessions retain the
//! overlay. Both render committed cells and a live tail from the current `ChatWidget.active_cell`.
//!
//! That live tail is kept in sync during `TuiEvent::Draw` handling for `Overlay::Transcript` by
//! asking `ChatWidget` for an active-cell cache key and transcript lines and by passing them into
//! `TranscriptOverlay::sync_live_tail`. This preserves the invariant that the overlay reflects
//! both committed history and in-flight activity without changing flush or coalescing behavior.

mod browsing;
mod legacy_input;
mod prompt_navigation;

use std::any::TypeId;
use std::sync::Arc;

use crate::app::App;
use crate::app_event::AppEvent;
use crate::app_server_session::AppServerSession;
use crate::bottom_pane::LocalImageAttachment;
use crate::chatwidget::ChatWidget;
use crate::chatwidget::UserMessage;
use crate::chatwidget::mention_bindings_from_user_inputs;
use crate::chatwidget::merge_user_messages;
#[cfg(test)]
use crate::history_cell::AgentMessageCell;
use crate::history_cell::HistoryCell;
use crate::history_cell::SessionInfoCell;
use crate::history_cell::UserHistoryCell;
use crate::history_cell::sanitize_user_text;
use crate::pager_overlay::Overlay;
use crate::pager_overlay::TranscriptHistoryState;
use crate::tui;
use crate::tui::TuiEvent;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::Turn;
use codex_app_server_protocol::TurnStatus;
use codex_protocol::ThreadId;
use codex_protocol::models::local_image_label_text;
use color_eyre::eyre::Result;
use color_eyre::eyre::bail;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use sha2::Digest;
use sha2::Sha256;

const NO_PREVIOUS_MESSAGE_TO_EDIT: &str = "No previous message to edit.";
pub(crate) const SIDE_EDIT_PREVIOUS_UNAVAILABLE_MESSAGE: &str =
    "Editing previous prompts is unavailable in side conversations.";

/// Aggregates all backtrack-related state used by the App.
#[derive(Default)]
pub(crate) struct BacktrackState {
    /// True when Esc has primed backtrack mode in the main view.
    pub(crate) primed: bool,
    /// Session id of the base thread whose transcript is being inspected.
    ///
    /// If the current thread changes, backtrack selections become invalid and must be ignored.
    pub(crate) base_id: Option<ThreadId>,
    /// Index of the currently highlighted user message.
    ///
    /// This is an index into the filtered "user messages since the last session start" view,
    /// not an index into `transcript_cells`. `usize::MAX` indicates "no selection".
    pub(crate) nth_user_message: usize,
    /// True when the transcript overlay is showing a backtrack preview.
    pub(crate) overlay_preview_active: bool,
    origin: Option<browsing::BrowsingOrigin>,
}

/// A user-visible backtrack choice that can be reopened in the current thread.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BacktrackSelection {
    pub(crate) thread_id: ThreadId,
    /// The selected user message, counted from the most recent session start.
    pub(crate) nth_user_message: usize,
    pub(crate) prompt: UserMessage,
}

impl App {
    /// Route overlay events, reserving backtracking for the transcript overlay.
    ///
    /// If browsing is active, Left/Right steps selection, Esc cancels, and Enter
    /// confirms. Otherwise, Esc begins preview mode and all other events are forwarded to the
    /// overlay.
    pub(crate) async fn handle_backtrack_overlay_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: TuiEvent,
    ) -> Result<bool> {
        if !matches!(self.overlay, Some(Overlay::Transcript(_))) {
            self.overlay_forward_event(tui, event)?;
            return Ok(true);
        }
        self.handle_legacy_transcript_event(tui, app_server, event)
    }

    /// Handle global Esc presses for backtracking when no overlay is present.
    pub(crate) fn handle_backtrack_esc_key(&mut self, tui: &mut tui::Tui) {
        if !self.chat_widget.composer_is_empty() {
            return;
        }

        if !self.backtrack.primed {
            self.remember_browsing_origin(tui);
            self.prime_backtrack();
        } else if self.overlay.is_none() {
            self.open_backtrack_preview(tui);
        }
    }

    /// Revert the current thread before the selected prompt.
    pub(crate) fn apply_backtrack_selection(&mut self, selection: BacktrackSelection) {
        if self.chat_widget.side_conversation_active() {
            self.reset_backtrack_state();
            self.chat_widget
                .add_error_message(SIDE_EDIT_PREVIOUS_UNAVAILABLE_MESSAGE.to_string());
            return;
        }

        if self.chat_widget.thread_id() != Some(selection.thread_id) {
            return;
        }

        let Some(index) = nth_user_position(&self.transcript_cells, selection.nth_user_message)
        else {
            return;
        };
        self.app_event_tx
            .send(AppEvent::RevertSessionForPromptEdit {
                thread_id: selection.thread_id,
                selected_cell: Arc::clone(&self.transcript_cells[index]),
                prompt: selection.prompt,
            });
    }

    pub(crate) fn restore_backtrack_prompt_after_revert_error(
        &mut self,
        prompt: UserMessage,
        err: impl std::fmt::Display,
    ) {
        self.chat_widget.restore_user_message_to_composer(prompt);
        self.chat_widget
            .add_error_message(format!("Failed to edit the selected prompt: {err:#}"));
    }

    /// Show detailed history in the owned viewport or the inline session's transcript overlay.
    pub(crate) fn open_transcript_overlay(&mut self, tui: &mut tui::Tui) {
        if tui.is_owned_screen() {
            self.transcript_view.set_presentation(
                /*detailed*/ true,
                self.chat_widget.history_render_mode(),
            );
            tui.frame_requester().schedule_frame();
            return;
        }
        let _ = tui.enter_alt_screen();
        self.overlay = Some(Overlay::new_transcript(
            self.transcript_cells.clone(),
            self.keymap.pager.clone(),
            self.local_settings
                .copy_on_select(&codex_terminal_detection::terminal_info()),
            self.local_settings
                .tui
                .mouse_scroll_speed
                .unwrap_or(crate::transcript_view::DEFAULT_MOUSE_SCROLL_SPEED),
        ));
        if self.scrollback_has_older_history
            && let Some(Overlay::Transcript(overlay)) = self.overlay.as_mut()
        {
            overlay.set_history_state(TranscriptHistoryState::Partial);
        }
        tui.frame_requester().schedule_frame();
    }

    /// Close the current overlay and restore normal UI, retaining Analytics navigation state.
    pub(crate) fn close_transcript_overlay(&mut self, tui: &mut tui::Tui) {
        if tui.is_owned_screen() && self.overlay.is_none() {
            self.transcript_view.set_presentation(
                /*detailed*/ false,
                self.chat_widget.history_render_mode(),
            );
            self.backtrack.overlay_preview_active = false;
            self.reset_backtrack_state();
            tui.frame_requester().schedule_frame();
            return;
        }
        let _ = tui.leave_alt_screen();
        let was_backtrack = self.backtrack.overlay_preview_active;
        if !self.deferred_history_lines.is_empty() {
            let lines = std::mem::take(&mut self.deferred_history_lines);
            tui.insert_history_hyperlink_lines_with_wrap_policy(
                lines,
                self.history_line_wrap_policy(),
            );
        }
        if let Some(Overlay::Analytics(mut view)) = self.overlay.take() {
            view.cancel_loads();
            self.retained_analytics = Some(view);
        }
        if self.pending_thread_usage_history_refresh
            && let Err(err) = self.refresh_thread_usage_history_tail(tui)
        {
            tracing::warn!(error = %err, "failed to refresh thread usage after closing overlay");
        }
        self.backtrack.overlay_preview_active = false;
        tui.frame_requester().schedule_frame();
        if was_backtrack {
            // Ensure backtrack state is fully reset when overlay closes (e.g. via 'q').
            self.reset_backtrack_state();
        }
    }

    /// Initialize backtrack state and show composer hint.
    fn prime_backtrack(&mut self) {
        self.backtrack.primed = true;
        self.backtrack.nth_user_message = usize::MAX;
        self.backtrack.base_id = self.chat_widget.thread_id();
        if has_backtrack_target(&self.transcript_cells) {
            self.chat_widget.show_esc_backtrack_hint();
        }
    }

    /// Open overlay and begin backtrack preview flow (first step + highlight).
    fn open_backtrack_preview(&mut self, tui: &mut tui::Tui) {
        if !has_backtrack_target(&self.transcript_cells) && !self.scrollback_has_older_history {
            self.reset_backtrack_state();
            self.chat_widget
                .add_info_message(NO_PREVIOUS_MESSAGE_TO_EDIT.to_string(), /*hint*/ None);
            tui.frame_requester().schedule_frame();
            return;
        }

        self.open_transcript_overlay(tui);
        self.backtrack.overlay_preview_active = true;
        self.set_browsing_details(/*detailed*/ false);
        // The selected prompt now supplies the backtrack context instead of the composer hint.
        self.chat_widget.clear_esc_backtrack_hint();
        self.step_backtrack_and_highlight(tui);
    }

    /// When overlay is already open, begin preview mode and select latest user message.
    fn begin_overlay_backtrack_preview(&mut self, tui: &mut tui::Tui) {
        if !has_backtrack_target(&self.transcript_cells) && !self.scrollback_has_older_history {
            self.close_transcript_overlay(tui);
            self.chat_widget
                .add_info_message(NO_PREVIOUS_MESSAGE_TO_EDIT.to_string(), /*hint*/ None);
            tui.frame_requester().schedule_frame();
            return;
        }

        self.remember_browsing_origin(tui);
        self.backtrack.nth_user_message = usize::MAX;
        self.backtrack.primed = true;
        self.backtrack.base_id = self.chat_widget.thread_id();
        self.backtrack.overlay_preview_active = true;
        self.set_browsing_details(/*detailed*/ false);
        let count = user_count(&self.transcript_cells);
        if let Some(last) = count.checked_sub(1) {
            self.apply_backtrack_selection_internal(last);
        }
        tui.frame_requester().schedule_frame();
    }

    /// Step selection to the next older user message and update overlay.
    fn step_backtrack_and_highlight(&mut self, tui: &mut tui::Tui) {
        let count = user_count(&self.transcript_cells);
        if count == 0 {
            return;
        }

        let last_index = count.saturating_sub(1);
        let next_selection = if self.backtrack.nth_user_message == usize::MAX {
            last_index
        } else if self.backtrack.nth_user_message == 0 {
            0
        } else {
            self.backtrack
                .nth_user_message
                .saturating_sub(1)
                .min(last_index)
        };

        self.apply_backtrack_selection_internal(next_selection);
        tui.frame_requester().schedule_frame();
    }

    /// Step selection to the next newer user message and update overlay.
    fn step_forward_backtrack_and_highlight(&mut self, tui: &mut tui::Tui) {
        let count = user_count(&self.transcript_cells);
        if count == 0 {
            return;
        }

        let last_index = count.saturating_sub(1);
        let next_selection = if self.backtrack.nth_user_message == usize::MAX {
            last_index
        } else {
            self.backtrack
                .nth_user_message
                .saturating_add(1)
                .min(last_index)
        };

        self.apply_backtrack_selection_internal(next_selection);
        tui.frame_requester().schedule_frame();
    }

    /// Apply a computed backtrack selection to the overlay and internal counter.
    pub(crate) fn apply_backtrack_selection_internal(&mut self, nth_user_message: usize) {
        if let Some(cell_idx) = nth_user_position(&self.transcript_cells, nth_user_message) {
            self.backtrack.nth_user_message = nth_user_message;
            if let Some(Overlay::Transcript(t)) = &mut self.overlay {
                t.set_highlight_cell(Some(cell_idx));
            }
            if self.overlay.is_none() {
                self.transcript_view.set_highlight(Some(cell_idx));
                self.transcript_view
                    .ensure_entry_visible(&self.transcript_cells, cell_idx);
            }
        } else {
            self.backtrack.nth_user_message = usize::MAX;
            if let Some(Overlay::Transcript(t)) = &mut self.overlay {
                t.set_highlight_cell(/*cell*/ None);
            }
            self.transcript_view.set_highlight(/*index*/ None);
        }
    }

    /// Forwards an event to the overlay and closes it if done.
    ///
    /// The transcript overlay draw path is special because the overlay should match the main
    /// viewport while the active cell is still streaming or mutating.
    ///
    /// `TranscriptOverlay` owns committed transcript cells, while `ChatWidget` owns the current
    /// in-flight active cell (often a coalesced exec/tool group). During draws we append that
    /// in-flight cell as a cached, render-only live tail so `Ctrl+T` does not appear to "lose" tool
    /// calls until a later flush boundary.
    ///
    /// This logic lives here (instead of inside the overlay widget) because `ChatWidget` is the
    /// source of truth for the active cell and its cache invalidation key, and because `App` owns
    /// overlay lifecycle and frame scheduling for animations.
    fn overlay_forward_event(&mut self, tui: &mut tui::Tui, event: TuiEvent) -> Result<()> {
        let width = tui.terminal.last_known_screen_size.width.max(/*other*/ 1);
        let footer = self.prompt_navigation_footer(width.saturating_sub(/*rhs*/ 2));
        if let Some(Overlay::Transcript(overlay)) = &mut self.overlay {
            overlay.browsing_footer =
                footer.and_then(|footer| footer.text.lines.into_iter().next());
        }
        let input = matches!(&event, TuiEvent::Key(key) if key.kind != KeyEventKind::Release)
            || matches!(&event, TuiEvent::Mouse(mouse) if mouse.kind != crossterm::event::MouseEventKind::Moved);
        if (input
            || matches!(
                &event,
                TuiEvent::Draw | TuiEvent::Resume | TuiEvent::Resize(_) | TuiEvent::FocusGained
            ))
            && let Some(Overlay::Transcript(t)) = &mut self.overlay
        {
            tui.set_overlay_input(tui::OverlayInput::Transcript)?;
            t.motion = crate::motion::MotionMode::from_animations_enabled(
                self.local_settings.tui.animations && self.local_settings.tui.effects.shimmer,
            );
            let active_key = self.chat_widget.active_cell_transcript_key();
            let chat_widget = &self.chat_widget;
            let detailed = t.is_detailed();
            let size = tui.prepare_draw_size()?;
            t.sync_search_live_tail(size.width.max(/*other*/ 1), active_key, |width| {
                chat_widget.active_cell_transcript_hyperlink_lines(width)
            });
            t.sync_live_tail(size.width.max(/*other*/ 1), active_key, |width| {
                if detailed {
                    chat_widget.active_cell_transcript_hyperlink_lines(width)
                } else {
                    chat_widget
                        .active_cell_owned_transcript_lines(width, /*expanded*/ false)
                        .map(|mut lines| {
                            lines.activity.extend(lines.auxiliary);
                            lines.activity
                        })
                }
            });
            // Refresh visible rows before selection captures this live revision.
            let result =
                if input { t.draw(tui) } else { Ok(()) }.and_then(|()| t.handle_event(tui, event));
            if result.is_err() {
                let _ = tui.set_overlay_input(tui::OverlayInput::Default);
            }
            result?;
            let close_overlay = t.is_done();
            if !close_overlay
                && active_key.is_some_and(|key| key.animation_tick.is_some())
                && t.is_scrolled_to_bottom()
            {
                tui.frame_requester()
                    .schedule_frame_in(std::time::Duration::from_millis(50));
            }
            if close_overlay {
                self.close_transcript_overlay(tui);
                tui.frame_requester().schedule_frame();
            }
            return Ok(());
        }

        if let Some(overlay) = &mut self.overlay {
            overlay.handle_event(tui, event)?;
            if overlay.is_done() {
                self.close_transcript_overlay(tui);
                tui.frame_requester().schedule_frame();
            }
        }
        Ok(())
    }

    /// Handle Enter in overlay backtrack preview: confirm selection and reset state.
    fn overlay_confirm_backtrack(&mut self, tui: &mut tui::Tui) {
        let nth_user_message = self.backtrack.nth_user_message;
        let Some(selection) = self.backtrack_selection(nth_user_message) else {
            return;
        };
        self.close_transcript_overlay(tui);
        self.apply_backtrack_selection(selection);
        tui.frame_requester().schedule_frame();
    }

    /// Confirm a primed backtrack from the main view (no overlay visible).
    /// Computes the prompt state from the selected user message.
    pub(crate) fn confirm_backtrack_from_main(&mut self) -> Option<BacktrackSelection> {
        let selection = self.backtrack_selection(self.backtrack.nth_user_message);
        self.reset_backtrack_state();
        selection
    }

    /// Clear all backtrack-related state and composer hints.
    pub(crate) fn reset_backtrack_state(&mut self) {
        self.backtrack.origin = None;
        self.backtrack.primed = false;
        self.backtrack.overlay_preview_active = false;
        self.backtrack.base_id = None;
        self.backtrack.nth_user_message = usize::MAX;
        self.transcript_view.set_highlight(/*index*/ None);
        // In case a hint is somehow still visible (e.g., race with overlay open/close).
        self.chat_widget.clear_esc_backtrack_hint();
    }

    fn backtrack_selection(&self, nth_user_message: usize) -> Option<BacktrackSelection> {
        let base_id = self.backtrack.base_id?;
        if self.chat_widget.thread_id() != Some(base_id) {
            return None;
        }

        let selected = nth_user_position(&self.transcript_cells, nth_user_message)
            .and_then(|idx| self.transcript_cells.get(idx))
            .and_then(|cell| cell.as_any().downcast_ref::<UserHistoryCell>())?;
        let local_images = selected
            .local_image_paths
            .iter()
            .enumerate()
            .map(|(index, path)| LocalImageAttachment {
                placeholder: local_image_label_text(index + 1),
                path: path.clone(),
            })
            .collect();

        Some(BacktrackSelection {
            thread_id: base_id,
            nth_user_message,
            prompt: UserMessage {
                text: selected.message.clone(),
                local_images,
                remote_image_urls: selected.remote_image_urls.clone(),
                text_elements: selected.text_elements.clone(),
                mention_bindings: Vec::new(),
            },
        })
    }
}

/// Find the persisted turn that contains a selected transcript prompt.
///
/// Replay hides review prompts and other display-empty inputs, so the selected ordinal must be
/// resolved against the same visible projection before restoring its canonical mention bindings.
/// `start_item` anchors a partially loaded transcript within authoritative history; earlier
/// user inputs still establish whether the selected input was a mid-turn steer.
///
/// A turn can contain multiple user messages when it was steered. Only its initial prompt can be
/// reopened independently because app-server cannot revert in the middle of a turn.
pub(crate) fn backtrack_revert_before_turn_id(
    turns: &[Turn],
    start_item: Option<&(String, String)>,
    nth_user_message: usize,
    prompt: &mut UserMessage,
) -> Result<String> {
    backtrack_prompt_edit_candidate(turns, start_item, nth_user_message, prompt, false)
        .map(|selection| selection.turn_id)
}

fn backtrack_turn_fingerprint(turn: &Turn) -> Result<[u8; 32]> {
    struct Sink(Sha256);
    impl std::io::Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut sink = Sink(Sha256::new());
    serde_json::to_writer(&mut sink, turn)?;
    Ok(sink.0.finalize().into())
}

#[derive(Debug)]
pub(crate) struct BacktrackPromptEdit {
    pub(crate) turn_id: String,
    pub(crate) nth_user_message: usize,
    pub(crate) whole_turn: bool,
    pub(crate) message_count: usize,
    pub(crate) turn_fingerprint: [u8; 32],
    pub(crate) remote_edit_unsupported: bool,
    pub(crate) clipped_turn_prefix: bool,
}

pub(crate) fn backtrack_prompt_edit_candidate(
    turns: &[Turn],
    start_item: Option<&(String, String)>,
    nth_user_message: usize,
    prompt: &mut UserMessage,
    allow_whole_turn: bool,
) -> Result<BacktrackPromptEdit> {
    let (start_turn, start_item) = match start_item {
        Some((turn_id, item_id)) => turns
            .iter()
            .position(|turn| turn.id == *turn_id)
            .and_then(|index| {
                turns[index]
                    .items
                    .iter()
                    .position(|item| item.id() == item_id)
                    .map(|item| (index, item))
            })
            .ok_or_else(|| {
                color_eyre::eyre::eyre!("the loaded history boundary no longer exists")
            })?,
        None => (0, 0),
    };
    let mut visible_user_messages_seen = 0_usize;
    let mut review_mode = false;
    for (turn_index, turn) in turns.iter().enumerate().skip(start_turn) {
        let turn_visible_start = visible_user_messages_seen;
        let turn_review_start = review_mode;
        let hidden_nested_review_turn = turn_index > start_turn
            && turns.get(turn_index - 1).is_some_and(|previous| {
                let previous_items = if turn_index - 1 == start_turn {
                    &previous.items[start_item..]
                } else {
                    &previous.items
                };
                is_hidden_nested_review_turn(previous, turn)
                    && previous_items
                        .iter()
                        .any(|item| matches!(item, ThreadItem::EnteredReviewMode { .. }))
                    && previous_items
                        .iter()
                        .any(|item| matches!(item, ThreadItem::ExitedReviewMode { .. }))
            });
        let first_item = if turn_index == start_turn {
            start_item
        } else {
            0
        };
        // Clipped items affect whether an input is a steer, but were never displayed and
        // therefore must not change the transcript's review visibility or prompt ordinals.
        let mut user_messages_in_turn = turn.items[..first_item]
            .iter()
            .filter(|item| matches!(item, ThreadItem::UserMessage { .. }))
            .count();
        for item in &turn.items[first_item..] {
            let content = match item {
                ThreadItem::EnteredReviewMode { .. } => {
                    review_mode = true;
                    continue;
                }
                ThreadItem::ExitedReviewMode { .. } => {
                    review_mode = false;
                    continue;
                }
                ThreadItem::UserMessage { content, .. } => content,
                _ => continue,
            };
            let is_steer = user_messages_in_turn > 0;
            user_messages_in_turn = user_messages_in_turn.saturating_add(/*rhs*/ 1);
            if review_mode {
                continue;
            }

            let display = ChatWidget::user_message_display_from_inputs(content);
            if hidden_nested_review_turn {
                continue;
            }
            if sanitize_user_text((&display.message).into())
                .trim()
                .is_empty()
                && display.text_elements.is_empty()
                && display.local_images.is_empty()
                && display.remote_image_urls.is_empty()
            {
                continue;
            }
            if visible_user_messages_seen != nth_user_message {
                visible_user_messages_seen =
                    visible_user_messages_seen.saturating_add(/*rhs*/ 1);
                continue;
            }

            if is_steer && !allow_whole_turn {
                bail!("the selected prompt is a steer and cannot be edited independently");
            }
            if matches!(turn.status, TurnStatus::InProgress) {
                bail!("the selected prompt belongs to a turn that is still in progress");
            }

            let selected_local_images = prompt.local_images.iter().map(|image| &image.path);
            if prompt.text != display.message
                || prompt.text_elements != display.text_elements
                || prompt.remote_image_urls != display.remote_image_urls
                || !selected_local_images.eq(display.local_images.iter())
            {
                bail!("the selected transcript prompt no longer matches the persisted thread");
            }
            prompt.mention_bindings = mention_bindings_from_user_inputs(content, &display.message);

            if is_steer
                && turns
                    .iter()
                    .any(|turn| matches!(turn.status, TurnStatus::InProgress))
            {
                bail!("Wait for the active turn to finish before rewinding this entire turn.");
            }
            let mut remote_edit_unsupported = false;
            let message_count = if is_steer {
                let messages = backtrack_turn_user_messages(turn, turn_review_start)?;
                remote_edit_unsupported = messages.iter().any(backtrack_remote_prompt_unsupported);
                let count = messages.len();
                *prompt = merge_user_messages(messages);
                count
            } else {
                1
            };
            let turn_fingerprint = backtrack_turn_fingerprint(turn)?;
            return Ok(BacktrackPromptEdit {
                turn_id: turn.id.clone(),
                nth_user_message: if is_steer {
                    turn_visible_start
                } else {
                    nth_user_message
                },
                whole_turn: is_steer,
                message_count,
                turn_fingerprint,
                remote_edit_unsupported,
                clipped_turn_prefix: is_steer && turn_index == start_turn && first_item > 0,
            });
        }
    }

    bail!("the selected prompt was not found in the persisted thread")
}

pub(crate) fn backtrack_remote_prompt_unsupported(prompt: &UserMessage) -> bool {
    let text = prompt.text.trim_start();
    !prompt.local_images.is_empty() || text.starts_with('/') || text.starts_with('!')
}

fn backtrack_turn_user_messages(turn: &Turn, mut review_mode: bool) -> Result<Vec<UserMessage>> {
    let mut messages = Vec::new();
    for item in &turn.items {
        let content = match item {
            ThreadItem::EnteredReviewMode { .. } => {
                review_mode = true;
                continue;
            }
            ThreadItem::ExitedReviewMode { .. } => {
                review_mode = false;
                continue;
            }
            ThreadItem::UserMessage { content, .. } if !review_mode => content,
            _ => continue,
        };
        if content.iter().any(|input| {
            matches!(
                input,
                codex_app_server_protocol::UserInput::Audio { .. }
                    | codex_app_server_protocol::UserInput::LocalAudio { .. }
                    | codex_app_server_protocol::UserInput::Image {
                        image: codex_app_server_protocol::ImageReference::File { .. },
                        ..
                    }
            )
        }) {
            bail!(
                "This turn contains attachments that cannot be restored safely in the composer. Its conversation history was not changed."
            );
        }
        let display = ChatWidget::user_message_display_from_inputs(content);
        if sanitize_user_text((&display.message).into())
            .trim()
            .is_empty()
            && display.text_elements.is_empty()
            && display.local_images.is_empty()
            && display.remote_image_urls.is_empty()
        {
            continue;
        }
        messages.push(UserMessage {
            mention_bindings: mention_bindings_from_user_inputs(content, &display.message),
            text: display.message,
            local_images: display
                .local_images
                .into_iter()
                .enumerate()
                .map(|(index, path)| LocalImageAttachment {
                    placeholder: local_image_label_text(index + 1),
                    path,
                })
                .collect(),
            remote_image_urls: display.remote_image_urls,
            text_elements: display.text_elements,
        });
    }
    Ok(messages)
}

/// Returns whether a turn is the reconstructed inline-review child with duplicated prompt inputs.
pub(crate) fn is_hidden_nested_review_turn(previous: &Turn, turn: &Turn) -> bool {
    if previous.status != TurnStatus::Completed
        || turn.status != TurnStatus::Interrupted
        || turn.completed_at.is_some()
        || !previous
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::EnteredReviewMode { .. }))
        || !previous
            .items
            .iter()
            .any(|item| matches!(item, ThreadItem::ExitedReviewMode { .. }))
    {
        return false;
    }

    let mut user_messages = turn.items.iter().filter_map(|item| match item {
        ThreadItem::UserMessage { content, .. } => Some(content),
        _ => None,
    });
    matches!(
        (
            user_messages.next(),
            user_messages.next(),
            user_messages.next(),
        ),
        (Some(first), Some(second), None) if first == second
    )
}

pub(crate) fn user_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize {
    user_positions_iter(cells).count()
}

fn has_backtrack_target(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> bool {
    user_count(cells) > 0
}

pub(crate) fn backtrack_prompt_revert_position(
    cells: &[Arc<dyn HistoryCell>],
    nth: usize,
    clipped_turn_prefix: bool,
) -> Option<usize> {
    if clipped_turn_prefix {
        Some(
            cells
                .iter()
                .rposition(|cell| cell.as_any().is::<SessionInfoCell>())
                .map_or(0, |index| index + 1),
        )
    } else {
        nth_user_position(cells, nth)
    }
}

pub(crate) fn nth_user_position(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
    nth: usize,
) -> Option<usize> {
    user_positions_iter(cells)
        .enumerate()
        .find_map(|(i, idx)| (i == nth).then_some(idx))
}

fn user_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_ {
    let session_start_type = TypeId::of::<SessionInfoCell>();
    let type_of = |cell: &Arc<dyn crate::history_cell::HistoryCell>| cell.as_any().type_id();

    let start = cells
        .iter()
        .rposition(|cell| type_of(cell) == session_start_type)
        .map_or(0, |idx| idx + 1);

    cells
        .iter()
        .enumerate()
        .skip(start)
        .filter_map(|(idx, cell)| {
            let user = cell.as_any().downcast_ref::<UserHistoryCell>()?;
            user.has_visible_content().then_some(idx)
        })
}

#[cfg(test)]
fn agent_group_count(cells: &[Arc<dyn crate::history_cell::HistoryCell>]) -> usize {
    agent_group_positions_iter(cells).count()
}

#[cfg(test)]
fn agent_group_positions_iter(
    cells: &[Arc<dyn crate::history_cell::HistoryCell>],
) -> impl Iterator<Item = usize> + '_ {
    let session_start_type = TypeId::of::<SessionInfoCell>();
    let type_of = |cell: &Arc<dyn crate::history_cell::HistoryCell>| cell.as_any().type_id();

    let start = cells
        .iter()
        .rposition(|cell| type_of(cell) == session_start_type)
        .map_or(0, |idx| idx + 1);

    cells
        .iter()
        .enumerate()
        .skip(start)
        .filter_map(move |(idx, cell)| {
            let is_agent = cell.as_any().downcast_ref::<AgentMessageCell>().is_some();
            let is_copy_source_group = is_agent && !cell.is_stream_continuation();
            is_copy_source_group.then_some(idx)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bottom_pane::MentionBinding;
    use crate::history_cell::AgentMessageCell;
    use crate::history_cell::HistoryCell;
    use codex_app_server_protocol::UserInput;
    use pretty_assertions::assert_eq;
    use ratatui::prelude::Line;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn render_lines(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn turn(turn_id: &str, status: TurnStatus, user_messages: usize) -> Turn {
        Turn {
            id: turn_id.to_string(),
            root_turn_id: None,
            items: (0..user_messages)
                .map(|index| ThreadItem::UserMessage {
                    id: format!("user-{index}"),
                    client_id: None,
                    content: vec![UserInput::Text {
                        text: format!("{turn_id}-prompt-{index}"),
                        text_elements: Vec::new(),
                    }],
                })
                .collect(),
            items_view: codex_app_server_protocol::TurnItemsView::Full,
            status,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        }
    }

    fn prompt(text: &str) -> UserMessage {
        UserMessage {
            text: text.to_string(),
            local_images: Vec::new(),
            remote_image_urls: Vec::new(),
            text_elements: Vec::new(),
            mention_bindings: Vec::new(),
        }
    }

    #[test]
    fn backtrack_revert_before_turn_id_resolves_first_and_later_prompts() {
        let mut hidden = turn("hidden", TurnStatus::Completed, /*user_messages*/ 1);
        let ThreadItem::UserMessage { content, .. } = &mut hidden.items[0] else {
            unreachable!()
        };
        *content = vec![UserInput::Text {
            text: "\u{0007}".into(),
            text_elements: Vec::new(),
        }];
        let turns = vec![
            hidden,
            turn("turn-1", TurnStatus::Completed, /*user_messages*/ 1),
            turn(
                "turn-compaction",
                TurnStatus::Completed,
                /*user_messages*/ 0,
            ),
            turn("turn-2", TurnStatus::Completed, /*user_messages*/ 1),
        ];

        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 0,
                &mut prompt("turn-1-prompt-0"),
            )
            .expect("first prompt should resolve"),
            "turn-1".to_string()
        );
        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 1,
                &mut prompt("turn-2-prompt-0"),
            )
            .expect("later prompt should resolve"),
            "turn-2".to_string()
        );
    }

    #[test]
    fn whole_turn_rewind_preserves_every_user_instruction_and_uses_owning_turn_boundary() {
        let turns = vec![
            turn("earlier", TurnStatus::Completed, 1),
            turn("selected", TurnStatus::Completed, 3),
        ];
        let mut selected = prompt("selected-prompt-1");
        let candidate = backtrack_prompt_edit_candidate(&turns, None, 2, &mut selected, true)
            .expect("whole-turn candidate");
        assert!(candidate.whole_turn);
        assert_eq!(candidate.turn_id, "selected");
        assert_eq!(candidate.nth_user_message, 1);
        assert_eq!(candidate.message_count, 3);
        assert_eq!(
            selected.text,
            "selected-prompt-0\nselected-prompt-1\nselected-prompt-2"
        );
        let mut independent = prompt("selected-prompt-1");
        assert!(backtrack_revert_before_turn_id(&turns, None, 2, &mut independent).is_err());
    }

    #[test]
    fn whole_turn_rewind_partial_history_recovers_clipped_initial_prompt() {
        let turns = vec![turn("selected", TurnStatus::Completed, 3)];
        let anchor = ("selected".to_string(), "user-1".to_string());
        let mut selected = prompt("selected-prompt-1");
        let candidate =
            backtrack_prompt_edit_candidate(&turns, Some(&anchor), 0, &mut selected, true)
                .expect("clipped whole-turn candidate");
        assert_eq!(candidate.nth_user_message, 0);
        assert_eq!(candidate.message_count, 3);
        assert!(candidate.clipped_turn_prefix);
        assert_eq!(
            selected.text,
            "selected-prompt-0\nselected-prompt-1\nselected-prompt-2"
        );
        let cells: Vec<Arc<dyn HistoryCell>> = vec![
            Arc::new(AgentMessageCell::new(
                vec![Line::from("earlier output of clipped turn")],
                true,
            )),
            Arc::new(crate::history_cell::new_user_prompt(
                "visible steer".into(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )),
        ];
        assert_eq!(backtrack_prompt_revert_position(&cells, 0, true), Some(0));
        assert_eq!(backtrack_prompt_revert_position(&cells, 0, false), Some(1));
    }

    #[test]
    fn whole_turn_rewind_preserves_images_mentions_and_rebased_text_elements() {
        let first = "use $skill [Image #1]";
        let second = "steer @sample [Image #1]";
        let mut selected_turn = turn("selected", TurnStatus::Completed, 0);
        selected_turn.items = vec![
            ThreadItem::UserMessage {
                id: "first".into(),
                client_id: None,
                content: vec![
                    UserInput::Text {
                        text: first.into(),
                        text_elements: vec![
                            codex_protocol::user_input::TextElement::new(
                                (4..10).into(),
                                Some("$skill".into()),
                            )
                            .into(),
                        ],
                    },
                    UserInput::LocalImage {
                        path: PathBuf::from("/tmp/first.png"),
                        detail: None,
                    },
                    UserInput::Skill {
                        name: "skill".into(),
                        path: PathBuf::from("/tmp/skills/skill/SKILL.md"),
                    },
                ],
            },
            ThreadItem::UserMessage {
                id: "steer".into(),
                client_id: None,
                content: vec![
                    UserInput::Text {
                        text: second.into(),
                        text_elements: vec![
                            codex_protocol::user_input::TextElement::new(
                                (6..13).into(),
                                Some("@sample".into()),
                            )
                            .into(),
                        ],
                    },
                    UserInput::LocalImage {
                        path: PathBuf::from("/tmp/second.png"),
                        detail: None,
                    },
                    UserInput::Image {
                        image: codex_app_server_protocol::ImageReference::Inline {
                            url: "https://example.test/remote.png".into(),
                        },
                        detail: None,
                    },
                    UserInput::Mention {
                        name: "Sample Plugin".into(),
                        path: "plugin://sample@test".into(),
                    },
                ],
            },
        ];
        let content = match &selected_turn.items[1] {
            ThreadItem::UserMessage { content, .. } => content,
            _ => unreachable!(),
        };
        let display = ChatWidget::user_message_display_from_inputs(content);
        let mut selected = UserMessage {
            text: display.message,
            local_images: display
                .local_images
                .into_iter()
                .map(|path| LocalImageAttachment {
                    placeholder: "[Image #1]".into(),
                    path,
                })
                .collect(),
            remote_image_urls: display.remote_image_urls,
            text_elements: display.text_elements,
            mention_bindings: Vec::new(),
        };
        let candidate =
            backtrack_prompt_edit_candidate(&[selected_turn], None, 1, &mut selected, true)
                .expect("attachment-safe whole turn");
        assert!(candidate.remote_edit_unsupported);
        assert_eq!(
            selected
                .local_images
                .iter()
                .map(|image| image.path.clone())
                .collect::<Vec<_>>(),
            vec![
                PathBuf::from("/tmp/first.png"),
                PathBuf::from("/tmp/second.png")
            ]
        );
        assert_eq!(
            selected.remote_image_urls,
            vec!["https://example.test/remote.png".to_string()]
        );
        assert_eq!(
            selected.mention_bindings,
            vec![
                MentionBinding {
                    sigil: '$',
                    mention: "skill".into(),
                    path: "/tmp/skills/skill/SKILL.md".into()
                },
                MentionBinding {
                    sigil: '@',
                    mention: "sample".into(),
                    path: "plugin://sample@test".into()
                }
            ]
        );
        for (element, token) in selected.text_elements.iter().zip(["$skill", "@sample"]) {
            let start = selected.text.find(token).expect("mention text");
            assert_eq!(element.byte_range, (start..start + token.len()).into());
        }
    }

    #[test]
    fn whole_turn_rewind_rejects_stale_in_progress_and_unsupported_attachment_inputs() {
        let turns = vec![turn("selected", TurnStatus::Completed, 2)];
        assert!(
            backtrack_prompt_edit_candidate(&turns, None, 1, &mut prompt("stale"), true).is_err()
        );
        let running = vec![turn("selected", TurnStatus::InProgress, 2)];
        assert!(
            backtrack_prompt_edit_candidate(
                &running,
                None,
                1,
                &mut prompt("selected-prompt-1"),
                true
            )
            .is_err()
        );
        let later_active = vec![
            turn("selected", TurnStatus::Completed, 2),
            turn("later", TurnStatus::InProgress, 1),
        ];
        assert!(
            backtrack_prompt_edit_candidate(
                &later_active,
                None,
                1,
                &mut prompt("selected-prompt-1"),
                true
            )
            .is_err()
        );
        let mut unsafe_turn = turn("selected", TurnStatus::Completed, 2);
        if let ThreadItem::UserMessage { content, .. } = &mut unsafe_turn.items[0] {
            content.push(UserInput::Audio {
                url: "data:audio/wav;base64,AA==".into(),
            });
        }
        assert!(
            backtrack_prompt_edit_candidate(
                &[unsafe_turn],
                None,
                1,
                &mut prompt("selected-prompt-1"),
                true
            )
            .is_err()
        );
    }

    #[test]
    fn whole_turn_rewind_fingerprint_changes_with_later_messages_and_remote_guard_covers_all_messages()
     {
        let mut selected_turn = turn("selected", TurnStatus::Completed, 3);
        let old = backtrack_turn_fingerprint(&selected_turn).expect("fingerprint");
        if let ThreadItem::UserMessage { content, .. } = &mut selected_turn.items[2] {
            content.push(UserInput::Text {
                text: "new instruction".into(),
                text_elements: Vec::new(),
            });
        }
        assert_ne!(
            old,
            backtrack_turn_fingerprint(&selected_turn).expect("changed fingerprint")
        );
        if let ThreadItem::UserMessage { content, .. } = &mut selected_turn.items[0] {
            *content = vec![UserInput::Text {
                text: "/command must not be restored remotely".into(),
                text_elements: Vec::new(),
            }];
        }
        let candidate = backtrack_prompt_edit_candidate(
            &[selected_turn],
            None,
            1,
            &mut prompt("selected-prompt-1"),
            true,
        )
        .expect("candidate");
        assert!(candidate.remote_edit_unsupported);
    }

    #[test]
    fn backtrack_revert_before_turn_id_rejects_mid_turn_steers() {
        let turns = vec![turn(
            "turn-1",
            TurnStatus::Completed,
            /*user_messages*/ 2,
        )];

        let error = backtrack_revert_before_turn_id(
            &turns,
            /*start_item*/ None,
            /*nth_user_message*/ 1,
            &mut prompt("turn-1-prompt-1"),
        )
        .expect_err("a steer cannot be edited independently");

        assert_eq!(
            error.to_string(),
            "the selected prompt is a steer and cannot be edited independently"
        );
    }

    #[test]
    fn backtrack_revert_partial_history_does_not_make_a_steer_editable() {
        let turns = vec![turn(
            "turn-1",
            TurnStatus::Completed,
            /*user_messages*/ 2,
        )];
        let start_item = (turns[0].id.clone(), turns[0].items[1].id().to_string());
        let error = backtrack_revert_before_turn_id(
            &turns,
            Some(&start_item),
            /*nth_user_message*/ 0,
            &mut prompt("turn-1-prompt-1"),
        )
        .expect_err("the loaded page starts mid-turn");
        assert_eq!(
            error.to_string(),
            "the selected prompt is a steer and cannot be edited independently"
        );
    }

    #[test]
    fn backtrack_revert_before_turn_id_rejects_in_progress_and_missing_prompts() {
        let turns = vec![turn(
            "turn-1",
            TurnStatus::InProgress,
            /*user_messages*/ 1,
        )];

        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 0,
                &mut prompt("turn-1-prompt-0"),
            )
            .expect_err("in-progress prompt cannot be edited")
            .to_string(),
            "the selected prompt belongs to a turn that is still in progress"
        );
        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 1,
                &mut prompt("missing prompt"),
            )
            .expect_err("missing prompt cannot be edited")
            .to_string(),
            "the selected prompt was not found in the persisted thread"
        );

        let completed_turns = vec![turn(
            "turn-1",
            TurnStatus::Completed,
            /*user_messages*/ 1,
        )];
        assert_eq!(
            backtrack_revert_before_turn_id(
                &completed_turns,
                /*start_item*/ None,
                /*nth_user_message*/ 0,
                &mut prompt("different prompt"),
            )
            .expect_err("a stale transcript prompt cannot be edited")
            .to_string(),
            "the selected transcript prompt no longer matches the persisted thread"
        );
    }

    #[test]
    fn backtrack_revert_before_turn_id_skips_hidden_review_prompts() {
        let mut review_turn = turn(
            "turn-review",
            TurnStatus::Completed,
            /*user_messages*/ 1,
        );
        review_turn.items.insert(
            /*index*/ 0,
            ThreadItem::EnteredReviewMode {
                id: "review-start".to_string(),
                review: "changes against main".to_string(),
            },
        );
        review_turn.items.push(ThreadItem::ExitedReviewMode {
            id: "review-end".to_string(),
            review: "review complete".to_string(),
        });
        let turns = vec![
            turn("turn-1", TurnStatus::Completed, /*user_messages*/ 1),
            review_turn,
            turn("turn-2", TurnStatus::Completed, /*user_messages*/ 1),
        ];

        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 1,
                &mut prompt("turn-2-prompt-0"),
            )
            .expect("the visible prompt after review should resolve"),
            "turn-2".to_string()
        );
        // This loaded page starts after the review marker, so its review prompt is visible.
        let start_item = (turns[1].id.clone(), turns[1].items[1].id().to_string());
        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                Some(&start_item),
                /*nth_user_message*/ 1,
                &mut prompt("turn-2-prompt-0"),
            )
            .expect("ordinal must match the clipped transcript"),
            "turn-2"
        );
    }

    #[test]
    fn backtrack_revert_before_turn_id_skips_hidden_nested_review_prompts() {
        let review_hint = "current changes";
        let review_prompt =
            "Review the current code changes (staged, unstaged, and untracked files).";
        let review_turn = Turn {
            items: vec![
                ThreadItem::EnteredReviewMode {
                    id: "review-start".to_string(),
                    review: review_hint.to_string(),
                },
                ThreadItem::ExitedReviewMode {
                    id: "review-end".to_string(),
                    review: "review complete".to_string(),
                },
            ],
            ..turn(
                "turn-review",
                TurnStatus::Completed,
                /*user_messages*/ 0,
            )
        };
        let review_child_turn = Turn {
            items: (0..2)
                .map(|index| ThreadItem::UserMessage {
                    id: format!("review-prompt-{index}"),
                    client_id: None,
                    content: vec![UserInput::Text {
                        text: review_prompt.to_string(),
                        text_elements: Vec::new(),
                    }],
                })
                .collect(),
            ..turn(
                "turn-review-child",
                TurnStatus::Interrupted,
                /*user_messages*/ 0,
            )
        };
        let interrupted_steered_turn = Turn {
            items: review_child_turn.items.clone(),
            completed_at: Some(1),
            ..turn(
                "turn-interrupted-steer",
                TurnStatus::Interrupted,
                /*user_messages*/ 0,
            )
        };
        assert!(!is_hidden_nested_review_turn(
            &review_turn,
            &interrupted_steered_turn,
        ));
        let turns = vec![
            review_turn,
            review_child_turn,
            turn("turn-2", TurnStatus::Completed, /*user_messages*/ 1),
        ];

        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 0,
                &mut prompt("turn-2-prompt-0"),
            )
            .expect("the visible prompt after a nested review should resolve"),
            "turn-2".to_string()
        );
    }

    #[test]
    fn backtrack_revert_before_turn_id_restores_canonical_mention_bindings() {
        let mut selected_turn = turn("turn-2", TurnStatus::Completed, /*user_messages*/ 1);
        selected_turn.items = vec![ThreadItem::UserMessage {
            id: "selected-prompt".to_string(),
            client_id: None,
            content: vec![
                UserInput::Text {
                    text: "use $skill @sample $google-calendar".to_string(),
                    text_elements: Vec::new(),
                },
                UserInput::Skill {
                    name: "skill".to_string(),
                    path: PathBuf::from("/tmp/skills/skill/SKILL.md"),
                },
                UserInput::Mention {
                    name: "Sample Plugin".to_string(),
                    path: "plugin://sample@test".to_string(),
                },
                UserInput::Mention {
                    name: "Google Calendar".to_string(),
                    path: "app://google_calendar".to_string(),
                },
            ],
        }];
        let turns = vec![
            turn("turn-1", TurnStatus::Completed, /*user_messages*/ 1),
            selected_turn,
        ];
        let mut selected_prompt = prompt("use $skill @sample $google-calendar");

        assert_eq!(
            backtrack_revert_before_turn_id(
                &turns,
                /*start_item*/ None,
                /*nth_user_message*/ 1,
                &mut selected_prompt,
            )
            .expect("the selected prompt should resolve"),
            "turn-2".to_string()
        );
        assert_eq!(
            selected_prompt.mention_bindings,
            vec![
                MentionBinding {
                    sigil: '$',
                    mention: "skill".to_string(),
                    path: "/tmp/skills/skill/SKILL.md".to_string(),
                },
                MentionBinding {
                    sigil: '@',
                    mention: "sample".to_string(),
                    path: "plugin://sample@test".to_string(),
                },
                MentionBinding {
                    sigil: '$',
                    mention: "google-calendar".to_string(),
                    path: "app://google_calendar".to_string(),
                },
            ]
        );
    }

    #[test]
    fn agent_group_count_ignores_context_compacted_marker() {
        let cells: Vec<Arc<dyn HistoryCell>> = vec![
            Arc::new(AgentMessageCell::new(
                vec![Line::from("first")],
                /*is_first_line*/ true,
            )) as Arc<dyn HistoryCell>,
            Arc::new(crate::history_cell::new_info_event(
                "Context compacted".to_string(),
                /*hint*/ None,
            )) as Arc<dyn HistoryCell>,
            Arc::new(AgentMessageCell::new(
                vec![Line::from("second")],
                /*is_first_line*/ true,
            )) as Arc<dyn HistoryCell>,
        ];

        assert_eq!(agent_group_count(&cells), 2);
    }

    #[test]
    fn backtrack_target_requires_user_message() {
        let mut cells: Vec<Arc<dyn HistoryCell>> = vec![
            Arc::new(AgentMessageCell::new(
                vec![Line::from("assistant")],
                /*is_first_line*/ true,
            )) as Arc<dyn HistoryCell>,
            Arc::new(crate::history_cell::new_info_event(
                "Context compacted".to_string(),
                /*hint*/ None,
            )) as Arc<dyn HistoryCell>,
        ];

        assert!(!has_backtrack_target(&cells));

        cells.push(Arc::new(UserHistoryCell {
            spoken: false,
            message: "hello".to_string(),
            text_elements: Vec::new(),
            local_image_paths: Vec::new(),
            remote_image_urls: Vec::new(),
        }) as Arc<dyn HistoryCell>);

        assert!(has_backtrack_target(&cells));
    }

    #[test]
    fn backtrack_unavailable_info_message_snapshot() {
        let cell = crate::history_cell::new_info_event(
            NO_PREVIOUS_MESSAGE_TO_EDIT.to_string(),
            /*hint*/ None,
        );
        let rendered = render_lines(&cell.display_lines(/*width*/ 80)).join("\n");

        insta::assert_snapshot!(rendered);
    }
}

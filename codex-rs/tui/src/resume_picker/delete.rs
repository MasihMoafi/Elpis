//! Elpis: require explicit consent before deleting a saved session from the picker.

use super::PickerFooterHint;
use super::PickerLoadRequest;
use super::PickerState;
use super::SessionPickerAction;
use super::SessionPickerLaunchContext;
use super::SessionSelection;
use super::archive::ArchiveState;
use super::hint_line_for_row;
use crate::keymap::KeymapContext;
use crate::style::accent_style;
use crate::text_formatting::truncate_text;
use codex_protocol::ThreadId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Block;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) enum DeleteState {
    #[default]
    Idle,
    Confirming {
        thread_id: ThreadId,
        label: String,
    },
    Pending {
        thread_id: ThreadId,
        label: String,
    },
}

impl PickerState {
    pub(super) fn delete_shortcut_available(&self) -> bool {
        if !self.query.is_empty()
            || !matches!(self.action, SessionPickerAction::Resume)
            || !matches!(self.archive_state, ArchiveState::Idle)
            || self.delete_state != DeleteState::Idle
        {
            return false;
        }
        let key = KeyEvent::from(KeyCode::Backspace);
        self.keymap.list.action_for(key).is_none()
            && !self.keymap.chords.bindings.iter().any(|binding| {
                binding.action.context == KeymapContext::List && binding.chord.prefix.is_press(key)
            })
    }

    pub(super) fn request_delete_for_selected_session(&mut self) {
        if !self.delete_shortcut_available() {
            return;
        }
        let Some(row) = self.filtered_rows.get(self.selected) else {
            return;
        };
        let Some(thread_id) = row.thread_id else {
            self.inline_error = Some("Selected session does not have a thread ID.".into());
            self.request_frame();
            return;
        };
        if matches!(
            self.launch_context,
            SessionPickerLaunchContext::ExistingSession {
                current_thread_id: Some(current_thread_id)
            } if current_thread_id == thread_id
        ) {
            self.inline_error =
                Some("Close this session before deleting it from the resume list.".into());
            self.request_frame();
            return;
        }
        self.delete_state = DeleteState::Confirming {
            thread_id,
            label: row
                .display_preview()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        };
        self.request_frame();
    }

    pub(super) fn handle_delete_key(&mut self, key: KeyEvent) -> Option<SessionSelection> {
        if key.kind != KeyEventKind::Press {
            return None;
        }
        if crate::key_hint::ctrl(KeyCode::Char('c')).is_press(key) {
            return Some(SessionSelection::Exit);
        }
        let DeleteState::Confirming { thread_id, label } = &self.delete_state else {
            return None;
        };
        let plain = key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT;
        match key.code {
            KeyCode::Char('y' | 'Y') if plain => {
                let thread_id = *thread_id;
                self.delete_state = DeleteState::Pending {
                    thread_id,
                    label: label.clone(),
                };
                self.request_frame();
                (self.picker_loader)(PickerLoadRequest::Delete { thread_id });
            }
            KeyCode::Esc | KeyCode::Enter => {
                self.delete_state = DeleteState::Idle;
                self.request_frame();
            }
            KeyCode::Char('n' | 'N') if plain => {
                self.delete_state = DeleteState::Idle;
                self.request_frame();
            }
            _ => {}
        }
        None
    }

    pub(super) fn handle_delete_result(
        &mut self,
        thread_id: ThreadId,
        result: std::io::Result<()>,
    ) {
        if !matches!(self.delete_state, DeleteState::Pending { thread_id: pending, .. } if pending == thread_id)
        {
            return;
        }
        self.delete_state = DeleteState::Idle;
        match result {
            Ok(()) => {
                self.thread_history_modes.remove(&thread_id);
                self.remove_session_row(thread_id);
            }
            Err(error) => {
                self.inline_error = Some(format!("Failed to delete session: {error}"));
                self.request_frame();
            }
        }
    }
}

pub(super) fn render_prompt(
    frame: &mut crate::custom_terminal::Frame,
    area: Rect,
    state: &PickerState,
) {
    let (title, label) = match &state.delete_state {
        DeleteState::Idle => return,
        DeleteState::Confirming { label, .. } => (" Delete session? ", label),
        DeleteState::Pending { label, .. } => (" Deleting session… ", label),
    };
    Clear.render(area, frame.buffer);
    let block = Block::bordered().title(title).border_style(accent_style());
    let inner = block.inner(area);
    frame.render_widget_ref(&block, area);
    let lines = vec![
        Line::from(truncate_text(label, inner.width as usize)).bold(),
        Line::from(truncate_text(
            "Also deletes subagents.",
            inner.width as usize,
        )),
        Line::from("You cannot undo this."),
    ];
    frame.render_widget_ref(&Paragraph::new(lines), inner);
}

pub(super) fn footer_hints(state: &PickerState, width: u16) -> Vec<Line<'static>> {
    let hints = match state.delete_state {
        DeleteState::Confirming { .. } => vec![
            PickerFooterHint {
                key: "y".into(),
                wide_label: "delete".into(),
                compact_label: "delete".into(),
                priority: 0,
            },
            PickerFooterHint {
                key: "n/esc/enter".into(),
                wide_label: "cancel".into(),
                compact_label: "cancel".into(),
                priority: 1,
            },
        ],
        DeleteState::Pending { .. } => vec![PickerFooterHint {
            key: "deleting".into(),
            wide_label: "session…".into(),
            compact_label: "session…".into(),
            priority: 0,
        }],
        DeleteState::Idle => return Vec::new(),
    };
    vec![
        hint_line_for_row(&hints, width),
        hint_line_for_row(
            &[PickerFooterHint {
                key: crate::key_hint::ctrl(KeyCode::Char('c')).display_label(),
                wide_label: "exit".into(),
                compact_label: "exit".into(),
                priority: 0,
            }],
            width,
        ),
    ]
}

//! Shared rename editing and task shortcuts respect configured editor and list bindings.

use super::*;
use crossterm::event::KeyEventKind;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::layout::Position;

/// Lines one wheel notch moves the selected task's conversation, as terminals scroll text.
const DETAILS_SCROLL_LINES: usize = 3;

impl AgentsOverviewView {
    pub(in crate::app::agents_overview_view) fn command_center_mouse(
        &mut self,
        event: MouseEvent,
    ) -> bool {
        if matches!(
            event.kind,
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
        ) {
            // The wheel over the selected task reads its whole conversation instead of the hidden transcript.
            let mut state = self.state();
            if state.help
                || state.stop_target.is_some()
                || !state
                    .details_area
                    .contains(Position::new(event.column, event.row))
            {
                return false;
            }
            state.details_scroll = if event.kind == MouseEventKind::ScrollUp {
                state.details_scroll.saturating_sub(DETAILS_SCROLL_LINES)
            } else {
                state
                    .details_scroll
                    .saturating_add(DETAILS_SCROLL_LINES)
                    .min(state.details_max_scroll)
            };
            return true;
        }
        if event.kind != MouseEventKind::Down(MouseButton::Left) || !event.modifiers.is_empty() {
            return false;
        }
        let mut state = self.state();
        if state.help || state.editor_target().is_some() || state.stop_target.is_some() {
            return false;
        }
        let point = Position::new(event.column, event.row);
        let target = state
            .mouse_targets
            .iter()
            .find_map(|(area, target)| area.contains(point).then_some(*target));
        match target {
            Some(AgentsOverviewMouseTarget::Filter(index)) => {
                state.status_filter = index;
                state.scroll = 0;
                drop(state);
                self.reconcile_command_center_selection();
            }
            Some(AgentsOverviewMouseTarget::Task(thread_id)) => {
                drop(state);
                let visible = self.selectable_indices();
                let Some(index) = self
                    .rows
                    .iter()
                    .position(|row| row.thread_id == thread_id)
                    .filter(|index| visible.contains(index))
                else {
                    return false;
                };
                self.selected = index;
                self.state().show_more_selected = false;
            }
            Some(AgentsOverviewMouseTarget::ShowMore) => {
                let online = state.connection_notice.is_none() && !state.creating_worktree;
                state.show_more_selected = true;
                drop(state);
                self.selected = usize::MAX;
                if online {
                    self.activate();
                }
            }
            None => return false,
        }
        true
    }

    pub(in crate::app::agents_overview_view) fn rename_key(&mut self, key: KeyEvent) -> bool {
        let mut state = self.state();
        if state.editor_target().is_none() {
            return false;
        }
        let input = &mut state.input;
        let editing = input.should_handle_vim_insert_escape(key) || input.is_vim_operator_pending();
        if !editing {
            match self.keymap.action_for(key) {
                Some(ListAction::Cancel) => {
                    drop(state);
                    self.on_ctrl_c();
                    return true;
                }
                Some(ListAction::Accept) if !is_plain_text_key_event(key) => {
                    let online = state.connection_notice.is_none() && !state.creating_worktree;
                    drop(state);
                    if online {
                        self.activate();
                    }
                    return true;
                }
                _ => {}
            }
        }
        let editor_binding = crate::keymap::keymap_action_ids()
            .filter(|action| action.context == input.keymap_context())
            .any(|action| {
                crate::keymap::bindings_for_action(
                    &self.editor_keymap,
                    action.context.config_name(),
                    action.action,
                )
                .is_some_and(|bindings| bindings.is_pressed(key))
            });
        if editing
            || is_plain_text_key_event(key)
            || editor_binding
            || !self.center_shortcut_keys.is_pressed(key)
        {
            input.input(key);
            return !crate::keymap::is_dispatch_token_event(key);
        }
        false
    }

    pub(in crate::app::agents_overview_view) fn command_center_key(
        &mut self,
        key: KeyEvent,
    ) -> bool {
        let stop_target = self.state().stop_target;
        if let Some(thread_id) = stop_target {
            match self.keymap.action_for(key) {
                Some(ListAction::Cancel) => {
                    self.state().stop_target = None;
                }
                Some(ListAction::Accept) => {
                    let online = {
                        let state = self.state();
                        state.connection_notice.is_none() && !state.creating_worktree
                    };
                    let active = self.rows.iter().any(|row| {
                        row.thread_id == thread_id
                            && matches!(row.thread.status, ThreadStatus::Active { .. })
                    });
                    if online && active {
                        self.app_event_tx
                            .send(AppEvent::StopAgentsOverviewThread { thread_id });
                    }
                    self.state().stop_target = None;
                }
                _ => {}
            }
            return true;
        }
        if self.state().editing_metadata() {
            if self.keymap.action_for(key) == Some(ListAction::Cancel) {
                self.on_ctrl_c();
                return true;
            }
            return false;
        }
        let steer_target = self.selected_row().map(|row| row.thread_id);
        let mut state = self.state();
        if state.help && self.keymap.action_for(key) == Some(ListAction::Cancel) {
            state.help = false;
            return true;
        }
        if state.help {
            if key.code == KeyCode::Char('?')
                && key.kind == KeyEventKind::Press
                && !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
            {
                state.help = false;
            }
            return true;
        }
        if self.center_shortcut_keys.is_pressed(key) {
            return false;
        }
        if key.code == KeyCode::Char('s')
            && key.modifiers.is_empty()
            && key.kind == KeyEventKind::Press
        {
            if state.connection_notice.is_none()
                && !state.creating_worktree
                && let Some(target) = steer_target
            {
                state.set_rename_input("", &self.editor_keymap);
                state.steer_target = Some(target);
                state.search.clear();
                state.searching = false;
            }
            return true;
        }
        if key.code == KeyCode::Char('?')
            && key.kind == KeyEventKind::Press
            && !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            state.help = !state.help;
            return true;
        }
        if key.code == KeyCode::Tab
            && !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            let step = if key.modifiers.contains(KeyModifiers::SHIFT) {
                TASK_FILTERS.len() - 1
            } else {
                1
            };
            state.status_filter = (state.status_filter + step) % TASK_FILTERS.len();
            state.scroll = 0;
            drop(state);
            self.reconcile_command_center_selection();
            return true;
        }
        false
    }
}

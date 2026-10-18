//! Shared rename editing and task shortcuts respect configured editor and list bindings.

use super::*;
use crossterm::event::KeyEventKind;

impl AgentsOverviewView {
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

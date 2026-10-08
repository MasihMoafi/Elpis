//! Elpis: IDE-style keyboard selection in the composer. Shift with a movement key selects from
//! where the selection started; Ctrl or Alt with it moves by words (GNOME Terminal keeps
//! Ctrl+Shift+Left/Right for itself and delivers Alt+Shift+Left/Right); Ctrl+A selects
//! everything. It is the selection mouse dragging makes, so typing, Backspace, Delete and Ctrl+C
//! act on it alike.

use super::*;

impl TextArea {
    /// Selects for a selection key and says whether `event` was one.
    pub(super) fn elpis_select(&mut self, event: KeyEvent) -> bool {
        let modifiers = event.modifiers;
        if matches!(event.code, KeyCode::Char('a' | 'A'))
            && modifiers.contains(KeyModifiers::CONTROL)
            && !modifiers.contains(KeyModifiers::ALT)
        {
            self.mouse_selection = None;
            self.jump(0);
            self.extend_selection(|textarea| textarea.jump(textarea.text.len()));
            return true;
        }
        if !modifiers.contains(KeyModifiers::SHIFT) {
            return false;
        }
        let by_word = modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let whole_draft = modifiers.contains(KeyModifiers::CONTROL);
        match event.code {
            KeyCode::Left if by_word => {
                self.extend_selection(|textarea| {
                    textarea.jump(textarea.beginning_of_previous_word())
                });
            }
            KeyCode::Right if by_word => {
                self.extend_selection(|textarea| textarea.jump(textarea.end_of_next_word()));
            }
            KeyCode::Left => self.extend_selection(Self::move_cursor_left),
            KeyCode::Right => self.extend_selection(Self::move_cursor_right),
            KeyCode::Up => self.extend_selection(Self::move_cursor_up),
            KeyCode::Down => self.extend_selection(Self::move_cursor_down),
            KeyCode::Home if whole_draft => self.extend_selection(|textarea| textarea.jump(0)),
            KeyCode::End if whole_draft => {
                self.extend_selection(|textarea| textarea.jump(textarea.text.len()));
            }
            KeyCode::Home => self.extend_selection(|textarea| {
                textarea.move_cursor_to_beginning_of_line(/*move_up_at_bol*/ false);
            }),
            KeyCode::End => self.extend_selection(|textarea| {
                textarea.move_cursor_to_end_of_line(/*move_down_at_eol*/ false);
            }),
            _ => return false,
        }
        true
    }

    /// Puts the cursor at `pos`; the next vertical move starts from its column.
    fn jump(&mut self, pos: usize) {
        self.cursor_pos = pos;
        self.preferred_col = None;
    }
}

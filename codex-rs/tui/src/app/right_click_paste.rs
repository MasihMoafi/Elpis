//! Right-click CLIPBOARD and local X11 middle-click PRIMARY fallback for an editable composer.
//! Elpis: Ctrl+V with no image on the clipboard pastes its text the same way, whatever the
//! right-click setting.
//! Existing selection handlers run first. Only a draw may deliver a read, so real input
//! invalidates pending paste before completion and is never replaced by clipboard text.

use super::*;
use crate::clipboard_copy::worker::PasteSource;
use crate::tui::VscodeDetection;
use codex_config::types::RightClickPaste;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;

pub(super) struct PendingPaste {
    thread: Option<ThreadId>,
    draft: (String, usize),
    source: PasteSource,
    /// Ctrl+V asked for it, not a mouse button.
    by_key: bool,
    _request: Arc<()>,
}

pub(super) struct PasteEnvironment {
    pub(super) primary: bool,
    pub(super) platform_default: bool,
    pub(super) ssh: bool,
    pub(super) wsl: bool,
    pub(super) vscode: VscodeDetection,
}

impl PasteEnvironment {
    pub(super) fn detect() -> Self {
        Self {
            primary: crate::clipboard_copy::primary::available(),
            platform_default: cfg!(any(target_os = "windows", target_os = "linux")),
            ssh: crate::clipboard_copy::is_ssh_session(),
            wsl: crate::clipboard_copy::is_wsl_session(),
            vscode: tui::detect_vscode_terminal(),
        }
    }

    fn allows(&self, mode: RightClickPaste) -> bool {
        if self.ssh || self.vscode == VscodeDetection::VsCode {
            return false;
        }
        match mode {
            RightClickPaste::Off => false,
            RightClickPaste::On => !cfg!(target_os = "android"),
            RightClickPaste::Auto => {
                self.platform_default && !(self.wsl && self.vscode == VscodeDetection::Unknown)
            }
        }
    }
}

impl App {
    fn right_click_paste_target(
        &self,
        tui: &tui::Tui,
        source: PasteSource,
        by_key: bool,
    ) -> Option<(Option<ThreadId>, (String, usize))> {
        let allowed = match source {
            PasteSource::Clipboard if by_key => !self.right_click_paste_environment.ssh,
            PasteSource::Clipboard => {
                !self.transcript_view.has_selection_range()
                    && self
                        .right_click_paste_environment
                        .allows(self.local_settings.tui.right_click_paste)
            }
            PasteSource::Primary => self.right_click_paste_environment.primary,
        };
        // Elpis: Ctrl+V pastes in the inline screen too; mouse buttons there are the terminal's.
        if (!tui.is_owned_screen() && !by_key)
            || self.overlay.is_some()
            || self.transcript_view.is_search_active()
            || !allowed
        {
            return None;
        }
        Some((
            self.current_displayed_thread_id(),
            self.chat_widget.right_click_paste_target()?,
        ))
    }

    pub(super) fn start_right_click_paste(&mut self, tui: &mut tui::Tui, mouse: MouseEvent) {
        let source = match mouse.kind {
            MouseEventKind::Down(MouseButton::Right) => PasteSource::Clipboard,
            MouseEventKind::Down(MouseButton::Middle) => PasteSource::Primary,
            _ => return,
        };
        if !mouse.modifiers.is_empty() {
            return;
        }
        self.start_paste(tui, source, /*by_key*/ false);
    }

    /// Elpis: Ctrl+V found no image on the clipboard; paste its text.
    pub(super) fn start_key_paste(&mut self, tui: &mut tui::Tui) {
        self.start_paste(tui, PasteSource::Clipboard, /*by_key*/ true);
    }

    fn start_paste(&mut self, tui: &mut tui::Tui, source: PasteSource, by_key: bool) {
        if self.pending_right_click_paste.is_some() {
            return;
        }
        let Some((thread, draft)) = self.right_click_paste_target(tui, source, by_key) else {
            return;
        };
        match tui.clipboard.read_text(source, tui.frame_requester()) {
            Ok(Some(request)) => {
                self.pending_right_click_paste = Some(PendingPaste {
                    thread,
                    draft,
                    source,
                    by_key,
                    _request: request,
                });
                tui.frame_requester().schedule_frame();
            }
            Ok(None) => {}
            Err(error) => self.chat_widget.add_error_message(error),
        }
    }

    /// Invalidate before polling, even when the worker has already completed.
    pub(super) fn invalidate_right_click_paste(&mut self, event: &TuiEvent) {
        let Some(pending) = &self.pending_right_click_paste else {
            return;
        };
        let button = match pending.source {
            PasteSource::Clipboard => MouseButton::Right,
            PasteSource::Primary => MouseButton::Middle,
        };
        let keep = match event {
            TuiEvent::Draw | TuiEvent::Resize(_) | TuiEvent::FocusGained => true,
            TuiEvent::Mouse(mouse) => {
                mouse.kind == MouseEventKind::Moved
                    || mouse.kind == MouseEventKind::Up(button)
                    || (mouse.kind == MouseEventKind::Down(button) && mouse.modifiers.is_empty())
            }
            // Elpis: releasing Ctrl+V does not change the draft.
            TuiEvent::Key(key) => key.kind == crossterm::event::KeyEventKind::Release,
            TuiEvent::Paste(_) | TuiEvent::FocusLost | TuiEvent::Resume => false,
        };
        if !keep {
            self.pending_right_click_paste = None;
        }
    }

    pub(super) fn finish_right_click_paste(
        &mut self,
        tui: &mut tui::Tui,
        event: TuiEvent,
    ) -> TuiEvent {
        if !matches!(event, TuiEvent::Draw) {
            return event;
        }
        let Some(pending) = self.pending_right_click_paste.as_ref() else {
            tui.clipboard.take_text_result();
            return event;
        };
        let Some((thread, draft)) =
            self.right_click_paste_target(tui, pending.source, pending.by_key)
        else {
            self.pending_right_click_paste = None;
            return event;
        };
        if pending.thread != thread || pending.draft != draft {
            self.pending_right_click_paste = None;
            return event;
        }
        let Some(result) = tui.clipboard.take_text_result() else {
            return event;
        };
        self.pending_right_click_paste = None;
        match result {
            Ok(text) if !text.is_empty() => {
                tui.frame_requester().schedule_frame();
                TuiEvent::Paste(text)
            }
            Ok(_) => event,
            Err(error) => {
                self.chat_widget.add_error_message(error);
                event
            }
        }
    }
}

#[cfg(test)]
#[path = "right_click_paste_tests.rs"]
mod tests;

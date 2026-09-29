//! Elpis: the ChatWidget side of the Context Ledger that v0.3.0 kept inside upstream files.
//!
//! Copied from v0.3.0 `chatwidget.rs` (the Manual Memory cache), `settings.rs` (the Smart
//! Prune and Subagents switches), `slash_dispatch.rs` (`/add`), `session_flow.rs` (the reset
//! on thread change) and `interaction.rs` (the Tab/Alt+C toggle). Upstream files reach this
//! module through one-line seams marked `Elpis:`.

use std::path::PathBuf;

use codex_features::Feature;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;

use super::ChatWidget;
use crate::app_event::AppEvent;
use crate::elpis_ledger_events::ManualMemoryMutation;
use crate::elpis_ledger_events::ManualMemoryRequestTarget;
use crate::elpis_ledger_events::ManualMemoryUnavailableReason;
use crate::key_hint;
use crate::legacy_core::config::Config;

pub(super) const ADD_CONTEXT_USAGE: &str =
    "Usage: /add <file-or-directory-path> (drag & drop works too)";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ManualMemoryPhase {
    #[default]
    Loading,
    Ready,
    Creating,
    Unavailable,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct ManualMemoryCache {
    pub(super) bound_target: Option<ManualMemoryRequestTarget>,
    pub(super) phase: ManualMemoryPhase,
    pub(super) status: Option<crate::legacy_core::elpis_context::ManualMemoryStatus>,
    pub(super) sources: Vec<crate::legacy_core::elpis_context::ContinuitySource>,
    pub(super) unavailable_reason: Option<ManualMemoryUnavailableReason>,
    pub(super) pending_mutation: Option<ManualMemoryMutation>,
    pub(super) refresh_requested: bool,
    pub(super) pending_context_report: bool,
}

/// Where Manual Memory lives: `<codex_home>/memories`, as v0.3.0's `config.memory_dir`.
pub(crate) fn elpis_memory_dir(config: &Config) -> PathBuf {
    config.codex_home.join("memories").to_path_buf()
}

/// Terminals drop paths quoted and/or with backslash-escaped spaces, sometimes as
/// file:// URIs. Normalize all of that to a plain filesystem path.
fn clean_dropped_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(trimmed);
    let without_scheme = unquoted.strip_prefix("file://").unwrap_or(unquoted);
    without_scheme.replace("\\ ", " ")
}

impl ChatWidget {
    /// Tab and Alt+C open, focus and hide the ledger before any modal sees the key.
    ///
    /// With a popup open (for example the slash-command list) Tab still belongs to it.
    pub(super) fn handle_context_ledger_pre_modal_key(&mut self, key_event: KeyEvent) -> bool {
        if key_hint::plain(KeyCode::Tab).is_press(key_event)
            && !self.bottom_pane.has_active_view()
            && !self.bottom_pane.no_modal_or_popup_active()
        {
            self.bottom_pane.handle_key_event(key_event);
            return true;
        }
        let ledger_toggle = key_hint::plain(KeyCode::Tab).is_press(key_event)
            || key_hint::alt(KeyCode::Char('c')).is_press(key_event);
        ledger_toggle && self.handle_context_ledger_key_event(key_event)
    }

    /// Smart Prune needs the Elpis context engine, which arrives in a later Elpis build.
    pub(super) fn request_smart_prune_enabled(&mut self, _enabled: bool) -> bool {
        self.add_info_message(
            "Smart Prune is not in this Elpis build yet. It arrives in a later Elpis build."
                .to_string(),
            /*hint*/ None,
        );
        self.request_redraw();
        false
    }

    pub(super) fn toggle_smart_prune(&mut self) -> bool {
        self.request_smart_prune_enabled(/*enabled*/ true)
    }

    /// Flips whether the model may hand work to other agent threads.
    ///
    /// The setting is durable, so the switch shows the requested state right
    /// away and the write reconciles it. A turn already running keeps the policy
    /// it started under; the next one is bound by the new answer.
    pub(super) fn toggle_subagents(&mut self) -> bool {
        if self.context_ledger.pending_subagents_enabled.is_some() {
            return false;
        }
        let enabled = !self
            .context_ledger
            .pending_subagents_enabled
            .unwrap_or(self.config.features.enabled(Feature::Collab));
        self.context_ledger.pending_subagents_enabled = Some(enabled);
        self.app_event_tx.send(AppEvent::UpdateFeatureFlags {
            updates: vec![(Feature::Collab, enabled)],
        });
        self.request_redraw();
        true
    }

    pub(crate) fn cancel_pending_subagents_update(&mut self) {
        self.context_ledger.pending_subagents_enabled = None;
        self.request_redraw();
    }

    /// Nothing holds a submission behind a Manual Memory write in this build, so there is
    /// never blocked input to restore.
    pub(crate) fn restore_admission_blocked_input_to_composer(&mut self) -> bool {
        false
    }

    /// `/add <path>`: add a file or directory to the Context Ledger.
    pub(super) fn add_context_source_command(&mut self, args: &str) {
        if self.reject_manual_memory_writer_conflict() {
            return;
        }
        let cleaned = clean_dropped_path(args);
        match crate::legacy_core::elpis_context::add_continuity_sources(
            Some(elpis_memory_dir(&self.config).as_path()),
            self.config.cwd.as_path(),
            std::path::Path::new(&cleaned),
        ) {
            Ok(paths) if paths.len() == 1 => self.add_info_message(
                format!("Added {} to the Context Ledger.", paths[0].display()),
                Some(
                    "It is enabled for the next turn. Open the ledger with Tab to toggle it."
                        .to_string(),
                ),
            ),
            Ok(paths) => self.add_info_message(
                format!(
                    "Added {} files from {cleaned} to the Context Ledger.",
                    paths.len()
                ),
                Some(
                    "They are enabled for the next turn. Open the ledger with Tab to toggle them."
                        .to_string(),
                ),
            ),
            Err(error) => self.add_error_message(format!("Could not add context source: {error}")),
        }
        self.request_manual_memory_status_refresh();
    }

    /// A new thread starts with no staged admissions and no per-thread ledger state.
    pub(super) fn reset_context_ledger_for_thread_change(&mut self) {
        self.smart_prune = codex_app_server_protocol::ThreadSmartPruneSnapshot::default();
        self.smart_prune_synced = false;
        self.context_attribution = None;
        self.context_ledger.pending_smart_prune_enabled = None;
        self.context_ledger.projected_token_delta = 0;
        self.context_ledger.projection_baseline_turn_id = None;
        self.context_ledger.pending_context_admissions.clear();
        self.last_prune_saved_tokens = None;
    }
}

/// The bottom pane with the Context Ledger to its right.
///
/// The ledger's top row is the composer box's top row and it runs downward. It is never
/// trimmed: `desired_height` is the taller of the two, so the layout grows to hold it.
pub(super) struct BesideContextLedger<'a> {
    pub(super) chat_widget: &'a ChatWidget,
    pub(super) bottom_pane: crate::render::renderable::RenderableItem<'a>,
}

impl BesideContextLedger<'_> {
    fn split(&self, area: ratatui::layout::Rect) -> (ratatui::layout::Rect, u16) {
        let ledger_width = self.chat_widget.context_ledger_width(area.width);
        let pane = ratatui::layout::Rect::new(
            area.x,
            area.y,
            area.width.saturating_sub(ledger_width),
            area.height,
        );
        (pane, ledger_width)
    }
}

impl crate::render::renderable::Renderable for BesideContextLedger<'_> {
    fn render(&self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer) {
        let (pane, ledger_width) = self.split(area);
        self.bottom_pane.render(pane, buf);
        if let Some((ledger_height, ledger_lines)) = self
            .chat_widget
            .context_ledger_lines_with_height(ledger_width)
        {
            self.chat_widget.render_context_ledger_lines(
                ratatui::layout::Rect::new(
                    pane.right(),
                    area.y,
                    ledger_width,
                    ledger_height.min(area.height),
                ),
                buf,
                ledger_lines,
            );
        }
    }

    fn desired_height(&self, width: u16) -> u16 {
        let ledger_width = self.chat_widget.context_ledger_width(width);
        self.bottom_pane
            .desired_height(width.saturating_sub(ledger_width))
            .max(self.chat_widget.context_ledger_desired_height(ledger_width))
    }

    fn cursor_pos(&self, area: ratatui::layout::Rect) -> Option<(u16, u16)> {
        let (pane, ledger_width) = self.split(area);
        if ledger_width > 0 && self.chat_widget.context_ledger_has_focus() {
            return None;
        }
        self.bottom_pane.cursor_pos(pane)
    }

    fn cursor_style(&self, area: ratatui::layout::Rect) -> crossterm::cursor::SetCursorStyle {
        self.bottom_pane.cursor_style(self.split(area).0)
    }
}

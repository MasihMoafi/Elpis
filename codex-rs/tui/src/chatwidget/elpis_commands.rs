//! Elpis slash commands on top of the upstream `SlashCommand` enum.
//!
//! The variants live in the upstream enum (enum order is popup order), but everything Elpis
//! decides about them lives here: the descriptions, the dispatch flags and the dispatch itself.
//! Upstream files reach this module through one-line seams marked `Elpis:`.
//!
//! `/yolo`, `/agent`, `/add`, `/context`, `/memory-model`, `/prune`, `/smart-prune`,
//! `/pruner-model` and `/dashboard` work in this build (the pruning commands live in
//! `elpis_prune_commands.rs`). `/force-prune` needs the rest of the Elpis context engine: it is
//! listed with its v0.3.0 description and, when run, says plainly that it arrives in a later
//! Elpis build. It sends nothing to the model or the app server.
//!
//! `/memory-model` saves `background_model` / `background_provider`
//! (`crate::elpis_background_model`), which choose the model that names sessions.
//!
//! `/compact` stays upstream's command; Elpis adds its v0.3.0 arguments here. `/compact N` saves
//! the pressure-compaction threshold (core/src/pressure_compaction.rs) and `/compact <text>`
//! compacts now with the text as guidance for the summary. Bare `/compact` is unchanged.
//!
//! Bare `/usage` is v0.3.0's session card for every login, opened as an overlay Escape closes.
//! Upstream's account menu (analytics and usage-limit resets) moves to `/usage account`; the
//! `daily`, `weekly` and `cumulative` views are unchanged.

use ratatui::style::Stylize;

use super::ChatWidget;
use super::user_messages::QueueDrain;
use crate::app_event::AppEvent;
use crate::app_event::RateLimitRefreshOrigin;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::picker_hint_line_for_keymap;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_background_model::BackgroundModelChoice;
use crate::history_cell::HistoryCell;
use crate::history_cell::PlainHistoryCell;
use crate::history_cell::WebHyperlinkHistoryCell;
use crate::legacy_core::pressure_compaction::PressureCompaction;
use crate::slash_command::SlashCommand;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Wrap;

/// Or-pattern of every Elpis-owned `SlashCommand` variant, for the exhaustive upstream matches.
macro_rules! elpis_slash_commands {
    () => {
        $crate::slash_command::SlashCommand::PrunerModel
            | $crate::slash_command::SlashCommand::MemoryModel
            | $crate::slash_command::SlashCommand::Yolo
            | $crate::slash_command::SlashCommand::Prune
            | $crate::slash_command::SlashCommand::SmartPrune
            | $crate::slash_command::SlashCommand::ForcePrune
            | $crate::slash_command::SlashCommand::Agent
            | $crate::slash_command::SlashCommand::Dashboard
            | $crate::slash_command::SlashCommand::Add
            | $crate::slash_command::SlashCommand::Context
    };
}
pub(crate) use elpis_slash_commands;

/// The v0.3.0 popup descriptions.
pub(crate) fn description(cmd: SlashCommand) -> &'static str {
    match cmd {
        SlashCommand::PrunerModel => {
            "view or set the model that prunes context; follows /memory-model when unset: /pruner-model <id|default>"
        }
        SlashCommand::MemoryModel => {
            "set background tasks (pruning and session naming); memory uses the responding agent: /memory-model <id|provider:id|default>"
        }
        SlashCommand::Yolo => "save Full Access as the default for future chats",
        SlashCommand::Prune => "turn Smart Prune on for subsequent turns",
        SlashCommand::SmartPrune => "optimize fresh tool results before their first model request",
        SlashCommand::ForcePrune => {
            "force a prune down to a target of remaining context: /force-prune <1-100>"
        }
        SlashCommand::Agent => "switch the active agent thread",
        SlashCommand::Dashboard => {
            "show the current context window, admitted sources, and pruning evidence"
        }
        SlashCommand::Add => "add a file to the Context Ledger: /add <path>",
        SlashCommand::Context => {
            "show context usage as a grid, by category, with checkpoints and system files"
        }
        _ => unreachable!("not an Elpis slash command: /{}", cmd.command()),
    }
}

/// v0.3.0's `/compact` description.
pub(crate) const COMPACT_DESCRIPTION: &str =
    "compact now, or /compact N to set remaining-context pressure (0 < N < 70)";

/// v0.3.0's `/usage` description, plus the `account` view that keeps upstream's menu.
pub(crate) const USAGE_DESCRIPTION: &str =
    "inspect this session, or add account/daily/weekly/cumulative for account activity";

/// `/usage account`: upstream's account menu, which bare `/usage` no longer opens.
pub(super) const USAGE_ACCOUNT_ARG: &str = "account";

/// Whether `/compact` arguments are a pressure setting (one number, `%` allowed) rather than
/// guidance for a compaction. Copied from v0.3.0 `slash_dispatch.rs`.
pub(super) fn is_pressure_compaction_arg(value: &str) -> bool {
    let mut parts = value.split_whitespace();
    let Some(token) = parts.next() else {
        return false;
    };
    parts.next().is_none() && token.trim_end_matches('%').parse::<f64>().is_ok()
}

/// Upstream commands v0.3.0 kept out of the `/` popup. Typing them still works, so none
/// of them may be feature-gated upstream (gated ones go in [`hidden`]).
pub(crate) fn unlisted(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        // Commands Codex added after v0.3.0, kept typeable (Masih asked for v0.3.0's list).
        SlashCommand::Agents
            | SlashCommand::Cd
            | SlashCommand::Daemon
            | SlashCommand::Export
            | SlashCommand::Pwd
            | SlashCommand::Recap
            | SlashCommand::Tui
            | SlashCommand::Warnings
            // Commands v0.3.0 kept out of the popup.
            | SlashCommand::Archive
            | SlashCommand::AutoReview
            | SlashCommand::Btw
            | SlashCommand::DebugConfig
            | SlashCommand::Delete
            | SlashCommand::Import
            | SlashCommand::Logout
            | SlashCommand::Mention
            | SlashCommand::Ps
            | SlashCommand::Raw
            | SlashCommand::Review
            | SlashCommand::Side
            | SlashCommand::Statusline
            | SlashCommand::Stop
            | SlashCommand::Title
            | SlashCommand::Vim
    )
}

/// Upstream commands v0.3.0 had removed or never offered. They are neither listed nor typed.
pub(crate) fn hidden(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        SlashCommand::App
            | SlashCommand::Apps
            | SlashCommand::ElevateSandbox
            | SlashCommand::Exit
            | SlashCommand::Feedback
            | SlashCommand::Memories
            | SlashCommand::MemoryDrop
            | SlashCommand::MemoryUpdate
            | SlashCommand::Pets
            | SlashCommand::Plugins
            | SlashCommand::Rollout
            | SlashCommand::Status
            | SlashCommand::TestApproval
            // Codex's worktree chooser, added after v0.3.0 and feature-gated upstream.
            | SlashCommand::Worktree
    )
}

pub(crate) fn supports_inline_args(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        SlashCommand::PrunerModel
            | SlashCommand::MemoryModel
            | SlashCommand::SmartPrune
            | SlashCommand::ForcePrune
            | SlashCommand::Add
            | SlashCommand::Compact
    )
}

pub(crate) fn available_in_side_conversation(cmd: SlashCommand) -> bool {
    matches!(cmd, SlashCommand::Dashboard | SlashCommand::Context)
}

pub(crate) fn available_during_task(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        SlashCommand::PrunerModel
            | SlashCommand::MemoryModel
            | SlashCommand::Yolo
            | SlashCommand::Agent
            | SlashCommand::Dashboard
            | SlashCommand::Context
    )
}

/// Whether a command queued behind a turn lets the next queued input run after it.
///
/// `/yolo` waits for the permission change, `/prune` and `/smart-prune` for the Smart Prune
/// switch, and `/agent` opens a picker, as in v0.3.0. The commands that only print "not in
/// this build yet" let the queue continue.
pub(super) fn queued_drain(cmd: SlashCommand) -> QueueDrain {
    match cmd {
        SlashCommand::Yolo
        | SlashCommand::Agent
        | SlashCommand::Add
        | SlashCommand::Prune
        | SlashCommand::SmartPrune => QueueDrain::Stop,
        _ => QueueDrain::Continue,
    }
}

impl ChatWidget {
    /// `/compact <args>`, as in v0.3.0. One number saves the pressure-compaction threshold and
    /// compacts nothing now; any other text compacts now with the text as summary guidance.
    pub(super) fn dispatch_compact_with_args(&mut self, args: &str) {
        if !is_pressure_compaction_arg(args) {
            self.start_compaction(Some(args.to_string()));
            return;
        }
        let result = PressureCompaction::parse(args).and_then(|settings| {
            settings.save(self.config.codex_home.as_path())?;
            Ok(settings.remaining_percent.unwrap_or_default())
        });
        match result {
            Ok(percent) => self.add_info_message(
                format!(
                    "Pressure compaction saved: {percent}% remaining. Checked before each turn. /compact alone compacts now."
                ),
                /*hint*/ None,
            ),
            Err(error) => {
                self.add_error_message(format!("Compaction setting was not changed: {error}"))
            }
        }
    }

    /// Bare `/usage`: v0.3.0's session card — model, provider, directory, permissions, session
    /// id and token usage — for every login, as an overlay Escape closes. A ChatGPT login also
    /// refreshes its limits into the card, as `/status` does.
    pub(super) fn open_usage_card(&mut self) {
        let request_id = self.should_prefetch_rate_limits().then(|| {
            let request_id = self.next_status_refresh_request_id;
            self.next_status_refresh_request_id = request_id.wrapping_add(1);
            request_id
        });
        let mut card = self.status_output_cell(request_id.is_some(), request_id);
        // v0.3.0 headed the card with the command that opened it.
        if let Some(header) = card.parts.first_mut() {
            let usage: Box<dyn HistoryCell> =
                Box::new(PlainHistoryCell::new(vec!["/usage".magenta().into()]));
            *header = usage;
        }
        let evidence = self.local_evidence_lines();
        if !evidence.is_empty() {
            card.parts
                .push(Box::new(WebHyperlinkHistoryCell::new(evidence)));
        }
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::OpenUsage(Box::new(card))));
        if let Some(request_id) = request_id {
            self.app_event_tx.send(AppEvent::RefreshRateLimits {
                origin: RateLimitRefreshOrigin::StatusCommand { request_id },
            });
        }
    }

    /// Run an Elpis slash command, bare or with inline arguments.
    pub(super) fn dispatch_elpis_command(&mut self, cmd: SlashCommand) {
        match cmd {
            SlashCommand::Yolo => {
                self.app_event_tx
                    .send(AppEvent::Elpis(ElpisAppEvent::EnableYolo));
                self.defer_input_until_settings_applied();
            }
            SlashCommand::Agent => {
                self.app_event_tx.send(AppEvent::OpenAgentPicker);
            }
            SlashCommand::Add => {
                self.add_error_message(super::elpis_ledger_glue::ADD_CONTEXT_USAGE.to_string());
            }
            SlashCommand::Prune | SlashCommand::SmartPrune | SlashCommand::PrunerModel => {
                self.dispatch_prune_command(cmd)
            }
            SlashCommand::Context => self.request_fresh_context_usage_report(),
            SlashCommand::MemoryModel => self.open_background_model_popup(),
            SlashCommand::Dashboard => self.open_dashboard(),
            _ => {
                self.add_info_message(
                    format!(
                        "/{} is not in this Elpis build yet. It arrives in a later Elpis build.",
                        cmd.command()
                    ),
                    /*hint*/ None,
                );
            }
        }
    }

    /// `/memory-model <id|provider:id|default>`, as in v0.3.0.
    pub(super) fn dispatch_memory_model_with_args(&mut self, args: &str) {
        match BackgroundModelChoice::parse(args, &self.config) {
            Ok(choice) => self.save_background_model(choice),
            Err(error) => {
                self.add_error_message(format!("Background model was not changed: {error}"))
            }
        }
    }

    /// Bare `/memory-model`: the built-in default and this provider's models, as in v0.3.0.
    fn open_background_model_popup(&mut self) {
        let current = self.config.background_model.clone();
        // The catalog is the session provider's, so a listed model clears
        // `background_provider` and follows the session's provider.
        let mut choices = vec![(
            None,
            "Built-in default".to_string(),
            "Name sessions with the default model on the session's provider".to_string(),
        )];
        choices.extend(
            self.model_catalog()
                .try_list_models()
                .unwrap_or_default()
                .into_iter()
                .filter(|preset| preset.show_in_picker)
                .map(|preset| (Some(preset.model.clone()), preset.model, preset.description)),
        );
        let items = choices
            .into_iter()
            .map(|(model, name, description)| {
                let choice = BackgroundModelChoice {
                    model,
                    provider: Some(None),
                };
                SelectionItem {
                    name,
                    description: Some(description),
                    is_current: current == choice.model,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(
                            choice.clone(),
                        )));
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        self.show_selection_view(SelectionViewParams {
            header: Box::new(
                Paragraph::new(vec![
                    Line::from("Background model".bold()),
                    Line::from(
                        format!(
                            "Names sessions; memory uses the responding agent. Now: {}. Any other model: /memory-model <id|provider:id|default>",
                            crate::elpis_background_model::describe(&self.config)
                        )
                        .dim(),
                    ),
                ])
                .wrap(Wrap { trim: false }),
            ),
            footer_hint: Some(picker_hint_line_for_keymap(&self.bottom_pane.list_keymap())),
            items,
            ..SelectionViewParams::picker()
        });
        self.request_redraw();
    }

    fn save_background_model(&mut self, choice: BackgroundModelChoice) {
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(choice)));
    }

    /// Uses a saved `/memory-model` choice in this chat.
    pub(crate) fn apply_background_model(&mut self, choice: &BackgroundModelChoice) {
        choice.apply_to(&mut self.config);
    }
}

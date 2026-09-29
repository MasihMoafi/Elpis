//! Elpis slash commands on top of the upstream `SlashCommand` enum.
//!
//! The variants live in the upstream enum (enum order is popup order), but everything Elpis
//! decides about them lives here: the descriptions, the dispatch flags and the dispatch itself.
//! Upstream files reach this module through one-line seams marked `Elpis:`.
//!
//! `/yolo` and `/agent` work in this build. The commands that need the Elpis context engine
//! (`/pruner-model`, `/memory-model`, `/prune`, `/smart-prune`, `/force-prune`, `/dashboard`)
//! are listed with their v0.3.0 descriptions and, when run, say plainly that they arrive in a
//! later Elpis build. They send nothing to the model or the app server.

use super::ChatWidget;
use super::user_messages::QueueDrain;
use crate::app_event::AppEvent;
use crate::elpis_app_event::ElpisAppEvent;
use crate::slash_command::SlashCommand;

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
        _ => unreachable!("not an Elpis slash command: /{}", cmd.command()),
    }
}

pub(crate) fn supports_inline_args(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        SlashCommand::PrunerModel
            | SlashCommand::MemoryModel
            | SlashCommand::SmartPrune
            | SlashCommand::ForcePrune
    )
}

pub(crate) fn available_in_side_conversation(cmd: SlashCommand) -> bool {
    matches!(cmd, SlashCommand::Dashboard)
}

pub(crate) fn available_during_task(cmd: SlashCommand) -> bool {
    matches!(
        cmd,
        SlashCommand::PrunerModel
            | SlashCommand::MemoryModel
            | SlashCommand::Yolo
            | SlashCommand::Agent
            | SlashCommand::Dashboard
    )
}

/// Whether a command queued behind a turn lets the next queued input run after it.
///
/// `/yolo` waits for the permission change and `/agent` opens a picker, as in v0.3.0. The
/// commands that only print "not in this build yet" let the queue continue.
pub(super) fn queued_drain(cmd: SlashCommand) -> QueueDrain {
    match cmd {
        SlashCommand::Yolo | SlashCommand::Agent => QueueDrain::Stop,
        _ => QueueDrain::Continue,
    }
}

impl ChatWidget {
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
}

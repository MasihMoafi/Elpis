use strum::IntoEnumIterator;
use strum_macros::AsRefStr;
use strum_macros::EnumIter;
use strum_macros::EnumString;
use strum_macros::IntoStaticStr;

// Elpis: Elpis command metadata and dispatch live in chatwidget/elpis_commands.rs.
use crate::chatwidget::elpis_commands as elpis;

/// Commands that can be invoked by starting a message with a leading slash.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumString, EnumIter, AsRefStr, IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    // DO NOT ALPHA-SORT! Enum order is presentation order in the popup, so
    // more frequently used commands should be listed first.
    Model,
    Effort, // Elpis
    // Elpis: v0.3.0 commands, in their v0.3.0 popup positions.
    PrunerModel,
    MemoryModel,
    Daybreak,
    Ide,
    Permissions,
    Yolo, // Elpis
    #[strum(to_string = "hotkeys", serialize = "keymap")] // Elpis: v0.3.0 name
    Keymap,
    Vim,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    #[strum(to_string = "settings", serialize = "experimental")] // Elpis: v0.3.0 name
    Experimental,
    #[strum(to_string = "approve")]
    AutoReview,
    Add, // Elpis: Context Ledger
    Memories,
    Skills,
    Import,
    Hooks,
    Review,
    Rename,
    New,
    Archive,
    #[strum(to_string = "del", serialize = "delete")] // Elpis: v0.3.0 name
    Delete,
    Resume,
    Fork,
    Worktree,
    App,
    Init,
    Compact,
    // Elpis: v0.3.0 pruning commands.
    Prune,
    SmartPrune,
    ForcePrune,
    Recap,
    Plan,
    Voice,
    Goal,
    Agent, // Elpis: v0.3.0 /agent
    Agents,
    Side,
    Btw,
    Copy,
    Export,
    Raw,
    Tui,
    Diff,
    Mention,
    Status,
    Daemon,
    Warnings,
    Cd,
    #[strum(to_string = "pwd", serialize = "cwd")]
    Pwd,
    Usage,
    Context,   // Elpis: Context Ledger
    Dashboard, // Elpis
    DebugConfig,
    Title,
    Statusline,
    Theme,
    #[strum(to_string = "pets", serialize = "pet")]
    Pets,
    Mcp,
    Apps,
    Plugins,
    Logout,
    Quit,
    Exit,
    Feedback,
    Rollout,
    Ps,
    #[strum(to_string = "kill", serialize = "stop", serialize = "clean")] // Elpis: v0.3.0 name
    Stop,
    Clear,
    TestApproval,
    #[strum(serialize = "subagents")]
    MultiAgents,
    // Debugging commands.
    #[strum(serialize = "debug-m-drop")]
    MemoryDrop,
    #[strum(serialize = "debug-m-update")]
    MemoryUpdate,
}

impl SlashCommand {
    /// User-visible description shown in the popup.
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::Feedback => "send logs to maintainers",
            SlashCommand::New => "start a new chat during a conversation",
            SlashCommand::Init => "create an AGENTS.md file with instructions for Elpis",
            // Elpis: v0.3.0's description, which names `/compact N`.
            SlashCommand::Compact => elpis::COMPACT_DESCRIPTION,
            SlashCommand::Recap => "summarize the current conversation now",
            SlashCommand::Review => "review my current changes and find issues",
            SlashCommand::Rename => "rename the current thread",
            SlashCommand::Resume => "resume a saved chat",
            SlashCommand::Archive => "archive this session",
            SlashCommand::Delete => "permanently delete this session",
            SlashCommand::Clear => "clear the terminal and start a new chat",
            SlashCommand::Fork => "fork the current chat",
            SlashCommand::Worktree => "start or continue a conversation in a new worktree",
            SlashCommand::App => "continue this session in the Desktop app",
            SlashCommand::Quit | SlashCommand::Exit => "exit Elpis",
            SlashCommand::Copy => "copy the last response or part of it",
            SlashCommand::Export => "export the conversation as markdown",
            SlashCommand::Raw => "toggle raw scrollback mode for copy-friendly terminal selection",
            SlashCommand::Tui => "choose the TUI mode for the next launch",
            SlashCommand::Diff => "show git diff (including untracked files)",
            SlashCommand::Mention => "mention a file",
            SlashCommand::Skills => "use skills to improve how Elpis performs specific tasks",
            SlashCommand::Import => "import setup, this project, and recent chats from Claude Code",
            SlashCommand::Hooks => "view and manage lifecycle hooks",
            SlashCommand::Daemon => "Manage the local background server",
            SlashCommand::Warnings => "view retained warnings and diagnostic details",
            SlashCommand::Status => "show current session configuration and token usage",
            SlashCommand::Cd => "change the current working directory",
            SlashCommand::Pwd => "show the current working directory",
            // Elpis: bare `/usage` is v0.3.0's session card.
            SlashCommand::Usage => elpis::USAGE_DESCRIPTION,
            SlashCommand::DebugConfig => "show config layers and requirement sources for debugging",
            SlashCommand::Title => "configure which items appear in the terminal title",
            SlashCommand::Statusline => "configure which items appear in the status line",
            SlashCommand::Theme => "choose a syntax highlighting theme",
            SlashCommand::Pets => "choose or hide the terminal pet",
            SlashCommand::Ps => "list background terminals",
            SlashCommand::Stop => "stop all background terminals",
            SlashCommand::MemoryDrop => "DO NOT USE",
            SlashCommand::MemoryUpdate => "DO NOT USE",
            SlashCommand::Model => "choose what model and reasoning effort to use",
            SlashCommand::Daybreak => "turn Daybreak on or off",
            SlashCommand::Ide => {
                "include current selection, open files, and other context from your IDE"
            }
            SlashCommand::Plan => "toggle Plan mode",
            SlashCommand::Voice => "start or stop voice; use /voice settings to choose a voice",
            SlashCommand::Goal => "set or view the goal for a long-running task",
            SlashCommand::Agents => "open the task list to resume, rename or delete chats",
            SlashCommand::MultiAgents => "switch between this session's subagents",
            SlashCommand::Side | SlashCommand::Btw => {
                "start a side conversation in an ephemeral fork"
            }
            SlashCommand::Permissions => "choose what Elpis is allowed to do",
            SlashCommand::Keymap => "remap TUI shortcuts",
            SlashCommand::Vim => "toggle Vim mode for the composer",
            SlashCommand::ElevateSandbox => "set up elevated agent sandbox",
            SlashCommand::Experimental => "toggle experimental features",
            SlashCommand::AutoReview => "approve one retry of a recent auto-review denial",
            SlashCommand::Memories => "configure memory use and generation",
            SlashCommand::Mcp => "list MCP tools; use /mcp verbose or /mcp login <name>",
            SlashCommand::Apps => "manage apps",
            SlashCommand::Plugins => "browse plugins",
            SlashCommand::Logout => "log out of Elpis",
            SlashCommand::Rollout => "print the rollout file path",
            SlashCommand::TestApproval => "test approval request",
            // Elpis: descriptions from v0.3.0.
            elpis::elpis_slash_commands!() => elpis::description(self),
        }
    }

    /// Command string without the leading '/'. Provided for compatibility with
    /// existing code that expects a method named `command()`.
    pub fn command(self) -> &'static str {
        self.into()
    }

    /// Whether this command supports inline args (for example `/review ...`).
    pub fn supports_inline_args(self) -> bool {
        // Elpis: Elpis commands decide their own inline args.
        if elpis::supports_inline_args(self) {
            return true;
        }
        matches!(
            self,
            SlashCommand::Review
                | SlashCommand::Rename
                | SlashCommand::New
                | SlashCommand::Clear
                | SlashCommand::Fork
                | SlashCommand::Plan
                | SlashCommand::Goal
                | SlashCommand::Voice
                | SlashCommand::Ide
                | SlashCommand::Keymap
                | SlashCommand::Mcp
                | SlashCommand::Export
                | SlashCommand::Raw
                | SlashCommand::Cd
                | SlashCommand::Pwd
                | SlashCommand::Usage
                | SlashCommand::Pets
                | SlashCommand::Side
                | SlashCommand::Btw
                | SlashCommand::Resume
        )
    }

    /// Whether this command remains available inside an active side conversation.
    pub fn available_in_side_conversation(self) -> bool {
        // Elpis: Elpis commands decide their own side-conversation availability.
        if elpis::available_in_side_conversation(self) {
            return true;
        }
        matches!(
            self,
            SlashCommand::Copy
                | SlashCommand::Agents
                | SlashCommand::Export
                | SlashCommand::Raw
                | SlashCommand::Diff
                | SlashCommand::Mention
                | SlashCommand::Status
                | SlashCommand::Daemon
                | SlashCommand::Warnings
                | SlashCommand::Pwd
                | SlashCommand::Usage
                | SlashCommand::Ide
        )
    }

    /// Whether dispatch needs thread state to validate this command before consuming its draft.
    /// The composer must defer busy-state rejection and draft clearing for these commands.
    pub(crate) fn requires_dispatch_validation(self) -> bool {
        matches!(self, SlashCommand::Review)
    }

    /// Commands that do not require a writable current thread. The server must still be connected.
    pub(crate) fn available_when_thread_unavailable(self) -> bool {
        matches!(
            self,
            SlashCommand::New
                | SlashCommand::Clear
                | SlashCommand::Resume
                | SlashCommand::Agents
                | SlashCommand::MultiAgents
                | SlashCommand::Quit
                | SlashCommand::Exit
                | SlashCommand::Status
                // Elpis: /status is folded into /usage (R8), so /usage works here too.
                | SlashCommand::Usage
                | SlashCommand::Warnings
                | SlashCommand::DebugConfig
                | SlashCommand::Pwd
                | SlashCommand::Rollout
                | SlashCommand::Copy
                | SlashCommand::Raw
        )
    }

    /// Whether this command can be run while a task is in progress.
    pub fn available_during_task(self) -> bool {
        match self {
            SlashCommand::New
            | SlashCommand::Delete
            | SlashCommand::Fork
            | SlashCommand::Worktree
            | SlashCommand::Init
            | SlashCommand::Compact
            | SlashCommand::Recap
            | SlashCommand::Export
            | SlashCommand::Keymap
            | SlashCommand::Tui
            | SlashCommand::Vim
            | SlashCommand::ElevateSandbox
            | SlashCommand::Experimental
            | SlashCommand::Memories
            | SlashCommand::Import
            | SlashCommand::Review
            | SlashCommand::Plan
            | SlashCommand::Cd
            | SlashCommand::Clear
            | SlashCommand::Logout
            | SlashCommand::MemoryDrop
            | SlashCommand::MemoryUpdate => false,
            SlashCommand::Diff
            | SlashCommand::Archive
            | SlashCommand::Resume
            | SlashCommand::Model
            | SlashCommand::Daybreak
            | SlashCommand::Permissions
            | SlashCommand::Copy
            | SlashCommand::Raw
            | SlashCommand::Rename
            | SlashCommand::Mention
            | SlashCommand::Skills
            | SlashCommand::Hooks
            | SlashCommand::Status
            | SlashCommand::Daemon
            | SlashCommand::Warnings
            | SlashCommand::Pwd
            | SlashCommand::Usage
            | SlashCommand::DebugConfig
            | SlashCommand::Ps
            | SlashCommand::Stop
            | SlashCommand::App
            | SlashCommand::Goal
            | SlashCommand::Voice
            | SlashCommand::Mcp
            | SlashCommand::Apps
            | SlashCommand::Plugins
            | SlashCommand::Title
            | SlashCommand::Statusline
            | SlashCommand::AutoReview
            | SlashCommand::Feedback
            | SlashCommand::Ide
            | SlashCommand::Quit
            | SlashCommand::Exit
            | SlashCommand::Side
            | SlashCommand::Btw => true,
            SlashCommand::Rollout => true,
            SlashCommand::TestApproval => true,
            SlashCommand::Agents | SlashCommand::MultiAgents => true,
            SlashCommand::Theme | SlashCommand::Pets => false,
            // Elpis: Elpis commands decide their own availability during a task.
            elpis::elpis_slash_commands!() => elpis::available_during_task(self),
        }
    }

    fn is_visible(self) -> bool {
        // Elpis: upstream commands Elpis removed stay hidden.
        if elpis::hidden(self) || elpis::unlisted(self) {
            return false;
        }
        match self {
            SlashCommand::Copy => !cfg!(target_os = "android"),
            SlashCommand::App => cfg!(any(target_os = "macos", target_os = "windows")),
            SlashCommand::Voice => true,
            SlashCommand::Rollout | SlashCommand::TestApproval => cfg!(debug_assertions),
            _ => true,
        }
    }
}

/// Return all built-in commands in a Vec paired with their command string.
pub fn built_in_slash_commands() -> Vec<(&'static str, SlashCommand)> {
    SlashCommand::iter()
        .filter(|command| command.is_visible())
        .map(|c| (c.command(), c))
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use std::str::FromStr;

    use super::SlashCommand;

    #[test]
    fn kill_command_is_canonical_name() {
        assert_eq!(SlashCommand::Stop.command(), "kill");
    }

    #[test]
    fn clean_alias_parses_to_stop_command() {
        assert_eq!(SlashCommand::from_str("clean"), Ok(SlashCommand::Stop));
    }

    #[test]
    fn certain_commands_are_available_during_task() {
        assert!(SlashCommand::Goal.available_during_task());
        assert!(SlashCommand::Ide.available_during_task());
        assert!(SlashCommand::Title.available_during_task());
        assert!(SlashCommand::Statusline.available_during_task());
        assert!(SlashCommand::Raw.available_during_task());
        assert!(SlashCommand::Raw.available_in_side_conversation());
        assert!(SlashCommand::Raw.supports_inline_args());
        assert!(SlashCommand::App.available_during_task());
    }

    #[test]
    fn auto_review_command_is_approve() {
        assert_eq!(SlashCommand::AutoReview.command(), "approve");
        assert_eq!(
            SlashCommand::from_str("approve"),
            Ok(SlashCommand::AutoReview)
        );
    }
}

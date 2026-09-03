// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use strum::IntoEnumIterator;
use strum_macros::AsRefStr;
use strum_macros::EnumIter;
use strum_macros::EnumString;
use strum_macros::IntoStaticStr;

/// Commands that can be invoked by starting a message with a leading slash.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, EnumString, EnumIter, AsRefStr, IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    // DO NOT ALPHA-SORT! Enum order is presentation order in the popup, so
    // more frequently used commands should be listed first.
    Model,
    Permissions,
    #[strum(serialize = "hotkeys", serialize = "keymap")]
    Keymap,
    Vim,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    #[strum(serialize = "sandbox-add-read-dir")]
    SandboxReadRoot,
    #[strum(to_string = "settings")]
    Experimental,
    #[strum(to_string = "approve")]
    AutoReview,
    Add,
    Skills,
    Import,
    Hooks,
    Review,
    Rename,
    New,
    Archive,
    #[strum(to_string = "del")]
    Delete,
    Resume,
    Fork,
    App,
    Init,
    Compact,
    SmartPrune,
    #[strum(to_string = "force-prune")]
    ForcePrune,
    Plan,
    Goal,
    Agent,
    Side,
    Btw,
    Copy,
    Raw,
    Diff,
    Mention,
    Usage,
    Context,
    Dashboard,
    DebugConfig,
    Title,
    Statusline,
    Theme,
    Mcp,
    Apps,
    Plugins,
    Logout,
    Quit,
    Ps,
    #[strum(to_string = "kill")]
    Stop,
    Clear,
    Personality,
    #[strum(serialize = "subagents")]
    MultiAgents,
}

impl SlashCommand {
    /// User-visible description shown in the popup.
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::New => "start a new chat during a conversation",
            SlashCommand::Init => "create an AGENTS.md file with instructions for Elpis",
            SlashCommand::Compact => "summarize conversation to prevent hitting the context limit",
            SlashCommand::Review => "review my current changes and find issues",
            SlashCommand::Rename => "rename the current thread",
            SlashCommand::Resume => "resume a saved chat",
            SlashCommand::Archive => "archive this session and exit",
            SlashCommand::Delete => "permanently delete this session and quit",
            SlashCommand::Clear => "clear the terminal and start a new chat",
            SlashCommand::Fork => "fork the current chat",
            SlashCommand::App => "continue this session in Codex Desktop",
            SlashCommand::Quit => "quit Elpis",
            SlashCommand::Copy => "copy last prompt and response as markdown",
            SlashCommand::Raw => "toggle raw scrollback mode for copy-friendly terminal selection",
            SlashCommand::Diff => "show git diff (including untracked files)",
            SlashCommand::Mention => "mention a file",
            SlashCommand::Skills => "use skills to improve how Elpis performs specific tasks",
            SlashCommand::Import => "import setup, this project, and recent chats from Claude Code",
            SlashCommand::Hooks => "view and manage lifecycle hooks",
            SlashCommand::Usage => "inspect current context, continuity, and token usage",
            SlashCommand::SmartPrune => {
                "optimize fresh tool results before their first model request"
            }
            SlashCommand::ForcePrune => {
                "force a prune down to a target of remaining context: /force-prune <1-100>"
            }
            SlashCommand::Context => {
                "show context usage as a grid, by category, with checkpoints and system files"
            }
            SlashCommand::Dashboard => {
                "show the current context window, admitted sources, and pruning evidence"
            }
            SlashCommand::DebugConfig => "show config layers and requirement sources for debugging",
            SlashCommand::Title => "configure which items appear in the terminal title",
            SlashCommand::Statusline => "configure which items appear in the status line",
            SlashCommand::Theme => "choose a syntax highlighting theme",
            SlashCommand::Ps => "list background terminals",
            SlashCommand::Stop => "kill all background terminals",
            SlashCommand::Model => "choose a provider-aware model and reasoning effort",
            SlashCommand::Personality => "choose a communication style for Elpis",
            SlashCommand::Plan => "switch to Plan mode",
            SlashCommand::Goal => "set or view the goal for a long-running task",
            SlashCommand::Agent | SlashCommand::MultiAgents => "switch the active agent thread",
            SlashCommand::Side | SlashCommand::Btw => {
                "start a side conversation in an ephemeral fork"
            }
            SlashCommand::Permissions => "choose what Elpis is allowed to do",
            SlashCommand::Keymap => "view or change TUI hotkeys",
            SlashCommand::Vim => "toggle Vim mode for the composer",
            SlashCommand::ElevateSandbox => "set up elevated agent sandbox",
            SlashCommand::SandboxReadRoot => {
                "let sandbox read a directory: /sandbox-add-read-dir <absolute_path>"
            }
            SlashCommand::Experimental => "configure Elpis settings",
            SlashCommand::AutoReview => "approve one retry of a recent auto-review denial",
            SlashCommand::Add => "add a file to the Context Ledger: /add <path>",
            SlashCommand::Mcp => "list configured MCP tools; use /mcp verbose for details",
            SlashCommand::Apps => "manage apps",
            SlashCommand::Plugins => "browse plugins",
            SlashCommand::Logout => "log out",
        }
    }

    /// Command string without the leading '/'. Provided for compatibility with
    /// existing code that expects a method named `command()`.
    pub fn command(self) -> &'static str {
        self.into()
    }

    /// Whether this command supports inline args (for example `/review ...`).
    pub fn supports_inline_args(self) -> bool {
        matches!(
            self,
            SlashCommand::SmartPrune
                | SlashCommand::ForcePrune
                | SlashCommand::Review
                | SlashCommand::Add
                | SlashCommand::Rename
                | SlashCommand::Plan
                | SlashCommand::Goal
                | SlashCommand::Keymap
                | SlashCommand::Mcp
                | SlashCommand::Raw
                | SlashCommand::Side
                | SlashCommand::Btw
                | SlashCommand::Resume
                | SlashCommand::SandboxReadRoot
        )
    }

    /// Whether this command remains available inside an active side conversation.
    pub fn available_in_side_conversation(self) -> bool {
        matches!(
            self,
            SlashCommand::Copy
                | SlashCommand::Raw
                | SlashCommand::Diff
                | SlashCommand::Mention
                | SlashCommand::Usage
                | SlashCommand::Context
                | SlashCommand::Dashboard
        )
    }

    /// Whether this command can be run while a task is in progress.
    pub fn available_during_task(self) -> bool {
        match self {
            SlashCommand::New
            | SlashCommand::Archive
            | SlashCommand::Delete
            | SlashCommand::Fork
            | SlashCommand::Init
            | SlashCommand::Compact
            | SlashCommand::SmartPrune
            | SlashCommand::ForcePrune
            | SlashCommand::Keymap
            | SlashCommand::Vim
            | SlashCommand::ElevateSandbox
            | SlashCommand::SandboxReadRoot
            | SlashCommand::Experimental
            | SlashCommand::Add
            | SlashCommand::Import
            | SlashCommand::Review
            | SlashCommand::Plan
            | SlashCommand::Clear
            | SlashCommand::Logout => false,
            SlashCommand::Diff
            | SlashCommand::Resume
            | SlashCommand::Model
            | SlashCommand::Personality
            | SlashCommand::Permissions
            | SlashCommand::Copy
            | SlashCommand::Raw
            | SlashCommand::Rename
            | SlashCommand::Mention
            | SlashCommand::Skills
            | SlashCommand::Hooks
            | SlashCommand::Usage
            | SlashCommand::Context
            | SlashCommand::Dashboard
            | SlashCommand::DebugConfig
            | SlashCommand::Ps
            | SlashCommand::Stop
            | SlashCommand::App
            | SlashCommand::Goal
            | SlashCommand::Mcp
            | SlashCommand::Apps
            | SlashCommand::Plugins
            | SlashCommand::Title
            | SlashCommand::Statusline
            | SlashCommand::AutoReview
            | SlashCommand::Quit
            | SlashCommand::Side
            | SlashCommand::Btw => true,
            SlashCommand::Agent | SlashCommand::MultiAgents => true,
            SlashCommand::Theme => false,
        }
    }

    fn is_visible(self) -> bool {
        match self {
            // Elpis owns the continuity, context, memory, permissions, and runtime
            // surfaces below. The remaining inherited commands are intentionally not
            // part of the public Elpis command contract.
            SlashCommand::Model
            | SlashCommand::Permissions
            | SlashCommand::Add
            | SlashCommand::Skills
            | SlashCommand::Hooks
            | SlashCommand::New
            | SlashCommand::Resume
            | SlashCommand::Init
            | SlashCommand::Compact
            | SlashCommand::SmartPrune
            | SlashCommand::ForcePrune
            | SlashCommand::Diff
            | SlashCommand::Usage
            | SlashCommand::Context
            | SlashCommand::Dashboard
            | SlashCommand::Mcp
            | SlashCommand::Quit
            | SlashCommand::Keymap
            | SlashCommand::Theme
            | SlashCommand::Fork
            | SlashCommand::Goal
            | SlashCommand::Rename
            | SlashCommand::Copy
            | SlashCommand::Experimental
            // Inherited Codex features being re-evaluated for the Elpis contract:
            // multi-agent threads (I6 /multi-task) and Plan mode (evaluated
            // against I5 structured interactive clarification).
            | SlashCommand::Agent
            | SlashCommand::MultiAgents
            | SlashCommand::Plan
            | SlashCommand::Clear => true,
            SlashCommand::Review
            | SlashCommand::Delete
            | SlashCommand::Side
            | SlashCommand::Btw
            | SlashCommand::Logout
            | SlashCommand::ElevateSandbox
            | SlashCommand::SandboxReadRoot
            | SlashCommand::AutoReview
            | SlashCommand::Import
            | SlashCommand::Archive
            | SlashCommand::App
            | SlashCommand::Mention
            | SlashCommand::Raw
            | SlashCommand::DebugConfig
            | SlashCommand::Title
            | SlashCommand::Statusline
            | SlashCommand::Apps
            | SlashCommand::Plugins
            | SlashCommand::Ps
            | SlashCommand::Stop
            | SlashCommand::Personality
            | SlashCommand::Vim => false,
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
    fn removed_stop_names_do_not_parse() {
        assert!(SlashCommand::from_str("stop").is_err());
        assert!(SlashCommand::from_str("clean").is_err());
    }

    #[test]
    fn codex_only_ide_command_is_not_available() {
        assert!(SlashCommand::from_str("ide").is_err());
        assert!(
            !super::built_in_slash_commands()
                .into_iter()
                .any(|(name, _)| name == "ide")
        );
    }

    #[test]
    fn retrospective_prune_command_is_not_available() {
        assert!(SlashCommand::from_str("prune").is_err());
        assert_eq!(SlashCommand::from_str("compact"), Ok(SlashCommand::Compact));
        assert_eq!(
            SlashCommand::from_str("smart-prune"),
            Ok(SlashCommand::SmartPrune)
        );
        assert_eq!(
            SlashCommand::from_str("force-prune"),
            Ok(SlashCommand::ForcePrune)
        );
        assert!(
            !super::built_in_slash_commands()
                .into_iter()
                .any(|(name, _)| name == "prune")
        );
    }

    #[test]
    fn renamed_commands_use_elpis_names() {
        assert_eq!(SlashCommand::Keymap.command(), "hotkeys");
        assert_eq!(SlashCommand::Delete.command(), "del");
        assert_eq!(SlashCommand::Experimental.command(), "settings");
        assert_eq!(SlashCommand::from_str("keymap"), Ok(SlashCommand::Keymap));
        assert_eq!(SlashCommand::from_str("hotkeys"), Ok(SlashCommand::Keymap));
        assert!(SlashCommand::from_str("delete").is_err());
        assert!(SlashCommand::from_str("experimental").is_err());
    }

    #[test]
    fn removed_commands_are_not_visible_or_parseable() {
        let visible = super::built_in_slash_commands()
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>();
        for removed in [
            "archive",
            "btw",
            "del",
            "debug-m-drop",
            "debug-m-update",
            "exit",
            "feedback",
            "apps",
            "app",
            "debug-config",
            "experimental",
            "import",
            "mention",
            "personality",
            "plugins",
            "raw",
            "review",
            "status",
            "statusline",
            "title",
            "vim",
        ] {
            assert!(!visible.contains(&removed), "{removed} should be removed");
        }
        assert!(visible.contains(&"add"));
        assert!(visible.contains(&"usage"));
        assert!(visible.contains(&"settings"));
        assert!(visible.contains(&"fork"));
        assert!(visible.contains(&"goal"));
        assert!(visible.contains(&"hooks"));
        assert!(visible.contains(&"copy"));
        // Unhidden 2026-07-25 for evaluation against the multi-agent backlog (I6).
        assert!(visible.contains(&"agent"));
        assert!(visible.contains(&"subagents"));
        // Unhidden 2026-07-26 so Masih can evaluate inherited Plan mode before any I5
        // structured-clarification work starts. Re-hide here if I5 supersedes it.
        assert!(visible.contains(&"plan"));
        // The terminal pets feature was deleted outright, not hidden.
        assert!(SlashCommand::from_str("pets").is_err());
        assert!(SlashCommand::from_str("debug-m-drop").is_err());
        assert!(SlashCommand::from_str("debug-m-update").is_err());
    }

    #[test]
    fn certain_commands_are_available_during_task() {
        assert!(SlashCommand::Goal.available_during_task());
        assert!(SlashCommand::Title.available_during_task());
        assert!(SlashCommand::Statusline.available_during_task());
        assert!(SlashCommand::App.available_during_task());
    }

    #[test]
    fn dashboard_is_a_visible_read_only_context_command() {
        assert_eq!(
            SlashCommand::from_str("dashboard"),
            Ok(SlashCommand::Dashboard)
        );
        assert_eq!(SlashCommand::Dashboard.command(), "dashboard");
        assert!(SlashCommand::Dashboard.available_in_side_conversation());
        assert!(SlashCommand::Dashboard.available_during_task());
        assert!(
            super::built_in_slash_commands()
                .into_iter()
                .any(|(name, command)| name == "dashboard" && command == SlashCommand::Dashboard)
        );
        assert!(SlashCommand::Dashboard.description().contains("context"));
    }

    #[test]
    fn smart_prune_is_visible_argument_aware_and_idle_only() {
        assert_eq!(
            SlashCommand::from_str("smart-prune"),
            Ok(SlashCommand::SmartPrune)
        );
        assert!(SlashCommand::SmartPrune.supports_inline_args());
        assert!(!SlashCommand::SmartPrune.available_during_task());
        assert!(
            super::built_in_slash_commands()
                .into_iter()
                .any(|(name, command)| name == "smart-prune"
                    && command == SlashCommand::SmartPrune)
        );
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

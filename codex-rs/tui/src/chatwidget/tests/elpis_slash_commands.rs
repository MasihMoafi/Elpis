//! Evals for the Elpis slash commands: `/yolo`, `/agent` and `/memory-model` work, and the
//! commands that need the Elpis context engine say plainly that they arrive in a later build.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::bottom_pane::slash_commands::BuiltinCommandFlags;
use crate::bottom_pane::slash_commands::find_builtin_command;
use crate::elpis_app_event::ElpisAppEvent;
use crate::slash_command::built_in_slash_commands;
use pretty_assertions::assert_eq;
use std::str::FromStr;

const NOT_IN_THIS_BUILD: &str =
    "is not in this Elpis build yet. It arrives in a later Elpis build.";

/// The commands that wait for the rest of the Elpis context engine. `/prune`, `/smart-prune`
/// and `/pruner-model` work (tests/elpis_smart_prune.rs); `/memory-model` saves the
/// background model; `/dashboard` works (elpis_dashboard.rs).
const LATER_BUILD: [SlashCommand; 1] = [SlashCommand::ForcePrune];

fn history_text(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> Vec<String> {
    drain_insert_history(rx)
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect()
}

#[test]
fn elpis_commands_are_listed_in_their_v030_order_with_v030_descriptions() {
    let listed = built_in_slash_commands()
        .into_iter()
        .map(|(name, cmd)| (name, cmd.description()))
        .collect::<Vec<_>>();
    let expected = [
        ("model", None),
        (
            "effort",
            Some("change how hard the model thinks: /effort [low|medium|high|…]"),
        ),
        (
            "pruner-model",
            Some(
                "view or set the model that prunes context; follows /memory-model when unset: /pruner-model <id|default>",
            ),
        ),
        (
            "memory-model",
            Some(
                "set background tasks (pruning and session naming); memory uses the responding agent: /memory-model <id|provider:id|default>",
            ),
        ),
        ("permissions", None),
        (
            "yolo",
            Some("save Full Access as the default for future chats"),
        ),
        ("add", Some("add a file to the Context Ledger: /add <path>")),
        (
            "compact",
            Some("compact now, or /compact N to set remaining-context pressure (0 < N < 70)"),
        ),
        ("prune", Some("turn Smart Prune on for subsequent turns")),
        (
            "smart-prune",
            Some("optimize fresh tool results before their first model request"),
        ),
        (
            "force-prune",
            Some("force a prune down to a target of remaining context: /force-prune <1-100>"),
        ),
        ("agent", Some("switch the active agent thread")),
        (
            "usage",
            Some(
                "inspect this session, or add account/daily/weekly/cumulative for account activity",
            ),
        ),
        (
            "context",
            Some("show context usage as a grid, by category, with checkpoints and system files"),
        ),
        (
            "dashboard",
            Some("show the current context window, admitted sources, and pruning evidence"),
        ),
    ];
    let mut last_index = 0;
    for (name, description) in expected {
        let index = listed
            .iter()
            .position(|(listed_name, _)| *listed_name == name)
            .unwrap_or_else(|| panic!("/{name} is missing from the popup"));
        assert!(index >= last_index, "/{name} is out of v0.3.0 order");
        last_index = index;
        if let Some(description) = description {
            assert_eq!(listed[index].1, description, "/{name}");
        }
    }
}

#[test]
fn hand_selected_slash_command_set_is_unchanged() {
    let mut expected = vec![
        "model", "effort", "pruner-model", "memory-model", "ide", "permissions", "yolo",
        "hotkeys", "settings", "add", "skills", "hooks", "rename", "new", "resume", "fork",
        "init", "compact", "prune", "smart-prune", "force-prune", "plan", "voice", "goal",
        "agent", "copy", "diff", "usage", "context", "dashboard", "theme", "mcp", "quit",
        "clear", "subagents",
    ];
    if cfg!(target_os = "android") {
        expected.retain(|name| *name != "copy");
    }
    assert_eq!(
        built_in_slash_commands().into_iter().map(|(name, _)| name).collect::<Vec<_>>(),
        expected,
        "Changing Masih's selected command set requires his explicit agreement",
    );
}

#[test]
fn typed_elpis_names_reach_elpis_commands_and_upstream_names_stay_upstream() {
    let flags = BuiltinCommandFlags::default();
    for (name, cmd) in [
        ("yolo", SlashCommand::Yolo),
        ("effort", SlashCommand::Effort),
        ("agent", SlashCommand::Agent),
        ("pruner-model", SlashCommand::PrunerModel),
        ("memory-model", SlashCommand::MemoryModel),
        ("prune", SlashCommand::Prune),
        ("smart-prune", SlashCommand::SmartPrune),
        ("force-prune", SlashCommand::ForcePrune),
        ("dashboard", SlashCommand::Dashboard),
        ("add", SlashCommand::Add),
        ("context", SlashCommand::Context),
    ] {
        assert_eq!(SlashCommand::from_str(name), Ok(cmd));
        assert_eq!(find_builtin_command(name, flags), Some(cmd), "/{name}");
    }
    // Negative: the upstream commands that share a prefix keep their own names.
    assert_eq!(
        find_builtin_command("agents", flags),
        Some(SlashCommand::Agents)
    );
    assert_eq!(
        find_builtin_command("subagents", flags),
        Some(SlashCommand::MultiAgents)
    );
    assert_eq!(
        find_builtin_command("model", flags),
        Some(SlashCommand::Model)
    );
}

#[tokio::test]
async fn yolo_asks_the_app_for_full_access_without_a_model_request() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::Yolo);

    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::Elpis(ElpisAppEvent::EnableYolo))
    );
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn yolo_is_not_a_later_build_stub() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::Yolo);

    let history = history_text(&mut rx);
    assert!(
        history.iter().all(|cell| !cell.contains(NOT_IN_THIS_BUILD)),
        "{history:?}"
    );
}

#[tokio::test]
async fn agent_opens_the_agent_thread_picker_as_in_v030() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::Agent);

    assert_matches!(rx.try_recv(), Ok(AppEvent::OpenAgentPicker));
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn later_build_commands_say_so_and_do_nothing_else() {
    for cmd in LATER_BUILD {
        for args in ["", "gpt-5 40"] {
            let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;
            chat.thread_id = Some(ThreadId::new());

            if args.is_empty() {
                chat.dispatch_command(cmd);
            } else {
                chat.dispatch_command_with_args(cmd, args.to_string(), Vec::new());
            }

            let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
            let cells = events
                .iter()
                .filter_map(|event| match event {
                    AppEvent::InsertHistoryCell(cell) => {
                        Some(lines_to_single_string(&cell.display_lines(/*width*/ 200)))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                cells,
                vec![format!("• /{} {NOT_IN_THIS_BUILD}\n", cmd.command())],
                "/{} {args}",
                cmd.command()
            );
            assert!(
                events
                    .iter()
                    .all(|event| matches!(event, AppEvent::InsertHistoryCell(_))),
                "/{} {args} sent more than a message: {events:?}",
                cmd.command()
            );
            assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
        }
    }
}

#[tokio::test]
async fn queued_elpis_command_with_args_is_not_sent_to_the_model() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());

    let drain = chat.submit_queued_slash_prompt(UserMessage::from("/memory-model gpt-x").into());

    assert_matches!(drain, QueueDrain::Continue);
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(choice))
                if choice.model.as_deref() == Some("gpt-x") && choice.provider.is_none()
        )),
        "{events:?}"
    );
    assert!(
        std::iter::from_fn(|| ops.try_recv().ok()).all(|op| !matches!(op, Op::UserTurn { .. })),
        "a queued /memory-model must not reach the model"
    );
}

/// Positive: `/memory-model default` asks the App to clear the model and its provider.
/// Negative: an empty choice never reaches the App.
#[tokio::test]
async fn memory_model_saves_the_typed_choice() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command_with_args(SlashCommand::MemoryModel, "default".to_string(), Vec::new());

    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(choice))
                if choice.model.is_none() && choice.provider == Some(None)
        )),
        "{events:?}"
    );
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));

    chat.dispatch_memory_model_with_args("   ");
    let events = std::iter::from_fn(|| rx.try_recv().ok()).collect::<Vec<_>>();
    assert!(
        events.iter().all(|event| !matches!(
            event,
            AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(_))
        )),
        "{events:?}"
    );
}

/// Bare `/memory-model` opens the picker instead of the later-build notice.
#[tokio::test]
async fn bare_memory_model_opens_the_background_model_picker() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::MemoryModel);

    let history = history_text(&mut rx);
    assert!(
        history.iter().all(|cell| !cell.contains(NOT_IN_THIS_BUILD)),
        "{history:?}"
    );
    assert!(chat.has_active_modal(), "no picker opened");
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn queued_plain_text_is_sent_to_the_model() {
    // Negative control for the eval above: the harness does see a model request.
    let (mut chat, _rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());

    chat.submit_queued_slash_prompt(UserMessage::from("memory-model gpt-x").into());

    assert_matches!(next_submit_op(&mut ops), Op::UserTurn { .. });
}

#[tokio::test]
async fn during_a_turn_yolo_runs_and_pruning_waits() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    handle_turn_started(&mut chat, "turn-1");
    while rx.try_recv().is_ok() {}

    chat.dispatch_command(SlashCommand::Yolo);
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::Elpis(ElpisAppEvent::EnableYolo))
    );

    // Native Codex rejects commands that cannot run during a turn.
    chat.dispatch_command(SlashCommand::Prune);
    assert!(history_text(&mut rx).join("\n").contains("disabled while a task is in progress"));
    assert!(chat.queued_user_message_texts().is_empty());
}

#[test]
fn commands_v030_removed_stay_hidden_and_other_unlisted_commands_leave_the_popup() {
    let flags = BuiltinCommandFlags::default();
    let listed = built_in_slash_commands()
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    for name in [
        "app",
        "apps",
        "plugins",
        "setup-default-sandbox",
        "exit",
        "feedback",
        "memories",
        "memory-drop",
        "memory-update",
        "pets",
        "rollout",
        "status",
        "test-approval",
    ] {
        assert!(!listed.contains(&name), "/{name} is listed");
        assert_eq!(find_builtin_command(name, flags), None, "/{name} resolves");
    }
    // Commands Codex added since July are out of the popup but still typeable.
    for (name, cmd) in [
        ("export", SlashCommand::Export),
        ("recap", SlashCommand::Recap),
        ("pwd", SlashCommand::Pwd),
    ] {
        assert!(!listed.contains(&name), "/{name} is listed");
        assert_eq!(find_builtin_command(name, flags), Some(cmd), "/{name}");
    }
    // Negative: v0.3.0's own commands are listed.
    for name in ["model", "compact", "context", "dashboard"] {
        assert!(listed.contains(&name), "/{name} is missing");
    }
}

#[test]
fn commands_v030_kept_out_of_the_popup_still_work_under_their_v030_names() {
    let flags = BuiltinCommandFlags::default();
    let listed = built_in_slash_commands()
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    for (name, cmd) in [
        ("approve", SlashCommand::AutoReview),
        ("btw", SlashCommand::Btw),
        ("debug-config", SlashCommand::DebugConfig),
        ("import", SlashCommand::Import),
        ("kill", SlashCommand::Stop),
        ("logout", SlashCommand::Logout),
        ("mention", SlashCommand::Mention),
        ("ps", SlashCommand::Ps),
        ("raw", SlashCommand::Raw),
        ("review", SlashCommand::Review),
        ("side", SlashCommand::Side),
        ("statusline", SlashCommand::Statusline),
        ("title", SlashCommand::Title),
        ("vim", SlashCommand::Vim),
    ] {
        assert!(!listed.contains(&name), "/{name} is listed");
        assert_eq!(find_builtin_command(name, flags), Some(cmd), "/{name}");
    }
    // v0.3.0's names are listed; upstream's old names still resolve.
    for (name, alias, cmd) in [
        ("hotkeys", "keymap", SlashCommand::Keymap),
        ("settings", "experimental", SlashCommand::Experimental),
    ] {
        assert!(listed.contains(&name), "/{name} is missing");
        assert!(!listed.contains(&alias), "/{alias} is listed");
        assert_eq!(find_builtin_command(alias, flags), Some(cmd), "/{alias}");
    }
    assert_eq!(
        find_builtin_command("stop", flags),
        Some(SlashCommand::Stop)
    );
    assert_eq!(
        find_builtin_command("delete", flags),
        Some(SlashCommand::Delete)
    );
}

#[test]
fn selected_chat_commands_stay_listed_and_removed_commands_stay_unlisted() {
    let flags = BuiltinCommandFlags::default();
    let listed = built_in_slash_commands();
    for (name, command) in [
        ("rename", SlashCommand::Rename),
        ("new", SlashCommand::New),
        ("resume", SlashCommand::Resume),
    ] {
        assert!(listed.contains(&(name, command)), "/{name} is missing");
    }
    for (name, command) in [
        ("agents", SlashCommand::Agents),
        ("archive", SlashCommand::Archive),
        ("del", SlashCommand::Delete),
    ] {
        assert!(!listed.contains(&(name, command)), "/{name} was restored to the popup");
        assert_eq!(find_builtin_command(name, flags), Some(command));
    }
    assert_eq!(find_builtin_command("daybreak", flags), None);
}

fn usage_card(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> Option<String> {
    std::iter::from_fn(|| rx.try_recv().ok()).find_map(|event| match event {
        AppEvent::Elpis(ElpisAppEvent::OpenUsage(card)) => {
            Some(lines_to_single_string(&card.display_lines(/*width*/ 120)))
        }
        _ => None,
    })
}

#[tokio::test]
async fn usage_opens_the_session_card_for_any_login() {
    for chatgpt in [false, true] {
        let (mut chat, mut rx, mut ops) = make_chatwidget_manual(/*model_override*/ None).await;
        chat.thread_id = Some(ThreadId::new());
        if chatgpt {
            set_chatgpt_auth(&mut chat);
        }

        chat.dispatch_command(SlashCommand::Usage);

        let card = usage_card(&mut rx)
            .unwrap_or_else(|| panic!("/usage opened no card (ChatGPT login: {chatgpt})"));
        for row in [
            "/usage",
            "Model:",
            "Model provider:",
            "Directory:",
            "Permissions:",
            "Session:",
            "Token usage:",
        ] {
            assert!(
                card.contains(row),
                "missing {row} (ChatGPT login: {chatgpt}):\n{card}"
            );
        }
        assert!(!card.contains("/status"), "{card}");
        assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
    }
}

#[tokio::test]
async fn usage_account_is_upstreams_menu_and_bare_usage_is_not() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);

    // Negative: bare `/usage` opens the card, not the account menu.
    chat.dispatch_command(SlashCommand::Usage);
    assert!(usage_card(&mut rx).is_some());
    assert!(chat.bottom_pane.no_modal_or_popup_active());

    chat.dispatch_command_with_args(SlashCommand::Usage, "account".to_string(), Vec::new());
    assert!(!chat.bottom_pane.no_modal_or_popup_active());
    assert!(usage_card(&mut rx).is_none());
}

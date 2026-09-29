//! Evals for the Elpis slash commands: `/yolo` and `/agent` work, and the commands that need
//! the Elpis context engine say plainly that they arrive in a later build.
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

/// The commands that wait for the Elpis context engine.
const LATER_BUILD: [SlashCommand; 6] = [
    SlashCommand::PrunerModel,
    SlashCommand::MemoryModel,
    SlashCommand::Prune,
    SlashCommand::SmartPrune,
    SlashCommand::ForcePrune,
    SlashCommand::Dashboard,
];

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
        ("compact", None),
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
        ("agents", None),
        ("usage", None),
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
fn typed_elpis_names_reach_elpis_commands_and_upstream_names_stay_upstream() {
    let flags = BuiltinCommandFlags::default();
    for (name, cmd) in [
        ("yolo", SlashCommand::Yolo),
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
    let history = history_text(&mut rx);
    assert!(
        history
            .iter()
            .any(|cell| cell.contains(&format!("/memory-model {NOT_IN_THIS_BUILD}"))),
        "{history:?}"
    );
    assert!(
        std::iter::from_fn(|| ops.try_recv().ok()).all(|op| !matches!(op, Op::UserTurn { .. })),
        "a queued /memory-model must not reach the model"
    );
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

    chat.dispatch_command(SlashCommand::Prune);
    let history = history_text(&mut rx);
    assert_eq!(
        history,
        vec!["■ '/prune' is disabled while a task is in progress.\n".to_string()]
    );
}

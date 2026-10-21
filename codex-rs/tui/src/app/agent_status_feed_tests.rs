use super::*;
use codex_app_server_protocol::CommandExecutionSource;
use codex_app_server_protocol::CommandExecutionStatus;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_utils_absolute_path::AbsolutePathBuf;

#[test]
fn ledger_read_attempt_evidence_names_tool_and_outcome() {
    for (status, success, output, outcome, exit_code) in [
        ("completed", true, "Rules", "ok", Some(0)),
        ("failed", false, "not found", "failed: not found", Some(1)),
        ("failed", false, "not found", "failed: not found", None),
    ] {
        let dynamic = serde_json::from_value(serde_json::json!({
            "type": "dynamicToolCall", "id": "read-agents", "namespace": null,
            "tool": "read_file", "arguments": {"path": "AGENTS.md"},
            "status": status, "success": success,
            "contentItems": [{"type": "inputText", "text": output}], "durationMs": null,
        }))
        .expect("read item");
        let bridged = serde_json::from_value(serde_json::json!({
            "type": "commandExecution", "id": "read-agents", "command": "Read AGENTS.md",
            "cwd": "/workspace", "source": "agent", "status": status,
            "commandActions": [{"type": "read", "command": "Read AGENTS.md", "name": "AGENTS.md", "path": "/workspace/AGENTS.md"}],
            "aggregatedOutput": output, "exitCode": exit_code,
        })).expect("bridged Read item");
        for (item, tool) in [(dynamic, "read_file"), (bridged, "Read")] {
            let mut store = ThreadEventStore::new(8);
            store.push_notification(ServerNotification::ItemCompleted(
                ItemCompletedNotification {
                    item,
                    thread_id: "child".to_string(),
                    turn_id: "turn".to_string(),
                    completed_at_ms: 1,
                },
            ));
            let preview = AgentStatusThreadPreview::from_store("child".to_string(), &store);
            assert_eq!(
                preview.latest_activity(),
                Some(format!("Read AGENTS.md · {tool} · {outcome}"))
            );
        }
    }
}

#[test]
fn agent_status_uses_bounded_buffered_activity() {
    let mut store = ThreadEventStore::new(/*capacity*/ 8);
    store.push_notification(ServerNotification::ItemCompleted(
        ItemCompletedNotification {
            item: ThreadItem::CommandExecution {
                model_context: None,
                sandbox_type: None,
                id: "command-1".to_string(),
                command: "cargo test -p codex-tui".to_string(),
                cwd: AbsolutePathBuf::try_from("/workspace")
                    .expect("absolute path")
                    .into(),
                process_id: None,
                plugin_id: None,
                script_path: None,
                source: CommandExecutionSource::Agent,
                status: CommandExecutionStatus::Completed,
                command_actions: Vec::new(),
                aggregated_output: Some("unbounded output\n".repeat(10_000)),
                exit_code: Some(0),
                duration_ms: Some(42),
            },
            thread_id: "thread-child".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 1,
        },
    ));
    store.push_notification(ServerNotification::ItemCompleted(
        ItemCompletedNotification {
            item: ThreadItem::AgentMessage {
                id: "message-1".to_string(),
                text: "Finished checking the focused TUI tests.".to_string(),
                phase: None,
                memory_citation: None,
                delivery: None,
                questions: None,
            },
            thread_id: "thread-child".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 2,
        },
    ));

    let preview = AgentStatusThreadPreview::from_store("/root/reviewer".to_string(), &store);
    let cell = AgentStatusHistoryCell::new(vec![preview]);
    let rendered = cell
        .display_lines(/*width*/ 80)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");

    insta::assert_snapshot!(rendered, @r###"
    /subagents
    Sub-agents running

      • `/root/reviewer`
        $ cargo test -p codex-tui
        Finished checking the focused TUI tests.
    "###);
    assert!(!rendered.contains("unbounded output"));
}

#[test]
fn agent_status_uses_reasoning_summaries_only() {
    let mut store = ThreadEventStore::new(/*capacity*/ 8);
    store.push_notification(ServerNotification::ItemCompleted(
        ItemCompletedNotification {
            item: ThreadItem::Reasoning {
                id: "reasoning-with-summary".to_string(),
                summary: vec!["safe summary".to_string()],
                content: vec!["hidden raw reasoning".to_string()],
            },
            thread_id: "thread-child".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 1,
        },
    ));
    store.push_notification(ServerNotification::ItemCompleted(
        ItemCompletedNotification {
            item: ThreadItem::Reasoning {
                id: "reasoning-without-summary".to_string(),
                summary: Vec::new(),
                content: vec!["raw-only reasoning".to_string()],
            },
            thread_id: "thread-child".to_string(),
            turn_id: "turn-1".to_string(),
            completed_at_ms: 2,
        },
    ));

    let preview = AgentStatusThreadPreview::from_store("/root/reviewer".to_string(), &store);
    let cell = AgentStatusHistoryCell::new(vec![preview]);
    let rendered = cell
        .display_lines(/*width*/ 80)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");

    insta::assert_snapshot!(rendered, @r###"
    /subagents
    Sub-agents running

      • `/root/reviewer`
        safe summary
    "###);
    assert!(!rendered.contains("hidden raw reasoning"));
    assert!(!rendered.contains("raw-only reasoning"));
}

// Elpis: the Ledger's subagent list shows the newest activity, and nothing for a quiet agent.
#[test]
fn latest_activity_is_the_newest_summary_and_none_when_quiet() {
    let mut store = ThreadEventStore::new(/*capacity*/ 8);
    assert_eq!(
        AgentStatusThreadPreview::from_store(String::new(), &store).latest_activity(),
        None
    );
    for (id, text) in [
        ("message-1", "first finding"),
        ("message-2", "second finding"),
    ] {
        store.push_notification(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item: ThreadItem::AgentMessage {
                    id: id.to_string(),
                    text: text.to_string(),
                    phase: None,
                    memory_citation: None,
                    delivery: None,
                    questions: None,
                },
                thread_id: "thread-child".to_string(),
                turn_id: "turn-1".to_string(),
                completed_at_ms: 1,
            },
        ));
    }
    let latest = AgentStatusThreadPreview::from_store(String::new(), &store)
        .latest_activity()
        .expect("activity");
    assert!(latest.contains("second finding"), "{latest}");
}

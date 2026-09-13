use super::*;
use codex_app_server_protocol::SubAgentActivityKind;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn canonical_subagent_activity_reaches_history_and_navigation() {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let primary = ThreadId::new();
    let child = ThreadId::new();
    app.primary_thread_id = Some(primary);
    app.active_thread_id = Some(primary);
    for (index, kind, expected, running) in [
        (0, SubAgentActivityKind::Started, "Started", true),
        (1, SubAgentActivityKind::Interacted, "Interacted with", true),
        (2, SubAgentActivityKind::Interrupted, "Interrupted", false),
    ] {
        app.handle_thread_event_now(ThreadBufferedEvent::Notification(
            ServerNotification::ItemCompleted(
                codex_app_server_protocol::ItemCompletedNotification {
                    thread_id: primary.to_string(),
                    turn_id: "parent-turn".to_string(),
                    completed_at_ms: index,
                    item: codex_app_server_protocol::ThreadItem::SubAgentActivity {
                        id: format!("activity-{index}"),
                        kind,
                        agent_thread_id: child.to_string(),
                        agent_path: "/root/reviewer".to_string(),
                    },
                },
            ),
        ));
        let cells: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                AppEvent::InsertHistoryCell(cell) => Some(cell),
                _ => None,
            })
            .collect();
        assert_eq!(cells.len(), 1, "one visible entry per activity");
        let text = lines_to_single_string(&cells[0].display_lines(100));
        assert!(text.contains(expected), "{text}");
        assert!(text.contains("/root/reviewer"), "{text}");
        assert_eq!(
            app.agent_navigation.get(&child).unwrap().is_running,
            running
        );
        assert_eq!(
            app.agent_navigation
                .active_agent_label(Some(primary), Some(primary)),
            Some("Main · 1 subagent · /agent".to_string()),
        );
    }
}

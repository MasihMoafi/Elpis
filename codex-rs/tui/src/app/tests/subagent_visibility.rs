use super::*;
use codex_app_server_protocol::SubAgentActivityKind;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn subagent_ledger_uses_live_completion_without_opening_agent_picker() {
    let (mut app, _events, _ops) = make_test_app_with_channels().await;
    let primary = ThreadId::new();
    let child = ThreadId::new();
    app.primary_thread_id = Some(primary);
    app.active_thread_id = Some(primary);
    app.agent_navigation
        .record_sub_agent_activity(SubAgentActivityDisplay {
            thread_id: child,
            agent_path: "/root/x".into(),
            is_running_hint: Some(true),
        });
    let channel = ThreadEventChannel::new(8);
    let store = Arc::clone(&channel.store);
    app.thread_event_channels.insert(child, channel);
    let render = |app: &App| {
        let area = Rect::new(0, 0, 140, 40);
        let mut buf = ratatui::buffer::Buffer::empty(area);
        crate::render::renderable::Renderable::render(&app.chat_widget, area, &mut buf);
        buf.content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
    };
    app.sync_active_agent_label();
    assert!(
        render(&app).contains("Running · /root/x"),
        "initial empty feed must preserve spawn hint"
    );
    store
        .lock()
        .await
        .push_notification(turn_started_notification(child, "work"));
    app.sync_active_agent_label();
    assert!(render(&app).contains("Running · /root/x"));
    store
        .lock()
        .await
        .push_notification(turn_completed_notification(
            child,
            "work",
            TurnStatus::Completed,
        ));
    app.sync_active_agent_label();
    assert!(render(&app).contains("Idle · /root/x"));
    store
        .lock()
        .await
        .push_notification(turn_started_notification(child, "more"));
    app.sync_active_agent_label();
    assert!(render(&app).contains("Running · /root/x"));
}

#[tokio::test]
async fn replayed_subagents_restore_navigation_without_claiming_they_are_running() {
    let (mut app, _events, _ops) = make_test_app_with_channels().await;
    let primary = ThreadId::new();
    let child = ThreadId::new();
    app.primary_thread_id = Some(primary);
    app.active_thread_id = Some(primary);
    app.agent_navigation
        .upsert(primary, None, None, /*is_closed*/ false);
    let item = codex_app_server_protocol::ThreadItem::SubAgentActivity {
        id: "past-start".to_string(),
        kind: SubAgentActivityKind::Started,
        agent_thread_id: child.to_string(),
        agent_path: "/root/reviewer".to_string(),
    };
    assert!(app.agent_navigation.get(&child).is_none());
    app.remember_replayed_subagents([&item]);
    let entry = app.agent_navigation.get(&child).unwrap();
    assert_eq!(entry.agent_path.as_deref(), Some("/root/reviewer"));
    assert!(!entry.is_running);
    assert_eq!(
        app.agent_navigation
            .active_agent_label(Some(primary), Some(primary)),
        Some("Main [default]".to_string())
    );
    app.agent_navigation.set_running(child, true);
    app.handle_thread_event_replay(ThreadBufferedEvent::Notification(
        ServerNotification::ItemCompleted(codex_app_server_protocol::ItemCompletedNotification {
            thread_id: primary.to_string(),
            turn_id: "past-turn".to_string(),
            completed_at_ms: 0,
            item,
        }),
    ));
    assert!(app.agent_navigation.get(&child).unwrap().is_running);
}

#[tokio::test]
async fn canonical_subagent_activity_reaches_history_and_navigation() {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let primary = ThreadId::new();
    let child = ThreadId::new();
    app.primary_thread_id = Some(primary);
    app.active_thread_id = Some(primary);
    app.agent_navigation
        .upsert(primary, None, None, /*is_closed*/ false);
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
            Some("Main [default]".to_string()),
        );
    }
}

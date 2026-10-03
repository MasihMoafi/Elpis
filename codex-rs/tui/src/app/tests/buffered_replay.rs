//! Real buffered notifications must use finalized rendering without losing live stream tails.

use super::*;
use crate::chatwidget::tests::helpers::normalize_snapshot_paths;
use crate::chatwidget::tests::helpers::render_bottom_popup;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::ItemStartedNotification;
use codex_app_server_protocol::ReasoningSummaryTextDeltaNotification;
use pretty_assertions::assert_eq;

fn delta(thread: &str, turn: &str, item: &str) -> ServerNotification {
    ServerNotification::AgentMessageDelta(AgentMessageDeltaNotification {
        thread_id: thread.into(),
        turn_id: turn.into(),
        item_id: item.into(),
        delta: "Partial **answer**\n".into(),
    })
}

fn completed(thread: &str) -> ServerNotification {
    ServerNotification::ItemCompleted(ItemCompletedNotification {
        thread_id: thread.into(),
        turn_id: "turn".into(),
        completed_at_ms: 0,
        item: ThreadItem::AgentMessage {
            id: "answer".into(),
            text: "Final **answer**".into(),
            phase: None,
            memory_citation: None,
            delivery: None,
            questions: None,
        },
    })
}

#[tokio::test]
async fn refreshed_active_reasoning_accepts_later_deltas_and_complete_summary() {
    for (refresh, refreshed_item_is_partial, capacity, voice_handoff) in [
        (true, false, 1, false),
        (true, true, 1, false),
        (false, false, 8, false),
        (false, false, 1, false),
        (true, false, 1, true),
    ] {
        let (mut app, mut events, _ops) = make_test_app_with_channels().await;
        let thread_id = ThreadId::new();
        let session = test_thread_session(thread_id, app.config.cwd.to_path_buf());
        let mut turn = test_turn("reasoning-turn", TurnStatus::InProgress, Vec::new());
        let channel =
            ThreadEventChannel::new_with_session(capacity, session.clone(), vec![turn.clone()]);
        {
            let mut store = channel.store.lock().await;
            store.push_notification(ServerNotification::ItemStarted(ItemStartedNotification {
                thread_id: thread_id.to_string(),
                turn_id: turn.id.clone(),
                item: ThreadItem::Reasoning {
                    id: "reasoning".into(),
                    summary: Vec::new(),
                    content: Vec::new(),
                },
                started_at_ms: 0,
            }));
            store.push_notification(ServerNotification::ReasoningSummaryTextDelta(
                ReasoningSummaryTextDeltaNotification {
                    thread_id: thread_id.to_string(),
                    turn_id: turn.id.clone(),
                    item_id: "reasoning".into(),
                    delta: "**First heading**\nOriginal analysis paragraph".into(),
                    summary_index: 0,
                },
            ));
            assert_eq!(store.buffer.len(), capacity.min(/*other*/ 2));
            if voice_handoff {
                store.push_notification(ServerNotification::ItemStarted(ItemStartedNotification {
                    thread_id: thread_id.to_string(),
                    turn_id: turn.id.clone(),
                    item: ThreadItem::UserMessage {
                        id: "voice-handoff".into(),
                        client_id: None,
                        content: vec![AppServerUserInput::Text {
                            text: "<realtime_delegation><input>spoken follow-up</input></realtime_delegation>".into(),
                            text_elements: Vec::new(),
                        }],
                    },
                    started_at_ms: 0,
                }));
            }
        }
        let mut snapshot = channel.store.lock().await.snapshot();
        app.thread_event_channels.insert(thread_id, channel);
        if refreshed_item_is_partial {
            turn.items.push(ThreadItem::Reasoning {
                id: "reasoning".into(),
                summary: vec!["**First heading**\nOriginal analysis paragraph".into()],
                content: Vec::new(),
            });
        }
        if refresh {
            app.apply_refreshed_snapshot_thread(
                thread_id,
                AppServerStartedThread {
                    session,
                    turns: vec![turn],
                    blocks_direct_input: false,
                    task_tools_available: false,
                },
                &mut snapshot,
            )
            .await;
            assert!(snapshot.events.is_empty());
        }
        assert!(snapshot.active_reasoning_item.is_some());
        app.replay_thread_snapshot(snapshot, /*resume_restored_queue*/ false);
        app.chat_widget.handle_server_notification(
            ServerNotification::ReasoningSummaryTextDelta(ReasoningSummaryTextDeltaNotification {
                thread_id: thread_id.to_string(),
                turn_id: "reasoning-turn".into(),
                item_id: "reasoning".into(),
                delta: "\n**Running checks**\nFinal paragraph".into(),
                summary_index: 0,
            }),
            /*replay_kind*/ None,
        );
        assert!(render_bottom_popup(&app.chat_widget, /*width*/ 80).contains("Final paragraph"));
        let completed = ServerNotification::ItemCompleted(ItemCompletedNotification {
                thread_id: thread_id.to_string(),
                turn_id: "reasoning-turn".into(),
                item: ThreadItem::Reasoning {
                    id: "reasoning".into(),
                    summary: vec![
                        "**First heading**\nOriginal analysis paragraph\n**Running checks**\nFinal paragraph"
                            .into(),
                    ],
                    content: Vec::new(),
                },
                completed_at_ms: 0,
            });
        let store = &app.thread_event_channels[&thread_id].store;
        store.lock().await.push_notification_ref(&completed);
        assert!(
            store
                .lock()
                .await
                .snapshot()
                .active_reasoning_item
                .is_none()
        );
        app.chat_widget
            .handle_server_notification(completed, /*replay_kind*/ None);
        app.chat_widget.handle_server_notification(
            ServerNotification::ReasoningSummaryTextDelta(ReasoningSummaryTextDeltaNotification {
                thread_id: thread_id.to_string(),
                turn_id: "reasoning-turn".into(),
                item_id: "reasoning".into(),
                delta: "\n**Stale heading**".into(),
                summary_index: 0,
            }),
            /*replay_kind*/ None,
        );
        assert!(!render_bottom_popup(&app.chat_widget, /*width*/ 80).contains("Stale heading"));
        let transcript = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                AppEvent::InsertHistoryCell(cell)
                    if cell
                        .as_any()
                        .is::<crate::history_cell::ReasoningSummaryCell>() =>
                {
                    Some(lines_to_single_string(&cell.transcript_lines(/*width*/ 80)))
                }
                _ => None,
            })
            .collect::<String>();
        insta::allow_duplicates! {
            insta::assert_snapshot!(transcript, @"
            • Original analysis paragraph
              Running checks
              Final paragraph
            ");
        }
    }
}

#[test]
fn buffered_replay_keeps_unfinished_and_unrelated_deltas_in_order() {
    let completion = completed("thread");
    let unfinished = delta("thread", "turn", "unfinished");
    let other_turn = delta("thread", "other-turn", "answer");
    let other_thread = delta("other-thread", "turn", "answer");
    let later_delta = delta("thread", "turn", "answer");
    let mut store = ThreadEventStore::new(/*capacity*/ 16);
    for event in [
        delta("thread", "turn", "answer"),
        unfinished.clone(),
        other_turn.clone(),
        other_thread.clone(),
        completion.clone(),
        later_delta.clone(),
    ] {
        store.push_notification(event);
    }
    let mut events = store.snapshot().events;
    replay_filter::omit_completed_agent_deltas(&mut events);
    let actual = events
        .into_iter()
        .map(|event| match event {
            ThreadBufferedEvent::Notification(notification) => *notification,
            other => panic!("unexpected event: {other:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(vec![
            unfinished,
            other_turn,
            other_thread,
            completion,
            later_delta
        ])
        .unwrap()
    );
    assert_eq!(store.snapshot().events.len(), 6);
}

#[tokio::test]
async fn buffered_replay_renders_completed_text_without_streaming_again() {
    let (mut app, mut events, _ops) = make_test_app_with_channels().await;
    let mut store = ThreadEventStore::new(/*capacity*/ 16);
    store.push_notification(delta("thread", "turn", "answer"));
    store.push_notification(completed("thread"));
    app.replay_thread_snapshot(store.snapshot(), /*resume_restored_queue*/ false);
    let mut lines = Vec::new();
    while let Ok(event) = events.try_recv() {
        match event {
            AppEvent::InsertHistoryCell(cell) => lines.extend(cell.display_lines(/*width*/ 80)),
            AppEvent::StartCommitAnimation | AppEvent::ConsolidateAgentMessage { .. } => {
                panic!("completed replay must not reconstruct a stream")
            }
            _ => {}
        }
    }
    let text = lines
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!(text.trim(), @"
    • Final answer
    ");
}

#[test]
fn buffered_replay_preserves_text_before_interactive_requests() {
    let mut store = ThreadEventStore::new(/*capacity*/ 16);
    store.push_notification(delta("thread", "turn", "answer"));
    store.push_request(
        codex_app_server_protocol::ServerRequest::ToolRequestUserInput {
            request_id: codex_app_server_protocol::RequestId::Integer(1),
            params: codex_app_server_protocol::ToolRequestUserInputParams {
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                item_id: "tool".into(),
                questions: Vec::new(),
                is_blocking: true,
                auto_resolution_ms: None,
            },
        },
    );
    store.push_notification(completed("thread"));
    let mut events = store.snapshot().events;
    let before = format!("{events:?}");
    replay_filter::omit_completed_agent_deltas(&mut events);
    assert_eq!(format!("{events:?}"), before);
}

#[tokio::test]
async fn misalignment_buffered_replay_preserves_input_after_continuation() {
    let (mut app, mut history, _) = make_test_app_with_channels().await;
    let thread_id = ThreadId::new();
    app.chat_widget
        .set_queue_autosend_suppressed(/*suppressed*/ true);
    app.chat_widget.insert_str("keep queued");
    app.chat_widget
        .handle_key_event(KeyEvent::from(KeyCode::Enter));
    app.chat_widget
        .restore_user_message_to_composer("keep draft".into());
    let saved_input = app.chat_widget.capture_thread_input_state();
    let error = AppServerTurnError {
        misalignment: None,
        message: "Chat stopped".into(),
        codex_error_info: Some(AppServerCodexErrorInfo::MisalignmentPolicyViolation),
        additional_details: None,
    };
    let failed_turn = Turn {
        error: Some(error.clone()),
        items: vec![ThreadItem::McpToolCall {
            id: "tool-call".into(),
            server: "sample".into(),
            tool: "inspect".into(),
            status: codex_app_server_protocol::McpToolCallStatus::InProgress,
            arguments: serde_json::json!({}),
            app_context: None,
            mcp_app_resource_uri: None,
            mcp_app_ui: None,
            plugin_id: None,
            read_only_hint: None,
            result: None,
            error: None,
            duration_ms: None,
        }],
        ..test_turn("failed-turn", TurnStatus::Failed, Vec::new())
    };
    let continued_turn = test_turn("continued-turn", TurnStatus::Completed, Vec::new());
    // Primary resume also replays stored turns without going through the snapshot filter.
    app.chat_widget
        .set_queue_autosend_suppressed(/*suppressed*/ true);
    app.chat_widget.replay_thread_turns(
        vec![failed_turn.clone(), continued_turn.clone()],
        ReplayKind::ResumeInitialMessages,
    );
    let rendered = std::iter::from_fn(|| history.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::InsertHistoryCell(cell) => {
                Some(lines_to_single_string(&cell.display_lines(/*width*/ 80)))
            }
            _ => None,
        })
        .collect::<String>();
    insta::assert_snapshot!("misalignment_replayed_failed_tool", rendered);
    assert!(!app.chat_widget.has_misalignment_policy_violation());
    insta::assert_snapshot!(
        "misalignment_replayed_input",
        normalize_snapshot_paths(render_bottom_popup(&app.chat_widget, /*width*/ 80))
    );
    assert_eq!(app.chat_widget.composer_text_with_pending(), "keep draft");
    assert_eq!(
        app.chat_widget.queued_user_message_texts(),
        vec!["keep queued".to_string()]
    );
    let events = [
        turn_started_notification(thread_id, "failed-turn"),
        ServerNotification::Error(codex_app_server_protocol::ErrorNotification {
            thread_id: thread_id.to_string(),
            turn_id: "failed-turn".to_string(),
            error,
            will_retry: false,
        }),
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: thread_id.to_string(),
            turn: failed_turn.clone(),
        }),
        turn_started_notification(thread_id, "continued-turn"),
        ServerNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: thread_id.to_string(),
            turn: continued_turn,
        }),
    ];
    // Retain the whole stream, only the new turn's delta, or only a post-completion notice.
    for (capacity, event_count) in [(16, 5), (1, 4), (1, 5)] {
        let mut store = ThreadEventStore::new_with_session(
            capacity,
            test_thread_session(thread_id, app.config.cwd.to_path_buf()),
            vec![failed_turn.clone()],
        );
        store.input_state = saved_input.clone();
        for event in &events[..event_count] {
            store.push_notification_ref(event);
        }
        if capacity == 1 {
            store.push_notification(if event_count == 4 {
                delta(&thread_id.to_string(), "continued-turn", "answer")
            } else {
                ServerNotification::Warning(WarningNotification {
                    message: "An unrelated notice".into(),
                    thread_id: Some(thread_id.to_string()),
                })
            });
            assert_eq!(store.buffer.len(), 1);
        }
        app.replay_thread_snapshot(store.snapshot(), /*resume_restored_queue*/ false);
        assert!(!app.chat_widget.has_misalignment_policy_violation());
        assert_eq!(app.chat_widget.composer_text_with_pending(), "keep draft");
        assert_eq!(
            app.chat_widget.queued_user_message_texts(),
            vec!["keep queued".to_string()]
        );
    }
}

#[tokio::test]
async fn misalignment_replay_blocks_when_turn_start_was_evicted() {
    let thread_id = ThreadId::new();
    let error = AppServerTurnError {
        misalignment: None,
        message: "Chat stopped".into(),
        codex_error_info: Some(AppServerCodexErrorInfo::MisalignmentPolicyViolation),
        additional_details: None,
    };
    let previous_turn = test_turn("old-turn", TurnStatus::Completed, Vec::new());
    let failed_turn = Turn {
        error: Some(error.clone()),
        ..test_turn("new-turn", TurnStatus::Failed, Vec::new())
    };
    for (stored_turn, notification) in [
        (
            previous_turn.clone(),
            ServerNotification::Error(codex_app_server_protocol::ErrorNotification {
                thread_id: thread_id.to_string(),
                turn_id: "new-turn".into(),
                error: error.clone(),
                will_retry: false,
            }),
        ),
        (
            previous_turn,
            ServerNotification::TurnCompleted(TurnCompletedNotification {
                thread_id: thread_id.to_string(),
                turn: failed_turn.clone(),
            }),
        ),
        // A settings-operation error has a submission ID, not evidence of a new turn.
        (
            failed_turn,
            ServerNotification::Error(codex_app_server_protocol::ErrorNotification {
                thread_id: thread_id.to_string(),
                turn_id: "settings-update".into(),
                error: AppServerTurnError {
                    codex_error_info: Some(AppServerCodexErrorInfo::BadRequest),
                    ..error
                },
                will_retry: false,
            }),
        ),
    ] {
        for saw_start in [false, true] {
            let mut app = make_test_app().await;
            let mut store = ThreadEventStore::new_with_session(
                /*capacity*/ 1,
                test_thread_session(thread_id, app.config.cwd.to_path_buf()),
                vec![stored_turn.clone()],
            );
            if saw_start {
                store.push_notification(turn_started_notification(thread_id, "new-turn"));
            }
            store.push_notification_ref(&notification);
            assert_eq!(store.buffer.len(), 1);
            app.replay_thread_snapshot(store.snapshot(), /*resume_restored_queue*/ false);
            assert!(app.chat_widget.has_misalignment_policy_violation());
            assert!(render_bottom_popup(&app.chat_widget, /*width*/ 80).contains("Chat stopped"));
        }
    }
}

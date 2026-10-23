use super::*;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn rate_limit_recovery_holds_submissions_until_model_change() {
    let (mut chat, mut events, mut ops) = make_chatwidget_manual(Some("test-model-a")).await;
    set_chatgpt_auth(&mut chat);
    chat.thread_id = Some(ThreadId::new());
    handle_turn_started(&mut chat, "failed-turn");
    chat.queue_user_message(UserMessage::from("queued follow-up"));
    chat.on_rate_limit_error(RateLimitErrorKind::UsageLimit, "Usage exhausted".into());
    assert!(
        std::iter::from_fn(|| events.try_recv().ok()).any(|event| matches!(
            event,
            AppEvent::RefreshRateLimits {
                origin: crate::app_event::RateLimitRefreshOrigin::Recovery
            }
        ))
    );
    chat.submit_user_message(UserMessage::from("submitted during recovery"));
    assert_no_submit_op(&mut ops);
    assert_eq!(
        chat.queued_user_message_texts(),
        vec!["queued follow-up", "submitted during recovery"]
    );

    chat.set_model("test-model-b");
    chat.finish_rate_limit_recovery();
    let Op::UserTurn { model, items, .. } = next_submit_op(&mut ops) else {
        panic!("expected queued follow-up on the fallback model");
    };
    assert_eq!(model, "test-model-b");
    assert!(
        matches!(items.as_slice(), [UserInput::Text { text, .. }] if text == "queued follow-up")
    );
    assert_eq!(
        chat.queued_user_message_texts(),
        vec!["submitted during recovery"]
    );
    chat.finish_rate_limit_recovery();
    assert_no_submit_op(&mut ops);
}

#[tokio::test]
async fn rate_limit_recovery_preserves_settings_hold_and_clears_on_account_change() {
    let (mut chat, _events, mut ops) = make_chatwidget_manual(Some("test-model-a")).await;
    set_chatgpt_auth(&mut chat);
    chat.thread_id = Some(ThreadId::new());
    chat.set_queue_autosend_suppressed(/*suppressed*/ true);
    chat.on_rate_limit_error(RateLimitErrorKind::UsageLimit, "Usage exhausted".into());
    chat.queue_user_message(UserMessage::from("queued follow-up"));
    chat.finish_rate_limit_recovery();
    assert_no_submit_op(&mut ops);
    assert!(chat.input_queue.suppress_queue_autosend);
    assert!(!chat.input_queue.rate_limit_recovery_pending);

    chat.on_rate_limit_error(RateLimitErrorKind::UsageLimit, "Usage exhausted".into());
    chat.update_account_state(
        /*status_account_display*/ None, /*plan_type*/ None,
        /*has_chatgpt_account*/ false, /*has_codex_backend_auth*/ false,
    );
    assert!(!chat.input_queue.rate_limit_recovery_pending);
    assert_eq!(chat.queued_user_message_texts(), vec!["queued follow-up"]);
    assert_no_submit_op(&mut ops);
}

/// What the Claude bridge pushes as `account/rateLimits/updated`.
fn claude_limits(primary_used: i32) -> RateLimitSnapshot {
    RateLimitSnapshot {
        limit_id: Some("codex".to_string()),
        limit_name: Some("Claude".to_string()),
        normal_model_slug: None,
        primary: Some(RateLimitWindow {
            used_percent: primary_used,
            window_duration_mins: Some(300),
            resets_at: None,
        }),
        secondary: Some(RateLimitWindow {
            used_percent: 7,
            window_duration_mins: Some(10_080),
            resets_at: None,
        }),
        credits: None,
        individual_limit: None,
        plan_type: None,
        spend_control_reached: None,
        rate_limit_reached_type: None,
    }
}

#[tokio::test]
async fn pushed_limits_are_kept_when_the_tui_does_not_fetch_limits() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    assert!(!chat.should_prefetch_rate_limits());

    chat.on_rolling_rate_limit_snapshot(claude_limits(/*primary_used*/ 42));

    let display = chat
        .rate_limit_snapshots_by_limit_id
        .get("codex")
        .expect("the pushed Claude limits are stored");
    assert_eq!(display.limit_name, "Claude");
    assert_eq!(
        display.primary.as_ref().map(|window| window.used_percent),
        Some(42.0)
    );
    assert_eq!(
        chat.status_line_value_for_item(crate::bottom_pane::StatusLineItem::FiveHourLimit),
        Some("5h 58% left".to_string())
    );
    assert_eq!(
        chat.status_line_value_for_item(crate::bottom_pane::StatusLineItem::WeeklyLimit),
        Some("weekly 93% left".to_string())
    );
}

#[tokio::test]
async fn pushed_limits_do_not_overwrite_the_limits_a_chatgpt_account_fetches() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);
    assert!(chat.should_prefetch_rate_limits());

    chat.on_rolling_rate_limit_snapshot(claude_limits(/*primary_used*/ 42));
    assert!(chat.rate_limit_snapshots_by_limit_id.get("codex").is_none());

    chat.on_rate_limit_snapshot(Some(claude_limits(/*primary_used*/ 10)));
    chat.on_rolling_rate_limit_snapshot(claude_limits(/*primary_used*/ 42));
    assert_eq!(
        chat.rate_limit_snapshots_by_limit_id
            .get("codex")
            .and_then(|display| display.primary.as_ref())
            .map(|window| window.used_percent),
        Some(10.0)
    );
}

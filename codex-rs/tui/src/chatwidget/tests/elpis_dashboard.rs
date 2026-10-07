//! Evals for `/dashboard` and what the page reads from the ChatWidget: each turn's timing and
//! cost state.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::activity_state::DashboardActivityStatus;
use crate::elpis_app_event::ElpisAppEvent;
use codex_app_server_protocol::TurnActivityStatus;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use pretty_assertions::assert_eq;

fn cost_update(turn_id: &str, reason: TurnCostAvailability) -> ServerNotification {
    ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
        thread_id: "thread-1".to_string(),
        turn_id: turn_id.to_string(),
        cost: TurnCostState::Unavailable { reason },
    })
}

fn activity_update(turn_id: &str, duration_ms: i64, first_token_ms: i64) -> ServerNotification {
    ServerNotification::TurnActivityUpdated(TurnActivityUpdatedNotification {
        thread_id: "thread-1".to_string(),
        turn_id: turn_id.to_string(),
        status: TurnActivityStatus::Completed,
        duration_ms: Some(duration_ms),
        time_to_first_token_ms: Some(first_token_ms),
    })
}

#[tokio::test]
async fn a_live_turn_records_its_timing_and_its_cost_state() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;

    handle_turn_started(&mut chat, "turn-1");
    chat.handle_server_notification(
        cost_update("turn-1", TurnCostAvailability::SubscriptionAuthentication),
        /*replay_kind*/ None,
    );
    let running = chat.dashboard_activity_state();
    assert_eq!(
        running.current.map(|row| row.status),
        Some(DashboardActivityStatus::Running)
    );

    handle_turn_completed(&mut chat, "turn-1", Some(1_234));
    chat.handle_server_notification(
        activity_update("turn-1", 1_234, 56),
        /*replay_kind*/ None,
    );

    let activity = chat.dashboard_activity_state();
    assert_eq!(activity.current, None);
    let [finished] = activity.recent.as_slice() else {
        panic!("one finished turn expected: {activity:?}");
    };
    assert_eq!(finished.status, DashboardActivityStatus::Completed);
    assert_eq!(finished.duration_ms, Some(1_234));
    assert_eq!(finished.time_to_first_token_ms, Some(56));
    assert_eq!(
        finished.cost,
        Some(TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        })
    );
}

#[tokio::test]
async fn replayed_or_foreign_updates_record_nothing() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;

    replay_turn_started(&mut chat, ReplayKind::ThreadSnapshot);
    chat.handle_server_notification(
        activity_update("turn-1", 10, 1),
        Some(ReplayKind::ThreadSnapshot),
    );
    assert_eq!(chat.dashboard_activity_state(), Default::default());

    // A live update for a turn that never started here is not invented into a row.
    chat.handle_server_notification(activity_update("turn-9", 10, 1), /*replay_kind*/ None);
    chat.handle_server_notification(
        cost_update("turn-9", TurnCostAvailability::CostObservationDisabled),
        /*replay_kind*/ None,
    );
    assert_eq!(chat.dashboard_activity_state(), Default::default());
}

fn dashboard_events(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> Vec<String> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::OpenDashboard) => Some("open".to_string()),
            AppEvent::Elpis(ElpisAppEvent::RefreshDashboard) => Some("refresh".to_string()),
            AppEvent::InsertHistoryCell(cell) => {
                Some(lines_to_single_string(&cell.display_lines(/*width*/ 200)))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn dashboard_asks_the_app_to_open_the_page_and_is_no_longer_a_stub() {
    let (mut chat, mut rx, mut ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());

    chat.dispatch_command(SlashCommand::Dashboard);

    assert_eq!(dashboard_events(&mut rx), vec!["open".to_string()]);
    assert_matches!(ops.try_recv(), Err(TryRecvError::Empty));
}

#[tokio::test]
async fn the_page_is_refreshed_only_after_dashboard_was_opened() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());

    // Negative: a chat that never opened the dashboard does no dashboard work.
    handle_turn_started(&mut chat, "turn-1");
    handle_token_count(&mut chat, Some(make_token_info(1_000, 258_400)));
    assert!(!dashboard_events(&mut rx).contains(&"refresh".to_string()));

    chat.dispatch_command(SlashCommand::Dashboard);
    assert_eq!(dashboard_events(&mut rx), vec!["open".to_string()]);

    // Positive: once open, measured usage and each turn's timing republish the page.
    handle_token_count(&mut chat, Some(make_token_info(2_000, 258_400)));
    assert_eq!(dashboard_events(&mut rx), vec!["refresh".to_string()]);
    chat.handle_server_notification(activity_update("turn-1", 900, 40), /*replay_kind*/ None);
    assert_eq!(dashboard_events(&mut rx), vec!["refresh".to_string()]);
}

fn context_report(chat: &mut ChatWidget) -> String {
    let cell = chat.context_usage_cell(Default::default());
    lines_to_single_string(&cell.display_lines(/*width*/ 200))
}

#[tokio::test]
async fn context_links_the_rollout_as_a_readable_local_report() -> anyhow::Result<()> {
    let home = tempfile::tempdir()?;
    let rollout = home.path().join("sessions/rollout-test.jsonl");
    std::fs::create_dir_all(rollout.parent().expect("rollout dir"))?;
    std::fs::write(&rollout, "{\"type\":\"session_meta\"}\n")?;
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.config.codex_home = AbsolutePathBuf::from_absolute_path(home.path())?;

    // Negative: no rollout on disk, no evidence block.
    let report = context_report(&mut chat);
    assert!(!report.contains("Local evidence"), "{report}");

    chat.current_rollout_path = Some(rollout);
    let report = context_report(&mut chat);
    assert!(report.contains("Local evidence · Ctrl+click to open"), "{report}");
    assert!(report.contains("Rollout · http://127.0.0.1:"), "{report}");
    assert!(!report.contains("file://"), "{report}");
    Ok(())
}

#[tokio::test]
async fn a_claude_subscription_model_shows_claude_as_its_provider() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.config.model_provider_id = "openrouter".to_string();
    chat.thread_id = Some(ThreadId::new());
    let status_text = |chat: &mut ChatWidget| {
        lines_to_single_string(
            &chat
                .status_output_cell(
                    /*refreshing_rate_limits*/ false, /*request_id*/ None,
                )
                .display_lines(/*width*/ 120),
        )
    };

    chat.set_model("claude/opus");
    assert_eq!(
        chat.dashboard_models().chat.provider.as_deref(),
        Some("Claude subscription")
    );
    assert!(
        status_text(&mut chat).contains("Claude subscription"),
        "{}",
        status_text(&mut chat)
    );
    // The configured provider still drives /model and the key checks.
    assert_eq!(chat.config.model_provider_id, "openrouter");

    chat.set_model("apodex/x");
    assert_eq!(
        chat.dashboard_models().chat.provider.as_deref(),
        Some("openrouter")
    );
    let text = status_text(&mut chat);
    assert!(!text.contains("Claude subscription"), "{text}");
    assert!(text.contains("openrouter"), "{text}");
}

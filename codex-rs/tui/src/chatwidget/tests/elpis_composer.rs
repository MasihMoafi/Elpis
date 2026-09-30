//! Evals for the ChatWidget half of the Elpis composer behaviour (`chatwidget/elpis_composer.rs`).
//!
//! Each behaviour has a positive case (the Elpis behaviour happens) and a negative case (the
//! input the behaviour must leave alone still takes its ordinary path).

use super::*;
use pretty_assertions::assert_eq;

fn queue_follow_ups(chat: &mut ChatWidget, texts: &[&str]) {
    for text in texts {
        chat.queue_user_message(UserMessage::from(*text));
    }
    assert_eq!(chat.queued_user_message_texts(), texts.to_vec());
}

// Up pulls every queued follow-up back together.

#[tokio::test]
async fn up_pulls_every_queued_follow_up_and_the_draft_back_together() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane.set_task_running(/*running*/ true);
    queue_follow_ups(&mut chat, &["queued one", "queued two"]);
    assert!(render_bottom_popup(&chat, /*width*/ 80).contains("↑ edit all · enter send"));
    chat.bottom_pane
        .set_composer_text("draft".to_string(), Vec::new(), Vec::new());

    chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(
        chat.bottom_pane.composer_text(),
        "queued one\nqueued two\ndraft"
    );
    assert!(chat.queued_user_message_texts().is_empty());
    assert!(!render_bottom_popup(&chat, /*width*/ 80).contains("edit all"));
}

#[tokio::test]
async fn up_without_queued_follow_ups_keeps_history_recall() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.bottom_pane
        .set_composer_text("earlier prompt".to_string(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    chat.bottom_pane.set_task_running(/*running*/ true);
    assert!(chat.queued_user_message_texts().is_empty());

    chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(chat.bottom_pane.composer_text(), "earlier prompt");
    assert!(chat.queued_user_message_texts().is_empty());
}

#[tokio::test]
async fn up_leaves_steers_already_sent_to_the_turn_alone() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane.set_task_running(/*running*/ true);
    chat.input_queue
        .pending_steers
        .push_back(pending_steer("already steering"));
    queue_follow_ups(&mut chat, &["queued one"]);

    chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(chat.bottom_pane.composer_text(), "queued one");
    assert_eq!(chat.input_queue.pending_steers.len(), 1);
}

// Enter queues a follow-up during a turn instead of steering it.

#[tokio::test]
async fn enter_during_a_turn_queues_instead_of_steering() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    handle_turn_started(&mut chat, "turn-1");
    chat.bottom_pane
        .set_composer_text("queued one".to_string(), Vec::new(), Vec::new());

    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert_eq!(chat.queued_user_message_texts(), vec!["queued one"]);
    assert!(chat.input_queue.pending_steers.is_empty());
    assert!(chat.bottom_pane.composer_text().is_empty());
}

#[tokio::test]
async fn enter_while_idle_sends_and_queues_nothing() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.bottom_pane
        .set_composer_text("send now".to_string(), Vec::new(), Vec::new());

    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

    assert!(chat.queued_user_message_texts().is_empty());
    assert!(chat.input_queue.pending_steers.is_empty());
    assert!(chat.bottom_pane.composer_text().is_empty());
}

// Footer hints: the idle Elpis tip, the Ledger hint, and Enter to queue while busy.

/// Renders below the Context Ledger's width threshold so the footer keeps the full row.
fn footer_after_tick(chat: &mut ChatWidget) -> String {
    chat.pre_draw_tick();
    render_bottom_popup(chat, /*width*/ 79)
}

#[tokio::test]
async fn idle_empty_composer_shows_the_ledger_tip_instead_of_shortcuts() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    let footer = footer_after_tick(&mut chat);

    assert!(chat.bottom_pane.elpis_tip_visible());
    assert!(
        footer.contains("tab  open the Context Ledger and choose what stays in context"),
        "{footer}"
    );
    assert!(!footer.contains("? for shortcuts"), "{footer}");
}

#[tokio::test]
async fn a_draft_a_turn_or_a_picker_hides_the_tip() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane
        .set_composer_text("make a plan".to_string(), Vec::new(), Vec::new());
    chat.pre_draw_tick();
    assert!(
        !chat.bottom_pane.elpis_tip_visible(),
        "a draft in progress outranks a tip"
    );

    chat.bottom_pane
        .set_composer_text(String::new(), Vec::new(), Vec::new());
    chat.bottom_pane.set_task_running(/*running*/ true);
    chat.pre_draw_tick();
    assert!(
        !chat.bottom_pane.elpis_tip_visible(),
        "a running turn outranks a tip"
    );

    chat.bottom_pane.set_task_running(/*running*/ false);
    chat.show_selection_view(SelectionViewParams {
        items: vec![SelectionItem {
            name: "Keep planning".to_string(),
            ..Default::default()
        }],
        ..Default::default()
    });
    chat.pre_draw_tick();
    assert!(
        !chat.bottom_pane.elpis_tip_visible(),
        "an open picker outranks a tip"
    );
}

#[tokio::test]
async fn busy_draft_footer_offers_enter_to_queue_and_the_ledger() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.bottom_pane.set_task_running(/*running*/ true);
    chat.bottom_pane
        .set_composer_text("follow-up".to_string(), Vec::new(), Vec::new());

    let footer = footer_after_tick(&mut chat);

    assert!(footer.contains("enter to queue message"), "{footer}");
    assert!(footer.contains("Tab Context Ledger"), "{footer}");
    assert!(!footer.contains("open the Context Ledger"), "{footer}");
}

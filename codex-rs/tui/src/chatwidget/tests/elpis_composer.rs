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

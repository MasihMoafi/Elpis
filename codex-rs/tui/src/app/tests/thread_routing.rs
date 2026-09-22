use super::*;

use std::time::Duration;

fn token_usage_with_output(thread_id: ThreadId, output_tokens: i64) -> ServerNotification {
    let mut event = token_usage_notification(
        thread_id,
        "turn-1",
        Some(/*model_context_window*/ 100),
        /*context_prune_saved_tokens*/ 0,
    );
    if let ServerNotification::ThreadTokenUsageUpdated(notification) = &mut event {
        notification.token_usage.total.output_tokens = output_tokens;
        notification.token_usage.total.total_tokens = 5 + output_tokens;
    }
    event
}

fn assert_token_usage_output(app: &App, output_tokens: i64) {
    std::assert_eq!(
        app.chat_widget.token_usage(),
        crate::token_usage::TokenUsage {
            input_tokens: 4,
            cached_input_tokens: 1,
            cache_write_tokens: None,
            output_tokens,
            reasoning_output_tokens: 0,
            total_tokens: 5 + output_tokens,
        }
    );
}

#[tokio::test]
async fn active_thread_drain_yields_at_frame_deadline_without_dropping_or_reordering_events()
-> Result<()> {
    let mut app = make_test_app().await;
    let thread_id = ThreadId::new();
    app.thread_event_channels
        .insert(thread_id, ThreadEventChannel::new(/*capacity*/ 3));
    app.activate_thread_channel(thread_id).await;

    for output_tokens in [5, 10, 15] {
        app.enqueue_thread_notification(
            thread_id,
            token_usage_with_output(thread_id, output_tokens),
        )
        .await?;
    }

    let mut tui = crate::tui::test_support::make_test_tui()?;
    for (expected_output, expected_remaining) in [(5, 2), (10, 1), (15, 0)] {
        app.drain_active_thread_events_until(&mut tui, Instant::now())
            .await?;
        assert_token_usage_output(&app, expected_output);
        std::assert_eq!(
            app.active_thread_rx
                .as_ref()
                .map(tokio::sync::mpsc::Receiver::len),
            Some(expected_remaining),
            "expired frame drains must preserve the remaining FIFO backlog",
        );
    }

    Ok(())
}

fn percentile(samples: &mut [Duration], percentile: usize) -> Duration {
    samples.sort_unstable();
    samples[(samples.len() - 1) * percentile / 100]
}

fn render_chat_for_latency(chat: &ChatWidget) -> String {
    let area = ratatui::layout::Rect::new(0, 0, 120, 40);
    let mut buffer = ratatui::buffer::Buffer::empty(area);
    Renderable::render(chat, area, &mut buffer);
    (0..area.height)
        .flat_map(|row| {
            (0..area.width)
                .map(|column| buffer[(column, row)].symbol().to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

async fn backlogged_running_app() -> App {
    let mut app = make_test_app().await;
    let thread_id = ThreadId::new();
    app.thread_event_channels.insert(
        thread_id,
        ThreadEventChannel::new(THREAD_EVENT_CHANNEL_CAPACITY),
    );
    app.activate_thread_channel(thread_id).await;

    replenish_active_event_backlog(&mut app);

    app.chat_widget.handle_server_notification(
        turn_started_notification(thread_id, "turn-1"),
        /*replay_kind*/ None,
    );
    app
}

fn replenish_active_event_backlog(app: &mut App) {
    let thread_id = app.active_thread_id.expect("active thread");
    let remaining = app
        .active_thread_rx
        .as_ref()
        .expect("active receiver")
        .len();
    let sender = app
        .thread_event_channels
        .get(&thread_id)
        .expect("thread channel")
        .sender
        .clone();
    let notification = token_usage_with_output(thread_id, /*output_tokens*/ 5);
    for _ in remaining..THREAD_EVENT_CHANNEL_CAPACITY {
        sender
            .try_send(ThreadBufferedEvent::Notification(notification.clone()))
            .expect("full-size test backlog should fit its channel");
    }
    std::assert_eq!(
        app.active_thread_rx
            .as_ref()
            .expect("active receiver")
            .len(),
        THREAD_EVENT_CHANNEL_CAPACITY,
        "every sample must begin with the same full active-event backlog",
    );
}

/// Reproduces the pre-fix drain exactly so the timing harness proves it can detect the regression.
fn drain_active_thread_events_without_frame_deadline(app: &mut App) {
    let mut receiver = app.active_thread_rx.take().expect("active receiver");
    while let Ok(event) = receiver.try_recv() {
        app.handle_thread_event_now(event);
    }
    app.active_thread_rx = Some(receiver);
}

#[tokio::test]
#[ignore = "manual latency experiment; wall-clock thresholds must not make CI flaky"]
async fn experiment_pending_character_and_enter_render_within_budget_under_full_backlog()
-> Result<()> {
    const REPETITIONS: usize = 30;
    const P95_LIMIT: Duration = Duration::from_millis(50);
    const MAX_LIMIT: Duration = Duration::from_millis(100);

    let mut app = backlogged_running_app().await;
    let mut tui = crate::tui::test_support::make_test_tui()?;
    let mut character_samples = Vec::with_capacity(REPETITIONS);
    for _ in 0..REPETITIONS {
        replenish_active_event_backlog(&mut app);
        // Non-ASCII input bypasses the intentional ASCII paste-burst hold; this experiment measures
        // event-drain plus render cost, not the separate paste-flush timer.
        let pending_key = KeyEvent::new(KeyCode::Char('Ω'), KeyModifiers::NONE);
        let started = Instant::now();
        app.drain_active_thread_events(&mut tui).await?;
        app.chat_widget.handle_key_event(pending_key);
        let rendered = render_chat_for_latency(&app.chat_widget);
        character_samples.push(started.elapsed());
        assert!(rendered.contains('Ω'), "typed character was not rendered");
        assert!(
            app.chat_widget.composer_text_with_pending().ends_with('Ω'),
            "typed character did not reach the composer"
        );
    }

    let mut queue_samples = Vec::with_capacity(REPETITIONS);
    for iteration in 0..REPETITIONS {
        replenish_active_event_backlog(&mut app);
        let message = format!("queued follow-up {iteration}");
        app.chat_widget.apply_external_edit(message.clone());
        let pending_enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
        let started = Instant::now();
        app.drain_active_thread_events(&mut tui).await?;
        app.chat_widget.handle_key_event(pending_enter);
        let rendered = render_chat_for_latency(&app.chat_widget);
        queue_samples.push(started.elapsed());
        assert!(
            app.chat_widget.composer_text_with_pending().is_empty(),
            "Enter did not clear the composer"
        );
        std::assert_eq!(
            app.chat_widget
                .queued_user_message_texts()
                .last()
                .map(String::as_str),
            Some(message.as_str()),
            "Enter did not append the message to queued state",
        );
        assert!(
            rendered.contains(&message),
            "queued input was not visibly rendered"
        );
    }

    eprintln!("typing latency raw character samples: {character_samples:?}");
    eprintln!("typing latency raw queue samples: {queue_samples:?}");
    let character_max = *character_samples.iter().max().expect("character samples");
    let queue_max = *queue_samples.iter().max().expect("queue samples");
    let character_p50 = percentile(&mut character_samples, 50);
    let character_p95 = percentile(&mut character_samples, 95);
    let queue_p50 = percentile(&mut queue_samples, 50);
    let queue_p95 = percentile(&mut queue_samples, 95);
    eprintln!(
        "typing latency: character p50={character_p50:?} p95={character_p95:?} max={character_max:?}; queue p50={queue_p50:?} p95={queue_p95:?} max={queue_max:?}"
    );
    assert!(
        character_p95 <= P95_LIMIT && character_max <= MAX_LIMIT,
        "character-to-visible latency exceeded budget: p95={character_p95:?}, max={character_max:?}"
    );
    assert!(
        queue_p95 <= P95_LIMIT && queue_max <= MAX_LIMIT,
        "Enter-to-visible-queue latency exceeded budget: p95={queue_p95:?}, max={queue_max:?}"
    );

    let mut unbounded_character_app = backlogged_running_app().await;
    let pending_key = KeyEvent::new(KeyCode::Char('Ω'), KeyModifiers::NONE);
    let started = Instant::now();
    drain_active_thread_events_without_frame_deadline(&mut unbounded_character_app);
    unbounded_character_app
        .chat_widget
        .handle_key_event(pending_key);
    let rendered = render_chat_for_latency(&unbounded_character_app.chat_widget);
    let unbounded_character = started.elapsed();
    assert!(rendered.contains('Ω'), "typed character was not rendered");
    assert!(
        unbounded_character_app
            .chat_widget
            .composer_text_with_pending()
            .ends_with('Ω'),
        "typed character did not reach the composer"
    );
    assert!(
        unbounded_character > P95_LIMIT,
        "negative control did not expose the old unbounded character delay: {unbounded_character:?}"
    );

    let mut unbounded_queue_app = backlogged_running_app().await;
    let message = "negative-control queued follow-up".to_string();
    unbounded_queue_app
        .chat_widget
        .apply_external_edit(message.clone());
    let pending_enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    let started = Instant::now();
    drain_active_thread_events_without_frame_deadline(&mut unbounded_queue_app);
    unbounded_queue_app
        .chat_widget
        .handle_key_event(pending_enter);
    let rendered = render_chat_for_latency(&unbounded_queue_app.chat_widget);
    let unbounded_queue = started.elapsed();
    assert!(
        unbounded_queue_app
            .chat_widget
            .composer_text_with_pending()
            .is_empty(),
        "Enter did not clear the composer"
    );
    std::assert_eq!(
        unbounded_queue_app
            .chat_widget
            .queued_user_message_texts()
            .last()
            .map(String::as_str),
        Some(message.as_str()),
        "Enter did not append the message to queued state",
    );
    assert!(
        rendered.contains(&message),
        "queued input was not visibly rendered"
    );
    assert!(
        unbounded_queue > P95_LIMIT,
        "negative control did not expose the old unbounded queue delay: {unbounded_queue:?}"
    );
    eprintln!(
        "typing latency negative control: character={unbounded_character:?}; queue={unbounded_queue:?}"
    );

    Ok(())
}

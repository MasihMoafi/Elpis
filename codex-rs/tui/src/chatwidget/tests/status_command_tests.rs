// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use super::*;
use crate::app_event::ManualMemoryUnavailableReason;
use assert_matches::assert_matches;

#[tokio::test]
async fn status_command_renders_immediately_and_refreshes_rate_limits_for_chatgpt_auth() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);

    chat.dispatch_command(SlashCommand::Usage);

    let rendered = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 80))
        }
        other => panic!("expected status output before refresh request, got {other:?}"),
    };
    assert!(
        !rendered.contains("refreshing limits"),
        "expected /usage to avoid transient refresh text in terminal history, got: {rendered}"
    );
    let request_id = match rx.try_recv() {
        Ok(AppEvent::RefreshRateLimits {
            origin: RateLimitRefreshOrigin::UsageCommand { request_id },
        }) => request_id,
        other => panic!("expected rate-limit refresh request, got {other:?}"),
    };
    pretty_assertions::assert_eq!(request_id, 0);
}

#[tokio::test]
async fn status_command_refresh_updates_cached_limits_for_future_status_outputs() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);

    chat.dispatch_command(SlashCommand::Usage);

    match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(_)) => {}
        other => panic!("expected status output before refresh request, got {other:?}"),
    }
    let first_request_id = match rx.try_recv() {
        Ok(AppEvent::RefreshRateLimits {
            origin: RateLimitRefreshOrigin::UsageCommand { request_id },
        }) => request_id,
        other => panic!("expected rate-limit refresh request, got {other:?}"),
    };

    chat.finish_status_rate_limit_refresh(first_request_id, vec![snapshot(/*percent*/ 92.0)]);
    drain_insert_history(&mut rx);

    chat.dispatch_command(SlashCommand::Usage);
    let refreshed = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 80))
        }
        other => panic!("expected refreshed status output, got {other:?}"),
    };
    assert!(
        refreshed.contains("8% left"),
        "expected a future /usage output to use refreshed cached limits, got: {refreshed}"
    );
}

#[tokio::test]
async fn status_command_renders_immediately_without_rate_limit_refresh() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;

    chat.dispatch_command(SlashCommand::Usage);

    assert_matches!(rx.try_recv(), Ok(AppEvent::InsertHistoryCell(_)));
    assert!(
        !std::iter::from_fn(|| rx.try_recv().ok())
            .any(|event| matches!(event, AppEvent::RefreshRateLimits { .. })),
        "non-ChatGPT sessions should not request a rate-limit refresh for /usage"
    );
}

#[tokio::test]
async fn status_command_uses_cached_manual_memory_without_requesting_refresh() {
    use crate::legacy_core::elpis_context::ContinuitySource;
    use crate::legacy_core::elpis_context::ContinuitySourceCategory;
    use crate::legacy_core::elpis_context::ManualMemoryAdmissionState;
    use crate::legacy_core::elpis_context::ManualMemoryStatus;

    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let memory_path = chat.config.memory_dir.as_path().join("MEMORY.md");
    chat.manual_memory_cache.phase = ManualMemoryPhase::Ready;
    chat.manual_memory_cache.status = Some(ManualMemoryStatus {
        state: ManualMemoryAdmissionState::Admitted,
        bytes: 14,
        request_chars_if_admitted: 14,
        eligible_chars_now: 14,
        limit_chars: 8_000,
        truncated: false,
    });
    chat.manual_memory_cache.sources = vec![ContinuitySource {
        name: "MEMORY.md".to_string(),
        path: memory_path,
        bytes: 14,
        estimated_tokens: 4,
        category: ContinuitySourceCategory::Memory,
        origin: "test cache",
        lifetime: "every turn",
        reason: "test cache",
        admitted: true,
        selectable: true,
    }];
    chat.manual_memory_cache.unavailable_reason = None;
    chat.manual_memory_cache.pending_mutation = None;

    chat.dispatch_command(SlashCommand::Usage);

    let rendered = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 100))
        }
        other => panic!("expected cached status output, got {other:?}"),
    };
    let normalized = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        normalized.contains("MEMORY.md Admitted next request 14/8000"),
        "{rendered}"
    );
    assert!(
        normalized.contains("Portable context ≈4 tokens admitted"),
        "{rendered}"
    );
    while let Ok(event) = rx.try_recv() {
        assert!(
            !matches!(
                event,
                AppEvent::ManualMemoryStatusRefreshRequested(_)
                    | AppEvent::RequestContextUsageReport(_)
            ),
            "/usage must remain a cached read"
        );
    }

    chat.manual_memory_cache.phase = ManualMemoryPhase::Unavailable;
    chat.manual_memory_cache.status = None;
    chat.manual_memory_cache.sources.clear();
    chat.manual_memory_cache.unavailable_reason =
        Some(ManualMemoryUnavailableReason::SourcesUnavailable);
    chat.dispatch_command(SlashCommand::Usage);
    let rendered = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 100))
        }
        other => panic!("expected unavailable cached status output, got {other:?}"),
    };
    let normalized = rendered.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(normalized.contains("MEMORY.md Unavailable"), "{rendered}");
    assert!(!rendered.contains("14/8000"), "{rendered}");
    while let Ok(event) = rx.try_recv() {
        assert!(
            !matches!(
                event,
                AppEvent::ManualMemoryStatusRefreshRequested(_)
                    | AppEvent::RequestContextUsageReport(_)
            ),
            "/usage must not turn an unavailable cache into a live read"
        );
    }
}

#[tokio::test]
async fn status_command_uses_catalog_default_reasoning_when_config_empty() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.4")).await;
    chat.config.model_reasoning_effort = None;

    chat.dispatch_command(SlashCommand::Usage);

    let rendered = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 80))
        }
        other => panic!("expected status output, got {other:?}"),
    };
    assert!(
        rendered.contains("gpt-5.4 (reasoning medium, summaries auto)"),
        "expected /usage to render the catalog default reasoning effort, got: {rendered}"
    );
}

#[tokio::test]
async fn status_command_overlapping_refreshes_update_matching_cells_only() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);

    chat.dispatch_command(SlashCommand::Usage);
    match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(_)) => {}
        other => panic!("expected first status output, got {other:?}"),
    }
    let first_request_id = match rx.try_recv() {
        Ok(AppEvent::RefreshRateLimits {
            origin: RateLimitRefreshOrigin::UsageCommand { request_id },
        }) => request_id,
        other => panic!("expected first refresh request, got {other:?}"),
    };

    chat.dispatch_command(SlashCommand::Usage);
    let second_rendered = match rx.try_recv() {
        Ok(AppEvent::InsertHistoryCell(cell)) => {
            lines_to_single_string(&cell.display_lines(/*width*/ 80))
        }
        other => panic!("expected second status output, got {other:?}"),
    };
    let second_request_id = match rx.try_recv() {
        Ok(AppEvent::RefreshRateLimits {
            origin: RateLimitRefreshOrigin::UsageCommand { request_id },
        }) => request_id,
        other => panic!("expected second refresh request, got {other:?}"),
    };

    assert_ne!(first_request_id, second_request_id);
    assert!(
        !second_rendered.contains("refreshing limits"),
        "expected /usage to avoid transient refresh text in terminal history, got: {second_rendered}"
    );

    chat.finish_status_rate_limit_refresh(first_request_id, Vec::new());
    pretty_assertions::assert_eq!(chat.refreshing_status_outputs.len(), 1);

    chat.finish_status_rate_limit_refresh(second_request_id, vec![snapshot(/*percent*/ 92.0)]);
    assert!(chat.refreshing_status_outputs.is_empty());
}

#[tokio::test]
async fn account_update_rejects_stale_status_rate_limit_snapshots() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    set_chatgpt_auth(&mut chat);
    chat.dispatch_command(SlashCommand::Usage);
    assert_matches!(rx.try_recv(), Ok(AppEvent::InsertHistoryCell(_)));
    let request_id = match rx.try_recv() {
        Ok(AppEvent::RefreshRateLimits {
            origin: RateLimitRefreshOrigin::UsageCommand { request_id },
        }) => request_id,
        other => panic!("expected status refresh request, got {other:?}"),
    };

    chat.update_account_state(
        /*status_account_display*/ None, /*plan_type*/ None,
        /*has_chatgpt_account*/ true, /*has_codex_backend_auth*/ true,
    );
    chat.finish_status_rate_limit_refresh(request_id, vec![snapshot(/*percent*/ 92.0)]);

    assert!(chat.rate_limit_snapshots_by_limit_id.is_empty());
}

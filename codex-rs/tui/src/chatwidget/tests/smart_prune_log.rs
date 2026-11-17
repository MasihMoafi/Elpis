use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use crate::legacy_core::smart_prune_log::PruneLogItem;
use crate::legacy_core::smart_prune_log::PruneLogRecord;

fn record(id: &str, turn: &str) -> PruneLogRecord {
    PruneLogRecord {
        attempt_id: id.to_string(),
        thread_id: "this-chat".to_string(),
        timestamp: "2026-10-17 19:20:00 +03:30".to_string(),
        chat_title: "Readable pruning log".to_string(),
        turn_id: format!("turn-uuid-{turn}"),
        turn_number: turn.parse().ok(),
        model: "gpt-6-luna".to_string(),
        reasoning_effort: "low".to_string(),
        items: vec![PruneLogItem {
            call_id: "test-call".into(), kept: None,
            description: "shell: cargo test -p core".to_string(),
            source_tokens: 1200,
            admitted_tokens: 200,
            decision: "compacted: Removed 4 source lines, including “test append_log ... ok”; “test keep_original ... ok”. Kept 0 source lines verbatim; results were reworded in the compact text.".to_string(),
            original: "running 2 tests\ntest append_log ... ok\ntest keep_original ... ok\ntest result: ok. 2 passed; 0 failed".to_string(),
            compact: Some("2 tests passed: append_log, keep_original. No failures.".to_string()),
        }, PruneLogItem {
            call_id: "test-call".into(), kept: None,
            description: "read_file: src/app.rs".to_string(),
            source_tokens: 800,
            admitted_tokens: 800,
            decision: "kept: Pruner's reason: This is the exact entry point for the next edit. Retained the line “fn main() { run_app(); }”.".to_string(),
            original: "fn main() { run_app(); }".to_string(),
            compact: None,
        }],
        note: None,
        admission_evidence_missing: false,
    }
}

fn finish_current(chat: &mut ChatWidget, records: Result<(Vec<PruneLogRecord>, usize), String>) {
    let request_id = chat.smart_prune_log_request.expect("open log request");
    chat.finish_smart_prune_log(request_id, records);
}

#[tokio::test]
async fn picker_navigation_keeps_active_view_until_global_and_next_page_events_are_handled() {
    use crate::legacy_core::smart_prune_log::PruneLogPage;
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    finish_current(&mut chat, Ok((Vec::new(), 0)));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let (source, cursor) = std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::OpenGlobalSmartPruneLog(id, cursor)) => {
                Some((id, cursor))
            }
            _ => None,
        })
        .expect("All chats requests the global log");
    assert_eq!(cursor, None);
    assert!(chat.smart_prune_picker_is_current(source));
    chat.open_global_smart_prune_log(cursor);
    let page_request = chat.smart_prune_log_request.unwrap();
    chat.finish_global_smart_prune_log(
        page_request,
        Ok(PruneLogPage {
            data: vec![(&record("newest", "2")).into()],
            next_cursor: Some("older".to_string()),
            unreadable: 0,
        }),
    );
    chat.handle_key_event(KeyEvent::from(KeyCode::Down));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let (source, cursor) = std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::OpenGlobalSmartPruneLog(id, cursor)) => {
                Some((id, cursor))
            }
            _ => None,
        })
        .expect("Next page requests older records");
    assert_eq!(source, page_request);
    assert_eq!(cursor.as_deref(), Some("older"));
    assert!(chat.smart_prune_picker_is_current(source));
    chat.open_global_smart_prune_log(cursor);
    assert_ne!(chat.smart_prune_log_request, Some(page_request));
    assert!(render_bottom_popup(&chat, 100).contains("Loading"));
}

#[tokio::test]
async fn global_log_opens_other_chat_and_rejects_stale_detail_requests() {
    use crate::legacy_core::smart_prune_log::PruneLogPage;
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    finish_current(&mut chat, Ok((Vec::new(), 0)));
    assert!(render_bottom_popup(&chat, 100).contains("All chats"));
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log all".to_string(), Vec::new());
    let request = chat.smart_prune_log_request.unwrap();
    let mut other = record("other-attempt", "6");
    other.thread_id = "other-chat".to_string();
    chat.finish_global_smart_prune_log(
        request,
        Ok(PruneLogPage {
            data: vec![(&other).into()],
            next_cursor: Some("next".to_string()),
            unreadable: 1,
        }),
    );
    let screen = render_bottom_popup(&chat, 100);
    assert!(screen.contains("All chats"));
    assert!(screen.contains("Readable pruning log"));
    assert!(screen.contains("unreadable"));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let requested = std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::ReadGlobalSmartPruneRecord(id, attempt, thread)) => {
                Some((id, attempt, thread))
            }
            _ => None,
        })
        .expect("global selection requests its record");
    assert_eq!(
        requested,
        (
            request,
            "other-attempt".to_string(),
            "other-chat".to_string()
        )
    );
    let detail = chat.begin_global_smart_prune_detail(request).unwrap();
    assert!(chat.global_smart_prune_detail_is_current(request, detail));
    let newer = chat.begin_global_smart_prune_detail(request).unwrap();
    assert!(!chat.global_smart_prune_detail_is_current(request, detail));
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    assert!(!chat.global_smart_prune_detail_is_current(request, newer));
    chat.finish_global_smart_prune_log(
        request,
        Ok(PruneLogPage {
            data: vec![(&other).into()],
            next_cursor: None,
            unreadable: 0,
        }),
    );
    assert!(!chat.global_smart_prune_log_is_current(request));
}

#[tokio::test]
async fn global_log_displays_unknown_savings_and_ignores_old_page() {
    use crate::legacy_core::smart_prune_log::PruneLogPage;
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log all".to_string(), Vec::new());
    let old = chat.smart_prune_log_request.unwrap();
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log all".to_string(), Vec::new());
    let current = chat.smart_prune_log_request.unwrap();
    let mut unknown: crate::legacy_core::smart_prune_log::PruneLogSummary =
        (&record("unknown", "1")).into();
    unknown.estimated_saved_tokens = None;
    chat.finish_global_smart_prune_log(
        old,
        Ok(PruneLogPage {
            data: vec![unknown.clone()],
            next_cursor: None,
            unreadable: 0,
        }),
    );
    assert!(render_bottom_popup(&chat, 100).contains("Loading"));
    chat.finish_global_smart_prune_log(
        current,
        Ok(PruneLogPage {
            data: vec![unknown],
            next_cursor: None,
            unreadable: 0,
        }),
    );
    let screen = render_bottom_popup(&chat, 100);
    assert!(screen.contains("Savings unavailable"));
    assert!(!screen.contains("~0 tokens saved"));
}

#[tokio::test]
async fn smart_prune_log_ignores_an_old_read_after_reopening() {
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    let old_request = chat.smart_prune_log_request.unwrap();
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    let new_request = chat.smart_prune_log_request.unwrap();
    assert_ne!(old_request, new_request);
    chat.finish_smart_prune_log(old_request, Ok((vec![record("old", "6")], 0)));
    assert!(render_bottom_popup(&chat, 80).contains("Loading"));
    chat.finish_smart_prune_log(new_request, Ok((vec![record("new", "9")], 0)));
    let screen = render_bottom_popup(&chat, 80);
    assert!(screen.contains("Turn 9"));
    assert!(!screen.contains("Turn 6"));
}

#[tokio::test]
async fn smart_prune_log_list_and_open_record_snapshots() {
    for width in [80, 120] {
        let (mut chat, mut rx, _ops) = make_chatwidget_manual(None).await;
        chat.thread_id = Some(ThreadId::new());
        chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
        finish_current(
            &mut chat,
            Ok((vec![record("attempt-1", "6"), record("attempt-2", "7")], 0)),
        );
        let screen = render_bottom_popup(&chat, width);
        assert!(screen.find("Turn 6").unwrap() < screen.find("Turn 7").unwrap());
        assert_chatwidget_snapshot!(format!("smart_prune_log_list_{width}"), screen);

        // Keyboard navigation really selects the older record; Enter opens its evidence.
        chat.handle_key_event(KeyEvent::from(KeyCode::Up));
        chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
        let opened = std::iter::from_fn(|| rx.try_recv().ok())
            .find_map(|event| match event {
                AppEvent::Elpis(ElpisAppEvent::OpenSmartPruneRecord(record)) => Some(record),
                _ => None,
            })
            .expect("Enter opens an attempt");
        assert_eq!(opened.attempt_id, "attempt-1");
        let crate::pager_overlay::Overlay::Static(mut pager) =
            super::super::smart_prune_log::record_overlay(
                &opened,
                opened.items.iter().map(|item| item.diff()).collect(),
                &crate::keymap::RuntimeKeymap::defaults().pager,
            )
        else {
            panic!("static evidence pager");
        };
        let area = Rect::new(0, 0, width, 35);
        let mut buffer = Buffer::empty(area);
        pager.render(area, &mut buffer);
        let detail = (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(detail.contains("Original output"));
        assert!(detail.contains("Compact output"));
        assert!(detail.contains("2 tests passed"));
        assert!(detail.contains("50.0%"));
        assert_chatwidget_snapshot!(format!("smart_prune_log_record_{width}"), detail);
    }
}

#[tokio::test]
async fn smart_prune_log_scrolls_to_older_attempts_with_real_keys() {
    let (mut chat, mut rx, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    let records = (0..20)
        .map(|i| record(&format!("attempt-{i}"), &format!("{i:02}")))
        .collect();
    finish_current(&mut chat, Ok((records, 0)));
    assert!(render_bottom_popup(&chat, 80).contains("Turn 19"));
    for _ in 0..19 {
        chat.handle_key_event(KeyEvent::from(KeyCode::Up));
    }
    let screen = render_bottom_popup(&chat, 80);
    assert!(screen.contains("Turn 0"));
    assert!(!screen.contains("Turn 19"));
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let opened = std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::OpenSmartPruneRecord(record)) => Some(record),
            _ => None,
        })
        .unwrap();
    assert_eq!(opened.attempt_id, "attempt-0");
}

#[tokio::test]
async fn smart_prune_log_empty_failed_and_late_reads() {
    let (mut chat, _rx, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    finish_current(&mut chat, Ok((Vec::new(), 0)));
    assert!(render_bottom_popup(&chat, 80).contains("No pruning attempts in this chat yet."));
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    finish_current(&mut chat, Ok((vec![record("late", "8")], 0)));
    assert!(!render_bottom_popup(&chat, 80).contains("Smart Prune log"));

    chat.dispatch_command_with_args(SlashCommand::SmartPrune, "log".to_string(), Vec::new());
    finish_current(&mut chat, Err("permission denied".to_string()));
    assert!(render_bottom_popup(&chat, 80).contains("Cannot read pruning evidence"));
}

#[test]
fn smart_prune_log_record_puts_turn_ids_last_and_explains_removed_text() {
    let mut attempt = record("attempt-useful", "3");
    attempt.turn_id = "6f1d2e3a-0000-7000-8000-000000000001".to_string();
    attempt.items[0].decision =
        "compacted: Removed 480 repeated test lines; kept 3 failures and the summary.".to_string();
    let lines = super::super::smart_prune_log::record_lines(&attempt)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    assert!(lines[0].contains("Turn 3"));
    assert!(!lines[0].contains(&attempt.turn_id));
    assert!(
        lines
            .iter()
            .any(|line| line.contains("Removed 480 repeated test lines"))
    );
    assert!(lines.last().unwrap().contains(&attempt.turn_id));
}

#[test]
fn missing_admission_never_claims_savings_and_notes_are_safe() {
    let mut attempt = record("missing", "3");
    attempt.admission_evidence_missing = true;
    attempt.note = Some(
        "Committed admission evidence unavailable; savings are unknown.\u{1b}[31m".to_string(),
    );
    for item in &mut attempt.items {
        item.compact = None;
    }
    let lines = super::super::smart_prune_log::record_lines(&attempt)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("savings unavailable"))
    );
    assert!(
        !lines
            .iter()
            .any(|line| line.contains("received by the main model"))
    );
    assert!(lines.iter().all(|line| !line.contains('\u{1b}')));
}

#[test]
fn smart_prune_inline_rows_follow_their_tool_and_activate_with_mouse_and_enter() {
    use crate::exec_cell::{CommandOutput, ExecCall, ExecCell};
    use crate::history_cell::{HistoryCell, HistoryRenderMode};
    use crate::transcript_view::{TranscriptView, ViewAction};
    use codex_protocol::elpis_smart_prune::SmartPruneEvent;
    use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let completed = |call: &str, command: &str| ExecCall {
        call_id: call.into(),
        command: vec![command.into()],
        parsed: vec![],
        output: Some(CommandOutput::new(0, "Full tool output".into())),
        source: codex_app_server_protocol::CommandExecutionSource::UnifiedExecStartup,
        start_time: None,
        duration: Some(std::time::Duration::from_millis(5)),
        interaction_input: None,
    };
    let mut group = ExecCell::new(completed("first", "cargo test -p core"), false);
    group.group.calls.push(completed("second", "git status"));
    let mut cells: Vec<Arc<dyn HistoryCell>> = vec![Arc::new(group)];
    let prune = SmartPruneEvent {
        attempt_id: "attempt-1".into(),
        call_id: "first".into(),
        tool: "cargo test -p core".into(),
        occurred_at_ms: 1_790_000_000_000,
        source_tokens: 6300,
        admitted_tokens: 182,
        kept: Some("the 2 failing tests".into()),
        failure_reason: None,
    };
    assert!(super::super::smart_prune_log::attach_to_tool(
        &mut cells, &prune
    ));
    let failed = SmartPruneEvent {
        call_id: "second".into(),
        failure_reason: Some("The pruner timed out.".into()),
        ..prune.clone()
    };
    assert!(super::super::smart_prune_log::attach_to_tool(
        &mut cells, &failed
    ));
    // Delivery can repeat after reconnect; an attempt is still displayed only once.
    assert!(super::super::smart_prune_log::attach_to_tool(
        &mut cells, &prune
    ));
    let raw = cells[0]
        .raw_lines()
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(raw.find("Smart Prune ·").unwrap() < raw.find("git status").unwrap());
    for width in [80, 120] {
        let mut view = TranscriptView::default();
        view.set_presentation(true, HistoryRenderMode::Rich);
        let area = Rect::new(0, 0, width, 30);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer, &cells);
        let lines = (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| crate::terminal_hyperlinks::strip_osc8(buffer[(x, y)].symbol()))
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect::<Vec<_>>();
        let screen = lines.join("\n");
        assert!(
            screen.find("Smart Prune ·").unwrap() < screen.find("git status").unwrap(),
            "the first audit follows its tool before the second command: {screen}"
        );
        assert_eq!(screen.matches("Smart Prune ·").count(), 1);
        assert_eq!(screen.matches("Smart Prune failed ·").count(), 1);
        assert!(screen.contains("6.3k → 182 tokens"));
        assert!(screen.contains("The pruner timed out."));
        assert!(
            screen.find("git status").unwrap() < screen.find("Smart Prune failed ·").unwrap(),
            "the failed audit follows the second command: {screen}"
        );
        let row = lines
            .iter()
            .position(|line| line.contains("Smart Prune ·"))
            .unwrap() as u16;
        let down = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 1,
            row,
            modifiers: KeyModifiers::NONE,
        };
        view.handle_mouse(down, &cells);
        view.render(area, &mut buffer, &cells);
        let Some(ViewAction::OpenLink(clicked)) = view.handle_mouse(
            MouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                ..down
            },
            &cells,
        ) else {
            panic!("prune click must open its audit");
        };
        view.handle_key(KeyEvent::from(KeyCode::Tab), &cells);
        let Some(ViewAction::OpenLink(entered)) =
            view.handle_key(KeyEvent::from(KeyCode::Enter), &cells)
        else {
            panic!("Enter must open the focused prune");
        };
        assert_eq!(clicked, entered);
        assert!(clicked.ends_with("attempt-1/first"));
    }
}

#[test]
fn smart_prune_record_opens_at_the_start_of_a_long_original() {
    let mut evidence = record("long", "1");
    evidence.items.truncate(1);
    evidence.items[0].original = format!(
        "FIRST_ORIGINAL_LINE\n{}LAST_ORIGINAL_LINE",
        "repeated line\n".repeat(120)
    );
    for width in [80, 120] {
        let crate::pager_overlay::Overlay::Static(mut pager) =
            super::super::smart_prune_log::record_overlay(
                &evidence,
                evidence.items.iter().map(|item| item.diff()).collect(),
                &crate::keymap::RuntimeKeymap::defaults().pager,
            )
        else {
            panic!("static evidence pager");
        };
        let area = Rect::new(0, 0, width, 18);
        let mut buffer = Buffer::empty(area);
        pager.render(area, &mut buffer);
        let screen = (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(screen.contains("Original output"));
        assert!(screen.contains("FIRST_ORIGINAL_LINE"));
        assert!(!screen.contains("LAST_ORIGINAL_LINE"));
    }
}

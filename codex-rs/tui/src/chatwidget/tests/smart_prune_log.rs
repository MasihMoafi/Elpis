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
            description: "shell: cargo test -p core".to_string(),
            source_tokens: 1200,
            admitted_tokens: 200,
            decision: "compacted: Removed 4 source lines, including “test append_log ... ok”; “test keep_original ... ok”. Kept 0 source lines verbatim; results were reworded in the compact text.".to_string(),
            original: "running 2 tests\ntest append_log ... ok\ntest keep_original ... ok\ntest result: ok. 2 passed; 0 failed".to_string(),
            compact: Some("2 tests passed: append_log, keep_original. No failures.".to_string()),
        }, PruneLogItem {
            description: "read_file: src/app.rs".to_string(),
            source_tokens: 800,
            admitted_tokens: 800,
            decision: "kept: Pruner's reason: This is the exact entry point for the next edit. Retained the line “fn main() { run_app(); }”.".to_string(),
            original: "fn main() { run_app(); }".to_string(),
            compact: None,
        }],
        note: None,
    }
}

fn finish_current(chat: &mut ChatWidget, records: Result<(Vec<PruneLogRecord>, usize), String>) {
    let request_id = chat.smart_prune_log_request.expect("open log request");
    chat.finish_smart_prune_log(request_id, records);
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

//! Evals for v0.3.0's `/compact` arguments on the new base: `/compact N` saves the
//! pressure-compaction threshold, `/compact <text>` compacts now with the text as guidance for
//! the summary, and bare `/compact` stays upstream's command. None of them reaches the model as
//! a chat message.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::legacy_core::pressure_compaction::PressureCompaction;
use pretty_assertions::assert_eq;

const SAVED_30: &str =
    "• Pressure compaction saved: 30% remaining. Checked before each turn. /compact alone compacts now.\n";
const NOT_CHANGED: &str =
    "■ Compaction setting was not changed: Use /compact N with 0 < N < 70.\n";
const GUIDANCE: &str = "keep the Cedar blockers";

type Events = tokio::sync::mpsc::UnboundedReceiver<AppEvent>;
type Ops = tokio::sync::mpsc::UnboundedReceiver<Op>;

/// A widget whose Elpis home is a fresh temporary directory, so `compaction.json` lands there.
async fn chat_with_home() -> (ChatWidget, Events, Ops, tempfile::TempDir) {
    let (mut chat, rx, ops) = make_chatwidget_manual(/*model_override*/ None).await;
    let home = tempfile::tempdir().expect("temporary home");
    chat.config.codex_home =
        AbsolutePathBuf::from_absolute_path(home.path()).expect("absolute temporary home");
    chat.thread_id = Some(ThreadId::new());
    (chat, rx, ops, home)
}

/// What the widget sent to the app: history cells (one line each) and ops.
struct Sent {
    cells: Vec<String>,
    ops: Vec<Op>,
}

fn drain(rx: &mut Events) -> Sent {
    let mut sent = Sent {
        cells: Vec::new(),
        ops: Vec::new(),
    };
    while let Ok(event) = rx.try_recv() {
        match event {
            AppEvent::InsertHistoryCell(cell) => sent
                .cells
                .push(lines_to_single_string(&cell.display_lines(/*width*/ 200))),
            AppEvent::CodexOp(op) => sent.ops.push(op),
            _ => {}
        }
    }
    sent
}

fn saved_percent(home: &tempfile::TempDir) -> Option<f64> {
    PressureCompaction::load(home.path())
        .expect("compaction.json is readable")
        .remaining_percent
}

fn is_compaction(op: &Op) -> bool {
    matches!(op, Op::Compact | Op::CompactWithInstructions { .. })
}

fn type_and_submit(chat: &mut ChatWidget, text: &str) {
    chat.bottom_pane
        .set_composer_text(text.to_string(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
}

fn complete_turn(chat: &mut ChatWidget, turn_id: &str) {
    complete_assistant_message(
        chat,
        &format!("{turn_id}-message"),
        "done",
        Some(MessagePhase::FinalAnswer),
    );
    handle_turn_completed(chat, turn_id, /*duration_ms*/ None);
}

fn queue_with_tab(chat: &mut ChatWidget, text: &str) {
    chat.bottom_pane
        .set_composer_text(text.to_string(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
}

#[tokio::test]
async fn typed_compact_number_saves_the_threshold_and_does_not_reach_the_model() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;
    assert_eq!(saved_percent(&home), None);

    type_and_submit(&mut chat, "/compact 30");

    assert_eq!(saved_percent(&home), Some(30.0));
    let sent = drain(&mut rx);
    assert!(
        sent.cells.iter().any(|cell| cell == SAVED_30),
        "{:?}",
        sent.cells
    );
    assert!(
        !sent.ops.iter().any(is_compaction),
        "/compact 30 compacted now: {:?}",
        sent.ops
    );
    assert_no_submit_op(&mut ops);
    assert!(!chat.bottom_pane.is_task_running());
}

#[tokio::test]
async fn typed_text_without_the_slash_reaches_the_model() {
    // Negative control for the eval above: this harness does see a model request.
    let (mut chat, _rx, mut ops, home) = chat_with_home().await;

    type_and_submit(&mut chat, "compact 30");

    assert_matches!(next_submit_op(&mut ops), Op::UserTurn { .. });
    assert_eq!(saved_percent(&home), None);
}

#[tokio::test]
async fn compact_numbers_in_range_are_saved_and_checked_against_remaining_context() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;

    for value in ["0.5", "1", "25", "30%", "25%%", "69.99"] {
        chat.dispatch_command_with_args(SlashCommand::Compact, value.into(), Vec::new());

        let threshold = value.trim_end_matches('%').parse::<f64>().unwrap();
        assert_eq!(saved_percent(&home), Some(threshold), "/compact {value}");
        let sent = drain(&mut rx);
        assert!(
            sent.cells
                .iter()
                .any(|cell| cell.contains("Pressure compaction saved: ")),
            "/compact {value}: {:?}",
            sent.cells
        );
        assert!(!sent.ops.iter().any(is_compaction), "/compact {value}");
        assert!(!chat.bottom_pane.is_task_running(), "/compact {value}");
    }
    assert_no_submit_op(&mut ops);

    // The saved threshold is remaining context: at 25%, 750 of 1000 used is the boundary.
    PressureCompaction::parse("25")
        .unwrap()
        .save(home.path())
        .unwrap();
    let settings = PressureCompaction::load(home.path()).unwrap();
    assert!(!settings.should_compact(749, Some(1000)));
    assert!(settings.should_compact(750, Some(1000)));
    assert!(!settings.should_compact(1000, None));
}

#[tokio::test]
async fn compact_numbers_out_of_range_show_usage_and_change_nothing() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;
    PressureCompaction::parse("25")
        .unwrap()
        .save(home.path())
        .unwrap();

    for invalid in ["0", "-1", "70", "100", "NaN", "inf"] {
        chat.dispatch_command_with_args(SlashCommand::Compact, invalid.into(), Vec::new());

        assert_eq!(saved_percent(&home), Some(25.0), "/compact {invalid}");
        let sent = drain(&mut rx);
        assert_eq!(sent.cells, vec![NOT_CHANGED.to_string()], "/compact {invalid}");
        assert!(!sent.ops.iter().any(is_compaction), "/compact {invalid}");
    }
    assert_no_submit_op(&mut ops);
}

#[tokio::test]
async fn typed_compact_text_compacts_now_with_that_guidance() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;
    PressureCompaction::parse("25")
        .unwrap()
        .save(home.path())
        .unwrap();

    type_and_submit(&mut chat, &format!("/compact {GUIDANCE}"));

    let sent = drain(&mut rx);
    let compactions = sent
        .ops
        .iter()
        .filter(|op| is_compaction(op))
        .collect::<Vec<_>>();
    assert_eq!(
        compactions,
        vec![&Op::CompactWithInstructions {
            instructions: GUIDANCE.to_string(),
        }]
    );
    assert!(chat.bottom_pane.is_task_running());
    assert_no_submit_op(&mut ops);
    assert_eq!(saved_percent(&home), Some(25.0), "guidance changed the threshold");
}

#[tokio::test]
async fn bare_compact_stays_upstream_and_carries_no_guidance() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;

    type_and_submit(&mut chat, "/compact");

    let sent = drain(&mut rx);
    let compactions = sent
        .ops
        .iter()
        .filter(|op| is_compaction(op))
        .collect::<Vec<_>>();
    assert_eq!(compactions, vec![&Op::Compact]);
    assert_no_submit_op(&mut ops);
    assert_eq!(saved_percent(&home), None);
}

#[tokio::test]
async fn queued_compact_number_lets_the_next_message_run() {
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;
    handle_turn_started(&mut chat, "turn-1");

    queue_with_tab(&mut chat, "/compact 25");
    queue_with_tab(&mut chat, "continue after the setting");
    complete_turn(&mut chat, "turn-1");

    assert_eq!(saved_percent(&home), Some(25.0));
    assert!(!drain(&mut rx).ops.iter().any(is_compaction));
    match next_submit_op(&mut ops) {
        Op::UserTurn { items, .. } => assert_eq!(
            items,
            vec![UserInput::Text {
                text: "continue after the setting".to_string(),
                text_elements: Vec::new(),
            }]
        ),
        other => panic!("expected the queued follow-up, got {other:?}"),
    }
}

#[tokio::test]
async fn queued_compact_text_compacts_and_holds_the_next_message() {
    // Negative case for the eval above: a real compaction keeps the queue waiting.
    let (mut chat, mut rx, mut ops, home) = chat_with_home().await;
    handle_turn_started(&mut chat, "turn-1");

    queue_with_tab(&mut chat, &format!("/compact {GUIDANCE}"));
    queue_with_tab(&mut chat, "continue after the compaction");
    complete_turn(&mut chat, "turn-1");

    assert!(
        drain(&mut rx).ops.contains(&Op::CompactWithInstructions {
            instructions: GUIDANCE.to_string(),
        })
    );
    assert_no_submit_op(&mut ops);
    assert_eq!(
        chat.queued_user_message_texts(),
        vec!["continue after the compaction"]
    );
    assert_eq!(saved_percent(&home), None);
}

use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

fn line(timestamp: &str, kind: &str, payload: Value) -> String {
    json!({ "timestamp": timestamp, "type": kind, "payload": payload }).to_string()
}

fn usage(input: i64, cached: i64, output: i64) -> Value {
    json!({ "usage": {
        "input_tokens": input, "cached_input_tokens": cached, "cache_write_input_tokens": 0,
        "output_tokens": output, "reasoning_output_tokens": 5, "total_tokens": input + output
    }})
}

/// A turn with a tool call, a cache hit, a Ledger change that breaks the cache, a compaction,
/// and a second turn: every number on the page comes from a recorded line.
fn rollout() -> String {
    [
        line("2026-11-05T10:00:00.000Z", "session_meta", json!({
            "id": "thread-1", "cwd": "/w", "model_provider": "openai",
            "base_instructions": { "text": "You are Elpis." }
        })),
        line("2026-11-05T10:00:00.000Z", "turn_context", json!({ "model": "gpt-6.1-terra" })),
        line("2026-11-05T10:00:00.000Z", "world_state", json!({ "full": true, "state": { "agents_md": {} } })),
        line("2026-11-05T10:00:00.000Z", "event_msg", json!({
            "type": "task_started", "started_at": 1_793_872_800, "model_context_window": 400_000
        })),
        line("2026-11-05T10:00:00.100Z", "response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "# AGENTS.md instructions for /w\n\nrules" }]
        })),
        line("2026-11-05T10:00:00.200Z", "response_item", json!({
            "type": "message", "role": "user",
            "content": [{ "type": "input_text", "text": "List the files" }]
        })),
        line("2026-11-05T10:00:01.000Z", "response_item", json!({
            "type": "function_call", "name": "exec_command",
            "arguments": "{\"cmd\":\"ls\"}", "call_id": "call-1"
        })),
        line("2026-11-05T10:00:02.000Z", "token_usage_record", usage(10_000, 0, 50)),
        line("2026-11-05T10:00:02.500Z", "response_item", json!({
            "type": "function_call_output", "call_id": "call-1", "output": "Exit code: 2\nls: no such file"
        })),
        line("2026-11-05T10:00:04.000Z", "response_item", json!({
            "type": "message", "role": "assistant",
            "content": [{ "type": "output_text", "text": "The folder is empty." }]
        })),
        line("2026-11-05T10:00:04.000Z", "token_usage_record", usage(10_200, 9_000, 20)),
        line("2026-11-05T10:00:05.000Z", "event_msg", json!({
            "type": "task_complete", "time_to_first_token_ms": 700
        })),
        line("2026-11-05T10:01:00.000Z", "world_state", json!({ "full": false, "state": { "agents_md": {} } })),
        line("2026-11-05T10:01:00.000Z", "event_msg", json!({ "type": "task_started", "started_at": 1_793_872_860 })),
        line("2026-11-05T10:01:00.100Z", "response_item", json!({
            "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Again" }]
        })),
        line("2026-11-05T10:01:02.000Z", "response_item", json!({
            "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Done." }]
        })),
        line("2026-11-05T10:01:02.000Z", "token_usage_record", usage(10_400, 1_000, 10)),
        line("2026-11-05T10:01:03.000Z", "compacted", json!({ "message": "Summary of the chat" })),
    ]
    .join("\n")
}

#[test]
fn turns_steps_and_records_follow_the_rollout() {
    let doc = project(&rollout());
    assert_eq!(doc.thread_id, "thread-1");
    assert_eq!(doc.model.as_deref(), Some("gpt-6.1-terra"));
    assert_eq!(doc.context_window, Some(400_000));
    let titles = doc
        .turns
        .iter()
        .map(|turn| {
            (
                turn.turn,
                turn.groups
                    .iter()
                    .map(|group| group.title.clone())
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        titles,
        vec![
            (
                Some(1),
                vec!["Message".into(), "Step 1".into(), "Step 2".into()]
            ),
            (Some(2), vec!["Message".into(), "Step 1".into()]),
            (None, vec!["Compaction 17".into()]),
        ]
    );
    let first = &doc.turns[0];
    let kinds = first.groups[0]
        .cells
        .iter()
        .map(|cell| cell.kind)
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec!["system", "context", "user"],
        "AGENTS.md is context, not the user"
    );
    assert_eq!(first.groups[0].cells[2].opens_turn, Some(true));
    let indexes = doc
        .turns
        .iter()
        .flat_map(|turn| &turn.groups)
        .flat_map(|group| &group.cells)
        .map(|cell| cell.index)
        .collect::<Vec<_>>();
    assert_eq!(indexes, (1..=indexes.len() as u32).collect::<Vec<_>>());
}

#[test]
fn a_tool_call_carries_its_result_timing_and_failure() {
    let doc = project(&rollout());
    let step = &doc.turns[0].groups[1];
    assert_eq!(step.cells[0].kind, "message");
    assert_eq!(step.cells[0].text, "1 tool call");
    let tool = &step.cells[1];
    assert_eq!(tool.kind, "tool");
    assert_eq!(tool.tool_name.as_deref(), Some("exec_command"));
    assert_eq!(tool.result.as_deref(), Some("Exit code: 2"));
    assert_eq!(tool.is_error, Some(true));
    assert_eq!(tool.time_seconds, Some(1.5));
}

#[test]
fn usage_is_disjoint_and_the_first_request_gets_the_recorded_ttft() {
    let doc = project(&rollout());
    let second = &doc.request_numbers[1];
    assert_eq!(
        second.usage,
        Some(Usage {
            input: 1_200,
            cache_read: 9_000,
            cache_write: 0,
            output: 20,
            reasoning: 5
        }),
        "cached input is counted once, outside input"
    );
    assert_eq!(
        second.cache,
        Some(CacheVerdict {
            hit_percent: 88,
            cause: None
        })
    );
    let metrics = doc.turns[0].groups[1].cells[0]
        .assistant_metrics
        .clone()
        .expect("assistant metrics");
    assert_eq!(
        metrics
            .first_token_time
            .zip(metrics.step_start_time)
            .map(|(a, b)| a - b),
        Some(700)
    );
    let later = doc.turns[0].groups[2].cells[0]
        .assistant_metrics
        .clone()
        .expect("metrics");
    assert_eq!(
        later.first_token_time, None,
        "only the turn's first request has a recorded TTFT"
    );
}

#[test]
fn a_cache_break_names_the_recorded_change() {
    let doc = project(&rollout());
    let third = &doc.request_numbers[2];
    assert_eq!(
        third.cache,
        Some(CacheVerdict {
            hit_percent: 10,
            cause: Some("AGENTS.md changed".into())
        })
    );
    assert_eq!(
        doc.request_numbers
            .iter()
            .map(|request| request.number)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
}

#[test]
fn a_partial_last_line_keeps_earlier_turns_and_marks_the_document_truncated() {
    let text = format!("{}\n{{\"timestamp\":", rollout());
    let doc = project(&text);
    assert!(doc.truncated);
    assert_eq!(doc.request_numbers.len(), 3);
}

#[test]
fn rfc3339_timestamps_are_read_as_utc_milliseconds() {
    assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01.500Z"), Some(1_500));
    assert_eq!(
        parse_rfc3339_ms("2026-11-05T10:00:00.000Z"),
        Some(1_793_872_800_000)
    );
    assert_eq!(parse_rfc3339_ms("not a time"), None);
}

#[test]
fn a_smart_prune_checkpoint_is_not_a_compaction() {
    let text = [
        line(
            "2026-11-05T10:00:00.000Z",
            "event_msg",
            json!({ "type": "task_started" }),
        ),
        line(
            "2026-11-05T10:00:01.000Z",
            "compacted",
            json!({ "message": "elpis.context-prune.v1: {\"kept\":3}" }),
        ),
    ]
    .join("\n");
    let doc = project(&text);
    let group = &doc.turns.last().expect("a section").groups[0];
    assert_eq!(group.title, "Smart Prune 1");
    assert_eq!(group.cells[0].text, "Smart Prune checkpoint");
}

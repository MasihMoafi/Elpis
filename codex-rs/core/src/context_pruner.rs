//! Layer 2 of Elpis's context pruning (see `docs/CONTEXT_AND_SESSIONS.md`, "Masih's
//! Ace in the Hole"). This layer handles content that requires judgment — deciding
//! whether a search was a dead end (delete outright, no trace) or found something
//! that matters (keep one evidence-pointer line). That judgment comes from a model
//! call. It is deliberately selective distillation rather than a summary of every
//! action: useful evidence earns one compact conclusion, while dead ends leave no
//! model-visible trace.
//!
//! Trigger: once active context use reaches 1% and uncovered tool output exists, or
//! uncovered tool output reaches 1,000 characters, one pass runs over that batch.
//! Passes chain — each new record is appended after prior ones, never re-compressed.
//! On any failure (model error, timeout, unparseable output) the batch is left alone
//! and the next request's larger uncovered total can retry.

use codex_protocol::models::ContentItem;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ResponseItem;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

/// Model used for the pruning pass — same model and `Medium` reasoning effort as the
/// existing memory-consolidation pass (`memories/write/src/lib.rs`'s `stage_two`),
/// reusing that precedent rather than picking a new pairing.
pub(crate) const PRUNE_MODEL_SLUG: &str = "gpt-5.6-terra";

/// Sentinel the model replies with when nothing in the batch is worth keeping.
/// Kept identical to the instruction in `prompts/templates/context_prune/prompt.md`.
const NOTHING_TO_KEEP: &str = "NOTHING_TO_KEEP";

static PRUNE_PASSES: AtomicUsize = AtomicUsize::new(0);
static PRUNE_SAVED_CHARS: AtomicUsize = AtomicUsize::new(0);

/// Number of Layer 2 pruning passes applied during this Elpis process.
pub fn pass_count() -> usize {
    PRUNE_PASSES.load(Ordering::Relaxed)
}

/// Cumulative chars removed from request context by Layer 2 during this Elpis
/// process.
pub fn saved_chars() -> usize {
    PRUNE_SAVED_CHARS.load(Ordering::Relaxed)
}

/// One completed pruning pass: the evidence-pointer text the model produced (may be
/// empty when the pass kept nothing), plus the exact tool-call ids it covers.
/// Applying a record replaces those items' raw content with a tiny receipt — the
/// record text is what carries "why it mattered" forward, not the raw output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PruneRecord {
    pub(crate) covered_call_ids: Vec<String>,
    pub(crate) text: String,
}

impl PruneRecord {
    fn is_empty(&self) -> bool {
        self.covered_call_ids.is_empty()
    }
}

/// True when active context use reaches 1% and uncovered tool output exists, or when
/// uncovered tool output reaches 1,000 characters.
pub(crate) fn should_prune(used_tokens: i64, uncovered_chars: usize, context_window: i64) -> bool {
    if context_window <= 0 || uncovered_chars == 0 {
        return false;
    }
    let used_percent = (used_tokens.max(0) * 100) / context_window;
    if used_percent >= 1 {
        return true;
    }
    uncovered_chars >= 1_000
}

fn prunable_text(item: &ResponseItem) -> Option<(&str, String)> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        }
        | ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => {
            let text = output.body.to_text()?;
            if text.trim().is_empty() {
                None
            } else {
                Some((call_id.as_str(), text))
            }
        }
        _ => None,
    }
}

/// The current user question is classification context, never part of the deletable
/// batch. Ace needs it to judge whether a tool result mattered.
pub(crate) fn latest_user_message_text(input: &[ResponseItem]) -> Option<String> {
    input.iter().rev().find_map(|item| {
        let ResponseItem::Message { role, content, .. } = item else {
            return None;
        };
        if role != "user" {
            return None;
        }
        let text = content
            .iter()
            .filter_map(|content| match content {
                ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

/// Chars of turn-lifetime tool call/output content in `input` not already covered by
/// a prior record. Only counts what a pass could plausibly do anything about;
/// durable rules, messages, and already-covered items are excluded.
pub(crate) fn uncovered_transient_chars(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> usize {
    input
        .iter()
        .filter_map(prunable_text)
        .filter(|(call_id, _)| !covered_call_ids.contains(*call_id))
        .map(|(_, text)| text.chars().count())
        .sum()
}

/// Snapshot of the batch eligible for one pruning pass: `(call_id, text)` pairs not
/// yet covered by a prior record, oldest first.
pub(crate) fn build_prune_batch(
    input: &[ResponseItem],
    covered_call_ids: &HashSet<String>,
) -> Vec<(String, String)> {
    let operations = input
        .iter()
        .filter_map(|item| match item {
            ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                call_id,
                ..
            } => {
                let tool = namespace
                    .as_deref()
                    .map_or_else(|| name.clone(), |namespace| format!("{namespace}.{name}"));
                Some((
                    call_id.as_str(),
                    format!("tool: {tool}\ninput: {arguments}"),
                ))
            }
            ResponseItem::CustomToolCall {
                name,
                namespace,
                input,
                call_id,
                ..
            } => {
                let tool = namespace
                    .as_deref()
                    .map_or_else(|| name.clone(), |namespace| format!("{namespace}.{name}"));
                Some((call_id.as_str(), format!("tool: {tool}\ninput: {input}")))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();

    input
        .iter()
        .filter_map(prunable_text)
        .filter(|(call_id, _)| !covered_call_ids.contains(*call_id))
        .map(|(call_id, text)| {
            let evidence = match operations.get(call_id) {
                Some(operation) => format!("{operation}\noutput:\n{text}"),
                None => format!("tool: <invocation unavailable>\noutput:\n{text}"),
            };
            (call_id.to_string(), evidence)
        })
        .collect()
}

/// Builds the user-message text sent to the pruning model: each batch entry tagged
/// with its call id so the model's output lines can be matched back to it.
pub(crate) fn build_prune_input(
    batch: &[(String, String)],
    active_question: Option<&str>,
) -> String {
    let question = active_question.unwrap_or("<unavailable>");
    let mut out = format!(
        "<active_user_question>\n{question}\n</active_user_question>\n\
         <evidence_batch>\n"
    );
    for (call_id, text) in batch {
        out.push_str(&format!("--- id: {call_id} ---\n{text}\n"));
    }
    out.push_str("</evidence_batch>\n");
    out
}

/// Parses one pass's raw model output into a record. A line only counts if it starts
/// with an id the batch actually contains — the model does not get to reference ids
/// it wasn't given. Every batch item ends up covered regardless of whether it earned
/// a line: items that didn't matter are deleted outright, not left dangling for a
/// future pass to re-litigate. Returns `None` unless the output is the exact sentinel
/// or every non-empty line has a known, unique id and non-empty conclusion, so the
/// caller leaves the batch alone rather than discarding evidence on a partial reply.
pub(crate) fn parse_prune_output(raw: &str, batch: &[(String, String)]) -> Option<PruneRecord> {
    if batch.is_empty() {
        return None;
    }
    let all_covered = || batch.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();

    if raw.trim() == NOTHING_TO_KEEP {
        return Some(PruneRecord {
            covered_call_ids: all_covered(),
            text: String::new(),
        });
    }

    let known_ids: HashSet<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
    let mut seen_ids = HashSet::new();
    let mut kept_lines = Vec::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Some((id, conclusion)) = line.split_once(':') else {
            return None;
        };
        let id = id.trim();
        if !known_ids.contains(id) || conclusion.trim().is_empty() || !seen_ids.insert(id) {
            return None;
        }
        kept_lines.push(line);
    }

    if kept_lines.is_empty() {
        return None;
    }

    Some(PruneRecord {
        covered_call_ids: all_covered(),
        text: kept_lines.join("\n"),
    })
}

/// Maps each `<id>: <content>` line in a record's text back to its call id, so the
/// per-item receipt below can carry the actual conclusion instead of a generic marker.
fn conclusions_by_call_id(record_text: &str) -> HashMap<&str, &str> {
    record_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(id, rest)| (id.trim(), rest.trim()))
        .collect()
}

/// Applies a validated deletion manifest to model-visible working history.
///
/// A tool result that earned a conclusion becomes a compact receipt with an exact
/// rollout pointer; its paired invocation remains so the operation is still legible.
/// A covered item with no conclusion is a dead end, so both invocation and output are
/// removed entirely. Exact originals remain in the durable rollout.
pub(crate) fn apply_prune_record(input: &mut Vec<ResponseItem>, record: &PruneRecord) -> usize {
    if record.is_empty() {
        return 0;
    }
    let covered: HashSet<&str> = record.covered_call_ids.iter().map(String::as_str).collect();
    let conclusions = conclusions_by_call_id(&record.text);
    let mut saved = 0usize;
    let mut rewritten = Vec::with_capacity(input.len());
    for mut item in std::mem::take(input) {
        let keep = match &mut item {
            ResponseItem::FunctionCall {
                call_id, arguments, ..
            } if covered.contains(call_id.as_str())
                && !conclusions.contains_key(call_id.as_str()) =>
            {
                saved += arguments.chars().count();
                false
            }
            ResponseItem::CustomToolCall { call_id, input, .. }
                if covered.contains(call_id.as_str())
                    && !conclusions.contains_key(call_id.as_str()) =>
            {
                saved += input.chars().count();
                false
            }
            ResponseItem::LocalShellCall {
                call_id: Some(call_id),
                ..
            } if covered.contains(call_id.as_str())
                && !conclusions.contains_key(call_id.as_str()) =>
            {
                false
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            }
            | ResponseItem::CustomToolCallOutput {
                call_id, output, ..
            } if covered.contains(call_id.as_str()) => {
                let Some(conclusion) = conclusions.get(call_id.as_str()) else {
                    saved += output.body.to_text().map_or(0, |text| text.chars().count());
                    continue;
                };
                let Some(text) = output.body.to_text() else {
                    rewritten.push(item);
                    continue;
                };
                let original_chars = text.chars().count();
                let receipt = format!(
                    "[ELPIS CONTEXT UPDATE]\nkept={conclusion}\nevidence=rollout://tool-call/{call_id}\noriginal_chars={original_chars}"
                );
                let new_chars = receipt.chars().count();
                if new_chars < original_chars {
                    saved += original_chars - new_chars;
                    output.body = FunctionCallOutputBody::Text(receipt);
                }
                true
            }
            _ => true,
        };
        if keep {
            rewritten.push(item);
        }
    }
    *input = rewritten;
    PRUNE_PASSES.fetch_add(1, Ordering::Relaxed);
    PRUNE_SAVED_CHARS.fetch_add(saved, Ordering::Relaxed);
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputPayload;

    fn tool_output(call_id: &str, text: &str) -> ResponseItem {
        ResponseItem::FunctionCallOutput {
            id: None,
            call_id: call_id.to_string(),
            output: FunctionCallOutputPayload::from_text(text.to_string()),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn tool_call(call_id: &str, name: &str, arguments: &str) -> ResponseItem {
        ResponseItem::FunctionCall {
            id: None,
            name: name.to_string(),
            namespace: None,
            arguments: arguments.to_string(),
            call_id: call_id.to_string(),
            internal_chat_message_metadata_passthrough: None,
        }
    }

    #[test]
    fn should_prune_respects_threshold() {
        assert!(!should_prune(0, 500, 1_000_000));
        assert!(should_prune(0, 1_000, 1_000_000));

        assert!(should_prune(10_000, 100, 1_000_000));
        assert!(!should_prune(10_000, 0, 1_000_000));
    }

    #[test]
    fn should_prune_false_for_non_positive_context_window() {
        assert!(!should_prune(200_000, 1_000_000, 0));
        assert!(!should_prune(200_000, 1_000_000, -1));
    }

    #[test]
    fn uncovered_transient_chars_excludes_already_covered_and_non_transient_items() {
        use codex_protocol::models::ContentItem;

        let input = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "please grep the repo".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            tool_output("a", "aaaa"),
            tool_output("b", "bb"),
        ];
        // The id-less user message is not prunable, so only tool outputs count.
        let mut covered = HashSet::new();
        assert_eq!(uncovered_transient_chars(&input, &covered), 6);
        covered.insert("a".to_string());
        assert_eq!(uncovered_transient_chars(&input, &covered), 2);
    }

    #[test]
    fn build_prune_batch_skips_covered_ids() {
        let input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"first"}"#),
            tool_output("a", "aaaa"),
            tool_call("b", "exec_command", r#"{"cmd":"second"}"#),
            tool_output("b", "bb"),
        ];
        let covered: HashSet<String> = ["a".to_string()].into_iter().collect();
        let batch = build_prune_batch(&input, &covered);
        assert_eq!(
            batch,
            vec![(
                "b".to_string(),
                "tool: exec_command\ninput: {\"cmd\":\"second\"}\noutput:\nbb".to_string()
            )]
        );
    }

    #[test]
    fn latest_user_message_is_context_but_not_part_of_prune_batch() {
        let input = vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputText {
                    text: "Find the source of the bug.".to_string(),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            tool_output("a", "evidence"),
        ];
        assert_eq!(
            latest_user_message_text(&input).as_deref(),
            Some("Find the source of the bug.")
        );
        assert_eq!(build_prune_batch(&input, &HashSet::new()).len(), 1);
    }

    #[test]
    fn parse_prune_output_accepts_only_known_unique_nonempty_lines() {
        let batch = vec![
            ("a".to_string(), "text a".to_string()),
            ("b".to_string(), "text b".to_string()),
        ];
        let raw = "a: found the answer at foo.rs:10 — this is why it mattered";
        let record = parse_prune_output(raw, &batch).expect("record");
        assert_eq!(
            record.covered_call_ids,
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(record.text.contains("foo.rs:10"));
    }

    #[test]
    fn parse_prune_output_rejects_partly_malformed_or_duplicate_manifests() {
        let batch = vec![
            ("a".to_string(), "text a".to_string()),
            ("b".to_string(), "text b".to_string()),
        ];
        assert_eq!(
            parse_prune_output(
                "a: valid line\nmade-up-id: unknown id must invalidate the pass",
                &batch
            ),
            None
        );
        assert_eq!(
            parse_prune_output("a: first conclusion\na: conflicting conclusion", &batch),
            None
        );
        assert_eq!(parse_prune_output("a:", &batch), None);
    }

    #[test]
    fn parse_prune_output_nothing_to_keep_covers_batch_with_empty_text() {
        let batch = vec![("a".to_string(), "text a".to_string())];
        let record = parse_prune_output("NOTHING_TO_KEEP", &batch).expect("record");
        assert_eq!(record.covered_call_ids, vec!["a".to_string()]);
        assert_eq!(record.text, "");
    }

    #[test]
    fn parse_prune_output_returns_none_on_unusable_reply() {
        let batch = vec![("a".to_string(), "text a".to_string())];
        assert_eq!(
            parse_prune_output("I looked at everything and it's fine.", &batch),
            None
        );
        assert_eq!(parse_prune_output("", &batch), None);
    }

    #[test]
    fn parse_prune_output_returns_none_for_empty_batch() {
        assert_eq!(parse_prune_output(NOTHING_TO_KEEP, &[]), None);
    }

    #[test]
    fn apply_prune_record_replaces_only_covered_items_and_reports_savings() {
        let large = "x".repeat(2_000);
        let mut input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"find X"}"#),
            tool_output("a", &large),
            tool_call("b", "exec_command", r#"{"cmd":"find Y"}"#),
            tool_output("b", &large),
        ];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: "a: found X at foo.rs:1 — mattered because Y".to_string(),
        };

        let saved = apply_prune_record(&mut input, &record);
        assert!(saved > 0);

        let ResponseItem::FunctionCallOutput { output, .. } = &input[1] else {
            panic!("function output");
        };
        let text = output.text_content().expect("text");
        assert!(text.contains("evidence=rollout://tool-call/a"));
        // The whole point of paying for the model pass: its conclusion must survive
        // into the receipt, not just a generic "covered" marker.
        assert!(text.contains("found X at foo.rs:1 — mattered because Y"));

        let ResponseItem::FunctionCallOutput { output, .. } = &input[3] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some(large.as_str()));
    }

    #[test]
    fn apply_prune_record_removes_dead_end_call_and_output_without_a_trace() {
        let large = "x".repeat(2_000);
        let mut input = vec![
            tool_call("a", "exec_command", r#"{"cmd":"useful"}"#),
            tool_output("a", &large),
            tool_call("b", "exec_command", r#"{"cmd":"dead end"}"#),
            tool_output("b", &large),
        ];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string(), "b".to_string()],
            text: "a: found X at foo.rs:1 — mattered because Y".to_string(),
        };

        apply_prune_record(&mut input, &record);

        assert_eq!(input.len(), 2);
        assert!(matches!(
            &input[0],
            ResponseItem::FunctionCall { call_id, .. } if call_id == "a"
        ));
        assert!(matches!(
            &input[1],
            ResponseItem::FunctionCallOutput { call_id, .. } if call_id == "a"
        ));
    }

    #[test]
    fn apply_prune_record_is_a_no_op_for_empty_record() {
        let mut input = vec![tool_output("a", "aaaa")];
        assert_eq!(apply_prune_record(&mut input, &PruneRecord::default()), 0);
        let ResponseItem::FunctionCallOutput { output, .. } = &input[0] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some("aaaa"));
    }

    #[test]
    fn apply_prune_record_never_grows_an_already_small_item() {
        let mut input = vec![tool_output("a", "ok")];
        let record = PruneRecord {
            covered_call_ids: vec!["a".to_string()],
            text: "a: trivial".to_string(),
        };
        assert_eq!(apply_prune_record(&mut input, &record), 0);
        let ResponseItem::FunctionCallOutput { output, .. } = &input[0] else {
            panic!("function output");
        };
        assert_eq!(output.text_content(), Some("ok"));
    }
}

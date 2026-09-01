//! Admission-time semantic optimization for fresh client-side tool output.
//!
//! This module owns only pure eligibility and envelope transformation. The session
//! runner, durable audit, and provider call live under `crate::session::smart_prune`.

use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::ResponseItem;
use codex_utils_string::approx_token_count;
use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;

pub(crate) const MIN_SOURCE_TOKENS: usize = 1_024;
pub(crate) const MIN_SAVED_TOKENS: usize = 256;
pub(crate) const MIN_SAVINGS_PERCENT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AdmissionEvidence<'a> {
    pub(crate) admission_id: &'a str,
    pub(crate) source_sha256: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TransformedToolOutput {
    pub(crate) admitted: ResponseItem,
    pub(crate) source_tokens: usize,
    pub(crate) admitted_tokens: usize,
    pub(crate) saved_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AdmissionDecision {
    Compact { call_id: String, content: String },
    Unchanged { call_id: String },
}

impl AdmissionDecision {
    pub(crate) fn call_id(&self) -> &str {
        match self {
            Self::Compact { call_id, .. } | Self::Unchanged { call_id } => call_id,
        }
    }
}

pub(crate) fn textual_tool_output(item: &ResponseItem) -> Option<(&str, &str)> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        }
        | ResponseItem::CustomToolCallOutput {
            call_id, output, ..
        } => {
            let FunctionCallOutputBody::Text(text) = &output.body else {
                return None;
            };
            Some((call_id, text))
        }
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDecisionManifest {
    items: Vec<RawDecision>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDecision {
    call_id: String,
    decision: RawDecisionKind,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawDecisionKind {
    Compact,
    Unchanged,
}

/// Parses an all-or-nothing manifest. Every expected id must appear exactly once and
/// the returned decisions follow caller order, regardless of model output order.
pub(crate) fn parse_decision_manifest(
    raw: &str,
    expected_call_ids: &[&str],
) -> Option<Vec<AdmissionDecision>> {
    if expected_call_ids.is_empty() {
        return None;
    }
    let expected = expected_call_ids.iter().copied().collect::<HashSet<_>>();
    if expected.len() != expected_call_ids.len() {
        return None;
    }

    let parsed: RawDecisionManifest = serde_json::from_str(raw).ok()?;
    if parsed.items.len() != expected_call_ids.len() {
        return None;
    }

    let mut by_id = HashMap::with_capacity(parsed.items.len());
    for item in parsed.items {
        if !expected.contains(item.call_id.as_str()) || by_id.contains_key(&item.call_id) {
            return None;
        }
        let decision = match (item.decision, item.content) {
            (RawDecisionKind::Compact, Some(content)) if !content.trim().is_empty() => {
                AdmissionDecision::Compact {
                    call_id: item.call_id.clone(),
                    content: content.trim().to_string(),
                }
            }
            (RawDecisionKind::Unchanged, None) => AdmissionDecision::Unchanged {
                call_id: item.call_id.clone(),
            },
            _ => return None,
        };
        by_id.insert(item.call_id, decision);
    }

    expected_call_ids
        .iter()
        .map(|call_id| by_id.remove(*call_id))
        .collect()
}

/// Returns a body-only compact clone when the source is supported and the proposed
/// admission clears the conservative profitability floor. Returning `None` means the
/// caller must admit the source item byte-for-byte.
pub(crate) fn transform_tool_output(
    source: &ResponseItem,
    compact_text: &str,
    evidence: AdmissionEvidence<'_>,
) -> Option<TransformedToolOutput> {
    let compact_text = compact_text.trim();
    if compact_text.is_empty() {
        return None;
    }

    let (call_id, source_text) = textual_tool_output(source)?;

    let source_tokens = approx_token_count(source_text);
    if source_tokens < MIN_SOURCE_TOKENS {
        return None;
    }

    let admitted_text = format!(
        "{compact_text}\n[ELPIS SMART PRUNE]\n\
         exact_source=smart-prune://{}/{call_id}\n\
         source_sha256={}",
        evidence.admission_id, evidence.source_sha256
    );
    let admitted_tokens = approx_token_count(&admitted_text);
    let saved_tokens = source_tokens.saturating_sub(admitted_tokens);
    if saved_tokens < MIN_SAVED_TOKENS
        || saved_tokens.saturating_mul(100)
            < source_tokens.saturating_mul(MIN_SAVINGS_PERCENT)
    {
        return None;
    }

    let mut admitted = source.clone();
    match &mut admitted {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => {
            output.body = FunctionCallOutputBody::Text(admitted_text);
        }
        _ => unreachable!("supported source variant changed after cloning"),
    }

    Some(TransformedToolOutput {
        admitted,
        source_tokens,
        admitted_tokens,
        saved_tokens,
    })
}

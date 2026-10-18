//! Elpis: Smart Prune state the core reports for a thread.
//!
//! Copied from v0.3.0 `protocol/src/protocol.rs`. The app server converts these into the
//! `ThreadSmartPruneSnapshot` family in `app-server-protocol/src/protocol/v2/elpis_context.rs`.

use serde::Deserialize;
use serde::Serialize;

use crate::protocol::TokenUsage;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct SmartPruneSnapshot {
    pub enabled: bool,
    pub examined_outputs: u64,
    pub admitted_outputs: u64,
    pub unchanged_outputs: u64,
    pub failed_batches: u64,
    pub approx_source_tokens: u64,
    pub approx_admitted_tokens: u64,
    pub approx_saved_tokens: u64,
    /// Optimizer calls are accounted separately from the main thread's token usage.
    #[serde(default)]
    pub optimizer_requests: u64,
    /// Number of optimizer calls for which the provider supplied token usage.
    #[serde(default)]
    pub optimizer_usage_reports: u64,
    /// Cumulative provider-reported optimizer usage. A report count of zero means
    /// these zero values are not measurements.
    #[serde(default)]
    pub optimizer_usage: TokenUsage,
    /// Cumulative wall-clock time spent awaiting optimizer calls.
    #[serde(default)]
    pub optimizer_latency_ms: u64,
    pub main_request_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<SmartPruneAdmissionSnapshot>,
    /// Latest optimizer attempt, including unchanged and failed outcomes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_attempt: Option<SmartPruneAttemptSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SmartPruneAttemptSnapshot {
    pub attempt_id: String,
    /// Path relative to the Elpis log directory when exact local evidence was published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_path: Option<String>,
    pub status: String,
    /// Safe explanation for display; raw provider errors remain in the local audit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    pub model_slug: String,
    pub reasoning_effort: String,
    pub candidate_outputs: u64,
    pub admitted_outputs: u64,
    pub approx_saved_tokens: u64,
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SmartPruneAdmissionSnapshot {
    pub admission_id: String,
    /// Path relative to the Elpis log directory; never contains raw tool content.
    pub audit_path: String,
    pub examined_outputs: u64,
    pub admitted_outputs: u64,
    pub approx_source_tokens: u64,
    pub approx_admitted_tokens: u64,
    pub approx_saved_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_input_sha256: Option<String>,
    pub request_linkage_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_usage: Option<TokenUsage>,
    pub response_linkage_verified: bool,
}

/// One completed admission attempt, attached to its tool call in conversation history.
/// Exact output stays in the immutable audit, loaded only when the user opens it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneEvent {
    pub attempt_id: String,
    pub call_id: String,
    pub tool: String,
    #[ts(type = "number")]
    pub occurred_at_ms: i64,
    #[ts(type = "number")]
    pub source_tokens: u64,
    #[ts(type = "number")]
    pub admitted_tokens: u64,
    pub kept: Option<String>,
    pub failure_reason: Option<String>,
}

impl SmartPruneEvent {
    pub fn item_id(&self) -> String {
        format!("smart-prune:{}:{}", self.attempt_id, self.call_id)
    }

    pub fn summary(&self) -> String {
        let clean = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(why) = &self.failure_reason {
            return format!(
                "✂ Smart Prune failed · kept the full output · {}",
                clean(why)
            );
        }
        let tokens = |count: u64| {
            if count >= 1000 {
                format!("{:.1}k", count as f64 / 1000.0)
            } else {
                count.to_string()
            }
        };
        format!(
            "✂ Smart Prune · {} · {} → {} tokens · kept: {}",
            clean(&self.tool),
            tokens(self.source_tokens),
            tokens(self.admitted_tokens),
            clean(self.kept.as_deref().unwrap_or("reason unavailable"))
        )
    }
}

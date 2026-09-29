//! Elpis: Context Ledger and Smart Prune state carried beside a thread's token usage.
//!
//! Copied from v0.3.0 `v2/thread.rs`. The conversions from core snapshots, and the
//! notifications that carry these types, arrive with the engine in Stage 2.

use super::TokenUsageBreakdown;
use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Estimated composition of the exact request built for the latest provider attempt.
/// Values are never padded to reconcile with provider token accounting.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadContextAttribution {
    #[ts(type = "number")]
    pub system_instructions: u64,
    #[ts(type = "number")]
    pub developer_messages: u64,
    #[ts(type = "number")]
    pub user_messages: u64,
    #[ts(type = "number")]
    pub agent_messages: u64,
    #[ts(type = "number")]
    pub reasoning: u64,
    #[ts(type = "number")]
    pub tool_calls: u64,
    #[ts(type = "number")]
    pub tool_results: u64,
    #[ts(type = "number")]
    pub tool_definitions: u64,
    #[ts(type = "number")]
    pub output_schema: u64,
    #[ts(type = "number")]
    pub unrecognized_items: u64,
    #[ts(type = "number")]
    pub estimated_total: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadSmartPruneSnapshot {
    pub enabled: bool,
    #[ts(type = "number")]
    pub examined_outputs: u64,
    #[ts(type = "number")]
    pub admitted_outputs: u64,
    #[ts(type = "number")]
    pub unchanged_outputs: u64,
    #[ts(type = "number")]
    pub failed_batches: u64,
    #[ts(type = "number")]
    pub approx_source_tokens: u64,
    #[ts(type = "number")]
    pub approx_admitted_tokens: u64,
    #[ts(type = "number")]
    pub approx_saved_tokens: u64,
    #[serde(default)]
    #[ts(type = "number")]
    pub optimizer_requests: u64,
    #[serde(default)]
    #[ts(type = "number")]
    pub optimizer_usage_reports: u64,
    #[serde(default = "zero_token_usage")]
    pub optimizer_usage: TokenUsageBreakdown,
    #[serde(default)]
    #[ts(type = "number")]
    pub optimizer_latency_ms: u64,
    #[ts(type = "number")]
    pub main_request_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest: Option<ThreadSmartPruneAdmissionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_attempt: Option<ThreadSmartPruneAttemptSnapshot>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadSmartPruneAttemptSnapshot {
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub audit_path: Option<String>,
    pub status: String,
    pub model_slug: String,
    pub reasoning_effort: String,
    #[ts(type = "number")]
    pub candidate_outputs: u64,
    #[ts(type = "number")]
    pub admitted_outputs: u64,
    #[ts(type = "number")]
    pub approx_saved_tokens: u64,
    #[ts(type = "number")]
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<TokenUsageBreakdown>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadSmartPruneAdmissionSnapshot {
    pub admission_id: String,
    pub audit_path: String,
    #[ts(type = "number")]
    pub examined_outputs: u64,
    #[ts(type = "number")]
    pub admitted_outputs: u64,
    #[ts(type = "number")]
    pub approx_source_tokens: u64,
    #[ts(type = "number")]
    pub approx_admitted_tokens: u64,
    #[ts(type = "number")]
    pub approx_saved_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number", optional)]
    pub request_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub request_input_sha256: Option<String>,
    pub request_linkage_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub response_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub response_usage: Option<TokenUsageBreakdown>,
    pub response_linkage_verified: bool,
}

fn zero_token_usage() -> TokenUsageBreakdown {
    TokenUsageBreakdown {
        total_tokens: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
    }
}

impl Default for ThreadSmartPruneSnapshot {
    fn default() -> Self {
        Self {
            enabled: false,
            examined_outputs: 0,
            admitted_outputs: 0,
            unchanged_outputs: 0,
            failed_batches: 0,
            approx_source_tokens: 0,
            approx_admitted_tokens: 0,
            approx_saved_tokens: 0,
            optimizer_requests: 0,
            optimizer_usage_reports: 0,
            optimizer_usage: zero_token_usage(),
            optimizer_latency_ms: 0,
            main_request_sequence: 0,
            latest: None,
            latest_attempt: None,
        }
    }
}

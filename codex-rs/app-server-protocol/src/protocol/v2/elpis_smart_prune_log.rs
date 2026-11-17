//! Read-only cross-chat Smart Prune audit projection.
use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogListParams {
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogSummary {
    pub attempt_id: String,
    pub thread_id: String,
    pub timestamp: String,
    pub chat_title: String,
    pub turn_id: String,
    #[ts(type = "number | null")]
    pub turn_number: Option<u64>,
    pub model: String,
    pub reasoning_effort: String,
    #[ts(type = "number | null")]
    pub estimated_source_tokens: Option<u64>,
    #[ts(type = "number | null")]
    pub estimated_admitted_tokens: Option<u64>,
    #[ts(type = "number | null")]
    pub estimated_saved_tokens: Option<u64>,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogListResponse {
    pub data: Vec<SmartPruneLogSummary>,
    pub next_cursor: Option<String>,
    #[ts(type = "number")]
    pub unreadable: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogReadParams {
    pub attempt_id: String,
    pub thread_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogItem {
    pub call_id: String,
    pub kept: Option<String>,
    pub description: String,
    #[ts(type = "number")]
    pub estimated_source_tokens: u64,
    #[ts(type = "number")]
    pub estimated_admitted_tokens: u64,
    pub decision: String,
    pub original: String,
    pub compact: Option<String>,
    pub diff: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogRecord {
    #[serde(flatten)]
    #[ts(flatten)]
    pub summary: SmartPruneLogSummary,
    pub items: Vec<SmartPruneLogItem>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SmartPruneLogReadResponse {
    pub record: SmartPruneLogRecord,
}

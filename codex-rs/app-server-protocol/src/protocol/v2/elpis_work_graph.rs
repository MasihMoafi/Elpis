//! Elpis: deterministic work graphs (`workGraph/list`), copied from v0.3.0.
use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkGraphListParams {
    pub root_thread_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkGraphListResponse {
    pub data: Vec<WorkGraphSummary>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkGraphSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    pub max_concurrency: u32,
    pub error: Option<String>,
    pub tasks: Vec<WorkGraphTaskSummary>,
    pub event_count: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkGraphTaskSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub dependencies: Vec<String>,
    pub assigned_thread_id: Option<String>,
    pub result: Option<JsonValue>,
    pub evidence: Vec<String>,
    pub failure_reason: Option<String>,
}

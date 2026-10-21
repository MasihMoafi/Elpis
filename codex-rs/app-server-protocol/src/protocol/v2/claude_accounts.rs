//! Claude subscription accounts owned by the Elpis Claude bridge.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ClaudeAccountsReadParams {}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
#[ts(tag = "action", export_to = "v2/")]
pub enum ClaudeAccountsWriteParams {
    Select {
        id: String,
    },
    Login {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
    },
    Code {
        id: String,
        code: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ClaudeAccount {
    pub id: String,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub authenticated: bool,
    pub duplicate: bool,
    pub signing_in: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ClaudeAccountsReadResponse {
    pub active_id: String,
    pub accounts: Vec<ClaudeAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_url: Option<String>,
}

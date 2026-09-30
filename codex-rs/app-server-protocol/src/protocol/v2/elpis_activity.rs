//! Elpis: per-turn timing and cost state for the dashboard's Activity tab.
//!
//! Copied from v0.3.0 `common.rs`, less what this build never produces: the turn profile
//! breakdown (0.159 reports it only to analytics) and a backend price (no price path is wired,
//! so every turn's cost is unavailable, with the reason). Both notifications carry scalars
//! only, never message content, and are never part of a persisted turn.
//!
//! Plain `//` comments on the types below keep their generated schemas free of descriptions.

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TurnActivityStatus {
    Completed,
    Failed,
    Interrupted,
}

// How a finished turn ended, its start-to-completion time and its time to the first model token,
// in milliseconds, each when known.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TurnActivityUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub status: TurnActivityStatus,
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    #[ts(type = "number | null")]
    pub time_to_first_token_ms: Option<i64>,
}

// Why a turn's cost is unavailable: a subscription login has no per-turn price, and any other
// login gets no price observation in this build.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TurnCostAvailability {
    SubscriptionAuthentication,
    CostObservationDisabled,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type")]
#[ts(export_to = "v2/")]
pub enum TurnCostState {
    Unavailable { reason: TurnCostAvailability },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TurnCostUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub cost: TurnCostState,
}

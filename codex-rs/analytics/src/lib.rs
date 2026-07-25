//! Inert analytics types.
//!
//! Upstream Codex used this crate to POST usage facts to
//! `{chatgpt_base_url}/codex/analytics-events/events`, enabled by default. Elpis
//! removed the delivery path — the reducer, the queue, the HTTP transport, and the
//! debug capture file are all gone, and `AnalyticsEventsClient` is a unit struct
//! whose `track_*` methods drop their input.
//!
//! What remains is the event/fact type surface that ~90 inherited call sites still
//! reference. Those call sites are being excised; until they are, the payload types
//! are constructed and dropped, so most of their fields are legitimately never read.
#![allow(dead_code)]

mod accepted_lines;
mod client;
mod events;
mod facts;

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub use accepted_lines::accepted_line_fingerprints_from_unified_diff;
pub use accepted_lines::fingerprint_hash;
pub use client::AnalyticsEventsClient;
pub use events::AppServerRpcTransport;
pub use events::GuardianApprovalRequestSource;
pub use events::GuardianReviewAnalyticsResult;
pub use events::GuardianReviewDecision;
pub use events::GuardianReviewEventParams;
pub use events::GuardianReviewFailureReason;
pub use events::GuardianReviewSessionAnalyticsParams;
pub use events::GuardianReviewSessionKind;
pub use events::GuardianReviewTerminalStatus;
pub use events::GuardianReviewTrackContext;
pub use events::GuardianReviewedAction;
pub use facts::AcceptedLineFingerprint;
pub use facts::AnalyticsJsonRpcError;
pub use facts::AppInvocation;
pub use facts::CodexCompactionEvent;
pub use facts::CodexErrKind;
pub use facts::CodexGoalEvent;
pub use facts::CodexTurnSteerEvent;
pub use facts::CompactionImplementation;
pub use facts::CompactionPhase;
pub use facts::CompactionReason;
pub use facts::CompactionStatus;
pub use facts::CompactionStrategy;
pub use facts::CompactionTrigger;
pub use facts::ExternalAgentConfigImportCompletedInput;
pub use facts::ExternalAgentConfigImportFailureInput;
pub use facts::GoalEventKind;
pub use facts::HookRunFact;
pub use facts::InputError;
pub use facts::InvocationType;
pub use facts::PluginInstallRequestSource;
pub use facts::PluginInstallRequested;
pub use facts::PluginInstallRequestedPlugin;
pub use facts::PluginInstallSource;
pub use facts::SkillInvocation;
pub use facts::SubAgentThreadStartedInput;
pub use facts::ThreadInitializationMode;
pub use facts::TrackEventsContext;
pub use facts::TurnCodexErrorFact;
pub use facts::TurnProfile;
pub use facts::TurnProfileFact;
pub use facts::TurnResolvedConfigFact;
pub use facts::TurnStatus;
pub use facts::TurnSteerRejectionReason;
pub use facts::TurnSteerRequestError;
pub use facts::TurnSteerResult;
pub use facts::TurnTokenUsageFact;
pub use facts::build_track_events_context;


pub fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn now_unix_millis() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

pub(crate) fn serialize_enum_as_string<T: serde::Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
}

pub(crate) fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

pub(crate) fn option_i64_to_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|value| u64::try_from(value).ok())
}

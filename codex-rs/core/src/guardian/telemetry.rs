//! Descriptors for the guardian review OTEL metrics emitted by
//! [`super::metrics`]. These lived in the deleted analytics crate; the payload
//! fields that only fed the analytics upload are gone, so what remains is what
//! [`super::metrics::emit_guardian_review_metrics`] actually reads.

use codex_protocol::protocol::GuardianAssessmentOutcome;
use codex_protocol::protocol::GuardianRiskLevel;
use codex_protocol::protocol::GuardianUserAuthorization;
use codex_protocol::protocol::TokenUsage;

#[derive(Clone, Copy, Debug)]
pub(crate) enum GuardianReviewDecision {
    Approved,
    Denied,
    Aborted,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GuardianReviewTerminalStatus {
    Approved,
    Denied,
    Aborted,
    TimedOut,
    FailedClosed,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GuardianReviewFailureReason {
    Timeout,
    Cancelled,
    PromptBuildError,
    SessionError,
    ParseError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GuardianReviewSessionKind {
    TrunkNew,
    TrunkReused,
    EphemeralForked,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GuardianApprovalRequestSource {
    /// Approval requested directly by the main Codex turn.
    MainTurn,
    /// Approval requested by a delegated subagent and routed through the parent
    /// session for guardian review.
    DelegatedSubagent,
}

/// Which kind of action was reviewed. Only the discriminant is recorded — the
/// action's own details reach telemetry through the item events, not here.
#[derive(Clone, Copy, Debug)]
pub(crate) enum GuardianReviewedAction {
    Shell,
    UnifiedExec,
    Execve,
    ApplyPatch,
    NetworkAccess,
    McpToolCall,
    RequestPermissions,
}

/// Fields marked `dead_code` are not metric tags; the guardian model-selection
/// and session-reuse tests read them and have no other observation point.
#[derive(Debug)]
pub(crate) struct GuardianReviewMetrics {
    pub(crate) decision: GuardianReviewDecision,
    pub(crate) terminal_status: GuardianReviewTerminalStatus,
    pub(crate) failure_reason: Option<GuardianReviewFailureReason>,
    /// Not a metric tag: read by the guardian retry tests to assert how many
    /// review attempts ran.
    #[allow(dead_code)]
    pub(crate) attempt_count: i64,
    pub(crate) risk_level: Option<GuardianRiskLevel>,
    pub(crate) user_authorization: Option<GuardianUserAuthorization>,
    pub(crate) outcome: Option<GuardianAssessmentOutcome>,
    /// Not a metric tag: read by the guardian session-reuse tests, which have no
    /// other observation point for which thread a review ran on.
    #[allow(dead_code)]
    pub(crate) guardian_thread_id: Option<String>,
    pub(crate) guardian_session_kind: Option<GuardianReviewSessionKind>,
    pub(crate) guardian_model: Option<String>,
    pub(crate) guardian_reasoning_effort: Option<String>,
    #[allow(dead_code)]
    pub(crate) guardian_default_review_model_id: Option<String>,
    #[allow(dead_code)]
    pub(crate) guardian_catalog_contains_auto_review: Option<bool>,
    #[allow(dead_code)]
    pub(crate) guardian_review_model_overridden: Option<bool>,
    #[allow(dead_code)]
    pub(crate) guardian_review_model_override: Option<String>,
    #[allow(dead_code)]
    pub(crate) guardian_model_provider_id: Option<String>,
    pub(crate) had_prior_review_context: Option<bool>,
    pub(crate) reviewed_action_truncated: bool,
    pub(crate) token_usage: Option<TokenUsage>,
    pub(crate) time_to_first_token_ms: Option<u64>,
}

impl GuardianReviewMetrics {
    pub(crate) fn without_session() -> Self {
        Self {
            decision: GuardianReviewDecision::Denied,
            terminal_status: GuardianReviewTerminalStatus::FailedClosed,
            failure_reason: None,
            attempt_count: 1,
            risk_level: None,
            user_authorization: None,
            outcome: None,
            guardian_thread_id: None,
            guardian_session_kind: None,
            guardian_model: None,
            guardian_reasoning_effort: None,
            guardian_default_review_model_id: None,
            guardian_catalog_contains_auto_review: None,
            guardian_review_model_overridden: None,
            guardian_review_model_override: None,
            guardian_model_provider_id: None,
            had_prior_review_context: None,
            reviewed_action_truncated: false,
            token_usage: None,
            time_to_first_token_ms: None,
        }
    }

    pub(crate) fn from_session(params: GuardianReviewSessionMetricsParams) -> Self {
        Self {
            guardian_thread_id: Some(params.guardian_thread_id),
            guardian_session_kind: Some(params.guardian_session_kind),
            guardian_model: Some(params.guardian_model),
            guardian_reasoning_effort: params.guardian_reasoning_effort,
            guardian_default_review_model_id: Some(params.guardian_default_review_model_id),
            guardian_catalog_contains_auto_review: Some(
                params.guardian_catalog_contains_auto_review,
            ),
            guardian_review_model_overridden: Some(params.guardian_review_model_overridden),
            guardian_review_model_override: params.guardian_review_model_override,
            guardian_model_provider_id: Some(params.guardian_model_provider_id),
            had_prior_review_context: Some(params.had_prior_review_context),
            ..Self::without_session()
        }
    }
}

pub(crate) struct GuardianReviewSessionMetricsParams {
    pub(crate) guardian_thread_id: String,
    pub(crate) guardian_session_kind: GuardianReviewSessionKind,
    pub(crate) guardian_model: String,
    pub(crate) guardian_reasoning_effort: Option<String>,
    pub(crate) guardian_default_review_model_id: String,
    pub(crate) guardian_catalog_contains_auto_review: bool,
    pub(crate) guardian_review_model_overridden: bool,
    pub(crate) guardian_review_model_override: Option<String>,
    pub(crate) guardian_model_provider_id: String,
    pub(crate) had_prior_review_context: bool,
}

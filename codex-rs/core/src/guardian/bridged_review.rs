//! Reviews external runtime actions through the native synchronous Guardian host.
use super::runtime::ReviewRuntime;
use super::*;
use codex_guardian_reviewer::GuardianReviewOutcome;
use codex_guardian_reviewer::GuardianReviewSessionLimits;
use codex_guardian_reviewer::ReviewDeadline;
use codex_guardian_reviewer::ReviewHost;
use codex_protocol::approvals::GuardianReviewReason;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::GuardianAssessmentOutcome;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::LegacyAppPathString;

pub(crate) async fn review(
    session: Arc<crate::session::session::Session>,
    command: String,
    cwd: AbsolutePathBuf,
    reason: String,
) -> anyhow::Result<(bool, String)> {
    let turn = session.new_default_turn().await;
    anyhow::ensure!(
        turn.config.approvals_reviewer == ApprovalsReviewer::AutoReview,
        "thread approvals reviewer is not auto_review"
    );
    let context = GuardianReviewContext::from(turn);
    let environment_id = context
        .environments()
        .turn_environments()
        .next()
        .ok_or_else(|| anyhow::anyhow!("thread has no review environment"))?
        .selection
        .environment_id
        .to_string();
    let request = GuardianApprovalRequest::ExecCommand {
        id: new_guardian_review_id(),
        environment_id,
        command: vec!["sh".to_string(), "-lc".to_string(), command],
        guardian_cwd: LegacyAppPathString::from_abs_path(&cwd),
        cwd: cwd.into(),
        sandbox_permissions: crate::sandboxing::SandboxPermissions::RequireEscalated,
        additional_permissions: None,
        justification: Some(reason.clone()),
        tty: false,
    };
    let (_, history_reset) = session.history_reset().await;
    let cancellation = history_reset.child_token();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let attached_reviewer = session
        .services
        .thread_extension_data
        .get::<Arc<dyn crate::guardian_review::AttachedReviewer>>()
        .map(|reviewer| Arc::clone(reviewer.as_ref()).bind());
    let host = ReviewRuntime {
        attached_reviewer,
        session: Arc::clone(&session),
        history_reset,
        context: context.clone(),
        request: request.into(),
        reasons: ApprovalRequestReasons {
            approval: Some(reason),
            retry: None,
        },
        options: GuardianReviewOptions {
            require_guardian: true,
            plugin_attribution_override: None,
            approval_request_source: codex_analytics::GuardianApprovalRequestSource::MainTurn,
            external_cancel: None,
            require_synchronous_review: true,
        },
    };
    let deadline = ReviewDeadline::from_timeout(Some(GUARDIAN_REVIEW_TIMEOUT));
    let (prepared, report) = host
        .prepare(
            &new_guardian_review_id(),
            GuardianReviewReason::Policy,
            deadline,
            &cancellation,
        )
        .await
        .map_err(|decision| anyhow::anyhow!("cannot prepare automatic review: {decision:?}"))?;
    if let Some(event) = report.started_event() {
        host.emit(EventMsg::GuardianAssessment(event)).await;
    }
    let telemetry = &context.turn().session_telemetry;
    let (outcome, analytics, evidence) = codex_guardian_reviewer::run_with_retry(
        GuardianReviewSessionLimits {
            max_attempts: codex_guardian_reviewer::MAX_REVIEW_ATTEMPTS,
            deadline,
        },
        Some(&cancellation),
        Some(telemetry),
        |deadline| host.attempt(&prepared, deadline, &cancellation),
    )
    .await;
    let result = match &outcome {
        GuardianReviewOutcome::Completed(assessment) => Ok((
            assessment.outcome == GuardianAssessmentOutcome::Allow,
            assessment.rationale.clone(),
        )),
        other => Err(anyhow::anyhow!(
            "automatic approval review failed: {other:?}"
        )),
    };
    let completed_at = codex_analytics::now_unix_millis();
    let (completed, elapsed) = report.complete(
        outcome,
        &context.model_info,
        true,
        analytics,
        completed_at.try_into().unwrap_or_default(),
    );
    report.track(
        telemetry,
        &session.services.analytics_events_client,
        completed.analytics,
        completed_at,
        elapsed,
    );
    if let Some(event) = completed.event {
        if let Some(evidence) = evidence {
            host.record_evidence(&prepared, evidence, &event).await;
        }
        host.emit(EventMsg::GuardianAssessment(event)).await;
    }
    result
}

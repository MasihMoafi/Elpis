//! Elpis: permissions accepted after a turn started must bind every later action of that
//! turn and of the work it outlives. Each test names the stale value the defect produced.

use super::*;
use crate::agent::child_config::build_agent_resume_config;
use crate::session::session::SessionSettingsUpdate;
use crate::session::step_settings::StepSettingsUpdate;
use crate::session::tests::HeldStepTask;
use crate::session::tests::make_session_and_context;
use crate::session::thread_settings;
use crate::state::TaskKind;
use codex_mcp::ElicitationReviewRequest;
use codex_protocol::models::ActivePermissionProfile;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE;
use codex_protocol::models::PermissionProfile;
use codex_protocol::protocol::ThreadSettingsOverrides;
use codex_protocol::protocol::TurnAbortReason;
use codex_protocol::protocol::TurnSettingsUpdate;
use codex_protocol::protocol::TurnSettingsUpdateOutcome;
use codex_rmcp_client::ElicitationAction;
use pretty_assertions::assert_eq;
use test_case::test_case;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

fn full_access() -> ThreadSettingsOverrides {
    ThreadSettingsOverrides {
        approval_policy: Some(AskForApproval::Never),
        permission_profile: Some(PermissionProfile::Disabled),
        active_permission_profile: Some(ActivePermissionProfile::new(
            BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS,
        )),
        ..Default::default()
    }
}

fn default_access() -> ThreadSettingsOverrides {
    ThreadSettingsOverrides {
        approval_policy: Some(AskForApproval::OnRequest),
        permission_profile: Some(PermissionProfile::workspace_write()),
        active_permission_profile: Some(ActivePermissionProfile::new(
            BUILT_IN_PERMISSION_PROFILE_WORKSPACE,
        )),
        ..Default::default()
    }
}

fn settings_update(overrides: ThreadSettingsOverrides) -> SessionSettingsUpdate {
    SessionSettingsUpdate {
        step_settings: StepSettingsUpdate {
            approval_policy: overrides.approval_policy,
            ..Default::default()
        },
        permission_profile: overrides.permission_profile,
        active_permission_profile: overrides.active_permission_profile,
        ..Default::default()
    }
}

/// A session whose turn started under `start` and is still running.
async fn running_turn(
    start: ThreadSettingsOverrides,
) -> (Arc<Session>, Arc<TurnContext>, Arc<StepContext>) {
    let (session, _) = make_session_and_context().await;
    let session = Arc::new(session);
    session
        .update_settings(settings_update(start))
        .await
        .expect("starting permissions");
    let turn = session
        .new_turn_with_default_settings("permission-turn".to_string(), Default::default())
        .await;
    let step = session
        .capture_step_context(Arc::clone(&turn), &CancellationToken::new())
        .await
        .expect("capture step");
    session
        .spawn_task(
            Arc::clone(&turn),
            Vec::new(),
            HeldStepTask {
                kind: TaskKind::Regular,
                finish: Arc::new(Notify::new()),
            },
        )
        .await;
    (session, turn, step)
}

fn profile_id(environments: &TurnEnvironmentSnapshot) -> Option<String> {
    environments
        .primary()
        .expect("thread environment")
        .active_permission_profile()
        .map(|profile| profile.id)
}

/// An empty form elicitation, which Full Access approves without review.
fn empty_elicitation() -> ElicitationReviewRequest {
    ElicitationReviewRequest {
        server_name: "permission-test".to_string(),
        request_id: rmcp::model::NumberOrString::Number(1),
        elicitation: codex_rmcp_client::Elicitation::Mcp(
            rmcp::model::ElicitRequestParams::FormElicitationParams {
                meta: None,
                message: "Continue?".to_string(),
                requested_schema: rmcp::model::ElicitationSchema::builder()
                    .build()
                    .expect("schema should build"),
            },
        ),
    }
}

async fn elicitation_action(session: &Arc<Session>) -> Option<ElicitationAction> {
    session.mark_mcp_runtime_dirty();
    session.refresh_mcp_if_dirty().await;
    session
        .mcp_elicitation_reviewer()
        .review(empty_elicitation())
        .await
        .expect("elicitation review")
        .map(|response| response.action)
}

/// Fails before the fix: the MCP elicitation check and the strict-review accessor read the
/// turn's starting Full Access after Default was accepted.
#[tokio::test]
async fn mid_turn_revocation_reaches_every_reader() {
    let (session, turn, step) = running_turn(full_access()).await;
    assert!(
        turn.has_current_full_access(),
        "the turn starts with Full Access"
    );
    assert_eq!(
        elicitation_action(&session).await,
        Some(ElicitationAction::Accept),
        "Full Access approves the elicitation without review"
    );

    thread_settings::update(&session, default_access())
        .await
        .expect("revocation accepted");

    assert!(!turn.has_current_full_access());
    assert_ne!(
        elicitation_action(&session).await,
        Some(ElicitationAction::Accept),
        "a revoked turn must not approve automatically"
    );
    let (_, settings, environments, _) = session
        .active_turn_context_and_strict_auto_review()
        .await
        .expect("active turn");
    assert_eq!(
        (settings.approval_policy(), profile_id(&environments)),
        (
            AskForApproval::OnRequest,
            Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
        )
    );
    let current = session
        .with_current_permissions(step)
        .await
        .expect("tool call step");
    assert_eq!(
        (
            current.settings.approval_policy(),
            profile_id(&current.environments)
        ),
        (
            AskForApproval::OnRequest,
            Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
        )
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

/// Fails before the fix: a child resumed, or reloaded to receive a message, took the
/// permissions the turn started with.
#[test_case(false; "revoked full access")]
#[test_case(true; "granted full access")]
#[tokio::test]
async fn resumed_children_take_permissions_accepted_during_the_turn(grant: bool) {
    let (start, accepted) = if grant {
        (default_access(), full_access())
    } else {
        (full_access(), default_access())
    };
    let expected_policy = accepted.approval_policy.expect("policy");
    let expected_full_access = grant;
    let (session, turn, _) = running_turn(start).await;

    thread_settings::update(&session, accepted)
        .await
        .expect("update accepted");

    let child = build_agent_resume_config(&turn).expect("child config");
    assert_eq!(
        (
            child.permissions.approval_policy.value(),
            matches!(
                child.permissions.permission_profile(),
                PermissionProfile::Disabled
            ),
        ),
        (expected_policy, expected_full_access)
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

async fn accept_thread_reviewer(session: &Session, reviewer: ApprovalsReviewer) {
    thread_settings::update(
        session,
        ThreadSettingsOverrides {
            approvals_reviewer: Some(reviewer),
            ..Default::default()
        },
    )
    .await
    .expect("thread reviewer accepted");
}

async fn accept_live_reviewer(session: &Session, turn: &TurnContext, reviewer: ApprovalsReviewer) {
    assert_eq!(
        session
            .apply_turn_settings(
                &turn.sub_id,
                TurnSettingsUpdate {
                    approvals_reviewer: Some(reviewer),
                    ..Default::default()
                },
            )
            .await,
        TurnSettingsUpdateOutcome::Applied
    );
}

/// Fails before the fix: the turn kept the Elpis reviewer in an overlay that every step
/// reapplied over 0.162's later live reviewer update.
#[test_case(false; "live update after thread update")]
#[test_case(true; "thread update after live update")]
#[tokio::test]
async fn the_reviewer_accepted_last_applies(thread_update_last: bool) {
    let (session, turn, step) = running_turn(default_access()).await;
    if thread_update_last {
        accept_live_reviewer(&session, &turn, ApprovalsReviewer::User).await;
        accept_thread_reviewer(&session, ApprovalsReviewer::AutoReview).await;
    } else {
        accept_thread_reviewer(&session, ApprovalsReviewer::AutoReview).await;
        accept_live_reviewer(&session, &turn, ApprovalsReviewer::User).await;
    }
    let expected = if thread_update_last {
        ApprovalsReviewer::AutoReview
    } else {
        ApprovalsReviewer::User
    };

    let next_step = session
        .capture_step_context(Arc::clone(&turn), &CancellationToken::new())
        .await
        .expect("next step");
    let tool_step = session
        .with_current_permissions(step)
        .await
        .expect("tool call step");
    assert_eq!(
        [
            turn.current_approvals_reviewer(),
            next_step.settings.approvals_reviewer(),
            tool_step.settings.approvals_reviewer(),
        ],
        [expected; 3]
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

/// Fails before the fix: a Code Mode cell created in one turn kept that turn's Full Access
/// for nested calls it made after the thread returned to Default.
#[tokio::test]
async fn a_step_that_outlives_its_turn_takes_the_thread_permissions() {
    let (session, _turn, cell_step) = running_turn(default_access()).await;
    thread_settings::update(&session, full_access())
        .await
        .expect("mid-turn grant accepted");
    let during_turn = session
        .with_current_permissions(Arc::clone(&cell_step))
        .await
        .expect("cell call during its turn");
    assert_eq!(
        during_turn.settings.approval_policy(),
        AskForApproval::Never,
        "the grant reaches the cell while its turn runs"
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;

    thread_settings::update(&session, default_access())
        .await
        .expect("revocation between turns accepted");
    let next_turn = session
        .new_turn_with_default_settings("next-turn".to_string(), Default::default())
        .await;
    session
        .spawn_task(
            next_turn,
            Vec::new(),
            HeldStepTask {
                kind: TaskKind::Regular,
                finish: Arc::new(Notify::new()),
            },
        )
        .await;

    let later_call = session
        .with_current_permissions(cell_step)
        .await
        .expect("cell call in a later turn");
    assert_eq!(
        (
            later_call.settings.approval_policy(),
            profile_id(&later_call.environments)
        ),
        (
            AskForApproval::OnRequest,
            Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
        )
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

/// Fails before the fix: context recorded without an engine turn, as for a Claude or
/// Gemini thread, saved the profile of the thread's last turn with the current policy, so
/// a cold resume restored the wrong permissions.
#[test_case(false; "full access granted")]
#[test_case(true; "full access revoked")]
#[tokio::test]
async fn context_recorded_without_a_turn_saves_accepted_permissions(revoke: bool) {
    let (session, _) = make_session_and_context().await;
    if revoke {
        // A turn under Full Access leaves it as the thread's environment defaults.
        session
            .update_settings(settings_update(full_access()))
            .await
            .expect("full access");
        session
            .new_turn_with_default_settings("full-access-turn".to_string(), Default::default())
            .await;
    }
    let accepted = if revoke {
        default_access()
    } else {
        full_access()
    };
    let expected = (
        accepted.approval_policy.expect("policy"),
        accepted
            .active_permission_profile
            .clone()
            .map(|profile| profile.id),
        !revoke,
    );
    session
        .update_settings(settings_update(accepted))
        .await
        .expect("accepted");

    let item = session
        .new_inject_items_context()
        .await
        .to_turn_context_item();
    let saved = session.thread_settings_snapshot().await;

    assert_eq!(
        (
            item.approval_policy,
            item.active_permission_profile.map(|profile| profile.id),
            matches!(item.permission_profile, Some(PermissionProfile::Disabled)),
        ),
        expected
    );
    assert_eq!(
        (
            saved.approval_policy,
            saved.active_permission_profile.map(|profile| profile.id),
        ),
        (expected.0, expected.1),
        "saved settings and recorded context agree"
    );
}

/// The refresh above must not reach a running turn's environments.
#[tokio::test]
async fn context_recorded_during_a_turn_keeps_the_turn_environments() {
    let (session, _, _) = running_turn(default_access()).await;
    session
        .update_settings(settings_update(full_access()))
        .await
        .expect("full access");

    let _ = session.new_inject_items_context().await;

    assert_eq!(
        profile_id(&session.services.turn_environments.snapshot().await),
        Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

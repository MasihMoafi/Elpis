use super::*;
use crate::session::tests::make_session_and_context;
use codex_protocol::models::ActivePermissionProfile;
use codex_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS;
use pretty_assertions::assert_eq;
use test_case::test_case;

#[derive(Clone, Copy, Debug)]
enum Preset {
    FullAccess,
    Default,
    ReadOnly,
    /// The workspace profile without approval prompts.
    WorkspaceNeverAsk,
}

impl Preset {
    fn policy(self) -> AskForApproval {
        match self {
            Self::FullAccess | Self::WorkspaceNeverAsk => AskForApproval::Never,
            Self::Default | Self::ReadOnly => AskForApproval::OnRequest,
        }
    }

    fn profile_id(self) -> &'static str {
        match self {
            Self::FullAccess => BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS,
            Self::Default | Self::WorkspaceNeverAsk => BUILT_IN_PERMISSION_PROFILE_WORKSPACE,
            Self::ReadOnly => BUILT_IN_PERMISSION_PROFILE_READ_ONLY,
        }
    }

    fn update(self) -> SessionSettingsUpdate {
        let profile = match self {
            Self::FullAccess => PermissionProfile::Disabled,
            Self::Default | Self::WorkspaceNeverAsk => PermissionProfile::workspace_write(),
            Self::ReadOnly => PermissionProfile::read_only(),
        };
        SessionSettingsUpdate {
            step_settings: StepSettingsUpdate {
                approval_policy: Some(self.policy()),
                ..Default::default()
            },
            permission_profile: Some(profile),
            active_permission_profile: Some(ActivePermissionProfile::new(self.profile_id())),
            ..Default::default()
        }
    }
}

async fn configuration(session: &Session, preset: Preset) -> SessionConfiguration {
    let current = session.state.lock().await.session_configuration.clone();
    session
        .apply_session_settings(&current, &preset.update())
        .expect("preset is valid")
}

#[test_case(Preset::FullAccess, Preset::Default, true; "leaving full access")]
#[test_case(Preset::FullAccess, Preset::ReadOnly, true; "leaving full access for read-only")]
#[test_case(Preset::Default, Preset::ReadOnly, true; "narrowing the workspace")]
#[test_case(Preset::Default, Preset::FullAccess, false; "granting full access")]
#[test_case(Preset::ReadOnly, Preset::Default, false; "widening to the workspace")]
#[test_case(Preset::Default, Preset::Default, false; "no change")]
#[test_case(Preset::WorkspaceNeverAsk, Preset::ReadOnly, false; "a policy change is not ordered")]
#[tokio::test]
async fn only_a_provable_removal_reaches_children(from: Preset, to: Preset, removes: bool) {
    let (session, _) = make_session_and_context().await;
    let (from, to) = (
        configuration(&session, from).await,
        configuration(&session, to).await,
    );
    assert_eq!(removes_authority(&from, &to), removes);
}

/// A child is lowered to its parent's new permissions only if that removes authority it
/// holds. Fails if the gate is skipped: the read-only child would gain workspace writes.
#[test_case(Preset::FullAccess, true; "a full access child is lowered")]
#[test_case(Preset::ReadOnly, false; "a read-only child is not raised")]
#[tokio::test]
async fn a_child_follows_only_a_reduction(child: Preset, lowered: bool) {
    let (session, _) = make_session_and_context().await;
    session
        .update_settings(child.update())
        .await
        .expect("child permissions");
    let parent = configuration(&session, Preset::Default).await;

    let changed = session
        .follow_parent_permission_reduction(permission_update(&parent))
        .await
        .expect("valid update");

    let expected = if lowered { Preset::Default } else { child };
    let snapshot = session.thread_config_snapshot().await;
    assert_eq!(
        (
            changed,
            snapshot.approval_policy,
            snapshot.active_permission_profile.map(|profile| profile.id),
        ),
        (
            lowered,
            expected.policy(),
            Some(expected.profile_id().to_string()),
        )
    );
}

async fn profile_id(session: &Session) -> Option<String> {
    session
        .thread_config_snapshot()
        .await
        .active_permission_profile
        .map(|profile| profile.id)
}

/// A child session at `preset`, created as if spawned by a parent.
async fn child_at(preset: Preset) -> Session {
    let (session, _) = make_session_and_context().await;
    session
        .update_settings(preset.update())
        .await
        .expect("child permissions");
    session
}

/// A parent's permissions at `preset`, as a child receives them.
async fn parent_at(child: &Session, preset: Preset) -> SessionSettingsUpdate {
    permission_update(&configuration(child, preset).await)
}

/// Fails if a parent's later grant releases what an existing child owes: the child, which
/// rejected the revocation, would act with Full Access again without ever taking the lower
/// setting.
#[tokio::test]
async fn a_rejected_revocation_stays_owed_after_the_parent_regains_full_access() {
    let child = child_at(Preset::FullAccess).await;
    let parent = Arc::new(Reductions::default());
    let (revoked, regained) = (
        parent_at(&child, Preset::Default).await,
        parent_at(&child, Preset::FullAccess).await,
    );
    // The child's own limits allow only `never`, and it existed at the revocation.
    {
        let mut state = child.state.lock().await;
        Arc::make_mut(&mut state.session_configuration.step_settings).approval_policy =
            crate::config::Constrained::allow_only(AskForApproval::Never);
    }
    child.owe_parent_reductions_from(&parent, /*generation*/ 1);

    let history = vec![revoked.clone()];
    assert!(
        child
            .take_parent_reductions(&parent, history.clone(), revoked)
            .await
            .is_err()
    );
    assert!(
        child
            .take_parent_reductions(&parent, history, regained)
            .await
            .is_err(),
        "the parent regaining Full Access must not release the child"
    );
    let snapshot = child.thread_config_snapshot().await;
    assert_eq!(
        (snapshot.approval_policy, snapshot.permission_profile),
        (AskForApproval::Never, PermissionProfile::Disabled)
    );
}

/// An existing child takes each reduction once, in order, and a parent's later grant does not
/// raise it.
#[tokio::test]
async fn an_existing_child_takes_each_reduction_and_is_not_raised() {
    let child = child_at(Preset::FullAccess).await;
    let parent = Arc::new(Reductions::default());
    let (default, read_only, full_access) = (
        parent_at(&child, Preset::Default).await,
        parent_at(&child, Preset::ReadOnly).await,
        parent_at(&child, Preset::FullAccess).await,
    );
    child.owe_parent_reductions_from(&parent, /*generation*/ 1);

    child
        .take_parent_reductions(&parent, vec![default.clone()], default.clone())
        .await
        .expect("first reduction");
    assert_eq!(
        profile_id(&child).await,
        Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
    );
    let history = vec![default, read_only.clone()];
    child
        .take_parent_reductions(&parent, history.clone(), read_only)
        .await
        .expect("second reduction");
    child
        .take_parent_reductions(&parent, history, full_access)
        .await
        .expect("a grant is not a reduction");
    assert_eq!(
        profile_id(&child).await,
        Some(BUILT_IN_PERMISSION_PROFILE_READ_ONLY.to_string())
    );
}

/// Runs what any background lowering does to a child that started after its parent regained
/// Full Access, more than once and with the earlier revocation still recorded. Fails if work
/// for an older reduction reaches a later child: it would lose the Full Access it inherited.
#[tokio::test]
async fn a_child_started_after_a_grant_keeps_what_it_inherited() {
    let child = child_at(Preset::FullAccess).await;
    let parent = Arc::new(Reductions::default());
    let (revoked, regained) = (
        parent_at(&child, Preset::Default).await,
        parent_at(&child, Preset::FullAccess).await,
    );

    for _ in 0..2 {
        child
            .take_parent_reductions(&parent, vec![revoked.clone()], regained.clone())
            .await
            .expect("nothing owed");
    }

    let snapshot = child.thread_config_snapshot().await;
    assert_eq!(
        (snapshot.approval_policy, snapshot.permission_profile),
        (AskForApproval::Never, PermissionProfile::Disabled)
    );
}

/// A child whose start was in flight when its parent revoked Full Access takes the parent's
/// current permissions when it first meets them.
#[tokio::test]
async fn a_child_started_during_a_revocation_takes_it() {
    let child = child_at(Preset::FullAccess).await;
    let parent = Arc::new(Reductions::default());
    let revoked = parent_at(&child, Preset::Default).await;

    child
        .take_parent_reductions(&parent, vec![revoked.clone()], revoked)
        .await
        .expect("revocation taken");

    assert_eq!(
        profile_id(&child).await,
        Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
    );
}

/// Reductions stay numbered in commit order; a grant between them removes none.
#[tokio::test]
async fn a_grant_keeps_earlier_reductions_recorded() {
    let (session, _) = make_session_and_context().await;
    let (full_access, default, read_only) = (
        configuration(&session, Preset::FullAccess).await,
        configuration(&session, Preset::Default).await,
        configuration(&session, Preset::ReadOnly).await,
    );

    let numbers = [
        session.note_permission_change(&full_access, &default),
        session.note_permission_change(&default, &full_access),
        session.note_permission_change(&full_access, &read_only),
    ];

    assert_eq!(numbers, [Some(1), None, Some(2)]);
    assert_eq!(
        session
            .reductions()
            .history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len(),
        2
    );
}

/// A reloaded parent numbers its reductions afresh. Fails if a child's baseline from the
/// earlier parent record carries over: the reloaded parent's first revocation would be
/// skipped.
#[tokio::test]
async fn a_reloaded_parent_starts_a_fresh_count() {
    let child = child_at(Preset::FullAccess).await;
    let (earlier, reloaded) = (
        Arc::new(Reductions::default()),
        Arc::new(Reductions::default()),
    );
    let full_access = parent_at(&child, Preset::FullAccess).await;
    let revoked = parent_at(&child, Preset::Default).await;
    child
        .take_parent_reductions(
            &earlier,
            vec![full_access.clone(), full_access.clone()],
            full_access,
        )
        .await
        .expect("nothing owed to the earlier record");

    child
        .take_parent_reductions(&reloaded, vec![revoked.clone()], revoked)
        .await
        .expect("revocation taken");

    assert_eq!(
        profile_id(&child).await,
        Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
    );
}

#[tokio::test]
async fn a_reloaded_parent_does_not_clear_an_owed_revocation() {
    let child = child_at(Preset::FullAccess).await;
    let earlier = Arc::new(Reductions::default());
    let revoked = parent_at(&child, Preset::Default).await;
    let regained = parent_at(&child, Preset::FullAccess).await;
    {
        let mut state = child.state.lock().await;
        Arc::make_mut(&mut state.session_configuration.step_settings).approval_policy =
            crate::config::Constrained::allow_only(AskForApproval::Never);
    }
    earlier.history.lock().unwrap().push(revoked);
    child.owe_parent_reductions_from(&earlier, /*generation*/ 1);
    drop(earlier);

    assert!(
        child
            .take_parent_reductions(&Arc::new(Reductions::default()), vec![], regained)
            .await
            .is_err(),
        "a fresh parent record must not erase an existing child's pending restriction"
    );
}

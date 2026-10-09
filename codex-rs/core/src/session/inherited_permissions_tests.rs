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

/// Fails if a rejected reduction counted as applied: the child would keep Full Access for
/// every later action instead of failing each one.
#[tokio::test]
async fn a_reduction_the_child_rejects_stays_pending() {
    let (session, _) = make_session_and_context().await;
    session
        .update_settings(Preset::FullAccess.update())
        .await
        .expect("full access");
    let parent = permission_update(&configuration(&session, Preset::Default).await);
    // The child's own limits allow only `never`.
    {
        let mut state = session.state.lock().await;
        Arc::make_mut(&mut state.session_configuration.step_settings).approval_policy =
            crate::config::Constrained::allow_only(AskForApproval::Never);
    }

    for _ in 0..2 {
        assert!(
            session
                .apply_parent_reduction(/*generation*/ 1, parent.clone())
                .await
                .is_err()
        );
    }
    let snapshot = session.thread_config_snapshot().await;
    assert_eq!(
        (snapshot.approval_policy, snapshot.permission_profile),
        (AskForApproval::Never, PermissionProfile::Disabled)
    );
}

/// Each numbered reduction applies once, so a late delivery of an older one changes nothing.
#[tokio::test]
async fn a_parent_reduction_applies_once() {
    let (session, _) = make_session_and_context().await;
    session
        .update_settings(Preset::FullAccess.update())
        .await
        .expect("full access");
    let default = permission_update(&configuration(&session, Preset::Default).await);
    let read_only = permission_update(&configuration(&session, Preset::ReadOnly).await);

    session
        .apply_parent_reduction(/*generation*/ 1, default)
        .await
        .expect("first reduction");
    session
        .apply_parent_reduction(/*generation*/ 1, read_only.clone())
        .await
        .expect("already applied");
    assert_eq!(
        profile_id(&session).await,
        Some(BUILT_IN_PERMISSION_PROFILE_WORKSPACE.to_string())
    );
    session
        .apply_parent_reduction(/*generation*/ 2, read_only)
        .await
        .expect("second reduction");
    assert_eq!(
        profile_id(&session).await,
        Some(BUILT_IN_PERMISSION_PROFILE_READ_ONLY.to_string())
    );
}

/// A reduction is numbered for children until the thread provably gains authority again.
/// Fails if a later grant leaves the old reduction pending: a child started with the new Full
/// Access would be lowered to the old reduction on its first tool call.
#[tokio::test]
async fn a_later_grant_forgets_the_pending_reduction() {
    let (session, _) = make_session_and_context().await;
    let (full_access, default, read_only) = (
        configuration(&session, Preset::FullAccess).await,
        configuration(&session, Preset::Default).await,
        configuration(&session, Preset::ReadOnly).await,
    );
    let pending = |session: &Session| {
        let reductions = session.reductions();
        let latest = reductions
            .latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        (latest.generation, latest.updates.is_some())
    };

    assert!(
        session
            .note_permission_change(&full_access, &default)
            .is_some()
    );
    assert_eq!(pending(&session), (1, true));
    assert!(
        session
            .note_permission_change(&default, &full_access)
            .is_none()
    );
    assert_eq!(pending(&session), (1, false));
    assert_eq!(
        session
            .note_permission_change(&full_access, &read_only)
            .map(|(generation, _)| generation),
        Some(2)
    );
}

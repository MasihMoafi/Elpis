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

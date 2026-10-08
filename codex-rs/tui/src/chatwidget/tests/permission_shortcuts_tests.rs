use super::permissions::requirements_stack;
use super::*;
use ApprovalsReviewer::AutoReview;
use ApprovalsReviewer::User;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn permission_shortcuts_cycle_builtin_modes() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ true);
    chat.chat_keymap.next_permission_mode = vec![crate::key_hint::plain(KeyCode::F(8))];
    chat.chat_keymap.previous_permission_mode = vec![crate::key_hint::plain(KeyCode::F(7))];
    #[cfg(target_os = "windows")]
    {
        chat.set_windows_sandbox_mode(Some(WindowsSandboxSetupMode::Unelevated));
    }
    for (current, reviewer, key, expected, next_reviewer) in [
        (":workspace", User, KeyCode::F(8), ":workspace", AutoReview),
        (":workspace", AutoReview, KeyCode::F(8), ":read-only", User),
        (":read-only", User, KeyCode::F(8), ":workspace", User),
        (":read-only", User, KeyCode::F(7), ":workspace", AutoReview),
    ] {
        let profile = if current == ":read-only" {
            PermissionProfile::read_only()
        } else {
            PermissionProfile::workspace_write()
        };
        chat.config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
                profile,
                ActivePermissionProfile::new(current),
            ))
            .expect("set current profile");
        chat.config.approvals_reviewer = reviewer;
        chat.handle_key_event(KeyEvent::from(key));
        chat.handle_key_event(KeyEvent::from(key));
        let AppEvent::ApplyPermissionShortcut {
            thread_id: target,
            selection,
        } = rx.try_recv().expect("permission selection")
        else {
            panic!("expected one typed permission selection");
        };
        assert_eq!(
            (
                target,
                selection.profile_id.as_str(),
                selection.approval_policy,
                selection.approvals_reviewer
            ),
            (
                thread_id,
                expected,
                Some(AskForApproval::OnRequest),
                Some(next_reviewer)
            )
        );
        assert!(
            rx.try_recv().is_err(),
            "pending shortcut must not be duplicated"
        );
        chat.complete_permission_shortcut(thread_id);
    }
    #[cfg(target_os = "windows")]
    {
        chat.set_windows_sandbox_mode(/*mode*/ None);
        chat.config
            .permissions
            .set_permission_profile(PermissionProfile::read_only())
            .unwrap();
        chat.config.approvals_reviewer = User;
        chat.handle_key_event(KeyEvent::from(KeyCode::F(8)));
        assert!(matches!(
            rx.try_recv(),
            Ok(AppEvent::ApplyPermissionShortcut {
                selection: PermissionProfileSelection {
                    approvals_reviewer: Some(AutoReview),
                    ..
                },
                ..
            })
        ));
        assert!(rx.try_recv().is_err());
        chat.complete_permission_shortcut(thread_id);
        chat.windows_sandbox_host = crate::app::WindowsSandboxHost::Remote;
        chat.handle_key_event(KeyEvent::from(KeyCode::F(8)));
        assert!(matches!(
            rx.try_recv(),
            Ok(AppEvent::ApplyPermissionShortcut {
                selection: PermissionProfileSelection {
                    profile_id,
                    approvals_reviewer: Some(User),
                    ..
                },
                ..
            }) if profile_id == ":workspace"
        ));
    }
}

#[tokio::test]
async fn permission_shortcuts_respect_managed_mode_requirements() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ true);
    chat.config.approvals_reviewer = AutoReview;
    chat.chat_keymap.next_permission_mode = vec![crate::key_hint::plain(KeyCode::F(8))];
    chat.config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
            PermissionProfile::workspace_write(),
            ActivePermissionProfile::new(":workspace"),
        ))
        .expect("set active profile");

    for requirements in [
        codex_config::ConfigRequirementsToml {
            allowed_approvals_reviewers: Some(vec![AutoReview]),
            ..Default::default()
        },
        codex_config::ConfigRequirementsToml {
            auto_review: Some(codex_config::AutoReviewRequirementsToml {
                required_on_models: Some(vec![chat.current_model().to_string()]),
                ..Default::default()
            }),
            ..Default::default()
        },
    ] {
        chat.config.config_layer_stack = requirements_stack(requirements);
        chat.handle_key_event(KeyEvent::from(KeyCode::F(8)));
        let AppEvent::InsertHistoryCell(cell) = rx.try_recv().expect("unavailable-mode notice")
        else {
            panic!("must not submit a forbidden mode");
        };
        insta::assert_snapshot!(
            "permission_shortcut_no_alternative",
            lines_to_single_string(&cell.display_lines(/*width*/ 80))
        );
        assert!(rx.try_recv().is_err(), "must not submit a forbidden mode");
    }
}

/// Elpis: Shift+Tab cycles the permission modes, Full Access included, as in v0.3.0, through the
/// same selection flow as the permission shortcuts. Negative: it no longer switches Plan mode.
#[tokio::test]
async fn shift_tab_cycles_permission_modes_including_full_access() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let thread_id = ThreadId::new();
    chat.thread_id = Some(thread_id);
    chat.config.approvals_reviewer = User;
    // Without auto-review, Default is followed directly by Full Access.
    chat.set_feature_enabled(Feature::GuardianApproval, /*enabled*/ false);
    let mode_before = chat.active_mode_kind();
    let full_access = codex_utils_approval_presets::builtin_approval_presets()
        .into_iter()
        .find(|preset| preset.id == "full-access")
        .expect("full access preset");
    let mut next_after = |chat: &mut ChatWidget| {
        chat.handle_key_event(KeyEvent::from(KeyCode::BackTab));
        let AppEvent::ApplyPermissionShortcut { selection, .. } =
            rx.try_recv().expect("permission selection")
        else {
            panic!("expected one permission selection");
        };
        chat.complete_permission_shortcut(thread_id);
        selection
    };

    // From Default (the workspace mode), the next mode is Full Access.
    chat.config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
            PermissionProfile::workspace_write(),
            ActivePermissionProfile::new(":workspace"),
        ))
        .expect("set default profile");
    chat.config.permissions.approval_policy =
        codex_config::Constrained::allow_any(AskForApproval::OnRequest.to_core());
    let selection = next_after(&mut chat);
    assert_eq!(
        (selection.profile_id.as_str(), selection.approval_policy),
        (
            full_access.active_permission_profile.id.as_str(),
            Some(AskForApproval::Never)
        )
    );

    // From Full Access, it wraps round to a sandboxed mode that asks.
    chat.config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::active(
            full_access.permission_profile.clone(),
            full_access.active_permission_profile.clone(),
        ))
        .expect("set full access profile");
    chat.config.permissions.approval_policy =
        codex_config::Constrained::allow_any(AskForApproval::Never.to_core());
    let selection = next_after(&mut chat);
    assert_ne!(selection.profile_id, full_access.active_permission_profile.id);
    assert_eq!(selection.approval_policy, Some(AskForApproval::OnRequest));

    assert_eq!(chat.active_mode_kind(), mode_before);
}

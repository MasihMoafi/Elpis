//! Worktree picker behavior and rendered choices.

use super::*;

#[tokio::test]
async fn slash_new_and_fork_offer_checkout_choices_inside_local_git_repository() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.set_feature_enabled(Feature::Worktrees, /*enabled*/ false);
    let checkout = tempdir().expect("temporary checkout");
    std::fs::create_dir(checkout.path().join(".git")).expect("git directory");
    std::fs::write(checkout.path().join(".git/HEAD"), "ref: refs/heads/main\n").expect("git HEAD");
    chat.config.cwd =
        AbsolutePathBuf::from_absolute_path(checkout.path()).expect("absolute checkout");

    chat.dispatch_command(SlashCommand::Fork);
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::ForkCurrentSession { name: None })
    );
    chat.dispatch_command(SlashCommand::New);
    assert_matches!(rx.try_recv(), Ok(AppEvent::NewSession { name: None }));

    chat.set_feature_enabled(Feature::Worktrees, /*enabled*/ true);
    chat.dispatch_command(SlashCommand::Fork);

    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("worktrees_fork_choices", popup);
    chat.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    chat.dispatch_command(SlashCommand::New);
    let popup = render_bottom_popup(&chat, /*width*/ 80);
    assert_chatwidget_snapshot!("worktrees_new_choices", popup);
    assert!(popup.contains("Current checkout"), "popup: {popup}");
    assert!(popup.contains("New worktree"), "popup: {popup}");
    assert_matches!(rx.try_recv(), Err(TryRecvError::Empty));
    chat.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
    chat.bottom_pane
        .set_composer_text("/new named".into(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_matches!(rx.try_recv(), Ok(AppEvent::FollowTranscript));
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('1'), KeyModifiers::NONE));
    assert_matches!(rx.try_recv(), Ok(AppEvent::NewSession { name: Some(name) }) if name == "named");
    chat.bottom_pane
        .set_composer_text("/fork named".into(), Vec::new(), Vec::new());
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_matches!(rx.try_recv(), Ok(AppEvent::FollowTranscript));
    chat.handle_key_event(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE));
    assert_matches!(rx.try_recv(), Ok(AppEvent::StartManagedWorktree {
        mode: crate::app_event::ManagedWorktreeMode::Fork,
        name: Some(name),
    }) if name == "named");
    chat.set_local_worktree_operations(/*enabled*/ false);
    chat.dispatch_command(SlashCommand::New);
    assert_matches!(rx.try_recv(), Ok(AppEvent::NewSession { name: None }));
    chat.dispatch_command(SlashCommand::Fork);
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::ForkCurrentSession { name: None })
    );
}

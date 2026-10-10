use super::*;

#[tokio::test]
async fn elpis_delete_shortcut_opens_confirmation_without_deleting() {
    let mut state = PickerState::new(
        FrameRequester::test_dummy(),
        Arc::new(|_| panic!("The prompt must not send a request")),
        ProviderFilter::Any,
        true,
        None,
        SessionPickerAction::Resume,
    );
    state.all_rows = vec![Row {
        path: None,
        preview: "Saved answer".into(),
        thread_id: Some(ThreadId::new()),
        thread_name: Some("Lawera retrieval".into()),
        created_at: None,
        updated_at: None,
        cwd: None,
        git_branch: None,
    }];
    state.apply_filter();

    let hints = footer_hint_lines(&state, 220)
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(hints.contains("backspace delete"), "{hints}");
    assert!(
        state
            .handle_key(KeyEvent::from(KeyCode::Backspace))
            .await
            .unwrap()
            .is_none()
    );
    let hints = footer_hint_lines(&state, 220)
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(hints.contains("y delete"), "{hints}");
    assert_eq!(state.filtered_rows.len(), 1);
}

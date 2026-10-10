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

use super::delete::DeleteState;
use std::sync::Mutex;

fn delete_picker() -> (PickerState, Arc<Mutex<Vec<ThreadId>>>, ThreadId) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let sink = requests.clone();
    let mut state = PickerState::new(
        FrameRequester::test_dummy(),
        Arc::new(move |request| {
            if let PickerLoadRequest::Delete { thread_id } = request {
                sink.lock().unwrap().push(thread_id);
            }
        }),
        ProviderFilter::Any,
        true,
        None,
        SessionPickerAction::Resume,
    );
    let thread_id = ThreadId::new();
    state.ingest_page(PickerPage {
        rows: vec![delete_row(thread_id, "Lawera retrieval")],
        history_modes: HashMap::new(),
        next_cursor: None,
        num_scanned_files: 1,
        reached_scan_cap: false,
    });
    (state, requests, thread_id)
}

fn delete_row(thread_id: ThreadId, label: &str) -> Row {
    Row {
        path: None,
        preview: "Saved answer".into(),
        thread_id: Some(thread_id),
        thread_name: Some(label.into()),
        created_at: None,
        updated_at: None,
        cwd: None,
        git_branch: None,
    }
}

fn footer(state: &PickerState, width: u16) -> String {
    footer_hint_lines(state, width)
        .into_iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn elpis_delete_cancel_preserves_search_selection_and_session() {
    for key in [
        KeyCode::Esc,
        KeyCode::Enter,
        KeyCode::Char('n'),
        KeyCode::Char('N'),
    ] {
        let (mut state, requests, thread_id) = delete_picker();
        state
            .handle_key(KeyEvent::from(KeyCode::Backspace))
            .await
            .unwrap();
        state.handle_paste("Accidental paste".into());
        state
            .handle_key(KeyEvent::from(KeyCode::Down))
            .await
            .unwrap();
        state.handle_key(KeyEvent::from(key)).await.unwrap();
        assert_eq!(state.delete_state, DeleteState::Idle);
        assert!(state.query.is_empty());
        assert_eq!(
            state.filtered_rows[state.selected].thread_id,
            Some(thread_id)
        );
        assert!(requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn elpis_delete_yes_sends_once_and_keeps_target_until_server_success() {
    let (mut state, requests, thread_id) = delete_picker();
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    for key in [
        KeyCode::Char('y'),
        KeyCode::Char('y'),
        KeyCode::Enter,
        KeyCode::Char('d'),
    ] {
        assert!(
            state
                .handle_key(KeyEvent::from(key))
                .await
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(*requests.lock().unwrap(), vec![thread_id]);
    assert_eq!(state.filtered_rows.len(), 1);
    state
        .handle_background_event(BackgroundEvent::Delete {
            thread_id,
            result: Ok(()),
        })
        .await
        .unwrap();
    assert!(state.filtered_rows.is_empty());
    assert_eq!(state.delete_state, DeleteState::Idle);
}

#[tokio::test]
async fn elpis_delete_failure_keeps_row_and_allows_retry() {
    let (mut state, requests, thread_id) = delete_picker();
    state.request_delete_for_selected_session();
    state
        .handle_key(KeyEvent::from(KeyCode::Char('y')))
        .await
        .unwrap();
    state
        .handle_background_event(BackgroundEvent::Delete {
            thread_id,
            result: Err(std::io::Error::other("thread has an active writer")),
        })
        .await
        .unwrap();
    assert_eq!(
        state.inline_error.as_deref(),
        Some("Failed to delete session: thread has an active writer")
    );
    assert_eq!(state.filtered_rows.len(), 1);
    state.request_delete_for_selected_session();
    state
        .handle_key(KeyEvent::from(KeyCode::Char('y')))
        .await
        .unwrap();
    assert_eq!(*requests.lock().unwrap(), vec![thread_id, thread_id]);
}

#[tokio::test]
async fn elpis_delete_rejects_current_session_empty_rows_and_busy_archive() {
    let (mut state, requests, thread_id) = delete_picker();
    state.launch_context = SessionPickerLaunchContext::ExistingSession {
        current_thread_id: Some(thread_id),
    };
    state.request_delete_for_selected_session();
    assert_eq!(state.delete_state, DeleteState::Idle);
    assert!(
        state
            .inline_error
            .as_ref()
            .unwrap()
            .contains("Close this session")
    );
    state.launch_context = SessionPickerLaunchContext::Startup;
    state.archive_state = super::archive::ArchiveState::Pending { thread_id };
    state.request_delete_for_selected_session();
    assert_eq!(state.delete_state, DeleteState::Idle);
    state.archive_state = super::archive::ArchiveState::Idle;
    state.filtered_rows.clear();
    state.request_delete_for_selected_session();
    assert_eq!(state.delete_state, DeleteState::Idle);
    assert!(!footer(&state, 220).contains("backspace delete"));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn elpis_delete_respects_custom_backspace_navigation_and_fork_picker() {
    let (mut state, requests, _thread_id) = delete_picker();
    let next_thread = ThreadId::new();
    state
        .all_rows
        .push(delete_row(next_thread, "Other saved session"));
    state.apply_filter();
    state.keymap.list.page_down = vec![crate::key_hint::plain(KeyCode::Backspace)];
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    assert_eq!(state.delete_state, DeleteState::Idle);
    assert!(!footer(&state, 220).contains("backspace delete"));
    assert_eq!(
        state.filtered_rows[state.selected].thread_id,
        Some(next_thread)
    );
    state.keymap = RuntimeKeymap::defaults();
    state.action = SessionPickerAction::Fork;
    state.request_delete_for_selected_session();
    assert_eq!(state.delete_state, DeleteState::Idle);
    assert!(!footer(&state, 220).contains("backspace delete"));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn elpis_delete_confirmation_ignores_repeats_and_modified_yes() {
    let (mut state, requests, _thread_id) = delete_picker();
    state.request_delete_for_selected_session();
    for event in [
        KeyEvent::new_with_kind(KeyCode::Char('y'), KeyModifiers::NONE, KeyEventKind::Repeat),
        KeyEvent::new_with_kind(
            KeyCode::Char('y'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ),
        KeyEvent::new(KeyCode::Char('y'), KeyModifiers::CONTROL),
        KeyEvent::new(KeyCode::Char('y'), KeyModifiers::ALT),
    ] {
        state.handle_key(event).await.unwrap();
    }
    assert!(requests.lock().unwrap().is_empty());
    assert!(matches!(state.delete_state, DeleteState::Confirming { .. }));
    state
        .handle_key(KeyEvent::new(KeyCode::Char('Y'), KeyModifiers::SHIFT))
        .await
        .unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn elpis_delete_success_preserves_other_selection_and_rejects_stale_page() {
    let (mut state, _requests, thread_id) = delete_picker();
    let other_id = ThreadId::new();
    state
        .all_rows
        .push(delete_row(other_id, "Other saved session"));
    state.apply_filter();
    state.request_delete_for_selected_session();
    state
        .handle_key(KeyEvent::from(KeyCode::Char('y')))
        .await
        .unwrap();
    state
        .transcript_previews
        .insert(thread_id, TranscriptPreviewState::Loaded(vec![]));
    state
        .thread_history_modes
        .insert(thread_id, ThreadHistoryMode::Legacy);
    state.expanded_thread_id = Some(thread_id);
    state
        .handle_background_event(BackgroundEvent::Delete {
            thread_id,
            result: Ok(()),
        })
        .await
        .unwrap();
    assert_eq!(state.filtered_rows.len(), 1);
    assert_eq!(
        state.filtered_rows[state.selected].thread_id,
        Some(other_id)
    );
    assert!(!state.transcript_previews.contains_key(&thread_id));
    assert!(!state.thread_history_modes.contains_key(&thread_id));
    assert!(state.expanded_thread_id.is_none());
    state.ingest_page(PickerPage {
        rows: vec![delete_row(thread_id, "Lawera retrieval")],
        history_modes: HashMap::new(),
        next_cursor: None,
        num_scanned_files: 1,
        reached_scan_cap: false,
    });
    assert_eq!(state.filtered_rows.len(), 1);
    assert_eq!(state.filtered_rows[0].thread_id, Some(other_id));
}

#[test]
fn elpis_delete_prompt_renders_target_warning_and_cancel_keys() {
    use crate::custom_terminal::Terminal;
    use crate::test_backend::VT100Backend;
    let (mut state, _requests, _thread_id) = delete_picker();
    for width in [40, 80, 120] {
        state.request_delete_for_selected_session();
        let backend = VT100Backend::new(width, 18);
        let mut terminal = Terminal::with_options(backend).unwrap();
        terminal.set_viewport_area(Rect::new(0, 0, width, 18));
        {
            let mut frame = terminal.get_frame();
            super::layout::render(&mut frame, &state);
        }
        terminal.flush().unwrap();
        let screen = terminal.backend().vt100().screen().contents();
        println!("Delete prompt at {width} columns:\n{screen}\n");
        assert!(screen.contains("Lawera retrieval"), "{screen}");
        assert!(screen.contains("subagent"), "{screen}");
        assert!(screen.contains("cannot undo"), "{screen}");
        assert!(screen.contains("y delete"), "{screen}");
        assert!(screen.contains("cancel"), "{screen}");
        assert!(!screen.contains("enter resume"), "{screen}");
        state.delete_state = DeleteState::Idle;
    }
}

#[tokio::test]
async fn elpis_delete_picker_uses_real_delete_rpc_and_preserves_other_chat()
-> color_eyre::Result<()> {
    use crate::legacy_core::config::ConfigBuilder;
    use app_test_support::{create_fake_rollout, rollout_path};
    use codex_config::LoaderOverrides;
    use tempfile::TempDir;
    for archived in [false, true] {
        let home = TempDir::new()?;
        let config = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .loader_overrides(LoaderOverrides::without_managed_config_for_tests())
            .build()
            .await?;
        let timestamp = "2025-01-05T12-00-00";
        let target_id = create_fake_rollout(
            home.path(),
            timestamp,
            "2025-01-05T12:00:00Z",
            "Delete marker",
            Some(config.model_provider_id.as_str()),
            None,
        )
        .map_err(std::io::Error::other)?;
        let mut target_path = rollout_path(home.path(), timestamp, &target_id);
        if archived {
            let dir = home.path().join("archived_sessions");
            std::fs::create_dir_all(&dir)?;
            let archived_path = dir.join(target_path.file_name().unwrap());
            std::fs::rename(&target_path, &archived_path)?;
            target_path = archived_path;
        }
        let other_id = create_fake_rollout(
            home.path(),
            timestamp,
            "2025-01-05T12:00:00Z",
            "Keep marker",
            Some(config.model_provider_id.as_str()),
            None,
        )
        .map_err(std::io::Error::other)?;
        let other_path = rollout_path(home.path(), timestamp, &other_id);
        let other_bytes = std::fs::read(&other_path)?;
        let app_server = crate::start_embedded_app_server_for_picker(&config).await?;
        let handle = app_server.request_handle();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let loader = spawn_app_server_page_loader(
            false,
            app_server,
            handle,
            false,
            RawReasoningVisibility::Hidden,
            Some(config),
            tx,
        );
        let mut state = PickerState::new(
            FrameRequester::test_dummy(),
            loader,
            ProviderFilter::Any,
            true,
            None,
            SessionPickerAction::Resume,
        );
        let thread_id = ThreadId::from_string(&target_id)?;
        state.all_rows = vec![delete_row(thread_id, "Disposable test session")];
        state.apply_filter();
        state.status = if archived {
            SessionStatus::Archived
        } else {
            SessionStatus::Active
        };
        state.handle_key(KeyEvent::from(KeyCode::Backspace)).await?;
        state.handle_key(KeyEvent::from(KeyCode::Esc)).await?;
        assert!(target_path.exists());
        assert_eq!(std::fs::read(&other_path)?, other_bytes);
        state.handle_key(KeyEvent::from(KeyCode::Backspace)).await?;
        state.handle_key(KeyEvent::from(KeyCode::Char('y'))).await?;
        let event = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
            .await?
            .expect("delete response");
        state.handle_background_event(event).await?;
        assert!(state.inline_error.is_none(), "{:?}", state.inline_error);
        assert!(!target_path.exists());
        assert_eq!(std::fs::read(&other_path)?, other_bytes);
        assert!(state.filtered_rows.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn elpis_delete_respects_chords_and_confirmation_owns_keys() {
    use codex_config::types::{KeybindingSpec, KeybindingsSpec, TuiKeymap};
    let (mut state, requests, thread_id) = delete_picker();
    let mut config = TuiKeymap::default();
    config.list.jump_top = Some(KeybindingsSpec::One(KeybindingSpec(
        "backspace home".into(),
    )));
    state.keymap = RuntimeKeymap::from_config(&config).unwrap();
    assert!(!state.delete_shortcut_available());
    assert!(
        state
            .route_key_chord(KeyEvent::from(KeyCode::Backspace))
            .is_none()
    );
    assert!(requests.lock().unwrap().is_empty());

    config.list.jump_top = Some(KeybindingsSpec::One(KeybindingSpec("f12 home".into())));
    state.keymap = RuntimeKeymap::from_config(&config).unwrap();
    state.request_delete_for_selected_session();
    let key = state
        .route_key_chord(KeyEvent::from(KeyCode::F(12)))
        .expect("the prompt ignores chord prefixes");
    state.handle_key(key).await.unwrap();
    assert!(matches!(state.delete_state, DeleteState::Confirming { .. }));
    assert!(requests.lock().unwrap().is_empty());
    let key = state
        .route_key_chord(KeyEvent::from(KeyCode::Char('y')))
        .expect("confirmation owns Y");
    state.handle_key(key).await.unwrap();
    assert_eq!(*requests.lock().unwrap(), vec![thread_id]);
}

#[tokio::test]
async fn elpis_delete_confirmation_keeps_original_target_when_page_changes() {
    let (mut state, requests, thread_id) = delete_picker();
    state.request_delete_for_selected_session();
    let other_id = ThreadId::new();
    state
        .all_rows
        .insert(0, delete_row(other_id, "Newer saved session"));
    state.apply_filter();
    state
        .handle_key(KeyEvent::from(KeyCode::Char('y')))
        .await
        .unwrap();
    assert_eq!(*requests.lock().unwrap(), vec![thread_id]);
    state
        .handle_background_event(BackgroundEvent::Delete {
            thread_id: other_id,
            result: Ok(()),
        })
        .await
        .unwrap();
    assert_eq!(state.filtered_rows.len(), 2);
    state
        .handle_background_event(BackgroundEvent::Delete {
            thread_id,
            result: Ok(()),
        })
        .await
        .unwrap();
    assert_eq!(
        state.filtered_rows[state.selected].thread_id,
        Some(other_id)
    );
}

#[tokio::test]
async fn elpis_backspace_edits_nonempty_search_before_offering_delete() {
    let (mut state, requests, thread_id) = delete_picker();
    state.set_query("Lawera".into());
    assert!(!footer(&state, 220).contains("backspace delete"));
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    assert_eq!(state.query, "Lawer");
    assert_eq!(state.delete_state, DeleteState::Idle);
    assert!(requests.lock().unwrap().is_empty());
    assert_eq!(
        state.filtered_rows[state.selected].thread_id,
        Some(thread_id)
    );

    state.set_query("L".into());
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    assert!(state.query.is_empty());
    assert_eq!(state.delete_state, DeleteState::Idle);
    state
        .handle_key(KeyEvent::new_with_kind(
            KeyCode::Backspace,
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        ))
        .await
        .unwrap();
    assert_eq!(state.delete_state, DeleteState::Idle);
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    assert!(matches!(state.delete_state, DeleteState::Confirming { .. }));
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn elpis_delete_requires_a_plain_backspace_press_without_ctrl_d_alias() {
    let (mut state, requests, _thread_id) = delete_picker();
    for event in [
        KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
        KeyEvent::new(KeyCode::Backspace, KeyModifiers::CONTROL),
        KeyEvent::new(KeyCode::Backspace, KeyModifiers::ALT),
        KeyEvent::new(KeyCode::Backspace, KeyModifiers::SHIFT),
        KeyEvent::new_with_kind(KeyCode::Backspace, KeyModifiers::NONE, KeyEventKind::Repeat),
        KeyEvent::new_with_kind(
            KeyCode::Backspace,
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ),
    ] {
        state.handle_key(event).await.unwrap();
        assert_eq!(state.delete_state, DeleteState::Idle);
        assert!(state.query.is_empty());
    }
    assert!(requests.lock().unwrap().is_empty());
    state
        .handle_key(KeyEvent::from(KeyCode::Backspace))
        .await
        .unwrap();
    assert!(matches!(state.delete_state, DeleteState::Confirming { .. }));
}

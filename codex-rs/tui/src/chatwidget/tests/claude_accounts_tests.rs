use super::*;
use codex_app_server_protocol::ClaudeAccount;
use codex_app_server_protocol::ClaudeAccountsReadResponse;

fn accounts() -> ClaudeAccountsReadResponse {
    ClaudeAccountsReadResponse {
        active_id: "default".into(),
        accounts: ["default", "66601136-bf70-4727-8da3-0e2e8efc7e99"]
            .into_iter()
            .enumerate()
            .map(|(index, id)| ClaudeAccount {
                id: id.into(),
                label: format!("Claude {}", index + 1),
                email: Some(format!("account{}@example.test", index + 1)),
                plan: Some("max".into()),
                authenticated: true,
                duplicate: false,
                signing_in: false,
                error: None,
            })
            .collect(),
        auth_url: None,
    }
}

#[tokio::test]
async fn claude_accounts_picker_lists_marks_current_and_selects_accounts() {
    for selected in [0, 1] {
        let (mut chat, mut events, _ops) = make_chatwidget_manual(None).await;
        chat.thread_id = Some(ThreadId::new());
        chat.claude_accounts = Some(accounts());
        chat.open_model_command_popup();
        let popup = render_bottom_popup(&chat, 100);
        assert!(popup.contains("Claude accounts…"), "{popup}");
        // The account entry is appended, so End opens it without changing the provider.
        chat.handle_key_event(KeyCode::End.into());
        chat.handle_key_event(KeyCode::Enter.into());
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::OpenClaudeAccounts))
        );
        chat.open_claude_accounts_popup();
        let popup = render_bottom_popup(&chat, 100);
        assert!(popup.contains("Claude 1 (current)"), "{popup}");
        assert!(popup.contains("Claude 2"), "{popup}");
        assert!(!popup.contains("Claude 2 (current)"), "{popup}");
        assert!(popup.contains("account1@example.test"), "{popup}");
        assert!(popup.contains("account2@example.test"), "{popup}");
        if selected == 1 {
            chat.handle_key_event(KeyCode::Down.into());
        }
        chat.handle_key_event(KeyCode::Enter.into());
        let expected = accounts().accounts[selected].id.clone();
        assert!(
            std::iter::from_fn(|| events.try_recv().ok()).any(
                |event| matches!(event, AppEvent::SelectClaudeAccount { id } if id == expected)
            )
        );
    }
}

#[tokio::test]
async fn claude_accounts_empty_or_unloaded_has_no_picker_entry() {
    for snapshot in [
        None,
        Some(ClaudeAccountsReadResponse {
            accounts: Vec::new(),
            ..accounts()
        }),
    ] {
        let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
        chat.thread_id = Some(ThreadId::new());
        chat.claude_accounts = snapshot;
        chat.open_model_command_popup();
        assert!(!render_bottom_popup(&chat, 100).contains("Claude accounts…"));
        chat.open_model_popup_with_presets(chat.model_catalog.models.clone());
        assert!(!render_bottom_popup(&chat, 100).contains("Claude accounts…"));
    }
}

#[tokio::test]
async fn claude_accounts_read_refreshes_present_picker_and_ignores_stale_or_closed_views() {
    let (mut chat, mut events, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.open_model_command_popup();
    let request_id = std::iter::from_fn(|| events.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::FetchClaudeAccounts { request_id } => Some(request_id),
            _ => None,
        })
        .expect("account read on opening the picker");
    chat.on_claude_accounts_loaded(uuid::Uuid::new_v4(), Ok(accounts()));
    assert!(!render_bottom_popup(&chat, 100).contains("Claude accounts…"));
    chat.on_claude_accounts_loaded(request_id, Ok(accounts()));
    assert!(render_bottom_popup(&chat, 100).contains("Claude accounts…"));
    chat.handle_key_event(KeyCode::Esc.into());
    chat.open_model_command_popup();
    let request_id = chat.claude_accounts_request_id.unwrap();
    chat.handle_key_event(KeyCode::Esc.into());
    chat.on_claude_accounts_loaded(request_id, Ok(accounts()));
    assert!(chat.bottom_pane.no_modal_or_popup_active());
}

#[tokio::test]
async fn claude_accounts_unavailable_logins_cannot_be_selected() {
    let (mut chat, mut events, _ops) = make_chatwidget_manual(None).await;
    for unavailable in ["signed-out", "duplicate", "signing-in", "error"] {
        let mut snapshot = accounts();
        let second = &mut snapshot.accounts[1];
        match unavailable {
            "signed-out" => second.authenticated = false,
            "duplicate" => second.duplicate = true,
            "signing-in" => second.signing_in = true,
            "error" => second.error = Some("Sign-in failed".into()),
            _ => unreachable!(),
        }
        chat.claude_accounts = Some(snapshot);
        chat.open_claude_accounts_popup();
        chat.handle_key_event(KeyCode::End.into());
        chat.handle_key_event(KeyCode::Enter.into());
        assert!(std::iter::from_fn(|| events.try_recv().ok()).all(
            |event| !matches!(event, AppEvent::SelectClaudeAccount { id } if id != "default")
        ));
    }
}

#[tokio::test]
async fn claude_accounts_failed_read_removes_stale_picker_entry() {
    let (mut chat, _events, _ops) = make_chatwidget_manual(None).await;
    chat.thread_id = Some(ThreadId::new());
    chat.claude_accounts = Some(accounts());
    chat.open_model_command_popup();
    assert!(render_bottom_popup(&chat, 100).contains("Claude accounts…"));
    chat.on_claude_accounts_loaded(
        chat.claude_accounts_request_id.unwrap(),
        Err("Method not found".into()),
    );
    assert!(!render_bottom_popup(&chat, 100).contains("Claude accounts…"));
}

#[tokio::test]
async fn claude_accounts_background_read_preserves_typed_search() {
    for query in ["Claude", "accounts"] {
        let (mut chat, _events, _ops) = make_chatwidget_manual(Some("gpt-5.5")).await;
        chat.thread_id = Some(ThreadId::new());
        chat.open_model_command_popup();
        for key in query.chars() {
            chat.handle_key_event(KeyCode::Char(key).into());
        }
        assert!(!render_bottom_popup(&chat, 100).contains("OpenAI"));
        chat.on_claude_accounts_loaded(chat.claude_accounts_request_id.unwrap(), Ok(accounts()));
        let popup = render_bottom_popup(&chat, 100);
        assert!(!popup.contains("OpenAI"), "{popup}");
        assert!(popup.contains("Claude accounts…"), "{popup}");
        assert!(!popup.contains("Search providers"), "{popup}");
    }
}

use super::*;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;

#[tokio::test]
async fn ide_command_injects_fresh_context_into_turns_and_stops_when_disabled() {
    let home = tempfile::tempdir().expect("home");
    let ipc = home.path().join("ipc");
    std::fs::create_dir(&ipc).expect("ipc directory");
    std::fs::set_permissions(&ipc, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = UnixListener::bind(ipc.join("ipc.sock")).expect("bind");
    let server = std::thread::spawn(move || {
        for selection in ["on", "first selection", "changed selection"] {
            let (mut stream, _) = listener.accept().expect("accept");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut header = [0; 4];
            stream.read_exact(&mut header).unwrap();
            let mut body = vec![0; u32::from_le_bytes(header) as usize];
            stream.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["sourceClientId"], "elpis-tui");
            let response = serde_json::json!({
                "type": "response", "method": "ide-context",
                "requestId": request["requestId"], "resultType": "success",
                "result": { "ideContext": {
                    "activeFile": {
                        "label": "main.rs", "path": "/repo/main.rs",
                        "selection": { "start": { "line": 0, "character": 0 },
                            "end": { "line": 0, "character": 3 } },
                        "activeSelectionContent": selection
                    },
                    "openTabs": [{ "label": "lib.rs", "path": "/repo/lib.rs" }]
                }}
            });
            let bytes = serde_json::to_vec(&response).unwrap();
            stream
                .write_all(&(bytes.len() as u32).to_le_bytes())
                .unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    let (mut chat, _rx, mut op_rx) = make_chatwidget_manual(None).await;
    chat.config.codex_home = home.path().to_path_buf().abs();
    chat.thread_id = Some(ThreadId::new());
    assert!(!chat.ide_context.is_enabled());
    chat.dispatch_command_with_args(SlashCommand::Ide, "on".into(), Vec::new());
    assert!(chat.ide_context.is_enabled());
    for selection in ["first selection", "changed selection"] {
        chat.submit_user_message(UserMessage::from("explain this"));
        let Op::UserTurn { items, .. } = next_submit_op(&mut op_rx) else {
            panic!("expected user turn");
        };
        let UserInput::Text { text, .. } = &items[0] else {
            panic!("expected text input");
        };
        assert!(text.contains(selection));
        assert!(text.contains("/repo/lib.rs"));
        assert_eq!(
            ChatWidget::user_message_display_from_inputs(&items).message,
            "explain this"
        );
    }
    server.join().expect("server joins");
    chat.dispatch_command_with_args(SlashCommand::Ide, "off".into(), Vec::new());
    assert!(!chat.ide_context.is_enabled());
    chat.submit_user_message(UserMessage::from("without context"));
    let Op::UserTurn { items, .. } = next_submit_op(&mut op_rx) else {
        panic!("expected user turn");
    };
    let UserInput::Text { text, .. } = &items[0] else {
        panic!("expected text input");
    };
    assert_eq!(text, "without context");
}

#[tokio::test]
async fn ide_unavailable_does_not_enable_context_or_change_user_input() {
    let home = tempfile::tempdir().expect("home");
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(None).await;
    chat.config.codex_home = home.path().to_path_buf().abs();
    chat.dispatch_command_with_args(SlashCommand::Ide, "on".into(), Vec::new());
    assert!(!chat.ide_context.is_enabled());
    let mut items = vec![UserInput::Text {
        text: "keep this".into(),
        text_elements: Vec::new(),
    }];
    let original = items.clone();
    chat.maybe_apply_ide_context(&mut items);
    assert_eq!(items, original);
    chat.dispatch_command_with_args(SlashCommand::Ide, "status".into(), Vec::new());
    assert!(!chat.ide_context.is_enabled());
}

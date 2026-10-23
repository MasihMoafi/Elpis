//! Exercise picker keys through App dispatch and inspect the actual JSON-RPC wire payload.

use super::*;
use codex_app_server_protocol::JSONRPCMessage;
use futures::SinkExt;
use futures::StreamExt;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::sync::Mutex;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const SECOND: &str = "00000000-0000-4000-8000-0000000000a1";

#[tokio::test]
async fn claude_accounts_picker_sends_bridge_payload_and_preserves_selection_on_rejection()
-> Result<()> {
    for rejected in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = crate::resolve_remote_addr(&format!("ws://{}", listener.local_addr()?))?;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let bridge = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let mut socket = tokio_tungstenite::accept_async(stream).await?;
            let mut snapshot = json!({
                "activeId": "default",
                "accounts": [
                    {"id": "default", "label": "Claude 1", "email": "one@example.test", "plan": "max", "authenticated": true, "duplicate": false, "signingIn": false, "error": null},
                    {"id": SECOND, "label": "Claude 2", "email": "two@example.test", "plan": "pro", "authenticated": true, "duplicate": false, "signingIn": false, "error": null}
                ]
            });
            while let Some(Ok(Message::Text(text))) = socket.next().await {
                let JSONRPCMessage::Request(request) = serde_json::from_str(&text)? else {
                    continue;
                };
                recorded
                    .lock()
                    .unwrap()
                    .push((request.method.clone(), request.params.clone()));
                let mut reply = match request.method.as_str() {
                    "initialize" => json!({"result": {"userAgent": "claude-accounts-test/1.0.0"}}),
                    "claudeAccounts/read" => {
                        assert_eq!(request.params, Some(json!({})));
                        json!({"result": snapshot})
                    }
                    "claudeAccounts/write" => {
                        assert_eq!(
                            request.params,
                            Some(json!({"action": "select", "id": SECOND}))
                        );
                        if rejected {
                            json!({"error": {"code": -32600, "message": "Wait for the active Claude response to finish before switching accounts."}})
                        } else {
                            snapshot["activeId"] = json!(SECOND);
                            json!({"result": snapshot})
                        }
                    }
                    method => panic!("unexpected request: {method}"),
                };
                reply["id"] = json!(request.id);
                socket.send(Message::Text(reply.to_string().into())).await?;
            }
            Ok::<_, color_eyre::Report>(())
        });
        let mut server = AppServerSession::new(
            crate::connect_remote_app_server(endpoint).await?,
            crate::app_server_session::ThreadParamsMode::Remote,
        );
        let (mut app, mut events, _ops) = make_test_app_with_channels().await;
        let mut tui = crate::tui::test_support::make_test_tui()?;
        app.chat_widget.handle_thread_session(test_thread_session(
            ThreadId::new(),
            test_path_buf("/tmp/project"),
        ));

        // Opening again reads the bridge, including a selection changed by another client.
        for opened in 0..2 {
            app.chat_widget.open_model_command_popup();
            let fetch = std::iter::from_fn(|| events.try_recv().ok())
                .find(|event| matches!(event, AppEvent::FetchClaudeAccounts { .. }))
                .expect("picker requests Claude accounts");
            Box::pin(app.handle_event(&mut tui, &mut server, fetch)).await?;
            let loaded = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(event @ AppEvent::ClaudeAccountsLoaded { .. }) = events.recv().await
                    {
                        break event;
                    }
                }
            })
            .await?;
            Box::pin(app.handle_event(&mut tui, &mut server, loaded)).await?;
            assert!(render_bottom_popup(&app.chat_widget, 100).contains("Claude accounts…"));
            app.chat_widget.handle_key_event(KeyCode::End.into());
            app.chat_widget.handle_key_event(KeyCode::Enter.into());
            let open = std::iter::from_fn(|| events.try_recv().ok())
                .find(|event| matches!(event, AppEvent::OpenClaudeAccounts))
                .expect("open account picker");
            Box::pin(app.handle_event(&mut tui, &mut server, open)).await?;
            let popup = render_bottom_popup(&app.chat_widget, 100);
            let expected = if opened == 0 || rejected {
                "Claude 1 (current)"
            } else {
                "Claude 2 (current)"
            };
            assert!(popup.contains(expected), "{popup}");
            if opened == 0 {
                app.chat_widget.handle_key_event(KeyCode::Down.into());
                app.chat_widget.handle_key_event(KeyCode::Enter.into());
                let select = std::iter::from_fn(|| events.try_recv().ok())
                    .find(|event| matches!(event, AppEvent::SelectClaudeAccount { .. }))
                    .expect("select account event");
                Box::pin(app.handle_event(&mut tui, &mut server, select)).await?;
                let message = std::iter::from_fn(|| events.try_recv().ok())
                    .find_map(|event| match event {
                        AppEvent::InsertHistoryCell(cell) => {
                            Some(lines_to_single_string(&cell.display_lines(120)))
                        }
                        _ => None,
                    })
                    .expect("switch result is visible");
                if rejected {
                    assert!(
                        message.contains("Could not switch Claude account"),
                        "{message}"
                    );
                    assert!(message.contains("active Claude response"), "{message}");
                } else {
                    assert!(
                        message.contains("Claude account: two@example.test"),
                        "{message}"
                    );
                }
            } else {
                app.chat_widget.handle_key_event(KeyCode::Esc.into());
            }
        }
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "claudeAccounts/write")
                .map(|(_, params)| params.clone())
                .collect::<Vec<_>>(),
            vec![Some(json!({"action": "select", "id": SECOND}))]
        );
        server.shutdown().await?;
        bridge.await??;
    }
    Ok(())
}

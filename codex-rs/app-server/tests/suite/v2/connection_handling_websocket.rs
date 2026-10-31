use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use app_test_support::DISABLE_PLUGIN_STARTUP_TASKS_ARG;
use app_test_support::MockResponsesConfig;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use app_test_support::write_models_cache;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use codex_app_server_protocol::ClientInfo;
use codex_app_server_protocol::ConfigWarningNotification;
use codex_app_server_protocol::InitializeParams;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::JSONRPCError;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::JSONRPCNotification;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SubAgentActivityKind;
use codex_app_server_protocol::ThreadItem;
use codex_app_server_protocol::ThreadLoadedListParams;
use codex_app_server_protocol::ThreadLoadedListResponse;
use codex_app_server_protocol::ThreadReadResponse;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_core::config::set_project_trust_level;
use codex_features::Feature;
use codex_http_client::HttpClient;
use codex_http_client::HttpClientBuilder;
use codex_http_client::HttpResponse;
use codex_protocol::config_types::TrustLevel;
use core_test_support::responses;
use futures::SinkExt;
use futures::StreamExt;
use hmac::Hmac;
use hmac::Mac;
use http::StatusCode;
use serde_json::json;
use sha2::Sha256;
use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::Command;
use tokio::time::Duration;
use tokio::time::Instant;
use tokio::time::sleep;
use tokio::time::timeout;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message as WebSocketMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::header::ORIGIN;
use wiremock::Mock;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path_regex;

// macOS and Windows CI can spend tens of seconds starting the app-server test
// binary under Bazel before it accepts JSON-RPC or reports its websocket bind
// address.
#[cfg(any(target_os = "macos", windows))]
pub(super) const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(not(any(target_os = "macos", windows)))]
pub(super) const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) type WsClient = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn websocket_read_only_follow_delivers_child_events_across_connections_and_reconnect()
-> Result<()> {
    const PARENT: &str = "start a live worker";
    const CHILD: &str = "live worker task";
    const SPAWN: &str = "live-follow-spawn";
    const MARKER: &str = "live child delta";
    const STEP: &str = "child-follow-step";
    const AFTER_RECONNECT: &str = "live child after reconnect";
    let server = responses::start_mock_server().await;
    let spawn_args = serde_json::to_string(
        &json!({"message": CHILD, "task_name": "worker", "fork_turns": "none"}),
    )?;
    let _parent = responses::mount_sse_once_match(
        &server,
        |req: &wiremock::Request| String::from_utf8_lossy(&req.body).contains(PARENT),
        responses::sse(vec![
            responses::ev_response_created("parent"),
            responses::ev_function_call_with_namespace(
                SPAWN,
                "collaboration",
                "spawn_agent",
                &spawn_args,
            ),
            responses::ev_completed("parent"),
        ]),
    )
    .await;
    let child_body = responses::sse(vec![
        responses::ev_response_created("child"),
        responses::ev_message_item_added("child-message", ""),
        responses::ev_output_text_delta(MARKER),
        responses::ev_assistant_message("child-message", MARKER),
        responses::ev_function_call(STEP, "exec_command", r#"{"cmd":"printf follow"}"#),
        responses::ev_completed("child"),
    ]);
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .and(|req: &wiremock::Request| {
            String::from_utf8_lossy(&req.body).contains(CHILD)
                && !String::from_utf8_lossy(&req.body).contains(SPAWN)
                && !String::from_utf8_lossy(&req.body).contains(STEP)
        })
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(child_body, "text/event-stream")
                .set_delay(Duration::from_secs(5)),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let resumed_child_body = responses::sse(vec![
        responses::ev_response_created("child-after-reconnect"),
        responses::ev_message_item_added("child-message-after-reconnect", ""),
        responses::ev_output_text_delta(AFTER_RECONNECT),
        responses::ev_assistant_message("child-message-after-reconnect", AFTER_RECONNECT),
        responses::ev_completed("child-after-reconnect"),
    ]);
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .and(|req: &wiremock::Request| String::from_utf8_lossy(&req.body).contains(STEP))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(resumed_child_body, "text/event-stream")
                .set_delay(Duration::from_secs(5)),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let _parent_done = responses::mount_sse_once_match(
        &server,
        |req: &wiremock::Request| String::from_utf8_lossy(&req.body).contains(SPAWN),
        responses::sse(vec![
            responses::ev_response_created("parent-done"),
            responses::ev_assistant_message("parent-message", "done"),
            responses::ev_completed("parent-done"),
        ]),
    )
    .await;
    let codex_home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri())
        .enable_feature(Feature::MultiAgentV2)
        .with_root_config(&format!("chatgpt_base_url = \"{}\"", server.uri()))
        .write(codex_home.path())?;
    write_models_cache(codex_home.path()).await?;
    let (_process, bind_addr) = spawn_websocket_server(codex_home.path()).await?;
    let mut root = connect_websocket(bind_addr).await?;
    let mut early = connect_websocket(bind_addr).await?;
    send_request(&mut root, "initialize", 1, Some(json!({"clientInfo": {"name": "root", "version": "0.1.0"}, "capabilities": {"experimentalApi": true}}))).await?;
    read_response_for_id(&mut root, 1).await?;
    send_request(&mut early, "initialize", 1, Some(json!({"clientInfo": {"name": "early-viewer", "version": "0.1.0"}, "capabilities": {"experimentalApi": true}}))).await?;
    read_response_for_id(&mut early, 1).await?;
    send_request(
        &mut root,
        "thread/start",
        2,
        Some(json!({"model": "gpt-5.4"})),
    )
    .await?;
    let parent: ThreadStartResponse = to_response(read_response_for_id(&mut root, 2).await?)?;
    send_request(&mut root, "turn/start", 3, Some(json!({"threadId": parent.thread.id, "input": [{"type": "text", "text": PARENT, "text_elements": []}]}))).await?;
    read_response_for_id(&mut root, 3).await?;
    let child_id = timeout(Duration::from_secs(30), async {
        loop {
            let notification = read_notification_for_method(&mut root, "item/completed").await?;
            let completed: ItemCompletedNotification =
                serde_json::from_value(notification.params.context("missing params")?)?;
            if let ThreadItem::SubAgentActivity {
                id,
                kind: SubAgentActivityKind::Started,
                agent_thread_id,
                ..
            } = completed.item
                && id == SPAWN
            {
                return Ok::<String, anyhow::Error>(agent_thread_id);
            }
        }
    })
    .await??;
    let mut late = connect_websocket(bind_addr).await?;
    send_request(&mut late, "initialize", 1, Some(json!({"clientInfo": {"name": "late-viewer", "version": "0.1.0"}, "capabilities": {"experimentalApi": true}}))).await?;
    read_response_for_id(&mut late, 1).await?;
    send_request(
        &mut late,
        "thread/subscribe",
        2,
        Some(json!({"threadId": child_id, "includeTurns": false})),
    )
    .await?;
    let read: ThreadReadResponse = to_response(read_response_for_id(&mut late, 2).await?)?;
    assert_eq!(read.thread.id, child_id);
    assert_eq!(read.thread.can_accept_direct_input, Some(false));
    for viewer in [&mut early, &mut late] {
        timeout(Duration::from_secs(30), async {
            loop {
                let notification =
                    read_notification_for_method(viewer, "item/agentMessage/delta").await?;
                let params = notification.params.context("missing delta params")?;
                if params["threadId"] == child_id && params["delta"] == MARKER {
                    return Ok::<(), anyhow::Error>(());
                }
            }
        })
        .await??;
    }
    early.close(None).await?;
    late.close(None).await?;
    drop(early);
    drop(late);
    let mut reconnected = connect_websocket(bind_addr).await?;
    send_request(&mut reconnected, "initialize", 1, Some(json!({"clientInfo": {"name": "reconnected-viewer", "version": "0.1.0"}, "capabilities": {"experimentalApi": true}}))).await?;
    read_response_for_id(&mut reconnected, 1).await?;
    send_request(
        &mut reconnected,
        "thread/subscribe",
        2,
        Some(json!({"threadId": child_id, "includeTurns": false})),
    )
    .await?;
    let _: ThreadReadResponse = to_response(read_response_for_id(&mut reconnected, 2).await?)?;
    timeout(Duration::from_secs(30), async {
        loop {
            let notification =
                read_notification_for_method(&mut reconnected, "item/agentMessage/delta").await?;
            let params = notification
                .params
                .context("missing reconnected delta params")?;
            if params["threadId"] == child_id && params["delta"] == AFTER_RECONNECT {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;
    timeout(Duration::from_secs(30), async {
        loop {
            let notification =
                read_notification_for_method(&mut reconnected, "turn/completed").await?;
            if notification.params.context("missing completion params")?["threadId"] == child_id {
                return Ok::<(), anyhow::Error>(());
            }
        }
    })
    .await??;
    send_request(
        &mut reconnected,
        "thread/read",
        3,
        Some(json!({"threadId": child_id, "includeTurns": true})),
    )
    .await?;
    let history: ThreadReadResponse =
        to_response(read_response_for_id(&mut reconnected, 3).await?)?;
    for text in [MARKER, AFTER_RECONNECT] {
        let count = history.thread.turns.iter().flat_map(|turn| &turn.items).filter(|item| {
            matches!(item, ThreadItem::AgentMessage { text: actual, .. } if actual.as_str() == text)
        }).count();
        assert_eq!(count, 1, "child history retains each message once: {text}");
    }
    send_request(&mut reconnected, "turn/start", 4, Some(json!({"threadId": child_id, "input": [{"type": "text", "text": "forbidden", "text_elements": []}]}))).await?;
    let error = read_error_for_id(&mut reconnected, 4).await?;
    assert!(
        error
            .error
            .message
            .contains("direct app-server input is not allowed for multi-agent v2 sub-agents")
    );
    send_request(
        &mut root,
        "thread/settings/update",
        4,
        Some(json!({"threadId": parent.thread.id})),
    )
    .await?;
    read_response_for_id(&mut root, 4).await?;
    Ok(())
}
type HmacSha256 = Hmac<Sha256>;

#[tokio::test]
async fn websocket_transport_routes_per_connection_handshake_and_responses() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let (mut process, bind_addr) = spawn_websocket_server(codex_home.path()).await?;

    let mut ws1 = connect_websocket(bind_addr).await?;
    let mut ws2 = connect_websocket(bind_addr).await?;

    send_initialize_request(&mut ws1, /*id*/ 1, "ws_client_one").await?;
    let first_init = read_response_for_id(&mut ws1, /*id*/ 1).await?;
    assert_eq!(first_init.id, RequestId::Integer(1));

    // Initialize responses are request-scoped and must not leak to other
    // connections.
    assert_no_message(&mut ws2, Duration::from_millis(250)).await?;

    send_config_read_request(&mut ws2, /*id*/ 2).await?;
    let not_initialized = read_error_for_id(&mut ws2, /*id*/ 2).await?;
    assert_eq!(not_initialized.error.message, "Not initialized");

    send_initialize_request(&mut ws2, /*id*/ 3, "ws_client_two").await?;
    let second_init = read_response_for_id(&mut ws2, /*id*/ 3).await?;
    assert_eq!(second_init.id, RequestId::Integer(3));

    // Same request-id on different connections must route independently.
    send_config_read_request(&mut ws1, /*id*/ 77).await?;
    send_config_read_request(&mut ws2, /*id*/ 77).await?;
    let ws1_config = read_response_for_id(&mut ws1, /*id*/ 77).await?;
    let ws2_config = read_response_for_id(&mut ws2, /*id*/ 77).await?;

    assert_eq!(ws1_config.id, RequestId::Integer(77));
    assert_eq!(ws2_config.id, RequestId::Integer(77));
    assert!(ws1_config.result.get("config").is_some());
    assert!(ws2_config.result.get("config").is_some());

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn thread_start_routes_project_exec_policy_warning_to_requester() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let project = TempDir::new()?;
    std::fs::create_dir(project.path().join(".git"))?;
    let rules_dir = project.path().join(".codex/rules");
    std::fs::create_dir_all(&rules_dir)?;
    let rules_path = rules_dir.join("broken.rules");
    std::fs::write(&rules_path, "prefix_rule(")?;
    set_project_trust_level(codex_home.path(), project.path(), TrustLevel::Trusted)?;

    let (mut process, bind_addr) = spawn_websocket_server(codex_home.path()).await?;
    let mut requester = connect_websocket(bind_addr).await?;
    let mut other_client = connect_websocket(bind_addr).await?;

    send_initialize_request(&mut requester, /*id*/ 1, "requester").await?;
    read_response_for_id(&mut requester, /*id*/ 1).await?;
    send_initialize_request(&mut other_client, /*id*/ 2, "other_client").await?;
    read_response_for_id(&mut other_client, /*id*/ 2).await?;

    send_request(
        &mut requester,
        "thread/start",
        /*id*/ 3,
        Some(serde_json::to_value(ThreadStartParams {
            cwd: Some(project.path().display().to_string()),
            model: Some("mock-model".to_string()),
            ..Default::default()
        })?),
    )
    .await?;

    let target_id = RequestId::Integer(3);
    let warning_summary = "Error parsing rules; custom rules not applied.";
    let is_exec_policy_warning = |notification: &JSONRPCNotification| {
        notification.method == "configWarning"
            && notification
                .params
                .as_ref()
                .and_then(|params| params.get("summary"))
                .and_then(serde_json::Value::as_str)
                == Some(warning_summary)
    };
    let mut response = None;
    let mut warning = None;
    while response.is_none() || warning.is_none() {
        match read_jsonrpc_message(&mut requester).await? {
            JSONRPCMessage::Response(candidate) if candidate.id == target_id => {
                response = Some(candidate);
            }
            JSONRPCMessage::Notification(candidate) if is_exec_policy_warning(&candidate) => {
                warning = Some(candidate);
            }
            _ => {}
        }
    }

    let _: ThreadStartResponse = to_response(response.context("missing thread/start response")?)?;
    let warning: ConfigWarningNotification = serde_json::from_value(
        warning
            .context("missing exec-policy configWarning")?
            .params
            .context("configWarning should include params")?,
    )?;
    assert_eq!(
        warning
            .path
            .as_deref()
            .map(Path::new)
            .and_then(Path::file_name),
        Some(std::ffi::OsStr::new("broken.rules"))
    );

    match timeout(Duration::from_millis(250), async {
        loop {
            let message = read_jsonrpc_message(&mut other_client).await?;
            if let JSONRPCMessage::Notification(notification) = message
                && is_exec_policy_warning(&notification)
            {
                return Ok::<_, anyhow::Error>(notification);
            }
        }
    })
    .await
    {
        Ok(Ok(_)) => bail!("exec-policy configWarning leaked to another connection"),
        Ok(Err(err)) => return Err(err),
        Err(_) => {}
    }

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_serves_health_endpoints_on_same_listener() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let (mut process, bind_addr) = spawn_websocket_server(codex_home.path()).await?;
    let client = HttpClientBuilder::new().build_direct()?;

    let readyz = http_get(&client, bind_addr, "/readyz").await?;
    assert_eq!(readyz.status(), StatusCode::OK);

    let healthz = http_get(&client, bind_addr, "/healthz").await?;
    assert_eq!(healthz.status(), StatusCode::OK);

    let mut ws = connect_websocket(bind_addr).await?;
    send_initialize_request(&mut ws, /*id*/ 1, "ws_health_client").await?;
    let init = read_response_for_id(&mut ws, /*id*/ 1).await?;
    assert_eq!(init.id, RequestId::Integer(1));

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_rejects_browser_origin_without_auth() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let (mut process, bind_addr) = spawn_websocket_server(codex_home.path()).await?;

    let mut ws = connect_websocket(bind_addr).await?;
    send_initialize_request(&mut ws, /*id*/ 1, "ws_loopback_client").await?;
    let init = read_response_for_id(&mut ws, /*id*/ 1).await?;
    assert_eq!(init.id, RequestId::Integer(1));
    drop(ws);

    assert_websocket_connect_rejected_with_headers(
        bind_addr,
        /*bearer_token*/ None,
        Some("https://evil.example"),
        StatusCode::FORBIDDEN,
    )
    .await?;

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_rejects_missing_and_invalid_capability_tokens() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let token_file = codex_home.path().join("app-server-token");
    std::fs::write(&token_file, "super-secret-token\n")?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = vec![
        "--ws-auth".to_string(),
        "capability-token".to_string(),
        "--ws-token-file".to_string(),
        token_file.display().to_string(),
    ];

    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://0.0.0.0:0", &auth_args).await?;

    assert_websocket_connect_rejected(bind_addr, /*bearer_token*/ None).await?;
    assert_websocket_connect_rejected(bind_addr, Some("wrong-token")).await?;

    let mut ws = connect_websocket_with_bearer(bind_addr, Some("super-secret-token")).await?;
    send_initialize_request(&mut ws, /*id*/ 1, "ws_auth_client").await?;
    let init = read_response_for_id(&mut ws, /*id*/ 1).await?;
    assert_eq!(init.id, RequestId::Integer(1));

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_verifies_signed_short_lived_bearer_tokens() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    let shared_secret = "0123456789abcdef0123456789abcdef";
    std::fs::write(&shared_secret_file, format!("{shared_secret}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = vec![
        "--ws-auth".to_string(),
        "signed-bearer-token".to_string(),
        "--ws-shared-secret-file".to_string(),
        shared_secret_file.display().to_string(),
        "--ws-issuer".to_string(),
        "codex-enroller".to_string(),
        "--ws-audience".to_string(),
        "codex-app-server".to_string(),
        "--ws-max-clock-skew-seconds".to_string(),
        "1".to_string(),
    ];

    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let expired_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() - 30,
            "iss": "codex-enroller",
            "aud": "codex-app-server",
        }),
    )?;
    assert_websocket_connect_rejected(bind_addr, Some(expired_token.as_str())).await?;

    let malformed_token = "not-a-jwt";
    assert_websocket_connect_rejected(bind_addr, Some(malformed_token)).await?;

    let not_yet_valid_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() + 60,
            "nbf": OffsetDateTime::now_utc().unix_timestamp() + 30,
            "iss": "codex-enroller",
            "aud": "codex-app-server",
        }),
    )?;
    assert_websocket_connect_rejected(bind_addr, Some(not_yet_valid_token.as_str())).await?;

    let wrong_issuer_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() + 60,
            "iss": "someone-else",
            "aud": "codex-app-server",
        }),
    )?;
    assert_websocket_connect_rejected(bind_addr, Some(wrong_issuer_token.as_str())).await?;

    let wrong_audience_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() + 60,
            "iss": "codex-enroller",
            "aud": "wrong-audience",
        }),
    )?;
    assert_websocket_connect_rejected(bind_addr, Some(wrong_audience_token.as_str())).await?;

    let wrong_signature_token = signed_bearer_token(
        b"fedcba9876543210fedcba9876543210",
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() + 60,
            "iss": "codex-enroller",
            "aud": "codex-app-server",
        }),
    )?;
    assert_websocket_connect_rejected(bind_addr, Some(wrong_signature_token.as_str())).await?;

    let valid_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": OffsetDateTime::now_utc().unix_timestamp() + 60,
            "iss": "codex-enroller",
            "aud": "codex-app-server",
        }),
    )?;
    let mut ws = connect_websocket_with_bearer(bind_addr, Some(valid_token.as_str())).await?;
    send_initialize_request(&mut ws, /*id*/ 1, "ws_signed_auth_client").await?;
    let init = read_response_for_id(&mut ws, /*id*/ 1).await?;
    assert_eq!(init.id, RequestId::Integer(1));

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_rejects_short_signed_bearer_secret_configuration() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    std::fs::write(&shared_secret_file, "too-short\n")?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let output = run_websocket_server_to_completion_with_args(
        codex_home.path(),
        "ws://127.0.0.1:0",
        &[
            "--ws-auth".to_string(),
            "signed-bearer-token".to_string(),
            "--ws-shared-secret-file".to_string(),
            shared_secret_file.display().to_string(),
        ],
    )
    .await?;
    assert!(
        !output.status.success(),
        "short shared secret should fail websocket server startup"
    );
    let stderr = String::from_utf8(output.stderr).context("stderr should be valid utf-8")?;
    assert!(
        stderr.contains("must be at least 32 bytes"),
        "unexpected stderr: {stderr}"
    );

    Ok(())
}

#[tokio::test]
async fn websocket_transport_rejects_unauthenticated_non_loopback_startup() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let output =
        run_websocket_server_to_completion_with_args(codex_home.path(), "ws://0.0.0.0:0", &[])
            .await?;
    assert!(
        !output.status.success(),
        "unauthenticated non-loopback listener should fail websocket server startup"
    );
    let stderr = String::from_utf8(output.stderr).context("stderr should be valid utf-8")?;
    assert!(
        stderr.contains("refusing to start non-loopback websocket listener"),
        "unexpected stderr: {stderr}"
    );

    Ok(())
}

#[tokio::test]
async fn websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout() -> Result<()>
{
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;

    let (mut process, bind_addr) = spawn_websocket_server_with_args(
        codex_home.path(),
        "ws://127.0.0.1:0",
        &["-c".to_string(), "thread_unload_delay_secs=2".to_string()],
    )
    .await?;

    let mut ws1 = connect_websocket(bind_addr).await?;
    send_initialize_request(&mut ws1, /*id*/ 1, "ws_thread_owner").await?;
    read_response_for_id(&mut ws1, /*id*/ 1).await?;

    let thread_id = start_thread(&mut ws1, /*id*/ 2).await?;
    assert_loaded_threads(&mut ws1, /*id*/ 3, &[thread_id.as_str()]).await?;

    let mut ws2 = connect_websocket(bind_addr).await?;
    send_initialize_request(&mut ws2, /*id*/ 4, "ws_reconnect_client").await?;
    read_response_for_id(&mut ws2, /*id*/ 4).await?;

    ws1.close(None).await.context("failed to close websocket")?;
    drop(ws1);

    wait_for_loaded_threads(&mut ws2, /*first_id*/ 5, &[thread_id.as_str()]).await?;
    wait_for_loaded_threads(&mut ws2, /*first_id*/ 100, &[]).await?;

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

pub(super) async fn spawn_websocket_server(codex_home: &Path) -> Result<(Child, SocketAddr)> {
    spawn_websocket_server_with_args(codex_home, "ws://127.0.0.1:0", &[]).await
}

pub(super) async fn spawn_websocket_server_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<(Child, SocketAddr)> {
    let program = codex_utils_cargo_bin::cargo_bin("codex-app-server")
        .context("should find app-server binary")?;
    let mut cmd = Command::new(program);
    cmd.arg("--listen")
        .arg(listen_url)
        .arg(DISABLE_PLUGIN_STARTUP_TASKS_ARG)
        .args(extra_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env("CODEX_HOME", codex_home)
        .env("RUST_LOG", "warn")
        .env("OTEL_METRIC_EXPORT_INTERVAL", "200");

    let mut process = cmd
        .kill_on_drop(true)
        .spawn()
        .context("failed to spawn websocket app-server process")?;

    let stderr = process
        .stderr
        .take()
        .context("failed to capture websocket app-server stderr")?;
    let mut stderr_reader = BufReader::new(stderr).lines();
    let deadline = Instant::now() + DEFAULT_READ_TIMEOUT;
    let bind_addr = loop {
        let line = timeout(
            deadline.saturating_duration_since(Instant::now()),
            stderr_reader.next_line(),
        )
        .await
        .context("timed out waiting for websocket app-server to report bound websocket address")?
        .context("failed to read websocket app-server stderr")?
        .context("websocket app-server exited before reporting bound websocket address")?;
        eprintln!("[websocket app-server stderr] {line}");

        let stripped_line = {
            let mut stripped = String::with_capacity(line.len());
            let mut chars = line.chars().peekable();
            while let Some(ch) = chars.next() {
                if ch == '\u{1b}' && matches!(chars.peek(), Some(&'[')) {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                    continue;
                }
                stripped.push(ch);
            }
            stripped
        };

        if let Some(bind_addr) = stripped_line
            .split_whitespace()
            .find_map(|token| token.strip_prefix("ws://"))
            .and_then(|addr| addr.parse::<SocketAddr>().ok())
        {
            break bind_addr;
        }
    };

    tokio::spawn(async move {
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            eprintln!("[websocket app-server stderr] {line}");
        }
    });

    Ok((process, bind_addr))
}

pub(super) async fn connect_websocket(bind_addr: SocketAddr) -> Result<WsClient> {
    connect_websocket_with_bearer(bind_addr, /*bearer_token*/ None).await
}

pub(super) async fn connect_websocket_with_bearer(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<WsClient> {
    let url = format!("ws://{}", connectable_bind_addr(bind_addr));
    let request = websocket_request(url.as_str(), bearer_token, /*origin*/ None)?;
    let deadline = Instant::now() + DEFAULT_READ_TIMEOUT;
    loop {
        match connect_async(request.clone()).await {
            Ok((stream, _response)) => return Ok(stream),
            Err(err) => {
                if Instant::now() >= deadline {
                    bail!("failed to connect websocket to {url}: {err}");
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn assert_websocket_connect_rejected(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<()> {
    assert_websocket_connect_rejected_with_headers(
        bind_addr,
        bearer_token,
        /*origin*/ None,
        StatusCode::UNAUTHORIZED,
    )
    .await
}

async fn assert_websocket_connect_rejected_with_headers(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
    origin: Option<&str>,
    expected_status: StatusCode,
) -> Result<()> {
    let url = format!("ws://{}", connectable_bind_addr(bind_addr));
    let request = websocket_request(url.as_str(), bearer_token, origin)?;

    match connect_async(request).await {
        Ok((_stream, response)) => {
            bail!(
                "expected websocket handshake rejection, got {}",
                response.status()
            )
        }
        Err(WsError::Http(response)) => {
            assert_eq!(response.status(), expected_status);
            Ok(())
        }
        Err(err) => bail!("expected http rejection during websocket handshake: {err}"),
    }
}

async fn run_websocket_server_to_completion_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<std::process::Output> {
    let program = codex_utils_cargo_bin::cargo_bin("codex-app-server")
        .context("should find app-server binary")?;
    let mut cmd = Command::new(program);
    cmd.arg("--listen")
        .arg(listen_url)
        .arg(DISABLE_PLUGIN_STARTUP_TASKS_ARG)
        .args(extra_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env("CODEX_HOME", codex_home)
        .env("RUST_LOG", "warn");
    timeout(DEFAULT_READ_TIMEOUT, cmd.output())
        .await
        .context("timed out waiting for websocket app-server to exit")?
        .context("failed to run websocket app-server")
}

async fn http_get(client: &HttpClient, bind_addr: SocketAddr, path: &str) -> Result<HttpResponse> {
    let connectable_bind_addr = connectable_bind_addr(bind_addr);
    let deadline = Instant::now() + DEFAULT_READ_TIMEOUT;
    loop {
        match client
            .get(format!("http://{connectable_bind_addr}{path}"))
            .send()
            .await
            .with_context(|| format!("failed to GET http://{connectable_bind_addr}{path}"))
        {
            Ok(response) => return Ok(response),
            Err(err) => {
                if Instant::now() >= deadline {
                    bail!("failed to GET http://{connectable_bind_addr}{path}: {err}");
                }
                sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

fn websocket_request(
    url: &str,
    bearer_token: Option<&str>,
    origin: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
    let mut request = url
        .into_client_request()
        .context("failed to create websocket request")?;
    if let Some(bearer_token) = bearer_token {
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {bearer_token}"))
                .context("invalid bearer token header")?,
        );
    }
    if let Some(origin) = origin {
        request.headers_mut().insert(
            ORIGIN,
            HeaderValue::from_str(origin).context("invalid origin header")?,
        );
    }
    Ok(request)
}

pub(super) async fn send_initialize_request(
    stream: &mut WsClient,
    id: i64,
    client_name: &str,
) -> Result<()> {
    let params = InitializeParams {
        client_info: ClientInfo {
            name: client_name.to_string(),
            title: Some("WebSocket Test Client".to_string()),
            version: "0.1.0".to_string(),
        },
        capabilities: None,
    };
    send_request(
        stream,
        "initialize",
        id,
        Some(serde_json::to_value(params)?),
    )
    .await
}

async fn start_thread(stream: &mut WsClient, id: i64) -> Result<String> {
    send_request(
        stream,
        "thread/start",
        id,
        Some(serde_json::to_value(ThreadStartParams {
            model: Some("mock-model".to_string()),
            ..Default::default()
        })?),
    )
    .await?;
    let response = read_response_for_id(stream, id).await?;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(response)?;
    Ok(thread.id)
}

async fn assert_loaded_threads(stream: &mut WsClient, id: i64, expected: &[&str]) -> Result<()> {
    let response = request_loaded_threads(stream, id).await?;
    let mut actual = response.data;
    actual.sort();
    let mut expected = expected
        .iter()
        .map(|thread_id| (*thread_id).to_string())
        .collect::<Vec<_>>();
    expected.sort();
    assert_eq!(actual, expected);
    assert_eq!(response.next_cursor, None);
    Ok(())
}

async fn wait_for_loaded_threads(
    stream: &mut WsClient,
    first_id: i64,
    expected: &[&str],
) -> Result<()> {
    let mut next_id = first_id;
    let expected = expected
        .iter()
        .map(|thread_id| (*thread_id).to_string())
        .collect::<Vec<_>>();
    timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let response = request_loaded_threads(stream, next_id).await?;
            next_id += 1;
            let mut actual = response.data;
            actual.sort();
            if actual == expected {
                return Ok::<(), anyhow::Error>(());
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("timed out waiting for loaded thread list")??;
    Ok(())
}

async fn request_loaded_threads(
    stream: &mut WsClient,
    id: i64,
) -> Result<ThreadLoadedListResponse> {
    send_request(
        stream,
        "thread/loaded/list",
        id,
        Some(serde_json::to_value(ThreadLoadedListParams::default())?),
    )
    .await?;
    let response = read_response_for_id(stream, id).await?;
    to_response::<ThreadLoadedListResponse>(response)
}

async fn send_config_read_request(stream: &mut WsClient, id: i64) -> Result<()> {
    send_request(
        stream,
        "config/read",
        id,
        Some(json!({ "includeLayers": false })),
    )
    .await
}

pub(super) async fn send_request(
    stream: &mut WsClient,
    method: &str,
    id: i64,
    params: Option<serde_json::Value>,
) -> Result<()> {
    let message = JSONRPCMessage::Request(JSONRPCRequest {
        id: RequestId::Integer(id),
        method: method.to_string(),
        params,
        trace: None,
    });
    send_jsonrpc(stream, message).await
}

pub(super) async fn send_jsonrpc(stream: &mut WsClient, message: JSONRPCMessage) -> Result<()> {
    let payload = serde_json::to_string(&message)?;
    stream
        .send(WebSocketMessage::Text(payload.into()))
        .await
        .context("failed to send websocket frame")
}

pub(super) async fn read_response_for_id(
    stream: &mut WsClient,
    id: i64,
) -> Result<JSONRPCResponse> {
    let target_id = RequestId::Integer(id);
    loop {
        let message = read_jsonrpc_message(stream).await?;
        if let JSONRPCMessage::Response(response) = message
            && response.id == target_id
        {
            return Ok(response);
        }
    }
}

pub(super) async fn read_notification_for_method(
    stream: &mut WsClient,
    method: &str,
) -> Result<JSONRPCNotification> {
    loop {
        let message = read_jsonrpc_message(stream).await?;
        if let JSONRPCMessage::Notification(notification) = message
            && notification.method == method
        {
            return Ok(notification);
        }
    }
}

pub(super) async fn read_response_and_notification_for_method(
    stream: &mut WsClient,
    id: i64,
    method: &str,
) -> Result<(JSONRPCResponse, JSONRPCNotification)> {
    let target_id = RequestId::Integer(id);
    let mut response = None;
    let mut notification = None;

    while response.is_none() || notification.is_none() {
        let message = read_jsonrpc_message(stream).await?;
        match message {
            JSONRPCMessage::Response(candidate) if candidate.id == target_id => {
                response = Some(candidate);
            }
            JSONRPCMessage::Notification(candidate)
                if candidate.method == method && notification.is_some() =>
            {
                bail!(
                    "received duplicate notification for method `{method}` before completing paired read"
                );
            }
            JSONRPCMessage::Notification(candidate) if candidate.method == method => {
                notification = Some(candidate);
            }
            _ => {}
        }
    }

    let Some(response) = response else {
        bail!("response must be set before returning");
    };
    let Some(notification) = notification else {
        bail!("notification must be set before returning");
    };

    Ok((response, notification))
}

pub(super) async fn read_error_for_id(stream: &mut WsClient, id: i64) -> Result<JSONRPCError> {
    let target_id = RequestId::Integer(id);
    loop {
        let message = read_jsonrpc_message(stream).await?;
        if let JSONRPCMessage::Error(err) = message
            && err.id == target_id
        {
            return Ok(err);
        }
    }
}

pub(super) async fn read_jsonrpc_message(stream: &mut WsClient) -> Result<JSONRPCMessage> {
    loop {
        let frame = timeout(DEFAULT_READ_TIMEOUT, stream.next())
            .await
            .context("timed out waiting for websocket frame")?
            .context("websocket stream ended unexpectedly")?
            .context("failed to read websocket frame")?;

        match frame {
            WebSocketMessage::Text(text) => return Ok(serde_json::from_str(text.as_ref())?),
            WebSocketMessage::Ping(payload) => {
                stream.send(WebSocketMessage::Pong(payload)).await?;
            }
            WebSocketMessage::Pong(_) => {}
            WebSocketMessage::Close(frame) => {
                bail!("websocket closed unexpectedly: {frame:?}")
            }
            WebSocketMessage::Binary(_) => bail!("unexpected binary websocket frame"),
            WebSocketMessage::Frame(_) => {}
        }
    }
}

pub(super) async fn assert_no_message(stream: &mut WsClient, wait_for: Duration) -> Result<()> {
    match timeout(wait_for, stream.next()).await {
        Ok(Some(Ok(frame))) => bail!("unexpected frame while waiting for silence: {frame:?}"),
        Ok(Some(Err(err))) => bail!("unexpected websocket read error: {err}"),
        Ok(None) => bail!("websocket closed unexpectedly while waiting for silence"),
        Err(_) => Ok(()),
    }
}

pub(super) fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "{approval_policy}"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )
}

fn connectable_bind_addr(bind_addr: SocketAddr) -> SocketAddr {
    match bind_addr {
        SocketAddr::V4(addr) if addr.ip().is_unspecified() => {
            SocketAddr::from(([127, 0, 0, 1], addr.port()))
        }
        SocketAddr::V6(addr) if addr.ip().is_unspecified() => {
            SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], addr.port()))
        }
        _ => bind_addr,
    }
}

fn signed_bearer_token(shared_secret: &[u8], claims: serde_json::Value) -> Result<String> {
    let header_segment = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims_segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
    let payload = format!("{header_segment}.{claims_segment}");
    let mut mac = HmacSha256::new_from_slice(shared_secret).context("failed to create hmac")?;
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{payload}.{signature}"))
}

//! Memory recall eval.
//!
//! Captures consecutive real Responses requests from one live app-server thread. The
//! planted markers exist only in this test's non-secret fixture, so every assertion is at
//! the request boundary rather than the Ledger's persisted state.
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::UserInput as V2UserInput;
use core_test_support::responses;
use std::path::Path;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(10);

const MEMORY_CREATE_MARKER: &str = "MEMORY_CREATE_MARKER";
const MEMORY_UPDATED_MARKER: &str = "MEMORY_UPDATED_MARKER";
const MEMORY_SOURCE_HEADER: &str = "MEMORY.md (";
const ELPIS_CONTINUITY_HEADER: &str = "## Elpis Admitted Context\n\n";

#[tokio::test]
async fn manual_memory_request_boundaries_follow_current_admission() -> Result<()> {
    let server = responses::start_mock_server().await;
    let response_mock = responses::mount_sse_sequence(
        &server,
        (1..=7)
            .map(|turn| {
                responses::sse(vec![
                    responses::ev_response_created(&format!("resp-{turn}")),
                    responses::ev_assistant_message(&format!("msg-{turn}"), "acknowledged"),
                    responses::ev_completed(&format!("resp-{turn}")),
                ])
            })
            .collect(),
    )
    .await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let memory_root = codex_home.path().join("memories");
    write_config_toml(codex_home.path(), &server.uri())?;

    let mut app = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .without_auto_env()
        .build()
        .await?;
    timeout(DEFAULT_READ_TIMEOUT, app.initialize()).await??;

    let request_id = app
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().to_string_lossy().to_string()),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(response)?;

    complete_turn(&mut app, &thread.id).await?;
    assert_no_manual_memory(&response_mock.requests()[0].message_input_texts("developer"));

    codex_core::elpis_context::create_manual_memory(Some(memory_root.as_path()), workspace.path())?;
    tokio::fs::write(memory_root.join("MEMORY.md"), MEMORY_CREATE_MARKER).await?;
    complete_turn(&mut app, &thread.id).await?;
    assert_no_manual_memory(&response_mock.requests()[1].message_input_texts("developer"));

    codex_core::elpis_context::set_continuity_source_admitted(
        Some(memory_root.as_path()),
        workspace.path(),
        "MEMORY.md",
        true,
    )?;
    complete_turn(&mut app, &thread.id).await?;
    let admitted = response_mock.requests()[2].message_input_texts("developer");
    assert!(
        admitted
            .iter()
            .any(|text| text.contains(MEMORY_CREATE_MARKER))
    );

    tokio::fs::write(memory_root.join("MEMORY.md"), MEMORY_UPDATED_MARKER).await?;
    complete_turn(&mut app, &thread.id).await?;
    let updated = response_mock.requests()[3].message_input_texts("developer");
    let continuity = elpis_continuity_fragments(&updated);
    assert_eq!(
        continuity.len(),
        1,
        "continuity must own one live request slot"
    );
    assert!(continuity[0].contains(MEMORY_UPDATED_MARKER));
    assert!(!continuity[0].contains(MEMORY_CREATE_MARKER));

    codex_core::elpis_context::set_continuity_source_admitted(
        Some(memory_root.as_path()),
        workspace.path(),
        "MEMORY.md",
        false,
    )?;
    complete_turn(&mut app, &thread.id).await?;
    assert_no_manual_memory(&response_mock.requests()[4].message_input_texts("developer"));

    let long_memory = "🦀".repeat(8_001);
    tokio::fs::write(memory_root.join("MEMORY.md"), &long_memory).await?;
    codex_core::elpis_context::set_continuity_source_admitted(
        Some(memory_root.as_path()),
        workspace.path(),
        "MEMORY.md",
        true,
    )?;
    assert!(
        codex_core::elpis_context::manual_memory_status(
            Some(memory_root.as_path()),
            workspace.path(),
        )?
        .expect("configured memory status")
        .truncated
    );
    complete_turn(&mut app, &thread.id).await?;
    let long_request = response_mock.requests()[5].message_input_texts("developer");
    assert_eq!(
        manual_memory_body(&long_request),
        format!("{}…", "🦀".repeat(7_999)),
        "the request body must stop at exactly 8,000 Rust characters"
    );

    let admission_path = codex_core::elpis_context::workspace_context_dir(
        Some(memory_root.as_path()),
        workspace.path(),
    )
    .expect("workspace admission path")
    .join("admission.toml");
    let corrupt = b"memory = [not valid";
    tokio::fs::write(&admission_path, corrupt).await?;
    complete_turn(&mut app, &thread.id).await?;
    let corrupt_request = response_mock.requests()[6].message_input_texts("developer");
    assert!(
        corrupt_request
            .iter()
            .all(|text| !text.contains("## Elpis Admitted Context")),
        "a corrupt admission record must fail closed"
    );
    assert_eq!(tokio::fs::read(&admission_path).await?, corrupt.as_slice());

    Ok(())
}

async fn complete_turn(app: &mut TestAppServer, thread_id: &str) -> Result<()> {
    let request_id = app
        .send_turn_start_request(TurnStartParams {
            thread_id: thread_id.to_string(),
            input: vec![V2UserInput::Text {
                text: "Check the current memory boundary.".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    Ok(())
}

fn assert_no_manual_memory(developer: &[String]) {
    assert!(
        developer
            .iter()
            .all(|text| !text.contains(MEMORY_SOURCE_HEADER)),
        "manual memory source unexpectedly reached the model: {developer:#?}"
    );
    assert!(
        developer
            .iter()
            .all(|text| !text.contains(MEMORY_CREATE_MARKER)),
        "manual memory fixture unexpectedly reached the model: {developer:#?}"
    );
}

fn manual_memory_body(developer: &[String]) -> String {
    developer
        .iter()
        .find_map(|text| {
            text.rsplit_once("MEMORY.md (8000 characters)\n\n")
                .map(|(_, body)| body.to_string())
        })
        .expect("the admitted request must contain the capped manual-memory source")
}

fn elpis_continuity_fragments(developer: &[String]) -> Vec<&str> {
    developer
        .iter()
        .filter_map(|text| {
            text.contains(ELPIS_CONTINUITY_HEADER)
                .then_some(text.as_str())
        })
        .collect()
}

fn write_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()> {
    std::fs::write(
        codex_home.join("config.toml"),
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
model_provider = "mock_provider"
suppress_unstable_features_warning = true

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
"#,
        ),
    )
}

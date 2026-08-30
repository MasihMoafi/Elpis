//! Memory recall eval.
//!
//! Plants a fact that exists nowhere except durable memory, runs a turn, and checks the
//! request that actually left for the model. Both negatives are the point: a recall test
//! that only proves the fact arrives passes just as happily when everything on disk is
//! admitted unconditionally, which is not memory working — it is memory being ignored in
//! the user's favour. `MEMORY.md` is an optional Ledger row, so it starts switched off and
//! must stay out of the request until it is admitted, and switching it back off must
//! remove it again.
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

/// Deliberately unguessable: a model cannot answer this from training data, and no other
/// file in the fixture contains it, so its presence in the request can only come from
/// durable memory.
const PLANTED_FACT: &str = "The Elpis staging cluster is named quiet-heron-42.";

/// What the Context Ledger did with the `MEMORY.md` row before the turn ran.
enum MemoryAdmission {
    /// Leave the row untouched, exercising the shipped default for optional rows.
    Untouched,
    Admitted,
    Withheld,
}

#[tokio::test]
async fn durable_memory_reaches_the_model_only_once_the_ledger_admits_it() -> Result<()> {
    // Optional rows default to off, so memory the user never admitted must not be spent.
    let untouched = developer_context_for_turn(MemoryAdmission::Untouched).await?;
    assert!(
        !untouched.iter().any(|text| text.contains(PLANTED_FACT)),
        "durable memory reached the model without being admitted: {untouched:#?}"
    );

    let admitted = developer_context_for_turn(MemoryAdmission::Admitted).await?;
    assert!(
        admitted.iter().any(|text| text.contains(PLANTED_FACT)),
        "durable memory was admitted and never reached the model; developer context was: {admitted:#?}"
    );

    let withheld = developer_context_for_turn(MemoryAdmission::Withheld).await?;
    assert!(
        !withheld.iter().any(|text| text.contains(PLANTED_FACT)),
        "MEMORY.md was switched off in the ledger and still reached the model: {withheld:#?}"
    );

    Ok(())
}

/// Runs one full turn against a mock model and returns the developer messages the model
/// received.
async fn developer_context_for_turn(admission: MemoryAdmission) -> Result<Vec<String>> {
    let server = responses::start_mock_server().await;
    let response_mock = responses::mount_sse_once(
        &server,
        responses::sse(vec![
            responses::ev_response_created("resp-1"),
            responses::ev_assistant_message("msg-1", "acknowledged"),
            responses::ev_completed("resp-1"),
        ]),
    )
    .await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let memory_root = codex_home.path().join("memories");
    write_config_toml(codex_home.path(), &server.uri())?;

    tokio::fs::create_dir_all(&memory_root).await?;
    tokio::fs::write(
        memory_root.join("MEMORY.md"),
        format!("# Durable memory\n\n- {PLANTED_FACT}\n"),
    )
    .await?;

    match admission {
        MemoryAdmission::Untouched => {}
        MemoryAdmission::Admitted | MemoryAdmission::Withheld => {
            codex_core::elpis_context::set_continuity_source_admitted(
                Some(memory_root.as_path()),
                workspace.path(),
                "MEMORY.md",
                matches!(admission, MemoryAdmission::Admitted),
            )?;
        }
    }

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

    let request_id = app
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id,
            input: vec![V2UserInput::Text {
                text: "What is the staging cluster called?".to_string(),
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

    Ok(response_mock
        .single_request()
        .message_input_texts("developer"))
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

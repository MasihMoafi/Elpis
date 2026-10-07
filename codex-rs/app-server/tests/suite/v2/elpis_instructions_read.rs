//! Elpis: `thread/elpisInstructions/read` returns the Elpis instruction text the thread's
//! model would receive, following the Context Ledger, before the thread runs any turn.
//!
//! Each source holds a unique nonce. The positive cases admit the source and expect its
//! nonce; the negative cases withdraw it and expect the nonce to be gone.

use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_core::elpis_context::set_continuity_source_admitted;
use core_test_support::responses;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const METHOD: &str = "thread/elpisInstructions/read";

const DEVELOPER_NONCE: &str = "ELPIS_INSTRUCTIONS_DEVELOPER_4c1d9e";
const AGENTS_NONCE: &str = "ELPIS_INSTRUCTIONS_PROJECT_AGENTS_8a27f0";
const MEMORY_NONCE: &str = "ELPIS_INSTRUCTIONS_MEMORY_d3b561";

const PROJECT_RULES_ROW: &str = "Project AGENTS.md";
const MEMORY_ROW: &str = "MEMORY.md";

struct Fixture {
    _server: wiremock::MockServer,
    codex_home: TempDir,
    _workspace: TempDir,
    mcp: TestAppServer,
    thread_id: String,
    cwd: PathBuf,
}

/// A home with configured developer instructions and MEMORY.md, a workspace with a project
/// AGENTS.md, and a started thread that has not run a turn.
async fn start_thread() -> Result<Fixture> {
    let server = responses::start_mock_server().await;
    let codex_home = TempDir::new()?;
    // An empty configured development-rule root keeps the machine's own rules out.
    let dev_rules = codex_home.path().join("dev-rule-root");
    std::fs::create_dir_all(&dev_rules)?;
    MockResponsesConfig::new(&server.uri())
        .with_root_config(&format!("developer_instructions = \"{DEVELOPER_NONCE}\""))
        .with_extra_config(&format!(
            "[skills]\ndev_rule_roots = [{}]",
            serde_json::to_string(&dev_rules.to_string_lossy())?
        ))
        .write(codex_home.path())?;
    std::fs::create_dir_all(codex_home.path().join("memories"))?;
    std::fs::write(
        codex_home.path().join("memories/MEMORY.md"),
        format!("# Elpis Memory\n\n- {MEMORY_NONCE}\n"),
    )?;
    let workspace = TempDir::new()?;
    std::fs::write(workspace.path().join("AGENTS.md"), AGENTS_NONCE)?;

    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .without_auto_env()
        .build_initialized()
        .await?;
    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    let ThreadStartResponse { thread, cwd, .. } =
        timeout(DEFAULT_READ_TIMEOUT, mcp.read_response(request_id)).await??;
    Ok(Fixture {
        _server: server,
        codex_home,
        _workspace: workspace,
        mcp,
        thread_id: thread.id,
        cwd: cwd.as_path().to_path_buf(),
    })
}

impl Fixture {
    /// Sets one Ledger row for the thread's workspace, as the TUI does.
    fn set_row(&self, row: &str, admitted: bool) -> Result<()> {
        set_continuity_source_admitted(
            Some(self.codex_home.path().join("memories").as_path()),
            &self.cwd,
            row,
            admitted,
        )?;
        Ok(())
    }

    async fn read(&mut self) -> Result<Value> {
        let request_id = self
            .mcp
            .send_request(METHOD, Some(json!({ "threadId": self.thread_id })))
            .await?;
        let response: Value =
            timeout(DEFAULT_READ_TIMEOUT, self.mcp.read_response(request_id)).await??;
        Ok(response)
    }
}

fn field<'a>(response: &'a Value, name: &str) -> Option<&'a str> {
    response
        .get(name)
        .unwrap_or_else(|| panic!("response has no `{name}` field: {response}"))
        .as_str()
}

fn contains(response: &Value, name: &str, nonce: &str) -> bool {
    field(response, name).is_some_and(|text| text.contains(nonce))
}

#[tokio::test]
async fn returns_developer_instructions_and_admitted_agents_md() -> Result<()> {
    let mut fixture = start_thread().await?;
    fixture.set_row(PROJECT_RULES_ROW, /*admitted*/ true)?;

    let response = fixture.read().await?;

    assert_eq!(
        field(&response, "developerInstructions"),
        Some(DEVELOPER_NONCE)
    );
    assert!(
        contains(&response, "agentsMd", AGENTS_NONCE),
        "admitted project AGENTS.md is missing: {response}"
    );
    Ok(())
}

#[tokio::test]
async fn withdrawn_agents_md_is_left_out() -> Result<()> {
    let mut fixture = start_thread().await?;
    fixture.set_row(PROJECT_RULES_ROW, /*admitted*/ true)?;
    fixture.set_row(PROJECT_RULES_ROW, /*admitted*/ false)?;

    let response = fixture.read().await?;

    assert!(
        !contains(&response, "agentsMd", AGENTS_NONCE),
        "withdrawn project AGENTS.md was returned: {response}"
    );
    assert_eq!(field(&response, "agentsMd"), None);
    Ok(())
}

#[tokio::test]
async fn continuity_carries_memory_only_while_admitted() -> Result<()> {
    let mut fixture = start_thread().await?;

    fixture.set_row(MEMORY_ROW, /*admitted*/ true)?;
    let admitted = fixture.read().await?;
    fixture.set_row(MEMORY_ROW, /*admitted*/ false)?;
    let withdrawn = fixture.read().await?;

    assert!(
        contains(&admitted, "continuity", MEMORY_NONCE),
        "admitted MEMORY.md is missing: {admitted}"
    );
    assert!(
        !contains(&withdrawn, "continuity", MEMORY_NONCE),
        "withdrawn MEMORY.md was returned: {withdrawn}"
    );
    assert_eq!(field(&withdrawn, "continuity"), None);
    Ok(())
}

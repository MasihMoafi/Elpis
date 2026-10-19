//! Context-file RPCs use the TUI's discovery and persisted admission state.
use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_core::elpis_context;
use core_test_support::responses;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::time::timeout;

const WAIT: std::time::Duration = std::time::Duration::from_secs(10);
const LIST: &str = "thread/contextFiles/list";
const SET: &str = "thread/contextFiles/set";
const MEMORY_NONCE: &str = "CONTEXT_FILES_MEMORY_76ba";

struct Fixture {
    _provider: wiremock::MockServer,
    home: TempDir,
    workspace: TempDir,
    mcp: TestAppServer,
    thread_id: String,
    dev_rules: PathBuf,
}

impl Fixture {
    async fn start() -> Result<Self> {
        let provider = responses::start_mock_server().await;
        let home = TempDir::new()?;
        let workspace = TempDir::new()?;
        let dev_rules = home.path().join("dev-rules");
        std::fs::create_dir_all(&dev_rules)?;
        std::fs::write(dev_rules.join("قواعد.md"), "configured development rules")?;
        MockResponsesConfig::new(&provider.uri())
            .with_extra_config(&format!(
                "[skills]\ndev_rule_roots = [{}]",
                serde_json::to_string(&dev_rules)?
            ))
            .write(home.path())?;
        std::fs::create_dir_all(home.path().join("memories"))?;
        std::fs::write(home.path().join("memories/MEMORY.md"), MEMORY_NONCE)?;
        std::fs::write(workspace.path().join("AGENTS.md"), "project instructions")?;
        let mut mcp = TestAppServer::builder()
            .with_codex_home(home.path())
            .without_auto_env()
            .build_initialized()
            .await?;
        let id = mcp
            .send_thread_start_request(ThreadStartParams {
                cwd: Some(workspace.path().display().to_string()),
                ..Default::default()
            })
            .await?;
        let ThreadStartResponse { thread, .. } = timeout(WAIT, mcp.read_response(id)).await??;
        let directory = elpis_context::thread_context_dir(
            Some(&home.path().join("memories")),
            workspace.path(),
            &thread.id,
        )?
        .expect("thread directory");
        std::fs::create_dir_all(&directory)?;
        std::fs::write(directory.join("ES.md"), "thread checkpoint")?;
        Ok(Self {
            _provider: provider,
            home,
            workspace,
            mcp,
            thread_id: thread.id,
            dev_rules,
        })
    }

    async fn request(&mut self, method: &str, extra: Value) -> Result<Value> {
        let mut params = json!({ "threadId": self.thread_id });
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let id = self.mcp.send_request(method, Some(params)).await?;
        Ok(timeout(WAIT, self.mcp.read_response(id)).await??)
    }

    async fn list(&mut self) -> Result<Value> {
        self.request(LIST, json!({})).await
    }

    // This is the exact discovery path used by the TUI's ManualMemoryStatusCoordinator.
    fn tui_sources(&self) -> Result<Vec<elpis_context::ContinuitySource>> {
        let memories = self.home.path().join("memories");
        let status = elpis_context::manual_memory_status(Some(&memories), self.workspace.path())?;
        Ok(elpis_context::continuity_sources_from_manual_memory_status(
            Some(&memories),
            self.workspace.path(),
            &[self.workspace.path().join("AGENTS.md")],
            &[codex_utils_absolute_path::AbsolutePathBuf::try_from(
                self.dev_rules.clone(),
            )?],
            status.as_ref(),
            Some(&self.thread_id),
        )?)
    }
}

fn row<'a>(response: &'a Value, name: &str) -> &'a Value {
    response["files"]
        .as_array()
        .expect("files")
        .iter()
        .find(|file| file["name"] == name)
        .unwrap_or_else(|| panic!("missing {name}: {response}"))
}

#[tokio::test]
async fn lists_all_groups_with_tui_metadata() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let response = fixture.list().await?;
    let tui = fixture.tui_sources()?;
    assert_eq!(response["files"].as_array().unwrap().len(), tui.len());
    for source in tui {
        let file = row(&response, &source.name);
        assert_eq!(file["path"], source.path.to_string_lossy().as_ref());
        assert_eq!(file["estimatedTokens"], source.estimated_tokens);
        assert_eq!(file["included"], source.admitted);
        assert_eq!(file["reason"], source.reason);
        assert_eq!(file["selectable"], source.selectable);
    }
    assert_eq!(row(&response, "ES.md")["group"], "sessionContinuity");
    assert_eq!(row(&response, "MEMORY.md")["group"], "durableMemory");
    assert_eq!(row(&response, "Project AGENTS.md")["group"], "instructions");
    assert_eq!(row(&response, "dev/قواعد.md")["included"], true);
    Ok(())
}

#[tokio::test]
async fn excludes_and_includes_again_in_rpc_tui_and_model_instructions() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    for (name, field, content) in [
        ("MEMORY.md", "continuity", MEMORY_NONCE),
        ("ES.md", "continuity", "thread checkpoint"),
        ("Project AGENTS.md", "agentsMd", "project instructions"),
        ("dev/قواعد.md", "continuity", "configured development rules"),
    ] {
        let listing = fixture.list().await?;
        let path = row(&listing, name)["path"].clone();
        for included in [true, false, true] {
            let updated = fixture
                .request(SET, json!({ "path": path, "included": included }))
                .await?;
            assert_eq!(row(&updated, name)["included"], included);
            let relisted = fixture.list().await?;
            assert_eq!(row(&relisted, name)["included"], included);
            assert_eq!(
                fixture
                    .tui_sources()?
                    .iter()
                    .find(|s| s.name == name)
                    .unwrap()
                    .admitted,
                included
            );
            let instructions = fixture
                .request("thread/elpisInstructions/read", json!({}))
                .await?;
            assert_eq!(
                instructions[field]
                    .as_str()
                    .is_some_and(|s| s.contains(content)),
                included,
                "model instructions did not follow {name} admission"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn refuses_unknown_paths_without_changing_admission() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let before = fixture.list().await?;
    let unknown = fixture.workspace.path().join("not-a-ledger-source.md");
    std::fs::write(&unknown, "not registered")?;
    for path in [
        unknown.display().to_string(),
        "MEMORY.md".into(),
        "../MEMORY.md".into(),
    ] {
        for included in [true, false] {
            let id = fixture
                .mcp
                .send_request(
                    SET,
                    Some(json!({
                        "threadId": fixture.thread_id, "path": path, "included": included,
                    })),
                )
                .await?;
            let error = timeout(
                WAIT,
                fixture
                    .mcp
                    .read_stream_until_error_message(RequestId::Integer(id)),
            )
            .await??;
            assert_eq!(error.error.code, -32600);
            assert!(error.error.message.contains("unknown context file"));
        }
    }
    assert_eq!(fixture.list().await?, before);
    Ok(())
}

#[tokio::test]
async fn listing_refreshes_instruction_discovery_and_thread_scope() -> Result<()> {
    let mut fixture = Fixture::start().await?;
    let before = fixture.list().await?;
    let original = row(&before, "Project AGENTS.md")["path"].clone();
    std::fs::write(
        fixture.workspace.path().join("AGENTS.override.md"),
        "override instructions",
    )?;
    let updated = fixture.list().await?;
    assert_ne!(row(&updated, "Project AGENTS.md")["path"], original);
    let request_id = fixture
        .mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(fixture.workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    let ThreadStartResponse { thread, .. } =
        timeout(WAIT, fixture.mcp.read_response(request_id)).await??;
    fixture.thread_id = thread.id;
    let other = fixture.list().await?;
    assert!(
        !other["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["name"] == "ES.md")
    );
    Ok(())
}

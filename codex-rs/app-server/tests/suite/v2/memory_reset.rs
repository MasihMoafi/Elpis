// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use chrono::Utc;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::MemoryResetResponse;
use codex_app_server_protocol::RequestId;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SessionSource;
use codex_state::Stage1JobClaimOutcome;
use codex_state::StateRuntime;
use codex_state::ThreadMetadataBuilder;
use codex_state::memories_db_path;
use pretty_assertions::assert_eq;
use std::path::Path;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[tokio::test]
async fn memory_reset_clears_memory_files_and_rows_preserves_threads() -> Result<()> {
    let codex_home = TempDir::new()?;
    let elpis_home = TempDir::new()?;
    let memory_root = elpis_home.path().join("memories");
    let memory_state_root = elpis_home.path().join("state");
    create_config_toml(codex_home.path(), &memory_root, &memory_state_root)?;
    let state_db = init_state_db(codex_home.path(), &memory_state_root).await?;

    tokio::fs::create_dir_all(memory_root.join("rollout_summaries")).await?;
    tokio::fs::write(memory_root.join("MEMORY.md"), "stale memory\n").await?;
    tokio::fs::write(
        memory_root.join("rollout_summaries").join("stale.md"),
        "stale rollout summary\n",
    )
    .await?;
    let codex_memory = codex_home.path().join("memories/MEMORY.md");
    tokio::fs::create_dir_all(codex_memory.parent().expect("memory parent")).await?;
    tokio::fs::write(&codex_memory, "preserve Codex memory\n").await?;

    let thread_id = seed_stage1_output(&state_db, codex_home.path()).await?;

    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .without_auto_env()
        .build()
        .await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_raw_request("memory/reset", /*params*/ None)
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let _: MemoryResetResponse = to_response::<MemoryResetResponse>(response)?;

    let stage1_outputs = state_db
        .memories()
        .list_stage1_outputs_for_global(/*n*/ 10)
        .await?;
    assert_eq!(stage1_outputs, Vec::new());
    assert_eq!(
        state_db.get_thread_memory_mode(thread_id).await?.as_deref(),
        Some("enabled")
    );

    let mut remaining_entries = tokio::fs::read_dir(&memory_root).await?;
    assert!(
        remaining_entries.next_entry().await?.is_none(),
        "memory root should be empty after reset"
    );
    assert!(tokio::fs::try_exists(&codex_memory).await?);
    assert!(!tokio::fs::try_exists(memories_db_path(codex_home.path())).await?);

    Ok(())
}

async fn seed_stage1_output(state_db: &Arc<StateRuntime>, codex_home: &Path) -> Result<ThreadId> {
    let now = Utc::now();
    let thread_id = ThreadId::from_string(&Uuid::new_v4().to_string())?;
    let worker_id = ThreadId::from_string(&Uuid::new_v4().to_string())?;
    let mut builder = ThreadMetadataBuilder::new(
        thread_id,
        codex_home.join("sessions").join("test.jsonl"),
        now,
        SessionSource::Cli,
    );
    builder.updated_at = Some(now);
    builder.cwd = codex_home.to_path_buf();
    let metadata = builder.build("mock_provider");
    state_db.upsert_thread(&metadata).await?;

    let claim = state_db
        .memories()
        .try_claim_stage1_job(
            thread_id,
            worker_id,
            now.timestamp(),
            /*lease_seconds*/ 3600,
            /*max_running_jobs*/ 64,
        )
        .await?;
    let Stage1JobClaimOutcome::Claimed { ownership_token } = claim else {
        anyhow::bail!("unexpected stage1 claim outcome: {claim:?}");
    };
    assert!(
        state_db
            .memories()
            .mark_stage1_job_succeeded(
                thread_id,
                ownership_token.as_str(),
                now.timestamp(),
                "raw memory",
                "rollout summary",
                /*rollout_slug*/ None,
            )
            .await?,
        "stage1 success should be recorded"
    );
    state_db
        .memories()
        .enqueue_global_consolidation(now.timestamp())
        .await?;

    Ok(thread_id)
}

async fn init_state_db(codex_home: &Path, memory_state_root: &Path) -> Result<Arc<StateRuntime>> {
    let state_db = StateRuntime::init_with_memories_state_root(
        codex_home.to_path_buf(),
        memory_state_root.to_path_buf(),
        "mock_provider".into(),
    )
    .await?;
    state_db
        .mark_backfill_complete(/*last_watermark*/ None)
        .await?;
    Ok(state_db)
}

fn create_config_toml(
    codex_home: &Path,
    memory_root: &Path,
    memory_state_root: &Path,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
model_provider = "mock_provider"
suppress_unstable_features_warning = true

[features]
sqlite = true

[memories]
root = {memory_root:?}
state_root = {memory_state_root:?}

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#,
            memory_root = memory_root.display().to_string(),
            memory_state_root = memory_state_root.display().to_string(),
        ),
    )
}

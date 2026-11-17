use anyhow::Result;
use app_test_support::TestAppServer;
use codex_app_server::INVALID_PARAMS_ERROR_CODE;
use codex_app_server_protocol::RequestId;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(10);

fn fixture(log_dir: &Path, attempt_id: &str, thread_id: &str) -> Result<()> {
    let attempts = log_dir.join("smart-prune/attempts");
    let admission = log_dir.join("smart-prune/admissions/admission-1");
    std::fs::create_dir_all(&attempts)?;
    std::fs::create_dir_all(admission.join("items"))?;
    let input = json!({"items": [{
        "call_id": "call-1", "source_tokens_estimate": 1200,
        "source_output": {"type": "function_call_output", "call_id": "call-1", "output": "original\nremoved\n"}
    }, {
        "call_id": "call-2", "source_tokens_estimate": 800,
        "source_output": {"type": "function_call_output", "call_id": "call-2", "output": "kept"}
    }]}).to_string();
    std::fs::write(
        attempts.join(format!("{attempt_id}.json")),
        json!({
            "attempt_id": attempt_id, "session_id": thread_id, "thread_id": thread_id,
            "timestamp": "2026-10-17T12:00:00Z", "chat_title": "Test chat", "turn_id": "turn-1",
            "model": "test-model", "reasoning_effort": "low", "status": "admitted",
            "input": input, "error": null, "admission_id": "admission-1"
        })
        .to_string(),
    )?;
    std::fs::write(
        admission.join("manifest.json"),
        json!({"items": [{
            "call_id": "call-1", "source_tokens": 1200, "admitted_tokens": 200,
            "admitted_artifact": "items/compact.json"
        }]})
        .to_string(),
    )?;
    std::fs::write(
        admission.join("items/compact.json"),
        json!({
            "type": "function_call_output", "call_id": "call-1", "output": "original\n"
        })
        .to_string(),
    )?;
    Ok(())
}

async fn rpc(server: &mut TestAppServer, method: &str, params: Value) -> Result<Value> {
    let id = server.send_raw_request(method, Some(params)).await?;
    timeout(TIMEOUT, server.read_response(id)).await?
}

async fn invalid(server: &mut TestAppServer, method: &str, params: Value) -> Result<()> {
    assert_error(server, method, params, INVALID_PARAMS_ERROR_CODE).await
}

async fn assert_error(
    server: &mut TestAppServer,
    method: &str,
    params: Value,
    code: i64,
) -> Result<()> {
    let id = server.send_raw_request(method, Some(params)).await?;
    let error = timeout(
        TIMEOUT,
        server.read_stream_until_error_message(RequestId::Integer(id)),
    )
    .await??;
    assert_eq!(error.error.code, code);
    Ok(())
}

#[tokio::test]
async fn global_log_dispatches_paginated_metadata_and_scoped_detail() -> Result<()> {
    let home = TempDir::new()?;
    let logs = codex_core::smart_prune_log::audit_log_dir(home.path());
    fixture(&logs, "a", "chat-a")?;
    fixture(&logs, "b", "chat-b")?;
    let older = logs.join("smart-prune/attempts/b.json");
    let mut attempt: Value = serde_json::from_slice(&std::fs::read(&older)?)?;
    attempt["timestamp"] = json!("2026-10-16T12:00:00Z");
    std::fs::write(older, attempt.to_string())?;
    std::fs::write(logs.join("smart-prune/attempts/bad.json"), b"{")?;
    let mut server = TestAppServer::builder()
        .with_codex_home(home.path())
        .build_initialized()
        .await?;
    let first = rpc(&mut server, "smartPrune/log/list", json!({"limit": 1})).await?;
    assert_eq!(first["unreadable"], 1);
    assert_eq!(first["data"][0]["threadId"], "chat-a");
    assert_eq!(first["data"][0]["estimatedSavedTokens"], 1000);
    assert!(first["data"][0].get("items").is_none());
    let second = rpc(
        &mut server,
        "smartPrune/log/list",
        json!({"limit": 1, "cursor": first["nextCursor"]}),
    )
    .await?;
    assert_eq!(second["data"][0]["threadId"], "chat-b");
    assert!(second["nextCursor"].is_null());
    let detail = rpc(
        &mut server,
        "smartPrune/log/read",
        json!({"attemptId": "a", "threadId": "chat-a"}),
    )
    .await?;
    let items = &detail["record"]["items"];
    assert_eq!(items[0]["original"], "original\nremoved\n");
    assert_eq!(items[0]["compact"], "original\n");
    assert!(items[0]["diff"].as_str().unwrap().contains("-removed"));
    assert!(items[1]["compact"].is_null());
    assert!(items[1]["diff"].is_null());
    Ok(())
}

#[tokio::test]
async fn global_log_dispatch_rejects_bad_scope_and_limits() -> Result<()> {
    let home = TempDir::new()?;
    fixture(
        &codex_core::smart_prune_log::audit_log_dir(home.path()),
        "a",
        "chat-a",
    )?;
    let mut server = TestAppServer::builder()
        .with_codex_home(home.path())
        .build_initialized()
        .await?;
    invalid(&mut server, "smartPrune/log/list", json!({"limit": 101})).await?;
    invalid(
        &mut server,
        "smartPrune/log/list",
        json!({"cursor": "missing"}),
    )
    .await?;
    invalid(
        &mut server,
        "smartPrune/log/read",
        json!({"attemptId": "a", "threadId": "chat-b"}),
    )
    .await?;
    invalid(
        &mut server,
        "smartPrune/log/read",
        json!({"attemptId": "../a", "threadId": "chat-a"}),
    )
    .await?;
    std::fs::remove_file(
        codex_core::smart_prune_log::audit_log_dir(home.path())
            .join("smart-prune/admissions/admission-1/items/compact.json"),
    )?;
    let page = rpc(&mut server, "smartPrune/log/list", json!({})).await?;
    assert_eq!(page["unreadable"], 1);
    assert_error(
        &mut server,
        "smartPrune/log/read",
        json!({"attemptId": "a", "threadId": "chat-a"}),
        -32603,
    )
    .await?;
    Ok(())
}

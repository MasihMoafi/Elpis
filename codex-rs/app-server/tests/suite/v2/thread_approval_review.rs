use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadStartParams;
use codex_features::Feature;
use core_test_support::responses;
use serde_json::json;
use tempfile::TempDir;

#[tokio::test]
async fn bridged_approval_uses_guardian_and_rejects_review_errors() -> Result<()> {
    for outcome in ["allow", "deny", "invalid"] {
        let model = responses::start_mock_server().await;
        let home = TempDir::new()?;
        MockResponsesConfig::new(&model.uri())
            .with_approval_policy("on-request")
            .with_root_config("approvals_reviewer = \"auto_review\"")
            .enable_feature(Feature::GuardianApproval)
            .write(home.path())?;
        let mock = responses::mount_sse_sequence(
            &model,
            vec![
                responses::sse(vec![
                    responses::ev_response_created("review"),
                    responses::ev_assistant_message(
                        "assessment",
                        &json!({
                            "outcome": outcome, "rationale": "mock review evidence"
                        })
                        .to_string(),
                    ),
                    responses::ev_completed("review"),
                ]);
                if outcome == "invalid" { 3 } else { 1 }
            ],
        )
        .await;
        let mut app = TestAppServer::builder()
            .with_codex_home(home.path())
            .build_initialized()
            .await?;
        let thread = app.start_thread(ThreadStartParams::default()).await?;
        let request = app
            .send_request(
                "thread/approval/review",
                Some(json!({
                    "threadId": thread.thread.id, "command": "echo bridged-review-only",
                    "cwd": home.path(), "reason": "Review a bridged tool without executing it"
                })),
            )
            .await?;
        if outcome == "invalid" {
            let error = app
                .read_stream_until_error_message(RequestId::Integer(request))
                .await?;
            assert_eq!(error.error.code, -32603);
        } else {
            let response = app
                .read_stream_until_response_message(RequestId::Integer(request))
                .await?;
            assert_eq!(
                response.result["decision"],
                if outcome == "allow" {
                    "approved"
                } else {
                    "denied"
                }
            );
            assert_eq!(response.result["rationale"], "mock review evidence");
        }
        let requests = mock.requests();
        assert!(!requests.is_empty());
        for request in requests {
            assert_eq!(
                request.body_json()["client_metadata"]["x-openai-subagent"],
                "guardian"
            );
            assert!(
                request
                    .body_json()
                    .to_string()
                    .contains("bridged-review-only")
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn bridged_approval_invalid_inputs_never_call_a_model() -> Result<()> {
    let model = responses::start_mock_server().await;
    let home = TempDir::new()?;
    MockResponsesConfig::new(&model.uri())
        .with_root_config("approvals_reviewer = \"user\"")
        .write(home.path())?;
    let mut app = TestAppServer::builder()
        .with_codex_home(home.path())
        .build_initialized()
        .await?;
    let thread = app.start_thread(ThreadStartParams::default()).await?;
    for (id, command, cwd, code) in [
        (
            thread.thread.id.as_str(),
            "",
            home.path().to_str().unwrap(),
            -32600,
        ),
        (thread.thread.id.as_str(), "echo test", "relative", -32600),
        (
            "not-a-thread",
            "echo test",
            home.path().to_str().unwrap(),
            -32600,
        ),
        (
            thread.thread.id.as_str(),
            "echo test",
            home.path().to_str().unwrap(),
            -32603,
        ),
    ] {
        let request = app
            .send_request(
                "thread/approval/review",
                Some(json!({
                    "threadId": id, "command": command, "cwd": cwd, "reason": "validation"
                })),
            )
            .await?;
        let error = app
            .read_stream_until_error_message(RequestId::Integer(request))
            .await?;
        assert_eq!(error.error.code, code);
    }
    assert!(model.received_requests().await.unwrap().is_empty());
    Ok(())
}

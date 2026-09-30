//! Elpis: a real turn reports what the dashboard and the Context Ledger show.
//!
//! One sampled turn against a mock provider must produce `turn/activityUpdated` (status and
//! duration), `turn/costUpdated` (always unavailable, with the reason for this login) and
//! category shares on `thread/tokenUsage/updated` that count the planted assistant answer.

use anyhow::Result;
use app_test_support::ChatGptAuthFixture;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::write_chatgpt_auth;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::ThreadTokenUsageUpdatedNotification;
use codex_app_server_protocol::TurnActivityStatus;
use codex_app_server_protocol::TurnActivityUpdatedNotification;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use codex_app_server_protocol::TurnCostUpdatedNotification;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::TurnStartResponse;
use codex_app_server_protocol::UserInput as V2UserInput;
use codex_config::types::AuthCredentialsStoreMode;
use core_test_support::responses;
use core_test_support::skip_if_no_network;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PLANTED_ANSWER: &str = "ELPIS_ACTIVITY_PLANTED_ANSWER_5c1e";

async fn server_with_one_answer() -> wiremock::MockServer {
    let server = responses::start_mock_server().await;
    let turn = responses::sse(vec![
        responses::ev_response_created("activity"),
        responses::ev_assistant_message("activity-answer", PLANTED_ANSWER),
        responses::ev_completed_with_tokens("activity", /*total_tokens*/ 120),
    ]);
    let _responses = responses::mount_sse_sequence(&server, vec![turn]).await;
    server
}

/// Starts a thread and one turn; returns the turn id once the turn has started.
async fn start_one_turn(mcp: &mut TestAppServer) -> Result<(String, String)> {
    let request = mcp
        .send_thread_start_request(ThreadStartParams {
            model: Some("mock-model".to_string()),
            ..Default::default()
        })
        .await?;
    let ThreadStartResponse { thread, .. } =
        timeout(DEFAULT_READ_TIMEOUT, mcp.read_response(request)).await??;
    let request = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id.clone(),
            client_user_message_id: None,
            input: vec![V2UserInput::Text {
                text: "Say the planted answer.".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let TurnStartResponse { turn } =
        timeout(DEFAULT_READ_TIMEOUT, mcp.read_response(request)).await??;
    Ok((thread.id, turn.id))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_reports_timing_cost_state_and_category_shares() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = server_with_one_answer().await;
    let codex_home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri())
        .with_provider_config("supports_websockets = false")
        .write(codex_home.path())?;
    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .with_env_overrides(&[("OPENAI_API_KEY", None)])
        .build_initialized_with_timeout(DEFAULT_READ_TIMEOUT)
        .await?;

    let (thread_id, turn_id) = start_one_turn(&mut mcp).await?;

    let cost: TurnCostUpdatedNotification = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_notification("turn/costUpdated"),
    )
    .await??;
    assert_eq!(
        cost,
        TurnCostUpdatedNotification {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            cost: TurnCostState::Unavailable {
                reason: TurnCostAvailability::CostObservationDisabled,
            },
        }
    );

    // A usage update sent before any request was built carries no shares; the one after the
    // sampled response must.
    let shares = timeout(DEFAULT_READ_TIMEOUT, async {
        loop {
            let usage: ThreadTokenUsageUpdatedNotification =
                mcp.read_notification("thread/tokenUsage/updated").await?;
            if let Some(shares) = usage.token_usage.context_attribution {
                return anyhow::Ok(shares);
            }
        }
    })
    .await??;
    assert!(
        shares.agent_messages > 0,
        "the planted answer counts as agent context"
    );
    assert!(shares.user_messages > 0);
    assert!(shares.system_instructions > 0);

    let activity: TurnActivityUpdatedNotification = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_notification("turn/activityUpdated"),
    )
    .await??;
    assert_eq!(activity.thread_id, thread_id);
    assert_eq!(activity.turn_id, turn_id);
    assert_eq!(activity.status, TurnActivityStatus::Completed);
    assert!(activity.duration_ms.is_some_and(|ms| ms >= 0));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subscription_login_reports_cost_as_unavailable_for_subscription() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = server_with_one_answer().await;
    let codex_home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri())
        .with_provider_name("OpenAI")
        .with_provider_config("requires_openai_auth = true\nsupports_websockets = false")
        .write(codex_home.path())?;
    write_chatgpt_auth(
        codex_home.path(),
        ChatGptAuthFixture::new("access-chatgpt").plan_type("pro"),
        AuthCredentialsStoreMode::File,
    )?;
    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .with_env_overrides(&[("OPENAI_API_KEY", None)])
        .build_initialized_with_timeout(DEFAULT_READ_TIMEOUT)
        .await?;

    let (_, turn_id) = start_one_turn(&mut mcp).await?;

    let cost: TurnCostUpdatedNotification = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_notification("turn/costUpdated"),
    )
    .await??;
    assert_eq!(cost.turn_id, turn_id);
    assert_eq!(
        cost.cost,
        TurnCostState::Unavailable {
            reason: TurnCostAvailability::SubscriptionAuthentication,
        }
    );
    Ok(())
}

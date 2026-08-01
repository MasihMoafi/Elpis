use anyhow::Result;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::skip_if_host_windows;
use core_test_support::test_codex::TestCodexHarness;
use core_test_support::test_codex::test_codex;
use serde_json::json;

const CONTEXT_WINDOW: i64 = 10_000;
const MAIN_MODEL: &str = "gpt-5.4";
const PRUNE_MODEL: &str = "gpt-5.6-luna";
const OLD_CALL_ID: &str = "old-pressure-output";
const CURRENT_CALL_ID: &str = "current-turn-output";

fn shell_arguments(command: &str) -> String {
    serde_json::to_string(&json!({
        "command": command,
        "timeout_ms": 2_000,
        "login": false,
    }))
    .expect("serialize shell arguments")
}

async fn pressure_harness() -> Result<TestCodexHarness> {
    TestCodexHarness::with_builder(
        test_codex()
            .with_model(MAIN_MODEL)
            .with_config(|config| config.model_context_window = Some(CONTEXT_WINDOW)),
    )
    .await
}

fn main_tool_response(call_id: &str, total_tokens: i64, command: &str) -> String {
    sse(vec![
        ev_function_call(call_id, "shell_command", &shell_arguments(command)),
        ev_completed_with_tokens("main-tool", total_tokens),
    ])
}

fn final_response() -> String {
    sse(vec![
        ev_assistant_message("main-final", "done"),
        ev_completed_with_tokens("main-final", /*total_tokens*/ 5_000),
    ])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pressure_prune_runs_at_thirty_percent_and_rewrites_next_request() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = pressure_harness().await?;
    let prune_response = sse(vec![
        ev_assistant_message(
            "prune-result",
            &format!("{OLD_CALL_ID}: command output was generated and inspected"),
        ),
        ev_completed_with_tokens("prune-result", /*total_tokens*/ 100),
    ]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 2_500,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
            final_response(),
            main_tool_response(
                CURRENT_CALL_ID,
                /*total_tokens*/ 3_000,
                "printf current-marker",
            ),
            prune_response,
            final_response(),
        ],
    )
    .await;

    harness.submit("generate an old diagnostic output").await?;
    harness.submit("inspect the current marker").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[0].body_json()["model"], MAIN_MODEL);
    assert_eq!(requests[3].body_json()["model"], PRUNE_MODEL);
    assert_eq!(requests[3].body_json()["reasoning"]["effort"], "max");
    assert_eq!(requests[4].body_json()["model"], MAIN_MODEL);
    assert!(requests[3].body_contains_text("<evidence_batch>"));
    assert!(requests[3].body_contains_text(OLD_CALL_ID));
    assert!(
        !requests[3].body_contains_text("output:\ncurrent-marker"),
        "the pruning model must never receive current-turn tool output"
    );
    assert!(requests[4].body_contains_text("[ELPIS CONTEXT UPDATE]"));
    assert!(requests[4].body_contains_text(&format!("rollout://tool-call/{OLD_CALL_ID}")));
    assert!(requests[4].body_contains_text("Output:\ncurrent-marker"));
    assert!(
        !requests[4].body_contains_text(&"x".repeat(128)),
        "the next real model request must receive the compact receipt, not raw bulk output"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_prune_survives_session_resume() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let server = start_mock_server().await;
    let mut builder = test_codex()
        .with_model(MAIN_MODEL)
        .with_config(|config| config.model_context_window = Some(CONTEXT_WINDOW));
    let initial = builder.build(&server).await?;
    let prune_response = sse(vec![
        ev_assistant_message(
            "resume-prune-result",
            &format!("{OLD_CALL_ID}: command output was generated and inspected"),
        ),
        ev_completed_with_tokens("resume-prune-result", /*total_tokens*/ 100),
    ]);
    let requests = mount_sse_sequence(
        &server,
        vec![
            main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
            final_response(),
            prune_response,
            final_response(),
        ],
    )
    .await;

    initial
        .submit_turn("generate an old diagnostic output")
        .await?;
    let prune_id = initial.codex.submit(Op::Prune { target_pct: None }).await?;
    loop {
        let event = initial.codex.next_event().await?;
        if event.id == prune_id && matches!(event.msg, EventMsg::TurnComplete(_)) {
            break;
        }
    }
    let saved_before_resume = initial.codex.context_prune_saved_tokens().await;
    assert!(saved_before_resume > 0);
    initial.codex.flush_rollout().await?;

    let home = initial.home.clone();
    let rollout_path = initial
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    drop(initial);

    let resumed = builder.resume(&server, home, rollout_path).await?;
    assert_eq!(
        resumed.codex.context_prune_saved_tokens().await,
        saved_before_resume,
        "resuming must restore the cumulative saved-token total"
    );
    resumed.submit_turn("continue after resuming").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 4);
    assert!(requests[3].body_contains_text("[ELPIS CONTEXT UPDATE]"));
    assert!(requests[3].body_contains_text(&format!("rollout://tool-call/{OLD_CALL_ID}")));
    assert!(
        !requests[3].body_contains_text(&"x".repeat(128)),
        "resuming must restore the rewritten history instead of raw tool output"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pressure_prune_does_not_run_below_thirty_percent() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = pressure_harness().await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(CURRENT_CALL_ID, /*total_tokens*/ 2_999, "printf x"),
            final_response(),
        ],
    )
    .await;

    harness.submit("generate a large diagnostic output").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.body_json()["model"] == MAIN_MODEL)
    );
    assert!(requests[1].body_contains_text("Output:\nx"));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_prune_rewrites_completed_tool_output_without_compacting_messages() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = pressure_harness().await?;
    let prune_response = sse(vec![
        ev_assistant_message(
            "manual-prune-result",
            &format!("{OLD_CALL_ID}: command output was generated and inspected"),
        ),
        ev_completed_with_tokens("manual-prune-result", /*total_tokens*/ 100),
    ]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
            final_response(),
            prune_response,
            final_response(),
        ],
    )
    .await;

    harness.submit("generate an old diagnostic output").await?;
    let codex = harness.test().codex.clone();
    let prune_id = codex.submit(Op::Prune { target_pct: None }).await?;
    loop {
        let event = codex.next_event().await?;
        if event.id == prune_id && matches!(event.msg, EventMsg::TurnComplete(_)) {
            break;
        }
    }
    harness.submit("continue after the manual prune").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[2].body_json()["model"],
        PRUNE_MODEL,
        "request models: {:?}",
        requests
            .iter()
            .map(|request| request.body_json()["model"].clone())
            .collect::<Vec<_>>()
    );
    assert!(requests[2].body_contains_text("<evidence_batch>"));
    assert!(requests[2].body_contains_text(OLD_CALL_ID));
    assert!(requests[3].body_contains_text("generate an old diagnostic output"));
    assert!(requests[3].body_contains_text("continue after the manual prune"));
    assert!(requests[3].body_contains_text("[ELPIS CONTEXT UPDATE]"));
    assert!(
        !requests[3].body_contains_text(&"x".repeat(128)),
        "manual pruning must replace raw bulk output while preserving the conversation"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_prune_without_completed_tool_output_makes_no_model_request() -> Result<()> {
    let harness = pressure_harness().await?;
    let requests =
        mount_sse_sequence(harness.server(), vec![final_response(), final_response()]).await;

    harness.submit("a message with no tool output").await?;
    let codex = harness.test().codex.clone();
    let prune_id = codex.submit(Op::Prune { target_pct: None }).await?;
    loop {
        let event = codex.next_event().await?;
        if event.id == prune_id && matches!(event.msg, EventMsg::TurnComplete(_)) {
            break;
        }
    }
    harness.submit("continue unchanged").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1].body_contains_text("a message with no tool output"),
        "a no-op manual prune must preserve the existing conversation"
    );

    Ok(())
}

use anyhow::Result;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
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
async fn pressure_prune_runs_at_sixty_percent_and_rewrites_next_request() -> Result<()> {
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
                /*total_tokens*/ 5_500,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
            final_response(),
            main_tool_response(
                CURRENT_CALL_ID,
                /*total_tokens*/ 6_000,
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
async fn pressure_prune_does_not_run_below_sixty_percent() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = pressure_harness().await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(CURRENT_CALL_ID, /*total_tokens*/ 5_500, "printf x"),
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

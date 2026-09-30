//! Elpis: a real sampled turn records the category shares the Context Ledger shows.
//!
//! Ported from v0.3.0 `context_attribution.rs`. v0.3.0 read the snapshot from `TokenCountEvent`;
//! this build keeps it in the thread's extension data, where the app server reads it when it
//! forwards token usage, so the test reads it there too.

use anyhow::Result;
use codex_core::elpis_context_attribution::ContextAttributionSnapshot;
use codex_core::elpis_context_attribution::latest;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;

const PLANTED_ANSWER: &str = "PLANTED_ANSWER_42 is present in the retained assistant response.";

/// The recorded snapshot before any request and after one sampled turn.
async fn attribution_around_one_turn(
    answer: Option<&str>,
) -> Result<(
    Option<ContextAttributionSnapshot>,
    Option<ContextAttributionSnapshot>,
)> {
    let server = start_mock_server().await;
    let mut events = Vec::new();
    if let Some(answer) = answer {
        events.push(ev_assistant_message("answer", answer));
    }
    events.push(ev_completed_with_tokens("response", 1_000));
    let _requests = mount_sse_sequence(&server, vec![sse(events)]).await;
    let test = test_codex().build(&server).await?;
    let before = latest(test.codex.thread_extension_data());
    test.submit_turn("Describe the planted response marker.")
        .await?;
    Ok((before, latest(test.codex.thread_extension_data())))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_assistant_response_updates_context_categories() -> Result<()> {
    let (before, after) = attribution_around_one_turn(Some(PLANTED_ANSWER)).await?;
    assert_eq!(before, None, "no request was built yet, so nothing is reported");
    let after = after.expect("the sampled turn records its request composition");
    assert!(
        after.agent_messages > 0,
        "the completed assistant response must count before another user turn"
    );
    assert!(after.user_messages > 0);
    assert!(after.system_instructions > 0);
    assert!(after.tool_definitions > 0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_response_does_not_invent_agent_context() -> Result<()> {
    let (_, after) = attribution_around_one_turn(/*answer*/ None).await?;
    let after = after.expect("the sampled turn records its request composition");
    assert_eq!(after.agent_messages, 0);
    assert!(after.user_messages > 0);
    Ok(())
}

//! Observe the same token events consumed by the Ledger after a real sampled response.
use anyhow::Result;
use codex_protocol::protocol::ContextAttributionSnapshot;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use codex_protocol::user_input::UserInput;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;

async fn sampled_attributions(answer: Option<&str>) -> Result<Vec<ContextAttributionSnapshot>> {
    let server = start_mock_server().await;
    let mut events = Vec::new();
    if let Some(answer) = answer {
        events.push(ev_assistant_message("answer", answer));
    }
    events.push(ev_completed_with_tokens("response", 1_000));
    let _requests = mount_sse_sequence(&server, vec![sse(events)]).await;
    let test = test_codex().build(&server).await?;
    test.codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "Describe the planted response marker.".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await?;
    let mut snapshots = Vec::new();
    loop {
        let event = test.codex.next_event().await?;
        match event.msg {
            EventMsg::TokenCount(event) => {
                if let Some(snapshot) = event.context_attribution {
                    snapshots.push(snapshot);
                }
            }
            EventMsg::TurnComplete(_) => break,
            _ => {}
        }
    }
    Ok(snapshots)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_assistant_response_updates_context_categories() -> Result<()> {
    let snapshots = sampled_attributions(Some(
        "PLANTED_ANSWER_42 is present in the retained assistant response.",
    ))
    .await?;
    let before = snapshots.first().expect("initial request attribution");
    let after = snapshots.last().expect("completed context attribution");
    assert_eq!(before.agent_messages, 0);
    assert!(
        after.agent_messages > 0,
        "the completed assistant response must appear before another user turn"
    );
    assert_eq!(after.user_messages, before.user_messages);
    assert_eq!(after.system_instructions, before.system_instructions);
    assert_eq!(after.tool_definitions, before.tool_definitions);
    assert!(after.estimated_total > before.estimated_total);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_response_does_not_invent_agent_context() -> Result<()> {
    let snapshots = sampled_attributions(None).await?;
    assert!(!snapshots.is_empty());
    assert!(
        snapshots
            .iter()
            .all(|snapshot| snapshot.agent_messages == 0)
    );
    Ok(())
}

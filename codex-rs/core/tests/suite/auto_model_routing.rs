use anyhow::Result;
use codex_features::Feature;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ModelRerouteReason;
use codex_protocol::protocol::Op;
use codex_protocol::user_input::UserInput;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::skip_if_host_windows;
use core_test_support::test_codex::TestCodexHarness;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event_match;

const LUNA_MODEL: &str = "gpt-5.6-luna";
const TERRA_MODEL: &str = "gpt-5.6-terra";
const SOL_MODEL: &str = "gpt-5.6-sol";

async fn auto_harness() -> Result<TestCodexHarness> {
    TestCodexHarness::with_builder(test_codex().with_model(TERRA_MODEL).with_config(|config| {
        let _ = config.features.enable(Feature::AutomaticModelRouting);
    }))
    .await
}

async fn submit_and_capture_route(
    harness: &TestCodexHarness,
    prompt: &str,
) -> codex_protocol::protocol::ModelRerouteEvent {
    harness
        .test()
        .codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: prompt.to_string(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .expect("submit Auto-routed turn");

    let route = wait_for_event_match(&harness.test().codex, |event| match event {
        EventMsg::ModelReroute(event) => Some(event.clone()),
        _ => None,
    })
    .await;
    wait_for_event_match(&harness.test().codex, |event| {
        matches!(event, EventMsg::TurnComplete(_)).then_some(())
    })
    .await;
    route
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_uses_terra_to_route_then_runs_the_selected_model() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = auto_harness().await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            sse(vec![
                ev_assistant_message("route", SOL_MODEL),
                ev_completed_with_tokens("route", 100),
            ]),
            sse(vec![
                ev_assistant_message("answer", "reviewed"),
                ev_completed_with_tokens("answer", 200),
            ]),
        ],
    )
    .await;

    let route = submit_and_capture_route(&harness, "Perform a critical security audit").await;

    assert_eq!(route.from_model, "auto");
    assert_eq!(route.to_model, SOL_MODEL);
    assert_eq!(route.reason, ModelRerouteReason::AutoModelRouting);
    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body_json()["model"], TERRA_MODEL);
    assert!(requests[0].body_contains_text("You are the Elpis model router."));
    assert_eq!(requests[1].body_json()["model"], SOL_MODEL);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auto_falls_back_to_terra_on_an_invalid_classifier_reply() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = auto_harness().await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            sse(vec![
                ev_assistant_message("route", "I would choose Luna"),
                ev_completed_with_tokens("route", 100),
            ]),
            sse(vec![
                ev_assistant_message("answer", "done"),
                ev_completed_with_tokens("answer", 200),
            ]),
        ],
    )
    .await;

    let route = submit_and_capture_route(&harness, "Copy one file").await;

    assert_eq!(route.from_model, "auto");
    assert_eq!(route.to_model, TERRA_MODEL);
    assert_eq!(route.reason, ModelRerouteReason::AutoModelRouting);
    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].body_json()["model"], TERRA_MODEL);
    assert_eq!(requests[1].body_json()["model"], TERRA_MODEL);
    assert!(
        requests[0].body_contains_text(LUNA_MODEL),
        "classifier prompt should include live Luna catalog metadata"
    );

    Ok(())
}

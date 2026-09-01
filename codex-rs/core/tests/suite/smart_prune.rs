use anyhow::Result;
use codex_features::Feature;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use codex_protocol::user_input::UserInput;
use core_test_support::responses::ResponsesRequest;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::mount_response_sequence;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::sse_response;
use core_test_support::responses::strip_metadata_from_items;
use core_test_support::skip_if_host_windows;
use core_test_support::test_codex::TestCodexHarness;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

const MAIN_MODEL: &str = "gpt-5.4";
const CACHE_TEST_MODEL: &str = "gpt-5.6-sol";
const SMART_PRUNE_MODEL: &str = "gpt-5.6-luna";
const CALL_A: &str = "smart-prune-call-a";
const CALL_B: &str = "smart-prune-call-b";
const COMPACT_A: &str = "The command produced a long run of the letter Z for cache testing.";

fn shell_arguments(character_code: u8) -> String {
    serde_json::to_string(&json!({
        "command": format!(
            "awk 'BEGIN {{ for (i=0; i<12000; i++) printf \"%c\", {character_code} }}'"
        ),
        "timeout_ms": 2_000,
        "login": false,
    }))
    .expect("serialize shell arguments")
}

fn tool_response(call_id: &str, character_code: u8) -> String {
    sse(vec![
        ev_function_call(call_id, "shell_command", &shell_arguments(character_code)),
        ev_completed_with_tokens("main-tool", 100),
    ])
}

fn mixed_tool_response() -> String {
    let small_arguments = serde_json::to_string(&json!({
        "command": "printf small-output",
        "timeout_ms": 2_000,
        "login": false,
    }))
    .expect("serialize small shell arguments");
    sse(vec![
        ev_function_call(CALL_A, "shell_command", &shell_arguments(90)),
        ev_function_call(CALL_B, "shell_command", &small_arguments),
        ev_completed_with_tokens("main-tools", 100),
    ])
}

fn admission_response(call_id: &str, compact: &str) -> String {
    let response = serde_json::to_string(&json!({
        "items": [{
            "call_id": call_id,
            "decision": "compact",
            "content": compact,
        }]
    }))
    .expect("serialize admission response");
    sse(vec![
        ev_assistant_message("smart-prune-result", &response),
        ev_completed_with_tokens("smart-prune-result", 75),
    ])
}

fn malformed_admission_with_usage(
    response_id: &str,
    total_tokens: i64,
    cache_write_tokens: Option<i64>,
) -> String {
    let mut input_details = json!({"cached_tokens": 0});
    if let Some(cache_write_tokens) = cache_write_tokens {
        input_details["cache_write_tokens"] = json!(cache_write_tokens);
    }
    sse(vec![
        ev_assistant_message(response_id, "not valid JSON"),
        json!({
            "type": "response.completed",
            "response": {
                "id": response_id,
                "usage": {
                    "input_tokens": total_tokens,
                    "input_tokens_details": input_details,
                    "output_tokens": 0,
                    "output_tokens_details": null,
                    "total_tokens": total_tokens,
                }
            }
        }),
    ])
}

fn final_response() -> String {
    sse(vec![
        ev_assistant_message("main-final", "done"),
        ev_completed_with_tokens("main-final", 200),
    ])
}

fn optimizer_source_output(request: &ResponsesRequest, call_id: &str) -> ResponseItem {
    let prompt = request.message_input_texts("user");
    assert_eq!(prompt.len(), 1, "Smart Prune has one user input");
    let input: serde_json::Value =
        serde_json::from_str(&prompt[0]).expect("parse Smart Prune input");
    let source = input["items"]
        .as_array()
        .expect("Smart Prune items")
        .iter()
        .find(|item| item["call_id"] == call_id)
        .expect("Smart Prune source item")["source_output"]
        .clone();
    serde_json::from_value(source).expect("deserialize Smart Prune source output")
}

fn main_request_output(request: &ResponsesRequest, call_id: &str) -> ResponseItem {
    serde_json::from_value(request.function_call_output(call_id))
        .expect("deserialize main-request tool output")
}

fn assert_source_output_preserved(
    optimizer_request: &ResponsesRequest,
    main_request: &ResponsesRequest,
    call_id: &str,
) {
    let source = optimizer_source_output(optimizer_request, call_id);
    let admitted = main_request_output(main_request, call_id);
    assert_eq!(
        strip_metadata_from_items(&[source]),
        strip_metadata_from_items(&[admitted]),
        "fail-open must preserve the source envelope apart from standard downstream transport metadata"
    );
}

async fn harness_for_model(enabled: bool, model: &str) -> Result<TestCodexHarness> {
    TestCodexHarness::with_builder(test_codex().with_model(model).with_config(move |config| {
        config.model_context_window = Some(100_000);
        if enabled {
            let _ = config.features.enable(Feature::AutomaticContextPruning);
        }
    }))
    .await
}

async fn harness(enabled: bool) -> Result<TestCodexHarness> {
    harness_for_model(enabled, MAIN_MODEL).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn smart_prune_admits_compact_output_before_first_main_followup() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness_for_model(true, CACHE_TEST_MODEL).await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            admission_response(CALL_A, COMPACT_A),
            final_response(),
        ],
    )
    .await;

    harness.submit("generate a large diagnostic output").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].body_json()["model"], CACHE_TEST_MODEL);
    assert_eq!(requests[1].body_json()["model"], SMART_PRUNE_MODEL);
    assert_eq!(requests[1].body_json()["reasoning"]["effort"], "max");
    assert_eq!(requests[2].body_json()["model"], CACHE_TEST_MODEL);
    assert!(requests[1].body_contains_text(CALL_A));
    assert!(requests[1].body_contains_text(&"Z".repeat(256)));
    assert!(requests[2].body_contains_text(COMPACT_A));
    assert!(requests[2].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(requests[2].body_contains_text("exact_source=smart-prune://"));
    assert!(!requests[2].body_contains_text(&"Z".repeat(256)));
    let first_main_input = requests[0].body_json()["input"]
        .as_array()
        .expect("initial main input")
        .clone();
    let followup_main_input = requests[2].body_json()["input"]
        .as_array()
        .expect("follow-up main input")
        .clone();
    assert!(
        followup_main_input.len() >= first_main_input.len(),
        "Smart Prune shortened already-visible main history"
    );
    assert_eq!(
        first_main_input,
        followup_main_input[..first_main_input.len()],
        "Smart Prune must append to, never rewrite, the provider-visible main prefix"
    );
    let first_main_body = requests[0].body_json();
    let followup_main_body = requests[2].body_json();
    assert!(
        first_main_body["input"]
            .as_array()
            .is_some_and(|items| items
                .iter()
                .filter_map(|item| item["content"].as_array())
                .flatten()
                .any(|block| block["prompt_cache_breakpoint"]["mode"] == "explicit")),
        "GPT-5.6 direct Responses requests must exercise a stamped cache breakpoint"
    );
    for field in [
        "instructions",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "store",
        "stream",
        "include",
        "service_tier",
        "prompt_cache_options",
        "text",
    ] {
        assert_eq!(
            first_main_body.get(field),
            followup_main_body.get(field),
            "cache-relevant main request field changed: {field}"
        );
    }
    let main_cache_key = first_main_body["prompt_cache_key"]
        .as_str()
        .filter(|key| !key.is_empty())
        .expect("main request must carry a nonempty prompt cache key");
    assert_eq!(
        followup_main_body["prompt_cache_key"].as_str(),
        Some(main_cache_key)
    );
    let optimizer_body = requests[1].body_json();
    let optimizer_cache_key = optimizer_body["prompt_cache_key"]
        .as_str()
        .filter(|key| !key.is_empty())
        .expect("Smart Prune request must carry a nonempty prompt cache key");
    assert_ne!(main_cache_key, optimizer_cache_key);
    assert!(optimizer_cache_key.ends_with(":smart-prune"));

    let admission_root = harness
        .test()
        .codex_home_path()
        .join("logs/smart-prune/admissions");
    let admission_dirs = std::fs::read_dir(admission_root)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(admission_dirs.len(), 1);
    let admission_dir = admission_dirs[0].path();
    assert!(admission_dir.join("manifest.json").is_file());
    assert!(admission_dir.join("ace.json").is_file());
    assert!(admission_dir.join("request.json").is_file());
    assert!(admission_dir.join("response.json").is_file());
    let source =
        std::fs::read_to_string(admission_dir.join(format!("items/000-{CALL_A}-source.json")))?;
    let admitted =
        std::fs::read_to_string(admission_dir.join(format!("items/000-{CALL_A}-admitted.json")))?;
    assert!(source.contains(&"Z".repeat(256)));
    assert!(!admitted.contains(&"Z".repeat(256)));
    assert!(admitted.contains(COMPACT_A));
    let request_link: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        admission_dir.join("request.json"),
    )?)?;
    assert_eq!(request_link["request_sequence"], 2);
    assert_eq!(
        request_link["input_representation"],
        "logical_response_items_before_transport"
    );
    let request_hash = request_link["request_input_sha256"]
        .as_str()
        .expect("request linkage must carry a SHA-256 receipt");
    assert_eq!(request_hash.len(), 64);
    assert!(request_hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let response_link: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        admission_dir.join("response.json"),
    )?)?;
    assert_eq!(response_link["response_id"], "main-final");
    assert_eq!(response_link["usage"]["total_tokens"], 200);
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    let latest = snapshot.latest.expect("latest Smart Prune admission");
    assert_eq!(latest.request_input_sha256.as_deref(), Some(request_hash));
    assert!(latest.request_linkage_verified);
    assert!(latest.response_linkage_verified);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn smart_prune_off_sends_original_without_optimizer_request() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness_for_model(false, CACHE_TEST_MODEL).await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![tool_response(CALL_A, 90), final_response()],
    )
    .await;

    harness.submit("generate a large diagnostic output").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.body_json()["model"] == CACHE_TEST_MODEL)
    );
    assert!(requests[1].body_contains_text(&"Z".repeat(256)));
    assert!(!requests[1].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(
        !harness
            .test()
            .codex_home_path()
            .join("logs/smart-prune")
            .exists()
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupt_cancels_in_flight_smart_prune_without_waiting_for_timeout() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let requests = mount_response_sequence(
        harness.server(),
        vec![
            sse_response(tool_response(CALL_A, 90)),
            sse_response(admission_response(CALL_A, COMPACT_A)).set_delay(Duration::from_secs(30)),
        ],
    )
    .await;
    let codex = Arc::clone(&harness.test().codex);

    codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "generate a large diagnostic output".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await?;

    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.requests().len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Smart Prune request should start");

    let interrupted_at = Instant::now();
    codex.submit(Op::Interrupt).await?;
    tokio::time::timeout(
        Duration::from_secs(2),
        wait_for_event(&codex, |event| matches!(event, EventMsg::TurnAborted(_))),
    )
    .await
    .expect("interrupt must not wait for the 45-second Smart Prune timeout");
    assert!(interrupted_at.elapsed() < Duration::from_secs(2));

    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.optimizer_requests, 1);
    assert_eq!(snapshot.failed_batches, 0);
    assert_eq!(snapshot.examined_outputs, 0);
    assert_eq!(snapshot.unchanged_outputs, 0);
    assert!(
        !harness
            .test()
            .codex_home_path()
            .join("logs/smart-prune/admissions")
            .exists()
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn smart_prune_malformed_reply_fails_open() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let malformed = sse(vec![
        ev_assistant_message("bad-smart-prune", "not valid JSON"),
        ev_completed_with_tokens("bad-smart-prune", 25),
    ]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![tool_response(CALL_A, 90), malformed, final_response()],
    )
    .await;

    harness.submit("generate a large diagnostic output").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].body_json()["model"], SMART_PRUNE_MODEL);
    assert_source_output_preserved(&requests[1], &requests[2], CALL_A);
    assert!(requests[2].body_contains_text(&"Z".repeat(256)));
    assert!(!requests[2].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(
        !harness
            .test()
            .codex_home_path()
            .join("logs/smart-prune/admissions")
            .exists()
    );
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.optimizer_requests, 1);
    assert_eq!(snapshot.optimizer_usage_reports, 1);
    assert_eq!(snapshot.optimizer_usage.input_tokens, 25);
    assert_eq!(snapshot.optimizer_usage.cache_write_tokens, None);
    Ok(())
}

#[tokio::test]
async fn failed_optimizer_skips_later_batches_in_same_turn() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let requests = mount_response_sequence(
        harness.server(),
        vec![
            sse_response(tool_response(CALL_A, 90)),
            sse_response(admission_response(CALL_A, COMPACT_A)).set_delay(Duration::from_secs(60)),
            sse_response(tool_response(CALL_B, 89)),
            sse_response(final_response()),
        ],
    )
    .await;
    let codex = Arc::clone(&harness.test().codex);

    codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "generate two large diagnostic outputs after one optimizer failure".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await?;

    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.requests().len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Smart Prune request should start");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(46)).await;
    tokio::time::resume();

    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.requests().len() < 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("second main follow-up should start without another optimizer request");

    let requests = requests.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].body_json()["model"], MAIN_MODEL);
    assert_eq!(requests[1].body_json()["model"], SMART_PRUNE_MODEL);
    assert_eq!(requests[2].body_json()["model"], MAIN_MODEL);
    assert_eq!(requests[3].body_json()["model"], MAIN_MODEL);
    assert_source_output_preserved(&requests[1], &requests[2], CALL_A);
    assert!(requests[3].body_contains_text(&"Y".repeat(256)));
    assert!(!requests[3].body_contains_text("[ELPIS SMART PRUNE]"));

    tokio::time::timeout(
        Duration::from_secs(5),
        wait_for_event(&codex, |event| matches!(event, EventMsg::TurnComplete(_))),
    )
    .await
    .expect("turn should complete after one bounded Smart Prune timeout");

    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.optimizer_requests, 1);
    assert_eq!(snapshot.failed_batches, 1);
    assert_eq!(snapshot.examined_outputs, 1);
    assert_eq!(snapshot.unchanged_outputs, 1);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn insufficient_savings_preserve_exact_tool_output() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let oversized_compaction = "Q".repeat(11_500);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            admission_response(CALL_A, &oversized_compaction),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("preserve an unprofitable tool output")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_source_output_preserved(&requests[1], &requests[2], CALL_A);
    assert!(!requests[2].body_contains_text(&oversized_compaction));
    assert!(!requests[2].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(
        !harness
            .test()
            .codex_home_path()
            .join("logs/smart-prune/admissions")
            .exists()
    );
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.examined_outputs, 1);
    assert_eq!(snapshot.admitted_outputs, 0);
    assert_eq!(snapshot.unchanged_outputs, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_batch_compacts_only_eligible_text_output() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            mixed_tool_response(),
            admission_response(CALL_A, COMPACT_A),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("run one large and one small command")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].body_contains_text(CALL_A));
    assert!(!requests[1].body_contains_text(CALL_B));
    let followup_body = requests[2].body_json();
    let followup_input = followup_body["input"]
        .as_array()
        .expect("main follow-up input");
    let large_output = followup_input
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == CALL_A)
        .expect("large tool output")["output"]
        .as_str()
        .expect("large text output");
    let small_output = followup_input
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == CALL_B)
        .expect("small tool output")["output"]
        .as_str()
        .expect("small text output");
    assert!(large_output.contains(COMPACT_A));
    assert!(!large_output.contains(&"Z".repeat(256)));
    assert!(small_output.contains("small-output"));
    assert!(!small_output.contains("[ELPIS SMART PRUNE]"));
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.examined_outputs, 1);
    assert_eq!(snapshot.admitted_outputs, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_publication_failure_preserves_exact_tool_output() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let logs = harness.test().codex_home_path().join("logs");
    std::fs::create_dir_all(&logs)?;
    std::fs::write(logs.join("smart-prune"), b"block audit directory creation")?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            admission_response(CALL_A, COMPACT_A),
            final_response(),
        ],
    )
    .await;

    harness.submit("preserve output when audit fails").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_source_output_preserved(&requests[1], &requests[2], CALL_A);
    assert!(!requests[2].body_contains_text(COMPACT_A));
    assert!(!requests[2].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(logs.join("smart-prune").is_file());
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.failed_batches, 1);
    assert_eq!(snapshot.unchanged_outputs, 1);
    assert!(snapshot.latest.is_none());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn smart_prune_stream_without_completed_fails_open() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let manifest = serde_json::to_string(&json!({
        "items": [{
            "call_id": CALL_A,
            "decision": "compact",
            "content": COMPACT_A,
        }]
    }))?;
    let incomplete_admission = sse(vec![ev_assistant_message(
        "incomplete-smart-prune",
        &manifest,
    )]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            incomplete_admission,
            final_response(),
        ],
    )
    .await;

    harness
        .submit("preserve output after an incomplete optimizer stream")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].body_json()["model"], SMART_PRUNE_MODEL);
    assert!(requests[2].body_contains_text(&"Z".repeat(256)));
    assert!(!requests[2].body_contains_text("[ELPIS SMART PRUNE]"));
    assert!(
        !harness
            .test()
            .codex_home_path()
            .join("logs/smart-prune/admissions")
            .exists()
    );
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.optimizer_requests, 1);
    assert_eq!(snapshot.optimizer_usage_reports, 0);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn optimizer_usage_preserves_absent_then_reported_zero_cache_writes() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            malformed_admission_with_usage("malformed-a", 40, None),
            final_response(),
            tool_response(CALL_B, 89),
            malformed_admission_with_usage("malformed-b", 60, Some(0)),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("record optimizer usage without cache-write data")
        .await?;
    let first_snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(first_snapshot.optimizer_requests, 1);
    assert_eq!(first_snapshot.failed_batches, 1);

    harness
        .submit("record optimizer usage with a reported zero cache write")
        .await?;

    assert_eq!(requests.requests().len(), 6);
    let snapshot = harness.test().codex.smart_prune_snapshot().await;
    assert_eq!(snapshot.optimizer_requests, 2);
    assert_eq!(snapshot.optimizer_usage_reports, 2);
    assert_eq!(snapshot.optimizer_usage.input_tokens, 100);
    assert_eq!(snapshot.optimizer_usage.total_tokens, 100);
    assert_eq!(snapshot.optimizer_usage.cache_write_tokens, Some(0));
    assert_eq!(snapshot.failed_batches, 2);
    assert_eq!(snapshot.examined_outputs, 2);
    assert_eq!(snapshot.unchanged_outputs, 2);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_history_is_an_exact_prefix_across_later_tool_cycles() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness = harness(true).await?;
    let compact_b = "The command produced a long run of the letter Y for prefix testing.";
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            admission_response(CALL_A, COMPACT_A),
            tool_response(CALL_B, 89),
            admission_response(CALL_B, compact_b),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("generate two large diagnostic outputs")
        .await?;

    let requests = requests.requests();
    let main_requests = requests
        .iter()
        .filter(|request| request.body_json()["model"] == MAIN_MODEL)
        .collect::<Vec<_>>();
    assert_eq!(main_requests.len(), 3);
    let first_body = main_requests[1].body_json();
    let second_body = main_requests[2].body_json();
    let first_followup = first_body["input"]
        .as_array()
        .expect("first main follow-up input");
    let second_followup = second_body["input"]
        .as_array()
        .expect("second main follow-up input");
    assert!(second_followup.len() > first_followup.len());
    assert_eq!(
        first_followup,
        &second_followup[..first_followup.len()],
        "the already-admitted main-input prefix must never be rewritten"
    );
    assert_eq!(
        second_followup
            .iter()
            .filter(|item| item["call_id"] == CALL_A && item["type"] == "function_call_output")
            .count(),
        1
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_links_admission_to_attempt_that_first_exposes_it() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness =
        TestCodexHarness::with_builder(test_codex().with_model(MAIN_MODEL).with_config(|config| {
            config.model_context_window = Some(100_000);
            config.model_provider.stream_max_retries = Some(1);
            let _ = config.features.enable(Feature::AutomaticContextPruning);
        }))
        .await?;
    let incomplete_tool_response = sse(vec![ev_function_call(
        CALL_A,
        "shell_command",
        &shell_arguments(90),
    )]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            incomplete_tool_response,
            admission_response(CALL_A, COMPACT_A),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("retry after a large diagnostic output")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].body_json()["model"], MAIN_MODEL);
    assert_eq!(requests[1].body_json()["model"], SMART_PRUNE_MODEL);
    assert_eq!(requests[2].body_json()["model"], MAIN_MODEL);
    assert!(requests[2].body_contains_text(COMPACT_A));
    assert!(!requests[2].body_contains_text(&"Z".repeat(256)));

    let admission_root = harness
        .test()
        .codex_home_path()
        .join("logs/smart-prune/admissions");
    let admission_dirs = std::fs::read_dir(admission_root)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(admission_dirs.len(), 1);
    let admission_dir = admission_dirs[0].path();
    let request_link: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        admission_dir.join("request.json"),
    )?)?;
    assert_eq!(request_link["request_sequence"], 2);
    let retry_input: Vec<ResponseItem> =
        serde_json::from_value(requests[2].body_json()["input"].clone())?;
    let expected_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&retry_input)?));
    assert_eq!(request_link["request_input_sha256"], expected_hash);
    let response_link: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        admission_dir.join("response.json"),
    )?)?;
    assert_eq!(response_link["response_id"], "main-final");

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_response_is_not_attached_to_failed_first_exposure_attempt() -> Result<()> {
    skip_if_host_windows!(Ok(()));
    let harness =
        TestCodexHarness::with_builder(test_codex().with_model(MAIN_MODEL).with_config(|config| {
            config.model_context_window = Some(100_000);
            config.model_provider.stream_max_retries = Some(1);
            let _ = config.features.enable(Feature::AutomaticContextPruning);
        }))
        .await?;
    let incomplete_first_exposure = sse(vec![json!({
        "type": "response.output_item.done",
    })]);
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            tool_response(CALL_A, 90),
            admission_response(CALL_A, COMPACT_A),
            incomplete_first_exposure,
            final_response(),
        ],
    )
    .await;

    harness
        .submit("do not misattribute a retry response")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 4);
    assert!(requests[2].body_contains_text(COMPACT_A));
    assert!(requests[3].body_contains_text(COMPACT_A));
    let admission_root = harness
        .test()
        .codex_home_path()
        .join("logs/smart-prune/admissions");
    let admission_dirs = std::fs::read_dir(admission_root)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(admission_dirs.len(), 1);
    let admission_dir = admission_dirs[0].path();
    assert!(admission_dir.join("request.json").is_file());
    assert!(
        !admission_dir.join("response.json").exists(),
        "the successful retry response must not be attributed to an earlier failed request"
    );

    Ok(())
}

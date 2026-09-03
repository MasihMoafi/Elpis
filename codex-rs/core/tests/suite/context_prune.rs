use anyhow::Result;
use codex_features::Feature;
use codex_protocol::protocol::CompactedItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use codex_protocol::protocol::RolloutItem;
use core_test_support::responses;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed_with_tokens;
use core_test_support::responses::ev_function_call;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::skip_if_host_windows;
use core_test_support::streaming_sse::StreamingSseChunk;
use core_test_support::streaming_sse::start_streaming_sse_server;
use core_test_support::test_codex::TestCodexHarness;
use core_test_support::test_codex::test_codex;
use core_test_support::wait_for_event;
use serde_json::json;
use serial_test::serial;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::oneshot;

const CONTEXT_WINDOW: i64 = 10_000;
const MAIN_MODEL: &str = "gpt-5.4";
const PRUNE_MODEL: &str = "gpt-5.6-luna";
const OLD_CALL_ID: &str = "old-pressure-output";
const GLOBAL_INSTRUCTIONS: &str = "global instructions for the prune/AGENTS.md regression test";

/// Pins the thread to one workspace and admits the global AGENTS.md row there, so build
/// and resume address the same Context Ledger entry.
fn pin_workspace_and_admit_global_rules(
    workspace: Arc<TempDir>,
) -> impl FnOnce(&mut codex_core::config::Config) + Send + 'static {
    move |config| {
        config.cwd =
            codex_utils_absolute_path::AbsolutePathBuf::try_from(workspace.path().to_path_buf())
                .expect("absolute workspace path");
        codex_core::elpis_context::set_continuity_source_admitted(
            Some(config.memory_dir.as_path()),
            config.cwd.as_path(),
            "Global AGENTS.md",
            true,
        )
        .expect("admit AGENTS.md in the ledger");
    }
}

fn shell_arguments(command: &str) -> String {
    serde_json::to_string(&json!({
        "command": command,
        "timeout_ms": 2_000,
        "login": false,
    }))
    .expect("serialize shell arguments")
}

async fn manual_harness() -> Result<TestCodexHarness> {
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

fn context_prune_checkpoints(items: Vec<RolloutItem>) -> Vec<CompactedItem> {
    items
        .into_iter()
        .filter_map(|item| match item {
            RolloutItem::Compacted(item) if item.is_context_prune_checkpoint() => Some(item),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn automatic_prune_is_disabled_by_default() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = TestCodexHarness::with_builder(
        test_codex()
            .with_model(MAIN_MODEL)
            .with_config(|config| config.model_context_window = Some(CONTEXT_WINDOW)),
    )
    .await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 3_000,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
            final_response(),
        ],
    )
    .await;

    harness.submit("generate a diagnostic output").await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.body_json()["model"] == MAIN_MODEL),
        "the default path must not make an Ace pruning request"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn smart_prune_flag_never_runs_retrospective_pressure_pruning() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness =
        TestCodexHarness::with_builder(test_codex().with_model(MAIN_MODEL).with_config(|config| {
            config.model_context_window = Some(CONTEXT_WINDOW);
            let _ = config.features.enable(Feature::AutomaticContextPruning);
        }))
        .await?;
    let requests = mount_sse_sequence(
        harness.server(),
        vec![
            main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 3_000,
                // Deliberately below Smart Prune's admission threshold but still
                // reclaimable by the retired pressure path.
                "awk 'BEGIN { for (i=0; i<800; i++) printf \"x\" }'",
            ),
            final_response(),
        ],
    )
    .await;

    harness
        .submit("generate a modest diagnostic output")
        .await?;

    let requests = requests.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.body_json()["model"] == MAIN_MODEL)
    );
    assert!(requests[1].body_contains_text(&"x".repeat(128)));
    assert!(!requests[1].body_contains_text("[ELPIS CONTEXT UPDATE]"));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
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
#[serial(context_prune_counters)]
async fn manual_prune_does_not_duplicate_agents_md_instructions_across_resume() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    // Regression test for three compounding bugs in manual `/prune`:
    //   1. `ContextManager::replace` (called by every prune pass) unconditionally
    //      cleared the live world-state baseline without restoring it, so the very
    //      next turn saw AGENTS.md as "Unknown" and reinjected a replacement notice
    //      -- even with no resume involved.
    //   2. Unlike real compaction, a prune checkpoint never paired its `Compacted`
    //      rollout item with a `WorldState` snapshot, so resume's backward scan
    //      could resolve its history base at the newest prune checkpoint and stop
    //      before ever finding a world-state baseline.
    //   3. A prune pass's own maintenance turn has a `TurnComplete` but no matching
    //      `TurnStarted`, so during resume's backward scan its turn id got stuck on
    //      the active replay segment, causing every older real turn's `TurnContext`
    //      to be discarded as "incompatible" -- losing `reference_context_item`
    //      entirely and forcing a full, duplicate context reinjection.
    let home = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_INSTRUCTIONS)?;

    // Deliberately no `model_context_window` override: `final_response()` reports
    // 5,000 total tokens, which would cross the 30% auto-pressure boundary against
    // `CONTEXT_WINDOW` (10,000) after the very first round and trigger an unrelated
    // automatic compaction attempt (there is no mock for the compact endpoint, so it
    // would fail and consume a response meant for a later request in the sequence).
    // Only the manual `/prune` path under test should run here.
    let server = start_mock_server().await;
    // The Context Ledger governs AGENTS.md and is keyed per workspace, so this pins the
    // workspace across build and resume and admits the row the assertions are about.
    let workspace = Arc::new(TempDir::new()?);
    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_model(MAIN_MODEL)
        .with_config(pin_workspace_and_admit_global_rules(Arc::clone(&workspace)));
    let initial = builder.build(&server).await?;

    let call_ids = ["prune-target-1", "prune-target-2", "prune-target-3"];
    let mut sse_sequence = Vec::new();
    for (index, call_id) in call_ids.iter().enumerate() {
        sse_sequence.push(main_tool_response(
            call_id,
            /*total_tokens*/ 1_000,
            &format!("awk 'BEGIN {{ for (i=0; i<8000; i++) printf \"x{index}\" }}'"),
        ));
        sse_sequence.push(final_response());
        sse_sequence.push(sse(vec![
            ev_assistant_message(
                &format!("prune-result-{index}"),
                &format!("{call_id}: command output was generated and inspected"),
            ),
            ev_completed_with_tokens(&format!("prune-result-{index}"), /*total_tokens*/ 100),
        ]));
    }
    sse_sequence.push(final_response());
    let requests = mount_sse_sequence(&server, sse_sequence).await;

    let agents_md_fragments = |request: &responses::ResponsesRequest| -> Vec<String> {
        request
            .message_input_texts("user")
            .into_iter()
            .filter(|text| text.starts_with("# AGENTS.md instructions"))
            .collect()
    };

    for index in 0..call_ids.len() {
        initial
            .submit_turn(&format!("generate diagnostic output {index}"))
            .await?;
        let prune_id = initial.codex.submit(Op::Prune { target_pct: None }).await?;
        loop {
            let event = initial.codex.next_event().await?;
            if event.id == prune_id && matches!(event.msg, EventMsg::TurnComplete(_)) {
                break;
            }
        }
        // Each prune pass runs live, in the same process -- no resume yet. Bug #1
        // would already show a second (replacement-notice) fragment right here.
        // Skip the prune model's own isolated request (it never sees AGENTS.md).
        let requests_so_far = requests.requests();
        let latest = requests_so_far
            .iter()
            .rev()
            .find(|request| request.body_json()["model"] == MAIN_MODEL)
            .expect("at least one main-model request so far");
        assert_eq!(
            agents_md_fragments(latest).len(),
            1,
            "prune pass {index} duplicated the AGENTS.md fragment in the live session"
        );
    }
    initial.codex.flush_rollout().await?;

    let home = initial.home.clone();
    let rollout_path = initial
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    drop(initial);

    let mut builder =
        builder.with_config(pin_workspace_and_admit_global_rules(Arc::clone(&workspace)));
    let resumed = builder.resume(&server, home, rollout_path).await?;
    resumed.submit_turn("continue after resuming").await?;

    let requests = requests.requests();
    let last_request = requests.last().expect("at least one request");
    let fragments = agents_md_fragments(last_request);
    assert_eq!(
        fragments.len(),
        1,
        "expected exactly one AGENTS.md instruction fragment after 3 prune passes and a resume; got {fragments:?}"
    );
    assert!(
        !fragments[0].contains("replace all previously provided"),
        "unexpected duplicate-instructions replacement notice: {fragments:?}"
    );
    assert!(fragments[0].contains(GLOBAL_INSTRUCTIONS));

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn manual_prune_rewrites_completed_tool_output_without_compacting_messages() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    let harness = manual_harness().await?;
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
#[serial(context_prune_counters)]
async fn manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint()
-> Result<()> {
    skip_if_host_windows!(Ok(()));

    let (release_prune_tx, release_prune_rx) = oneshot::channel();
    let cancelled_prune = vec![
        StreamingSseChunk {
            gate: None,
            body: sse(vec![ev_assistant_message(
                "cancelled-prune-result",
                &format!("{OLD_CALL_ID}: command output was generated and inspected"),
            )]),
        },
        StreamingSseChunk {
            gate: Some(release_prune_rx),
            body: sse(vec![ev_completed_with_tokens(
                "cancelled-prune-result",
                /*total_tokens*/ 100,
            )]),
        },
    ];
    let (release_retry_tx, release_retry_rx) = oneshot::channel();
    let retry_prune = vec![
        StreamingSseChunk {
            gate: None,
            body: sse(vec![ev_assistant_message(
                "retry-prune-result",
                &format!("{OLD_CALL_ID}: command output was generated and inspected"),
            )]),
        },
        StreamingSseChunk {
            gate: Some(release_retry_rx),
            body: sse(vec![ev_completed_with_tokens(
                "retry-prune-result",
                /*total_tokens*/ 100,
            )]),
        },
    ];
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: main_tool_response(
                OLD_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<8000; i++) printf \"x\" }'",
            ),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: final_response(),
        }],
        cancelled_prune,
        retry_prune,
    ])
    .await;
    let mut builder = test_codex().with_model(MAIN_MODEL).with_config(|config| {
        config.model_context_window = Some(CONTEXT_WINDOW);
        // The generic interruption marker is unrelated to pruning. Disable it so
        // identical retry input proves that pruning itself left working history and
        // covered-call selection byte-for-byte unchanged.
        config.agent_interrupt_message_enabled = false;
    });
    let test = builder.build_with_streaming_server(&server).await?;
    let codex = Arc::clone(&test.codex);

    test.submit_turn("generate an old diagnostic output")
        .await?;
    codex.flush_rollout().await?;

    let logs_dir = test.home.path().join("logs");
    let pruning_dir = logs_dir.join("pruning");
    let passes_dir = pruning_dir.join("passes");
    let failed_dir = pruning_dir.join("failed_attempts");
    std::fs::create_dir_all(&passes_dir)?;
    std::fs::create_dir_all(&failed_dir)?;
    let attempts_path = pruning_dir.join("attempts.jsonl");
    let debug_path = logs_dir.join("prune_debug.log");
    let report_path = logs_dir.join("prune_report.md");
    let attempts_before: &[u8] = b"pre-existing attempt log\n";
    let debug_before: &[u8] = b"pre-existing debug log\n";
    let report_before: &[u8] = b"pre-existing latest report\n";
    std::fs::write(&attempts_path, attempts_before)?;
    std::fs::write(&debug_path, debug_before)?;
    std::fs::write(&report_path, report_before)?;

    let prune_state_before = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    let applied_passes_before = codex_core::context_pruner::pass_count();
    let saved_chars_before = codex_core::context_pruner::saved_chars();
    let checkpoints_before =
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items);

    codex.submit(Op::Prune { target_pct: None }).await?;
    server.wait_for_request_count(3).await;
    let requests = server.requests().await;
    let first_prune_body: serde_json::Value =
        serde_json::from_slice(&requests[2]).expect("parse first prune request");
    assert_eq!(first_prune_body["model"], PRUNE_MODEL);
    assert!(
        first_prune_body["input"]
            .to_string()
            .contains("<evidence_batch>")
    );
    assert!(first_prune_body["input"].to_string().contains(OLD_CALL_ID));
    let first_prune_input = first_prune_body["input"].clone();

    codex_core::test_support::interrupt_active_prune_and_wait_for_cancellation(&codex).await?;
    let _ = release_prune_tx.send(());
    let terminal = wait_for_event(&codex, |event| {
        matches!(event, EventMsg::TurnAborted(_) | EventMsg::TurnComplete(_))
    })
    .await;
    assert!(
        matches!(terminal, EventMsg::TurnAborted(_)),
        "manual prune completed instead of observing cancellation: {terminal:?}"
    );
    codex.flush_rollout().await?;

    assert_eq!(
        server.requests().await.len(),
        3,
        "cancellation must not issue a fallback pruning-model request"
    );
    let prune_state_after = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    assert_eq!(
        prune_state_after.raw_history, prune_state_before.raw_history,
        "cancelled pruning must not change live working history"
    );
    assert_eq!(
        prune_state_after.covered_call_ids, prune_state_before.covered_call_ids,
        "cancelled pruning must not mark call IDs as covered"
    );
    assert_eq!(
        prune_state_after.saved_tokens, prune_state_before.saved_tokens,
        "cancelled pruning must not change saved-token accounting"
    );
    assert_eq!(
        codex_core::context_pruner::pass_count(),
        applied_passes_before,
        "cancelled pruning must not change applied-pass accounting"
    );
    assert_eq!(
        codex_core::context_pruner::saved_chars(),
        saved_chars_before,
        "cancelled pruning must not change removed-character accounting"
    );
    assert_eq!(std::fs::read(&report_path)?, report_before);
    assert_eq!(std::fs::read(&attempts_path)?, attempts_before);
    assert_eq!(std::fs::read(&debug_path)?, debug_before);
    assert_eq!(
        std::fs::read_dir(&passes_dir)?.count(),
        0,
        "cancelled pruning must not record applied-pass accounting"
    );
    assert_eq!(
        std::fs::read_dir(&failed_dir)?.count(),
        0,
        "user cancellation must not be recorded as a failed pruning attempt"
    );

    let checkpoints_after =
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items);
    assert_eq!(
        checkpoints_after, checkpoints_before,
        "cancelled pruning must not persist a replacement checkpoint"
    );

    // Prompt equality is secondary evidence that the unchanged live state selects the
    // same batch again on the ordinary retry path.
    let retry_id = codex.submit(Op::Prune { target_pct: None }).await?;
    server.wait_for_request_count(4).await;
    let requests = server.requests().await;
    assert_eq!(requests.len(), 4);
    let retry_body: serde_json::Value =
        serde_json::from_slice(&requests[3]).expect("parse retry prune request");
    assert_eq!(retry_body["model"], PRUNE_MODEL);
    assert_eq!(retry_body["input"], first_prune_input);

    // Pause immediately after the commit decision so Ctrl-C deterministically reaches
    // the task before the durable sequence starts.
    let commit_gate = codex_core::test_support::pause_active_prune_commit(&codex).await;
    let _ = release_retry_tx.send(());
    codex_core::test_support::wait_for_active_prune_commit(&codex).await;
    codex_core::test_support::interrupt_active_prune_and_wait_for_commit_protection(&codex).await?;
    commit_gate.release();

    let committed_terminal = loop {
        let event = codex.next_event().await?;
        if event.id == retry_id
            && matches!(
                event.msg,
                EventMsg::TurnAborted(_) | EventMsg::TurnComplete(_)
            )
        {
            break event.msg;
        }
    };
    assert!(
        matches!(committed_terminal, EventMsg::TurnComplete(_)),
        "an interrupt after commit must let pruning finish: {committed_terminal:?}"
    );

    let committed_state = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    assert_ne!(committed_state.raw_history, prune_state_before.raw_history);
    assert!(committed_state.covered_call_ids.contains(OLD_CALL_ID));
    assert!(committed_state.saved_tokens > prune_state_before.saved_tokens);
    assert_eq!(
        codex_core::context_pruner::pass_count(),
        applied_passes_before + 1
    );
    assert!(codex_core::context_pruner::saved_chars() > saved_chars_before);
    assert_eq!(std::fs::read_dir(&passes_dir)?.count(), 1);
    assert_ne!(std::fs::read(&report_path)?, report_before);
    assert_eq!(
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items,)
            .len(),
        checkpoints_before.len() + 1
    );

    server.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn manual_prune_rearms_cancellation_before_a_later_batch_commits() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    const FIRST_CALL_ID: &str = "multi-batch-first";
    const SECOND_CALL_ID: &str = "multi-batch-second";
    const CALL_IDS: [&str; 2] = [FIRST_CALL_ID, SECOND_CALL_ID];

    let (release_second_pass_tx, release_second_pass_rx) = oneshot::channel();
    let second_pass = vec![
        StreamingSseChunk {
            gate: None,
            body: sse(vec![ev_assistant_message(
                "second-batch-prune-result",
                "NOTHING_TO_KEEP",
            )]),
        },
        StreamingSseChunk {
            gate: Some(release_second_pass_rx),
            body: sse(vec![ev_completed_with_tokens(
                "second-batch-prune-result",
                /*total_tokens*/ 100,
            )]),
        },
    ];
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: main_tool_response(
                FIRST_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<100000; i++) printf \"x \" }'",
            ),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: final_response(),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: main_tool_response(
                SECOND_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<100000; i++) printf \"y \" }'",
            ),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: final_response(),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: sse(vec![
                ev_assistant_message("first-batch-prune-result", "NOTHING_TO_KEEP"),
                ev_completed_with_tokens("first-batch-prune-result", /*total_tokens*/ 100),
            ]),
        }],
        second_pass,
    ])
    .await;
    let mut builder = test_codex().with_model(MAIN_MODEL).with_config(|config| {
        config.model_context_window = Some(CONTEXT_WINDOW);
        config.tool_output_token_limit = Some(30_000);
        config.agent_interrupt_message_enabled = false;
    });
    let test = builder.build_with_streaming_server(&server).await?;
    let codex = Arc::clone(&test.codex);

    let dump = |label: &str, items: &[codex_protocol::models::ResponseItem]| {
        eprintln!("[probe] {label}: {} items", items.len());
        for (index, item) in items.iter().enumerate() {
            let text: String = format!("{item:?}").chars().take(110).collect();
            eprintln!("[probe]   {index}: {text}");
        }
    };
    for prompt in [
        "generate the first oversized diagnostic output",
        "generate the second oversized diagnostic output",
    ] {
        test.submit_turn(prompt).await?;
        eprintln!(
            "[probe] turn done: {prompt}; requests so far={}",
            server.requests().await.len()
        );
        let state = codex_core::test_support::context_prune_state_snapshot(&codex).await;
        dump("history after turn", &state.raw_history);
        codex.flush_rollout().await?;
        let rollout = codex.load_history(/*include_archived*/ false).await?.items;
        eprintln!("[probe] rollout items after turn: {}", rollout.len());
        for (index, item) in rollout.iter().enumerate() {
            let text: String = format!("{item:?}").chars().take(170).collect();
            eprintln!("[probe]   r{index}: {text}");
        }
    }
    codex.flush_rollout().await?;

    let state_before = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    dump("history before prune", &state_before.raw_history);
    let applied_passes_before = codex_core::context_pruner::pass_count();
    let saved_chars_before = codex_core::context_pruner::saved_chars();
    let checkpoints_before =
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items);

    let prune_id = codex.submit(Op::Prune { target_pct: None }).await?;
    eprintln!("[probe] prune submitted id={prune_id}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let n = server.requests().await.len();
        eprintln!("[probe] requests={n}");
        if n >= 6 {
            break;
        }
        if std::time::Instant::now() > deadline {
            let state = codex_core::test_support::context_prune_state_snapshot(&codex).await;
            eprintln!(
                "[probe] stuck: covered={:?} saved_tokens={}",
                state.covered_call_ids, state.saved_tokens
            );
            dump("history after first pass", &state.raw_history);
            let prune_request: serde_json::Value =
                serde_json::from_slice(&server.requests().await[4]).expect("parse prune request");
            let prune_text: String = prune_request["input"].to_string().chars().take(400).collect();
            eprintln!("[probe] first prune request input (truncated): {prune_text}");
            while let Ok(Ok(event)) =
                tokio::time::timeout(std::time::Duration::from_millis(500), codex.next_event())
                    .await
            {
                let text: String = format!("{:?}", event.msg).chars().take(160).collect();
                eprintln!("[probe] queued event id={} {}", event.id, text);
            }
            panic!("[probe] request 6 never arrived; {n} requests seen");
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }

    let requests = server.requests().await;
    assert_eq!(requests.len(), 6, "the sweep must open its second batch");
    let first_prune_body: serde_json::Value =
        serde_json::from_slice(&requests[4]).expect("parse first batch request");
    let second_prune_body: serde_json::Value =
        serde_json::from_slice(&requests[5]).expect("parse second batch request");
    let first_prune_input = first_prune_body["input"].to_string();
    let second_prune_input = second_prune_body["input"].to_string();

    let state_after_first_commit =
        codex_core::test_support::context_prune_state_snapshot(&codex).await;
    let newly_covered = CALL_IDS
        .iter()
        .copied()
        .filter(|call_id| {
            state_after_first_commit.covered_call_ids.contains(*call_id)
                && !state_before.covered_call_ids.contains(*call_id)
        })
        .collect::<Vec<_>>();
    let still_uncovered = CALL_IDS
        .iter()
        .copied()
        .filter(|call_id| !state_after_first_commit.covered_call_ids.contains(*call_id))
        .collect::<Vec<_>>();
    assert!(
        !newly_covered.is_empty(),
        "the first pass must be non-vacuous"
    );
    assert!(
        !still_uncovered.is_empty(),
        "the gated request must be a real later batch"
    );
    assert_ne!(
        state_after_first_commit.raw_history,
        state_before.raw_history
    );
    assert!(state_after_first_commit.saved_tokens > state_before.saved_tokens);
    for call_id in &newly_covered {
        assert!(first_prune_input.contains(*call_id));
        assert!(!second_prune_input.contains(*call_id));
    }
    for call_id in &still_uncovered {
        assert!(second_prune_input.contains(*call_id));
    }

    eprintln!("[probe] interrupting active prune");
    codex_core::test_support::interrupt_active_prune_and_wait_for_cancellation(&codex).await?;
    eprintln!("[probe] cancellation observed; releasing second pass");
    let _ = release_second_pass_tx.send(());
    let terminal = loop {
        let event = codex.next_event().await?;
        let text: String = format!("{:?}", event.msg).chars().take(120).collect();
        eprintln!("[probe] event id={} {}", event.id, text);
        if event.id == prune_id
            && matches!(
                event.msg,
                EventMsg::TurnAborted(_) | EventMsg::TurnComplete(_)
            )
        {
            break event.msg;
        }
    };
    assert!(
        matches!(terminal, EventMsg::TurnAborted(_)),
        "an interrupt before the second commit must abort the sweep: {terminal:?}"
    );

    let state_after_cancel = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    assert_eq!(
        state_after_cancel.raw_history, state_after_first_commit.raw_history,
        "the cancelled second pass must not change live working history"
    );
    assert_eq!(
        state_after_cancel.covered_call_ids, state_after_first_commit.covered_call_ids,
        "the cancelled second pass must not cover another call ID"
    );
    assert_eq!(
        state_after_cancel.saved_tokens, state_after_first_commit.saved_tokens,
        "the cancelled second pass must not change saved-token accounting"
    );
    assert_eq!(
        codex_core::context_pruner::pass_count(),
        applied_passes_before + 1
    );
    assert!(codex_core::context_pruner::saved_chars() > saved_chars_before);
    assert_eq!(
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items,)
            .len(),
        checkpoints_before.len() + 1
    );
    assert_eq!(
        server.requests().await.len(),
        6,
        "cancelling pass two must not issue a fallback or third request"
    );

    server.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn manual_prune_interrupt_during_commit_stops_before_the_next_batch() -> Result<()> {
    skip_if_host_windows!(Ok(()));

    const FIRST_CALL_ID: &str = "stop-after-commit-first";
    const SECOND_CALL_ID: &str = "stop-after-commit-second";

    let (release_first_pass_tx, release_first_pass_rx) = oneshot::channel();
    let first_pass = vec![
        StreamingSseChunk {
            gate: None,
            body: sse(vec![ev_assistant_message(
                "stop-after-commit-result",
                "NOTHING_TO_KEEP",
            )]),
        },
        StreamingSseChunk {
            gate: Some(release_first_pass_rx),
            body: sse(vec![ev_completed_with_tokens(
                "stop-after-commit-result",
                /*total_tokens*/ 100,
            )]),
        },
    ];
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: main_tool_response(
                FIRST_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<100000; i++) printf \"a \" }'",
            ),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: final_response(),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: main_tool_response(
                SECOND_CALL_ID,
                /*total_tokens*/ 1_000,
                "awk 'BEGIN { for (i=0; i<100000; i++) printf \"b \" }'",
            ),
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: final_response(),
        }],
        first_pass,
        vec![StreamingSseChunk {
            gate: None,
            body: sse(vec![
                ev_assistant_message("unexpected-next-batch", "NOTHING_TO_KEEP"),
                ev_completed_with_tokens("unexpected-next-batch", /*total_tokens*/ 100),
            ]),
        }],
    ])
    .await;
    let mut builder = test_codex().with_model(MAIN_MODEL).with_config(|config| {
        config.model_context_window = Some(CONTEXT_WINDOW);
        config.tool_output_token_limit = Some(30_000);
        config.agent_interrupt_message_enabled = false;
    });
    let test = builder.build_with_streaming_server(&server).await?;
    let codex = Arc::clone(&test.codex);

    test.submit_turn("generate the first commit-boundary output")
        .await?;
    test.submit_turn("generate the second commit-boundary output")
        .await?;
    codex.flush_rollout().await?;

    let state_before = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    let applied_passes_before = codex_core::context_pruner::pass_count();
    let saved_chars_before = codex_core::context_pruner::saved_chars();
    let checkpoints_before =
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items);

    let prune_id = codex.submit(Op::Prune { target_pct: None }).await?;
    server.wait_for_request_count(5).await;
    let requests = server.requests().await;
    let first_prune_body: serde_json::Value =
        serde_json::from_slice(&requests[4]).expect("parse committed batch request");
    let first_prune_input = first_prune_body["input"].to_string();
    assert!(first_prune_input.contains(FIRST_CALL_ID));
    assert!(
        !first_prune_input.contains(SECOND_CALL_ID),
        "the unrequested second oversized output proves another batch remains"
    );

    let commit_gate = codex_core::test_support::pause_active_prune_commit(&codex).await;
    let _ = release_first_pass_tx.send(());
    codex_core::test_support::wait_for_active_prune_commit(&codex).await;
    codex_core::test_support::interrupt_active_prune_and_wait_for_commit_protection(&codex).await?;
    commit_gate.release();

    let terminal = loop {
        let event = codex.next_event().await?;
        if event.id == prune_id
            && matches!(
                event.msg,
                EventMsg::TurnAborted(_) | EventMsg::TurnComplete(_)
            )
        {
            break event.msg;
        }
    };
    assert!(
        matches!(terminal, EventMsg::TurnComplete(_)),
        "an interrupt during commit must finish that pass normally: {terminal:?}"
    );

    let state_after = codex_core::test_support::context_prune_state_snapshot(&codex).await;
    assert_ne!(state_after.raw_history, state_before.raw_history);
    assert!(state_after.covered_call_ids.contains(FIRST_CALL_ID));
    assert!(!state_after.covered_call_ids.contains(SECOND_CALL_ID));
    assert!(state_after.saved_tokens > state_before.saved_tokens);
    assert_eq!(
        codex_core::context_pruner::pass_count(),
        applied_passes_before + 1
    );
    assert!(codex_core::context_pruner::saved_chars() > saved_chars_before);
    assert_eq!(
        context_prune_checkpoints(codex.load_history(/*include_archived*/ false).await?.items,)
            .len(),
        checkpoints_before.len() + 1
    );
    assert_eq!(
        server.requests().await.len(),
        5,
        "the committed interrupt must stop the sweep before its next request"
    );

    server.shutdown().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial(context_prune_counters)]
async fn manual_prune_without_completed_tool_output_makes_no_model_request() -> Result<()> {
    let harness = manual_harness().await?;
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

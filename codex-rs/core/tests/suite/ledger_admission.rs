//! Payload-level proof that the Context Ledger is the only authority over which
//! instruction files reach the model.
//!
//! Every assertion here reads the actual request body sent to the provider rather than an
//! internal flag: "off" has to mean the bytes are absent, and "on" has to mean exactly one
//! effective copy no matter how many turns, rewrites, or resumes happened first.
use anyhow::Result;
use codex_core::config::Config;
use codex_core::elpis_context::set_continuity_source_admitted;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::Op;
use codex_utils_absolute_path::AbsolutePathBuf;
use core_test_support::responses;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use tempfile::TempDir;

const GLOBAL_INSTRUCTIONS: &str = "global ledger admission instructions";
const GLOBAL_RULES_ROW: &str = "Global AGENTS.md";

fn turn_responses(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| {
            let id = format!("ledger-response-{index}");
            sse(vec![ev_response_created(&id), ev_completed(&id)])
        })
        .collect()
}

fn instruction_fragments(request: &responses::ResponsesRequest) -> Vec<String> {
    request
        .message_input_texts("user")
        .into_iter()
        .filter(|text| text.starts_with("# AGENTS.md instructions"))
        .collect()
}

/// A file on disk is not consent: a fresh session must send nothing until the ledger
/// admits it. This is the property the RQ1/RQ4 benchmark runs depend on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ledger_off_by_default_keeps_instruction_files_out_of_the_request() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(2)).await;
    let home = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_INSTRUCTIONS)?;

    let mut builder = test_codex().with_home(Arc::clone(&home));
    let test = builder.build(&server).await?;
    test.submit_turn("first turn").await?;
    test.submit_turn("second turn").await?;

    for (index, request) in requests.requests().iter().enumerate() {
        assert_eq!(
            instruction_fragments(request),
            Vec::<String>::new(),
            "request {index} carried an unadmitted instruction fragment"
        );
        assert!(
            !request.body_contains_text(GLOBAL_INSTRUCTIONS),
            "request {index} leaked unadmitted instruction file contents"
        );
    }

    // The row still has to be visible so it can be switched on.
    assert!(
        !test.codex.instruction_sources().await.is_empty(),
        "an unadmitted file must stay listed for the ledger UI"
    );
    Ok(())
}

/// On means one logical source, assembled per request -- never a copy appended per turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_instructions_appear_exactly_once_across_turns() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(3)).await;
    let home = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_INSTRUCTIONS)?;

    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_config(|config| {
            set_continuity_source_admitted(
                Some(config.memory_dir.as_path()),
                config.cwd.as_path(),
                GLOBAL_RULES_ROW,
                true,
            )
            .expect("admit global rules in the ledger");
        });
    let test = builder.build(&server).await?;
    test.submit_turn("first turn").await?;
    test.submit_turn("second turn").await?;
    test.submit_turn("third turn").await?;

    for (index, request) in requests.requests().iter().enumerate() {
        let fragments = instruction_fragments(request);
        assert_eq!(
            fragments.len(),
            1,
            "request {index} should carry exactly one instruction copy; got {fragments:?}"
        );
        assert!(fragments[0].contains(GLOBAL_INSTRUCTIONS));
        assert!(
            !request.body_contains_text("replace all previously provided"),
            "request {index} carried an instruction replacement notice"
        );
    }
    Ok(())
}

/// Off means absent from the next request, including the copy an earlier turn appended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withdrawing_admission_mid_session_clears_the_next_request() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(3)).await;
    let home = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_INSTRUCTIONS)?;

    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_config(|config| {
            set_continuity_source_admitted(
                Some(config.memory_dir.as_path()),
                config.cwd.as_path(),
                GLOBAL_RULES_ROW,
                true,
            )
            .expect("admit global rules in the ledger");
        });
    let test = builder.build(&server).await?;
    test.submit_turn("admitted turn").await?;

    set_continuity_source_admitted(
        Some(test.config.memory_dir.as_path()),
        test.config.cwd.as_path(),
        GLOBAL_RULES_ROW,
        false,
    )?;
    test.submit_turn("withdrawn turn").await?;

    // ...and switching it back on restores exactly one copy, with nothing accumulated.
    set_continuity_source_admitted(
        Some(test.config.memory_dir.as_path()),
        test.config.cwd.as_path(),
        GLOBAL_RULES_ROW,
        true,
    )?;
    test.submit_turn("readmitted turn").await?;

    let requests = requests.requests();
    assert_eq!(instruction_fragments(&requests[0]).len(), 1);
    assert_eq!(
        instruction_fragments(&requests[1]),
        Vec::<String>::new(),
        "withdrawing admission must clear the earlier copy too"
    );
    assert!(
        !requests[1].body_contains_text(GLOBAL_INSTRUCTIONS),
        "withdrawn instruction contents must be gone from the request body"
    );
    assert_eq!(instruction_fragments(&requests[2]).len(), 1);
    Ok(())
}

/// Pins the thread to one workspace so build and resume address the same ledger, and
/// optionally sets the global-rules row before the thread starts.
fn pin_workspace(
    workspace: Arc<TempDir>,
    admit: Option<bool>,
) -> impl FnOnce(&mut Config) + Send + 'static {
    move |config| {
        config.cwd = AbsolutePathBuf::try_from(workspace.path().to_path_buf())
            .expect("absolute workspace path");
        if let Some(admitted) = admit {
            set_continuity_source_admitted(
                Some(config.memory_dir.as_path()),
                config.cwd.as_path(),
                GLOBAL_RULES_ROW,
                admitted,
            )
            .expect("write ledger admission");
        }
    }
}

/// Resume reads the admission state back off disk; it neither re-admits nor re-appends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admission_state_survives_resume() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(3)).await;
    let home = Arc::new(TempDir::new()?);
    let workspace = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_INSTRUCTIONS)?;

    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_config(pin_workspace(Arc::clone(&workspace), Some(true)));
    let initial = builder.build(&server).await?;
    initial.submit_turn("before resume").await?;
    initial.codex.flush_rollout().await?;
    let rollout_path = initial
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    let memory_dir = initial.config.memory_dir.clone();
    let cwd = initial.config.cwd.clone();
    initial.codex.submit(Op::Shutdown).await?;
    core_test_support::wait_for_event(&initial.codex, |event| {
        matches!(event, EventMsg::ShutdownComplete)
    })
    .await;
    drop(initial);

    // Resume writes no admission of its own: whatever the previous session stored has to
    // be what the resumed session honours.
    builder = builder.with_config(pin_workspace(Arc::clone(&workspace), None));
    let resumed = builder
        .resume(&server, Arc::clone(&home), rollout_path.clone())
        .await?;
    assert_eq!(resumed.config.cwd, cwd, "resume must reuse the workspace");
    resumed.submit_turn("after resume while admitted").await?;

    set_continuity_source_admitted(
        Some(memory_dir.as_path()),
        cwd.as_path(),
        GLOBAL_RULES_ROW,
        false,
    )?;
    resumed.submit_turn("after resume while withdrawn").await?;

    let requests = requests.requests();
    assert_eq!(
        instruction_fragments(&requests[1]).len(),
        1,
        "resume must restore one copy, not append another"
    );
    assert_eq!(
        instruction_fragments(&requests[2]),
        Vec::<String>::new(),
        "a withdrawn row must stay withdrawn after resume"
    );
    Ok(())
}

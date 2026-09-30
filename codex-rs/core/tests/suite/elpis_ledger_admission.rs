//! Elpis: the model's request carries exactly what the Context Ledger admits.
//!
//! Each source holds a unique sentinel. Every assertion counts that sentinel in the request
//! body sent to the mock provider: an included source appears exactly once, an excluded one
//! not at all, including the copy an earlier turn appended. Ported from v0.3.0's
//! `ledger_admission.rs` and extended to the continuity sources.

use anyhow::Result;
use codex_core::config::Config;
use codex_core::elpis_admission::install_elpis_continuity;
use codex_core::elpis_admission::memory_dir;
use codex_core::elpis_context::add_continuity_source;
use codex_core::elpis_context::set_continuity_source_admitted;
use codex_core::elpis_context::workspace_context_dir;
use codex_extension_api::ExtensionRegistry;
use codex_extension_api::ExtensionRegistryBuilder;
use core_test_support::responses::ResponsesRequest;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::test_codex::test_codex;
use pretty_assertions::assert_eq;
use std::path::Path;
use std::sync::Arc;
use tempfile::TempDir;

const GLOBAL_AGENTS: &str = "ELPIS_LEDGER_GLOBAL_AGENTS_7d41c2";
const PROJECT_AGENTS: &str = "ELPIS_LEDGER_PROJECT_AGENTS_2b9305";
const MEMORY: &str = "ELPIS_LEDGER_MEMORY_5e08b1";
const DEV_RULE: &str = "ELPIS_LEDGER_DEV_RULE_c61f4a";
const ADDED_FILE: &str = "ELPIS_LEDGER_ADDED_FILE_09aa7e";

const GLOBAL_RULES_ROW: &str = "Global AGENTS.md";
const PROJECT_RULES_ROW: &str = "Project AGENTS.md";
const MEMORY_ROW: &str = "MEMORY.md";
const DEV_RULE_ROW: &str = "dev/RULE.md";

fn turn_responses(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| {
            let id = format!("ledger-response-{index}");
            sse(vec![ev_response_created(&id), ev_completed(&id)])
        })
        .collect()
}

fn occurrences(request: &ResponsesRequest, sentinel: &str) -> usize {
    request.body_json().to_string().matches(sentinel).count()
}

/// Sets one Ledger row for the session's workspace, as the TUI does.
fn set_row(config: &Config, row: &str, admitted: bool) -> Result<()> {
    set_continuity_source_admitted(
        Some(memory_dir(config).as_path()),
        config.cwd.as_path(),
        row,
        admitted,
    )?;
    Ok(())
}

fn continuity_extensions() -> Arc<ExtensionRegistry<Config>> {
    let mut builder = ExtensionRegistryBuilder::<Config>::new();
    install_elpis_continuity(&mut builder);
    Arc::new(builder.build())
}

/// Plants MEMORY.md and a development rule under `[skills] dev_rule_roots` in `home`.
fn plant_continuity_sources(home: &Path) -> Result<()> {
    let dev_rules = home.join("rule-root");
    std::fs::create_dir_all(&dev_rules)?;
    std::fs::write(dev_rules.join("RULE.md"), DEV_RULE)?;
    std::fs::write(
        home.join("config.toml"),
        format!(
            "[skills]\ndev_rule_roots = [{}]\n",
            serde_json::to_string(&dev_rules.to_string_lossy())?
        ),
    )?;
    std::fs::create_dir_all(home.join("memories"))?;
    std::fs::write(
        home.join("memories/MEMORY.md"),
        format!("# Elpis Memory\n\n- {MEMORY}\n"),
    )?;
    Ok(())
}

/// A file on disk is not admission; admitting it sends one copy; withdrawing it removes
/// the copy an earlier turn appended; re-admitting restores exactly one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agents_md_reaches_the_request_only_while_the_ledger_admits_it() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(/*count*/ 4)).await;
    let home = Arc::new(TempDir::new()?);
    std::fs::write(home.path().join("AGENTS.md"), GLOBAL_AGENTS)?;
    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_workspace_setup(|cwd, _fs| async move {
            std::fs::write(cwd.as_path().join("AGENTS.md"), PROJECT_AGENTS)?;
            Ok(())
        });
    let test = builder.build(&server).await?;

    test.submit_turn("default turn").await?;
    set_row(&test.config, GLOBAL_RULES_ROW, /*admitted*/ true)?;
    set_row(&test.config, PROJECT_RULES_ROW, /*admitted*/ true)?;
    test.submit_turn("admitted turn").await?;
    set_row(&test.config, GLOBAL_RULES_ROW, /*admitted*/ false)?;
    set_row(&test.config, PROJECT_RULES_ROW, /*admitted*/ false)?;
    test.submit_turn("withdrawn turn").await?;
    set_row(&test.config, GLOBAL_RULES_ROW, /*admitted*/ true)?;
    set_row(&test.config, PROJECT_RULES_ROW, /*admitted*/ true)?;
    test.submit_turn("readmitted turn").await?;

    let requests = requests.requests();
    let counts = requests
        .iter()
        .map(|request| {
            (
                occurrences(request, GLOBAL_AGENTS),
                occurrences(request, PROJECT_AGENTS),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        counts,
        vec![(0, 0), (1, 1), (0, 0), (1, 1)],
        "(global, project) AGENTS.md copies per request: default, admitted, withdrawn, readmitted"
    );
    for (index, request) in requests.iter().enumerate() {
        assert!(
            !request.body_contains_text("no longer apply")
                && !request.body_contains_text("replace all previously provided"),
            "request {index} carried an AGENTS.md lifecycle notice"
        );
    }
    assert_eq!(
        test.codex.instruction_sources().await.len(),
        2,
        "the Ledger must keep listing both files so a withdrawn row can be re-admitted"
    );
    Ok(())
}

/// MEMORY.md, a configured development rule and a file added with `/add` each reach the
/// request exactly while the Ledger includes them. A malformed record includes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continuity_sources_reach_the_request_only_while_the_ledger_admits_them() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(/*count*/ 4)).await;
    let home = Arc::new(TempDir::new()?);
    plant_continuity_sources(home.path())?;
    let mut builder = test_codex()
        .with_home(Arc::clone(&home))
        .with_extensions(continuity_extensions());
    let test = builder.build(&server).await?;
    let memories_root = memory_dir(&test.config);
    let cwd = test.config.cwd.as_path();
    let notes = cwd.join("NOTES.md");
    std::fs::write(&notes, ADDED_FILE)?;

    // Development rules start included; MEMORY.md and unadded files do not.
    test.submit_turn("default turn").await?;

    set_row(&test.config, MEMORY_ROW, /*admitted*/ true)?;
    set_row(&test.config, DEV_RULE_ROW, /*admitted*/ false)?;
    let added = add_continuity_source(Some(memories_root.as_path()), cwd, &notes)?;
    test.submit_turn("admitted turn").await?;

    set_row(&test.config, MEMORY_ROW, /*admitted*/ false)?;
    set_row(&test.config, DEV_RULE_ROW, /*admitted*/ true)?;
    set_row(&test.config, &added.to_string_lossy(), /*admitted*/ false)?;
    test.submit_turn("withdrawn turn").await?;

    let admission = workspace_context_dir(Some(memories_root.as_path()), cwd)
        .expect("workspace context dir")
        .join("admission.toml");
    std::fs::write(&admission, "memory = [\n")?;
    test.submit_turn("malformed turn").await?;

    let requests = requests.requests();
    let counts = requests
        .iter()
        .map(|request| {
            [MEMORY, DEV_RULE, ADDED_FILE].map(|sentinel| occurrences(request, sentinel))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        counts,
        vec![[0, 1, 0], [1, 0, 1], [0, 1, 0], [0, 0, 0]],
        "[MEMORY, dev rule, added file] copies per request: default, admitted, withdrawn, malformed"
    );
    let last = requests.last().expect("malformed turn request");
    assert!(
        last.body_contains_text("default turn"),
        "replacing the slot must not drop neighbouring history"
    );
    Ok(())
}

/// Negative control: without the continuity extension, an admitted MEMORY.md and an added
/// file never reach the request. The sentinels have no other way in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_the_continuity_extension_admitted_sources_never_arrive() -> Result<()> {
    let server = start_mock_server().await;
    let requests = mount_sse_sequence(&server, turn_responses(/*count*/ 1)).await;
    let home = Arc::new(TempDir::new()?);
    plant_continuity_sources(home.path())?;
    let mut builder = test_codex().with_home(Arc::clone(&home));
    let test = builder.build(&server).await?;
    let cwd = test.config.cwd.as_path();
    let notes = cwd.join("NOTES.md");
    std::fs::write(&notes, ADDED_FILE)?;
    set_row(&test.config, MEMORY_ROW, /*admitted*/ true)?;
    add_continuity_source(Some(memory_dir(&test.config).as_path()), cwd, &notes)?;

    test.submit_turn("admitted turn").await?;

    let request = requests.single_request();
    assert_eq!(
        [MEMORY, DEV_RULE, ADDED_FILE].map(|sentinel| occurrences(&request, sentinel)),
        [0, 0, 0]
    );
    Ok(())
}

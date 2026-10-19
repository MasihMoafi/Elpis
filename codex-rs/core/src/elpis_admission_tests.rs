use super::*;
use crate::elpis_context::ELPIS_CONTINUITY_PROMPT_PREFIX;
use crate::elpis_context::set_continuity_source_admitted;
use crate::elpis_context::workspace_context_dir;
use codex_extension_api::Instructions;
use codex_protocol::protocol::InternalSessionSource;
use codex_protocol::protocol::SubAgentSource;
use pretty_assertions::assert_eq;
use std::path::PathBuf;
use tempfile::TempDir;

const GLOBAL_RULES_ROW: &str = "Global AGENTS.md";

struct Workspace {
    _root: TempDir,
    memories_root: PathBuf,
    cwd: PathBuf,
    global: AbsolutePathBuf,
}

fn workspace() -> Workspace {
    let root = TempDir::new().expect("temp dir");
    let home = root.path().join("home");
    let cwd = root.path().join("project");
    std::fs::create_dir_all(&home).expect("home dir");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let global = home.join("AGENTS.md");
    std::fs::write(&global, "global rule").expect("global rule");
    Workspace {
        memories_root: home.join("memories"),
        cwd,
        global: AbsolutePathBuf::from_absolute_path(&global).expect("absolute global path"),
        _root: root,
    }
}

/// The global file as a Ledger row, beside guidance that has no file and so no row.
fn admitted_text(workspace: &Workspace) -> Option<String> {
    let loaded = LoadedAgentsMd::from_text_for_testing("internal guidance")
        .with_instructions(
            Some(Instructions {
                text: "global rule".to_string(),
                source: Some(workspace.global.clone()),
            }),
            /*thread_instructions*/ None,
        )
        .expect("loaded instructions");
    let admitted =
        admitted_agents_md_for(&workspace.memories_root, &workspace.cwd, Arc::new(loaded))?;
    Some(admitted.text())
}

#[test]
fn instruction_files_follow_the_ledger_and_fail_closed() {
    let workspace = workspace();
    assert_eq!(
        admitted_text(&workspace),
        Some("internal guidance".to_string()),
        "a file on disk is not admission: the global row starts excluded"
    );

    set_continuity_source_admitted(
        Some(workspace.memories_root.as_path()),
        &workspace.cwd,
        GLOBAL_RULES_ROW,
        /*admitted*/ true,
    )
    .expect("admit the global row");
    assert_eq!(
        admitted_text(&workspace),
        Some("global rule\n\ninternal guidance".to_string())
    );

    set_continuity_source_admitted(
        Some(workspace.memories_root.as_path()),
        &workspace.cwd,
        GLOBAL_RULES_ROW,
        /*admitted*/ false,
    )
    .expect("exclude the global row");
    assert_eq!(
        admitted_text(&workspace),
        Some("internal guidance".to_string())
    );

    let admission = workspace_context_dir(Some(workspace.memories_root.as_path()), &workspace.cwd)
        .expect("workspace context dir")
        .join("admission.toml");
    std::fs::write(&admission, "global_rules = [\n").expect("malformed admission");
    assert_eq!(
        admitted_text(&workspace),
        None,
        "a malformed admission record admits nothing"
    );
}

#[test]
fn continuity_section_owns_one_slot_and_resends_only_changes() {
    let empty = continuity_section(/*body*/ None);
    assert!(empty.owns_single_history_slot());
    assert!(!empty.has_model_visible_content());
    assert!(
        empty
            .render_diff(PreviousWorldStateSection::Absent)
            .1
            .is_none()
    );

    let body = format!("{ELPIS_CONTINUITY_PROMPT_PREFIX}### Source: /tmp/MEMORY.md\n\nfact");
    let filled = continuity_section(Some(body.clone()));
    assert!(filled.owns_single_history_slot());
    assert!(filled.has_model_visible_content());
    let (snapshot, fragment) = filled.render_diff(PreviousWorldStateSection::Absent);
    assert_eq!(
        fragment.map(|fragment| (fragment.role(), fragment.body().to_string())),
        Some(("developer", body.clone()))
    );
    let snapshot = snapshot.expect("a filled section persists its body");
    assert!(
        filled
            .render_diff(PreviousWorldStateSection::Known(&snapshot))
            .1
            .is_none(),
        "an unchanged body is not sent again"
    );
    assert!(filled.matches_retained_fragment("developer", &body));
}

#[test]
fn continuity_matcher_requires_the_complete_generator_prefix() {
    let generated = format!("{ELPIS_CONTINUITY_PROMPT_PREFIX}[MEMORY.md]\n\naccepted memory");
    assert!(is_elpis_continuity_fragment("developer", &generated));
    assert!(!is_elpis_continuity_fragment(
        "developer",
        "## Elpis Admitted Context\n\nneighboring developer content"
    ));
    assert!(!is_elpis_continuity_fragment("user", &generated));
}

#[test]
fn guardian_reviewers_are_ineligible_for_continuity() {
    assert!(elpis_continuity_is_eligible(&SessionSource::Cli));
    assert!(!elpis_continuity_is_eligible(&SessionSource::SubAgent(
        SubAgentSource::Other("guardian".to_string())
    )));
    assert!(!elpis_continuity_is_eligible(&SessionSource::Internal(
        InternalSessionSource::Guardian
    )));
}

#[tokio::test]
async fn native_and_bridge_admission_follow_the_same_thread_and_explicit_handoffs()
-> anyhow::Result<()> {
    let workspace = workspace();
    let first = codex_protocol::ThreadId::new();
    let second = codex_protocol::ThreadId::new();
    let legacy_directory =
        workspace_context_dir(Some(&workspace.memories_root), &workspace.cwd).unwrap();
    std::fs::create_dir_all(&legacy_directory)?;
    let legacy = format!("- Thread: `{first}`\nFIRST_LEGACY_CHECKPOINT");
    std::fs::write(legacy_directory.join("ES.md"), &legacy)?;
    for name in ["GOAL.md", "ES.md"] {
        set_continuity_source_admitted(Some(&workspace.memories_root), &workspace.cwd, name, true)?;
    }
    let second_directory = elpis_context::thread_context_dir(
        Some(&workspace.memories_root),
        &workspace.cwd,
        &second.to_string(),
    )?
    .unwrap();
    std::fs::create_dir_all(&second_directory)?;
    std::fs::write(
        second_directory.join("ES.md"),
        format!("- Thread: `{second}`\nSECOND_CHECKPOINT"),
    )?;
    std::fs::write(
        second_directory.join("GOAL.md"),
        format!("- Thread: `{second}`\nSECOND_GOAL"),
    )?;
    let session_store = ExtensionData::new("session");
    let turn_store = ExtensionData::new("turn");
    let step_store = ExtensionData::new("step");
    let model_info = codex_models_manager::model_info::model_info_from_slug("test-model");
    for (thread, expected, excluded) in [
        (first, "FIRST_LEGACY_CHECKPOINT", "SECOND_CHECKPOINT"),
        (second, "SECOND_CHECKPOINT", "FIRST_LEGACY_CHECKPOINT"),
    ] {
        // Recreate the store as on exact resume: lookup still selects the same portable state.
        for _ in 0..2 {
            let thread_store = ExtensionData::new(thread.to_string());
            thread_store.insert(ElpisContinuityConfig {
                memories_root: AbsolutePathBuf::try_from(workspace.memories_root.clone())?,
                cwd: AbsolutePathBuf::try_from(workspace.cwd.clone())?,
                dev_rule_roots: Vec::new(),
                eligible: true,
            });
            let bridge = thread_continuity(&thread_store)
                .await
                .expect("admitted checkpoint");
            assert!(bridge.contains(expected));
            assert!(!bridge.contains(excluded));
            let native = ElpisContinuityExtension
                .contribute_world_state(WorldStateContributionInput {
                    thread_id: thread,
                    turn_id: "turn",
                    model_info: &model_info,
                    environments: &[],
                    ready_selected_capability_roots: &[],
                    executor_capability_discovery: None,
                    extension_metrics: None,
                    session_store: &session_store,
                    thread_store: &thread_store,
                    turn_store: &turn_store,
                    step_store: &step_store,
                    previous_world_state: None,
                })
                .await;
            let (_, fragment) = native[0].render_diff(PreviousWorldStateSection::Absent);
            assert_eq!(fragment.expect("native fragment").body(), bridge);
        }
    }
    assert_eq!(
        std::fs::read_to_string(legacy_directory.join("ES.md"))?,
        legacy
    );
    let third = codex_protocol::ThreadId::new().to_string();
    let no_implicit_handoff = elpis_context::build_continuity_prompt_with_dev_rule_roots(
        Some(&workspace.memories_root),
        &workspace.cwd,
        &[],
        Some(&third),
    )
    .await
    .unwrap_or_default();
    assert!(!no_implicit_handoff.contains("FIRST_LEGACY_CHECKPOINT"));
    elpis_context::add_continuity_sources(
        Some(&workspace.memories_root),
        &workspace.cwd,
        &legacy_directory.join("ES.md"),
    )?;
    let explicit = elpis_context::build_continuity_prompt_with_dev_rule_roots(
        Some(&workspace.memories_root),
        &workspace.cwd,
        &[],
        Some(&third),
    )
    .await
    .expect("explicitly admitted handoff");
    assert!(explicit.contains("FIRST_LEGACY_CHECKPOINT"));
    Ok(())
}

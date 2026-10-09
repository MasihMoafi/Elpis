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

use super::*;
use pretty_assertions::assert_eq;

fn request(cwd: &std::path::Path, edits: serde_json::Value, check_only: bool) -> MemorySaveRequest {
    serde_json::from_value(json!({
        "cwd": cwd,
        "threadId": "thread",
        "turnId": "turn",
        "memoryEdits": edits,
        "checkpoint": null,
        "checkOnly": check_only,
    }))
    .expect("request")
}

/// A Claude chat saves to the same MEMORY.md as the engine's tool, only where the workspace
/// opted in, and an ambiguous edit is refused without writing.
#[test]
fn memory_save_follows_the_workspace_opt_in_and_the_tools_edit_rules() {
    let home = tempfile::tempdir().expect("home");
    let cwd = home.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let root = home.path().join("memories");
    let append = json!([{ "old_text": null, "new_text": "- Prefers Celsius.\n" }]);

    assert_eq!(
        answer(home.path(), request(&cwd, append.clone(), false)),
        json!({ "enabled": false })
    );

    let workspace =
        codex_core::elpis_context::workspace_context_dir(Some(&root), &cwd).expect("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace dir");
    std::fs::write(
        workspace.join("memory-autosave.json"),
        r#"{"enabled":true}"#,
    )
    .expect("opt in");

    let check = answer(home.path(), request(&cwd, json!([]), true));
    assert_eq!(check["enabled"], json!(true));
    assert_eq!(check["description"], json!(SAVE_MEMORY_DESCRIPTION));
    assert_eq!(
        answer(home.path(), request(&cwd, append, false)),
        json!({ "enabled": true, "memoryChanged": true, "checkpointChanged": false })
    );
    let saved = std::fs::read_to_string(root.join("MEMORY.md")).expect("memory");
    assert!(saved.contains("Prefers Celsius"), "{saved}");

    let ambiguous = json!([{ "old_text": "e", "new_text": null }]);
    let refused = answer(home.path(), request(&cwd, ambiguous, false));
    assert!(
        refused["error"]
            .as_str()
            .is_some_and(|e| e.contains("exactly once")),
        "{refused}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("MEMORY.md")).expect("memory"),
        saved
    );
}

//! Elpis: `elpis memory-save`, the engine's guarded `save_memory` for a chat whose turns run on
//! another engine (the Claude bridge offers it to Claude and Antigravity chats). It reads one
//! JSON request on stdin and prints one JSON answer. Saving is the same as the tool's: opt-in
//! per workspace (`memory-autosave.json`), locked, and rejected when an edit is ambiguous.

use std::io::Read;
use std::path::PathBuf;

use codex_core::memory_save::CHECKPOINT_DESCRIPTION;
use codex_core::memory_save::MEMORY_EDITS_DESCRIPTION;
use codex_core::memory_save::MemoryEdit;
use codex_core::memory_save::MemorySaveTiming;
use codex_core::memory_save::MemorySnapshot;
use codex_core::memory_save::MemoryUpdate;
use codex_core::memory_save::SAVE_MEMORY_DESCRIPTION;
use codex_core::memory_save::apply_memory_edits;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemorySaveRequest {
    /// The chat's working directory; its workspace holds ES.md and the opt-in.
    cwd: PathBuf,
    thread_id: String,
    turn_id: String,
    #[serde(default)]
    memory_edits: Vec<MemoryEdit>,
    #[serde(default)]
    checkpoint: Option<String>,
    /// Only say whether saving is on for this workspace.
    #[serde(default)]
    check_only: bool,
}

pub(crate) fn run(codex_home: PathBuf) -> anyhow::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: MemorySaveRequest = serde_json::from_str(&input)?;
    println!("{}", answer(&codex_home, request));
    Ok(())
}

fn answer(codex_home: &std::path::Path, request: MemorySaveRequest) -> serde_json::Value {
    let snapshot = match MemorySnapshot::open(&codex_home.join("memories"), &request.cwd) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return json!({ "enabled": false }),
        Err(error) => return json!({ "enabled": true, "error": format!("{error:#}") }),
    };
    if request.check_only {
        return json!({
            "enabled": true,
            "description": SAVE_MEMORY_DESCRIPTION,
            "memoryEditsDescription": MEMORY_EDITS_DESCRIPTION,
            "checkpointDescription": CHECKPOINT_DESCRIPTION,
        });
    }
    let memory = match apply_memory_edits(&snapshot.memory, &request.memory_edits) {
        Ok(memory) => memory,
        Err(error) => return json!({ "enabled": true, "error": error }),
    };
    let memory_changed = memory.is_some();
    let checkpoint_changed = request.checkpoint.is_some();
    if memory_changed || checkpoint_changed {
        let update = MemoryUpdate {
            memory,
            checkpoint: request.checkpoint,
        };
        if let Err(error) = snapshot.commit_update(
            &snapshot.baseline(),
            &update,
            "responding-agent",
            &request.thread_id,
            &request.turn_id,
            /*usage*/ None,
            /*evidence*/ None,
            MemorySaveTiming::default(),
        ) {
            return json!({ "enabled": true, "error": format!("{error:#}") });
        }
    }
    json!({
        "enabled": true,
        "memoryChanged": memory_changed,
        "checkpointChanged": checkpoint_changed,
    })
}

#[cfg(test)]
#[path = "elpis_memory_save_tests.rs"]
mod tests;

//! Elpis: the responding agent's guarded `save_memory` tool, ported from v0.3.0.
//!
//! v0.3.0 registered this handler in core's tool plan. On 0.159 it is an extension tool
//! (`crate::elpis_memory`), so it receives a `ToolCall` instead of a core `ToolInvocation`:
//! the thread id, turn id and turn-start baseline are bound when the extension offers the
//! tool, and the turn evidence comes from the call's conversation history. The saving logic,
//! limits, messages and spec are v0.3.0's.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::ResponseItem;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolCall;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use serde_json::json;

use crate::function_tool::FunctionCallError;
use crate::memory_save::MemoryBaseline;
use crate::memory_save::MemorySaveTiming;
use crate::memory_save::MemorySnapshot;
use crate::memory_save::MemoryUpdate;
use crate::tools::context::FunctionToolOutput;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::context::boxed_tool_output;
use crate::tools::handlers::parse_arguments;

pub(crate) const TOOL_NAME: &str = "save_memory";
const MAX_EVIDENCE_CHARS: usize = 64_000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryEdit {
    old_text: Option<String>,
    new_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveMemoryArgs {
    memory_edits: Vec<MemoryEdit>,
    checkpoint: Option<String>,
}

#[derive(Debug)]
struct SaveMemoryOutput {
    memory_changed: bool,
    checkpoint_changed: bool,
}

impl ToolOutput for SaveMemoryOutput {
    fn log_output(&self) -> String {
        if self.memory_changed || self.checkpoint_changed {
            "Saved durable Elpis context.".to_string()
        } else {
            "No durable context changes requested.".to_string()
        }
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        let message = if self.memory_changed || self.checkpoint_changed {
            format!(
                "Durable context saved (memory_changed={}, checkpoint_changed={}).",
                self.memory_changed, self.checkpoint_changed
            )
        } else {
            "No durable context changes requested; existing files were preserved.".to_string()
        };
        FunctionToolOutput::from_text(message, Some(true)).to_response_item(call_id, payload)
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        json!({
            "saved": self.memory_changed || self.checkpoint_changed,
            "status": if self.memory_changed || self.checkpoint_changed { "saved" } else { "no_changes_requested" },
            "memory_changed": self.memory_changed,
            "checkpoint_changed": self.checkpoint_changed,
        })
    }
}

pub struct SaveMemoryHandler {
    memory_root: PathBuf,
    cwd: PathBuf,
    thread_id: String,
    turn_id: String,
    baseline: MemoryBaseline,
}

impl SaveMemoryHandler {
    pub fn new(
        memory_root: &Path,
        cwd: &Path,
        thread_id: &str,
        turn_id: &str,
        baseline: MemoryBaseline,
    ) -> Self {
        Self {
            memory_root: memory_root.to_path_buf(),
            cwd: cwd.to_path_buf(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            baseline,
        }
    }

    fn apply_memory_edits(
        existing: &str,
        edits: &[MemoryEdit],
    ) -> Result<Option<String>, FunctionCallError> {
        let mut memory = existing.to_string();
        for edit in edits {
            match (&edit.old_text, &edit.new_text) {
                (None, None) => {
                    return Err(FunctionCallError::RespondToModel(
                        "a memory edit must append, replace, or remove text".to_string(),
                    ));
                }
                (None, Some(new_text)) => {
                    if new_text.is_empty() {
                        return Err(FunctionCallError::RespondToModel(
                            "appended memory text cannot be empty".to_string(),
                        ));
                    }
                    if !memory.is_empty() && !memory.ends_with('\n') {
                        memory.push('\n');
                    }
                    memory.push_str(new_text);
                }
                (Some(old_text), replacement) => {
                    if old_text.is_empty() {
                        return Err(FunctionCallError::RespondToModel(
                            "old_text cannot be empty".to_string(),
                        ));
                    }
                    let matches = memory.match_indices(old_text).count();
                    if matches != 1 {
                        return Err(FunctionCallError::RespondToModel(format!(
                            "old_text must match durable memory exactly once; found {matches} matches"
                        )));
                    }
                    memory = memory.replacen(old_text, replacement.as_deref().unwrap_or(""), 1);
                }
            }
        }
        Ok((memory != existing).then_some(memory))
    }

    fn bounded_turn_evidence(
        items: &[ResponseItem],
        thread_id: &str,
        turn_id: &str,
    ) -> Result<String, FunctionCallError> {
        let mut remaining = MAX_EVIDENCE_CHARS;
        let mut evidence = BTreeMap::new();
        for user_pass in [true, false] {
            let mut allowance = if user_pass {
                MAX_EVIDENCE_CHARS / 2
            } else {
                remaining
            };
            for (index, item) in items.iter().enumerate().rev() {
                if item.turn_id() != Some(turn_id)
                    || !matches!(item, ResponseItem::Message { role, .. } if role == "user" || role == "assistant")
                {
                    continue;
                }
                let is_user = matches!(item, ResponseItem::Message { role, .. } if role == "user");
                if (user_pass && !is_user) || evidence.contains_key(&index) {
                    continue;
                }
                let size = serde_json::to_string(item)
                    .map_err(|error| FunctionCallError::Fatal(error.to_string()))?
                    .chars()
                    .count();
                if size > allowance || size > remaining {
                    continue;
                }
                allowance -= size;
                remaining -= size;
                evidence.insert(
                    index,
                    json!({
                        "id": format!("{thread_id}:{turn_id}:{index}"),
                        "turn_id": turn_id,
                        "item": item,
                    }),
                );
            }
        }
        serde_json::to_string(&json!({
            "evidence": evidence.into_values().collect::<Vec<_>>()
        }))
        .map_err(|error| FunctionCallError::Fatal(error.to_string()))
    }

    async fn save(&self, invocation: ToolCall<'_>) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        // The baseline was captured when this turn started; a call from any other turn
        // would compare the files against the wrong snapshot.
        if invocation.turn_id != self.turn_id {
            return Err(FunctionCallError::RespondToModel(
                "save_memory can only save the turn that offered it".to_string(),
            ));
        }
        let ToolPayload::Function { arguments } = &invocation.payload else {
            return Err(FunctionCallError::RespondToModel(
                "save_memory handler received unsupported payload".to_string(),
            ));
        };
        let args: SaveMemoryArgs = parse_arguments(arguments)?;
        let snapshot = MemorySnapshot::open(&self.memory_root, &self.cwd)
            .map_err(|error| {
                FunctionCallError::RespondToModel(format!(
                    "Memory save failed before writing: {error:#}"
                ))
            })?
            .ok_or_else(|| {
                FunctionCallError::RespondToModel(
                    "Memory save is disabled for this workspace".to_string(),
                )
            })?;
        let memory = Self::apply_memory_edits(&snapshot.memory, &args.memory_edits)?;
        let memory_changed = memory.is_some();
        let checkpoint_changed = args.checkpoint.is_some();
        if !memory_changed && !checkpoint_changed {
            snapshot
                .validate_baseline(&self.baseline)
                .map_err(|error| {
                    FunctionCallError::RespondToModel(format!("Memory save failed: {error:#}"))
                })?;
            return Ok(boxed_tool_output(SaveMemoryOutput {
                memory_changed: false,
                checkpoint_changed: false,
            }));
        }
        let evidence = Self::bounded_turn_evidence(
            invocation.conversation_history.items(),
            &self.thread_id,
            &self.turn_id,
        )?;
        snapshot
            .commit_update(
                &self.baseline,
                &MemoryUpdate {
                    memory,
                    checkpoint: args.checkpoint,
                },
                "responding-agent",
                &self.thread_id,
                &self.turn_id,
                None,
                Some(&evidence),
                MemorySaveTiming::default(),
            )
            .map_err(|error| {
                FunctionCallError::RespondToModel(format!("Memory save failed: {error:#}"))
            })?;
        Ok(boxed_tool_output(SaveMemoryOutput {
            memory_changed,
            checkpoint_changed,
        }))
    }
}

impl<'call> codex_tools::ToolExecutor<ToolCall<'call>> for SaveMemoryHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(TOOL_NAME)
    }

    fn spec(&self) -> ToolSpec {
        let nullable_string =
            || JsonSchema::any_of(vec![JsonSchema::string(None), JsonSchema::null(None)], None);
        let edit = JsonSchema::object(
            BTreeMap::from([
                ("old_text".to_string(), nullable_string()),
                ("new_text".to_string(), nullable_string()),
            ]),
            Some(vec!["old_text".to_string(), "new_text".to_string()]),
            Some(false.into()),
        );
        ToolSpec::Function(ResponsesApiTool {
            name: TOOL_NAME.to_string(),
            description: "Persist durable context before your final answer when it changed. MEMORY.md is only for stable global user preferences: use exact edits so unseen memory is preserved. ES is the workspace checkpoint for project state, verification, blockers, and next action. Pass an empty edit list and null checkpoint when nothing should change. Saving is local, opt-in, root-thread only, and rejects stale or conflicting files.".to_string(),
            strict: true,
            defer_loading: None,
            parameters: JsonSchema::object(
                BTreeMap::from([
                    (
                        "memory_edits".to_string(),
                        JsonSchema::array(
                            edit,
                            Some("Exact MEMORY.md edits. old_text=null appends; new_text=null removes; both strings replace.".to_string()),
                        ),
                    ),
                    (
                        "checkpoint".to_string(),
                        JsonSchema::any_of(
                            vec![JsonSchema::string(None), JsonSchema::null(None)],
                            Some("Complete replacement for the workspace's Consolidated State, or null to preserve it byte-for-byte.".to_string()),
                        ),
                    ),
                ]),
                Some(vec!["memory_edits".to_string(), "checkpoint".to_string()]),
                Some(false.into()),
            ),
            output_schema: None,
        })
    }

    fn handle<'a>(&'a self, invocation: ToolCall<'call>) -> codex_tools::ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(self.save(invocation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use codex_tools::ConversationHistory;
    use codex_tools::NoopTurnItemEmitter;
    use codex_tools::ToolCallSource;
    use codex_tools::ToolExecutor;
    use codex_utils_output_truncation::TruncationPolicy;

    const THREAD: &str = "019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10";
    const TURN: &str = "current-turn";

    fn message(role: &str, text: &str, turn_id: &str) -> ResponseItem {
        let mut item = ResponseItem::Message {
            id: None,
            role: role.to_string(),
            content: vec![codex_protocol::models::ContentItem::InputText {
                text: text.to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        };
        item.set_turn_id_if_missing(turn_id);
        item
    }

    fn call(turn_id: &str, arguments: JsonValue, history: Vec<ResponseItem>) -> ToolCall<'static> {
        ToolCall {
            turn_id: turn_id.to_string(),
            call_id: "call-1".to_string(),
            tool_name: ToolName::plain(TOOL_NAME),
            model: "gpt-test".to_string(),
            codex_turn_metadata: None,
            truncation_policy: TruncationPolicy::Bytes(10_000),
            source: ToolCallSource::Direct,
            conversation_history: ConversationHistory::new(history),
            turn_item_emitter: Arc::new(NoopTurnItemEmitter),
            environments: Vec::new(),
            payload: ToolPayload::Function {
                arguments: arguments.to_string(),
            },
        }
    }

    /// An opted-in workspace: `<home>/memories` with `memory-autosave.json` enabled.
    fn enabled_workspace(dir: &Path) -> anyhow::Result<(PathBuf, PathBuf, PathBuf)> {
        let root = dir.join("memories");
        let cwd = dir.join("project");
        let workspace = crate::elpis_context::workspace_context_dir(Some(&root), &cwd)
            .ok_or_else(|| anyhow::anyhow!("workspace"))?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        Ok((root, cwd, workspace))
    }

    #[test]
    fn exact_edits_preserve_unseen_memory() {
        let updated = SaveMemoryHandler::apply_memory_edits(
            "# Elpis Memory\n\n- Existing preference.\n",
            &[
                MemoryEdit {
                    old_text: None,
                    new_text: Some("- User prefers Celsius.\n".to_string()),
                },
                MemoryEdit {
                    old_text: Some("Existing".to_string()),
                    new_text: Some("Established".to_string()),
                },
            ],
        )
        .unwrap()
        .unwrap();
        assert!(updated.contains("Established preference"));
        assert!(updated.contains("User prefers Celsius"));
    }

    #[test]
    fn ambiguous_edits_are_rejected() {
        let error = SaveMemoryHandler::apply_memory_edits(
            "same same",
            &[MemoryEdit {
                old_text: Some("same".to_string()),
                new_text: None,
            }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("exactly once"));
    }

    #[test]
    fn evidence_is_current_turn_only_and_reserves_space_for_the_user() {
        let evidence = SaveMemoryHandler::bounded_turn_evidence(
            &[
                message("user", "older preference", "older-turn"),
                message("user", "current preference", "current-turn"),
                message("assistant", &"x".repeat(MAX_EVIDENCE_CHARS), "current-turn"),
            ],
            "thread",
            "current-turn",
        )
        .unwrap();

        assert!(evidence.contains("current preference"));
        assert!(!evidence.contains("older preference"));
        assert!(!evidence.contains(&"x".repeat(MAX_EVIDENCE_CHARS)));
        assert!(evidence.contains("\"turn_id\":\"current-turn\""));
        assert!(evidence.contains("thread:current-turn:1"));
    }

    /// Positive case: a call from the offering turn writes MEMORY.md, ES.md and a receipt
    /// that carries the turn's user message as evidence.
    #[tokio::test]
    async fn the_offering_turn_saves_memory_checkpoint_and_receipt() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let (root, cwd, workspace) = enabled_workspace(dir.path())?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, &cwd)?
            .ok_or_else(|| anyhow::anyhow!("saving is enabled"))?;
        let handler = SaveMemoryHandler::new(&root, &cwd, THREAD, TURN, baseline);

        handler
            .handle(call(
                TURN,
                json!({
                    "memory_edits": [{ "old_text": null, "new_text": "- User prefers Celsius.\n" }],
                    "checkpoint": "- [ ] Verify Cedar on port 5823.",
                }),
                vec![message("user", "I prefer Celsius.", TURN)],
            ))
            .await?;

        assert!(std::fs::read_to_string(root.join("MEMORY.md"))?.contains("User prefers Celsius"));
        let checkpoint = std::fs::read_to_string(workspace.join("ES.md"))?;
        assert!(checkpoint.contains("## Consolidated State"));
        assert!(checkpoint.contains("Verify Cedar on port 5823"));
        assert!(checkpoint.contains(&format!("- Thread: `{THREAD}`")));
        let receipt = std::fs::read_dir(workspace.join("memory-saves"))?
            .next()
            .ok_or_else(|| anyhow::anyhow!("a recovery receipt"))??
            .path();
        let receipt = std::fs::read_to_string(receipt)?;
        assert!(receipt.contains("\"status\": \"committed\""));
        assert!(receipt.contains("I prefer Celsius."));
        Ok(())
    }

    /// Negative case: the same save from another turn is refused and writes nothing.
    #[tokio::test]
    async fn a_call_from_another_turn_is_rejected_without_writing() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let (root, cwd, workspace) = enabled_workspace(dir.path())?;
        let baseline = MemorySnapshot::baseline_when_enabled(&root, &cwd)?
            .ok_or_else(|| anyhow::anyhow!("saving is enabled"))?;
        let handler = SaveMemoryHandler::new(&root, &cwd, THREAD, TURN, baseline);

        let Err(error) = handler
            .handle(call(
                "later-turn",
                json!({
                    "memory_edits": [{ "old_text": null, "new_text": "- Stale.\n" }],
                    "checkpoint": "- Stale.",
                }),
                Vec::new(),
            ))
            .await
        else {
            panic!("a call from another turn must fail");
        };
        assert_eq!(
            error,
            FunctionCallError::RespondToModel(
                "save_memory can only save the turn that offered it".to_string()
            )
        );
        assert!(!root.join("MEMORY.md").exists());
        assert!(!workspace.join("ES.md").exists());
        assert!(!workspace.join("memory-saves").exists());
        Ok(())
    }
}

//! Elpis: the responding agent saves durable context through `save_memory`.
//!
//! A workspace opts in with `context/workspaces/<workspace>/memory-autosave.json` containing
//! `{"enabled":true}`. For a root thread in such a workspace, each turn start captures the
//! MEMORY.md / ES.md baseline and the agent is offered the guarded `save_memory` tool
//! (`tools/handlers/save_memory.rs`, storage in `memory_save.rs`) in its normal tool loop.
//! Subagent and internal threads are never offered it, and no auxiliary model runs after a
//! response or before compaction. Saving is independent of Ledger admission, which alone
//! decides whether the saved files reach a later request (`elpis_admission`).
//!
//! v0.3.0 captured the baseline in core's turn context and planned the tool in core; on
//! 0.159 the same behavior is an extension installed from `app-server/src/extensions.rs`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use codex_extension_api::ConfigContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::TurnLifecycleContributor;
use codex_extension_api::TurnStartInput;
use codex_protocol::protocol::SessionSource;
use codex_utils_absolute_path::AbsolutePathBuf;

use crate::config::Config;
use crate::elpis_admission::memory_dir;
use crate::memory_save::MemoryBaseline;
use crate::memory_save::MemorySnapshot;
use crate::tools::handlers::SaveMemoryHandler;

/// Installs the extension that offers `save_memory` to opted-in root threads.
pub fn install_save_memory(builder: &mut ExtensionRegistryBuilder<Config>) {
    let extension = Arc::new(SaveMemoryExtension);
    builder.thread_lifecycle_contributor(extension.clone());
    builder.config_contributor(extension.clone());
    builder.turn_lifecycle_contributor(extension.clone());
    builder.tool_contributor(extension);
}

struct SaveMemoryExtension;

/// Where a root thread saves. The runtime fixes these paths; the caller cannot choose them.
/// Absent from subagent and internal threads, which therefore never see the tool.
struct SavePaths {
    memory_root: AbsolutePathBuf,
    cwd: AbsolutePathBuf,
}

impl SavePaths {
    fn from_config(config: &Config) -> Self {
        Self {
            memory_root: memory_dir(config),
            cwd: config.cwd.clone(),
        }
    }
}

/// The running turn's id and its turn-start baseline, present only while saving is enabled.
#[derive(Default)]
struct TurnBaseline(Mutex<Option<(String, MemoryBaseline)>>);

impl TurnBaseline {
    fn set(&self, value: Option<(String, MemoryBaseline)>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = value;
    }

    fn get(&self) -> Option<(String, MemoryBaseline)> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

/// Only the thread answering the user saves; v0.3.0 gave no baseline to non-root agents.
fn saves_for(session_source: &SessionSource) -> bool {
    !session_source.is_non_root_agent()
}

impl ThreadLifecycleContributor<Config> for SaveMemoryExtension {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if saves_for(input.session_source) {
                input
                    .thread_store
                    .insert(SavePaths::from_config(input.config));
            }
        })
    }
}

impl ConfigContributor<Config> for SaveMemoryExtension {
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    ) {
        if thread_store.get::<SavePaths>().is_some() {
            thread_store.insert(SavePaths::from_config(new_config));
        }
    }
}

impl TurnLifecycleContributor for SaveMemoryExtension {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(paths) = input.thread_store.get::<SavePaths>() else {
                return;
            };
            let baseline = match MemorySnapshot::baseline_when_enabled(
                paths.memory_root.as_path(),
                paths.cwd.as_path(),
            ) {
                Ok(baseline) => baseline,
                Err(error) => {
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "could not capture the turn-start memory baseline"
                    );
                    None
                }
            };
            input
                .thread_store
                .get_or_init(TurnBaseline::default)
                .set(baseline.map(|baseline| (input.turn_id.to_string(), baseline)));
        })
    }
}

impl ToolContributor for SaveMemoryExtension {
    fn tools(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(paths) = thread_store.get::<SavePaths>() else {
            return Vec::new();
        };
        let Some((turn_id, baseline)) = thread_store
            .get::<TurnBaseline>()
            .and_then(|turn_baseline| turn_baseline.get())
        else {
            return Vec::new();
        };
        vec![Arc::new(SaveMemoryHandler::new(
            paths.memory_root.as_path(),
            paths.cwd.as_path(),
            thread_store.level_id(),
            &turn_id,
            baseline,
        )) as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::ThreadId;
    use codex_protocol::protocol::SubAgentSource;

    #[test]
    fn only_the_thread_answering_the_user_saves() {
        assert!(saves_for(&SessionSource::Cli));
        assert!(saves_for(&SessionSource::VSCode));
        assert!(!saves_for(&SessionSource::SubAgent(
            SubAgentSource::ThreadSpawn {
                parent_thread_id: ThreadId::new(),
                depth: 1,
                agent_path: None,
                agent_nickname: None,
                agent_role: None,
            }
        )));
    }

    /// The tool exists only for a thread with save paths and an enabled turn baseline.
    #[test]
    fn the_tool_is_offered_only_while_the_turn_has_a_baseline() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let root = AbsolutePathBuf::try_from(dir.path().join("memories"))?;
        let cwd = AbsolutePathBuf::try_from(dir.path().join("project"))?;
        let session_store = ExtensionData::new("session");
        let thread_store = ExtensionData::new("019a0c4e-7b1e-7a41-9b4e-2f0d8c1a5e10");
        let extension = SaveMemoryExtension;

        // A subagent thread: no save paths, so nothing is offered.
        assert!(extension.tools(&session_store, &thread_store).is_empty());

        thread_store.insert(SavePaths {
            memory_root: root.clone(),
            cwd: cwd.clone(),
        });
        // Saving disabled for this turn: no baseline, no tool.
        thread_store.get_or_init(TurnBaseline::default).set(None);
        assert!(extension.tools(&session_store, &thread_store).is_empty());

        let workspace =
            crate::elpis_context::workspace_context_dir(Some(root.as_path()), cwd.as_path())
                .ok_or_else(|| anyhow::anyhow!("workspace"))?;
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("memory-autosave.json"), "{\"enabled\":true}")?;
        let baseline = MemorySnapshot::baseline_when_enabled(root.as_path(), cwd.as_path())?
            .ok_or_else(|| anyhow::anyhow!("saving is enabled"))?;
        thread_store
            .get_or_init(TurnBaseline::default)
            .set(Some(("turn-1".to_string(), baseline)));
        let tools = extension.tools(&session_store, &thread_store);
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.tool_name().name)
                .collect::<Vec<_>>(),
            vec!["save_memory".to_string()]
        );
        Ok(())
    }
}

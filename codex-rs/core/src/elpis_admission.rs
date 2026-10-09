//! Elpis: the model's request follows the Context Ledger.
//!
//! The Ledger (`elpis_context`) records which sources a workspace admits. Two seams make the
//! request obey it:
//!
//! - Instruction files (global and project AGENTS.md) are filtered in
//!   `AgentsMdManager::refresh`. Discovery keeps every file, so the Ledger can still list and
//!   re-admit a withdrawn one; only the admitted subset reaches the model.
//! - Every other admitted source (MEMORY.md, development rules, GOAL.md, ES.md and files
//!   added with `/add`) is one `elpis_continuity` World State section, contributed by the
//!   extension installed with [`install_elpis_continuity`].
//!
//! Both are single-slot World State sections, so an exclusion removes the earlier copy from
//! the next request. Ported from Elpis v0.3.0 (`app-server/src/extensions.rs`,
//! `agents_md_manager.rs`).

use std::cell::Cell;
use std::path::Path;
use std::sync::Arc;

use codex_extension_api::ConfigContributor;
use codex_extension_api::ContextContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::PreviousWorldStateSection;
use codex_extension_api::RenderedWorldStateFragment;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::WorldStateContributionInput;
use codex_extension_api::WorldStateSectionContribution;
use codex_protocol::protocol::SessionSource;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::json;

use crate::agents_md::LoadedAgentsMd;
use crate::config::Config;
use crate::elpis_context;

const ELPIS_CONTINUITY_WORLD_STATE_ID: &str = "elpis_continuity";

/// Where Manual Memory lives: `<home>/memories`. The Ledger keys its admission record from
/// this directory's parent, so the TUI and the request must agree on it.
pub fn memory_dir(config: &Config) -> AbsolutePathBuf {
    config.codex_home.join("memories")
}

/// The configured development-rule roots (`[skills] dev_rule_roots`). Empty selects the
/// managed fallback in `elpis_context`.
pub fn dev_rule_roots(config: &Config) -> Vec<AbsolutePathBuf> {
    codex_config::dev_rule_roots_from_stack(&config.config_layer_stack)
}

/// The instruction files the Context Ledger admits for this workspace.
pub(crate) fn admitted_agents_md(
    config: &Config,
    loaded: Option<Arc<LoadedAgentsMd>>,
) -> Option<Arc<LoadedAgentsMd>> {
    admitted_agents_md_for(memory_dir(config).as_path(), config.cwd.as_path(), loaded?)
}

/// An unreadable or malformed admission record admits nothing: the Ledger cannot say what
/// is included. Instructions without a file behind them are not Ledger rows and stay.
fn admitted_agents_md_for(
    memories_root: &Path,
    cwd: &Path,
    loaded: Arc<LoadedAgentsMd>,
) -> Option<Arc<LoadedAgentsMd>> {
    let admission_failed = Cell::new(false);
    let admitted = loaded.admitted_by(&|path| {
        elpis_context::instruction_source_admitted(Some(memories_root), cwd, path).unwrap_or_else(
            |_| {
                admission_failed.set(true);
                false
            },
        )
    });
    if admission_failed.get() {
        return None;
    }
    admitted.map(Arc::new)
}

/// Installs the extension that sends the Ledger's admitted continuity sources.
pub fn install_elpis_continuity(builder: &mut ExtensionRegistryBuilder<Config>) {
    let extension = Arc::new(ElpisContinuityExtension);
    builder.thread_lifecycle_contributor(extension.clone());
    builder.config_contributor(extension.clone());
    builder.prompt_contributor(extension);
}

struct ElpisContinuityExtension;

#[derive(Clone)]
struct ElpisContinuityConfig {
    memories_root: AbsolutePathBuf,
    cwd: AbsolutePathBuf,
    dev_rule_roots: Vec<AbsolutePathBuf>,
    eligible: bool,
}

impl ElpisContinuityConfig {
    fn from_config(config: &Config, eligible: bool) -> Self {
        Self {
            memories_root: memory_dir(config),
            cwd: config.cwd.clone(),
            dev_rule_roots: dev_rule_roots(config),
            eligible,
        }
    }

    /// The thread's continuity settings, unless it has none or is not eligible.
    fn for_thread(thread_store: &ExtensionData) -> Option<Arc<Self>> {
        thread_store.get::<Self>().filter(|config| config.eligible)
    }

    async fn body(&self) -> Option<String> {
        elpis_context::build_continuity_prompt_with_dev_rule_roots(
            Some(self.memories_root.as_path()),
            self.cwd.as_path(),
            &self.dev_rule_roots,
        )
        .await
    }
}

/// The Elpis instruction text a thread's next model request carries, for a client that runs
/// the thread's turns on another engine (`thread/elpisInstructions/read`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ElpisInstructions {
    /// The thread's configured `developer_instructions`.
    pub developer_instructions: Option<String>,
    /// The global and project AGENTS.md text the Context Ledger admits.
    pub agents_md: Option<String>,
    /// The admitted continuity section (MEMORY.md, development rules, GOAL.md, ES.md and
    /// files added with `/add`), exactly as the `elpis_continuity` World State section sends it.
    pub continuity: Option<String>,
}

/// The continuity text the thread's next request carries, if any.
pub(crate) async fn thread_continuity(thread_store: &ExtensionData) -> Option<String> {
    ElpisContinuityConfig::for_thread(thread_store)?
        .body()
        .await
}

impl ContextContributor for ElpisContinuityExtension {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let Some(config) = ElpisContinuityConfig::for_thread(input.thread_store) else {
                return Vec::new();
            };
            vec![continuity_section(config.body().await)]
        })
    }
}

/// One single-slot section holding the admitted continuity text, if any.
fn continuity_section(body: Option<String>) -> WorldStateSectionContribution {
    let has_model_visible_content = body.is_some();
    WorldStateSectionContribution::new(ELPIS_CONTINUITY_WORLD_STATE_ID, move |previous| {
        // A withdrawn body persists as an empty section; the slot reconciliation removes
        // the earlier copy.
        let snapshot = Some(json!({ "body": body }));
        if matches!(
            previous,
            PreviousWorldStateSection::Known(previous)
                if previous.get("body").and_then(serde_json::Value::as_str) == body.as_deref()
        ) {
            return (snapshot, None);
        }
        let fragment = body
            .as_ref()
            .map(|body| RenderedWorldStateFragment::new("developer", ("", ""), body.clone()));
        (snapshot, fragment)
    })
    .with_retained_fragment_matcher(is_elpis_continuity_fragment)
    .with_single_history_slot(has_model_visible_content)
}

impl ThreadLifecycleContributor<Config> for ElpisContinuityExtension {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            input
                .thread_store
                .insert(ElpisContinuityConfig::from_config(
                    input.config,
                    elpis_continuity_is_eligible(input.session_source),
                ));
        })
    }
}

impl ConfigContributor<Config> for ElpisContinuityExtension {
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    ) {
        let Some(previous) = thread_store.get::<ElpisContinuityConfig>() else {
            return;
        };
        thread_store.insert(ElpisContinuityConfig::from_config(
            new_config,
            previous.eligible,
        ));
    }
}

/// Guardian reviewers judge an action; they do not carry the user's continuity.
fn elpis_continuity_is_eligible(session_source: &SessionSource) -> bool {
    !crate::guardian::is_basic_session_source(session_source)
}

fn is_elpis_continuity_fragment(role: &str, text: &str) -> bool {
    role == "developer" && text.starts_with(elpis_context::ELPIS_CONTINUITY_PROMPT_PREFIX)
}

#[cfg(test)]
#[path = "elpis_admission_tests.rs"]
mod tests;

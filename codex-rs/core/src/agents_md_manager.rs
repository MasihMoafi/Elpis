use crate::agents_md::LoadedAgentsMd;
use crate::agents_md::load_project_instructions;
use crate::config::Config;
use crate::elpis_context;
use crate::environment_selection::TurnEnvironmentSnapshot;
use codex_extension_api::UserInstructions;
use codex_protocol::protocol::TurnEnvironmentSelection;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Owns the inputs and cached result of AGENTS.md discovery for a session.
pub(crate) struct AgentsMdManager {
    user_instructions: Option<UserInstructions>,
    cache: Mutex<AgentsMdCache>,
}

#[derive(Default)]
struct AgentsMdCache {
    selections: Option<Vec<TurnEnvironmentSelection>>,
    /// Identity of the Context Ledger state the cached result was filtered against.
    admission: Option<Option<String>>,
    /// Everything discovery found, so the ledger can list and re-admit a withdrawn file.
    loaded: Option<Arc<LoadedAgentsMd>>,
    /// The subset the ledger admits -- the only thing the model is allowed to see.
    admitted: Option<Arc<LoadedAgentsMd>>,
}

impl AgentsMdManager {
    pub(crate) fn new(user_instructions: Option<UserInstructions>) -> Self {
        Self {
            user_instructions: user_instructions
                .filter(|instructions| !instructions.text.trim().is_empty()),
            cache: Mutex::new(AgentsMdCache::default()),
        }
    }

    #[tracing::instrument(name = "agents_md.refresh", skip_all)]
    pub(crate) async fn refresh(&self, config: &Config, environments: &TurnEnvironmentSnapshot) {
        let selections = environments.to_selections();
        // The ledger takes part in the cache key so a toggle lands on the very next
        // request instead of waiting for the environment selection to happen to change.
        let admission = elpis_context::admission_fingerprint(
            Some(config.memory_dir.as_path()),
            config.cwd.as_path(),
        );
        {
            let cache = self.cache.lock().await;
            let unchanged = cache.selections.as_ref() == Some(&selections)
                && cache.admission.as_ref() == Some(&admission);
            // A ledger we cannot read is not a withdrawal. Once a readable state has been
            // seen, keep it rather than letting a deleted directory or a transient I/O
            // error silently strip instructions the user did admit.
            let unreadable_after_known_state =
                admission.is_none() && matches!(cache.admission.as_ref(), Some(Some(_)));
            if unchanged || unreadable_after_known_state {
                return;
            }
        }

        let loaded =
            load_project_instructions(config, self.user_instructions.clone(), environments)
                .await
                .map(Arc::new);
        let admitted = loaded.as_ref().and_then(|loaded| {
            let admitted = loaded.admitted_by(&|path| {
                elpis_context::instruction_source_admitted(
                    Some(config.memory_dir.as_path()),
                    config.cwd.as_path(),
                    path,
                )
            });
            (!admitted.is_empty()).then(|| Arc::new(admitted))
        });
        let mut cache = self.cache.lock().await;
        cache.selections = Some(selections);
        cache.admission = Some(admission);
        cache.loaded = loaded;
        cache.admitted = admitted;
    }

    /// Everything discovery found, whether or not the ledger admits it. This is what the
    /// ledger UI and `/status` list, so a withdrawn file stays visible and switchable.
    pub(crate) async fn get_loaded(&self) -> Option<Arc<LoadedAgentsMd>> {
        self.cache.lock().await.loaded.clone()
    }

    /// The instructions the ledger admits: the only ones allowed into model context.
    pub(crate) async fn get_admitted(&self) -> Option<Arc<LoadedAgentsMd>> {
        self.cache.lock().await.admitted.clone()
    }

    pub(crate) fn user_instructions(&self) -> Option<UserInstructions> {
        self.user_instructions.clone()
    }
}

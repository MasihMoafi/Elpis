use crate::agents_md::LoadedAgentsMd;
use crate::agents_md::load_project_instructions;
use crate::config::Config;
use crate::elpis_context;
use crate::environment_selection::TurnEnvironmentSnapshot;
use codex_extension_api::UserInstructions;
use codex_protocol::protocol::TurnEnvironmentSelection;
use std::cell::Cell;
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
        if let Ok(admission) = &admission {
            let cache = self.cache.lock().await;
            let unchanged = cache.selections.as_ref() == Some(&selections)
                && cache.admission.as_ref() == Some(admission);
            if unchanged {
                return;
            }
        }

        let loaded =
            load_project_instructions(config, self.user_instructions.clone(), environments)
                .await
                .map(Arc::new);
        let admission_error = Cell::new(admission.is_err());
        let admitted = loaded.as_ref().and_then(|loaded| {
            if admission_error.get() {
                return None;
            }
            let admitted = loaded.admitted_by(&|path| {
                match elpis_context::instruction_source_admitted(
                    Some(config.memory_dir.as_path()),
                    config.cwd.as_path(),
                    path,
                ) {
                    Ok(admitted) => admitted,
                    Err(_) => {
                        admission_error.set(true);
                        false
                    }
                }
            });
            (!admission_error.get() && !admitted.is_empty()).then(|| Arc::new(admitted))
        });
        let mut cache = self.cache.lock().await;
        cache.selections = Some(selections);
        cache.admission = if admission_error.get() {
            None
        } else {
            admission.ok()
        };
        cache.loaded = loaded;
        cache.admitted = if admission_error.get() {
            None
        } else {
            admitted
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigBuilder;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use tempfile::tempdir;

    async fn config_for(codex_home: &std::path::Path, cwd: &std::path::Path) -> Config {
        let mut config = ConfigBuilder::default()
            .codex_home(codex_home.to_path_buf())
            .build()
            .await
            .expect("test config");
        config.cwd = AbsolutePathBuf::from_absolute_path(cwd).expect("absolute cwd");
        config
    }

    #[tokio::test(flavor = "current_thread")]
    async fn elpis_context_admission_error_clears_cached_admitted_instructions() {
        let home = tempdir().expect("home");
        let cwd = tempdir().expect("cwd");
        let global_path = home.path().join("AGENTS.md");
        std::fs::write(&global_path, "optional instruction").expect("global fixture");
        let config = config_for(home.path(), cwd.path()).await;
        let manager = AgentsMdManager::new(Some(UserInstructions {
            text: "optional instruction".to_string(),
            source: AbsolutePathBuf::from_absolute_path(&global_path).expect("absolute source"),
        }));
        let environments = TurnEnvironmentSnapshot::default();

        elpis_context::set_continuity_source_admitted(
            Some(config.memory_dir.as_path()),
            config.cwd.as_path(),
            "Global AGENTS.md",
            true,
        )
        .expect("admit optional instruction");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_admitted().await.expect("admitted").text(),
            "optional instruction"
        );

        let admission = elpis_context::workspace_context_dir(
            Some(config.memory_dir.as_path()),
            config.cwd.as_path(),
        )
        .expect("workspace")
        .join("admission.toml");
        std::fs::write(&admission, "global_rules = true # changed fingerprint\n")
            .expect("changed valid admission");
        {
            let _guard = elpis_context::inject_admission_read_failure();
            manager.refresh(&config, &environments).await;
        }
        assert_eq!(
            manager.get_loaded().await.expect("discovery retained").text(),
            "optional instruction"
        );
        assert!(manager.get_admitted().await.is_none());

        std::fs::write(&admission, "global_rules = true\n").expect("repair read failure");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_admitted().await.expect("read retry recovered").text(),
            "optional instruction"
        );

        std::fs::write(&admission, "not valid = [").expect("corrupt admission");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_loaded().await.expect("discovery retained").text(),
            "optional instruction"
        );
        assert!(manager.get_admitted().await.is_none());

        std::fs::write(&admission, "global_rules = true\n").expect("repair admission");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_admitted().await.expect("recovered").text(),
            "optional instruction"
        );

        std::fs::remove_file(&admission).expect("delete admission");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_loaded().await.expect("discovery retained").text(),
            "optional instruction"
        );
        assert!(
            manager.get_admitted().await.is_none(),
            "configured-file NotFound must use optional-off default"
        );

        std::fs::create_dir(&admission).expect("non-file admission");
        manager.refresh(&config, &environments).await;
        assert_eq!(
            manager.get_loaded().await.expect("discovery retained").text(),
            "optional instruction"
        );
        assert!(manager.get_admitted().await.is_none());
    }

    #[tokio::test]
    async fn admission_not_found_retries_with_default_on_dev_rules() {
        let home = tempdir().expect("home");
        let cwd = tempdir().expect("cwd");
        let dev = home.path().join("skills/dev/AGENTS.md");
        std::fs::create_dir_all(dev.parent().expect("dev parent")).expect("dev directory");
        std::fs::write(&dev, "development instruction").expect("dev fixture");
        let config = config_for(home.path(), cwd.path()).await;
        let manager = AgentsMdManager::new(Some(UserInstructions {
            text: "development instruction".to_string(),
            source: AbsolutePathBuf::from_absolute_path(&dev).expect("absolute dev source"),
        }));

        manager
            .refresh(&config, &TurnEnvironmentSnapshot::default())
            .await;

        assert_eq!(
            manager.get_admitted().await.expect("default-on dev rule").text(),
            "development instruction"
        );
    }
}

//! The user-owned personal skill is refreshed for every turn, including after compaction.
use std::path::Path;
use std::path::PathBuf;
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
use serde_json::json;

use crate::config::Config;

const PREFIX: &str = "# Personal working preferences\n";

pub fn install(builder: &mut ExtensionRegistryBuilder<Config>) {
    let extension = Arc::new(PersonalExtension);
    builder.thread_lifecycle_contributor(extension.clone());
    builder.config_contributor(extension.clone());
    builder.prompt_contributor(extension);
}

struct PersonalExtension;
struct PersonalHome(Option<PathBuf>);

pub(crate) async fn instructions(home: &Path) -> Option<String> {
    let home = home.to_path_buf();
    match tokio::task::spawn_blocking(move || {
        codex_skills::personal::read(&home).map(|body| {
            body.map(|body| {
                format!(
                    "{PREFIX}Source: {}\n\n{body}",
                    codex_skills::personal::path(&home).display()
                )
            })
        })
    })
    .await
    {
        Ok(Ok(body)) => body,
        result => {
            tracing::warn!(?result, "Could not load personal skill");
            None
        }
    }
}

impl ThreadLifecycleContributor<Config> for PersonalExtension {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let home = (!crate::guardian::is_basic_session_source(input.session_source))
                .then(|| input.config.codex_home.to_path_buf());
            input.thread_store.insert(PersonalHome(home));
        })
    }
}

impl ConfigContributor<Config> for PersonalExtension {
    fn on_config_changed(
        &self,
        _session: &ExtensionData,
        thread: &ExtensionData,
        _old: &Config,
        config: &Config,
    ) {
        if thread
            .get::<PersonalHome>()
            .is_some_and(|home| home.0.is_some())
        {
            thread.insert(PersonalHome(Some(config.codex_home.to_path_buf())));
        }
    }
}

impl ContextContributor for PersonalExtension {
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let Some(home) = input.thread_store.get::<PersonalHome>() else {
                return vec![];
            };
            let Some(home) = &home.0 else { return vec![] };
            let body = instructions(home).await;
            let visible = body.is_some();
            vec![WorldStateSectionContribution::new("elpis_personal", move |previous| {
                let snapshot = Some(json!({ "body": body }));
                if matches!(previous, PreviousWorldStateSection::Known(previous) if previous.get("body").and_then(serde_json::Value::as_str) == body.as_deref()) {
                    return (snapshot, None);
                }
                let fragment = body.as_ref().map(|body| RenderedWorldStateFragment::new("user", ("", ""), body.clone()));
                (snapshot, fragment)
            }).with_retained_fragment_matcher(|role, text| role == "user" && text.starts_with(PREFIX))
                .with_single_history_slot(visible)]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn personal_skill_loads_only_when_present_and_preserves_edits() {
        let home = tempfile::TempDir::new().unwrap();
        assert!(instructions(home.path()).await.is_none());
        assert!(codex_skills::personal::show_tip(home.path()));
        let (path, _) = codex_skills::personal::open(home.path()).unwrap();
        let content = format!(
            "{}\nMy habit: PERSONAL_HABIT_5713\n",
            codex_skills::personal::TEMPLATE
        );
        std::fs::write(&path, &content).unwrap();
        codex_skills::personal::open(home.path()).unwrap();
        let loaded = instructions(home.path()).await.unwrap();
        assert!(loaded.contains("PERSONAL_HABIT_5713"));
        assert!(!codex_skills::personal::show_tip(home.path()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        std::fs::write(
            &path,
            content.replace("PERSONAL_HABIT_5713", "EDITED_HABIT_5713"),
        )
        .unwrap();
        let edited = instructions(home.path()).await.unwrap();
        assert!(edited.contains("EDITED_HABIT_5713"));
        assert!(!edited.contains("PERSONAL_HABIT_5713"));
    }

    #[tokio::test]
    async fn personal_dismissal_creates_no_skill_and_malformed_skills_are_not_loaded() {
        let home = tempfile::TempDir::new().unwrap();
        codex_skills::personal::dismiss_tip(home.path()).unwrap();
        assert!(!codex_skills::personal::show_tip(home.path()));
        assert!(instructions(home.path()).await.is_none());
        let (path, _) = codex_skills::personal::open(home.path()).unwrap();
        std::fs::write(&path, "not a skill").unwrap();
        assert!(instructions(home.path()).await.is_none());
        std::fs::write(&path, "x".repeat(32 * 1024 + 1)).unwrap();
        assert!(instructions(home.path()).await.is_none());
    }
}

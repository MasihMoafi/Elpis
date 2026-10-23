//! Elpis: `/prune`, `/smart-prune` and `/pruner-model`, as in v0.3.0 `slash_dispatch.rs` and
//! `model_popups.rs`.
//!
//! `/prune` turns Smart Prune on for subsequent turns; `/smart-prune` toggles it and
//! `/smart-prune on|off` sets it and `log` browses its evidence. `/pruner-model`
//! chooses the model Smart Prune's optimizer uses, saved in `pruner.json`
//! (`core/src/pruner_settings.rs`); the chat model is never changed. Typed choices parse as
//! `/memory-model`'s do (`crate::elpis_background_model`): `default`, `<provider>:<id>`, or an
//! id on the provider the pruner already uses.

use std::path::Path;

use super::ChatWidget;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_background_model::BackgroundModelChoice;
use crate::legacy_core::pruner_settings::PrunerSettings;
use crate::slash_command::SlashCommand;
use codex_app_server_protocol::PrunerReadResponse;
use codex_app_server_protocol::PrunerWriteParams;
use codex_protocol::openai_models::ReasoningEffort;

const SMART_PRUNE_USAGE: &str = "Usage: /smart-prune [on|off|log]";
const PRUNER_MODEL_LOADING_VIEW_ID: &str = "pruner-model-loading";
const PRUNER_MODEL_SELECTION_VIEW_ID: &str = "pruner-model-selection";

/// Saves a `/pruner-model` choice to `pruner.json` and returns how the choice reads.
/// `role_provider` is the provider a bare id runs on when the choice names none.
pub(crate) fn save_pruner_choice(
    home: &Path,
    choice: &BackgroundModelChoice,
    role_provider: &str,
) -> Result<String, String> {
    let mut settings = PrunerSettings::load(home).map_err(|error| error.to_string())?;
    if let Some(provider) = &choice.provider {
        settings.provider = provider.clone();
    }
    settings.model = choice.model.clone();
    settings.reasoning_effort = None;
    settings.save(home).map_err(|error| error.to_string())?;
    Ok(match &settings.model {
        None => "built-in default".to_string(),
        Some(model) => format!(
            "{model} on {}",
            settings.provider.as_deref().unwrap_or(role_provider)
        ),
    })
}

/// `--pruner-model <id|provider:id|default>`, copied from v0.3.0 `tui/src/lib.rs`. Unlike the
/// slash command, a bare id clears the pinned provider, so the pruner follows background
/// maintenance again rather than keeping a provider chosen for some earlier model.
pub(crate) fn apply_pruner_model_flag(
    config: &crate::legacy_core::config::Config,
    model: &str,
) -> std::io::Result<()> {
    let mut settings = PrunerSettings::load(config.codex_home.as_path())?;
    let (provider, model) = match model.split_once(':') {
        Some((provider, id)) if !id.is_empty() && config.model_providers.contains_key(provider) => {
            (Some(provider.to_string()), id)
        }
        _ => (None, model),
    };
    settings.model = (model != "default").then(|| model.to_string());
    settings.reasoning_effort = None;
    settings.provider = settings.model.as_ref().and(provider);
    settings.save(config.codex_home.as_path())
}

impl ChatWidget {
    /// Bare `/prune`, `/smart-prune` and `/pruner-model`.
    pub(super) fn dispatch_prune_command(&mut self, cmd: SlashCommand) {
        match cmd {
            SlashCommand::Prune => {
                self.request_smart_prune_enabled(/*enabled*/ true);
            }
            SlashCommand::SmartPrune => {
                self.toggle_smart_prune();
            }
            SlashCommand::PrunerModel => self.open_pruner_model_popup(),
            _ => unreachable!("not a pruning command: /{}", cmd.command()),
        }
    }

    /// `/smart-prune on|off|log` and `/pruner-model <id|provider:id|default>`.
    pub(super) fn dispatch_prune_command_with_args(&mut self, cmd: SlashCommand, args: &str) {
        match cmd {
            SlashCommand::SmartPrune => match args.to_ascii_lowercase().as_str() {
                "log" => self.open_smart_prune_log(),
                "on" => {
                    self.request_smart_prune_enabled(/*enabled*/ true);
                }
                "off" => {
                    self.request_smart_prune_enabled(/*enabled*/ false);
                }
                _ => self.add_error_message(SMART_PRUNE_USAGE.to_string()),
            },
            SlashCommand::PrunerModel => {
                let result = BackgroundModelChoice::parse(args, &self.config).and_then(|choice| {
                    save_pruner_choice(
                        self.config.codex_home.as_path(),
                        &choice,
                        self.pruner_role_provider(),
                    )
                });
                match result {
                    Ok(chosen) => {
                        self.request_pruner_settings(false);
                        self.add_info_message(
                            format!("Smart Prune model saved: {chosen}. Applies to the next optimizer request; chat model unchanged."), None,
                        );
                    }
                    Err(error) => {
                        self.add_error_message(format!("Pruner model was not changed: {error}"))
                    }
                }
            }
            _ => self.dispatch_prune_command(cmd),
        }
    }

    /// The provider the pruner uses when `pruner.json` names none: the background provider,
    /// else the session's.
    pub(crate) fn pruner_role_provider(&self) -> &str {
        self.config
            .background_provider
            .as_deref()
            .unwrap_or(&self.config.model_provider_id)
    }

    pub(super) fn request_pruner_settings(&self, show_picker: bool) {
        let request_id = uuid::Uuid::new_v4();
        self.context_ledger.pruner_request.set(Some(request_id));
        self.app_event_tx
            .send(AppEvent::Elpis(ElpisAppEvent::LoadPrunerSettings {
                request_id,
                show_picker,
            }));
    }

    /// The Ledger and `/pruner-model` share one picker. Every effort comes from the
    /// current server catalog; a missing catalog cannot manufacture a model or a level.
    pub(super) fn open_pruner_model_popup(&mut self) {
        if !self
            .model_catalog
            .models
            .iter()
            .any(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
        {
            self.add_error_message(
                "No model catalog available. Reopen /pruner-model after models load.".into(),
            );
            return;
        }
        self.show_selection_view(SelectionViewParams {
            view_id: Some(PRUNER_MODEL_LOADING_VIEW_ID),
            title: Some("Loading pruner settings…".into()),
            footer_hint: Some(standard_popup_hint_line()),
            ..SelectionViewParams::picker()
        });
        self.request_pruner_settings(true);
    }

    pub(crate) fn finish_pruner_settings(
        &mut self,
        request_id: uuid::Uuid,
        show_picker: bool,
        result: Result<PrunerReadResponse, String>,
    ) {
        if self.context_ledger.pruner_request.get() != Some(request_id) {
            return;
        }
        self.context_ledger.pruner_request.set(None);
        let settings = match result {
            Ok(settings) => settings,
            Err(error) => {
                if show_picker {
                    self.bottom_pane
                        .dismiss_active_view_if_id(PRUNER_MODEL_LOADING_VIEW_ID);
                    self.add_error_message(format!("Cannot read pruner settings: {error}"));
                }
                return;
            }
        };
        self.context_ledger.pruner_settings = Some(settings.clone());
        if !show_picker {
            return;
        }
        let params = self.pruner_model_picker(&settings);
        if params.items.len() <= 1 {
            self.bottom_pane
                .dismiss_active_view_if_id(PRUNER_MODEL_LOADING_VIEW_ID);
            self.add_error_message(
                "No model catalog available. Reopen /pruner-model after models load.".into(),
            );
            return;
        }
        // Esc or a newer menu during the read cancels opening the picker.
        self.bottom_pane
            .replace_selection_view_if_active(PRUNER_MODEL_LOADING_VIEW_ID, params);
        self.request_redraw();
    }

    fn pruner_model_picker(&self, settings: &PrunerReadResponse) -> SelectionViewParams {
        let provider = self.config.model_provider_id.clone();
        let mut choices = vec![(
            None,
            None,
            "Provider default".to_string(),
            "Restore automatic pruner model selection".to_string(),
        )];
        for preset in self
            .model_catalog
            .models
            .iter()
            .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
        {
            if preset.supported_reasoning_efforts.is_empty() {
                choices.push((
                    Some(preset.model.clone()),
                    None,
                    preset.model.clone(),
                    preset.description.clone(),
                ));
            } else {
                for level in &preset.supported_reasoning_efforts {
                    choices.push((
                        Some(preset.model.clone()),
                        Some(level.effort.clone()),
                        format!("{} · {} effort", preset.model, level.effort.as_str()),
                        level.description.clone(),
                    ));
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        let items: Vec<SelectionItem> = choices
            .into_iter()
            .filter(|(model, effort, _, _)| seen.insert((model.clone(), effort.clone())))
            .map(|(model, effort, name, description)| {
                let search_value = Some(format!(
                    "{} {} {name} {description}",
                    model.as_deref().unwrap_or("default"),
                    effort.as_ref().map(ReasoningEffort::as_str).unwrap_or("")
                ));
                let is_current = settings.model == model
                    && (settings.reasoning_effort == effort
                        || (model.is_some()
                            && settings.reasoning_effort.is_none()
                            && effort == Some(ReasoningEffort::Low)));
                let params = PrunerWriteParams {
                    expected_version: settings.version.clone(),
                    provider: model.as_ref().map(|_| provider.clone()),
                    model,
                    reasoning_effort: effort,
                    prompt_edit: None,
                };
                SelectionItem {
                    name,
                    search_value,
                    description: Some(description),
                    is_current,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::Elpis(ElpisAppEvent::SavePrunerModel(
                            params.clone(),
                        )))
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        SelectionViewParams {
            view_id: Some(PRUNER_MODEL_SELECTION_VIEW_ID),
            initial_selected_idx: items.iter().position(|item| item.is_current),
            title: Some("Choose pruner model".into()),
            subtitle: Some(format!(
                "Catalog: {provider} · Current: {}",
                self.pruner_model_label()
            )),
            items,
            is_searchable: true,
            search_placeholder: Some("Search models and effort".into()),
            footer_hint: Some(standard_popup_hint_line()),
            ..SelectionViewParams::picker()
        }
    }

    pub(super) fn pruner_model_label(&self) -> String {
        if let Some(settings) = &self.context_ledger.pruner_settings {
            let model = settings
                .model
                .as_deref()
                .or(self.config.background_model.as_deref())
                .unwrap_or("provider default");
            let effort = settings
                .reasoning_effort
                .as_ref()
                .unwrap_or(&ReasoningEffort::Low)
                .as_str();
            format!("{model} · {effort} effort")
        } else if let Some(attempt) = &self.smart_prune.latest_attempt {
            format!(
                "{} · {} effort",
                attempt.model_slug, attempt.reasoning_effort
            )
        } else {
            "Choose model…".to_string()
        }
    }

    pub(crate) fn finish_pruner_model_save(&mut self, result: Result<PrunerReadResponse, String>) {
        match result {
            Ok(settings) => {
                // A read started before this save must not overwrite its new value.
                self.context_ledger.pruner_request.set(None);
                self.context_ledger.pruner_settings = Some(settings);
                self.add_info_message(
                    format!("Smart Prune model saved: {}.", self.pruner_model_label()),
                    None,
                );
            }
            Err(error) => self.add_error_message(format!("Pruner model was not changed: {error}")),
        }
        self.request_redraw();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn choice(model: Option<&str>, provider: Option<Option<&str>>) -> BackgroundModelChoice {
        BackgroundModelChoice {
            model: model.map(str::to_string),
            provider: provider.map(|provider| provider.map(str::to_string)),
        }
    }

    /// Positive: `--pruner-model openai:<id>` pins the provider; a bare id clears it.
    /// Negative: an unknown prefix is part of the id, and `default` clears both.
    #[tokio::test]
    async fn pruner_model_flag_follows_v030() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let config =
            crate::legacy_core::config::Config::load_default_with_cli_overrides_for_codex_home(
                home.path().to_path_buf(),
                Vec::new(),
            )
            .await?;
        let load = || PrunerSettings::load(home.path());

        apply_pruner_model_flag(&config, "openai:gpt-5.6-luna")?;
        assert_eq!(load()?.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(load()?.provider.as_deref(), Some("openai"));

        apply_pruner_model_flag(&config, "gpt-5.6-terra")?;
        assert_eq!(load()?.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(load()?.provider, None);

        apply_pruner_model_flag(&config, "vendor:model")?;
        assert_eq!(load()?.model.as_deref(), Some("vendor:model"));
        assert_eq!(load()?.provider, None);

        apply_pruner_model_flag(&config, "default")?;
        assert_eq!(load()?, PrunerSettings::default());
        Ok(())
    }

    /// Positive: a choice lands in pruner.json and reads back with its provider.
    /// Negative: `default` clears both, and a bare id keeps the pinned provider.
    #[test]
    fn pruner_choices_save_to_pruner_json_as_in_v030() {
        let home = tempfile::tempdir().expect("tempdir");
        let pinned = choice(Some("luna"), Some(Some("pinned")));
        assert_eq!(
            save_pruner_choice(home.path(), &pinned, "session"),
            Ok("luna on pinned".to_string())
        );
        assert_eq!(
            save_pruner_choice(home.path(), &choice(Some("terra"), None), "session"),
            Ok("terra on pinned".to_string())
        );
        let saved = PrunerSettings::load(home.path()).expect("load");
        assert_eq!(saved.model.as_deref(), Some("terra"));
        assert_eq!(saved.provider.as_deref(), Some("pinned"));

        assert_eq!(
            save_pruner_choice(home.path(), &choice(None, Some(None)), "session"),
            Ok("built-in default".to_string())
        );
        assert_eq!(
            PrunerSettings::load(home.path()).expect("load"),
            PrunerSettings::default()
        );
        assert_eq!(
            save_pruner_choice(home.path(), &choice(Some("mini"), None), "session"),
            Ok("mini on session".to_string())
        );
    }
}

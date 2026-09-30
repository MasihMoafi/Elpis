//! Elpis: `/prune`, `/smart-prune` and `/pruner-model`, as in v0.3.0 `slash_dispatch.rs` and
//! `model_popups.rs`.
//!
//! `/prune` turns Smart Prune on for subsequent turns; `/smart-prune` toggles it and
//! `/smart-prune on|off` sets it (`elpis_ledger_glue.rs` owns the switch). `/pruner-model`
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
use crate::elpis_background_model::BackgroundModelChoice;
use crate::history_cell;
use crate::legacy_core::pruner_settings::PrunerSettings;
use crate::slash_command::SlashCommand;

const SMART_PRUNE_USAGE: &str = "Usage: /smart-prune [on|off]";
const PRUNER_MODEL_SELECTION_VIEW_ID: &str = "pruner-model-selection";

/// Saves a `/pruner-model` choice to `pruner.json` and returns how the choice reads.
/// `role_provider` is the provider a bare id runs on when the choice names none.
fn save_pruner_choice(
    home: &Path,
    choice: &BackgroundModelChoice,
    role_provider: &str,
) -> Result<String, String> {
    let mut settings = PrunerSettings::load(home).map_err(|error| error.to_string())?;
    if let Some(provider) = &choice.provider {
        settings.provider = provider.clone();
    }
    settings.model = choice.model.clone();
    settings.save(home).map_err(|error| error.to_string())?;
    Ok(match &settings.model {
        None => "built-in default".to_string(),
        Some(model) => format!(
            "{model} on {}",
            settings.provider.as_deref().unwrap_or(role_provider)
        ),
    })
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

    /// `/smart-prune on|off` and `/pruner-model <id|provider:id|default>`.
    pub(super) fn dispatch_prune_command_with_args(&mut self, cmd: SlashCommand, args: &str) {
        match cmd {
            SlashCommand::SmartPrune => match args.to_ascii_lowercase().as_str() {
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
                    Ok(chosen) => self.add_info_message(
                        format!(
                            "Smart Prune model saved: {chosen}. Applies to the next optimizer request; chat model unchanged."
                        ),
                        /*hint*/ None,
                    ),
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
    fn pruner_role_provider(&self) -> &str {
        self.config
            .background_provider
            .as_deref()
            .unwrap_or(&self.config.model_provider_id)
    }

    /// Bare `/pruner-model`: the provider default, this provider's models, and a model set
    /// by hand that the catalog does not list.
    fn open_pruner_model_popup(&mut self) {
        let settings = match PrunerSettings::load(self.config.codex_home.as_path()) {
            Ok(settings) => settings,
            Err(error) => {
                self.add_error_message(format!("Cannot read pruner settings: {error}"));
                return;
            }
        };
        // The catalog is the session provider's, so a listed model pins that provider.
        let provider_id = self.config.model_provider_id.clone();
        let mut choices: Vec<(Option<String>, Option<String>, String, String)> = vec![(
            None,
            None,
            "Provider default".to_string(),
            "Restore automatic pruner model selection".to_string(),
        )];
        choices.extend(
            self.model_catalog()
                .try_list_models()
                .unwrap_or_default()
                .into_iter()
                .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
                .map(|preset| {
                    (
                        Some(preset.model.clone()),
                        Some(provider_id.clone()),
                        preset.model,
                        preset.description,
                    )
                }),
        );
        // A model set by hand may be absent from the catalog, so keep it selectable.
        if let Some(model) = settings.model.clone()
            && !choices
                .iter()
                .any(|(choice, _, _, _)| choice.as_ref() == Some(&model))
        {
            choices.push((
                Some(model.clone()),
                settings.provider.clone(),
                model,
                "Currently configured".to_string(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        choices.retain(|(model, _, _, _)| seen.insert(model.clone()));
        let footer_note = (choices.len() == 1)
            .then(|| "No models available. Reopen /pruner-model to retry.".into());
        let items: Vec<SelectionItem> = choices
            .into_iter()
            .map(|(model, provider, name, description)| {
                let home = self.config.codex_home.clone();
                let is_current = settings.model == model;
                SelectionItem {
                    name,
                    description: Some(description),
                    is_current,
                    actions: vec![Box::new(move |tx| {
                        let result = PrunerSettings::load(home.as_path()).and_then(|mut settings| {
                            settings.model = model.clone();
                            settings.provider = provider.clone();
                            settings.save(home.as_path())
                        });
                        let cell = match result {
                            Ok(()) => history_cell::new_info_event(
                                format!(
                                    "Smart Prune model saved: {}. Chat model unchanged.",
                                    model.as_deref().unwrap_or("provider default")
                                ),
                                /*hint*/ None,
                            ),
                            Err(error) => history_cell::new_error_event(format!(
                                "Cannot save pruner model: {error}"
                            )),
                        };
                        tx.send(AppEvent::InsertHistoryCell(Box::new(cell)));
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.show_selection_view(SelectionViewParams {
            view_id: Some(PRUNER_MODEL_SELECTION_VIEW_ID),
            initial_selected_idx,
            title: Some("Choose pruner model".into()),
            subtitle: Some(format!(
                "Provider: {} · Current: {} · Chat model unchanged",
                settings
                    .provider
                    .as_deref()
                    .unwrap_or_else(|| self.pruner_role_provider()),
                settings.model.as_deref().unwrap_or("provider default")
            )),
            items,
            is_searchable: true,
            search_placeholder: Some("Search models".into()),
            footer_note,
            footer_hint: Some(standard_popup_hint_line()),
            ..SelectionViewParams::picker()
        });
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

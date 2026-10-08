//! Elpis: `/effort`, how hard the current model thinks. GPT and Claude subscription models list
//! their effort levels; an Antigravity model carries its level in its id
//! (`agy/gemini-3.8-flash-high`), so its levels are its family's other ids.

use super::elpis_providers::ANTIGRAVITY_PROVIDER_ID;
use super::elpis_providers::bridged_provider_of_model;
use super::*;

/// The effort suffixes of Antigravity ids, lowest first.
const ANTIGRAVITY_LEVELS: [&str; 3] = ["low", "medium", "high"];

/// A level `/effort` offers: its name and the model and effort choosing it applies.
struct EffortChoice {
    name: String,
    model: String,
    effort: ReasoningEffortConfig,
}

impl ChatWidget {
    /// Bare `/effort`: the current model's levels, the current one highlighted.
    pub(super) fn open_effort_popup(&mut self) {
        if !self.is_session_configured() {
            self.add_info_message(
                "Effort selection is disabled until startup completes.".to_string(),
                /*hint*/ None,
            );
            return;
        }
        let model = self.current_model().to_string();
        if !is_antigravity(&model) {
            match self.current_preset() {
                Some(preset) if preset.supported_reasoning_efforts.len() > 1 => {
                    self.open_reasoning_popup(preset);
                }
                _ => self.say_no_effort_levels(),
            }
            return;
        }
        let items: Vec<SelectionItem> = self
            .effort_choices()
            .into_iter()
            .map(|choice| SelectionItem {
                name: capitalized(&choice.name),
                is_current: choice.model == model,
                actions: self.model_selection_actions(
                    choice.model,
                    Some(choice.effort),
                    /*should_prompt_plan_mode_scope*/ false,
                ),
                dismiss_on_select: true,
                ..Default::default()
            })
            .collect();
        if items.is_empty() {
            self.say_no_effort_levels();
            return;
        }
        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.bottom_pane.show_selection_view(SelectionViewParams {
            title: Some(format!(
                "Select Reasoning Level for {}",
                self.model_display_name()
            )),
            items,
            initial_selected_idx,
            ..SelectionViewParams::picker()
        });
    }

    /// `/effort <level>`: that level of the current model, if it has it.
    pub(super) fn dispatch_effort_with_args(&mut self, name: &str) {
        let choices = self.effort_choices();
        if choices.is_empty() {
            self.say_no_effort_levels();
            return;
        }
        let picked = choices.iter().find(|choice| {
            choice.name.eq_ignore_ascii_case(name)
                || Self::reasoning_effort_label(&choice.effort).eq_ignore_ascii_case(name)
        });
        match picked {
            Some(choice) => {
                self.apply_model_and_effort(choice.model.clone(), Some(choice.effort.clone()));
            }
            None => {
                let levels: Vec<&str> = choices.iter().map(|choice| choice.name.as_str()).collect();
                self.add_error_message(format!(
                    "`{name}` is not an effort level of {}. Its levels: {}.",
                    self.model_display_name(),
                    levels.join(", ")
                ));
            }
        }
    }

    /// The current model's levels: its family's ids for an Antigravity model, its effort levels
    /// otherwise.
    fn effort_choices(&self) -> Vec<EffortChoice> {
        let model = self.current_model();
        let catalog = self.model_catalog.try_list_models().unwrap_or_default();
        if is_antigravity(model) {
            let Some((family, _)) = model
                .rsplit_once('-')
                .filter(|(_, level)| ANTIGRAVITY_LEVELS.contains(level))
            else {
                return Vec::new();
            };
            return ANTIGRAVITY_LEVELS
                .iter()
                .filter_map(|level| {
                    let id = format!("{family}-{level}");
                    let preset = catalog.iter().find(|preset| preset.model == id)?;
                    Some(EffortChoice {
                        name: level.to_string(),
                        model: id,
                        effort: preset.default_reasoning_effort.clone(),
                    })
                })
                .collect();
        }
        self.current_preset()
            .map(|preset| preset.supported_reasoning_efforts)
            .unwrap_or_default()
            .into_iter()
            .map(|option| EffortChoice {
                name: option.effort.as_str().to_string(),
                model: model.to_string(),
                effort: option.effort,
            })
            .collect()
    }

    fn current_preset(&self) -> Option<ModelPreset> {
        let model = self.current_model();
        self.model_catalog
            .try_list_models()
            .ok()?
            .into_iter()
            .find(|preset| preset.model == model)
    }

    fn say_no_effort_levels(&mut self) {
        self.add_info_message(
            format!(
                "{} has no effort levels to choose from.",
                self.model_display_name()
            ),
            /*hint*/ None,
        );
    }
}

fn is_antigravity(model: &str) -> bool {
    bridged_provider_of_model(model).is_some_and(|bridged| bridged.id == ANTIGRAVITY_PROVIDER_ID)
}

fn capitalized(name: &str) -> String {
    let mut chars = name.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

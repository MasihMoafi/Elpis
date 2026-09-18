//! Accept current provider-scoped model replies and refresh an open picker in place.

use super::model_popups::ALL_MODELS_SELECTION_VIEW_ID;
use super::model_popups::BACKGROUND_MODEL_SELECTION_VIEW_ID;
use super::model_popups::MODEL_SELECTION_VIEW_ID;
use super::model_popups::ModelPickerRole;
use super::model_popups::PRUNER_MODEL_SELECTION_VIEW_ID;
use super::*;

impl ChatWidget {
    pub(super) fn request_model_catalog(&mut self, provider_id: Option<String>) {
        let request_id = uuid::Uuid::new_v4();
        self.model_popup_request_ids
            .insert(provider_id.clone(), request_id);
        self.app_event_tx.send(AppEvent::FetchModels {
            request_id,
            provider_id,
        });
    }

    pub(crate) fn model_popup_request_is_current(
        &self,
        request_id: uuid::Uuid,
        provider_id: Option<&str>,
    ) -> bool {
        self.model_popup_request_ids
            .get(&provider_id.map(str::to_string))
            == Some(&request_id)
    }

    pub(crate) fn model_popup_request_is_pending(&self, provider_id: &str) -> bool {
        self.model_popup_request_ids
            .contains_key(&Some(provider_id.to_string()))
    }

    pub(crate) fn on_models_loaded(
        &mut self,
        request_id: uuid::Uuid,
        provider_id: Option<String>,
        result: Result<Vec<ModelPreset>, String>,
    ) -> bool {
        if !self.model_popup_request_is_current(request_id, provider_id.as_deref()) {
            return false;
        }
        self.model_popup_request_ids.remove(&provider_id);
        let presets = match result {
            Ok(presets) if !presets.is_empty() => presets,
            Ok(_) | Err(_) => {
                self.refresh_open_model_popup();
                return false;
            }
        };

        let Some(provider_id) = provider_id else {
            return false;
        };
        let make_primary = provider_id == self.active_model_provider_id();
        let existing = self.model_catalog.models_for_provider(&provider_id);
        let primary_already_matches = self
            .model_catalog
            .try_list_models()
            .is_ok_and(|models| models == presets);
        if existing.as_ref() == Some(&presets) && (!make_primary || primary_already_matches) {
            return false;
        }
        self.model_catalog = Arc::new(self.model_catalog.with_provider_models(
            provider_id,
            presets,
            make_primary,
        ));
        if make_primary {
            self.refresh_effective_service_tier();
            self.refresh_model_dependent_surfaces();
        }
        self.refresh_open_model_popup();
        true
    }

    pub(super) fn refresh_open_model_popup(&mut self) {
        if self
            .bottom_pane
            .selected_index_for_active_view(PRUNER_MODEL_SELECTION_VIEW_ID)
            .is_some()
        {
            self.refresh_pruner_model_popup();
            return;
        }
        if self
            .bottom_pane
            .selected_index_for_active_view(BACKGROUND_MODEL_SELECTION_VIEW_ID)
            .is_some()
        {
            self.refresh_background_model_popup();
            return;
        }
        if self
            .bottom_pane
            .selected_index_for_active_view(MODEL_SELECTION_VIEW_ID)
            .is_some()
        {
            let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
            let presets = self.models_for_provider(&provider_id);
            self.open_model_popup_with_presets(presets);
        } else if self
            .bottom_pane
            .selected_index_for_active_view(ALL_MODELS_SELECTION_VIEW_ID)
            .is_some()
        {
            let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
            let presets = self
                .models_for_provider(&provider_id)
                .into_iter()
                .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
                .collect();
            self.open_all_models_popup(presets);
        }
    }

    pub(super) fn models_for_active_provider(&self) -> Vec<ModelPreset> {
        self.models_for_provider(self.active_model_provider_id())
    }

    /// Picker catalogue for a named provider, and only ever that provider's.
    ///
    /// The old fallback here handed back the session catalogue for any provider
    /// that had not answered yet, which is how picking OpenAI could list
    /// DeepSeek and Qwen. A provider now answers with its own live list, else
    /// the list Elpis ships for it, else nothing.
    pub(super) fn models_for_provider(&self, provider_id: &str) -> Vec<ModelPreset> {
        // OpenRouter's bundled catalogue is only the free auto-router, so prefer
        // the live list with prices once it has arrived.
        if provider_id == codex_model_provider_info::OPENROUTER_PROVIDER_ID {
            let live = self.openrouter_live_presets();
            if !live.is_empty() {
                return live;
            }
            return codex_model_provider::openrouter_free_model_catalog()
                .models
                .into_iter()
                .map(ModelPreset::from)
                .collect();
        }
        // Ollama's catalogue is whatever is installed on this machine, which no
        // remote endpoint can report.
        if provider_id == codex_model_provider_info::OLLAMA_OSS_PROVIDER_ID
            && !self.ollama_local_models.is_empty()
        {
            return self.ollama_local_presets();
        }
        if let Some(models) = self.model_catalog.models_for_provider(provider_id) {
            return models;
        }
        // The session's own catalogue counts only when it was loaded for this
        // provider. Switching provider mid-session used to leave the previous
        // provider's models showing under the new one.
        if provider_id == self.active_model_provider_id()
            && self.model_catalog.primary_belongs_to(provider_id)
            && let Ok(models) = self.model_catalog.try_list_models()
            && !models.is_empty()
        {
            return models;
        }
        Self::bundled_presets_for_provider(provider_id)
    }

    /// The models Elpis ships for a provider, for the moment before that
    /// provider's own endpoint answers - or for good, when it has no endpoint
    /// Elpis can read.
    pub(super) fn bundled_presets_for_provider(provider_id: &str) -> Vec<ModelPreset> {
        codex_model_provider_info::bundled_provider_models(provider_id)
            .iter()
            .enumerate()
            .filter_map(|(priority, model)| {
                let description = match model.max_output_tokens {
                    Some(max_output) => format!(
                        "{} context · {} max output",
                        Self::token_count_label(model.context_window),
                        Self::token_count_label(max_output)
                    ),
                    None => format!("{} context", Self::token_count_label(model.context_window)),
                };
                let info: codex_protocol::openai_models::ModelInfo =
                    serde_json::from_value(serde_json::json!({
                        "slug": model.slug,
                        "display_name": model.display_name,
                        "description": description,
                        "default_reasoning_level": null,
                        "supported_reasoning_levels": [],
                        "shell_type": "shell_command",
                        "visibility": "list",
                        "supported_in_api": true,
                        "priority": priority,
                        "availability_nux": null,
                        "upgrade": null,
                        "base_instructions": "",
                        "supports_reasoning_summary_parameter": false,
                        "support_verbosity": false,
                        "default_verbosity": null,
                        "apply_patch_tool_type": null,
                        "truncation_policy": {"mode": "bytes", "limit": 10000},
                        "supports_parallel_tool_calls": true,
                        "supports_image_detail_original": false,
                        "context_window": model.context_window,
                        "max_context_window": model.context_window,
                        "experimental_supported_tools": [],
                        "input_modalities": ["text"]
                    }))
                    .ok()?;
                Some(ModelPreset::from(info))
            })
            .collect()
    }

    fn token_count_label(tokens: u32) -> String {
        if tokens >= 1_000_000 && tokens % 1_000_000 == 0 {
            format!("{}M", tokens / 1_000_000)
        } else if tokens >= 1_000 {
            format!("{}k", tokens / 1_000)
        } else {
            tokens.to_string()
        }
    }

    pub(super) fn show_model_selection_view(&mut self, mut params: SelectionViewParams) {
        let selected_index = params
            .view_id
            .and_then(|view_id| self.bottom_pane.selected_index_for_active_view(view_id));
        let selected_model = selected_index.and_then(|index| self.model_popup_model_ids.get(index));
        params.initial_selected_idx = params
            .items
            .iter()
            .position(|item| Some(&item.name) == selected_model)
            .or(params.initial_selected_idx);
        self.model_popup_model_ids = params.items.iter().map(|item| item.name.clone()).collect();
        if let Some(view_id) = params.view_id.filter(|_| selected_index.is_some()) {
            self.bottom_pane
                .replace_selection_view_if_active(view_id, params);
        } else {
            self.bottom_pane.show_selection_view(params);
        }
    }
}

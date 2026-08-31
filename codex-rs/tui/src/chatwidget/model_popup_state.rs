//! Accept current provider-scoped model replies and refresh an open picker in place.

use super::model_popups::ALL_MODELS_SELECTION_VIEW_ID;
use super::model_popups::MODEL_SELECTION_VIEW_ID;
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
        let Ok(presets) = result else {
            return false;
        };
        if presets.is_empty() {
            return false;
        }

        let Some(provider_id) = provider_id else {
            return false;
        };
        let make_primary = provider_id == self.active_model_provider_id();
        let existing = self.model_catalog.models_for_provider(&provider_id);
        if existing.as_ref() == Some(&presets) {
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

    fn refresh_open_model_popup(&mut self) {
        if self
            .bottom_pane
            .selected_index_for_active_view(MODEL_SELECTION_VIEW_ID)
            .is_some()
        {
            let presets = self.models_for_active_provider();
            self.open_model_popup_with_presets(presets);
        } else if self
            .bottom_pane
            .selected_index_for_active_view(ALL_MODELS_SELECTION_VIEW_ID)
            .is_some()
        {
            let presets = self
                .models_for_active_provider()
                .into_iter()
                .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
                .collect();
            self.open_all_models_popup(presets);
        }
    }

    pub(super) fn models_for_active_provider(&self) -> Vec<ModelPreset> {
        self.model_catalog
            .models_for_provider(self.active_model_provider_id())
            .unwrap_or_else(|| self.model_catalog.try_list_models().unwrap_or_default())
    }

    pub(super) fn show_model_selection_view(&mut self, mut params: SelectionViewParams) {
        let selected_index = params
            .view_id
            .and_then(|view_id| self.bottom_pane.selected_index_for_active_view(view_id));
        let selected_model = selected_index.and_then(|index| self.model_popup_model_ids.get(index));
        params.initial_selected_idx = params
            .items
            .iter()
            .position(|item| Some(&item.name) == selected_model);
        self.model_popup_model_ids = params.items.iter().map(|item| item.name.clone()).collect();
        if let Some(view_id) = params.view_id.filter(|_| selected_index.is_some()) {
            self.bottom_pane
                .replace_selection_view_if_active(view_id, params);
        } else {
            self.bottom_pane.show_selection_view(params);
        }
    }
}

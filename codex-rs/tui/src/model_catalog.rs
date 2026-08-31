use codex_protocol::openai_models::ModelPreset;
use std::collections::HashMap;
use std::convert::Infallible;

#[derive(Debug, Clone)]
pub(crate) struct ModelCatalog {
    models: Vec<ModelPreset>,
    provider_models: HashMap<String, Vec<ModelPreset>>,
}

impl ModelCatalog {
    pub(crate) fn new(models: Vec<ModelPreset>) -> Self {
        Self {
            models,
            provider_models: HashMap::new(),
        }
    }

    pub(crate) fn try_list_models(&self) -> Result<Vec<ModelPreset>, Infallible> {
        Ok(self.models.clone())
    }

    pub(crate) fn models_for_provider(&self, provider_id: &str) -> Option<Vec<ModelPreset>> {
        self.provider_models.get(provider_id).cloned()
    }

    pub(crate) fn with_provider_models(
        &self,
        provider_id: String,
        models: Vec<ModelPreset>,
        make_primary: bool,
    ) -> Self {
        let mut catalog = self.clone();
        catalog.provider_models.insert(provider_id, models.clone());
        if make_primary {
            catalog.models = models;
        }
        catalog
    }
}

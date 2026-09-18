use codex_protocol::openai_models::ModelPreset;
use std::collections::HashMap;
use std::convert::Infallible;

#[derive(Debug, Clone)]
pub(crate) struct ModelCatalog {
    models: Vec<ModelPreset>,
    /// Which provider `models` came from, so the session catalogue is never
    /// offered as another provider's. `None` means it predates any fetch and
    /// belongs to whichever provider the session started on.
    primary_provider: Option<String>,
    provider_models: HashMap<String, Vec<ModelPreset>>,
}

impl ModelCatalog {
    pub(crate) fn new(models: Vec<ModelPreset>) -> Self {
        Self {
            models,
            primary_provider: None,
            provider_models: HashMap::new(),
        }
    }

    /// The session-wide list, tagged with the provider it was loaded for.
    pub(crate) fn for_provider(models: Vec<ModelPreset>, provider_id: &str) -> Self {
        Self {
            models,
            primary_provider: Some(provider_id.to_string()),
            provider_models: HashMap::new(),
        }
    }

    /// Whether the session-wide list describes this provider.
    ///
    /// An untagged list came from a request that named no provider, so it
    /// belongs to none of them in particular and is never offered as one
    /// provider's catalogue.
    pub(crate) fn primary_belongs_to(&self, provider_id: &str) -> bool {
        self.primary_provider.as_deref() == Some(provider_id)
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
        catalog
            .provider_models
            .insert(provider_id.clone(), models.clone());
        if make_primary {
            catalog.models = models;
            catalog.primary_provider = Some(provider_id);
        }
        catalog
    }
}

//! Exposes only the pruning model override and provider identities, never credentials.
use super::config_processor::ConfigRequestProcessor;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use codex_app_server_protocol::JSONRPCErrorError;
use codex_app_server_protocol::PrunerProviderChoice;
use codex_app_server_protocol::PrunerReadResponse;
use codex_app_server_protocol::PrunerWriteParams;
use codex_core::config::Config;
use codex_core::pruner_settings::PrunerSettings;
use sha2::Digest;
use sha2::Sha256;

fn version(settings: &PrunerSettings) -> Result<String, JSONRPCErrorError> {
    let bytes = serde_json::to_vec(settings)
        .map_err(|_| internal_error("Could not encode pruning settings"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn response(
    settings: PrunerSettings,
    config: &Config,
) -> Result<PrunerReadResponse, JSONRPCErrorError> {
    let version = version(&settings)?;
    let mut providers = config
        .model_providers
        .iter()
        .map(|(id, provider)| PrunerProviderChoice {
            id: id.clone(),
            display_name: provider.name.clone(),
        })
        .collect::<Vec<_>>();
    providers.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(PrunerReadResponse {
        model: settings.model,
        provider: settings.provider,
        reasoning_effort: settings.reasoning_effort,
        version,
        providers,
    })
}

fn stale_version() -> JSONRPCErrorError {
    let mut error = invalid_request("Pruning settings changed; reload before saving again");
    error.data = Some(serde_json::json!({ "reason": "staleVersion" }));
    error
}

impl ConfigRequestProcessor {
    pub(crate) async fn pruner_read(&self) -> Result<PrunerReadResponse, JSONRPCErrorError> {
        let config = self.load_latest_config(None).await?;
        let settings = PrunerSettings::load(&config.codex_home)
            .map_err(|_| internal_error("Could not read pruning settings"))?;
        response(settings, &config)
    }

    pub(crate) async fn pruner_write(
        &self,
        params: PrunerWriteParams,
    ) -> Result<PrunerReadResponse, JSONRPCErrorError> {
        if params.model.is_some() != params.provider.is_some() {
            return Err(invalid_request(
                "Select both a pruning model and provider, or clear both",
            ));
        }
        let config = self.load_latest_config(None).await?;
        if let Some(provider) = params.provider.as_ref() {
            if !config.model_providers.contains_key(provider) {
                return Err(invalid_request("Unknown pruning provider"));
            }
        }
        let settings = PrunerSettings::load(&config.codex_home)
            .map_err(|_| internal_error("Could not read pruning settings"))?;
        if version(&settings)? != params.expected_version {
            return Err(stale_version());
        }
        // Keep the custom prompt intact. The shared core store checks the snapshot again
        // under its file lock, including writers from the terminal picker.
        let updated = PrunerSettings {
            backend: settings.backend,
            model: params.model,
            provider: params.provider,
            reasoning_effort: params.reasoning_effort,
            system_prompt: settings.system_prompt.clone(),
        };
        updated
            .validate()
            .map_err(|error| invalid_request(error.to_string()))?;
        if !updated
            .save_if_unchanged(&config.codex_home, &settings)
            .map_err(|_| internal_error("Could not save pruning settings"))?
        {
            return Err(stale_version());
        }
        response(updated, &config)
    }
}

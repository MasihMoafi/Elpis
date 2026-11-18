pub mod cache;
pub mod collaboration_mode_presets;
// Elpis: the model is told it is Elpis.
pub(crate) mod config;
mod elpis_identity;
pub mod manager;
pub mod model_info;
pub mod model_presets;
pub mod test_support;

pub use codex_protocol::auth::AuthMode;
pub use config::ModelsManagerConfig;

/// Load the bundled model catalog shipped with `codex-models-manager`.
pub fn bundled_models_response()
-> std::result::Result<codex_protocol::openai_models::ModelsResponse, serde_json::Error> {
    serde_json::from_str(include_str!("../models.json"))
}

/// OpenAI gates model discovery by the catalog compatibility version, independently
/// of Elpis's package version. This schema supports the GPT-6.2 catalog.
pub fn client_version_to_whole() -> String {
    codex_login::default_client::OPENAI_CLIENT_VERSION.to_string()
}

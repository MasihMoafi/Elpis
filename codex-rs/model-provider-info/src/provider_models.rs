//! Where a provider's key is minted, written down next to the provider itself.
//!
//! This file used to hold each provider's models as well - slug, display name
//! and context window, typed out by hand. Those rows were a guess about someone
//! else's account: they listed models a key might not reach, missed every model
//! added since the table was written, and stated context windows nobody had
//! measured. Providers publish all of that themselves, so Elpis asks them
//! instead (`model-provider/src/native_models_endpoint.rs`). A provider that
//! cannot be reached now lists nothing, which is the honest answer.

use crate::ANTHROPIC_PROVIDER_ID;
use crate::GOOGLE_GEMINI_PROVIDER_ID;

/// Where the owner mints a key for a provider, or `None` when the provider
/// needs no key at all (a local runtime) or Elpis has no page to point at.
pub fn provider_api_key_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        ANTHROPIC_PROVIDER_ID => Some("https://console.anthropic.com/settings/keys"),
        GOOGLE_GEMINI_PROVIDER_ID => Some("https://aistudio.google.com/apikey"),
        crate::OPENAI_PROVIDER_ID => Some("https://platform.openai.com/api-keys"),
        crate::OPENROUTER_PROVIDER_ID => Some("https://openrouter.ai/keys"),
        _ => None,
    }
}

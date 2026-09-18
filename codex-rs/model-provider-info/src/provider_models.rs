//! The models each provider serves, written down next to the provider itself.
//!
//! The contract is borrowed from the two references that do multi-provider
//! selection well: Zed declares a provider's models inside that provider's own
//! module (`crates/language_models/src/provider/deepseek.rs` returns exactly
//! two DeepSeek models from `provided_models`), and pi-mono gives every
//! provider its own generated catalog file (`providers/deepseek.models.ts`).
//! In both, a model exists only as one of a named provider's models, so a
//! picker physically cannot offer a model the chosen provider does not serve.
//!
//! Elpis had no such list: every provider shared one catalog, which is why
//! choosing OpenAI could list DeepSeek and Qwen. This module is the missing
//! per-provider list. It holds only what the provider publishes and Elpis can
//! stand behind - slug, name, and limits. Prices are not written here; a
//! provider that reports them live (OpenRouter) shows them, the rest do not
//! rather than showing an invented number.

use crate::ANTHROPIC_PROVIDER_ID;
use crate::GOOGLE_GEMINI_PROVIDER_ID;

/// One model as its provider publishes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderModel {
    /// The id sent on the wire.
    pub slug: &'static str,
    /// The name shown in a picker.
    pub display_name: &'static str,
    /// Total context window in tokens.
    pub context_window: u32,
    /// Largest response the provider will return, where the provider states
    /// one. `None` means unpublished, not unlimited.
    pub max_output_tokens: Option<u32>,
}

/// Source: Zed `crates/anthropic/src/anthropic.rs` for the ids. Anthropic
/// publishes its own limits through the listing endpoint Elpis already calls,
/// so these numbers are only the fallback shown before that answers.
const ANTHROPIC_MODELS: &[ProviderModel] = &[
    ProviderModel {
        slug: "claude-opus-5",
        display_name: "Claude Opus 5",
        context_window: 200_000,
        max_output_tokens: None,
    },
    ProviderModel {
        slug: "claude-sonnet-5",
        display_name: "Claude Sonnet 5",
        context_window: 200_000,
        max_output_tokens: None,
    },
    ProviderModel {
        slug: "claude-fable-5-1",
        display_name: "Claude Fable 5.1",
        context_window: 200_000,
        max_output_tokens: None,
    },
    ProviderModel {
        slug: "claude-opus-4-8",
        display_name: "Claude Opus 4.8",
        context_window: 200_000,
        max_output_tokens: None,
    },
    ProviderModel {
        slug: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        context_window: 200_000,
        max_output_tokens: None,
    },
    ProviderModel {
        slug: "claude-haiku-4-5",
        display_name: "Claude Haiku 4.5",
        context_window: 200_000,
        max_output_tokens: None,
    },
];

/// Source: Zed `crates/google_ai/src/google_ai.rs`.
const GOOGLE_GEMINI_MODELS: &[ProviderModel] = &[
    ProviderModel {
        slug: "gemini-3.8-flash",
        display_name: "Gemini 3.8 Flash",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
    ProviderModel {
        slug: "gemini-3.7-flash",
        display_name: "Gemini 3.7 Flash",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
    ProviderModel {
        slug: "gemini-3.6-flash",
        display_name: "Gemini 3.6 Flash",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
    ProviderModel {
        slug: "gemini-3.5-flash",
        display_name: "Gemini 3.5 Flash",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
    ProviderModel {
        slug: "gemini-3.5-flash-lite",
        display_name: "Gemini 3.5 Flash-Lite",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
    ProviderModel {
        slug: "gemini-3.1-pro-preview",
        display_name: "Gemini 3.1 Pro",
        context_window: 1_048_576,
        max_output_tokens: Some(65_536),
    },
];

/// The models Elpis ships for a provider, used when the provider's own
/// `/models` endpoint has not answered (yet, or at all).
///
/// An empty slice means "ask the provider" - correct for OpenRouter, Ollama
/// and LM Studio, whose catalogs are per-account or per-machine and cannot be
/// written down here.
pub fn bundled_provider_models(provider_id: &str) -> &'static [ProviderModel] {
    match provider_id {
        ANTHROPIC_PROVIDER_ID => ANTHROPIC_MODELS,
        GOOGLE_GEMINI_PROVIDER_ID => GOOGLE_GEMINI_MODELS,
        _ => &[],
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_providers_models_are_only_its_own() {
        // The whole point of the table: no slug may appear under two
        // providers, or the picker is back to offering a model the chosen
        // provider cannot serve.
        let ids = [ANTHROPIC_PROVIDER_ID, GOOGLE_GEMINI_PROVIDER_ID];
        let mut seen: Vec<&str> = Vec::new();
        for id in ids {
            for model in bundled_provider_models(id) {
                assert!(
                    !seen.contains(&model.slug),
                    "{} is listed under more than one provider",
                    model.slug
                );
                seen.push(model.slug);
            }
        }
    }
}

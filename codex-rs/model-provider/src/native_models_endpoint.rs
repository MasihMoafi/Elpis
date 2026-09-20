//! Live model catalogs for providers whose list endpoint is not Codex-shaped.
//!
//! Anthropic, Google, and every OpenAI-compatible third party publish a models
//! endpoint, but none of them speaks the schema
//! [`crate::models_endpoint::OpenAiModelsEndpoint`] expects — that one wants
//! Codex's own `{"models":[…]}` payload with a full `ModelInfo` per row. Before
//! this module each provider was represented by a single invented entry — one
//! model name and one context window written into the source — so a picker
//! showed "Gemini 3.5 Flash · 1000k" whether or not that model existed on the
//! account, and the window was a number nobody had measured. Every field here
//! comes from the provider's own response; when the request fails the catalog is
//! empty, which is honest, rather than a fabricated row.

use std::time::Duration;

use codex_http_client::ClientRouteClass;
use codex_http_client::HttpClientFactory;
use codex_model_provider_info::ModelProviderInfo;
use codex_model_provider_info::WireApi;
use codex_models_manager::manager::ModelsEndpointClient;
use codex_models_manager::manager::ModelsEndpointFuture;
use codex_models_manager::model_info::BASE_INSTRUCTIONS;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CoreResult;
use codex_protocol::openai_models::ModelInfo;
use tokio::time::timeout;

const CATALOG_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Anthropic's list endpoint reports no context window, so it is carried here
/// per family. These are Anthropic's published windows for the current models;
/// the beta 1M-token window for Sonnet is deliberately not claimed, because it
/// requires a header Elpis does not send and would overstate what a turn holds.
const ANTHROPIC_DEFAULT_CONTEXT_WINDOW: u32 = 200_000;

/// A provider catalog that has to be parsed from the provider's own schema.
#[derive(Debug)]
pub(crate) struct NativeModelsEndpoint {
    info: ModelProviderInfo,
}

impl NativeModelsEndpoint {
    /// Returns an endpoint when this provider publishes a catalog Elpis can read.
    pub(crate) fn for_provider(info: &ModelProviderInfo) -> Option<Self> {
        if !matches!(
            info.wire_api,
            WireApi::AnthropicMessages | WireApi::GeminiGenerateContent | WireApi::Chat
        ) {
            return None;
        }
        info.base_url.as_ref()?;
        Some(Self { info: info.clone() })
    }

    fn api_key(&self) -> Option<String> {
        self.info
            .api_key()
            .ok()
            .flatten()
            .filter(|key| !key.trim().is_empty())
    }

    async fn fetch(&self, http_client_factory: HttpClientFactory) -> CoreResult<Vec<ModelInfo>> {
        let base_url = self
            .info
            .base_url
            .as_deref()
            .ok_or_else(|| CodexErr::InternalAgentDied)?
            .trim_end_matches('/')
            .to_string();
        let api_key = self.api_key();
        let (request_url, headers) = match self.info.wire_api {
            // Anthropic's and Google's catalogs are account-scoped, so without a
            // key there is nothing to list. Report the missing key instead of
            // returning a guessed model.
            WireApi::AnthropicMessages => (
                format!("{base_url}/models?limit=1000"),
                vec![
                    (
                        "x-api-key".to_string(),
                        api_key.ok_or(CodexErr::InternalAgentDied)?,
                    ),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ],
            ),
            WireApi::GeminiGenerateContent => (
                format!(
                    "{base_url}/models?pageSize=1000&key={key}",
                    key = api_key.ok_or(CodexErr::InternalAgentDied)?
                ),
                Vec::new(),
            ),
            // A hosted OpenAI-compatible provider needs the bearer key; a local
            // server serving the same routes lists without one, so the header is
            // attached only when there is a key to attach.
            WireApi::Chat => (
                format!("{base_url}/models"),
                api_key
                    .map(|key| vec![("Authorization".to_string(), format!("Bearer {key}"))])
                    .unwrap_or_default(),
            ),
            WireApi::Responses => return Ok(Vec::new()),
        };

        let client = http_client_factory
            .build_reqwest_client(
                reqwest::Client::builder()
                    .connect_timeout(CATALOG_FETCH_TIMEOUT)
                    .timeout(CATALOG_FETCH_TIMEOUT),
                &request_url,
                ClientRouteClass::Api,
            )
            .map_err(|_| CodexErr::InternalAgentDied)?;
        let mut request = client.get(&request_url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let body = timeout(CATALOG_FETCH_TIMEOUT, async {
            let response = request.send().await.map_err(|_| CodexErr::Timeout)?;
            response
                .json::<serde_json::Value>()
                .await
                .map_err(|_| CodexErr::Timeout)
        })
        .await
        .map_err(|_| CodexErr::Timeout)??;

        Ok(match self.info.wire_api {
            WireApi::AnthropicMessages => anthropic_models(&body),
            WireApi::GeminiGenerateContent => gemini_models(&body),
            WireApi::Chat => openai_compatible_models(&body),
            WireApi::Responses => Vec::new(),
        })
    }
}

impl ModelsEndpointClient for NativeModelsEndpoint {
    fn has_command_auth(&self) -> bool {
        self.info.has_command_auth()
    }

    /// Anthropic's and Google's catalogs are account-scoped, so until there is
    /// a key there is nothing to ask them for. An OpenAI-compatible server
    /// lists either way: a hosted one wants the bearer key, a local one does
    /// not need it.
    fn lists_own_models(&self) -> bool {
        match self.info.wire_api {
            WireApi::AnthropicMessages | WireApi::GeminiGenerateContent => self.api_key().is_some(),
            _ => true,
        }
    }

    fn uses_codex_backend(&self) -> ModelsEndpointFuture<'_, bool> {
        Box::pin(async { false })
    }

    fn list_models<'a>(
        &'a self,
        _client_version: &'a str,
        http_client_factory: HttpClientFactory,
    ) -> ModelsEndpointFuture<'a, CoreResult<(Vec<ModelInfo>, Option<String>)>> {
        Box::pin(async move {
            let models = self.fetch(http_client_factory).await?;
            Ok((models, None))
        })
    }
}

/// The reasoning levels offered for a model whose provider says it can think.
///
/// A provider's listing says whether a model reasons, not how finely: these are
/// the three the OpenAI-compatible wire has always carried, and the ones
/// OpenRouter forwards to whatever model sits behind the slug. The descriptions
/// say what changes, not how clever the answer will be.
const REASONING_LEVELS: [(&str, &str); 3] = [
    ("low", "Answers soonest"),
    ("medium", "Balanced"),
    ("high", "Thinks longest before answering"),
];

fn reasoning_levels_json() -> serde_json::Value {
    serde_json::Value::Array(
        REASONING_LEVELS
            .iter()
            .map(|(effort, description)| {
                serde_json::json!({"effort": effort, "description": description})
            })
            .collect(),
    )
}

/// Builds a catalog entry. Only `context_window` is optional: an unknown window
/// stays unknown rather than being filled with a plausible number.
fn model_info(
    slug: &str,
    display_name: &str,
    description: String,
    context_window: Option<u32>,
    priority: i32,
    reasons: bool,
) -> Option<ModelInfo> {
    serde_json::from_value(serde_json::json!({
        "slug": slug,
        "display_name": display_name,
        "description": description,
        "default_reasoning_level": if reasons { Some("medium") } else { None },
        "supported_reasoning_levels": if reasons {
            reasoning_levels_json()
        } else {
            serde_json::Value::Array(Vec::new())
        },
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": priority,
        "availability_nux": null,
        "upgrade": null,
        // These entries are what the session runs on once one is picked, not
        // just picker rows. An empty prompt here would strip the agent's
        // instructions from every turn on a discovered model.
        "base_instructions": BASE_INSTRUCTIONS,
        "supports_reasoning_summary_parameter": false,
        "support_verbosity": false,
        "default_verbosity": null,
        "apply_patch_tool_type": null,
        "truncation_policy": {"mode": "bytes", "limit": 10000},
        "supports_parallel_tool_calls": true,
        "supports_image_detail_original": false,
        "context_window": context_window,
        "max_context_window": context_window,
        "experimental_supported_tools": [],
        "input_modalities": ["text"]
    }))
    .ok()
}

/// Parses `GET /v1/models`: `{"data":[{"id":…,"display_name":…}]}`.
pub(crate) fn anthropic_models(body: &serde_json::Value) -> Vec<ModelInfo> {
    let Some(entries) = body.get("data").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let slug = entry.get("id")?.as_str()?;
            let display_name = entry
                .get("display_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(slug);
            model_info(
                slug,
                display_name,
                format!("≈{}k context", ANTHROPIC_DEFAULT_CONTEXT_WINDOW / 1_000),
                Some(ANTHROPIC_DEFAULT_CONTEXT_WINDOW),
                index as i32,
                // Anthropic's listing says which models exist, not which of
                // them think, and Elpis does not put a thinking budget on the
                // Messages wire yet. Claiming levels here would offer a choice
                // that changes nothing.
                /*reasons*/
                false,
            )
        })
        .collect()
}

/// Parses `GET /v1beta/models`: `{"models":[{"name":"models/…","inputTokenLimit":…}]}`.
///
/// Only models that can actually answer a turn are listed, so embedding and
/// legacy endpoints do not appear in a chat-model picker.
pub(crate) fn gemini_models(body: &serde_json::Value) -> Vec<ModelInfo> {
    let Some(entries) = body.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let supports_generate = entry
                .get("supportedGenerationMethods")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .any(|method| method == "generateContent")
                });
            if !supports_generate {
                return None;
            }
            let name = entry.get("name")?.as_str()?;
            let slug = name.strip_prefix("models/").unwrap_or(name);
            let display_name = entry
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(slug);
            let context_window = entry
                .get("inputTokenLimit")
                .and_then(serde_json::Value::as_u64)
                .and_then(|limit| u32::try_from(limit).ok());
            let description = match context_window {
                Some(window) => format!("≈{}k context", window / 1_000),
                None => "context window not reported".to_string(),
            };
            model_info(
                slug,
                display_name,
                description,
                context_window,
                index as i32,
                // Same as Anthropic: the listing carries no thinking signal and
                // the generateContent wire carries no thinking config yet.
                /*reasons*/
                false,
            )
        })
        .collect()
}

/// The keys an OpenAI-compatible `/models` row may use for its context window.
/// Each one is a field some provider actually returns (`context_length` on
/// OpenRouter and Together, `context_window` on Groq, `max_context_length` on
/// Mistral). A row using none of them keeps an unknown window: there is no
/// per-provider default here, because a plausible number is still a made-up one.
const CONTEXT_WINDOW_KEYS: &[&str] = &["context_length", "context_window", "max_context_length"];

/// Parses `GET {base_url}/models` in the OpenAI list shape:
/// `{"data":[{"id":…}]}`. Some providers (Together) return the same rows as a
/// bare top-level array, so both envelopes are accepted.
pub(crate) fn openai_compatible_models(body: &serde_json::Value) -> Vec<ModelInfo> {
    let entries = match body.as_array() {
        Some(entries) => entries,
        None => match body.get("data").and_then(serde_json::Value::as_array) {
            Some(entries) => entries,
            // An error body (`{"error": …}`) lands here and lists nothing.
            None => return Vec::new(),
        },
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let slug = entry.get("id")?.as_str()?;
            let display_name = entry
                .get("display_name")
                .or_else(|| entry.get("name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or(slug);
            let context_window = CONTEXT_WINDOW_KEYS
                .iter()
                .find_map(|key| entry.get(*key).and_then(serde_json::Value::as_u64))
                .filter(|window| *window > 0)
                .and_then(|window| u32::try_from(window).ok());
            let description = match context_window {
                Some(window) => format!("≈{}k context", window / 1_000),
                None => "context window not reported".to_string(),
            };
            // OpenRouter lists the parameters each model accepts. A model that
            // takes `reasoning` is one the owner can turn the effort up on;
            // every other row keeps an empty list rather than offering a dial
            // that goes nowhere.
            let reasons = entry
                .get("supported_parameters")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|parameters| {
                    parameters
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .any(|parameter| parameter == "reasoning")
                });
            model_info(
                slug,
                display_name,
                description,
                context_window,
                index as i32,
                reasons,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::openai_models::ReasoningEffort;

    #[test]
    fn anthropic_catalog_is_read_from_the_response() {
        let body = serde_json::json!({
            "data": [
                {"type": "model", "id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6"},
                {"type": "model", "id": "claude-haiku-4-5"}
            ]
        });
        let models = anthropic_models(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "claude-sonnet-4-6");
        assert_eq!(models[0].display_name, "Claude Sonnet 4.6");
        // A missing display name falls back to the id rather than inventing one.
        assert_eq!(models[1].display_name, "claude-haiku-4-5");
        assert_eq!(models[0].context_window, Some(200_000));
    }

    #[test]
    fn a_discovered_model_carries_the_agents_instructions() {
        // A picked model's catalog entry is what the session runs on. These
        // entries shipped with an empty prompt while nothing could reach this
        // code; the moment discovery went live that would have stripped the
        // agent's instructions from every turn on a third-party provider.
        let body = serde_json::json!({"data": [{"id": "claude-sonnet-4-6"}]});
        let models = anthropic_models(&body);
        assert_eq!(models[0].base_instructions, BASE_INSTRUCTIONS);
    }

    #[test]
    fn gemini_catalog_uses_the_reported_token_limit() {
        let body = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-3.5-flash",
                    "displayName": "Gemini 3.5 Flash",
                    "inputTokenLimit": 1_048_576u64,
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/text-embedding-004",
                    "displayName": "Text Embedding",
                    "inputTokenLimit": 2048u64,
                    "supportedGenerationMethods": ["embedContent"]
                }
            ]
        });
        let models = gemini_models(&body);
        // The embedding model cannot answer a turn, so it is not offered.
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "gemini-3.5-flash");
        // 1_048_576 is what Google reports; the old hardcoded entry said 1_000_000.
        assert_eq!(models[0].context_window, Some(1_048_576));
    }

    #[test]
    fn a_model_without_a_reported_window_keeps_it_unknown() {
        let body = serde_json::json!({
            "models": [{
                "name": "models/gemini-experimental",
                "supportedGenerationMethods": ["generateContent"]
            }]
        });
        let models = gemini_models(&body);
        assert_eq!(models[0].context_window, None);
    }

    #[test]
    fn a_malformed_response_yields_no_models_instead_of_a_guess() {
        assert!(anthropic_models(&serde_json::json!({"error": "nope"})).is_empty());
        assert!(gemini_models(&serde_json::json!({"error": "nope"})).is_empty());
    }

    /// Shape of `GET https://api.deepseek.com/models`: ids only, no window.
    #[test]
    fn a_chat_provider_without_windows_lists_models_with_none() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                {"id": "deepseek-chat", "object": "model", "owned_by": "deepseek"},
                {"id": "deepseek-reasoner", "object": "model", "owned_by": "deepseek"}
            ]
        });
        let models = openai_compatible_models(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].slug, "deepseek-chat");
        // No display name in the row, so the id stands in rather than an invention.
        assert_eq!(models[0].display_name, "deepseek-chat");
        // DeepSeek reports no window, so none is claimed.
        assert_eq!(models[0].context_window, None);
        assert_eq!(
            models[0].description.as_deref(),
            Some("context window not reported")
        );
    }

    /// Shape of `GET https://api.groq.com/openai/v1/models`.
    #[test]
    fn a_chat_provider_reporting_context_window_is_believed() {
        let body = serde_json::json!({
            "object": "list",
            "data": [{
                "id": "llama-3.3-70b-versatile",
                "object": "model",
                "created": 1_733_447_754u64,
                "owned_by": "Meta",
                "active": true,
                "context_window": 131_072u64
            }]
        });
        let models = openai_compatible_models(&body);
        assert_eq!(models[0].context_window, Some(131_072));
    }

    /// Shape of `GET https://openrouter.ai/api/v1/models`: `context_length`
    /// plus a human name Elpis should prefer over the slug.
    #[test]
    fn openrouter_context_length_and_name_are_used() {
        let body = serde_json::json!({
            "data": [{
                "id": "anthropic/claude-sonnet-4.5",
                "name": "Anthropic: Claude Sonnet 4.5",
                "created": 1_758_000_000u64,
                "context_length": 200_000u64,
                "pricing": {"prompt": "0.000003", "completion": "0.000015"}
            }]
        });
        let models = openai_compatible_models(&body);
        assert_eq!(models[0].slug, "anthropic/claude-sonnet-4.5");
        assert_eq!(models[0].display_name, "Anthropic: Claude Sonnet 4.5");
        assert_eq!(models[0].context_window, Some(200_000));
    }

    /// OpenRouter says which parameters each model accepts. A model that takes
    /// `reasoning` gets the effort levels; one that does not is offered none,
    /// so the picker never shows a dial that changes nothing.
    #[test]
    fn reasoning_levels_follow_what_the_provider_says_the_model_accepts() {
        let body = serde_json::json!({
            "data": [
                {
                    "id": "deepseek/deepseek-v4.1-flash",
                    "context_length": 164_000u64,
                    "supported_parameters": ["tools", "reasoning", "include_reasoning"]
                },
                {
                    "id": "meta-llama/llama-3.3-70b-instruct",
                    "context_length": 131_072u64,
                    "supported_parameters": ["tools", "temperature"]
                },
                {
                    "id": "some/model-that-says-nothing",
                    "context_length": 8_192u64
                }
            ]
        });
        let models = openai_compatible_models(&body);

        assert_eq!(
            models[0]
                .supported_reasoning_levels
                .iter()
                .map(|preset| preset.effort.clone())
                .collect::<Vec<_>>(),
            vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High
            ]
        );
        assert_eq!(
            models[0].default_reasoning_level,
            Some(ReasoningEffort::Medium)
        );
        assert!(models[1].supported_reasoning_levels.is_empty());
        assert!(models[1].default_reasoning_level.is_none());
        assert!(models[2].supported_reasoning_levels.is_empty());
    }

    /// Together returns the rows as a bare array instead of `{"data": …}`.
    #[test]
    fn a_bare_array_of_models_is_read_like_a_data_envelope() {
        let body = serde_json::json!([
            {
                "id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "object": "model",
                "type": "chat",
                "display_name": "Llama 3.3 70B Instruct Turbo",
                "context_length": 131_072u64
            },
            {"id": "BAAI/bge-large-en-v1.5", "object": "model", "type": "embedding"}
        ]);
        let models = openai_compatible_models(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].display_name, "Llama 3.3 70B Instruct Turbo");
        assert_eq!(models[0].context_window, Some(131_072));
        assert_eq!(models[1].context_window, None);
    }

    /// Mistral names the same field `max_context_length`.
    #[test]
    fn mistral_max_context_length_is_read_as_the_window() {
        let body = serde_json::json!({
            "object": "list",
            "data": [{
                "id": "mistral-large-latest",
                "object": "model",
                "owned_by": "mistralai",
                "max_context_length": 131_072u64
            }]
        });
        let models = openai_compatible_models(&body);
        assert_eq!(models[0].context_window, Some(131_072));
    }

    /// A rejected key answers with an error object, which must list nothing
    /// rather than fall back to a written-down model.
    #[test]
    fn a_chat_provider_error_body_lists_nothing() {
        let body = serde_json::json!({
            "error": {"message": "Invalid API key", "type": "invalid_request_error", "code": 401}
        });
        assert!(openai_compatible_models(&body).is_empty());
        assert!(openai_compatible_models(&serde_json::json!({"data": "nope"})).is_empty());
        assert!(openai_compatible_models(&serde_json::json!([{"object": "model"}])).is_empty());
    }

    /// A zero window is a provider saying nothing, not a zero-token model.
    #[test]
    fn a_zero_context_window_stays_unknown() {
        let body = serde_json::json!({"data": [{"id": "some-model", "context_length": 0}]});
        assert_eq!(openai_compatible_models(&body)[0].context_window, None);
    }
}

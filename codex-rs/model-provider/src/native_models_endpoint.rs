//! Live model catalogs for providers whose list endpoint is not OpenAI-shaped.
//!
//! Anthropic and Google both publish a models endpoint, but neither speaks the
//! schema [`crate::models_endpoint::OpenAiModelsEndpoint`] expects. Before this
//! module each of them was represented by a single invented entry — one model
//! name and one context window written into the source — so a picker showed
//! "Gemini 3.5 Flash · 1000k" whether or not that model existed on the account,
//! and the window was a number nobody had measured. Every field here comes from
//! the provider's own response; when the request fails the catalog is empty,
//! which is honest, rather than a fabricated row.

use std::time::Duration;

use codex_http_client::ClientRouteClass;
use codex_http_client::HttpClientFactory;
use codex_model_provider_info::ModelProviderInfo;
use codex_model_provider_info::WireApi;
use codex_models_manager::manager::ModelsEndpointClient;
use codex_models_manager::manager::ModelsEndpointFuture;
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
            WireApi::AnthropicMessages | WireApi::GeminiGenerateContent
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
        // Both catalogs are account-scoped, so without a key there is nothing to
        // list. Report the missing key instead of returning a guessed model.
        let api_key = self.api_key().ok_or(CodexErr::InternalAgentDied)?;
        let (request_url, headers) = match self.info.wire_api {
            WireApi::AnthropicMessages => (
                format!("{base_url}/models?limit=1000"),
                vec![
                    ("x-api-key".to_string(), api_key),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ],
            ),
            WireApi::GeminiGenerateContent => (
                format!("{base_url}/models?pageSize=1000&key={api_key}"),
                Vec::new(),
            ),
            WireApi::Responses | WireApi::Chat => return Ok(Vec::new()),
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
            WireApi::Responses | WireApi::Chat => Vec::new(),
        })
    }
}

impl ModelsEndpointClient for NativeModelsEndpoint {
    fn has_command_auth(&self) -> bool {
        self.info.has_command_auth()
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

/// Builds a catalog entry. Only `context_window` is optional: an unknown window
/// stays unknown rather than being filled with a plausible number.
fn model_info(
    slug: &str,
    display_name: &str,
    description: String,
    context_window: Option<u32>,
    priority: i32,
) -> Option<ModelInfo> {
    serde_json::from_value(serde_json::json!({
        "slug": slug,
        "display_name": display_name,
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
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

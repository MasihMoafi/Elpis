// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Registry of model providers supported by Codex.
//!
//! Providers can be defined in two places:
//!   1. Built-in defaults compiled into the binary so Codex works out-of-the-box.
//!   2. User-defined entries inside `~/.codex/config.toml` under the `model_providers`
//!      key. These override or extend the defaults at runtime.

use codex_api::Provider as ApiProvider;
use codex_api::RetryConfig as ApiRetryConfig;
use codex_api::is_azure_responses_provider;
use codex_protocol::auth::AuthMode;
use codex_protocol::config_types::ModelProviderAuthInfo;
use codex_protocol::error::CodexErr;
use codex_protocol::error::EnvVarError;
use codex_protocol::error::Result as CodexResult;
use http::HeaderMap;
use http::header::HeaderName;
use http::header::HeaderValue;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS: u64 = 300_000;
const DEFAULT_STREAM_MAX_RETRIES: u64 = 5;
const DEFAULT_REQUEST_MAX_RETRIES: u64 = 4;
pub const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS: u64 = 15_000;
/// Hard cap for user-configured `stream_max_retries`.
const MAX_STREAM_MAX_RETRIES: u64 = 100;
/// Hard cap for user-configured `request_max_retries`.
const MAX_REQUEST_MAX_RETRIES: u64 = 100;

const OPENAI_PROVIDER_NAME: &str = "OpenAI";
const OPENAI_ACTOR_AUTHORIZATION_HEADER: &str = "x-openai-actor-authorization";
pub const OPENAI_PROVIDER_ID: &str = "openai";
pub const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const OPENROUTER_PROVIDER_NAME: &str = "OpenRouter";
pub const OPENROUTER_PROVIDER_ID: &str = "openrouter";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const OPENROUTER_CLAUDE_COMPAT_ALIAS: &str = "claude";
pub const OPENROUTER_CLAUDE_COMPAT_MODEL: &str = "~anthropic/claude-sonnet-latest";
pub const OPENROUTER_GEMINI_COMPAT_ALIAS: &str = "gemini";
pub const OPENROUTER_GEMINI_COMPAT_MODEL: &str = "~google/gemini-pro-latest";
pub const OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS: &str = "gemini-flash";
pub const OPENROUTER_GEMINI_FLASH_COMPAT_MODEL: &str = "~google/gemini-flash-latest";

/// Free-tier OpenRouter models Elpis surfaces directly in the `/model` picker's OPENROUTER
/// group and rotates through as a single fallback group (Masih, 2026-07-21): if a request
/// to one of these fails for any reason, retry the identical request against the next
/// model in the list, in order, before giving up. Single source of truth for both the
/// picker (`codex-model-provider`'s `native_model_catalog`) and the turn-loop retry
/// (`codex-core`'s `stream_with_openrouter_fallback`) -- change the group here only.
/// OpenRouter's free auto-router. It is not a model: OpenRouter dispatches each request to
/// whichever open-weight model is free at that moment, so pinning individual free slugs here
/// only goes stale as their catalog rotates. One entry, and OpenRouter does the choosing.
pub const OPENROUTER_FREE_MODEL_SLUG: &str = "openrouter/free";

pub const OPENROUTER_FREE_MODEL_GROUP: &[&str] = &[OPENROUTER_FREE_MODEL_SLUG];

/// Returns the other members of `slug`'s fallback group, in retry order. Empty if `slug`
/// isn't part of `OPENROUTER_FREE_MODEL_GROUP` (the common case for every other model).
pub fn openrouter_free_fallback_candidates(slug: &str) -> Vec<&'static str> {
    let Some(position) = OPENROUTER_FREE_MODEL_GROUP
        .iter()
        .position(|candidate| *candidate == slug)
    else {
        return Vec::new();
    };
    OPENROUTER_FREE_MODEL_GROUP
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != position)
        .map(|(_, candidate)| *candidate)
        .collect()
}

#[cfg(test)]
mod openrouter_free_fallback_tests {
    use super::*;

    #[test]
    fn auto_router_has_no_siblings_to_fall_back_to() {
        // OpenRouter already picks a working free model per request, so there is nothing
        // for the turn loop to retry against.
        assert!(openrouter_free_fallback_candidates(OPENROUTER_FREE_MODEL_SLUG).is_empty());
    }

    #[test]
    fn empty_for_unrelated_model() {
        assert!(openrouter_free_fallback_candidates("gpt-5.6-sol").is_empty());
        assert!(openrouter_free_fallback_candidates("").is_empty());
    }
}

pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const ANTHROPIC_PROVIDER_NAME: &str = "Anthropic Claude";
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
pub const GOOGLE_GEMINI_PROVIDER_ID: &str = "google-gemini";
pub const GOOGLE_GEMINI_PROVIDER_NAME: &str = "Google Gemini";
pub const GOOGLE_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const GOOGLE_GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
pub const GOOGLE_GEMINI_DEFAULT_MODEL: &str = "gemini-3.5-flash";
const AMAZON_BEDROCK_PROVIDER_NAME: &str = "Amazon Bedrock";
pub const AMAZON_BEDROCK_PROVIDER_ID: &str = "amazon-bedrock";
pub const AMAZON_BEDROCK_GPT_5_5_MODEL_ID: &str = "openai.gpt-5.5";
pub const AMAZON_BEDROCK_GPT_5_4_MODEL_ID: &str = "openai.gpt-5.4";
pub const AMAZON_BEDROCK_GPT_5_6_SOL_MODEL_ID: &str = "openai.gpt-5.6-sol";
pub const AMAZON_BEDROCK_GPT_5_6_TERRA_MODEL_ID: &str = "openai.gpt-5.6-terra";
pub const AMAZON_BEDROCK_GPT_5_6_LUNA_MODEL_ID: &str = "openai.gpt-5.6-luna";
pub const AMAZON_BEDROCK_DEFAULT_BASE_URL: &str =
    "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
const AMAZON_BEDROCK_MANTLE_CLIENT_AGENT_HEADER: &str = "x-amzn-mantle-client-agent";
const AMAZON_BEDROCK_MANTLE_CLIENT_AGENT_VALUE: &str = "codex";
pub const LEGACY_OLLAMA_CHAT_PROVIDER_ID: &str = "ollama-chat";
pub const OLLAMA_CHAT_PROVIDER_REMOVED_ERROR: &str = "`ollama-chat` is no longer supported.\nHow to fix: replace `ollama-chat` with `ollama` in `model_provider`, `oss_provider`, or `--local-provider`.\nMore info: https://github.com/openai/codex/discussions/7782";

/// Wire protocol that the provider speaks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
    /// Anthropic's native Messages API at `/v1/messages`.
    AnthropicMessages,
    /// Google's native Gemini `streamGenerateContent` API.
    GeminiGenerateContent,
    /// Standard OpenAI Chat Completions API at `/v1/chat/completions`.
    Chat,
}

impl fmt::Display for WireApi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Responses => "responses",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
            Self::Chat => "chat",
        };
        f.write_str(value)
    }
}

impl<'de> Deserialize<'de> for WireApi {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "responses" => Ok(Self::Responses),
            "anthropic_messages" => Ok(Self::AnthropicMessages),
            "gemini_generate_content" => Ok(Self::GeminiGenerateContent),
            "chat" | "chat_completions" => Ok(Self::Chat),
            _ => Err(serde::de::Error::unknown_variant(
                &value,
                &[
                    "responses",
                    "anthropic_messages",
                    "gemini_generate_content",
                    "chat",
                ],
            )),
        }
    }
}

/// Serializable representation of a provider definition.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ModelProviderInfo {
    /// Friendly display name.
    #[serde(default)]
    pub name: String,
    /// Base URL for the provider API selected by `wire_api`.
    pub base_url: Option<String>,
    /// Environment variable that stores the user's API key for this provider.
    pub env_key: Option<String>,

    /// Optional instructions to help the user get a valid value for the
    /// variable and set it.
    pub env_key_instructions: Option<String>,
    /// Value to use with `Authorization: Bearer <token>` header. Use of this
    /// config is discouraged in favor of `env_key` for security reasons, but
    /// this may be necessary when using this programmatically.
    pub experimental_bearer_token: Option<String>,
    /// Command-backed bearer-token configuration for this provider.
    pub auth: Option<ModelProviderAuthInfo>,
    /// AWS SigV4 auth configuration for this provider.
    pub aws: Option<ModelProviderAwsAuthInfo>,
    /// Which wire protocol this provider expects.
    #[serde(default)]
    pub wire_api: WireApi,
    /// Optional query parameters to append to the base URL.
    pub query_params: Option<HashMap<String, String>>,
    /// Additional HTTP headers to include in requests to this provider where
    /// the (key, value) pairs are the header name and value.
    pub http_headers: Option<HashMap<String, String>>,
    /// Optional HTTP headers to include in requests to this provider where the
    /// (key, value) pairs are the header name and _environment variable_ whose
    /// value should be used. If the environment variable is not set, or the
    /// value is empty, the header will not be included in the request.
    pub env_http_headers: Option<HashMap<String, String>>,
    /// Maximum number of times to retry a failed HTTP request to this provider.
    pub request_max_retries: Option<u64>,
    /// Number of times to retry reconnecting a dropped streaming response before failing.
    pub stream_max_retries: Option<u64>,
    /// Idle timeout (in milliseconds) to wait for activity on a streaming response before treating
    /// the connection as lost.
    pub stream_idle_timeout_ms: Option<u64>,
    /// Maximum time (in milliseconds) to wait for a websocket connection attempt before treating
    /// it as failed.
    pub websocket_connect_timeout_ms: Option<u64>,
    /// Does this provider require an OpenAI API Key or ChatGPT login token? If true,
    /// user is presented with login screen on first run, and login preference and token/key
    /// are stored in auth.json. If false (which is the default), login screen is skipped,
    /// and API key (if needed) comes from the "env_key" environment variable.
    #[serde(default)]
    pub requires_openai_auth: bool,
    /// Whether this provider supports the Responses API WebSocket transport.
    #[serde(default)]
    pub supports_websockets: bool,
}

/// AWS SigV4 auth configuration for a model provider.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct ModelProviderAwsAuthInfo {
    /// AWS profile name to use. When unset, the AWS SDK default chain decides.
    pub profile: Option<String>,
    /// AWS region to use for provider-specific endpoints.
    pub region: Option<String>,
}

/// Stable metadata for a built-in inference route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderMetadata {
    pub provider_id: &'static str,
    pub display_name: &'static str,
    pub api_base_url: &'static str,
    pub environment_variable: Option<&'static str>,
    pub wire_protocol: WireApi,
    pub default_model: &'static str,
}

/// Returns truthful metadata for built-in hosted providers.
pub fn provider_metadata(provider_id: &str) -> Option<ProviderMetadata> {
    match provider_id {
        OPENAI_PROVIDER_ID => Some(ProviderMetadata {
            provider_id: OPENAI_PROVIDER_ID,
            display_name: OPENAI_PROVIDER_NAME,
            api_base_url: "https://api.openai.com/v1",
            environment_variable: Some("OPENAI_API_KEY"),
            wire_protocol: WireApi::Responses,
            default_model: "gpt-5.4",
        }),
        OPENROUTER_PROVIDER_ID => Some(ProviderMetadata {
            provider_id: OPENROUTER_PROVIDER_ID,
            display_name: OPENROUTER_PROVIDER_NAME,
            api_base_url: OPENROUTER_BASE_URL,
            environment_variable: Some("OPENROUTER_API_KEY"),
            wire_protocol: WireApi::Chat,
            default_model: "openai/gpt-5.4",
        }),
        ANTHROPIC_PROVIDER_ID => Some(ProviderMetadata {
            provider_id: ANTHROPIC_PROVIDER_ID,
            display_name: ANTHROPIC_PROVIDER_NAME,
            api_base_url: ANTHROPIC_BASE_URL,
            environment_variable: Some(ANTHROPIC_API_KEY_ENV),
            wire_protocol: WireApi::AnthropicMessages,
            default_model: ANTHROPIC_DEFAULT_MODEL,
        }),
        GOOGLE_GEMINI_PROVIDER_ID => Some(ProviderMetadata {
            provider_id: GOOGLE_GEMINI_PROVIDER_ID,
            display_name: GOOGLE_GEMINI_PROVIDER_NAME,
            api_base_url: GOOGLE_GEMINI_BASE_URL,
            environment_variable: Some(GOOGLE_GEMINI_API_KEY_ENV),
            wire_protocol: WireApi::GeminiGenerateContent,
            default_model: GOOGLE_GEMINI_DEFAULT_MODEL,
        }),
        _ => None,
    }
}

/// Metadata for launcher aliases that deliberately route a vendor model through OpenRouter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompatibilityRouteMetadata {
    pub alias: &'static str,
    pub display_name: &'static str,
    pub provider_id: &'static str,
    pub model: &'static str,
}

pub fn compatibility_route_metadata(alias: &str) -> Option<CompatibilityRouteMetadata> {
    match alias {
        OPENROUTER_CLAUDE_COMPAT_ALIAS => Some(CompatibilityRouteMetadata {
            alias: OPENROUTER_CLAUDE_COMPAT_ALIAS,
            display_name: "Claude via OpenRouter (compatibility)",
            provider_id: OPENROUTER_PROVIDER_ID,
            model: OPENROUTER_CLAUDE_COMPAT_MODEL,
        }),
        OPENROUTER_GEMINI_COMPAT_ALIAS => Some(CompatibilityRouteMetadata {
            alias: OPENROUTER_GEMINI_COMPAT_ALIAS,
            display_name: "Gemini Pro via OpenRouter (compatibility)",
            provider_id: OPENROUTER_PROVIDER_ID,
            model: OPENROUTER_GEMINI_COMPAT_MODEL,
        }),
        OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS => Some(CompatibilityRouteMetadata {
            alias: OPENROUTER_GEMINI_FLASH_COMPAT_ALIAS,
            display_name: "Gemini Flash via OpenRouter (compatibility)",
            provider_id: OPENROUTER_PROVIDER_ID,
            model: OPENROUTER_GEMINI_FLASH_COMPAT_MODEL,
        }),
        _ => None,
    }
}

impl ModelProviderInfo {
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.aws.is_some() {
            if self.supports_websockets {
                // TODO(celia-oai): Support AWS SigV4 signing for WebSocket
                // upgrade requests before allowing AWS-authenticated providers
                // to enable Responses-over-WebSocket.
                return Err("provider aws cannot be combined with supports_websockets".to_string());
            }

            let mut conflicts = Vec::new();
            if self.env_key.is_some() {
                conflicts.push("env_key");
            }
            if self.experimental_bearer_token.is_some() {
                conflicts.push("experimental_bearer_token");
            }
            if self.auth.is_some() {
                conflicts.push("auth");
            }
            if self.requires_openai_auth {
                conflicts.push("requires_openai_auth");
            }

            if !conflicts.is_empty() {
                return Err(format!(
                    "provider aws cannot be combined with {}",
                    conflicts.join(", ")
                ));
            }
        }

        let Some(auth) = self.auth.as_ref() else {
            return Ok(());
        };

        if auth.command.trim().is_empty() {
            return Err("provider auth.command must not be empty".to_string());
        }

        let mut conflicts = Vec::new();
        if self.env_key.is_some() {
            conflicts.push("env_key");
        }
        if self.experimental_bearer_token.is_some() {
            conflicts.push("experimental_bearer_token");
        }
        if self.requires_openai_auth {
            conflicts.push("requires_openai_auth");
        }

        if conflicts.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "provider auth cannot be combined with {}",
                conflicts.join(", ")
            ))
        }
    }

    fn build_header_map(&self) -> CodexResult<HeaderMap> {
        let capacity = self.http_headers.as_ref().map_or(0, HashMap::len)
            + self.env_http_headers.as_ref().map_or(0, HashMap::len);
        let mut headers = HeaderMap::with_capacity(capacity);
        if let Some(extra) = &self.http_headers {
            for (k, v) in extra {
                if let (Ok(name), Ok(value)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
                    headers.insert(name, value);
                }
            }
        }

        if let Some(env_headers) = &self.env_http_headers {
            for (header, env_var) in env_headers {
                if let Ok(val) = std::env::var(env_var)
                    && !val.trim().is_empty()
                    && let (Ok(name), Ok(value)) =
                        (HeaderName::try_from(header), HeaderValue::try_from(val))
                {
                    headers.insert(name, value);
                }
            }
        }

        Ok(headers)
    }

    pub fn to_api_provider(&self, auth_mode: Option<AuthMode>) -> CodexResult<ApiProvider> {
        let default_base_url = if matches!(
            auth_mode,
            Some(
                AuthMode::Chatgpt
                    | AuthMode::ChatgptAuthTokens
                    | AuthMode::Headers
                    | AuthMode::AgentIdentity
                    | AuthMode::PersonalAccessToken
            )
        ) {
            CHATGPT_CODEX_BASE_URL
        } else {
            "https://api.openai.com/v1"
        };
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| default_base_url.to_string());

        let headers = self.build_header_map()?;
        let retry = ApiRetryConfig {
            max_attempts: self.request_max_retries(),
            base_delay: Duration::from_millis(200),
            retry_429: false,
            retry_5xx: true,
            retry_transport: true,
        };

        Ok(ApiProvider {
            name: self.name.clone(),
            base_url,
            query_params: self.query_params.clone(),
            headers,
            retry,
            stream_idle_timeout: self.stream_idle_timeout(),
        })
    }

    /// If `env_key` is Some, returns the API key for this provider if present
    /// (and non-empty) in the environment. If `env_key` is required but
    /// cannot be found, returns an error.
    pub fn api_key(&self) -> CodexResult<Option<String>> {
        match &self.env_key {
            Some(env_key) => {
                let val = std::env::var(env_key).ok().filter(|v| !v.trim().is_empty());
                if val.is_none() && self.requires_openai_auth {
                    return Err(CodexErr::EnvVar(EnvVarError {
                        var: env_key.clone(),
                        instructions: self.env_key_instructions.clone(),
                    }));
                }
                Ok(val)
            }
            None => Ok(None),
        }
    }

    /// Effective maximum number of request retries for this provider.
    pub fn request_max_retries(&self) -> u64 {
        self.request_max_retries
            .unwrap_or(DEFAULT_REQUEST_MAX_RETRIES)
            .min(MAX_REQUEST_MAX_RETRIES)
    }

    /// Effective maximum number of stream reconnection attempts for this provider.
    pub fn stream_max_retries(&self) -> u64 {
        self.stream_max_retries
            .unwrap_or(DEFAULT_STREAM_MAX_RETRIES)
            .min(MAX_STREAM_MAX_RETRIES)
    }

    /// Effective idle timeout for streaming responses.
    pub fn stream_idle_timeout(&self) -> Duration {
        self.stream_idle_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_millis(DEFAULT_STREAM_IDLE_TIMEOUT_MS))
    }

    /// Effective timeout for websocket connect attempts.
    pub fn websocket_connect_timeout(&self) -> Duration {
        self.websocket_connect_timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_millis(DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS))
    }

    pub fn create_openai_provider(base_url: Option<String>) -> ModelProviderInfo {
        ModelProviderInfo {
            name: OPENAI_PROVIDER_NAME.into(),
            base_url,
            env_key: None,
            env_key_instructions: None,
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::Responses,
            query_params: None,
            http_headers: Some(
                [("version".to_string(), env!("CARGO_PKG_VERSION").to_string())]
                    .into_iter()
                    .collect(),
            ),
            env_http_headers: Some(
                [
                    (
                        "OpenAI-Organization".to_string(),
                        "OPENAI_ORGANIZATION".to_string(),
                    ),
                    ("OpenAI-Project".to_string(), "OPENAI_PROJECT".to_string()),
                ]
                .into_iter()
                .collect(),
            ),
            // Use global defaults for retry/timeout unless overridden in config.toml.
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: true,
            supports_websockets: true,
        }
    }

    pub fn create_openrouter_provider() -> ModelProviderInfo {
        ModelProviderInfo {
            name: OPENROUTER_PROVIDER_NAME.into(),
            base_url: Some(OPENROUTER_BASE_URL.into()),
            env_key: Some("OPENROUTER_API_KEY".into()),
            env_key_instructions: Some(
                "Set OPENROUTER_API_KEY to an OpenRouter API key before launching Elpis.".into(),
            ),
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::Chat,
            query_params: None,
            http_headers: Some(HashMap::from([(
                "X-OpenRouter-Title".to_string(),
                "Elpis".to_string(),
            )])),
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: false,
        }
    }

    pub fn create_anthropic_provider() -> ModelProviderInfo {
        ModelProviderInfo {
            name: ANTHROPIC_PROVIDER_NAME.into(),
            base_url: Some(ANTHROPIC_BASE_URL.into()),
            env_key: Some(ANTHROPIC_API_KEY_ENV.into()),
            env_key_instructions: Some(
                "Set ANTHROPIC_API_KEY to an Anthropic API key before launching Elpis.".into(),
            ),
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::AnthropicMessages,
            query_params: None,
            http_headers: Some(HashMap::from([(
                "anthropic-version".to_string(),
                "2023-06-01".to_string(),
            )])),
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: false,
        }
    }

    pub fn create_google_gemini_provider() -> ModelProviderInfo {
        ModelProviderInfo {
            name: GOOGLE_GEMINI_PROVIDER_NAME.into(),
            base_url: Some(GOOGLE_GEMINI_BASE_URL.into()),
            env_key: Some(GOOGLE_GEMINI_API_KEY_ENV.into()),
            env_key_instructions: Some(
                "Set GEMINI_API_KEY to a Google AI Gemini API key before launching Elpis.".into(),
            ),
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::GeminiGenerateContent,
            query_params: None,
            http_headers: None,
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: false,
        }
    }

    pub fn create_amazon_bedrock_provider(
        aws: Option<ModelProviderAwsAuthInfo>,
    ) -> ModelProviderInfo {
        ModelProviderInfo {
            name: AMAZON_BEDROCK_PROVIDER_NAME.into(),
            base_url: Some(AMAZON_BEDROCK_DEFAULT_BASE_URL.into()),
            env_key: None,
            env_key_instructions: None,
            experimental_bearer_token: None,
            auth: None,
            aws: Some(aws.unwrap_or(ModelProviderAwsAuthInfo {
                profile: None,
                region: None,
            })),
            wire_api: WireApi::Responses,
            query_params: None,
            http_headers: Some(HashMap::from([(
                AMAZON_BEDROCK_MANTLE_CLIENT_AGENT_HEADER.to_string(),
                AMAZON_BEDROCK_MANTLE_CLIENT_AGENT_VALUE.to_string(),
            )])),
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: false,
        }
    }

    pub fn is_openai(&self) -> bool {
        self.name == OPENAI_PROVIDER_NAME
    }

    pub fn uses_openai_actor_authorization(&self) -> bool {
        !self.requires_openai_auth
            && self.http_headers.as_ref().is_some_and(|headers| {
                headers.iter().any(|(name, value)| {
                    name.eq_ignore_ascii_case(OPENAI_ACTOR_AUTHORIZATION_HEADER)
                        && !value.trim().is_empty()
                })
            })
    }

    pub fn is_amazon_bedrock(&self) -> bool {
        self.name == AMAZON_BEDROCK_PROVIDER_NAME
    }

    pub fn is_openrouter(&self) -> bool {
        self.name == OPENROUTER_PROVIDER_NAME
    }

    pub fn supports_remote_compaction(&self) -> bool {
        self.is_openai() || is_azure_responses_provider(&self.name, self.base_url.as_deref())
    }

    pub fn has_command_auth(&self) -> bool {
        self.auth.is_some()
    }
}

pub const DEFAULT_LMSTUDIO_PORT: u16 = 1234;
pub const DEFAULT_OLLAMA_PORT: u16 = 11434;

pub const LMSTUDIO_OSS_PROVIDER_ID: &str = "lmstudio";
pub const OLLAMA_OSS_PROVIDER_ID: &str = "ollama";

/// Human-readable names for the locally served providers. The runtime that serves the
/// models is what the user picked and what every surface should name -- `gpt-oss` is
/// one model family they may or may not be running, not the provider.
pub const LMSTUDIO_OSS_PROVIDER_NAME: &str = "LM Studio";
pub const OLLAMA_OSS_PROVIDER_NAME: &str = "Ollama";

/// Built-in default provider list.
pub fn built_in_model_providers(
    openai_base_url: Option<String>,
) -> HashMap<String, ModelProviderInfo> {
    use ModelProviderInfo as P;
    let openai_provider = P::create_openai_provider(openai_base_url);
    let openrouter_provider = P::create_openrouter_provider();
    let anthropic_provider = P::create_anthropic_provider();
    let google_gemini_provider = P::create_google_gemini_provider();
    let amazon_bedrock_provider = P::create_amazon_bedrock_provider(/*aws*/ None);

    // We do not want to be in the business of adjucating which third-party
    // providers are bundled with Codex CLI, so we only include the OpenAI and
    // open source ("oss") providers by default. Users are encouraged to add to
    // `model_providers` in config.toml to add their own providers.
    [
        (OPENAI_PROVIDER_ID, openai_provider),
        (OPENROUTER_PROVIDER_ID, openrouter_provider),
        (ANTHROPIC_PROVIDER_ID, anthropic_provider),
        (GOOGLE_GEMINI_PROVIDER_ID, google_gemini_provider),
        (AMAZON_BEDROCK_PROVIDER_ID, amazon_bedrock_provider),
        (
            OLLAMA_OSS_PROVIDER_ID,
            create_oss_provider(
                OLLAMA_OSS_PROVIDER_NAME,
                DEFAULT_OLLAMA_PORT,
                WireApi::Responses,
            ),
        ),
        (
            LMSTUDIO_OSS_PROVIDER_ID,
            create_oss_provider(
                LMSTUDIO_OSS_PROVIDER_NAME,
                DEFAULT_LMSTUDIO_PORT,
                WireApi::Responses,
            ),
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// Merge configured providers into the built-in provider catalog.
///
/// Configured providers extend the built-in set. Built-in providers are not
/// generally overridable, but the built-in Amazon Bedrock provider allows the
/// user to set `aws.profile` and `aws.region`.
pub fn merge_configured_model_providers(
    mut model_providers: HashMap<String, ModelProviderInfo>,
    configured_model_providers: HashMap<String, ModelProviderInfo>,
) -> Result<HashMap<String, ModelProviderInfo>, String> {
    for (key, mut provider) in configured_model_providers {
        if key == AMAZON_BEDROCK_PROVIDER_ID {
            let aws_override = provider.aws.take();
            if provider != ModelProviderInfo::default() {
                return Err(format!(
                    "model_providers.{AMAZON_BEDROCK_PROVIDER_ID} only supports changing \
`aws.profile` and `aws.region`; other non-default provider fields are not supported"
                ));
            }

            if let Some(aws_override) = aws_override
                && let Some(built_in_provider) = model_providers.get_mut(AMAZON_BEDROCK_PROVIDER_ID)
                && let Some(built_in_aws) = built_in_provider.aws.as_mut()
            {
                if let Some(profile) = aws_override.profile {
                    built_in_aws.profile = Some(profile);
                }
                if let Some(region) = aws_override.region {
                    built_in_aws.region = Some(region);
                }
            }
        } else {
            model_providers.entry(key).or_insert(provider);
        }
    }

    Ok(model_providers)
}

pub fn create_oss_provider(
    name: &str,
    default_provider_port: u16,
    wire_api: WireApi,
) -> ModelProviderInfo {
    // These CODEX_OSS_ environment variables are experimental: we may
    // switch to reading values from config.toml instead.
    let default_codex_oss_base_url = format!(
        "http://localhost:{codex_oss_port}/v1",
        codex_oss_port = std::env::var("CODEX_OSS_PORT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(default_provider_port)
    );

    let codex_oss_base_url = std::env::var("CODEX_OSS_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(default_codex_oss_base_url);
    create_oss_provider_with_base_url(name, &codex_oss_base_url, wire_api)
}

pub fn create_oss_provider_with_base_url(
    name: &str,
    base_url: &str,
    wire_api: WireApi,
) -> ModelProviderInfo {
    ModelProviderInfo {
        name: name.into(),
        base_url: Some(base_url.into()),
        env_key: None,
        env_key_instructions: None,
        experimental_bearer_token: None,
        auth: None,
        aws: None,
        wire_api,
        query_params: None,
        http_headers: None,
        env_http_headers: None,
        request_max_retries: None,
        stream_max_retries: None,
        stream_idle_timeout_ms: None,
        websocket_connect_timeout_ms: None,
        requires_openai_auth: false,
        supports_websockets: false,
    }
}

#[cfg(test)]
#[path = "model_provider_info_tests.rs"]
mod tests;

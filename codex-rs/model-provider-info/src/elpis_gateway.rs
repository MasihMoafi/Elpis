// Elpis: providers served through the in-process Elpis provider gateway.
//! Providers that do not speak the Responses API.
//!
//! Anthropic Messages, Gemini generateContent and OpenAI-compatible Chat
//! Completions reach their vendor through the Elpis gateway
//! (`codex-elpis-gateway`), a loopback server that accepts Responses requests
//! and translates them. To core such a provider is an ordinary
//! `wire_api = "responses"` provider whose base URL is the gateway; the
//! `x-elpis-*` headers below tell the gateway where each request really goes.
//!
//! The same routing serves the built-in providers (`anthropic`,
//! `google-gemini`, `openrouter`) and any configured provider that names one of
//! these protocols, as v0.3.0 configs did:
//!
//! ```toml
//! [model_providers.deepseek]
//! name = "DeepSeek"
//! base_url = "https://api.deepseek.com/v1"
//! env_key = "DEEPSEEK_API_KEY"
//! wire_api = "chat"
//! ```

use std::collections::HashMap;
use std::sync::PoisonError;
use std::sync::RwLock;

use codex_utils_redacted_string::RedactedString;
use serde::Deserialize;

use crate::ModelProviderInfo;
use crate::WireApi;

/// Per-process secret that proves a request came from this Elpis process.
pub const GATEWAY_TOKEN_HEADER: &str = "x-elpis-gateway-token";
/// Which vendor protocol the gateway translates to.
pub const GATEWAY_WIRE_HEADER: &str = "x-elpis-wire";
/// The vendor's API base URL, for example `https://api.anthropic.com/v1`.
pub const GATEWAY_UPSTREAM_HEADER: &str = "x-elpis-upstream";
/// The provider ID, which keys a key saved from the terminal.
pub const GATEWAY_PROVIDER_HEADER: &str = "x-elpis-provider";
/// The environment variable that holds the provider's API key.
pub const GATEWAY_ENV_KEY_HEADER: &str = "x-elpis-env-key";
/// A configured provider header travels under this prefix and is sent to the
/// vendor under its own name.
pub const GATEWAY_FORWARD_HEADER_PREFIX: &str = "x-elpis-fwd-";

/// Where gateway providers point before the gateway has started. `.invalid`
/// never resolves (RFC 2606), so a request fails at once and names the gateway,
/// instead of reaching some other server.
const UNSTARTED_GATEWAY_ORIGIN: &str = "http://elpis-gateway.invalid";

pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const ANTHROPIC_PROVIDER_NAME: &str = "Anthropic Claude";
pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1";
pub const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
pub const GOOGLE_GEMINI_PROVIDER_ID: &str = "google-gemini";
pub const GOOGLE_GEMINI_PROVIDER_NAME: &str = "Google Gemini";
pub const GOOGLE_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const GOOGLE_GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
pub const OPENROUTER_PROVIDER_ID: &str = "openrouter";
pub const OPENROUTER_PROVIDER_NAME: &str = "OpenRouter";
pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const OPENROUTER_API_KEY_ENV: &str = "OPENROUTER_API_KEY";

/// A vendor protocol the gateway translates Responses requests into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayWire {
    /// OpenAI-compatible Chat Completions at `{base_url}/chat/completions`.
    Chat,
    /// Anthropic Messages at `{base_url}/messages`.
    AnthropicMessages,
    /// Gemini `streamGenerateContent` at `{base_url}/models/{model}:streamGenerateContent`.
    GeminiGenerateContent,
}

impl GatewayWire {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
        }
    }

    /// Accepts the `wire_api` values v0.3.0 configs used for these protocols.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "chat" | "chat_completions" => Some(Self::Chat),
            "anthropic_messages" => Some(Self::AnthropicMessages),
            "gemini_generate_content" => Some(Self::GeminiGenerateContent),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Chat => "OpenAI-compatible Chat Completions",
            Self::AnthropicMessages => "Anthropic Messages",
            Self::GeminiGenerateContent => "Gemini generateContent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GatewayAddress {
    origin: String,
    token: String,
}

static GATEWAY_ADDRESS: RwLock<Option<GatewayAddress>> = RwLock::new(None);

/// Records where this process's gateway listens. Call it before the config is
/// loaded: providers read the address when they are built.
pub fn set_elpis_gateway_address(origin: String, token: String) {
    *GATEWAY_ADDRESS
        .write()
        .unwrap_or_else(PoisonError::into_inner) = Some(GatewayAddress { origin, token });
}

fn gateway_address() -> GatewayAddress {
    GATEWAY_ADDRESS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_else(|| GatewayAddress {
            origin: UNSTARTED_GATEWAY_ORIGIN.to_string(),
            token: String::new(),
        })
}

/// Where a gateway provider's requests really go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayRoute {
    pub provider_id: String,
    pub wire: GatewayWire,
    pub upstream_base_url: String,
    pub env_key: Option<String>,
}

/// Returns the route of a provider served through the gateway, or `None` for a
/// provider core reaches directly.
pub fn gateway_route(provider: &ModelProviderInfo) -> Option<GatewayRoute> {
    let headers = provider.http_headers.as_ref()?;
    let get = |name: &str| headers.get(name).map(|value| value.as_str().to_string());
    Some(GatewayRoute {
        provider_id: get(GATEWAY_PROVIDER_HEADER)?,
        wire: GatewayWire::parse(&get(GATEWAY_WIRE_HEADER)?)?,
        upstream_base_url: get(GATEWAY_UPSTREAM_HEADER)?,
        env_key: get(GATEWAY_ENV_KEY_HEADER),
    })
}

/// The name a configured header travels under between core and the gateway.
pub fn forwarded_header_name(name: &str) -> String {
    format!(
        "{GATEWAY_FORWARD_HEADER_PREFIX}{}",
        name.to_ascii_lowercase()
    )
}

/// Points a provider at the gateway.
///
/// `provider.base_url` is taken as the vendor's base URL and `env_key` as the
/// variable holding its key; both move into headers the gateway reads, so core
/// never sends the key itself and never fails on a missing variable. The key is
/// resolved by the gateway, which also finds a key saved from the terminal.
/// Configured headers are forwarded to the vendor. The provider never receives
/// the OpenAI login: `requires_openai_auth` is cleared.
pub fn route_through_gateway(
    provider_id: &str,
    wire: GatewayWire,
    provider: &mut ModelProviderInfo,
) -> Result<(), String> {
    let upstream = provider
        .base_url
        .take()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            format!(
                "model_providers.{provider_id}: wire_api = \"{}\" needs a base_url",
                wire.as_str()
            )
        })?;
    let address = gateway_address();
    let mut headers: HashMap<String, RedactedString> = provider
        .http_headers
        .take()
        .unwrap_or_default()
        .into_iter()
        .map(|(name, value)| (forwarded_header_name(&name), value))
        .collect();
    headers.insert(GATEWAY_TOKEN_HEADER.to_string(), address.token.into());
    headers.insert(GATEWAY_WIRE_HEADER.to_string(), wire.as_str().into());
    headers.insert(GATEWAY_UPSTREAM_HEADER.to_string(), upstream.into());
    headers.insert(GATEWAY_PROVIDER_HEADER.to_string(), provider_id.into());
    if let Some(env_key) = provider.env_key.take() {
        headers.insert(GATEWAY_ENV_KEY_HEADER.to_string(), env_key.into());
    }
    provider.http_headers = Some(headers);
    provider.env_http_headers = provider.env_http_headers.take().map(|headers| {
        headers
            .into_iter()
            .map(|(name, variable)| (forwarded_header_name(&name), variable))
            .collect()
    });
    provider.base_url = Some(format!("{}/v1", address.origin));
    provider.wire_api = WireApi::Responses;
    provider.requires_openai_auth = false;
    provider.supports_websockets = false;
    Ok(())
}

struct BuiltInGatewayProvider {
    id: &'static str,
    name: &'static str,
    wire: GatewayWire,
    base_url: &'static str,
    env_key: &'static str,
    headers: &'static [(&'static str, &'static str)],
}

const BUILT_IN_GATEWAY_PROVIDERS: [BuiltInGatewayProvider; 3] = [
    BuiltInGatewayProvider {
        id: ANTHROPIC_PROVIDER_ID,
        name: ANTHROPIC_PROVIDER_NAME,
        wire: GatewayWire::AnthropicMessages,
        base_url: ANTHROPIC_BASE_URL,
        env_key: ANTHROPIC_API_KEY_ENV,
        headers: &[],
    },
    BuiltInGatewayProvider {
        id: GOOGLE_GEMINI_PROVIDER_ID,
        name: GOOGLE_GEMINI_PROVIDER_NAME,
        wire: GatewayWire::GeminiGenerateContent,
        base_url: GOOGLE_GEMINI_BASE_URL,
        env_key: GOOGLE_GEMINI_API_KEY_ENV,
        headers: &[],
    },
    BuiltInGatewayProvider {
        id: OPENROUTER_PROVIDER_ID,
        name: OPENROUTER_PROVIDER_NAME,
        wire: GatewayWire::Chat,
        base_url: OPENROUTER_BASE_URL,
        env_key: OPENROUTER_API_KEY_ENV,
        headers: &[("X-OpenRouter-Title", "Elpis")],
    },
];

/// The built-in providers served through the gateway.
pub fn built_in_gateway_providers() -> Vec<(String, ModelProviderInfo)> {
    BUILT_IN_GATEWAY_PROVIDERS
        .iter()
        .filter_map(|built_in| {
            let mut provider = ModelProviderInfo {
                name: built_in.name.to_string(),
                base_url: Some(built_in.base_url.to_string()),
                env_key: Some(built_in.env_key.to_string()),
                http_headers: (!built_in.headers.is_empty()).then(|| {
                    built_in
                        .headers
                        .iter()
                        .map(|(name, value)| ((*name).to_string(), (*value).into()))
                        .collect()
                }),
                ..ModelProviderInfo::default()
            };
            route_through_gateway(built_in.id, built_in.wire, &mut provider).ok()?;
            Some((built_in.id.to_string(), provider))
        })
        .collect()
}

/// Deserializes the `model_providers` table, routing each provider whose
/// `wire_api` names a gateway protocol through the gateway.
///
/// Each provider is read through the caller's deserializer, so a wrapping
/// deserializer (the strict-config check) still sees keys Codex would ignore.
/// `WireApi` accepts a gateway protocol name only while this runs, and records it.
pub fn deserialize_configured_model_providers<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, ModelProviderInfo>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Providers;

    impl<'de> serde::de::Visitor<'de> for Providers {
        type Value = HashMap<String, ModelProviderInfo>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a table of model providers")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut providers = HashMap::new();
            while let Some(provider_id) = map.next_key::<String>()? {
                let (provider, wire) =
                    capture_gateway_wire(|| map.next_value::<ModelProviderInfo>());
                let mut provider = provider?;
                if let Some(wire) = wire {
                    route_through_gateway(&provider_id, wire, &mut provider).map_err(|error| {
                        serde::de::Error::custom(format!("model_providers.{provider_id}: {error}"))
                    })?;
                }
                providers.insert(provider_id, provider);
            }
            Ok(providers)
        }
    }

    deserializer.deserialize_map(Providers)
}

thread_local! {
    /// `Some` while a provider is being read: the gateway protocol its `wire_api` named, if any.
    static CAPTURED_GATEWAY_WIRE: std::cell::Cell<Option<Option<GatewayWire>>> =
        const { std::cell::Cell::new(None) };
}

fn capture_gateway_wire<T>(read: impl FnOnce() -> T) -> (T, Option<GatewayWire>) {
    let outer = CAPTURED_GATEWAY_WIRE.replace(Some(None));
    let value = read();
    let wire = CAPTURED_GATEWAY_WIRE.replace(outer).flatten();
    (value, wire)
}

/// Elpis seam for `WireApi`'s deserializer: while a configured provider is being read, a
/// gateway protocol name is recorded and read as `responses`. Anywhere else it stays an error.
pub(crate) fn accept_gateway_wire_name(value: &str) -> bool {
    let Some(wire) = GatewayWire::parse(value) else {
        return false;
    };
    CAPTURED_GATEWAY_WIRE.with(|captured| match captured.get() {
        Some(_) => {
            captured.set(Some(Some(wire)));
            true
        }
        None => false,
    })
}

#[cfg(test)]
#[path = "elpis_gateway_tests.rs"]
mod tests;

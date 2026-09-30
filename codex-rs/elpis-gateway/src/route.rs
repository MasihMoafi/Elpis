//! Where a gateway request goes, read from the `x-elpis-*` headers core sends.

use codex_model_provider_info::GATEWAY_ENV_KEY_HEADER;
use codex_model_provider_info::GATEWAY_FORWARD_HEADER_PREFIX;
use codex_model_provider_info::GATEWAY_PROVIDER_HEADER;
use codex_model_provider_info::GATEWAY_TOKEN_HEADER;
use codex_model_provider_info::GATEWAY_UPSTREAM_HEADER;
use codex_model_provider_info::GATEWAY_WIRE_HEADER;
use codex_model_provider_info::GatewayWire;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use http::header::AUTHORIZATION;

use crate::GatewayError;
use crate::catalog;

/// Anthropic's API version, sent unless the provider forwards its own.
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Route {
    pub(crate) provider_id: String,
    pub(crate) wire: GatewayWire,
    /// The vendor base URL, without a trailing slash.
    pub(crate) upstream: String,
    pub(crate) env_key: Option<String>,
    /// A bearer token core attached for this provider.
    pub(crate) bearer: Option<String>,
    /// Configured headers to send to the vendor under their own names.
    pub(crate) forwarded: HeaderMap,
}

impl Route {
    /// Reads the route. A request without this process's token is refused, so no other local
    /// program can spend the owner's keys through the gateway.
    pub(crate) fn from_headers(headers: &HeaderMap, token: &str) -> Result<Self, GatewayError> {
        let text = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        if token.is_empty() || text(GATEWAY_TOKEN_HEADER).as_deref() != Some(token) {
            return Err(GatewayError::forbidden(
                "this request did not come from the Elpis process that owns the gateway",
            ));
        }
        let missing = |name: &str| GatewayError::bad_request(format!("missing `{name}` header"));
        let wire_name = text(GATEWAY_WIRE_HEADER).ok_or_else(|| missing(GATEWAY_WIRE_HEADER))?;
        let wire = GatewayWire::parse(&wire_name).ok_or_else(|| {
            GatewayError::bad_request(format!("unknown provider protocol `{wire_name}`"))
        })?;
        let upstream = text(GATEWAY_UPSTREAM_HEADER)
            .ok_or_else(|| missing(GATEWAY_UPSTREAM_HEADER))?
            .trim_end_matches('/')
            .to_string();
        let provider_id =
            text(GATEWAY_PROVIDER_HEADER).ok_or_else(|| missing(GATEWAY_PROVIDER_HEADER))?;
        let bearer = headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut forwarded = HeaderMap::new();
        for (name, value) in headers {
            if let Some(original) = name.as_str().strip_prefix(GATEWAY_FORWARD_HEADER_PREFIX)
                && let Ok(original) = HeaderName::from_bytes(original.as_bytes())
            {
                forwarded.insert(original, value.clone());
            }
        }
        Ok(Self {
            provider_id,
            wire,
            upstream,
            env_key: text(GATEWAY_ENV_KEY_HEADER),
            bearer,
            forwarded,
        })
    }

    /// The vendor URL that streams one response.
    pub(crate) fn responses_url(&self, model: &str, query: Option<&str>) -> String {
        let path = match self.wire {
            GatewayWire::Chat => "chat/completions".to_string(),
            GatewayWire::AnthropicMessages => "messages".to_string(),
            GatewayWire::GeminiGenerateContent => format!(
                "models/{}:streamGenerateContent",
                model.strip_prefix("models/").unwrap_or(model)
            ),
        };
        let mut url = format!("{}/{path}", self.upstream);
        let mut params: Vec<&str> = query.into_iter().filter(|query| !query.is_empty()).collect();
        if self.wire == GatewayWire::GeminiGenerateContent {
            params.push("alt=sse");
        }
        if !params.is_empty() {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&params.join("&"));
        }
        url
    }

    /// The vendor URL that lists models.
    pub(crate) fn models_url(&self) -> String {
        format!("{}/{}", self.upstream, catalog::models_path(self.wire))
    }

    /// Headers that authenticate to the vendor. Anthropic takes `x-api-key`, Gemini
    /// `x-goog-api-key`, and Chat providers a bearer token; a Chat provider without a key (a
    /// local server) is called without one.
    pub(crate) fn vendor_headers(&self, key: Option<&str>) -> Result<HeaderMap, GatewayError> {
        let mut headers = self.forwarded.clone();
        let secret = |value: String| {
            HeaderValue::from_str(&value)
                .map(|mut value| {
                    value.set_sensitive(true);
                    value
                })
                .map_err(|_| {
                    GatewayError::forbidden(format!(
                        "the API key for provider `{}` is not a valid header value",
                        self.provider_id
                    ))
                })
        };
        match (self.wire, key) {
            (GatewayWire::Chat, Some(key)) => {
                headers.insert(AUTHORIZATION, secret(format!("Bearer {key}"))?);
            }
            (GatewayWire::Chat, None) => {}
            (GatewayWire::AnthropicMessages, Some(key)) => {
                headers.insert("x-api-key", secret(key.to_string())?);
                if !headers.contains_key("anthropic-version") {
                    headers.insert(
                        "anthropic-version",
                        HeaderValue::from_static(ANTHROPIC_VERSION),
                    );
                }
            }
            (GatewayWire::GeminiGenerateContent, Some(key)) => {
                headers.insert("x-goog-api-key", secret(key.to_string())?);
            }
            (GatewayWire::AnthropicMessages | GatewayWire::GeminiGenerateContent, None) => {
                return Err(self.missing_key());
            }
        }
        Ok(headers)
    }

    fn missing_key(&self) -> GatewayError {
        let hint = match &self.env_key {
            Some(env_key) => format!("set {env_key} or save a key for it"),
            None => "save a key for it".to_string(),
        };
        GatewayError::forbidden(format!(
            "no API key for provider `{}`: {hint}",
            self.provider_id
        ))
    }
}

#[cfg(test)]
#[path = "route_tests.rs"]
mod tests;

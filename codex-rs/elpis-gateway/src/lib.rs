//! Elpis provider gateway.
//!
//! Upstream Codex 0.159 speaks only the OpenAI Responses API. This crate serves that API on a
//! loopback port inside the Elpis process and translates each request into Anthropic Messages,
//! Gemini `streamGenerateContent` or OpenAI-compatible Chat Completions, then translates the
//! vendor's stream back into Responses events. Providers reach it through the routing in
//! `codex_model_provider_info` (`elpis_gateway.rs`); this crate owns the protocols, the keys and
//! the vendor model lists.
//!
//! Routes: `POST /v1/responses` (one streamed response) and `GET /v1/models` (the vendor's model
//! list as a Codex catalog). Every request must carry this process's token.

mod anthropic;
mod catalog;
mod chat;
mod conversation;
mod emitter;
mod gemini;
mod keys;
mod route;

use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::post;
use codex_model_provider_info::GatewayWire;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use http::HeaderMap;
use http::HeaderValue;
use http::StatusCode;
use http::Uri;
use http::header::ACCEPT;
use http::header::CACHE_CONTROL;
use http::header::CONTENT_TYPE;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub use keys::KeySource;
pub use keys::key_source;
pub use keys::provider_keys_path;
pub use keys::remove_provider_key;
pub use keys::save_provider_key;

use crate::conversation::Conversation;
use crate::emitter::Translation;
use crate::route::Route;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);
/// Same as core's default stream idle timeout: a vendor silent this long has gone away.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// A long session's request carries its whole history; axum's 2 MB default is too small.
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const STREAM_CHANNEL_CAPACITY: usize = 64;

/// A running gateway.
#[derive(Debug, Clone)]
pub struct GatewayHandle {
    origin: String,
    token: String,
}

impl GatewayHandle {
    /// `http://127.0.0.1:<port>`.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// The secret every request must carry in `x-elpis-gateway-token`.
    pub fn token(&self) -> &str {
        &self.token
    }
}

#[derive(Clone)]
struct GatewayState {
    token: Arc<str>,
    home: Arc<PathBuf>,
    /// Honors proxy variables: vendors are reached the way the owner's network requires.
    client: reqwest::Client,
    /// Never proxied, for a vendor on this machine (a local server, a test fixture).
    direct: reqwest::Client,
}

impl GatewayState {
    fn client_for(&self, url: &str) -> &reqwest::Client {
        let loopback = reqwest::Url::parse(url).ok().is_some_and(|url| {
            matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
        });
        if loopback {
            &self.direct
        } else {
            &self.client
        }
    }
}

/// Starts a gateway on an ephemeral loopback port. It serves until the runtime shuts down.
/// `home` is the Elpis home that holds saved provider keys.
pub async fn start(home: PathBuf) -> std::io::Result<GatewayHandle> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(std::io::Error::other)?;
    let direct = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(std::io::Error::other)?;
    let state = GatewayState {
        token: Arc::from(token.as_str()),
        home: Arc::new(home),
        client,
        direct,
    };
    let router = Router::new()
        .route("/v1/responses", post(responses))
        .route("/v1/models", get(models))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!("the Elpis provider gateway stopped: {error}");
        }
    });
    Ok(GatewayHandle { origin, token })
}

/// Starts this process's gateway and points every gateway provider at it. Call it before the
/// config is loaded.
pub async fn start_for_process(home: &Path) -> std::io::Result<GatewayHandle> {
    let handle = start(home.to_path_buf()).await?;
    codex_model_provider_info::set_elpis_gateway_address(
        handle.origin.clone(),
        handle.token.clone(),
    );
    Ok(handle)
}

/// Proxy variables that send plain HTTP through a proxy.
const PROXY_VARIABLES: [&str; 6] = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "localhost"];

/// The `NO_PROXY` value that keeps core's requests to the gateway off an HTTP proxy, or `None`
/// when nothing needs to change. Core's HTTP client applies proxy variables to loopback
/// addresses too, so with `HTTP_PROXY` set a request to `127.0.0.1` would reach the proxy, which
/// may send it somewhere the gateway is not. Vendor requests still use the proxy.
pub fn no_proxy_with_loopback(env: impl Fn(&str) -> Option<String>) -> Option<String> {
    let proxied = PROXY_VARIABLES
        .iter()
        .any(|&name| env(name).is_some_and(|value| !value.trim().is_empty()));
    if !proxied {
        return None;
    }
    let current = env("NO_PROXY").or_else(|| env("no_proxy")).unwrap_or_default();
    let entries: Vec<&str> = current
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.contains(&"*") {
        return None;
    }
    let missing: Vec<&str> = LOOPBACK_HOSTS
        .iter()
        .copied()
        .filter(|host| !entries.contains(host))
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(entries.into_iter().chain(missing).collect::<Vec<_>>().join(","))
}

/// A request the gateway refuses or a vendor rejected, answered as a JSON error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GatewayError {
    status: StatusCode,
    code: Option<&'static str>,
    message: String,
}

impl GatewayError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code: None,
            message: message.into(),
        }
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    /// Refused credentials. Never 401: core answers a 401 by refreshing the OpenAI login.
    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }

    /// Maps a vendor's error response. Statuses pass through so core's retry and rate-limit
    /// handling applies, except 401 (see [`Self::forbidden`]) and Anthropic's 529 overload.
    fn from_vendor(status: StatusCode, body: &str, provider_id: &str) -> Self {
        let parsed = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
        let detail = vendor_error_message(&parsed, body);
        let message = format!("provider `{provider_id}` returned {status}: {detail}");
        match status.as_u16() {
            401 => Self::forbidden(message),
            529 => Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: Some("server_is_overloaded"),
                message,
            },
            _ => Self::new(status, message),
        }
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        tracing::warn!(status = %self.status, "Elpis gateway: {}", self.message);
        let body = json!({
            "error": {
                "message": self.message,
                "type": "elpis_gateway_error",
                "code": self.code,
            }
        });
        (
            self.status,
            [(CONTENT_TYPE, "application/json")],
            body.to_string(),
        )
            .into_response()
    }
}

/// The readable message in a vendor error body: `error.message` (OpenAI, Anthropic, Gemini),
/// a top-level `message`, or Gemini's array form. Falls back to `fallback`.
pub(crate) fn vendor_error_message(body: &Value, fallback: &str) -> String {
    ["/error/message", "/message", "/0/error/message"]
        .iter()
        .find_map(|pointer| body.pointer(pointer).and_then(Value::as_str))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

async fn responses(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    match serve_responses(&state, &headers, uri.query(), &body).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

async fn serve_responses(
    state: &GatewayState,
    headers: &HeaderMap,
    query: Option<&str>,
    body: &[u8],
) -> Result<Response, GatewayError> {
    let route = Route::from_headers(headers, &state.token)?;
    let request: Value = serde_json::from_slice(body)
        .map_err(|error| GatewayError::bad_request(format!("the request is not JSON: {error}")))?;
    let conversation = Conversation::from_request(&request)?;
    let vendor_body = match route.wire {
        GatewayWire::Chat => chat::request(&conversation),
        GatewayWire::AnthropicMessages => anthropic::request(&conversation)?,
        GatewayWire::GeminiGenerateContent => gemini::request(&conversation)?,
    };
    let key = keys::resolve(&state.home, &route, |name| std::env::var(name).ok());
    let mut vendor_headers = route.vendor_headers(key.as_deref())?;
    vendor_headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    let url = route.responses_url(&conversation.model, query);
    tracing::debug!(provider = %route.provider_id, wire = route.wire.as_str(), "Elpis gateway request");
    let response = state
        .client_for(&url)
        .post(&url)
        .headers(vendor_headers)
        .json(&vendor_body)
        .send()
        .await
        .map_err(|error| {
            GatewayError::bad_gateway(format!(
                "could not reach provider `{}`: {error}",
                route.provider_id
            ))
        })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(GatewayError::from_vendor(status, &text, &route.provider_id));
    }
    Ok(stream_response(
        response,
        Translation::new(route.wire, conversation.tool_map),
    ))
}

/// Translates the vendor's SSE stream as it arrives. A client that goes away stops the read.
fn stream_response(response: reqwest::Response, mut translation: Translation) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(STREAM_CHANNEL_CAPACITY);
    tokio::spawn(async move {
        let mut events = Box::pin(response.bytes_stream().eventsource());
        if !send_events(&tx, translation.start()).await {
            return;
        }
        while !translation.is_finished() {
            let batch = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, events.next()).await {
                Err(_) => translation.fail("the provider stream went idle"),
                Ok(None) => translation.end(),
                Ok(Some(Err(error))) => {
                    translation.fail(&format!("the provider stream broke: {error}"))
                }
                Ok(Some(Ok(event))) => translation.push(&event.event, &event.data),
            };
            if !send_events(&tx, batch).await {
                return;
            }
        }
    });
    (
        StatusCode::OK,
        [
            (CONTENT_TYPE, "text/event-stream"),
            (CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

async fn send_events(
    tx: &mpsc::Sender<Result<Bytes, std::io::Error>>,
    events: Vec<Value>,
) -> bool {
    for event in events {
        let frame = sse_frame(&event);
        if tx.send(Ok(Bytes::from(frame))).await.is_err() {
            return false;
        }
    }
    true
}

pub(crate) fn sse_frame(event: &Value) -> String {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    format!("event: {kind}\ndata: {event}\n\n")
}

async fn models(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    match serve_models(&state, &headers).await {
        Ok(catalog) => (
            StatusCode::OK,
            [(CONTENT_TYPE, "application/json")],
            catalog.to_string(),
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

async fn serve_models(state: &GatewayState, headers: &HeaderMap) -> Result<Value, GatewayError> {
    let route = Route::from_headers(headers, &state.token)?;
    let key = keys::resolve(&state.home, &route, |name| std::env::var(name).ok());
    let url = route.models_url();
    let response = state
        .client_for(&url)
        .get(&url)
        .headers(route.vendor_headers(key.as_deref())?)
        .timeout(CATALOG_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            GatewayError::bad_gateway(format!(
                "could not list the models of provider `{}`: {error}",
                route.provider_id
            ))
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(GatewayError::from_vendor(status, &text, &route.provider_id));
    }
    let listing: Value = serde_json::from_str(&text).map_err(|error| {
        GatewayError::bad_gateway(format!(
            "provider `{}` listed its models in a form Elpis cannot read: {error}",
            route.provider_id
        ))
    })?;
    catalog::catalog_response(catalog::models_from_listing(route.wire, &listing))
        .map_err(|message| GatewayError::new(StatusCode::INTERNAL_SERVER_ERROR, message))
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod tests;

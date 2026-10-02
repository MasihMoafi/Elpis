//! Elpis: a loopback proxy that runs Smart Prune on Claude Code's requests.
//!
//! `elpis claude` starts this proxy and points Claude Code at it with `ANTHROPIC_BASE_URL`.
//! The proxy forwards each request and its headers, which include the login of the user,
//! and it returns each response stream unchanged. It changes a `POST /v1/messages` body
//! only as `prune` describes. Each error sends the source unchanged.

mod prune;

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::Method;
use axum::http::StatusCode;
use axum::http::Uri;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use codex_core::AdmissionDecision;
use codex_core::OptimizerReply;
use codex_core::StandaloneOptimizer;
use codex_core::admit_compact_text;
use codex_core::parse_decision_manifest;
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Mutex;

use crate::prune::Candidate;
use crate::prune::Decisions;

/// Anthropic's API origin, the default upstream.
pub const ANTHROPIC_ORIGIN: &str = "https://api.anthropic.com";

/// The model that decides how to compact each tool result.
pub trait Optimizer: Send + Sync + 'static {
    fn decide(&self, input: String) -> BoxFuture<'_, anyhow::Result<OptimizerReply>>;
}

impl Optimizer for StandaloneOptimizer {
    fn decide(&self, input: String) -> BoxFuture<'_, anyhow::Result<OptimizerReply>> {
        StandaloneOptimizer::decide(self, input).boxed()
    }
}

pub struct ProxyOptions {
    /// The origin that receives each forwarded request, for example [`ANTHROPIC_ORIGIN`].
    pub upstream: String,
    /// The directory of admission records. The proxy loads the decisions from it at start.
    pub log_dir: PathBuf,
    /// When false, the proxy forwards each body byte for byte.
    pub prune: bool,
}

pub struct ProxyHandle {
    origin: String,
}

impl ProxyHandle {
    /// The loopback origin to put in `ANTHROPIC_BASE_URL`.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

struct ProxyState {
    client: reqwest::Client,
    upstream: String,
    prune: bool,
    log_dir: PathBuf,
    optimizer: Arc<dyn Optimizer>,
    /// Decisions by `tool_use_id`. The lock also makes sure that one block gets one decision.
    decisions: Mutex<Decisions>,
}

/// Binds a loopback port and serves the proxy until the process exits.
pub async fn start(
    options: ProxyOptions,
    optimizer: Arc<dyn Optimizer>,
) -> io::Result<ProxyHandle> {
    let decisions = load_decisions(&options.log_dir);
    let client = reqwest::Client::builder()
        .build()
        .map_err(io::Error::other)?;
    let state = Arc::new(ProxyState {
        client,
        upstream: options.upstream.trim_end_matches('/').to_string(),
        prune: options.prune,
        log_dir: options.log_dir,
        optimizer,
        decisions: Mutex::new(decisions),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .fallback(forward)
        .layer(DefaultBodyLimit::disable())
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!("elpis claude proxy stopped: {error}");
        }
    });
    Ok(ProxyHandle { origin })
}

async fn forward(
    State(state): State<Arc<ProxyState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = if state.prune && method == Method::POST && uri.path() == "/v1/messages" {
        prune_body(&state, body).await
    } else {
        body
    };
    let path = uri.path_and_query().map_or("/", |path| path.as_str());
    let mut request = state
        .client
        .request(method, format!("{}{path}", state.upstream))
        .body(body);
    for (name, value) in &headers {
        // The client sets the length and the host. The upstream sends an identity
        // encoding, so the proxy never sees a compressed body.
        if !matches!(
            *name,
            header::HOST
                | header::CONTENT_LENGTH
                | header::CONNECTION
                | header::TRANSFER_ENCODING
                | header::ACCEPT_ENCODING
        ) {
            request = request.header(name, value);
        }
    }
    let upstream = match request.send().await {
        Ok(upstream) => upstream,
        Err(error) => {
            tracing::warn!("elpis claude proxy could not reach the upstream: {error}");
            return (StatusCode::BAD_GATEWAY, "Elpis proxy: upstream unreachable").into_response();
        }
    };
    let mut response = Response::builder().status(upstream.status());
    for (name, value) in upstream.headers() {
        if !matches!(
            *name,
            header::CONTENT_LENGTH | header::CONNECTION | header::TRANSFER_ENCODING
        ) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Returns the body to forward. Each failure returns the source bytes.
async fn prune_body(state: &ProxyState, source: Bytes) -> Bytes {
    let Ok(mut body) = serde_json::from_slice::<Value>(&source) else {
        return source;
    };
    let mut decisions = state.decisions.lock().await;
    let pending = prune::candidates(&body, &decisions);
    if !pending.is_empty() {
        let decided = decide(state, &body, &pending).await;
        decisions.extend(decided);
    }
    if !prune::apply_decisions(&mut body, &decisions) {
        return source;
    }
    match serde_json::to_vec(&body) {
        Ok(bytes) => Bytes::from(bytes),
        Err(_) => source,
    }
}

/// Asks the optimizer about the candidates and records the attempt. Each candidate gets
/// a decision. On failure, that decision is to keep the source, and the record tells why.
async fn decide(state: &ProxyState, body: &Value, pending: &[Candidate]) -> Decisions {
    let input = prune::admission_input(body, pending);
    let admission_id = uuid::Uuid::now_v7().to_string();
    let (status, error, reply, manifest) = match state.optimizer.decide(input.clone()).await {
        Err(error) => ("optimizer_error", Some(format!("{error:#}")), None, None),
        Ok(reply) => {
            let ids = pending
                .iter()
                .map(|candidate| candidate.tool_use_id.as_str())
                .collect::<Vec<_>>();
            match parse_decision_manifest(&reply.raw_response, &ids) {
                Some(manifest) => ("decided", None, Some(reply), Some(manifest)),
                None => (
                    "malformed_reply",
                    Some("the reply did not match the decision manifest".to_string()),
                    Some(reply),
                    None,
                ),
            }
        }
    };
    let mut decided = Decisions::new();
    let mut items = Vec::new();
    let manifest = manifest.map(|manifest| manifest.into_iter().map(Some).collect::<Vec<_>>());
    let decisions = manifest.unwrap_or_else(|| vec![None; pending.len()]);
    for (candidate, decision) in pending.iter().zip(decisions) {
        let source_sha256 = format!("{:x}", Sha256::digest(candidate.source.as_bytes()));
        let admitted = match decision {
            Some(AdmissionDecision::Compact { content, .. }) => admit_compact_text(
                &candidate.source,
                &content,
                &candidate.tool_use_id,
                &admission_id,
                &source_sha256,
            ),
            Some(AdmissionDecision::Unchanged { .. }) | None => None,
        };
        items.push(serde_json::json!({
            "tool_use_id": candidate.tool_use_id,
            "source_sha256": source_sha256,
            "source_tokens": candidate.source_tokens,
            "admitted_tokens": admitted.as_ref().map(|admitted| admitted.admitted_tokens),
            "saved_tokens": admitted.as_ref().map_or(0, |admitted| admitted.saved_tokens),
            "admitted": admitted.as_ref().map(|admitted| admitted.text.as_str()),
        }));
        decided.insert(
            candidate.tool_use_id.clone(),
            admitted.map(|admitted| admitted.text),
        );
    }
    if let Some(error) = &error {
        tracing::warn!("Smart Prune kept the source: {error}");
    }
    let record = serde_json::json!({
        "admission_id": admission_id,
        "status": status,
        "error": error,
        "model_slug": reply.as_ref().map(|reply| reply.model_slug.as_str()),
        "input": input,
        "raw_response": reply.as_ref().map(|reply| reply.raw_response.as_str()),
        "items": items,
    });
    // An admission without a durable record would change a block that nobody can audit.
    if let Err(error) = write_record(&state.log_dir, &admission_id, &record) {
        tracing::warn!("Smart Prune record failed; sending the source: {error}");
        return pending
            .iter()
            .map(|candidate| (candidate.tool_use_id.clone(), None))
            .collect();
    }
    decided
}

fn write_record(log_dir: &Path, admission_id: &str, record: &Value) -> io::Result<()> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(format!("{admission_id}.json"));
    let temp = log_dir.join(format!(".{admission_id}.json.tmp"));
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(record).map_err(io::Error::other)?,
    )?;
    std::fs::rename(temp, path)
}

/// The decisions in each record of `log_dir`. An unreadable record is skipped: its blocks
/// then go out unchanged, which is safe.
fn load_decisions(log_dir: &Path) -> Decisions {
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return HashMap::new();
    };
    let mut decisions = Decisions::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(record) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        for item in record
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = item.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let admitted = item
                .get("admitted")
                .and_then(Value::as_str)
                .map(str::to_string);
            decisions.insert(id.to_string(), admitted);
        }
    }
    decisions
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

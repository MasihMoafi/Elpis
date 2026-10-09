//! Elpis: local HTTP server backing the `/dashboard` command: serves a minimal, static
//! HTML/CSS/JS page (see `dashboard_assets/index.html`) that polls `/data.json`
//! for the live state published from the chat widget.
//!
//! Copied from v0.3.0 `dashboard_server.rs`. A turn's cost is only ever unavailable in this
//! build, so neither the turn profile breakdown nor a price has a representation here. The
//! server binds 127.0.0.1 only.
//!
//! Three pages change settings: the Models tab (`dashboard_models.rs`), the provider keys
//! (`dashboard_provider_keys.rs`) and the Smart Prune prompt (`dashboard_pruner.rs`). Each
//! needs this session's token in its path, and a write must be a same-origin JSON POST
//! (`read_write_body`). They reach the running App through the [`DashboardLink`] it registers
//! each time it publishes the page's state.

use std::io::Cursor;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::sync::Mutex;

use chrono::Utc;
use codex_app_server_protocol::TurnCostAvailability;
use codex_app_server_protocol::TurnCostState;
use serde::Deserialize;
use serde::Serialize;

use crate::activity_state::DashboardActivityState;
use crate::activity_state::DashboardActivityStatus as ProjectedActivityStatus;

#[path = "dashboard_claude.rs"]
mod claude;
#[path = "dashboard_evidence.rs"]
mod evidence;
#[path = "dashboard_models.rs"]
mod models;
#[path = "dashboard_provider_keys.rs"]
mod provider_keys;
#[path = "dashboard_pruner.rs"]
mod pruner;

pub(crate) use evidence::publish as publish_evidence;
pub(crate) use evidence::register as evidence_url;
pub(crate) use models::DashboardLink;
pub(crate) use models::DashboardModelChoice;
pub(crate) use models::DashboardModels;
pub(crate) use models::register_link;

const INDEX_HTML: &str = include_str!("dashboard_assets/index.html");
const DASHBOARD_CSS: &str = include_str!("dashboard_assets/dashboard.css");
const DASHBOARD_JS: &str = include_str!("dashboard_assets/dashboard.js");
const SCHEMA_VERSION: u64 = 1;
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UNAVAILABLE_JSON: &[u8] = br#"{"state":null,"heartbeat_at":null}"#;

type DashboardResponse = tiny_http::Response<Cursor<Vec<u8>>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardState {
    pub(crate) schema_version: u64,
    pub(crate) revision: u64,
    pub(crate) generated_at: i64,
    pub(crate) context: DashboardContext,
    pub(crate) tokens: DashboardTokens,
    pub(crate) activity: DashboardActivity,
    pub(crate) smart_prune: DashboardSmartPrune,
    /// The usage limits `/usage` shows. Empty when none were reported; absent in states written
    /// before the Limits card.
    #[serde(default)]
    pub(crate) limits: Vec<DashboardLimit>,
}

/// One usage-limit window, such as Claude's 5-hour or weekly limit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardLimit {
    pub(crate) label: String,
    pub(crate) used_percent: i64,
    /// Local reset time as `/usage` formats it; `None` when the server sent none.
    pub(crate) resets_at: Option<String>,
}

/// One agent on the Agents map: a chat, or a helper another agent started.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardAgent {
    pub(crate) id: String,
    /// The agent that started this one; `None` for a chat the user started.
    pub(crate) parent_id: Option<String>,
    pub(crate) title: String,
    pub(crate) model: Option<String>,
    /// `#rrggbb`: the hue the agent list in Elpis gives this agent.
    pub(crate) color: Option<String>,
    pub(crate) status: DashboardAgentStatus,
    /// The status in the agent list's words.
    pub(crate) status_label: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardAgentStatus {
    NeedsYou,
    Working,
    Ready,
    Inactive,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardEnvelope {
    pub(crate) state: DashboardState,
    pub(crate) heartbeat_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardContext {
    pub(crate) model: String,
    pub(crate) used_tokens: Option<u64>,
    pub(crate) window_tokens: Option<u64>,
    pub(crate) used_percent: Option<i64>,
    pub(crate) attributed_tokens: Option<u64>,
    pub(crate) categories: Option<Vec<DashboardCategory>>,
    pub(crate) saved_tokens: u64,
    pub(crate) sources: Vec<DashboardSource>,
    pub(crate) backtrack_points: usize,
    /// The chat, background and Smart Prune models this session uses now. Absent in states
    /// written before the Models tab.
    #[serde(default)]
    pub(crate) models: DashboardModels,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardCategory {
    pub(crate) label: String,
    pub(crate) tokens: u64,
    pub(crate) color: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardSource {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) estimated_tokens: u64,
    pub(crate) admitted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardTokens {
    pub(crate) session_total: Option<DashboardTokenTotals>,
    pub(crate) last_turn: Option<DashboardTokenTotals>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardTokenTotals {
    pub(crate) input: i64,
    pub(crate) cached_input: i64,
    /// `None` means the provider did not report cache-write usage. This must not be
    /// collapsed into a reported zero in dashboard evidence.
    pub(crate) cache_write: Option<i64>,
    pub(crate) output: i64,
    pub(crate) reasoning_output: i64,
    pub(crate) total: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardActivity {
    pub(crate) current: Option<DashboardCurrentTurn>,
    pub(crate) recent: Vec<DashboardRecentTurn>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardCurrentTurn {
    pub(crate) status: DashboardActivityStatus,
    pub(crate) started_at: Option<i64>,
    pub(crate) cost: Option<DashboardCostState>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardRecentTurn {
    pub(crate) status: DashboardActivityStatus,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) time_to_first_token_ms: Option<i64>,
    pub(crate) cost: Option<DashboardCostState>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardActivityStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DashboardCostState {
    Unavailable { reason: DashboardCostAvailability },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DashboardCostAvailability {
    SubscriptionAuthentication,
    CostObservationDisabled,
}

/// Dashboard-safe Smart Prune facts. Raw content, paths, hashes, and request or
/// response identifiers intentionally have no representation here.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardSmartPrune {
    pub(crate) configured_enabled: bool,
    pub(crate) current_thread_next_turn_enabled: Option<bool>,
    pub(crate) examined_outputs: u64,
    pub(crate) admitted_outputs: u64,
    pub(crate) unchanged_outputs: u64,
    pub(crate) failed_batches: u64,
    pub(crate) approx_source_tokens: u64,
    pub(crate) approx_admitted_tokens: u64,
    pub(crate) approx_saved_tokens: u64,
    pub(crate) optimizer_requests: u64,
    pub(crate) optimizer_usage_reports: u64,
    pub(crate) optimizer_usage: DashboardTokenTotals,
    pub(crate) optimizer_latency_ms: u64,
    pub(crate) latest: Option<DashboardSmartPruneLatest>,
    pub(crate) latest_attempt: Option<DashboardSmartPruneAttempt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardSmartPruneLatest {
    pub(crate) examined_outputs: u64,
    pub(crate) admitted_outputs: u64,
    pub(crate) approx_source_tokens: u64,
    pub(crate) approx_admitted_tokens: u64,
    pub(crate) approx_saved_tokens: u64,
    pub(crate) request_linkage_verified: bool,
    pub(crate) response_usage: Option<DashboardTokenTotals>,
    pub(crate) response_linkage_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardSmartPruneAttempt {
    pub(crate) status: String,
    pub(crate) model: String,
    pub(crate) reasoning_effort: String,
    pub(crate) candidate_outputs: u64,
    pub(crate) admitted_outputs: u64,
    pub(crate) approx_saved_tokens: u64,
    pub(crate) latency_ms: u64,
    pub(crate) usage: Option<DashboardTokenTotals>,
}

static DASHBOARD_STATE: Mutex<Option<DashboardState>> = Mutex::new(None);
static SERVER_URL: Mutex<Option<String>> = Mutex::new(None);
static DASHBOARD_AGENTS: Mutex<Vec<DashboardAgent>> = Mutex::new(Vec::new());

/// Whether `/dashboard` has started this session's page server.
pub(crate) fn is_running() -> bool {
    SERVER_URL.lock().is_ok_and(|url| url.is_some())
}

/// Replaces the agents the Agents map draws; the page reads them from `/agents.json`.
pub(crate) fn publish_agents(agents: Vec<DashboardAgent>) {
    if let Ok(mut slot) = DASHBOARD_AGENTS.lock() {
        *slot = agents;
    }
}

fn agents_body(agents: &[DashboardAgent]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "agents": agents }))
        .unwrap_or_else(|_| br#"{"agents":[]}"#.to_vec())
}

pub(crate) fn publish_state(
    context: DashboardContext,
    tokens: DashboardTokens,
    activity: DashboardActivityState,
    smart_prune: DashboardSmartPrune,
    limits: Vec<DashboardLimit>,
) -> bool {
    let Ok(mut slot) = DASHBOARD_STATE.lock() else {
        return false;
    };
    publish_state_into(
        &mut slot,
        context,
        tokens,
        activity,
        smart_prune,
        limits,
        Utc::now().timestamp_millis(),
    )
}

fn publish_state_into(
    slot: &mut Option<DashboardState>,
    context: DashboardContext,
    tokens: DashboardTokens,
    activity: DashboardActivityState,
    smart_prune: DashboardSmartPrune,
    limits: Vec<DashboardLimit>,
    generated_at: i64,
) -> bool {
    let activity = map_activity(activity);
    let revision = match slot.as_ref() {
        Some(current)
            if current.context == context
                && current.tokens == tokens
                && current.activity == activity
                && current.smart_prune == smart_prune
                && current.limits == limits =>
        {
            return false;
        }
        Some(current) => current.revision.saturating_add(1),
        None => 1,
    };
    *slot = Some(DashboardState {
        schema_version: SCHEMA_VERSION,
        revision,
        generated_at,
        context,
        tokens,
        activity,
        smart_prune,
        limits,
    });
    true
}

fn map_activity(activity: DashboardActivityState) -> DashboardActivity {
    DashboardActivity {
        current: activity.current.map(|row| DashboardCurrentTurn {
            status: map_activity_status(row.status),
            started_at: row
                .started_at
                .and_then(|seconds| seconds.checked_mul(1_000)),
            cost: row.cost.map(map_cost),
        }),
        recent: activity
            .recent
            .into_iter()
            .map(|row| DashboardRecentTurn {
                status: map_activity_status(row.status),
                duration_ms: row.duration_ms,
                time_to_first_token_ms: row.time_to_first_token_ms,
                cost: row.cost.map(map_cost),
            })
            .collect(),
    }
}

fn map_activity_status(status: ProjectedActivityStatus) -> DashboardActivityStatus {
    match status {
        ProjectedActivityStatus::Running => DashboardActivityStatus::Running,
        ProjectedActivityStatus::Completed => DashboardActivityStatus::Completed,
        ProjectedActivityStatus::Failed => DashboardActivityStatus::Failed,
        ProjectedActivityStatus::Interrupted => DashboardActivityStatus::Interrupted,
    }
}

fn map_cost(cost: TurnCostState) -> DashboardCostState {
    match cost {
        TurnCostState::Unavailable { reason } => DashboardCostState::Unavailable {
            reason: match reason {
                TurnCostAvailability::SubscriptionAuthentication => {
                    DashboardCostAvailability::SubscriptionAuthentication
                }
                TurnCostAvailability::CostObservationDisabled => {
                    DashboardCostAvailability::CostObservationDisabled
                }
            },
        },
    }
}

pub(crate) fn ensure_running() -> Option<String> {
    ensure_server_url(&SERVER_URL, || {
        let listener = tiny_http::Server::http(dashboard_bind_addr()).ok()?;
        let port = listener.server_addr().to_ip()?.port();
        let url = format!("http://127.0.0.1:{port}{}", evidence::dashboard_fragment());
        std::thread::Builder::new()
            .name("elpis-dashboard".to_string())
            .spawn(move || serve(listener, port))
            .ok()?;
        Some(url)
    })
}

fn ensure_server_url(
    slot: &Mutex<Option<String>>,
    start: impl FnOnce() -> Option<String>,
) -> Option<String> {
    let mut server_url = slot.lock().ok()?;
    if let Some(url) = server_url.as_ref() {
        return Some(url.clone());
    }
    let url = start()?;
    *server_url = Some(url.clone());
    Some(url)
}

fn dashboard_bind_addr() -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
}

fn serve(listener: tiny_http::Server, port: u16) {
    for mut request in listener.incoming_requests() {
        // Listing a provider's models can wait on the vendor; the page keeps polling meanwhile.
        if request.url().starts_with("/models/") {
            let _ = std::thread::Builder::new()
                .name("elpis-dashboard-models".to_string())
                .spawn(move || {
                    let link = models::current_link();
                    let response = route(&mut request, port, link.as_deref(), None, 0);
                    let _ = request.respond(response);
                });
            continue;
        }
        let link = models::current_link();
        let state = DASHBOARD_STATE.lock().ok().and_then(|state| state.clone());
        let response = route(
            &mut request,
            port,
            link.as_deref(),
            state,
            Utc::now().timestamp_millis(),
        );
        let _ = request.respond(response);
    }
}

/// Every request: the Host check, then the capability routes, then the read-only page.
fn route(
    request: &mut tiny_http::Request,
    port: u16,
    link: Option<&DashboardLink>,
    state: Option<DashboardState>,
    heartbeat_at: i64,
) -> DashboardResponse {
    if !valid_host(request, port) {
        return response(403, "text/plain; charset=utf-8", b"forbidden".to_vec());
    }
    let url = request.url();
    if url.starts_with("/models/") {
        return models::route(link, request, port);
    }
    if url.starts_with("/provider-keys/") {
        return provider_keys::route(link, request, port);
    }
    if url.starts_with("/pruner-settings/") {
        return pruner::route(link, request, port);
    }
    // Each poll asks the App to republish, so the page shows this session within one poll
    // even when nothing in the chat announced the change.
    if url == "/data.json"
        && request.method() == &tiny_http::Method::Get
        && let Some(link) = link
    {
        link.request_refresh();
    }
    response_for_at(request, port, state, heartbeat_at)
}

fn plain(status: u16, message: &str) -> DashboardResponse {
    response(
        status,
        "text/plain; charset=utf-8",
        message.as_bytes().to_vec(),
    )
}

fn json_response(value: &serde_json::Value) -> DashboardResponse {
    match serde_json::to_vec(value) {
        Ok(body) => response(200, "application/json; charset=utf-8", body),
        Err(_) => plain(500, "Cannot encode the answer"),
    }
}

/// The path after `prefix` and this session's token: `""` for the route itself, or the
/// rest after a `/`. A wrong token, like a foreign Host, learns nothing.
fn capability_path<'a>(
    request: &'a tiny_http::Request,
    port: u16,
    prefix: &str,
) -> Result<&'a str, DashboardResponse> {
    let rest = request
        .url()
        .strip_prefix(prefix)
        .ok_or_else(|| plain(404, "Not found"))?;
    let (token, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !valid_host(request, port) || !evidence::valid_token(token) {
        return Err(plain(403, "Forbidden"));
    }
    Ok(path)
}

/// Reads the body of a write. A write must come from this page (its `Origin`), be JSON (a
/// cross-site form cannot send that without a preflight this server never answers) and
/// carry a length no larger than `max_bytes`.
fn read_write_body(
    request: &mut tiny_http::Request,
    port: u16,
    max_bytes: u64,
) -> Result<Vec<u8>, DashboardResponse> {
    use std::io::Read;

    let origin = format!("http://127.0.0.1:{port}");
    let same_origin = request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Origin") && header.value.as_str() == origin);
    let json = request.headers().iter().any(|header| {
        header.field.equiv("Content-Type")
            && header.value.as_str().split(';').next() == Some("application/json")
    });
    if !same_origin || !json {
        return Err(plain(403, "Same-origin JSON required"));
    }
    if request
        .body_length()
        .is_none_or(|size| size as u64 > max_bytes)
    {
        return Err(plain(413, "Body too large or missing its length"));
    }
    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > max_bytes
    {
        return Err(plain(400, "Cannot read the request"));
    }
    Ok(bytes)
}

fn response_for_at(
    request: &tiny_http::Request,
    port: u16,
    state: Option<DashboardState>,
    heartbeat_at: i64,
) -> DashboardResponse {
    if !valid_host(request, port) {
        return response(403, "text/plain; charset=utf-8", b"forbidden".to_vec());
    }
    if request.method() != &tiny_http::Method::Get {
        return response(
            405,
            "text/plain; charset=utf-8",
            b"method not allowed".to_vec(),
        );
    }
    if request.url().starts_with("/evidence/") {
        return evidence::route(request, port);
    }
    match request.url() {
        "/" | "/index.html" => response(
            200,
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes().to_vec(),
        ),
        "/dashboard.css" => response(
            200,
            "text/css; charset=utf-8",
            DASHBOARD_CSS.as_bytes().to_vec(),
        ),
        "/dashboard.js" => response(
            200,
            "text/javascript; charset=utf-8",
            DASHBOARD_JS.as_bytes().to_vec(),
        ),
        "/claude.json" => response(
            200,
            "application/json; charset=utf-8",
            claude::summary_json(),
        ),
        "/agents.json" => response(
            200,
            "application/json; charset=utf-8",
            agents_body(&DASHBOARD_AGENTS.lock().map(|agents| agents.clone()).unwrap_or_default()),
        ),
        "/data.json" => match state {
            Some(state) => data_response_with(state, heartbeat_at, serde_json::to_vec),
            None => unavailable_response(),
        },
        _ => response(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

fn valid_host(request: &tiny_http::Request, port: u16) -> bool {
    let mut hosts = request
        .headers()
        .iter()
        .filter(|header| header.field.equiv("Host"));
    let Some(host) = hosts.next() else {
        return false;
    };
    if hosts.next().is_some() {
        return false;
    }
    let value = host.value.as_str();
    value == format!("127.0.0.1:{port}") || value.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

fn data_response_with<E>(
    state: DashboardState,
    heartbeat_at: i64,
    encode: impl FnOnce(&DashboardEnvelope) -> Result<Vec<u8>, E>,
) -> DashboardResponse {
    let envelope = DashboardEnvelope {
        state,
        heartbeat_at,
    };
    match encode(&envelope) {
        Ok(body) => response(200, "application/json; charset=utf-8", body),
        Err(_) => unavailable_response(),
    }
}

fn unavailable_response() -> DashboardResponse {
    response(
        503,
        "application/json; charset=utf-8",
        UNAVAILABLE_JSON.to_vec(),
    )
}

fn response(status: u16, content_type: &str, body: Vec<u8>) -> DashboardResponse {
    let mut response = tiny_http::Response::from_data(body).with_status_code(status);
    for (name, value) in [
        ("Content-Type", content_type),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
        ("Content-Security-Policy", CSP),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
    ] {
        response = response.with_header(
            tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
                .expect("static dashboard response header is valid"),
        );
    }
    response
}

#[cfg(test)]
#[path = "dashboard_server_tests.rs"]
mod tests;

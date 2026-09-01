//! Local HTTP server backing the `/dashboard` command: serves a minimal, static
//! HTML/CSS/JS page (see `dashboard_assets/index.html`) that polls `/data.json`
//! for the live snapshot published from the chat widget.

use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use serde::Serialize;

const INDEX_HTML: &str = include_str!("dashboard_assets/index.html");

#[derive(Serialize, Clone, Default)]
pub(crate) struct DashboardSnapshot {
    pub(crate) model: String,
    pub(crate) used_tokens: u64,
    pub(crate) window_tokens: u64,
    pub(crate) used_percent: i64,
    pub(crate) categories: Vec<DashboardCategory>,
    pub(crate) saved_tokens: u64,
    pub(crate) sources: Vec<DashboardSource>,
    pub(crate) backtrack_points: usize,
    pub(crate) session_total: DashboardTokenTotals,
    pub(crate) last_turn: DashboardTokenTotals,
    pub(crate) automatic_pruning_configured_for_next_conversation: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct DashboardCategory {
    pub(crate) label: String,
    pub(crate) tokens: u64,
    pub(crate) color: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct DashboardSource {
    pub(crate) name: String,
    pub(crate) category: String,
    pub(crate) estimated_tokens: u64,
    pub(crate) admitted: bool,
}

#[derive(Serialize, Clone, Default)]
pub(crate) struct DashboardTokenTotals {
    pub(crate) input: i64,
    pub(crate) cached_input: i64,
    pub(crate) output: i64,
    pub(crate) reasoning_output: i64,
    pub(crate) total: i64,
}

static SNAPSHOT_JSON: OnceLock<Mutex<String>> = OnceLock::new();
static SERVER_STARTED: AtomicBool = AtomicBool::new(false);
static SERVER_PORT: OnceLock<u16> = OnceLock::new();

/// Publishes a fresh snapshot for the dashboard's `/data.json` endpoint to serve.
/// Cheap to call often: this only updates a JSON string behind a mutex.
pub(crate) fn publish(snapshot: &DashboardSnapshot) {
    let Ok(json) = serde_json::to_string(snapshot) else {
        return;
    };
    let cell = SNAPSHOT_JSON.get_or_init(|| Mutex::new(String::new()));
    if let Ok(mut guard) = cell.lock() {
        *guard = json;
    }
}

/// Starts the local dashboard server on first call (idempotent) and returns its URL.
pub(crate) fn ensure_running() -> Option<String> {
    if SERVER_STARTED.swap(true, Ordering::SeqCst) {
        return SERVER_PORT.get().map(|port| format!("http://127.0.0.1:{port}"));
    }
    let listener = tiny_http::Server::http("127.0.0.1:0").ok()?;
    let port = listener.server_addr().to_ip()?.port();
    let _ = SERVER_PORT.set(port);
    std::thread::Builder::new()
        .name("elpis-dashboard".to_string())
        .spawn(move || serve(listener))
        .ok()?;
    Some(format!("http://127.0.0.1:{port}"))
}

fn serve(listener: tiny_http::Server) {
    for request in listener.incoming_requests() {
        let (status, content_type, body): (u16, &str, Vec<u8>) = match request.url() {
            "/" | "/index.html" => (200, "text/html; charset=utf-8", INDEX_HTML.as_bytes().to_vec()),
            "/data.json" => {
                let body = SNAPSHOT_JSON
                    .get()
                    .and_then(|m| m.lock().ok())
                    .map(|guard| guard.clone())
                    .unwrap_or_else(|| "{}".to_string());
                (200, "application/json", body.into_bytes())
            }
            _ => (404, "text/plain", b"not found".to_vec()),
        };
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
            .expect("static content-type is valid header value");
        let response = tiny_http::Response::from_data(body)
            .with_status_code(status)
            .with_header(header);
        let _ = request.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_snapshot_serializes_automatic_pruning_configuration() {
        let disabled = serde_json::to_value(DashboardSnapshot::default()).expect("serialize");
        assert_eq!(
            disabled["automatic_pruning_configured_for_next_conversation"],
            serde_json::Value::Bool(false)
        );

        let enabled = serde_json::to_value(DashboardSnapshot {
            automatic_pruning_configured_for_next_conversation: true,
            ..Default::default()
        })
        .expect("serialize");
        assert_eq!(
            enabled["automatic_pruning_configured_for_next_conversation"],
            serde_json::Value::Bool(true)
        );
    }
}

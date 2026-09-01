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
    pub(crate) used_tokens: Option<u64>,
    pub(crate) window_tokens: u64,
    pub(crate) used_percent: Option<i64>,
    pub(crate) categories: Vec<DashboardCategory>,
    pub(crate) saved_tokens: u64,
    pub(crate) sources: Vec<DashboardSource>,
    pub(crate) backtrack_points: usize,
    pub(crate) session_total: DashboardTokenTotals,
    pub(crate) last_turn: DashboardTokenTotals,
    pub(crate) automatic_pruning_configured_for_next_conversation: bool,
    pub(crate) smart_prune: DashboardSmartPruneSnapshot,
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
    /// `None` means the provider did not report cache-write usage. This must not be
    /// collapsed into a reported zero in dashboard evidence.
    pub(crate) cache_write: Option<i64>,
    pub(crate) output: i64,
    pub(crate) reasoning_output: i64,
    pub(crate) total: i64,
}

/// Dashboard-safe Smart Prune evidence. This intentionally contains linkage and
/// aggregate token metadata only; raw tool contents never enter the dashboard payload.
#[derive(Serialize, Clone, Default)]
pub(crate) struct DashboardSmartPruneSnapshot {
    pub(crate) enabled: bool,
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
    pub(crate) main_request_sequence: u64,
    pub(crate) latest: Option<DashboardSmartPruneAdmissionSnapshot>,
}

#[derive(Serialize, Clone)]
pub(crate) struct DashboardSmartPruneAdmissionSnapshot {
    pub(crate) admission_id: String,
    pub(crate) audit_path: String,
    pub(crate) examined_outputs: u64,
    pub(crate) admitted_outputs: u64,
    pub(crate) approx_source_tokens: u64,
    pub(crate) approx_admitted_tokens: u64,
    pub(crate) approx_saved_tokens: u64,
    pub(crate) request_sequence: Option<u64>,
    pub(crate) request_input_sha256: Option<String>,
    pub(crate) request_linkage_verified: bool,
    pub(crate) response_id: Option<String>,
    pub(crate) response_usage: Option<DashboardTokenTotals>,
    pub(crate) response_linkage_verified: bool,
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
        return SERVER_PORT
            .get()
            .map(|port| format!("http://127.0.0.1:{port}"));
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
            "/" | "/index.html" => (
                200,
                "text/html; charset=utf-8",
                INDEX_HTML.as_bytes().to_vec(),
            ),
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
    use serde_json::json;

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

    fn token_totals(cache_write: Option<i64>) -> DashboardTokenTotals {
        DashboardTokenTotals {
            input: 4_200,
            cached_input: 3_100,
            cache_write,
            output: 800,
            reasoning_output: 200,
            total: 5_000,
        }
    }

    #[test]
    fn cache_write_serialization_distinguishes_unreported_from_zero() {
        let unreported = serde_json::to_value(token_totals(None)).expect("serialize token totals");
        let reported_zero =
            serde_json::to_value(token_totals(Some(0))).expect("serialize token totals");

        assert_eq!(unreported["cache_write"], serde_json::Value::Null);
        assert_eq!(reported_zero["cache_write"], json!(0));
    }

    #[test]
    fn snapshot_serializes_smart_prune_evidence_without_tool_content_fields() {
        let snapshot = DashboardSnapshot {
            smart_prune: DashboardSmartPruneSnapshot {
                enabled: true,
                examined_outputs: 3,
                admitted_outputs: 2,
                unchanged_outputs: 1,
                failed_batches: 0,
                approx_source_tokens: 18_000,
                approx_admitted_tokens: 1_200,
                approx_saved_tokens: 16_800,
                optimizer_requests: 3,
                optimizer_usage_reports: 2,
                optimizer_usage: token_totals(None),
                optimizer_latency_ms: 1_250,
                main_request_sequence: 7,
                latest: Some(DashboardSmartPruneAdmissionSnapshot {
                    admission_id: "sp-7".to_string(),
                    audit_path: "smart-prune/admissions/sp-7".to_string(),
                    examined_outputs: 3,
                    admitted_outputs: 2,
                    approx_source_tokens: 18_000,
                    approx_admitted_tokens: 1_200,
                    approx_saved_tokens: 16_800,
                    request_sequence: Some(7),
                    request_input_sha256: Some("abc123".to_string()),
                    request_linkage_verified: true,
                    response_id: Some("resp_7".to_string()),
                    response_usage: Some(token_totals(Some(0))),
                    response_linkage_verified: true,
                }),
            },
            ..DashboardSnapshot::default()
        };

        let value = serde_json::to_value(snapshot).expect("serialize dashboard snapshot");
        assert_eq!(
            value["smart_prune"],
            json!({
                "enabled": true,
                "examined_outputs": 3,
                "admitted_outputs": 2,
                "unchanged_outputs": 1,
                "failed_batches": 0,
                "approx_source_tokens": 18_000,
                "approx_admitted_tokens": 1_200,
                "approx_saved_tokens": 16_800,
                "optimizer_requests": 3,
                "optimizer_usage_reports": 2,
                "optimizer_usage": {
                    "input": 4_200,
                    "cached_input": 3_100,
                    "cache_write": null,
                    "output": 800,
                    "reasoning_output": 200,
                    "total": 5_000,
                },
                "optimizer_latency_ms": 1_250,
                "main_request_sequence": 7,
                "latest": {
                    "admission_id": "sp-7",
                    "audit_path": "smart-prune/admissions/sp-7",
                    "examined_outputs": 3,
                    "admitted_outputs": 2,
                    "approx_source_tokens": 18_000,
                    "approx_admitted_tokens": 1_200,
                    "approx_saved_tokens": 16_800,
                    "request_sequence": 7,
                    "request_input_sha256": "abc123",
                    "request_linkage_verified": true,
                    "response_id": "resp_7",
                    "response_usage": {
                        "input": 4_200,
                        "cached_input": 3_100,
                        "cache_write": 0,
                        "output": 800,
                        "reasoning_output": 200,
                        "total": 5_000,
                    },
                    "response_linkage_verified": true,
                },
            })
        );
        assert!(value["smart_prune"]["latest"].get("tool_output").is_none());
        assert!(
            value["smart_prune"]["latest"]
                .get("tool_contents")
                .is_none()
        );
    }
}

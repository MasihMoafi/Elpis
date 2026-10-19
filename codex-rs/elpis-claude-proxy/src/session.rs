//! Elpis: the live page of one `elpis claude` session. The proxy serves it at `/elpis`.
//!
//! The page shows counts, times and model ids only, never request, tool or admitted text.

use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use axum::http::StatusCode;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::Response;
use codex_core::MIN_SOURCE_TOKENS;
use serde_json::Value;
use serde_json::json;

/// The page path. Anthropic's API has no path under it.
pub(crate) const PAGE_PATH: &str = "/elpis";
const PAGE_HTML: &str = include_str!("session_page.html");
/// The style of the Elpis dashboard, so that both pages look the same.
const DASHBOARD_CSS: &str = include_str!("../../tui/src/dashboard_assets/dashboard.css");
const RECENT_RESULTS: usize = 20;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Compacted,
    Kept,
    Error,
}

struct CheckedResult {
    at: i64,
    model: Option<String>,
    outcome: Outcome,
    source_tokens: usize,
    sent_tokens: usize,
}

pub(crate) struct SessionStats {
    started_at: i64,
    requests: u64,
    /// The source tokens of each tool result in this session, by `tool_use_id`.
    results: HashMap<String, usize>,
    checked: Vec<CheckedResult>,
}

impl SessionStats {
    pub(crate) fn new() -> Self {
        Self {
            started_at: now(),
            requests: 0,
            results: HashMap::new(),
            checked: Vec::new(),
        }
    }

    pub(crate) fn note_request(&mut self, tool_results: Vec<(String, usize)>) {
        self.requests += 1;
        for (id, tokens) in tool_results {
            self.results.entry(id).or_insert(tokens);
        }
    }

    pub(crate) fn note_checked(
        &mut self,
        model: Option<&str>,
        outcome: Outcome,
        source_tokens: usize,
        sent_tokens: usize,
    ) {
        self.checked.push(CheckedResult {
            at: now(),
            model: model.map(str::to_string),
            outcome,
            source_tokens,
            sent_tokens,
        });
    }

    fn summary(&self, prune: bool, log_dir: &Path) -> Value {
        let source = self.checked.iter().map(|r| r.source_tokens).sum::<usize>();
        let sent = self.checked.iter().map(|r| r.sent_tokens).sum::<usize>();
        let recent = self
            .checked
            .iter()
            .rev()
            .take(RECENT_RESULTS)
            .map(|result| {
                json!({
                    "at": result.at,
                    "model": result.model,
                    "outcome": match result.outcome {
                        Outcome::Compacted => "compacted",
                        Outcome::Kept => "kept",
                        Outcome::Error => "error",
                    },
                    "source_tokens": result.source_tokens,
                    "sent_tokens": result.sent_tokens,
                })
            })
            .collect::<Vec<_>>();
        json!({
            "started_at": self.started_at,
            "prune": prune,
            "min_source_tokens": MIN_SOURCE_TOKENS,
            "requests": self.requests,
            "results": self.results.len(),
            "small_results": self.results.values().filter(|tokens| **tokens < MIN_SOURCE_TOKENS).count(),
            "checked": self.checked.len(),
            "compacted": self.checked.iter().filter(|r| r.outcome == Outcome::Compacted).count(),
            "source_tokens": source,
            "sent_tokens": sent,
            "saved_tokens": source.saturating_sub(sent),
            "recent": recent,
            "all": all_sessions(log_dir),
        })
    }
}

/// Serves the page, its style and its data. Each other path under the page is not found.
pub(crate) fn route(path: &str, stats: &SessionStats, prune: bool, log_dir: &Path) -> Response {
    match path.trim_end_matches('/') {
        PAGE_PATH => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            PAGE_HTML,
        )
            .into_response(),
        "/elpis/dashboard.css" => (
            [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
            DASHBOARD_CSS,
        )
            .into_response(),
        "/elpis/session.json" => (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            stats.summary(prune, log_dir).to_string(),
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The totals of every record in the Elpis home, this session included.
fn all_sessions(log_dir: &Path) -> Value {
    let (mut results, mut source, mut saved) = (0u64, 0u64, 0u64);
    for entry in std::fs::read_dir(log_dir).into_iter().flatten().flatten() {
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
            let item_source = item
                .get("source_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            results += 1;
            source += item_source;
            saved += item
                .get("saved_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(item_source);
        }
    }
    json!({ "results": results, "source_tokens": source, "saved_tokens": saved })
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or(0)
}

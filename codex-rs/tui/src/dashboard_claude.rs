//! Elpis: the `elpis claude` section of the dashboard. It sums the Smart Prune records that
//! `elpis claude` writes to `<ELPIS_HOME>/logs/claude-proxy`. It sends only counts, times and
//! model ids, never request, tool or admitted text.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// The newest records that the summary reads, so a long history stays cheap to poll.
const MAX_RECORDS: usize = 500;
const RECENT_RESULTS: usize = 8;

#[derive(Debug, Default, PartialEq, Serialize)]
pub(crate) struct ClaudeSummary {
    pub(crate) results: u64,
    pub(crate) source_tokens: u64,
    pub(crate) sent_tokens: u64,
    pub(crate) saved_tokens: u64,
    /// Newest first.
    pub(crate) recent: Vec<ClaudeResult>,
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct ClaudeResult {
    pub(crate) at: i64,
    pub(crate) model: Option<String>,
    pub(crate) source_tokens: u64,
    pub(crate) sent_tokens: u64,
    pub(crate) saved_tokens: u64,
}

pub(crate) fn summarize(log_dir: &Path) -> ClaudeSummary {
    let mut files: Vec<(i64, std::path::PathBuf)> = std::fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            let at = modified.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some((i64::try_from(at).ok()?, entry.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_RECORDS);

    let mut summary = ClaudeSummary::default();
    for (at, path) in files {
        let Some(record) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        let model = record
            .get("model_slug")
            .and_then(Value::as_str)
            .map(str::to_string);
        for item in record
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let source = item
                .get("source_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let saved = item
                .get("saved_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(source);
            summary.results += 1;
            summary.source_tokens += source;
            summary.saved_tokens += saved;
            summary.sent_tokens += source - saved;
            if summary.recent.len() < RECENT_RESULTS {
                summary.recent.push(ClaudeResult {
                    at,
                    model: model.clone(),
                    source_tokens: source,
                    sent_tokens: source - saved,
                    saved_tokens: saved,
                });
            }
        }
    }
    summary
}

/// The `/claude.json` body for the Elpis home in `ELPIS_HOME`.
pub(crate) fn summary_json() -> Vec<u8> {
    let summary = std::env::var_os("ELPIS_HOME")
        .map(|home| summarize(&Path::new(&home).join("logs").join("claude-proxy")))
        .unwrap_or_default();
    serde_json::to_vec(&summary).unwrap_or_else(|_| b"{}".to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn sums_every_pruned_result_and_sends_no_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("a.json"),
            r#"{"status":"decided","model_slug":"pruner-x","input":"SECRET INPUT",
               "items":[{"source_tokens":12000,"saved_tokens":11700,"admitted":"SECRET TEXT"},
                        {"source_tokens":4000,"saved_tokens":0,"admitted":null}]}"#,
        )
        .expect("write");
        std::fs::write(dir.path().join("broken.json"), "not json").expect("write");
        std::fs::write(
            dir.path().join("notes.txt"),
            r#"{"items":[{"source_tokens":9}]}"#,
        )
        .expect("write");

        let summary = summarize(dir.path());
        assert_eq!(
            (
                summary.results,
                summary.source_tokens,
                summary.sent_tokens,
                summary.saved_tokens
            ),
            (2, 16_000, 4_300, 11_700)
        );
        assert_eq!(summary.recent.len(), 2);
        assert_eq!(summary.recent[0].model.as_deref(), Some("pruner-x"));
        let json = String::from_utf8(serde_json::to_vec(&summary).expect("json")).expect("utf8");
        assert!(!json.contains("SECRET"), "{json}");
    }

    #[test]
    fn a_home_without_records_is_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            summarize(&dir.path().join("missing")),
            ClaudeSummary::default()
        );
    }
}

//! Capability-protected, explicitly registered local evidence. Never part of data.json.
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::Mutex;

use serde_json::Value;
use uuid::Uuid;

use super::DashboardResponse;
use super::response;

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;

struct Entry {
    id: String,
    label: String,
    path: PathBuf,
    file: File,
}

pub(super) struct Evidence {
    token: String,
    entries: Vec<Entry>,
    current: Vec<String>,
}

impl Evidence {
    fn new() -> Self {
        Self {
            token: Uuid::new_v4().simple().to_string(),
            entries: Vec::new(),
            current: Vec::new(),
        }
    }

    fn register(&mut self, root: &Path, label: &str, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(root).ok()?;
        let mut checked = root.to_path_buf();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return None;
            }
            checked.push(component);
            if std::fs::symlink_metadata(&checked)
                .ok()?
                .file_type()
                .is_symlink()
            {
                return None;
            }
        }
        let root = root.canonicalize().ok()?;
        let canonical = path.canonicalize().ok()?;
        if !canonical.starts_with(&root) || canonical == root {
            return None;
        }
        // Require every component below the trusted root to be a real directory/file.
        let mut checked = root.clone();
        for component in canonical.strip_prefix(&root).ok()?.components() {
            checked.push(component);
            if std::fs::symlink_metadata(&checked)
                .ok()?
                .file_type()
                .is_symlink()
            {
                return None;
            }
        }
        if let Some(entry) = self.entries.iter().find(|e| e.path == canonical) {
            return Some(entry.id.clone());
        }
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.remove(0);
        }
        let file = File::open(&canonical).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        // Hold the opened file, so a later path replacement cannot redirect the viewer.
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let opened = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()?;
            if opened != canonical {
                return None;
            }
        }
        let id = Uuid::new_v4().simple().to_string();
        self.entries.push(Entry {
            id: id.clone(),
            label: label.to_string(),
            path: canonical,
            file,
        });
        Some(id)
    }

    fn route(&mut self, request: &tiny_http::Request, port: u16) -> DashboardResponse {
        let denied = || {
            response(
                403,
                "text/plain; charset=utf-8",
                b"Evidence access denied. Open a fresh link from Elpis.".to_vec(),
            )
        };
        let origin = format!("http://127.0.0.1:{port}");
        for header in request.headers() {
            if (header.field.equiv("Origin") && header.value.as_str() != origin)
                || (header.field.equiv("Sec-Fetch-Site") && header.value.as_str() == "cross-site")
            {
                return denied();
            }
        }
        let Some(rest) = request.url().strip_prefix("/evidence/") else {
            return denied();
        };
        let Some((token, name)) = rest.split_once('/') else {
            return denied();
        };
        if token != self.token {
            return denied();
        }
        if name == "index.json" {
            let rows: Vec<_> = self.current.iter().filter_map(|id| self.entries.iter().find(|e| &e.id == id))
                .map(|e| serde_json::json!({"label": e.label, "url": format!("/evidence/{}/{}", self.token, e.id)})).collect();
            return response(
                200,
                "application/json; charset=utf-8",
                serde_json::to_vec(&rows).unwrap_or_default(),
            );
        }
        let (id, markdown) = name
            .strip_suffix(".md")
            .map_or((name, false), |id| (id, true));
        let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) else {
            return response(
                404,
                "text/plain; charset=utf-8",
                b"Evidence link expired or is not registered. Open a fresh link from Elpis."
                    .to_vec(),
            );
        };
        match read_report(entry) {
            Ok(report) if markdown => {
                response(200, "text/plain; charset=utf-8", report.into_bytes())
            }
            Ok(report) => {
                let body = render_html(&report, &format!("{id}.md"));
                response(200, "text/html; charset=utf-8", body.into_bytes())
            }
            Err(error) => response(
                422,
                "text/plain; charset=utf-8",
                format!("Cannot read this evidence: {error}. The original file is unchanged.")
                    .into_bytes(),
            ),
        }
    }
}

static EVIDENCE: LazyLock<Mutex<Evidence>> = LazyLock::new(|| Mutex::new(Evidence::new()));

pub(super) fn valid_token(token: &str) -> bool {
    EVIDENCE
        .lock()
        .is_ok_and(|evidence| evidence.token == token)
}

pub(super) fn dashboard_fragment() -> String {
    EVIDENCE
        .lock()
        .map(|e| format!("#evidence={}", e.token))
        .unwrap_or_default()
}

pub(crate) fn register(root: &Path, label: &str, path: &Path) -> Option<String> {
    let base = super::ensure_running()?;
    let mut evidence = EVIDENCE.lock().ok()?;
    let id = evidence.register(root, label, path)?;
    Some(format!(
        "{}/evidence/{}/{id}",
        base.split('#').next()?,
        evidence.token
    ))
}

pub(crate) fn publish(root: &Path, paths: Vec<(&str, PathBuf)>) {
    let Ok(mut evidence) = EVIDENCE.lock() else {
        return;
    };
    evidence.current = paths
        .iter()
        .filter_map(|(label, path)| evidence.register(root, label, path))
        .collect();
}

pub(super) fn route(request: &tiny_http::Request, port: u16) -> DashboardResponse {
    match EVIDENCE.lock() {
        Ok(mut evidence) => evidence.route(request, port),
        Err(_) => response(
            503,
            "text/plain; charset=utf-8",
            b"Evidence viewer unavailable.".to_vec(),
        ),
    }
}

fn read_report(entry: &mut Entry) -> Result<String, String> {
    entry
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    (&mut entry.file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("file exceeds the 32 MiB viewer limit; open it in a native text editor".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    let mut report = format!(
        "# {}\n\nReadable local evidence. The original file is unchanged.\n\n",
        entry.label
    );
    if entry.path.extension().is_some_and(|ext| ext == "jsonl") {
        for (index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line).map_err(|_| {
                format!(
                    "record {} is incomplete or invalid; retry after the writer finishes",
                    index + 1
                )
            })?;
            report.push_str(&format!("## Record {}\n\n", index + 1));
            render_value(&value, 3, &mut report);
        }
    } else if entry.path.extension().is_some_and(|ext| ext == "md") {
        report.push_str(text);
    } else {
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        render_value(&value, 2, &mut report);
    }
    Ok(report)
}

fn render_value(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Object(fields) => {
            let conversation = fields.contains_key("instructions")
                && fields.contains_key("input")
                && fields.contains_key("raw_response");
            if conversation {
                out.push_str(&format!(
                    "{} Pruner conversation\n\n",
                    "#".repeat(depth.min(6))
                ));
                for (key, label) in [
                    ("instructions", "System prompt"),
                    ("input", "Tool input"),
                    ("raw_response", "Pruner response"),
                ] {
                    out.push_str(&format!("{} {label}\n\n", "#".repeat((depth + 1).min(6))));
                    if key != "instructions"
                        && let Some(text) = fields[key].as_str()
                        && let Ok(parsed) = serde_json::from_str::<Value>(text)
                        && (parsed.is_object() || parsed.is_array())
                    {
                        render_value(&parsed, depth + 2, out);
                    } else {
                        render_value(&fields[key], depth + 2, out);
                    }
                }
                out.push_str(&format!(
                    "{} Attempt metadata\n\n",
                    "#".repeat(depth.min(6))
                ));
            }
            for (name, value) in fields {
                if conversation
                    && matches!(name.as_str(), "instructions" | "input" | "raw_response")
                {
                    continue;
                }
                out.push_str(&format!(
                    "{} {}\n\n",
                    "#".repeat(depth.min(6)),
                    name.replace('_', " ")
                ));
                render_value(value, depth + 1, out);
            }
        }
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("None recorded.\n\n");
            }
            for (index, item) in items.iter().enumerate() {
                out.push_str(&format!(
                    "{} Item {}\n\n",
                    "#".repeat(depth.min(6)),
                    index + 1
                ));
                render_value(item, depth + 1, out);
            }
        }
        Value::Null => out.push_str("Not reported.\n\n"),
        Value::String(text) => {
            // Fence exact text: evidence cannot supply active markup, links or images.
            let longest = text.split(|ch| ch != '`').map(str::len).max().unwrap_or(0);
            let fence = "`".repeat(3.max(longest + 1));
            out.push_str(&format!("{fence}text\n{text}\n{fence}\n\n"));
        }
        _ => out.push_str(&format!("{value}\n\n")),
    }
}

fn render_html(report: &str, markdown_link: &str) -> String {
    use pulldown_cmark::Event;
    use pulldown_cmark::Tag;
    use pulldown_cmark::TagEnd;
    let events = pulldown_cmark::Parser::new(report).filter_map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
        Event::Start(Tag::Link { .. } | Tag::Image { .. })
        | Event::End(TagEnd::Link | TagEnd::Image) => None,
        other => Some(other),
    });
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, events);
    format!(
        "<!doctype html><html lang=\"en\" data-theme=\"elpis-dashboard\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Elpis evidence</title><link rel=\"stylesheet\" href=\"/dashboard.css\"></head><body><main class=\"evidence-report\"><a class=\"link\" href=\"{markdown_link}\" download=\"evidence.md\">Download Markdown</a>{body}</main></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> tiny_http::Request {
        tiny_http::TestRequest::new().with_path(path).into()
    }

    #[test]
    fn evidence_report_contains_exact_marker_and_markdown_download() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("attempt.json");
        std::fs::write(
            &path,
            r#"{"input":"EVIDENCE_ACCESS_MARKER","saved_tokens":12,"usage":null}"#,
        )
        .unwrap();
        let mut evidence = Evidence::new();
        let id = evidence
            .register(dir.path(), "Smart Prune attempt", &path)
            .unwrap();
        for suffix in ["", ".md"] {
            let route = format!("/evidence/{}/{id}{suffix}", evidence.token);
            let result = evidence.route(&request(&route), 43123);
            assert_eq!(result.status_code().0, 200);
            let text = String::from_utf8(result.into_reader().into_inner()).unwrap();
            assert!(text.contains("EVIDENCE_ACCESS_MARKER"));
            assert!(text.contains("Not reported."));
        }
        assert_eq!(
            evidence
                .route(&request(&format!("/evidence/wrong/{id}")), 43123)
                .status_code()
                .0,
            403
        );
        evidence.entries.clear();
        assert_eq!(
            evidence
                .route(
                    &request(&format!("/evidence/{}/{id}", evidence.token)),
                    43123
                )
                .status_code()
                .0,
            404
        );
    }

    #[test]
    fn evidence_rejects_foreign_paths_and_origins() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let path = other.path().join("secret.json");
        std::fs::write(&path, "{}").unwrap();
        let mut evidence = Evidence::new();
        assert!(evidence.register(root.path(), "Foreign", &path).is_none());
        for route in [
            format!("/evidence/{}/../secret.json", evidence.token),
            format!("/evidence/{}/%2e%2e%2fsecret.json", evidence.token),
        ] {
            assert_eq!(evidence.route(&request(&route), 43123).status_code().0, 404);
        }
        let request = tiny_http::TestRequest::new()
            .with_path(&format!("/evidence/{}/index.json", evidence.token))
            .with_header(
                "Origin: https://example.com"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            )
            .into();
        assert_eq!(evidence.route(&request, 43123).status_code().0, 403);
        #[cfg(unix)]
        {
            let link = root.path().join("link.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(evidence.register(root.path(), "Symlink", &link).is_none());
        }
    }

    #[test]
    fn evidence_markup_is_inert_and_missing_usage_stays_unknown() {
        let mut report = String::new();
        render_value(
            &serde_json::json!({"input":"<script>alert(1)</script>\n```\n![leak](https://example.com)","usage":null}),
            2,
            &mut report,
        );
        let html = render_html(&report, "test.md");
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("Not reported."));
    }

    #[test]
    fn pruner_conversation_has_roles_and_unwraps_json_without_losing_text() {
        let mut report = String::new();
        render_value(
            &serde_json::json!({
                "instructions": "Keep the planted fact.",
                "input": "{\"active_request\":\"Find the planted fact\",\"items\":[]}",
                "raw_response": "{\"items\":[{\"decision\":\"compact\",\"content\":\"The planted fact is 42.\"}]}",
                "usage": null,
            }),
            2,
            &mut report,
        );
        for text in [
            "Pruner conversation",
            "System prompt",
            "Tool input",
            "Pruner response",
            "Keep the planted fact.",
            "The planted fact is 42.",
            "Attempt metadata",
            "Not reported.",
        ] {
            assert!(report.contains(text), "missing {text}");
        }
        let mut unrelated = String::new();
        render_value(
            &serde_json::json!({"input":"ordinary data"}),
            2,
            &mut unrelated,
        );
        assert!(!unrelated.contains("Pruner conversation"));
    }
}

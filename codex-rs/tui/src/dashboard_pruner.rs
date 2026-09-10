//! Capability-protected local optimizer settings; no arbitrary filesystem targets.
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::legacy_core::pruner_settings::DEFAULT_SYSTEM_PROMPT;
use crate::legacy_core::pruner_settings::PrunerSettings;

static HOME: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BODY: u64 = 131_072;

pub(super) fn configure(home: &Path) {
    if let Ok(mut value) = HOME.lock() {
        *value = Some(home.to_path_buf());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_settings_only_with_session_capability_and_same_origin_json() {
        let dir = tempfile::tempdir().unwrap();
        configure(dir.path());
        let token = super::super::evidence::dashboard_fragment()
            .trim_start_matches("#evidence=")
            .to_string();
        let request = |token: &str, origin: &str, body: &'static str| {
            tiny_http::TestRequest::new()
                .with_method(tiny_http::Method::Post)
                .with_path(&format!("/pruner-settings/{token}"))
                .with_header("Host: 127.0.0.1:43123".parse().unwrap())
                .with_header(format!("Origin: {origin}").parse().unwrap())
                .with_header("Content-Type: application/json".parse().unwrap())
                .with_body(body)
                .into()
        };
        let body = r#"{"model":"optimizer-test","system_prompt":"Retain planted marker 42."}"#;
        assert_eq!(
            route(
                &mut request(&token, "https://external.invalid", body),
                43123
            )
            .status_code()
            .0,
            403
        );
        assert_eq!(
            route(
                &mut request("invalid", "http://127.0.0.1:43123", body),
                43123
            )
            .status_code()
            .0,
            403
        );
        assert_eq!(
            PrunerSettings::load(dir.path()).unwrap(),
            PrunerSettings::default()
        );
        assert_eq!(
            route(&mut request(&token, "http://127.0.0.1:43123", body), 43123)
                .status_code()
                .0,
            200
        );
        let saved = PrunerSettings::load(dir.path()).unwrap();
        assert_eq!(saved.model.as_deref(), Some("optimizer-test"));
        assert_eq!(
            saved.system_prompt.as_deref(),
            Some("Retain planted marker 42.")
        );
        assert_eq!(
            route(
                &mut request(&token, "http://127.0.0.1:43123", r#"{"system_prompt":""}"#),
                43123
            )
            .status_code()
            .0,
            400
        );
        assert_eq!(PrunerSettings::load(dir.path()).unwrap(), saved);
    }
}

pub(super) fn route(request: &mut tiny_http::Request, port: u16) -> super::DashboardResponse {
    let error = |status, message: &str| {
        super::response(
            status,
            "text/plain; charset=utf-8",
            message.as_bytes().to_vec(),
        )
    };
    let Some(token) = request.url().strip_prefix("/pruner-settings/") else {
        return error(404, "Not found");
    };
    if !super::valid_host(request, port) || !super::evidence::valid_token(token) {
        return error(403, "Forbidden");
    }
    let Ok(home) = HOME.lock() else {
        return error(503, "Settings unavailable");
    };
    let Some(home) = home.as_ref() else {
        return error(503, "Open a dashboard from the active session first");
    };
    match request.method() {
        tiny_http::Method::Get => {}
        tiny_http::Method::Post => {
            let origin = format!("http://127.0.0.1:{port}");
            let same_origin = request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Origin") && h.value.as_str() == origin);
            let json = request.headers().iter().any(|h| {
                h.field.equiv("Content-Type")
                    && h.value.as_str().split(';').next() == Some("application/json")
            });
            if !same_origin || !json {
                return error(403, "Same-origin JSON required");
            }
            if request
                .body_length()
                .is_none_or(|size| size as u64 > MAX_BODY)
            {
                return error(413, "Settings body too large or missing length");
            }
            let mut bytes = Vec::new();
            if request
                .as_reader()
                .take(MAX_BODY + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_BODY
            {
                return error(400, "Cannot read settings");
            }
            let settings = match serde_json::from_slice::<PrunerSettings>(&bytes) {
                Ok(settings) => settings,
                Err(_) => return error(400, "Invalid settings JSON"),
            };
            if let Err(err) = settings.save(home) {
                return error(400, &err.to_string());
            }
        }
        _ => return error(405, "Method not allowed"),
    }
    match PrunerSettings::load(home) {
        Ok(settings) => super::response(
            200,
            "application/json",
            serde_json::json!({
                "settings": settings,
                "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
            })
            .to_string()
            .into_bytes(),
        ),
        Err(err) => error(500, &format!("Cannot read settings: {err}")),
    }
}

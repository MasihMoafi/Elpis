//! Elpis: the Smart Prune prompt editor, from v0.3.0's settings page.
//!
//! The pruner's model is chosen in the Models tab (`dashboard_models.rs`), so this page changes
//! the system prompt alone and keeps the saved model and provider. Settings live in
//! `pruner.json` (`core/src/pruner_settings.rs`), which core reads for each optimizer request.

use serde::Deserialize;

use super::DashboardLink;
use super::DashboardResponse;
use super::json_response;
use super::plain;
use crate::legacy_core::pruner_settings::DEFAULT_SYSTEM_PROMPT;
use crate::legacy_core::pruner_settings::PrunerSettings;

const MAX_BODY: u64 = 131_072;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptEdit {
    /// `None` restores the default prompt.
    system_prompt: Option<String>,
}

/// `GET /pruner-settings/<token>`: the saved settings. `POST`: a [`PromptEdit`].
pub(super) fn route(
    link: Option<&DashboardLink>,
    request: &mut tiny_http::Request,
    port: u16,
) -> DashboardResponse {
    match super::capability_path(request, port, "/pruner-settings/") {
        Ok("") => {}
        Ok(_) => return plain(404, "Not found"),
        Err(response) => return response,
    }
    let Some(link) = link else {
        return plain(503, "Open the dashboard from the active session first");
    };
    let home = link.home.as_path();
    match request.method() {
        tiny_http::Method::Get => {}
        tiny_http::Method::Post => {
            let bytes = match super::read_write_body(request, port, MAX_BODY) {
                Ok(bytes) => bytes,
                Err(response) => return response,
            };
            let Ok(edit) = serde_json::from_slice::<PromptEdit>(&bytes) else {
                return plain(400, "Send a system_prompt");
            };
            let saved = PrunerSettings::load(home).and_then(|mut settings| {
                settings.system_prompt = edit.system_prompt;
                settings.save(home)
            });
            if let Err(error) = saved {
                return plain(400, &format!("Not saved: {error}"));
            }
        }
        _ => return plain(405, "Method not allowed"),
    }
    match PrunerSettings::load(home) {
        Ok(settings) => json_response(&serde_json::json!({
            "settings": settings,
            "default_system_prompt": DEFAULT_SYSTEM_PROMPT,
        })),
        Err(error) => plain(500, &format!("Cannot read the settings: {error}")),
    }
}

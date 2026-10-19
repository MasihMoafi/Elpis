//! Elpis: provider API keys pasted into the dashboard, as v0.3.0's key page took them.
//!
//! The keys go to the gateway's store (`codex_elpis_gateway::save_provider_key`): one
//! owner-only file in the Elpis home, the one the terminal's "Add API key…" writes. The gateway
//! reads it for every request, so a saved key applies to the next one. A key is never sent back
//! to the page, logged or put in an error message; the page sees only where a key comes from
//! and a fixed mask.

use codex_elpis_gateway::KeySource;
use codex_model_provider_info::ModelProviderInfo;
use serde::Deserialize;

use super::DashboardLink;
use super::DashboardResponse;
use super::json_response;
use super::plain;
use crate::app_event::AppEvent;

const MAX_BODY: u64 = 16_384;
/// Fixed width, so the page never learns a key's length.
const MASK: &str = "••••••••";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderKeyEdit {
    provider: String,
    /// `None` forgets the saved key; the environment variable applies again.
    #[serde(default)]
    api_key: Option<String>,
}

fn source_name(source: KeySource) -> &'static str {
    match source {
        KeySource::Configured => "configured",
        KeySource::Saved => "saved",
        KeySource::Environment => "environment",
        KeySource::NotRequired => "not_required",
        KeySource::Missing => "missing",
    }
}

/// The providers that take a key here: those the gateway serves.
fn keyed(link: &DashboardLink) -> Vec<(String, String, &ModelProviderInfo, KeySource)> {
    crate::chatwidget::elpis_picker_providers(&link.providers, &link.active_provider)
        .into_iter()
        .filter_map(|(id, name)| {
            let provider = link.providers.get(&id)?;
            let source = codex_elpis_gateway::provider_key_source(&link.home, provider)?;
            Some((id, name, provider, source))
        })
        .collect()
}

fn rows(link: &DashboardLink) -> DashboardResponse {
    let rows: Vec<_> = keyed(link)
        .into_iter()
        .map(|(id, name, provider, source)| {
            let env_var =
                codex_model_provider_info::gateway_route(provider).and_then(|route| route.env_key);
            let has_key = matches!(
                source,
                KeySource::Configured | KeySource::Saved | KeySource::Environment
            );
            serde_json::json!({
                "id": id,
                "name": name,
                "env_var": env_var,
                "source": source_name(source),
                "masked": has_key.then_some(MASK),
            })
        })
        .collect();
    json_response(&serde_json::json!({ "providers": rows }))
}

/// `GET /provider-keys/<token>`: where each key comes from. `POST`: a [`ProviderKeyEdit`].
pub(super) fn route(
    link: Option<&DashboardLink>,
    request: &mut tiny_http::Request,
    port: u16,
) -> DashboardResponse {
    match super::capability_path(request, port, "/provider-keys/") {
        Ok("") => {}
        Ok(_) => return plain(404, "Not found"),
        Err(response) => return response,
    }
    let Some(link) = link else {
        return plain(503, "Open the dashboard from the active session first");
    };
    match request.method() {
        tiny_http::Method::Get => rows(link),
        tiny_http::Method::Post => {
            let bytes = match super::read_write_body(request, port, MAX_BODY) {
                Ok(bytes) => bytes,
                Err(response) => return response,
            };
            // The body carries the key, so a parse failure is reported without it.
            let Ok(edit) = serde_json::from_slice::<ProviderKeyEdit>(&bytes) else {
                return plain(400, "Send a provider id and an api_key");
            };
            let Some((_, name, _, source)) = keyed(link)
                .into_iter()
                .find(|(id, ..)| *id == edit.provider)
            else {
                return plain(404, "This provider does not take an API key here");
            };
            if source == KeySource::Configured {
                return plain(
                    409,
                    "This provider's key is set in config.toml, which comes first; change it there",
                );
            }
            let (saved, done) = match &edit.api_key {
                Some(key) => (
                    codex_elpis_gateway::save_provider_key(&link.home, &edit.provider, key),
                    "saved",
                ),
                None => (
                    codex_elpis_gateway::remove_provider_key(&link.home, &edit.provider),
                    "removed",
                ),
            };
            // The store's errors never contain the key.
            if let Err(error) = saved {
                return plain(400, &format!("The key was not saved: {error}"));
            }
            link.tx.send(AppEvent::InsertHistoryCell(Box::new(
                crate::history_cell::new_info_event(
                    format!(
                        "{name} key {done} from the dashboard. It applies to the next request."
                    ),
                    /*hint*/ None,
                ),
            )));
            rows(link)
        }
        _ => plain(405, "Method not allowed"),
    }
}

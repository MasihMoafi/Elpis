//! Elpis: the dashboard's Models tab.
//!
//! The page lists a provider's models the way the `/model` picker does, and a choice goes
//! through the writer the terminal uses: the chat model through the picker's switch
//! (`ElpisProviderEvent::Switch`), the background model through `/memory-model`'s save
//! (`ElpisAppEvent::SaveBackgroundModel`) and the Smart Prune model through `/pruner-model`'s
//! `save_pruner_choice` (`pruner.json`). Each applies to the next request.
//!
//! A choice names a provider and a model that provider listed, so a model never lands on a
//! provider that cannot serve it.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::openai_models::ModelPreset;
use serde::Deserialize;
use serde::Serialize;

use super::DashboardResponse;
use super::json_response;
use super::plain;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::chatwidget::ElpisProviderEvent;
use crate::elpis_app_event::ElpisAppEvent;
use crate::elpis_background_model::BackgroundModelChoice;

const MAX_BODY: u64 = 4_096;
/// The gateway gives up on a vendor's list after 10 s and on a connection after 30 s.
const LIST_TIMEOUT: Duration = Duration::from_secs(45);

/// One role's model as the page shows it. `model: None` is the built-in default.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardModelChoice {
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct DashboardModels {
    pub(crate) chat: DashboardModelChoice,
    pub(crate) background: DashboardModelChoice,
    pub(crate) pruner: DashboardModelChoice,
}

/// What the page needs from the running App. The App registers a new one each time it
/// publishes the page's state.
pub(crate) struct DashboardLink {
    pub(crate) tx: AppEventSender,
    pub(crate) home: PathBuf,
    pub(crate) providers: HashMap<String, ModelProviderInfo>,
    /// The provider this conversation runs on.
    pub(crate) active_provider: String,
    /// The app server's model list, for the provider it started with.
    pub(crate) catalog: Vec<ModelPreset>,
    /// The provider a pruner model runs on when `pruner.json` names none.
    pub(crate) pruner_role_provider: String,
    /// Runs the vendor model lists.
    pub(crate) runtime: Option<tokio::runtime::Handle>,
    /// Set once a refresh is asked for; a new link (a new publication) starts clear.
    pub(crate) refresh_pending: AtomicBool,
}

impl DashboardLink {
    /// Asks the App to republish the page's state, once per publication.
    pub(super) fn request_refresh(&self) {
        if !self.refresh_pending.swap(true, Ordering::AcqRel) {
            self.tx
                .send(AppEvent::Elpis(ElpisAppEvent::RefreshDashboard));
        }
    }

    /// A provider's models as the `/model` picker lists them.
    fn list(&self, provider_id: &str) -> Result<Vec<ModelPreset>, String> {
        let provider = self
            .providers
            .get(provider_id)
            .ok_or_else(|| format!("No provider `{provider_id}` is configured"))?;
        let presets = if crate::chatwidget::elpis_lists_from_app_server(provider_id, provider) {
            self.catalog.clone()
        } else {
            let runtime = self
                .runtime
                .as_ref()
                .ok_or_else(|| "Elpis cannot list models right now".to_string())?;
            let (tx, rx) = std::sync::mpsc::channel();
            let home = self.home.clone();
            let id = provider_id.to_string();
            let provider = provider.clone();
            runtime.spawn(async move {
                let _ = tx
                    .send(crate::chatwidget::load_elpis_provider_models(home, id, provider).await);
            });
            rx.recv_timeout(LIST_TIMEOUT)
                .map_err(|_| "The provider did not list its models in time".to_string())??
        };
        let presets: Vec<ModelPreset> = presets
            .into_iter()
            .filter(|preset| preset.show_in_picker)
            .collect();
        if let Ok(mut listed) = LISTED.lock() {
            listed.insert(
                provider_id.to_string(),
                presets.iter().map(|preset| preset.model.clone()).collect(),
            );
        }
        Ok(presets)
    }

    /// Whether `provider_id` lists `model`, asking the provider when the page has not.
    fn serves(&self, provider_id: &str, model: &str) -> Result<bool, String> {
        let known = LISTED
            .lock()
            .ok()
            .and_then(|listed| listed.get(provider_id).cloned());
        let models = match known {
            Some(models) if models.iter().any(|listed| listed == model) => return Ok(true),
            Some(_) | None => self
                .list(provider_id)?
                .into_iter()
                .map(|preset| preset.model)
                .collect::<Vec<_>>(),
        };
        Ok(models.iter().any(|listed| listed == model))
    }
}

static LINK: Mutex<Option<Arc<DashboardLink>>> = Mutex::new(None);
/// The model ids each provider listed last.
static LISTED: Mutex<BTreeMap<String, Vec<String>>> = Mutex::new(BTreeMap::new());

pub(crate) fn register_link(link: DashboardLink) {
    if let Ok(mut slot) = LINK.lock() {
        *slot = Some(Arc::new(link));
    }
}

pub(super) fn current_link() -> Option<Arc<DashboardLink>> {
    LINK.lock().ok().and_then(|slot| slot.clone())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    Chat,
    Background,
    Pruner,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelEdit {
    role: Role,
    /// `None` with `model: None` restores the built-in default (not for the chat model).
    provider: Option<String>,
    model: Option<String>,
}

/// `GET /models/<token>`: the providers. `GET /models/<token>/<provider>`: its models.
/// `POST /models/<token>`: a [`ModelEdit`].
pub(super) fn route(
    link: Option<&DashboardLink>,
    request: &mut tiny_http::Request,
    port: u16,
) -> DashboardResponse {
    let path = match super::capability_path(request, port, "/models/") {
        Ok(path) => path.to_string(),
        Err(response) => return response,
    };
    let Some(link) = link else {
        return plain(503, "Open the dashboard from the active session first");
    };
    match (request.method(), path.as_str()) {
        (tiny_http::Method::Get, "") => providers(link),
        (tiny_http::Method::Get, provider_id) => match link.list(provider_id) {
            Ok(presets) => json_response(&serde_json::json!({
                "provider": provider_id,
                "models": presets
                    .iter()
                    .map(|preset| serde_json::json!({
                        "id": preset.model,
                        "name": preset.display_name,
                        "description": preset.description,
                    }))
                    .collect::<Vec<_>>(),
            })),
            Err(error) => plain(502, &format!("Could not list its models: {error}")),
        },
        (tiny_http::Method::Post, "") => {
            let bytes = match super::read_write_body(request, port, MAX_BODY) {
                Ok(bytes) => bytes,
                Err(response) => return response,
            };
            let Ok(edit) = serde_json::from_slice::<ModelEdit>(&bytes) else {
                return plain(400, "Send a role, a provider and a model");
            };
            match apply(link, edit) {
                Ok(message) => {
                    link.request_refresh();
                    json_response(&serde_json::json!({ "message": message }))
                }
                Err((status, message)) => plain(status, &message),
            }
        }
        _ => plain(405, "Method not allowed"),
    }
}

fn providers(link: &DashboardLink) -> DashboardResponse {
    let rows: Vec<_> =
        crate::chatwidget::elpis_picker_providers(&link.providers, &link.active_provider)
            .into_iter()
            .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
            .collect();
    json_response(&serde_json::json!({ "providers": rows }))
}

/// Applies a choice through the terminal's own writer and says what happens next.
fn apply(link: &DashboardLink, edit: ModelEdit) -> Result<String, (u16, String)> {
    let choice = match (edit.provider, edit.model) {
        (None, None) if !matches!(edit.role, Role::Chat) => BackgroundModelChoice {
            model: None,
            provider: Some(None),
        },
        (Some(provider), Some(model)) => {
            if !link.providers.contains_key(&provider) {
                return Err((400, format!("No provider `{provider}` is configured")));
            }
            match link.serves(&provider, &model) {
                Ok(true) => {}
                Ok(false) => {
                    return Err((
                        400,
                        format!("`{provider}` does not list `{model}`; pick a model from its list"),
                    ));
                }
                Err(error) => return Err((502, error)),
            }
            BackgroundModelChoice {
                model: Some(model),
                provider: Some(Some(provider)),
            }
        }
        _ => return Err((400, "Pick a provider and one of its models".to_string())),
    };
    match edit.role {
        Role::Chat => {
            let (Some(model), Some(Some(provider_id))) = (choice.model, choice.provider) else {
                return Err((400, "Pick a provider and one of its models".to_string()));
            };
            link.tx.send(AppEvent::Elpis(ElpisAppEvent::Provider(
                ElpisProviderEvent::Switch { provider_id, model },
            )));
            Ok(
                "Sent to Elpis. The next answer uses it; the terminal confirms the change."
                    .to_string(),
            )
        }
        Role::Background => {
            link.tx
                .send(AppEvent::Elpis(ElpisAppEvent::SaveBackgroundModel(choice)));
            Ok("Sent to Elpis. It is saved and used for the next background request.".to_string())
        }
        Role::Pruner => {
            let chosen = crate::chatwidget::elpis_prune_commands::save_pruner_choice(
                &link.home,
                &choice,
                &link.pruner_role_provider,
            )
            .map_err(|error| (500, format!("Smart Prune model was not changed: {error}")))?;
            let message = format!(
                "Smart Prune model saved: {chosen}. Applies to the next optimizer request; chat model unchanged."
            );
            link.tx.send(AppEvent::InsertHistoryCell(Box::new(
                crate::history_cell::new_info_event(
                    format!("{message} (from the dashboard)"),
                    /*hint*/ None,
                ),
            )));
            Ok(message)
        }
    }
}

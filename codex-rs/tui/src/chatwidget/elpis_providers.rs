//! Elpis: the provider-aware `/model` picker ("Choose a mind") from v0.3.0.
//!
//! Every model picker names the provider the thread runs on, how Elpis reaches it, its wire
//! protocol and where its key comes from, and offers "Change provider…" and, while the provider
//! has no key, "Add API key…". The app server lists models only for the provider the process
//! started with, so a provider browsed here, or switched to, lists its own models through the
//! Elpis gateway library.

use std::sync::PoisonError;
use std::sync::RwLock;

use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use codex_elpis_gateway::KeySource;
use codex_model_provider_info::ModelProviderInfo;

pub(super) const ELPIS_PROVIDER_SELECTION_VIEW_ID: &str = "elpis-provider-selection";
pub(super) const ELPIS_PROVIDER_MODELS_VIEW_ID: &str = "elpis-provider-models";

/// The provider whose models the app server lists: the one the process started with.
static CATALOG_PROVIDER: RwLock<Option<String>> = RwLock::new(None);

/// Records the provider the app server started with. Called once before the app runs.
pub(crate) fn set_elpis_catalog_provider(provider_id: &str) {
    *CATALOG_PROVIDER
        .write()
        .unwrap_or_else(PoisonError::into_inner) = Some(provider_id.to_string());
}

pub(crate) fn elpis_catalog_provider() -> Option<String> {
    CATALOG_PROVIDER
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// A pasted API key. Its debug form never shows the key.
pub(crate) struct ElpisSecret(pub(crate) String);

impl std::fmt::Debug for ElpisSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ElpisSecret(••••)")
    }
}

/// Picker actions that need the app: listing a provider's models, saving a key, switching.
#[derive(Debug)]
pub(crate) enum ElpisProviderEvent {
    /// Open the provider list ("Change provider…").
    OpenProviders,
    /// List a provider's models.
    Browse { provider_id: String },
    /// A provider's models arrived.
    ModelsLoaded {
        provider_id: String,
        result: Result<Vec<ModelPreset>, String>,
    },
    /// Ask for a provider's key ("Add API key…").
    OpenKeyPrompt { provider_id: String },
    /// Save a pasted key into the Elpis home.
    SaveKey {
        provider_id: String,
        key: ElpisSecret,
    },
    /// Continue this conversation on `provider_id` with `model`.
    Switch { provider_id: String, model: String },
}

fn send(tx: &AppEventSender, event: ElpisProviderEvent) {
    tx.send(AppEvent::Elpis(ElpisAppEvent::Provider(event)));
}

/// Where the owner mints a key for a built-in provider.
fn api_key_url(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        codex_model_provider_info::ANTHROPIC_PROVIDER_ID => {
            Some("https://console.anthropic.com/settings/keys")
        }
        codex_model_provider_info::GOOGLE_GEMINI_PROVIDER_ID => {
            Some("https://aistudio.google.com/apikey")
        }
        codex_model_provider_info::OPENROUTER_PROVIDER_ID => Some("https://openrouter.ai/keys"),
        _ => None,
    }
}

/// Lists a provider's models for the picker: a gateway provider asks its vendor, OpenAI uses
/// the bundled catalog, and any other provider is listed only by the app server it started.
pub(crate) async fn load_elpis_provider_models(
    home: PathBuf,
    provider_id: String,
    provider: ModelProviderInfo,
) -> Result<Vec<ModelPreset>, String> {
    let catalog = match codex_elpis_gateway::provider_models(&home, &provider).await {
        Some(result) => result?,
        None if provider.is_openai() => {
            codex_models_manager::bundled_models_response().map_err(|error| error.to_string())?
        }
        None => {
            return Err(format!(
                "Elpis lists the models of `{provider_id}` when it starts with it: set \
                 model_provider = \"{provider_id}\" in config.toml and restart"
            ));
        }
    };
    let mut models = catalog.models;
    models.sort_by_key(|model| model.priority);
    let mut presets: Vec<ModelPreset> = models.into_iter().map(Into::into).collect();
    ModelPreset::mark_default_by_picker_visibility(&mut presets);
    Ok(presets)
}

impl ChatWidget {
    fn elpis_provider(&self, provider_id: &str) -> Option<&ModelProviderInfo> {
        self.config.model_providers.get(provider_id)
    }

    fn elpis_provider_name(&self, provider_id: &str) -> String {
        self.elpis_provider(provider_id)
            .map(|provider| provider.name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| provider_id.to_string())
    }

    fn elpis_key_source(&self, provider_id: &str) -> Option<KeySource> {
        let provider = self.elpis_provider(provider_id)?;
        codex_elpis_gateway::provider_key_source(self.config.codex_home.as_path(), provider)
    }

    pub(super) fn elpis_needs_key(&self, provider_id: &str) -> bool {
        self.elpis_key_source(provider_id) == Some(KeySource::Missing)
    }

    /// What it takes for this provider to answer, as the picker says it.
    fn elpis_credential_label(&self, provider_id: &str) -> String {
        let env_key = self
            .elpis_provider(provider_id)
            .and_then(codex_model_provider_info::gateway_route)
            .and_then(|route| route.env_key);
        match self.elpis_key_source(provider_id) {
            Some(KeySource::Configured) => "key in config.toml".to_string(),
            Some(KeySource::Saved) => "key saved in this Elpis home".to_string(),
            Some(KeySource::Environment) => {
                format!("environment variable {}", env_key.unwrap_or_default())
            }
            Some(KeySource::NotRequired) => "none required".to_string(),
            Some(KeySource::Missing) => match env_key {
                Some(env_key) => format!("missing · set {env_key} or add a key"),
                None => "missing · add a key".to_string(),
            },
            None => match self.elpis_provider(provider_id) {
                Some(provider) if provider.aws.is_some() => "your AWS credentials".to_string(),
                Some(provider) if provider.requires_openai_auth => {
                    "your OpenAI sign-in".to_string()
                }
                _ => "none required".to_string(),
            },
        }
    }

    /// Provider, route, protocol and credential of the provider a picker lists.
    pub(super) fn elpis_provider_header_lines(&self, provider_id: &str) -> Vec<Line<'static>> {
        let name = self.elpis_provider_name(provider_id);
        let (route, protocol) = match self
            .elpis_provider(provider_id)
            .and_then(codex_model_provider_info::gateway_route)
        {
            Some(route) => (
                format!("Elpis gateway → {}", route.upstream_base_url),
                route.wire.display_name().to_string(),
            ),
            None => (
                self.elpis_provider(provider_id)
                    .and_then(|provider| provider.base_url.clone())
                    .unwrap_or_else(|| "the provider's default endpoint".to_string()),
                "OpenAI Responses".to_string(),
            ),
        };
        let credential = self.elpis_credential_label(provider_id);
        vec![
            Line::from(format!("Provider: {name} ({provider_id})").dim()),
            Line::from(format!("Route: {route}").dim()),
            Line::from(format!("Protocol: {protocol}").dim()),
            Line::from(format!("Credential: {credential}").dim()),
        ]
    }

    /// "Change provider…" and, while `provider_id` has no key, "Add API key…", each with the id
    /// the picker uses to keep its highlight. They open each list, as in v0.3.0.
    pub(super) fn elpis_picker_rows(&self, provider_id: &str) -> Vec<(String, SelectionItem)> {
        let mut rows = vec![(
            "elpis:change-provider".to_string(),
            SelectionItem {
                name: "Change provider…".to_string(),
                description: Some(format!(
                    "Currently {}",
                    self.elpis_provider_name(provider_id)
                )),
                actions: vec![Box::new(|tx| send(tx, ElpisProviderEvent::OpenProviders))],
                dismiss_on_select: true,
                ..Default::default()
            },
        )];
        if self.elpis_needs_key(provider_id) {
            let description = match api_key_url(provider_id) {
                Some(url) => format!("Paste it here · get one at {url}"),
                None => "Paste it here; it is saved in this Elpis home".to_string(),
            };
            let provider_for_action = provider_id.to_string();
            rows.push((
                "elpis:add-api-key".to_string(),
                SelectionItem {
                    name: "Add API key…".to_string(),
                    description: Some(description),
                    actions: vec![Box::new(move |tx| {
                        send(
                            tx,
                            ElpisProviderEvent::OpenKeyPrompt {
                                provider_id: provider_for_action.clone(),
                            },
                        );
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ));
        }
        rows
    }

    /// For `/model` on a thread whose provider the app server does not list: list that
    /// provider's models here instead. Returns whether it did.
    pub(super) fn elpis_open_model_popup_for_other_provider(&self) -> bool {
        let provider_id = self.config.model_provider_id.clone();
        if elpis_catalog_provider().is_none_or(|catalog| catalog == provider_id) {
            return false;
        }
        send(
            &self.app_event_tx,
            ElpisProviderEvent::Browse { provider_id },
        );
        true
    }

    /// Every configured provider, each with what it needs to answer.
    pub(crate) fn open_elpis_provider_popup(&mut self) {
        let active = self.config.model_provider_id.clone();
        let mut providers: Vec<(String, String)> = self
            .config
            .model_providers
            .keys()
            .map(|id| (id.clone(), self.elpis_provider_name(id)))
            .collect();
        providers.sort_by_key(|(_, name)| name.to_lowercase());
        let items: Vec<SelectionItem> = providers
            .into_iter()
            .map(|(id, name)| {
                let provider_for_action = id.clone();
                SelectionItem {
                    description: Some(self.elpis_credential_label(&id)),
                    search_value: Some(format!("{name} {id}")),
                    is_current: id == active,
                    name,
                    actions: vec![Box::new(move |tx| {
                        send(
                            tx,
                            ElpisProviderEvent::Browse {
                                provider_id: provider_for_action.clone(),
                            },
                        );
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.bottom_pane.show_selection_view(SelectionViewParams {
            view_id: Some(ELPIS_PROVIDER_SELECTION_VIEW_ID),
            title: Some("Choose a provider".to_string()),
            subtitle: Some(
                "The next step lists that provider's own models; nothing changes until you pick one"
                    .to_string(),
            ),
            items,
            is_searchable: true,
            search_placeholder: Some("Search providers".to_string()),
            initial_selected_idx,
            ..SelectionViewParams::picker()
        });
    }

    /// A provider's models. Picking one on another provider continues this conversation there.
    pub(crate) fn open_elpis_provider_models(
        &mut self,
        provider_id: String,
        result: Result<Vec<ModelPreset>, String>,
    ) {
        let is_active = provider_id == self.config.model_provider_id;
        let current_model = self.current_model().to_string();
        let mut items: Vec<SelectionItem> = Vec::new();
        let (presets, subtitle) = match result {
            Ok(presets) => {
                let presets: Vec<ModelPreset> = presets
                    .into_iter()
                    .filter(|preset| preset.show_in_picker)
                    .collect();
                let subtitle = if presets.is_empty() {
                    "This provider lists no models right now.".to_string()
                } else if is_active {
                    "Pick a model for this conversation.".to_string()
                } else {
                    "Picking a model continues this conversation on this provider.".to_string()
                };
                (presets, subtitle)
            }
            Err(error) => (Vec::new(), format!("Could not list its models: {error}")),
        };
        for preset in presets {
            let model = preset.model.clone();
            let provider_for_action = provider_id.clone();
            let model_for_action = model.clone();
            items.push(SelectionItem {
                name: preset.display_name.clone(),
                description: (!preset.description.is_empty()).then_some(preset.description.clone()),
                // Searchable rows need a search value, or a search hides them.
                search_value: Some(format!("{} {model}", preset.display_name)),
                is_current: is_active && model == current_model,
                is_default: preset.is_default,
                actions: vec![Box::new(move |tx| {
                    send(
                        tx,
                        ElpisProviderEvent::Switch {
                            provider_id: provider_for_action.clone(),
                            model: model_for_action.clone(),
                        },
                    );
                })],
                dismiss_on_select: true,
                ..Default::default()
            });
        }
        let elpis_rows = self.elpis_picker_rows(&provider_id);
        let first_model = elpis_rows.len();
        items.splice(0..0, elpis_rows.into_iter().map(|(_, item)| item));
        let mut header = vec![
            Line::from("Choose a mind".bold()),
            Line::from(subtitle.dim()),
        ];
        header.extend(self.elpis_provider_header_lines(&provider_id));
        // Searchable, since a provider such as OpenRouter lists hundreds of models; the current
        // model starts highlighted.
        let initial_selected_idx = items
            .iter()
            .position(|item| item.is_current)
            .or((items.len() > first_model).then_some(first_model));
        self.bottom_pane.show_selection_view(SelectionViewParams {
            view_id: Some(ELPIS_PROVIDER_MODELS_VIEW_ID),
            items,
            header: Box::new(Paragraph::new(header).wrap(Wrap { trim: false })),
            is_searchable: true,
            search_placeholder: Some("Search models".to_string()),
            initial_selected_idx,
            ..SelectionViewParams::picker()
        });
    }

    /// Ask for a provider's key in the terminal, shown as bullets while it is typed.
    pub(crate) fn open_elpis_api_key_prompt(&mut self, provider_id: String) {
        let name = self.elpis_provider_name(&provider_id);
        if self.elpis_key_source(&provider_id).is_none() {
            self.add_info_message(
                format!("{name} does not take an API key here."),
                /*hint*/ None,
            );
            return;
        }
        let context = match api_key_url(&provider_id) {
            Some(url) => format!("Get a key at {url} · saved in this Elpis home, for you alone"),
            None => "Saved in this Elpis home, readable by you alone".to_string(),
        };
        let tx = self.app_event_tx.clone();
        let view = CustomPromptView::new(
            format!("{name} API key"),
            "Paste the key and press Enter".to_string(),
            /*initial_text*/ String::new(),
            Some(context),
            Box::new(move |key: String| {
                send(
                    &tx,
                    ElpisProviderEvent::SaveKey {
                        provider_id: provider_id.clone(),
                        key: ElpisSecret(key),
                    },
                );
            }),
        )
        .masked();
        self.bottom_pane.show_view(Box::new(view));
    }

    /// Store a pasted key, then list the provider's models with it.
    pub(crate) fn save_elpis_provider_key(&mut self, provider_id: String, key: ElpisSecret) {
        let name = self.elpis_provider_name(&provider_id);
        match codex_elpis_gateway::save_provider_key(
            self.config.codex_home.as_path(),
            &provider_id,
            &key.0,
        ) {
            Ok(()) => {
                self.add_info_message(
                    format!("{name} key saved."),
                    Some(
                        "Stored in this Elpis home, readable by you alone. It is used before the \
                         environment variable."
                            .to_string(),
                    ),
                );
                send(
                    &self.app_event_tx,
                    ElpisProviderEvent::Browse { provider_id },
                );
            }
            Err(error) => {
                self.add_error_message(format!("Could not save the {name} key: {error}"));
            }
        }
    }
}

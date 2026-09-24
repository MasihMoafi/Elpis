// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Model, collaboration, and reasoning popups for `ChatWidget`.
//!
//! These surfaces are tightly related because changing one often redirects
//! into another, especially while Plan mode is active.

use super::*;
use codex_model_provider_info::OLLAMA_OSS_PROVIDER_ID;
use codex_model_provider_info::OPENAI_PROVIDER_ID;
use codex_model_provider_info::OPENROUTER_PROVIDER_ID;
use ratatui::text::Span;

const ULTRA_REASONING_CONCURRENCY_WARNING_THRESHOLD: usize = 8;
/// How many of a provider's models fit in the picker before the rest move
/// behind "All models". Every provider Elpis ships a catalogue for is under
/// this; OpenRouter's live list is not.
const INLINE_MODEL_ROW_LIMIT: usize = 12;
const OLLAMA_MODELS_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
/// OpenRouter is a remote service, so it gets a longer budget than local Ollama.
const OPENROUTER_MODELS_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);
/// Families worth offering in the picker. OpenRouter lists hundreds of models and
/// its API carries no quality signal, so the alternative to naming the families is
/// inventing a ranking. Price and context window still come from the live response.
const OPENROUTER_TOP_TIER_FAMILIES: &[&str] = &[
    "anthropic/",
    "openai/",
    "google/",
    "deepseek/",
    "x-ai/",
    "qwen/",
    "moonshotai/",
    "mistralai/",
    "meta-llama/",
];
/// Which model a picker is choosing. Each role keeps its own provider, so the
/// provider step has to know which one it is stepping into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelPickerRole {
    /// The model that answers the user.
    Chat,
    /// The model that saves memory, names sessions and prunes when the pruner
    /// has no model of its own.
    Memory,
    /// The model that prunes tool output.
    Pruner,
}

/// A token count as people say it: 1M, not 1048k.
///
/// A million is a million even when the provider's real number is 1,048,576,
/// so anything from a million up reads in M with at most one decimal.
pub(super) fn token_count_label(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        let millions = tokens as f64 / 1_000_000.0;
        let rounded = (millions * 10.0).round() / 10.0;
        if (rounded - rounded.round()).abs() < f64::EPSILON {
            format!("{}M", rounded.round() as u64)
        } else {
            format!("{rounded:.1}M")
        }
    } else if tokens >= 1_000 {
        format!("{}k", tokens / 1_000)
    } else {
        tokens.to_string()
    }
}

pub(super) const PROVIDER_SELECTION_VIEW_ID: &str = "provider-selection";
pub(super) const MODEL_SELECTION_VIEW_ID: &str = "model-selection";
pub(super) const ALL_MODELS_SELECTION_VIEW_ID: &str = "all-models-selection";
pub(super) const PRUNER_MODEL_SELECTION_VIEW_ID: &str = "pruner-model-selection";
pub(super) const BACKGROUND_MODEL_SELECTION_VIEW_ID: &str = "memory-model-selection";

impl ChatWidget {
    /// Every configured provider, so a model can be chosen from any of them
    /// rather than only from the one the session already points at.
    pub(crate) fn open_model_provider_popup(&mut self, role: ModelPickerRole) {
        let active = match role {
            ModelPickerRole::Chat | ModelPickerRole::Pruner => {
                self.active_model_provider_id().to_string()
            }
            ModelPickerRole::Memory => self.background_provider_id().to_string(),
        };
        let mut providers: Vec<(String, String, Option<String>)> = self
            .config
            .model_providers
            .iter()
            .map(|(id, info)| (id.clone(), info.name.clone(), info.env_key.clone()))
            .collect();
        providers.sort_by(|left, right| left.1.to_lowercase().cmp(&right.1.to_lowercase()));

        let items: Vec<SelectionItem> = providers
            .into_iter()
            .map(|(id, name, env_key)| {
                let is_current = id == active;
                // Say whether this provider can answer at all, so an empty model
                // list later is explained before it happens rather than after.
                let description = Some(self.provider_credential_label(&id, env_key.as_deref()));
                let provider_for_action = id.clone();
                // Searchable by both the shown name and the id typed in config,
                // so "deepseek" finds "DeepSeek".
                let search_value = Some(format!("{name} {id}"));
                SelectionItem {
                    name,
                    description,
                    search_value,
                    is_current,
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::BrowseModelProvider {
                            role,
                            provider_id: provider_for_action.clone(),
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();

        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(PROVIDER_SELECTION_VIEW_ID),
            initial_selected_idx,
            title: Some("Choose a provider".into()),
            subtitle: Some(
                "The next step lists that provider's own models; nothing is saved until you pick one"
                    .to_string(),
            ),
            items,
            is_searchable: true,
            search_placeholder: Some("Search providers".into()),
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        });
    }

    /// Point the open picker at another provider and list its models. Nothing is
    /// written until a model is chosen.
    pub(crate) fn browse_model_provider(&mut self, role: ModelPickerRole, provider_id: String) {
        self.browsing_provider = Some(provider_id.clone());
        match role {
            // `open_model_popup` asks for the catalogue itself; asking here too
            // fired two requests and left the first one stale.
            ModelPickerRole::Chat => self.open_model_popup(),
            ModelPickerRole::Memory => {
                self.request_model_catalog(Some(provider_id));
                self.refresh_background_model_popup();
            }
            ModelPickerRole::Pruner => {
                self.request_model_catalog(Some(provider_id));
                self.refresh_pruner_model_popup();
            }
        }
    }

    /// The provider a picker should list: the one being browsed, else the role's own.
    pub(super) fn picker_provider_id(&self, role: ModelPickerRole) -> String {
        if let Some(provider) = self.browsing_provider.as_ref() {
            return provider.clone();
        }
        match role {
            ModelPickerRole::Chat | ModelPickerRole::Pruner => {
                self.active_model_provider_id().to_string()
            }
            ModelPickerRole::Memory => self.background_provider_id().to_string(),
        }
    }

    /// The provider a pick should carry with it: set only while a provider is
    /// being browsed, so an ordinary pick on the session's own provider keeps
    /// its existing path (plan-mode scope prompt, ultra-reasoning warning).
    pub(super) fn picker_target_provider(&self) -> Option<String> {
        self.browsing_provider.clone()
    }

    /// Whether a provider can authenticate right now: it needs no key, or one
    /// is set in the environment or in this Elpis home.
    ///
    /// Mirrors Zed's `ApiKeyState::has_key` and Phoenix's `isProviderReady`:
    /// the picker says so before the request fails, not after.
    pub(super) fn provider_has_key(&self, provider_id: &str) -> bool {
        let Some(info) = self.config.model_providers.get(provider_id) else {
            return false;
        };
        // Credentials that are not an API key the owner could type here:
        // the ChatGPT sign-in store, a bearer token, a command, AWS SigV4.
        if info.requires_openai_auth
            || info.experimental_bearer_token.is_some()
            || info.auth.is_some()
            || info.aws.is_some()
        {
            return true;
        }
        match info.env_key.as_deref() {
            None => true,
            Some(_) => info
                .api_key()
                .ok()
                .flatten()
                .is_some_and(|key| !key.trim().is_empty()),
        }
    }

    /// The environment variable a provider reads its key from, if it reads one.
    /// What it takes to make this provider answer. A missing `env_key` does not
    /// mean a free ride: OpenAI wants a sign-in and Bedrock wants AWS
    /// credentials, and saying "no key needed" there strands a new user on an
    /// empty model list.
    fn provider_credential_label(&self, provider_id: &str, env_key: Option<&str>) -> String {
        if let Some(env_key) = env_key {
            return if self.provider_has_key(provider_id) {
                format!("key set · {env_key}")
            } else {
                "needs an API key · paste one after picking a model".to_string()
            };
        }
        match self.config.model_providers.get(provider_id) {
            Some(info) if info.aws.is_some() => "uses your AWS credentials".to_string(),
            Some(info) if info.requires_openai_auth || info.is_openai() => {
                "uses your OpenAI sign-in".to_string()
            }
            _ => "runs locally · no key needed".to_string(),
        }
    }

    fn provider_env_key(&self, provider_id: &str) -> Option<String> {
        self.config
            .model_providers
            .get(provider_id)
            .and_then(|info| info.env_key.clone())
    }

    fn provider_display_name(&self, provider_id: &str) -> String {
        self.config
            .model_providers
            .get(provider_id)
            .map(|info| info.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| provider_id.to_string())
    }

    /// Ask for the provider's key in the terminal, masked while it is typed.
    ///
    /// The two ways in are both on screen: paste it here, or open the
    /// dashboard's key page. Nothing about the provider changes until a key
    /// lands, so Esc leaves the session exactly as it was.
    pub(crate) fn open_provider_api_key_prompt(
        &mut self,
        role: ModelPickerRole,
        provider_id: String,
        then_model: Option<String>,
    ) {
        let name = self.provider_display_name(&provider_id);
        let Some(env_key) = self.provider_env_key(&provider_id) else {
            self.add_info_message(
                format!("{name} does not take an API key."),
                /*hint*/ None,
            );
            return;
        };
        let from_env = std::env::var(&env_key)
            .ok()
            .is_some_and(|value| !value.trim().is_empty());
        if from_env {
            self.add_info_message(
                format!("{name} already reads its key from {env_key}."),
                Some("Unset that variable to type a different key here.".to_string()),
            );
            return;
        }
        let where_to_get = codex_model_provider_info::provider_api_key_url(&provider_id)
            .map(|url| format!("Get a key at {url} · "))
            .unwrap_or_default();
        let context_label = format!("{where_to_get}or paste it in /dashboard → Keys");
        let tx = self.app_event_tx.clone();
        let provider_for_submit = provider_id.clone();
        let view = CustomPromptView::new(
            format!("{name} API key"),
            "Paste the key and press Enter".to_string(),
            /*initial_text*/ String::new(),
            Some(context_label),
            Box::new(move |key: String| {
                tx.send(AppEvent::SaveProviderApiKey {
                    role,
                    provider_id: provider_for_submit.clone(),
                    key,
                    then_model: then_model.clone(),
                });
            }),
        )
        .masked();
        self.bottom_pane.show_view(Box::new(view));
    }

    /// Store the pasted key and carry on where the owner left off.
    pub(crate) fn save_provider_api_key(
        &mut self,
        role: ModelPickerRole,
        provider_id: String,
        key: String,
        then_model: Option<String>,
    ) {
        let name = self.provider_display_name(&provider_id);
        let Some(env_key) = self.provider_env_key(&provider_id) else {
            return;
        };
        if let Err(error) = crate::dashboard_server::save_provider_key(
            self.config.codex_home.as_path(),
            &provider_id,
            &env_key,
            &key,
        ) {
            self.add_error_message(format!("Could not save the {name} key: {error}"));
            return;
        }
        self.add_info_message(
            format!("{name} key saved."),
            Some("Stored for this Elpis home only, readable by you alone.".to_string()),
        );
        match then_model {
            Some(model) => self
                .app_event_tx
                .send(AppEvent::ApplyProviderModelSelection {
                    model,
                    provider_id,
                    effort: None,
                }),
            None => self.browse_model_provider(role, provider_id),
        }
    }

    /// A row for pasting the provider's key, shown only while that provider has
    /// none. Phoenix puts "Configure AI Providers" in the model menu's footer
    /// for the same reason: the answer to "no key" belongs where the wall is.
    pub(super) fn add_api_key_item(
        &self,
        role: ModelPickerRole,
        provider_id: &str,
    ) -> Option<SelectionItem> {
        if self.provider_has_key(provider_id) {
            return None;
        }
        let description = match codex_model_provider_info::provider_api_key_url(provider_id) {
            Some(url) => format!("Paste it here, or open /dashboard → Keys · {url}"),
            None => "Paste it here, or open /dashboard → Keys".to_string(),
        };
        let provider_for_action = provider_id.to_string();
        Some(SelectionItem {
            name: "Add API key…".to_string(),
            description: Some(description),
            actions: vec![Box::new(move |tx| {
                tx.send(AppEvent::OpenProviderApiKeyPrompt {
                    role,
                    provider_id: provider_for_action.clone(),
                    then_model: None,
                });
            })],
            dismiss_on_select: true,
            ..Default::default()
        })
    }

    /// The row that opens the provider step, shown at the top of every picker.
    pub(super) fn change_provider_item(&self, role: ModelPickerRole) -> SelectionItem {
        SelectionItem {
            name: "Change provider…".to_string(),
            description: Some(format!(
                "Currently {}",
                self.config
                    .model_providers
                    .get(&self.picker_provider_id(role))
                    .map(|info| info.name.clone())
                    .unwrap_or_else(|| self.picker_provider_id(role))
            )),
            actions: vec![Box::new(move |tx| {
                tx.send(AppEvent::OpenModelProviderPopup { role });
            })],
            dismiss_on_select: true,
            ..Default::default()
        }
    }

    pub(crate) fn open_pruner_model_popup(&mut self) {
        self.request_model_catalog(Some(self.active_model_provider_id().to_string()));
        self.refresh_openrouter_models();
        self.refresh_pruner_model_popup();
    }

    /// Choose the model used for pruning and session naming.
    ///
    /// Sibling of [`Self::open_pruner_model_popup`]: that one overrides the
    /// pruner alone, this one moves all background maintenance together.
    pub(crate) fn open_background_model_popup(&mut self) {
        self.request_model_catalog(Some(self.background_provider_id().to_string()));
        self.refresh_openrouter_models();
        self.refresh_background_model_popup();
    }

    /// The provider background maintenance actually talks to, which is not the
    /// session's when `background_provider` is set. Showing the session's here
    /// would advertise a catalogue the background work never uses.
    pub(crate) fn background_provider_id(&self) -> &str {
        self.config
            .background_provider
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| self.active_model_provider_id())
    }

    /// A model id typed by hand for one of the roles that is chosen apart from
    /// the chat model, split into the model and the provider that serves it.
    pub(super) fn typed_model_choice(
        &self,
        input: &str,
        role_provider: &str,
    ) -> Result<TypedModelChoice, String> {
        if input == "default" {
            return Ok(TypedModelChoice {
                model: None,
                provider: None,
                label: "built-in default".to_string(),
            });
        }
        let qualified = input.split_once(':').filter(|(provider, model)| {
            !model.is_empty() && self.config.model_providers.contains_key(*provider)
        });
        let (provider, model) = match qualified {
            Some((provider, model)) => (provider, model),
            None => (role_provider, input),
        };
        let vendor_prefixed = model.contains('/');
        if provider == OPENROUTER_PROVIDER_ID && !vendor_prefixed {
            return Err(format!(
                "OpenRouter model ids look like vendor/model, and `{model}` does not."
            ));
        }
        if provider == OPENAI_PROVIDER_ID && vendor_prefixed {
            return Err(format!(
                "`{model}` is an OpenRouter-style id but this runs on openai. Use `openrouter:{model}` or pick from the list."
            ));
        }
        Ok(TypedModelChoice {
            model: Some(model.to_string()),
            provider: qualified.is_some().then(|| provider.to_string()),
            label: format!("{model} on {provider}"),
        })
    }

    /// Edits for `/memory-model <id>` typed by hand. `default` clears the
    /// model and the provider together, as the picker's first row does;
    /// `<provider>:<id>` sets both; a bare id keeps the provider background work
    /// already uses.
    pub(super) fn background_model_edits(
        &self,
        input: &str,
    ) -> Result<(Vec<crate::legacy_core::config::edit::ConfigEdit>, String), String> {
        use crate::legacy_core::config::edit::background_model_edit;
        use crate::legacy_core::config::edit::background_provider_edit;
        let choice = self.typed_model_choice(input, self.background_provider_id())?;
        let mut edits = vec![background_model_edit(choice.model.as_deref())];
        if choice.replaces_provider() {
            edits.push(background_provider_edit(choice.provider.as_deref()));
        }
        Ok((edits, choice.label))
    }

    pub(super) fn refresh_background_model_popup(&mut self) {
        let current = self.config.background_model.clone();
        let provider_id = self.picker_provider_id(ModelPickerRole::Memory);
        // Each choice carries the provider that serves it, so picking a model
        // moves the provider with it instead of leaving a model the background
        // provider cannot serve.
        let mut choices: Vec<(Option<String>, Option<String>, String, String)> = vec![(
            None,
            None,
            "Built-in default".to_string(),
            "Follow the session's provider for background work".to_string(),
        )];
        choices.extend(
            self.models_for_provider(&provider_id)
                .into_iter()
                .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
                .map(|preset| {
                    (
                        Some(preset.model.clone()),
                        Some(provider_id.clone()),
                        preset.model,
                        preset.description,
                    )
                }),
        );
        // A model already set by hand may not be in the catalogue - a provider
        // whose list Elpis cannot enumerate, for instance - so keep it selectable.
        if let Some(model) = current.clone()
            && !choices
                .iter()
                .any(|(choice, _, _, _)| choice.as_ref() == Some(&model))
        {
            choices.push((
                Some(model.clone()),
                self.config.background_provider.clone(),
                model,
                "Currently configured".to_string(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        choices.retain(|(model, _, _, _)| seen.insert(model.clone()));
        let footer_note = (choices.len() == 1).then(|| {
            Line::from(if self.model_popup_request_is_pending(&provider_id) {
                "Loading available models…"
            } else {
                "No models listed for this provider. Use /memory-model <id>."
            })
        });
        let items: Vec<SelectionItem> = choices
            .into_iter()
            .map(|(model, provider, name, description)| {
                let home = self.config.codex_home.clone();
                let is_current = current == model;
                SelectionItem {
                    name,
                    description: Some(description),
                    is_current,
                    actions: vec![Box::new(move |tx| {
                        let edits = vec![
                            crate::legacy_core::config::edit::background_model_edit(
                                model.as_deref(),
                            ),
                            crate::legacy_core::config::edit::background_provider_edit(
                                provider.as_deref(),
                            ),
                        ];
                        let cell =
                            match crate::legacy_core::config::edit::apply_blocking(&home, &edits) {
                                Ok(()) => history_cell::new_info_event(
                                    format!(
                                        "Background task model saved: {}. Pruning and session naming use it; memory uses the responding agent.",
                                        model.as_deref().unwrap_or("built-in default")
                                    ),
                                    None,
                                ),
                                Err(error) => history_cell::new_error_event(format!(
                                    "Cannot save background model: {error}"
                                )),
                            };
                        tx.send(AppEvent::InsertHistoryCell(Box::new(cell)));
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let mut items = items;
        items.insert(0, self.change_provider_item(ModelPickerRole::Memory));
        if let Some(key_item) = self.add_api_key_item(ModelPickerRole::Memory, &provider_id) {
            items.insert(1, key_item);
        }
        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(BACKGROUND_MODEL_SELECTION_VIEW_ID),
            initial_selected_idx,
            title: Some("Choose background task model".into()),
            subtitle: Some(format!(
                "Provider: {provider_id} · Current: {} · Memory uses responding agent",
                current.as_deref().unwrap_or("built-in default")
            )),
            items,
            is_searchable: true,
            search_placeholder: Some("Search models".into()),
            footer_note,
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        });
    }

    pub(super) fn refresh_pruner_model_popup(&mut self) {
        use crate::legacy_core::pruner_settings::PrunerSettings;
        let settings = match PrunerSettings::load(&self.config.codex_home) {
            Ok(settings) => settings,
            Err(error) => {
                self.add_error_message(format!("Cannot read pruner settings: {error}"));
                return;
            }
        };
        let provider_id = self.picker_provider_id(ModelPickerRole::Pruner);
        // Each choice carries the provider that serves it, so picking a model
        // moves the provider with it instead of leaving the pruner pointed at a
        // model its provider cannot serve.
        let mut choices: Vec<(Option<String>, Option<String>, String, String)> = vec![(
            None,
            None,
            "Provider default".to_string(),
            "Restore automatic pruner model selection".to_string(),
        )];
        choices.extend(
            self.models_for_provider(&provider_id)
                .into_iter()
                .filter(|preset| preset.show_in_picker && !Self::is_auto_model(&preset.model))
                .map(|preset| {
                    (
                        Some(preset.model.clone()),
                        Some(provider_id.clone()),
                        preset.model,
                        preset.description,
                    )
                }),
        );
        // A model set by hand may be absent from every catalogue, so keep it
        // selectable rather than dropping the owner's current choice.
        if let Some(model) = settings.model.clone()
            && !choices
                .iter()
                .any(|(choice, _, _, _)| choice.as_ref() == Some(&model))
        {
            choices.push((
                Some(model.clone()),
                settings.provider.clone(),
                model,
                "Currently configured".to_string(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        choices.retain(|(model, _, _, _)| seen.insert(model.clone()));
        let footer_note = (choices.len() == 1).then(|| {
            Line::from(if self.model_popup_request_is_pending(&provider_id) {
                "Loading available models…"
            } else {
                "No models available. Reopen /pruner-model to retry."
            })
        });
        let items: Vec<SelectionItem> = choices
            .into_iter()
            .map(|(model, provider, name, description)| {
                let home = self.config.codex_home.clone();
                let is_current = settings.model == model;
                SelectionItem {
                    name,
                    description: Some(description),
                    is_current,
                    actions: vec![Box::new(move |tx| {
                        let result = PrunerSettings::load(&home).and_then(|mut settings| {
                            settings.model = model.clone();
                            settings.provider = provider.clone();
                            settings.save(&home)
                        });
                        let cell = match result {
                            Ok(()) => history_cell::new_info_event(
                                format!(
                                    "Smart Prune model saved: {}. Chat model unchanged.",
                                    model.as_deref().unwrap_or("provider default")
                                ),
                                None,
                            ),
                            Err(error) => history_cell::new_error_event(format!(
                                "Cannot save pruner model: {error}"
                            )),
                        };
                        tx.send(AppEvent::InsertHistoryCell(Box::new(cell)));
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();
        let mut items = items;
        items.insert(0, self.change_provider_item(ModelPickerRole::Pruner));
        if let Some(key_item) = self.add_api_key_item(ModelPickerRole::Pruner, &provider_id) {
            items.insert(1, key_item);
        }
        let initial_selected_idx = items.iter().position(|item| item.is_current);
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(PRUNER_MODEL_SELECTION_VIEW_ID),
            initial_selected_idx,
            title: Some("Choose pruner model".into()),
            subtitle: Some(format!(
                "Provider: {} · Current: {} · Chat model unchanged",
                settings
                    .provider
                    .as_deref()
                    .unwrap_or_else(|| self.background_provider_id()),
                settings.model.as_deref().unwrap_or("provider default")
            )),
            items,
            is_searchable: true,
            search_placeholder: Some("Search models".into()),
            footer_note,
            footer_hint: Some(standard_popup_hint_line()),
            ..Default::default()
        });
    }

    /// Open a popup to choose a quick auto model. Selecting "All models"
    /// opens the full picker with every available preset.
    pub(crate) fn open_model_popup(&mut self) {
        if !self.is_session_configured() {
            self.add_info_message(
                "Model selection is disabled until startup completes.".to_string(),
                /*hint*/ None,
            );
            return;
        }

        let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        let presets = self.models_for_provider(&provider_id);
        self.refresh_ollama_models();
        self.refresh_openrouter_models();
        self.request_model_catalog(Some(provider_id));
        self.open_model_popup_with_presets(presets);
    }

    /// Kicks off a background refresh of the locally installed Ollama models shown in the
    /// `/model` picker. Fire-and-forget: results land later via `OllamaModelsLoaded` and only
    /// affect the *next* time the picker is opened, since the popup already on screen (if any)
    /// isn't rebuilt in place.
    pub(super) fn refresh_ollama_models(&self) {
        let Some(base_url) = self
            .config
            .model_providers
            .get(OLLAMA_OSS_PROVIDER_ID)
            .and_then(|provider| provider.base_url.clone())
        else {
            return;
        };
        let tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let models = fetch_ollama_model_names(base_url).await;
            tx.send(AppEvent::OllamaModelsLoaded { models });
        });
    }

    /// Fire-and-forget refresh of OpenRouter's catalogue with live prices.
    ///
    /// Elpis otherwise knows only the `openrouter/free` auto-router, which is
    /// useless for choosing a specific paid model. Like the Ollama refresh, the
    /// result affects the *next* time a picker opens rather than rebuilding one
    /// already on screen.
    pub(super) fn refresh_openrouter_models(&self) {
        let Some(base_url) = self.model_provider_base_url(OPENROUTER_PROVIDER_ID) else {
            return;
        };
        let tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let models = fetch_openrouter_top_models(base_url).await;
            tx.send(AppEvent::OpenRouterModelsLoaded { models });
        });
    }

    pub(crate) fn on_openrouter_models_loaded(&mut self, models: Vec<OpenRouterModel>) {
        if self.openrouter_models == models {
            return;
        }
        self.openrouter_models = models;
        // Rebuild a picker that is already on screen, so the prices appear on the
        // first open rather than only the next one.
        self.refresh_open_model_popup();
    }

    /// The live OpenRouter catalogue as picker presets.
    ///
    /// Built through the same metadata shape as the bundled free-tier entry so
    /// these flow through every existing picker path rather than needing a
    /// parallel one.
    pub(super) fn openrouter_live_presets(&self) -> Vec<ModelPreset> {
        self.openrouter_models
            .iter()
            .enumerate()
            .filter_map(|(priority, model)| {
                let info: codex_protocol::openai_models::ModelInfo =
                    serde_json::from_value(serde_json::json!({
                        "slug": model.slug,
                        "display_name": model.slug,
                        "description": model.description,
                        "default_reasoning_level": null,
                        "supported_reasoning_levels": [],
                        "shell_type": "shell_command",
                        "visibility": "list",
                        "supported_in_api": true,
                        "priority": priority,
                        "availability_nux": null,
                        "upgrade": null,
                        "base_instructions": "",
                        "supports_reasoning_summary_parameter": false,
                        "support_verbosity": false,
                        "default_verbosity": null,
                        "apply_patch_tool_type": null,
                        "truncation_policy": {"mode": "bytes", "limit": 10000},
                        "supports_parallel_tool_calls": true,
                        "supports_image_detail_original": false,
                        "context_window": 131_072,
                        "max_context_window": 131_072,
                        "experimental_supported_tools": [],
                        "input_modalities": ["text"]
                    }))
                    .ok()?;
                Some(ModelPreset::from(info))
            })
            .collect()
    }

    /// The models installed on this machine, as picker presets, so Ollama's
    /// entry in the provider list shows its own catalogue like every other
    /// provider does.
    pub(super) fn ollama_local_presets(&self) -> Vec<ModelPreset> {
        self.ollama_local_models
            .iter()
            .enumerate()
            .filter_map(|(priority, model)| {
                let info: codex_protocol::openai_models::ModelInfo =
                    serde_json::from_value(serde_json::json!({
                        "slug": model,
                        "display_name": model,
                        "description": "Runs on this machine via Ollama",
                        "default_reasoning_level": null,
                        "supported_reasoning_levels": [],
                        "shell_type": "shell_command",
                        "visibility": "list",
                        "supported_in_api": true,
                        "priority": priority,
                        "availability_nux": null,
                        "upgrade": null,
                        "base_instructions": "",
                        "supports_reasoning_summary_parameter": false,
                        "support_verbosity": false,
                        "default_verbosity": null,
                        "apply_patch_tool_type": null,
                        "truncation_policy": {"mode": "bytes", "limit": 10000},
                        "supports_parallel_tool_calls": true,
                        "supports_image_detail_original": false,
                        "context_window": 131_072,
                        "max_context_window": 131_072,
                        "experimental_supported_tools": [],
                        "input_modalities": ["text"]
                    }))
                    .ok()?;
                Some(ModelPreset::from(info))
            })
            .collect()
    }

    pub(crate) fn on_ollama_models_loaded(&mut self, models: Vec<String>) {
        self.ollama_local_models = models;
    }

    /// Provider currently backing this thread. Kept in step with the server by
    /// `apply_thread_settings`, so it reflects mid-session provider switches.
    pub(crate) fn active_model_provider_id(&self) -> &str {
        self.config.model_provider_id.as_str()
    }

    /// Base URL configured for a provider, for callers that need to query the provider's own
    /// API (model lists, model metadata) rather than route a turn through it.
    pub(crate) fn model_provider_base_url(&self, provider_id: &str) -> Option<String> {
        self.config
            .model_providers
            .get(provider_id)
            .and_then(|provider| provider.base_url.clone())
    }

    /// Provider name and id reduced to their letters and digits, lowercased, so cosmetic
    /// differences ("LM Studio" vs "lmstudio") don't read as two different providers.
    fn squashed(value: &str) -> String {
        value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect()
    }

    pub(super) fn model_provider_display_name(&self) -> String {
        let provider_id = self.config.model_provider_id.trim();
        let provider_name = self.config.model_provider.name.trim();
        match (provider_name.is_empty(), provider_id.is_empty()) {
            (true, true) => "configured provider".to_string(),
            (true, false) => provider_id.to_string(),
            (false, true) => provider_name.to_string(),
            // `LM Studio`/`lmstudio` name the same thing, so showing both would be noise.
            // Compare on letters and digits only so spacing and punctuation don't split them.
            (false, false) if Self::squashed(provider_name) == Self::squashed(provider_id) => {
                provider_name.to_string()
            }
            (false, false) => format!("{provider_name} ({provider_id})"),
        }
    }

    /// The heading above a provider's models. It names the provider whose list
    /// is on screen, which is not the session's while another is being browsed.
    fn model_provider_group_item(&self) -> SelectionItem {
        let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        let name = if provider_id == self.active_model_provider_id() {
            self.model_provider_display_name()
        } else {
            self.provider_display_name(&provider_id)
        };
        SelectionItem {
            name: name.to_uppercase(),
            is_disabled: true,
            ..Default::default()
        }
    }

    /// The provider the header should describe: the one whose models are on
    /// screen. Reading the session's here told the owner "Provider: OpenRouter"
    /// above a list of DeepSeek models.
    fn picker_provider_info(&self) -> &codex_model_provider_info::ModelProviderInfo {
        let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        self.config
            .model_providers
            .get(&provider_id)
            .unwrap_or(&self.config.model_provider)
    }

    fn model_provider_route(&self) -> crate::branding::ProviderRoute {
        let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        let info = self.picker_provider_info();
        crate::branding::ProviderRoute::for_provider(
            &provider_id,
            &info.name,
            info.wire_api,
            self.custom_openai_base_url().is_some(),
        )
    }

    fn model_protocol_label(&self) -> String {
        self.picker_provider_info().wire_api.to_string()
    }

    fn model_credential_label(&self) -> String {
        let provider = self.picker_provider_info();
        if provider.requires_openai_auth {
            return "OpenAI/ChatGPT credential store".to_string();
        }
        if let Some(env_key) = provider.env_key.as_deref() {
            return format!("environment variable {env_key}");
        }
        if let Some(headers) = provider.env_http_headers.as_ref()
            && !headers.is_empty()
        {
            let mut env_names = headers.values().cloned().collect::<Vec<_>>();
            env_names.sort();
            env_names.dedup();
            return format!("environment header {}", env_names.join(", "));
        }
        if provider.auth.is_some() {
            return "command-backed bearer token".to_string();
        }
        if provider.aws.is_some() {
            return "AWS SigV4 credential chain".to_string();
        }
        if provider.experimental_bearer_token.is_some() {
            return "configured bearer token".to_string();
        }
        // A provider that declares no credential of any kind is a local server; saying
        // "not declared" makes a normal setup look misconfigured.
        "none required".to_string()
    }

    fn model_route_description(&self, description: &str) -> String {
        let route = self.model_provider_route().long_label();
        if description.is_empty() {
            route.to_string()
        } else {
            format!("{route} · {description}")
        }
    }

    fn model_menu_header(&self, title: &str, subtitle: &str) -> Box<dyn Renderable> {
        let picker_provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        let browsing_other = picker_provider_id != self.active_model_provider_id();
        let provider = if browsing_other {
            self.provider_display_name(&picker_provider_id)
        } else {
            self.model_provider_display_name()
        };
        let route = self.model_provider_route().long_label();
        let protocol = self.model_protocol_label();
        let credential = self.model_credential_label();
        let mut header = ColumnRenderable::new();
        header.push(Line::from(Span::styled(
            title.to_string(),
            crate::style::brand_style(),
        )));
        header.push(Line::from(Span::styled(
            format!("Provider: {provider}"),
            crate::style::status_symbol_style(),
        )));
        header.push(Line::from(Span::styled(
            format!("Route: {route}"),
            crate::style::status_symbol_style(),
        )));
        header.push(Line::from(Span::styled(
            format!("Protocol: {protocol}"),
            crate::style::status_symbol_style(),
        )));
        header.push(Line::from(Span::styled(
            format!("Credential: {credential}"),
            crate::style::status_symbol_style(),
        )));
        header.push(Line::from(if browsing_other {
            "Model: none chosen on this provider yet".to_string().bold()
        } else {
            format!("Model: {}", self.current_model()).bold()
        }));
        header.push(Line::from(subtitle.to_string().dim()));
        if let Some(warning) = self.model_menu_warning_line() {
            header.push(warning);
        }
        Box::new(header)
    }

    fn model_menu_warning_line(&self) -> Option<Line<'static>> {
        let base_url = self.custom_openai_base_url()?;
        let warning = format!(
            "Compatibility route: OpenAI base URL is overridden to {base_url}. Model discovery and selection depend on that endpoint."
        );
        Some(Line::from(Span::styled(
            warning,
            crate::style::popup_border_style(),
        )))
    }

    fn custom_openai_base_url(&self) -> Option<String> {
        if !self.config.model_provider.is_openai() {
            return None;
        }

        let base_url = self.config.model_provider.base_url.as_ref()?;
        let trimmed = base_url.trim();
        if trimmed.is_empty() {
            return None;
        }

        let normalized = trimmed.trim_end_matches('/');
        if normalized == DEFAULT_OPENAI_BASE_URL {
            return None;
        }

        Some(trimmed.to_string())
    }

    pub(crate) fn open_model_popup_with_presets(&mut self, presets: Vec<ModelPreset>) {
        let provider_id = self.picker_provider_id(ModelPickerRole::Chat);
        let presets: Vec<ModelPreset> = presets
            .into_iter()
            .filter(|preset| preset.show_in_picker)
            .collect();
        let auto_routing_item = self.auto_model_routing_item(&presets);

        // While another provider is being browsed the session's model is not on
        // this list, so do not present it as this provider's current choice.
        let browsing_other = provider_id != self.active_model_provider_id();
        let current_model = if browsing_other {
            String::new()
        } else {
            self.current_model().to_string()
        };
        let current_label = presets
            .iter()
            .find(|preset| preset.model.as_str() == current_model)
            .map(|preset| preset.model.to_string())
            .unwrap_or_else(|| {
                if browsing_other {
                    "none yet".to_string()
                } else {
                    self.model_display_name().to_string()
                }
            });

        let (mut auto_presets, mut other_presets): (Vec<ModelPreset>, Vec<ModelPreset>) = presets
            .into_iter()
            .partition(|preset| Self::is_auto_model(&preset.model));

        auto_presets.sort_by_key(|preset| Self::auto_model_order(&preset.model));
        // Choosing a provider should put its models on screen, not one more row
        // to open. A catalogue too long to read stays behind "All models", but
        // only when the page has models of its own to show instead. A provider
        // with no auto models -- a live catalogue such as OpenRouter -- would
        // otherwise get a page whose only choice is "All models": a hop with
        // nothing on it.
        let inline_everything = auto_presets.is_empty()
            || auto_presets.len() + other_presets.len() <= INLINE_MODEL_ROW_LIMIT;
        if inline_everything {
            auto_presets.append(&mut other_presets);
        }
        let mut items: Vec<SelectionItem> = auto_presets
            .into_iter()
            .map(|preset| {
                let description = Some(self.model_route_description(&preset.description));
                let model = preset.model.clone();
                // A model that offers several efforts gets its effort chosen
                // explicitly, the same rule the full-catalog list follows.
                let requires_advanced_selection =
                    Self::is_advanced_reasoning_effort(&preset.default_reasoning_effort)
                        || preset
                            .supported_reasoning_efforts
                            .iter()
                            .any(|option| Self::is_advanced_reasoning_effort(&option.effort))
                        || (!Self::is_auto_model(&preset.model)
                            && preset.supported_reasoning_efforts.len() > 1);
                let actions: Vec<SelectionAction> = if requires_advanced_selection {
                    let preset_for_action = preset.clone();
                    let provider_for_action = self.picker_target_provider();
                    vec![Box::new(move |tx| {
                        tx.send(AppEvent::OpenReasoningPopup {
                            model: preset_for_action.clone(),
                            provider_id: provider_for_action.clone(),
                        });
                    })]
                } else {
                    let should_prompt_plan_mode_scope = self
                        .should_prompt_plan_mode_reasoning_scope(
                            model.as_str(),
                            Some(preset.default_reasoning_effort.clone()),
                        );
                    // With exactly one supported effort the default is not a
                    // choice, it is the only answer - applying a different
                    // default would send an effort the model does not offer.
                    let effort = match preset.supported_reasoning_efforts.as_slice() {
                        [only] => only.effort.clone(),
                        _ => preset.default_reasoning_effort.clone(),
                    };
                    self.model_selection_actions(
                        model.clone(),
                        Some(effort),
                        self.picker_target_provider(),
                        should_prompt_plan_mode_scope,
                    )
                };
                SelectionItem {
                    name: model.clone(),
                    description,
                    is_current: model.as_str() == current_model,
                    is_default: preset.is_default,
                    actions,
                    dismiss_on_select: !requires_advanced_selection,
                    dismiss_parent_on_child_accept: requires_advanced_selection,
                    ..Default::default()
                }
            })
            .collect();

        if other_presets.is_empty() && items.is_empty() {
            // Say why the list is empty for this provider rather than showing a
            // bare gap, and never borrow another provider's models to fill it.
            let provider_name = self.provider_display_name(&provider_id);
            let name = if self.model_popup_request_is_pending(&provider_id) {
                format!("Loading available {provider_name} models…")
            } else {
                format!("{provider_name} unavailable - retry with /model")
            };
            items.push(SelectionItem {
                name,
                is_disabled: true,
                ..Default::default()
            });
        }
        if !other_presets.is_empty() {
            let all_models = other_presets;
            let actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
                tx.send(AppEvent::OpenAllModelsPopup {
                    models: all_models.clone(),
                });
            })];

            let is_current = !items.iter().any(|item| item.is_current);
            let description = Some(format!(
                "Browse this provider's full catalog (current: {current_label})"
            ));

            items.push(SelectionItem {
                name: "All models".to_string(),
                description,
                is_current,
                actions,
                dismiss_on_select: true,
                ..Default::default()
            });
        }

        let mut head = 0;
        items.insert(head, self.model_provider_group_item());
        head += 1;
        if let Some(auto_routing_item) = auto_routing_item {
            items.insert(head, auto_routing_item);
            head += 1;
        }
        items.insert(head, self.change_provider_item(ModelPickerRole::Chat));
        head += 1;
        if let Some(key_item) = self.add_api_key_item(ModelPickerRole::Chat, &provider_id) {
            items.insert(head, key_item);
        }

        let header = self.model_menu_header(
            "Choose a mind",
            "Provider, protocol, route, and credential source remain visible while choosing.",
        );
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(MODEL_SELECTION_VIEW_ID),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            header,
            ..Default::default()
        });
    }

    /// Auto routing needs Luna, Terra, and Sol, which only OpenAI serves. On a
    /// provider that cannot offer them the row is not a choice, so it is not
    /// shown - unless it is already on, where hiding it would trap the session.
    fn auto_model_routing_item(&self, presets: &[ModelPreset]) -> Option<SelectionItem> {
        let available = self.auto_model_routing_available()
            && presets.iter().any(|preset| {
                preset.model.as_str() == crate::chatwidget::model_routing::TERRA_MODEL
            });
        let enabled = self.auto_model_routing_enabled();
        if !available && !enabled {
            return None;
        }
        let description = if available {
            "Elpis automatically chooses the right model for the task".to_string()
        } else {
            "On, but this provider does not offer GPT-5.6 Luna, Terra, and Sol.".to_string()
        };
        let mut actions: Vec<SelectionAction> = Vec::new();
        if available {
            actions.push(Box::new(|tx| {
                tx.send(AppEvent::EnableAutoModelRouting);
            }));
        }
        Some(SelectionItem {
            name: "Auto".to_string(),
            description: Some(description),
            is_current: enabled,
            is_disabled: !available,
            actions,
            dismiss_on_select: available,
            ..Default::default()
        })
    }

    pub(super) fn is_auto_model(model: &str) -> bool {
        model.starts_with("codex-auto-")
    }

    fn auto_model_order(model: &str) -> usize {
        match model {
            "codex-auto-fast" => 0,
            "codex-auto-balanced" => 1,
            "codex-auto-thorough" => 2,
            _ => 3,
        }
    }

    pub(crate) fn open_all_models_popup(&mut self, presets: Vec<ModelPreset>) {
        let mut items: Vec<SelectionItem> = vec![self.model_provider_group_item()];
        for preset in presets.into_iter() {
            let description = Some(self.model_route_description(&preset.description));
            let is_current = preset.model.as_str() == self.current_model();
            // A pick opens a second step only when there is a real choice of
            // effort left to make. A model that offers none - every entry in a
            // live provider catalog - is applied on the spot, so the pick has to
            // close this list itself: no child popup will ever open to do it.
            let sole_effort = match preset.supported_reasoning_efforts.as_slice() {
                [] => Some(preset.default_reasoning_effort.clone()),
                [only] => Some(only.effort.clone()),
                _ => None,
            };
            let single_supported_effort =
                sole_effort.is_some_and(|effort| !Self::is_advanced_reasoning_effort(&effort));
            let preset_for_action = preset.clone();
            let provider_for_action = self.picker_target_provider();
            let actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
                let preset_for_event = preset_for_action.clone();
                tx.send(AppEvent::OpenReasoningPopup {
                    model: preset_for_event,
                    provider_id: provider_for_action.clone(),
                });
            })];
            items.push(SelectionItem {
                name: preset.model.clone(),
                description,
                is_current,
                is_default: preset.is_default,
                actions,
                dismiss_on_select: single_supported_effort,
                dismiss_parent_on_child_accept: !single_supported_effort,
                ..Default::default()
            });
        }
        if items.len() == 1 {
            items.push(SelectionItem {
                name: "No models available".to_string(),
                is_disabled: true,
                ..Default::default()
            });
        }

        let header = self.model_menu_header(
            "Choose a mind and effort",
            "Models are grouped under the active provider and routing mode.",
        );
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(ALL_MODELS_SELECTION_VIEW_ID),
            footer_hint: Some(self.bottom_pane.standard_popup_hint_line()),
            items,
            header,
            // Escape here means "I did not want this list", not "close the
            // picker": step back to the provider's page the way the rest of
            // the settings screens do.
            on_cancel: Some(Box::new(|tx| {
                tx.send(AppEvent::ReopenModelPopup);
            })),
            ..Default::default()
        });
    }

    fn model_selection_actions(
        &self,
        model_for_action: String,
        effort_for_action: Option<ReasoningEffortConfig>,
        provider_id: Option<String>,
        should_prompt_plan_mode_scope: bool,
    ) -> Vec<SelectionAction> {
        let warning = effort_for_action
            .as_ref()
            .and_then(|effort| self.ultra_reasoning_concurrency_warning(effort));
        // A model on a provider with no key cannot answer, so ask for the key
        // first and apply the model once it lands.
        if let Some(provider_id) = provider_id.clone()
            && !self.provider_has_key(&provider_id)
        {
            return vec![Box::new(move |tx| {
                tx.send(AppEvent::OpenProviderApiKeyPrompt {
                    role: ModelPickerRole::Chat,
                    provider_id: provider_id.clone(),
                    then_model: Some(model_for_action.clone()),
                });
            })];
        }
        vec![Box::new(move |tx| {
            if let Some(provider_id) = provider_id.as_ref() {
                tx.send(AppEvent::ApplyProviderModelSelection {
                    model: model_for_action.clone(),
                    provider_id: provider_id.clone(),
                    effort: effort_for_action.clone(),
                });
            } else if effort_for_action == Some(ReasoningEffortConfig::Ultra) {
                tx.send(AppEvent::ApplyAdvancedReasoning {
                    model: model_for_action.clone(),
                    effort: ReasoningEffortConfig::Ultra,
                });
            } else if should_prompt_plan_mode_scope {
                tx.send(AppEvent::OpenPlanReasoningScopePrompt {
                    model: model_for_action.clone(),
                    effort: effort_for_action.clone(),
                });
            } else {
                tx.send(AppEvent::UpdateModel(model_for_action.clone()));
                tx.send(AppEvent::UpdateReasoningEffort(effort_for_action.clone()));
                tx.send(AppEvent::PersistModelSelection {
                    model: model_for_action.clone(),
                    effort: effort_for_action.clone(),
                });
            }
            if let Some(warning) = warning.clone() {
                tx.send(AppEvent::InsertHistoryCell(Box::new(
                    history_cell::new_warning_event(warning),
                )));
            }
        })]
    }

    fn should_prompt_plan_mode_reasoning_scope(
        &self,
        selected_model: &str,
        selected_effort: Option<ReasoningEffortConfig>,
    ) -> bool {
        if !self.collaboration_modes_enabled()
            || self.active_mode_kind() != ModeKind::Plan
            || selected_model != self.current_model()
        {
            return false;
        }

        // Prompt whenever the selection is not a true no-op for both:
        // 1) the active Plan-mode effective reasoning, and
        // 2) the stored global defaults that would be updated by the fallback path.
        selected_effort != self.effective_reasoning_effort()
            || selected_model != self.current_collaboration_mode.model()
            || selected_effort != self.current_collaboration_mode.reasoning_effort()
    }

    pub(crate) fn open_plan_reasoning_scope_prompt(
        &mut self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    ) {
        let reasoning_phrase = match effort.as_ref() {
            Some(ReasoningEffortConfig::None) => "no reasoning".to_string(),
            Some(selected_effort) => {
                format!(
                    "{} reasoning",
                    Self::reasoning_effort_sentence_label(selected_effort)
                )
            }
            None => "the selected reasoning".to_string(),
        };
        let plan_only_description = format!("Always use {reasoning_phrase} in Plan mode.");
        let plan_reasoning_source = if let Some(plan_override) =
            self.config.plan_mode_reasoning_effort.as_ref()
        {
            format!(
                "user-chosen Plan override ({})",
                Self::reasoning_effort_sentence_label(plan_override)
            )
        } else if let Some(plan_mask) = collaboration_modes::plan_mask(self.model_catalog.as_ref())
        {
            match plan_mask
                .reasoning_effort
                .as_ref()
                .and_then(|effort| effort.as_ref())
            {
                Some(plan_effort) => format!(
                    "built-in Plan default ({})",
                    Self::reasoning_effort_sentence_label(plan_effort)
                ),
                None => "built-in Plan default (no reasoning)".to_string(),
            }
        } else {
            "built-in Plan default".to_string()
        };
        let all_modes_description = format!(
            "Set the global default reasoning level and the Plan mode override. This replaces the current {plan_reasoning_source}."
        );
        let subtitle = format!("Choose where to apply {reasoning_phrase}.");
        let warning = effort
            .as_ref()
            .and_then(|effort| self.ultra_reasoning_concurrency_warning(effort));

        let plan_only_actions: Vec<SelectionAction> = vec![Box::new({
            let model = model.clone();
            let effort = effort.clone();
            let warning = warning.clone();
            move |tx| {
                tx.send(AppEvent::UpdateModel(model.clone()));
                tx.send(AppEvent::UpdatePlanModeReasoningEffort(effort.clone()));
                tx.send(AppEvent::PersistPlanModeReasoningEffort(effort.clone()));
                if let Some(warning) = warning.clone() {
                    tx.send(AppEvent::InsertHistoryCell(Box::new(
                        history_cell::new_warning_event(warning),
                    )));
                }
            }
        })];
        let all_modes_actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
            tx.send(AppEvent::UpdateModel(model.clone()));
            tx.send(AppEvent::UpdateReasoningEffort(effort.clone()));
            tx.send(AppEvent::UpdatePlanModeReasoningEffort(effort.clone()));
            tx.send(AppEvent::PersistPlanModeReasoningEffort(effort.clone()));
            tx.send(AppEvent::PersistModelSelection {
                model: model.clone(),
                effort: effort.clone(),
            });
            if let Some(warning) = warning.clone() {
                tx.send(AppEvent::InsertHistoryCell(Box::new(
                    history_cell::new_warning_event(warning),
                )));
            }
        })];

        self.bottom_pane.show_selection_view(SelectionViewParams {
            title: Some(PLAN_MODE_REASONING_SCOPE_TITLE.to_string()),
            subtitle: Some(subtitle),
            footer_hint: Some(standard_popup_hint_line()),
            items: vec![
                SelectionItem {
                    name: PLAN_MODE_REASONING_SCOPE_PLAN_ONLY.to_string(),
                    description: Some(plan_only_description),
                    actions: plan_only_actions,
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: PLAN_MODE_REASONING_SCOPE_ALL_MODES.to_string(),
                    description: Some(all_modes_description),
                    actions: all_modes_actions,
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        self.notify(Notification::PlanModePrompt {
            title: PLAN_MODE_REASONING_SCOPE_TITLE.to_string(),
        });
    }

    /// Open a popup to choose the standard reasoning effort for the given model.
    ///
    /// Max and Ultra require an explicit second step so expensive efforts cannot
    /// be selected accidentally while moving through the normal effort scale.
    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
    pub(crate) fn open_reasoning_popup(&mut self, preset: ModelPreset) {
        self.open_reasoning_popup_for_provider(preset, None);
    }

    pub(crate) fn open_reasoning_popup_for_provider(
        &mut self,
        preset: ModelPreset,
        provider_id: Option<String>,
    ) {
        let default_effort = preset.default_reasoning_effort.clone();
        let supported = &preset.supported_reasoning_efforts;
        let in_plan_mode =
            self.collaboration_modes_enabled() && self.active_mode_kind() == ModeKind::Plan;

        let warn_effort = if supported
            .iter()
            .any(|option| option.effort == ReasoningEffortConfig::XHigh)
        {
            Some(ReasoningEffortConfig::XHigh)
        } else if supported
            .iter()
            .any(|option| option.effort == ReasoningEffortConfig::High)
        {
            Some(ReasoningEffortConfig::High)
        } else {
            None
        };
        let warning_text = warn_effort.as_ref().map(|effort| {
            let effort_label = Self::reasoning_effort_label(effort);
            format!("⚠ {effort_label} reasoning effort can quickly consume Plus plan rate limits.")
        });
        let warn_for_model = preset.model.starts_with("gpt-5.1-codex")
            || preset.model.starts_with("gpt-5.1-codex-max")
            || preset.model.starts_with("gpt-5.2");

        let mut all_choices: Vec<ReasoningEffortConfig> = supported
            .iter()
            .map(|option| option.effort.clone())
            .collect();
        if all_choices.is_empty() {
            all_choices.push(default_effort.clone());
        }
        let (choices, advanced_choices): (Vec<_>, Vec<_>) = all_choices
            .into_iter()
            .partition(|effort| !Self::is_advanced_reasoning_effort(effort));

        if choices.len() == 1 && advanced_choices.is_empty() {
            let selected_effort = choices.first().cloned();
            let selected_model = preset.model;
            if let Some(provider_id) = provider_id.clone() {
                self.apply_provider_model_and_effort(selected_model, provider_id, selected_effort);
            } else if self
                .should_prompt_plan_mode_reasoning_scope(&selected_model, selected_effort.clone())
            {
                self.app_event_tx
                    .send(AppEvent::OpenPlanReasoningScopePrompt {
                        model: selected_model,
                        effort: selected_effort,
                    });
            } else {
                self.apply_model_and_effort(selected_model, selected_effort);
            }
            return;
        }

        let default_choice = choices
            .contains(&default_effort)
            .then(|| default_effort.clone());

        let model_slug = preset.model.to_string();
        let is_current_model = self.current_model() == preset.model.as_str();
        let highlight_choice = if is_current_model {
            if in_plan_mode {
                self.config
                    .plan_mode_reasoning_effort
                    .clone()
                    .or_else(|| self.effective_reasoning_effort())
            } else {
                self.effective_reasoning_effort()
            }
        } else {
            default_choice.clone().or_else(|| choices.first().cloned())
        };
        let selection_choice = highlight_choice.clone().or_else(|| default_choice.clone());
        let initial_selected_idx = choices
            .iter()
            .position(|choice| Some(choice) == selection_choice.as_ref());
        let mut items: Vec<SelectionItem> = Vec::new();
        for choice in choices.iter() {
            let effort = choice.clone();
            let mut effort_label = Self::reasoning_effort_label(&effort);
            if Some(choice) == default_choice.as_ref() {
                effort_label.push_str(" (default)");
            }

            let description = supported
                .iter()
                .find(|option| option.effort == effort)
                .map(|option| option.description.to_string())
                .filter(|text| !text.is_empty());

            let show_warning = warn_for_model && warn_effort.as_ref() == Some(&effort);
            let selected_description = if show_warning {
                warning_text.as_ref().map(|warning_message| {
                    description.as_ref().map_or_else(
                        || warning_message.clone(),
                        |d| format!("{d}\n{warning_message}"),
                    )
                })
            } else {
                None
            };

            let choice_effort = Some(effort);
            let should_prompt_plan_mode_scope = self.should_prompt_plan_mode_reasoning_scope(
                model_slug.as_str(),
                choice_effort.clone(),
            );
            let actions = self.model_selection_actions(
                model_slug.clone(),
                choice_effort,
                provider_id.clone(),
                should_prompt_plan_mode_scope,
            );

            items.push(SelectionItem {
                name: effort_label,
                description,
                selected_description,
                is_current: is_current_model && Some(choice) == highlight_choice.as_ref(),
                actions,
                dismiss_on_select: true,
                ..Default::default()
            });
        }

        if !advanced_choices.is_empty() {
            let advanced_label = advanced_choices
                .iter()
                .map(Self::reasoning_effort_label)
                .collect::<Vec<_>>()
                .join(" and ");
            let verb = if advanced_choices.len() == 1 {
                "consumes"
            } else {
                "consume"
            };
            let preset_for_action = preset;
            let provider_id_for_action = provider_id;
            let actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
                tx.send(AppEvent::OpenAdvancedReasoningPopup {
                    model: preset_for_action.clone(),
                    provider_id: provider_id_for_action.clone(),
                });
            })];
            items.push(SelectionItem {
                name: "More reasoning…".to_string(),
                description: Some(format!("{advanced_label} {verb} usage limits faster")),
                is_current: is_current_model
                    && highlight_choice
                        .as_ref()
                        .is_some_and(Self::is_advanced_reasoning_effort),
                actions,
                dismiss_parent_on_child_accept: true,
                ..Default::default()
            });
        }

        let mut header = ColumnRenderable::new();
        header.push(Line::from(
            format!("Select Reasoning Level for {model_slug}").bold(),
        ));

        self.bottom_pane.show_selection_view(SelectionViewParams {
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            initial_selected_idx,
            ..Default::default()
        });
    }

    /// Open the explicit Max/Ultra effort picker for the given model.
    /// Exercised by tests only; no production path reaches it today.
    #[cfg(test)]
    pub(crate) fn open_advanced_reasoning_popup(&mut self, preset: ModelPreset) {
        self.open_advanced_reasoning_popup_for_provider(preset, None);
    }

    pub(crate) fn open_advanced_reasoning_popup_for_provider(
        &mut self,
        preset: ModelPreset,
        provider_id: Option<String>,
    ) {
        let mut choices = preset
            .supported_reasoning_efforts
            .iter()
            .map(|option| option.effort.clone())
            .filter(Self::is_advanced_reasoning_effort)
            .collect::<Vec<_>>();
        if choices.is_empty()
            && Self::is_advanced_reasoning_effort(&preset.default_reasoning_effort)
        {
            choices.push(preset.default_reasoning_effort.clone());
        }
        choices.sort_by_key(|effort| matches!(effort, ReasoningEffortConfig::Ultra));
        if choices.is_empty() {
            return;
        }

        let model_slug = preset.model.to_string();
        let is_current_model = self.current_model() == preset.model.as_str();
        let highlight_choice = is_current_model
            .then(|| self.effective_reasoning_effort())
            .flatten();
        let mut items = Vec::new();
        for effort in choices {
            let description = match &effort {
                ReasoningEffortConfig::Max => {
                    "For difficult problems when quality matters more than speed · higher usage"
                }
                ReasoningEffortConfig::Ultra => {
                    "For demanding work using multiple agents · highest usage"
                }
                _ => unreachable!("advanced choices are limited to Max and Ultra"),
            };
            let should_prompt_plan_mode_scope = self
                .should_prompt_plan_mode_reasoning_scope(model_slug.as_str(), Some(effort.clone()));
            let actions = self.model_selection_actions(
                model_slug.clone(),
                Some(effort.clone()),
                provider_id.clone(),
                should_prompt_plan_mode_scope,
            );

            items.push(SelectionItem {
                name: Self::reasoning_effort_label(&effort),
                description: Some(description.to_string()),
                is_current: is_current_model && Some(&effort) == highlight_choice.as_ref(),
                actions,
                dismiss_on_select: true,
                ..Default::default()
            });
        }

        let mut header = ColumnRenderable::new();
        header.push(Line::from("Advanced Reasoning".bold()));
        header.push(Line::from(Span::styled(
            "⚠ Consumes usage limits faster",
            crate::style::status_symbol_style(),
        )));
        self.bottom_pane.show_selection_view(SelectionViewParams {
            header: Box::new(header),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            ..Default::default()
        });
    }

    pub(super) fn is_advanced_reasoning_effort(effort: &ReasoningEffortConfig) -> bool {
        matches!(
            effort,
            ReasoningEffortConfig::Max | ReasoningEffortConfig::Ultra
        )
    }

    pub(super) fn reasoning_effort_label(effort: &ReasoningEffortConfig) -> String {
        match effort {
            ReasoningEffortConfig::None => "None".to_string(),
            ReasoningEffortConfig::Minimal => "Minimal".to_string(),
            ReasoningEffortConfig::Low => "Low".to_string(),
            ReasoningEffortConfig::Medium => "Medium".to_string(),
            ReasoningEffortConfig::High => "High".to_string(),
            ReasoningEffortConfig::XHigh => "Extra high".to_string(),
            ReasoningEffortConfig::Max => "Max".to_string(),
            ReasoningEffortConfig::Ultra => "Ultra".to_string(),
            ReasoningEffortConfig::Custom(value) => value.clone(),
        }
    }

    pub(super) fn reasoning_effort_sentence_label(effort: &ReasoningEffortConfig) -> String {
        match effort {
            ReasoningEffortConfig::Custom(value) => value.clone(),
            effort => Self::reasoning_effort_label(effort).to_lowercase(),
        }
    }

    pub(super) fn ultra_reasoning_concurrency_warning(
        &self,
        effort: &ReasoningEffortConfig,
    ) -> Option<String> {
        if effort != &ReasoningEffortConfig::Ultra {
            return None;
        }

        let max_threads = self
            .config
            .multi_agent_v2
            .max_concurrent_threads_per_session;
        if max_threads < ULTRA_REASONING_CONCURRENCY_WARNING_THRESHOLD {
            return None;
        }

        let max_subagents = max_threads.saturating_sub(1);
        Some(format!(
            "Ultra reasoning may proactively use multiple agents. This session is configured for \
             {max_threads} concurrent threads with up to {max_subagents} subagents which can \
             increase usage quickly. Consider setting \
             features.multi_agent_v2.max_concurrent_threads_per_session below 8."
        ))
    }

    pub(super) fn apply_model_and_effort_without_persist(
        &self,
        model: String,
        effort: Option<ReasoningEffortConfig>,
    ) {
        let warning = effort
            .as_ref()
            .and_then(|effort| self.ultra_reasoning_concurrency_warning(effort));
        self.app_event_tx.send(AppEvent::UpdateModel(model));
        self.app_event_tx
            .send(AppEvent::UpdateReasoningEffort(effort));
        if let Some(warning) = warning {
            self.app_event_tx.send(AppEvent::InsertHistoryCell(Box::new(
                history_cell::new_warning_event(warning),
            )));
        }
    }

    fn apply_model_and_effort(&self, model: String, effort: Option<ReasoningEffortConfig>) {
        self.apply_model_and_effort_without_persist(model.clone(), effort.clone());
        self.app_event_tx
            .send(AppEvent::PersistModelSelection { model, effort });
    }

    fn apply_provider_model_and_effort(
        &self,
        model: String,
        provider_id: String,
        effort: Option<ReasoningEffortConfig>,
    ) {
        self.app_event_tx
            .send(AppEvent::ApplyProviderModelSelection {
                model,
                provider_id,
                effort,
            });
    }
}

/// Queries a local Ollama server's native `/api/tags` endpoint for installed model names.
///
/// `base_url` is the provider's OpenAI-compatible base URL (e.g. `http://localhost:11434/v1`);
/// Ollama's native API lives one level up, at the host root. Any failure (server not running,
/// unexpected response shape, timeout) yields an empty list rather than surfacing an error --
/// this is a best-effort convenience list, not a required capability.
async fn fetch_ollama_model_names(base_url: String) -> Vec<String> {
    let host_root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(OLLAMA_MODELS_FETCH_TIMEOUT)
        .timeout(OLLAMA_MODELS_FETCH_TIMEOUT)
        .build()
    else {
        return Vec::new();
    };
    let Ok(response) = client.get(format!("{host_root}/api/tags")).send().await else {
        return Vec::new();
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    body.get("models")
        .and_then(|models| models.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("name")?.as_str())
                .filter(|name| !is_embedding_model_name(name) && !is_cloud_hosted_model_name(name))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a model Ollama lists is one it hosts remotely rather than serves from this
/// machine. These carry a `:cloud` tag and appear in `/api/tags` next to the real local
/// pulls, but reaching them takes a signed-in Ollama account, so offering one to a user
/// without that account produces a model that is listed and cannot answer.
fn is_cloud_hosted_model_name(name: &str) -> bool {
    name.ends_with(":cloud")
}

/// Whether an installed Ollama model only produces embeddings and so cannot hold a turn.
///
/// `/api/tags` reports no capability field, and the family it does report does not separate
/// the two -- `qwen3-embedding` and a `qwen3` chat model are both family `qwen3`. The name is
/// the only signal the list endpoint carries. Asking `/api/show` per model would answer this
/// exactly, at the cost of one request per installed model every time the picker opens.
fn is_embedding_model_name(name: &str) -> bool {
    name.to_ascii_lowercase().contains("embed")
}

/// Context window Ollama reports for one locally installed model, via `/api/show`.
///
/// Without this the model falls back to the generic metadata window, so the context meter
/// and every budget derived from it describe a model nobody is running. Best-effort like
/// `fetch_ollama_model_names`: on any failure the caller keeps the fallback.
pub(crate) async fn fetch_ollama_context_window(base_url: String, model: String) -> Option<i64> {
    let host_root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(OLLAMA_MODELS_FETCH_TIMEOUT)
        .timeout(OLLAMA_MODELS_FETCH_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .post(format!("{host_root}/api/show"))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .ok()?;
    let body = response.json::<serde_json::Value>().await.ok()?;
    // Ollama namespaces the key by architecture (`qwen35.context_length`, `llama.context_length`,
    // ...), so match on the suffix rather than guessing the architecture.
    body.get("model_info")?
        .as_object()?
        .iter()
        .find(|(key, _)| key.ends_with(".context_length"))
        .and_then(|(_, value)| value.as_i64())
        .filter(|context_window| *context_window > 0)
}

#[cfg(test)]
mod tests {
    use super::is_cloud_hosted_model_name;
    use super::is_embedding_model_name;

    /// Reaching a `:cloud` model needs a signed-in Ollama account. Listing one without that
    /// account offers a model that cannot answer, so it does not belong in the picker.
    #[test]
    fn remotely_hosted_models_are_not_offered() {
        assert!(is_cloud_hosted_model_name("glm-5.2:cloud"));
        assert!(is_cloud_hosted_model_name("minimax-m2:cloud"));
        assert!(!is_cloud_hosted_model_name("qwen3.5:latest"));
    }

    #[test]
    fn embedding_models_are_not_offered_as_chat_models() {
        for name in [
            "qwen3-embedding:8b",
            "qwen3-embedding:0.6b",
            "embeddinggemma:latest",
            "nomic-embed-text:latest",
        ] {
            assert!(is_embedding_model_name(name), "{name} should be filtered");
        }
        for name in ["qwen3.5:latest", "glm-5.2:cloud", "minimax-m2:cloud"] {
            assert!(!is_embedding_model_name(name), "{name} should be offered");
        }
    }
}

/// A model id typed for a role chosen apart from the chat model, split into the
/// model and the provider that serves it.
pub(super) struct TypedModelChoice {
    /// `None` restores the built-in default and clears the provider with it.
    pub(super) model: Option<String>,
    /// `Some` only when the input named a provider; otherwise the role keeps
    /// whichever provider it already uses.
    pub(super) provider: Option<String>,
    pub(super) label: String,
}

impl TypedModelChoice {
    /// Whether this choice decides the role's provider. A bare id leaves the
    /// current one alone; naming one, or restoring the default, replaces it.
    pub(super) fn replaces_provider(&self) -> bool {
        self.provider.is_some() || self.model.is_none()
    }
}

/// One OpenRouter model as offered in the picker, with its live price.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenRouterModel {
    pub(crate) slug: String,
    pub(crate) description: String,
}

/// Top-tier OpenRouter models with their current prices, newest first.
///
/// Returns empty on any failure: an empty picker group is honest, whereas
/// invented models or stale hardcoded prices are not.
async fn fetch_openrouter_top_models(base_url: String) -> Vec<OpenRouterModel> {
    let root = base_url.trim_end_matches('/');
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(OPENROUTER_MODELS_FETCH_TIMEOUT)
        .timeout(OPENROUTER_MODELS_FETCH_TIMEOUT)
        .build()
    else {
        return Vec::new();
    };
    let Ok(response) = client.get(format!("{root}/models")).send().await else {
        return Vec::new();
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    openrouter_models_from_response(&body)
}

pub(crate) fn openrouter_models_from_response(body: &serde_json::Value) -> Vec<OpenRouterModel> {
    let Some(entries) = body.get("data").and_then(|data| data.as_array()) else {
        return Vec::new();
    };
    let price_per_million = |pricing: Option<&serde_json::Value>, key: &str| {
        pricing
            .and_then(|pricing| pricing.get(key))
            .and_then(|value| value.as_str())
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value * 1_000_000.0)
    };
    let mut models: Vec<(i64, OpenRouterModel)> = entries
        .iter()
        .filter_map(|entry| {
            let slug = entry.get("id")?.as_str()?;
            // `~`-prefixed ids are moving aliases and `:free`/`:batch` variants are
            // not what "top tier" means; both would misreport what a turn will cost.
            if slug.starts_with('~') || slug.contains(":free") || slug.contains(":batch") {
                return None;
            }
            if !OPENROUTER_TOP_TIER_FAMILIES
                .iter()
                .any(|family| slug.starts_with(family))
            {
                return None;
            }
            let context = entry
                .get("context_length")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            if context < 100_000 {
                return None;
            }
            let pricing = entry.get("pricing");
            let input = price_per_million(pricing, "prompt")?;
            let output = price_per_million(pricing, "completion")?;
            if input <= 0.0 && output <= 0.0 {
                return None;
            }
            let created = entry
                .get("created")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0);
            Some((
                created,
                OpenRouterModel {
                    slug: slug.to_string(),
                    description: format!(
                        "${input:.2}/M in · ${output:.2}/M out · {} context",
                        token_count_label(context)
                    ),
                },
            ))
        })
        .collect();
    models.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.slug.cmp(&right.1.slug))
    });
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .filter(|(_, model)| seen.insert(model.slug.clone()))
        .map(|(_, model)| model)
        .collect()
}

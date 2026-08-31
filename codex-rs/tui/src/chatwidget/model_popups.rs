// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Model, collaboration, and reasoning popups for `ChatWidget`.
//!
//! These surfaces are tightly related because changing one often redirects
//! into another, especially while Plan mode is active.

use super::*;
use codex_model_provider_info::OLLAMA_OSS_PROVIDER_ID;
use codex_model_provider_info::OPENAI_PROVIDER_ID;
use codex_model_provider_info::OPENROUTER_BASE_URL;
use ratatui::text::Span;

const ULTRA_REASONING_CONCURRENCY_WARNING_THRESHOLD: usize = 8;
const OLLAMA_MODELS_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
pub(super) const MODEL_SELECTION_VIEW_ID: &str = "model-selection";
pub(super) const ALL_MODELS_SELECTION_VIEW_ID: &str = "all-models-selection";

impl ChatWidget {
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

        let active_provider_id = self.active_model_provider_id().to_string();
        let presets = self.models_for_active_provider();
        self.refresh_ollama_models();
        self.request_model_catalog(Some(active_provider_id.clone()));
        if active_provider_id != OPENAI_PROVIDER_ID {
            self.request_model_catalog(Some(OPENAI_PROVIDER_ID.to_string()));
        }
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

    /// Appends an "OLLAMA" group listing locally installed models below whatever the active
    /// provider's models are, mirroring `push_openrouter_free_model_group`. Selecting one
    /// switches both the model and the provider for the active thread, and persists both to
    /// config.toml so the next launch starts on the same local model.
    ///
    /// Listed even while Ollama is the active provider: the group above it comes from the
    /// hosted model catalog, which never contains locally installed models, so skipping this
    /// group would leave a thread running on Ollama with no way to see or reach its own models.
    fn push_ollama_model_group(&self, items: &mut Vec<SelectionItem>) {
        if self.ollama_local_models.is_empty() {
            return;
        }
        items.push(SelectionItem {
            name: "OLLAMA".to_string(),
            is_disabled: true,
            ..Default::default()
        });
        for model in &self.ollama_local_models {
            let model = model.clone();
            let model_for_action = model.clone();
            items.push(SelectionItem {
                name: model,
                description: Some("Runs on this machine via Ollama".to_string()),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::ApplyProviderModelSelection {
                        model: model_for_action.clone(),
                        provider_id: OLLAMA_OSS_PROVIDER_ID.to_string(),
                        effort: None,
                    });
                })],
                dismiss_on_select: true,
                ..Default::default()
            });
        }
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

    fn model_provider_group_item(&self) -> SelectionItem {
        SelectionItem {
            name: self.model_provider_display_name().to_uppercase(),
            is_disabled: true,
            ..Default::default()
        }
    }

    /// Whether the currently active provider is already OpenRouter -- if so, its free
    /// models are already listed under the normal provider group above, and appending
    /// a second OPENROUTER group would just duplicate them.
    fn is_openrouter_active(&self) -> bool {
        self.config.model_provider.base_url.as_deref() == Some(OPENROUTER_BASE_URL)
    }

    /// Appends an always-visible "OPENROUTER" group and its free models below whatever
    /// the active provider's models are, mirroring how OPENAI's models are grouped.
    /// Selecting one while a different provider is active can't take effect immediately --
    /// provider selection is a launch-time choice (`--provider`), and switching providers
    /// mid-session isn't wired at the protocol layer -- so the action tells the user how to
    /// actually use it instead of silently no-op'ing.
    fn push_openrouter_free_model_group(&self, items: &mut Vec<SelectionItem>) {
        if self.is_openrouter_active() {
            return;
        }
        items.push(SelectionItem {
            name: "OPENROUTER".to_string(),
            is_disabled: true,
            ..Default::default()
        });
        for preset in codex_model_provider::openrouter_free_model_catalog().models {
            let preset: ModelPreset = preset.into();
            let model = preset.model.clone();
            items.push(SelectionItem {
                name: model.clone(),
                description: Some(preset.description.clone()),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::UpdateModel(model.clone()));
                    tx.send(AppEvent::PersistModelSelection {
                        model: model.clone(),
                        effort: None,
                    });
                })],
                dismiss_on_select: true,
                ..Default::default()
            });
        }
    }

    /// Appends the account-scoped OpenAI catalog below a different active provider.
    /// The list is fetched through the app server with the existing ChatGPT authentication;
    /// until it arrives the picker renders an explicit loading row instead of invented models.
    fn push_openai_model_group(&self, items: &mut Vec<SelectionItem>) {
        if self.active_model_provider_id() == OPENAI_PROVIDER_ID {
            return;
        }
        items.push(SelectionItem {
            name: "OPENAI".to_string(),
            is_disabled: true,
            ..Default::default()
        });
        let Some(presets) = self.model_catalog.models_for_provider(OPENAI_PROVIDER_ID) else {
            let item = if self.model_popup_request_is_pending(OPENAI_PROVIDER_ID) {
                SelectionItem {
                    name: "Loading available OpenAI models…".to_string(),
                    description: Some("Uses the connected ChatGPT subscription".to_string()),
                    is_disabled: true,
                    ..Default::default()
                }
            } else {
                SelectionItem {
                    name: "OpenAI unavailable - retry with /model".to_string(),
                    is_disabled: true,
                    ..Default::default()
                }
            };
            items.push(item);
            return;
        };
        let mut visible_count = 0;
        for preset in presets.into_iter().filter(|preset| preset.show_in_picker) {
            visible_count += 1;
            let model = preset.model.clone();
            let preset_for_action = preset.clone();
            let single_supported_effort = preset.supported_reasoning_efforts.len() == 1;
            items.push(SelectionItem {
                name: model.clone(),
                description: Some(preset.description),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::OpenReasoningPopup {
                        model: preset_for_action.clone(),
                        provider_id: Some(OPENAI_PROVIDER_ID.to_string()),
                    });
                })],
                dismiss_on_select: single_supported_effort,
                dismiss_parent_on_child_accept: !single_supported_effort,
                ..Default::default()
            });
        }
        if visible_count == 0 {
            items.push(SelectionItem {
                name: "No selectable OpenAI models are available".to_string(),
                is_disabled: true,
                ..Default::default()
            });
        }
    }

    fn model_provider_route(&self) -> crate::branding::ProviderRoute {
        crate::branding::ProviderRoute::for_provider(
            &self.config.model_provider_id,
            &self.config.model_provider.name,
            self.config.model_provider.wire_api,
            self.custom_openai_base_url().is_some(),
        )
    }

    fn model_protocol_label(&self) -> String {
        self.config.model_provider.wire_api.to_string()
    }

    fn model_credential_label(&self) -> String {
        if self.config.model_provider.requires_openai_auth {
            return "OpenAI/ChatGPT credential store".to_string();
        }
        if let Some(env_key) = self.config.model_provider.env_key.as_deref() {
            return format!("environment variable {env_key}");
        }
        if let Some(headers) = self.config.model_provider.env_http_headers.as_ref()
            && !headers.is_empty()
        {
            let mut env_names = headers.values().cloned().collect::<Vec<_>>();
            env_names.sort();
            env_names.dedup();
            return format!("environment header {}", env_names.join(", "));
        }
        if self.config.model_provider.auth.is_some() {
            return "command-backed bearer token".to_string();
        }
        if self.config.model_provider.aws.is_some() {
            return "AWS SigV4 credential chain".to_string();
        }
        if self
            .config
            .model_provider
            .experimental_bearer_token
            .is_some()
        {
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
        let provider = self.model_provider_display_name();
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
        header.push(Line::from(
            format!("Model: {}", self.current_model()).bold(),
        ));
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
        let presets: Vec<ModelPreset> = presets
            .into_iter()
            .filter(|preset| preset.show_in_picker)
            .collect();
        let auto_routing_item = self.auto_model_routing_item(&presets);

        let current_model = self.current_model();
        let current_label = presets
            .iter()
            .find(|preset| preset.model.as_str() == current_model)
            .map(|preset| preset.model.to_string())
            .unwrap_or_else(|| self.model_display_name().to_string());

        let (mut auto_presets, other_presets): (Vec<ModelPreset>, Vec<ModelPreset>) = presets
            .into_iter()
            .partition(|preset| Self::is_auto_model(&preset.model));

        auto_presets.sort_by_key(|preset| Self::auto_model_order(&preset.model));
        let mut items: Vec<SelectionItem> = auto_presets
            .into_iter()
            .map(|preset| {
                let description = Some(self.model_route_description(&preset.description));
                let model = preset.model.clone();
                let requires_advanced_selection =
                    Self::is_advanced_reasoning_effort(&preset.default_reasoning_effort)
                        || preset
                            .supported_reasoning_efforts
                            .iter()
                            .any(|option| Self::is_advanced_reasoning_effort(&option.effort));
                let actions: Vec<SelectionAction> = if requires_advanced_selection {
                    let preset_for_action = preset.clone();
                    vec![Box::new(move |tx| {
                        tx.send(AppEvent::OpenReasoningPopup {
                            model: preset_for_action.clone(),
                            provider_id: None,
                        });
                    })]
                } else {
                    let should_prompt_plan_mode_scope = self
                        .should_prompt_plan_mode_reasoning_scope(
                            model.as_str(),
                            Some(preset.default_reasoning_effort.clone()),
                        );
                    self.model_selection_actions(
                        model.clone(),
                        Some(preset.default_reasoning_effort.clone()),
                        None,
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

        self.push_openai_model_group(&mut items);
        self.push_openrouter_free_model_group(&mut items);
        self.push_ollama_model_group(&mut items);
        items.insert(0, self.model_provider_group_item());
        items.insert(1, auto_routing_item);

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

    fn auto_model_routing_item(&self, presets: &[ModelPreset]) -> SelectionItem {
        let available = self.auto_model_routing_available()
            && presets.iter().any(|preset| {
                preset.model.as_str() == crate::chatwidget::model_routing::TERRA_MODEL
            });
        let description = if available {
            "Elpis automatically chooses the right model for the task".to_string()
        } else {
            "Requires this provider to offer GPT-5.6 Luna, Terra, and Sol.".to_string()
        };
        let mut actions: Vec<SelectionAction> = Vec::new();
        if available {
            actions.push(Box::new(|tx| {
                tx.send(AppEvent::EnableAutoModelRouting);
            }));
        }
        SelectionItem {
            name: "Auto".to_string(),
            description: Some(description),
            is_current: self.auto_model_routing_enabled(),
            is_disabled: !available,
            actions,
            dismiss_on_select: available,
            ..Default::default()
        }
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
            let single_supported_effort = preset.supported_reasoning_efforts.len() == 1;
            let preset_for_action = preset.clone();
            let actions: Vec<SelectionAction> = vec![Box::new(move |tx| {
                let preset_for_event = preset_for_action.clone();
                tx.send(AppEvent::OpenReasoningPopup {
                    model: preset_for_event,
                    provider_id: None,
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
        self.push_openai_model_group(&mut items);
        self.push_openrouter_free_model_group(&mut items);
        self.push_ollama_model_group(&mut items);

        let header = self.model_menu_header(
            "Choose a mind and effort",
            "Models are grouped under the active provider and routing mode.",
        );
        self.show_model_selection_view(SelectionViewParams {
            view_id: Some(ALL_MODELS_SELECTION_VIEW_ID),
            footer_hint: Some(self.bottom_pane.standard_popup_hint_line()),
            items,
            header,
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

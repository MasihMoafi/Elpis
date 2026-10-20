//! Settings-adjacent popup surfaces for `ChatWidget`.
//!
//! This keeps theme and experimental-feature UI out of the main
//! orchestration module without changing their event wiring.

use super::*;
use std::collections::HashMap;

impl ChatWidget {
    pub(crate) fn open_config_panel(
        &mut self,
        request_handle: codex_app_server_client::AppServerRequestHandle,
        section: Option<&str>,
    ) {
        let mut local_values = HashMap::new();
        local_values.insert("Model", self.current_model().to_string());
        local_values.insert(
            "Reasoning effort",
            self.current_reasoning_effort()
                .map_or_else(|| "default".to_string(), |effort| effort.to_string()),
        );
        local_values.insert(
            "Permissions",
            format!("{:?}", self.config.permissions.approval_policy.value()),
        );
        local_values.insert(
            "Account",
            if self.has_codex_backend_auth {
                "connected"
            } else {
                "not connected"
            }
            .to_string(),
        );
        local_values.insert(
            "Experimental features",
            format!("{} enabled", self.config.features.enabled_features().len()),
        );
        local_values.insert(
            "Context Ledger",
            if self.thread_id().is_some() {
                "active"
            } else {
                "unavailable"
            }
            .to_string(),
        );
        local_values.insert(
            "Pruner model",
            crate::legacy_core::pruner_settings::PrunerSettings::load(
                self.config.codex_home.as_path(),
            )
            .ok()
            .and_then(|settings| settings.model)
            .unwrap_or_else(|| "provider default".to_string()),
        );
        local_values.insert(
            "Voice settings",
            self.config.realtime.voice.map_or_else(
                || "default".to_string(),
                |voice| voice.wire_name().to_string(),
            ),
        );
        local_values.insert(
            "Keymap",
            if self.local_settings.tui.keymap == Default::default() {
                "default"
            } else {
                "custom"
            }
            .to_string(),
        );
        local_values.insert(
            "Theme",
            self.local_settings
                .tui
                .theme
                .clone()
                .unwrap_or_else(|| "default".to_string()),
        );
        local_values.insert(
            "Vim mode",
            if self.bottom_pane.composer_is_vim_enabled() {
                "on"
            } else {
                "off"
            }
            .to_string(),
        );
        local_values.insert(
            "Pets",
            self.local_settings
                .tui
                .pet
                .clone()
                .unwrap_or_else(|| "hidden".to_string()),
        );
        local_values.insert(
            "TUI mode",
            if self.local_settings.tui.fullscreen_transcript {
                "fullscreen transcript"
            } else {
                "inline"
            }
            .to_string(),
        );
        local_values.insert(
            "Ledger width",
            self.local_settings
                .tui
                .context_ledger_width
                .map_or_else(|| "automatic".to_string(), |width| width.to_string()),
        );
        local_values.insert(
            "Status line",
            self.local_settings.tui.status_line.as_ref().map_or_else(
                || "default".to_string(),
                |items| format!("{} items", items.len()),
            ),
        );
        local_values.insert(
            "Terminal title",
            self.local_settings.tui.terminal_title.as_ref().map_or_else(
                || "default".to_string(),
                |items| format!("{} items", items.len()),
            ),
        );
        let cwd = self.current_cwd.as_ref().map_or_else(
            || self.config.cwd.display().to_string(),
            |cwd| cwd.display().to_string(),
        );
        self.bottom_pane
            .show_view(Box::new(crate::bottom_pane::ConfigPanelView::new(
                section,
                request_handle,
                cwd,
                self.app_event_tx.clone(),
                local_values,
            )));
    }

    pub(crate) fn open_config_shortcut(&mut self, command: SlashCommand) {
        self.dispatch_command(command);
    }

    pub(super) fn open_theme_picker(&mut self) {
        let codex_home = codex_utils_home_dir::find_codex_home().ok();
        let params = crate::theme_picker::build_theme_picker_params(
            self.local_settings.tui.theme.as_deref(),
            codex_home.as_deref(),
            self.last_rendered_width.get(),
        );
        self.bottom_pane.show_selection_view(params);
    }

    pub(crate) fn open_experimental_popup(&mut self) {
        let Some(thread_id) = self.thread_id() else {
            self.add_info_message(
                "Experimental features are unavailable until startup completes.".to_string(),
                /*hint*/ None,
            );
            return;
        };
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        self.app_event_tx.send(AppEvent::FetchExperimentalFeatures {
            thread_id,
            response_tx,
        });
        let view = ExperimentalFeaturesView::new(
            Vec::new(),
            thread_id,
            Some(response_rx),
            self.app_event_tx.clone(),
            self.bottom_pane.list_keymap(),
        );
        self.bottom_pane.show_view(Box::new(view));
    }
}

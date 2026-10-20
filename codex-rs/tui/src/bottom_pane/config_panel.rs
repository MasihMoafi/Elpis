//! Searchable settings catalog. Shared defaults come from the app server; terminal
//! controls hand off to their existing pickers and retain the composer draft.

use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ConfigLayerSource;
use codex_app_server_protocol::ConfigReadResponse;
use codex_app_server_protocol::ConfigRequirementsReadResponse;
use codex_app_server_protocol::RequestId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Constraint;
use ratatui::layout::Layout;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::config_update;
use crate::render::renderable::Renderable;
use crate::slash_command::SlashCommand;

use super::CancellationEvent;
use super::bottom_pane_view::BottomPaneView;

pub(crate) const SECTIONS: [&str; 6] = [
    "Models & accounts",
    "Permissions & behavior",
    "Context & maintenance",
    "Connections & coding",
    "App & terminal",
    "Advanced",
];

#[derive(Clone, Copy)]
enum Action {
    Shortcut(SlashCommand),
    VoiceSettings,
    ToggleSmartPruneDefault,
    None,
}

#[derive(Clone, Copy)]
struct Item {
    section: usize,
    name: &'static str,
    scope: &'static str,
    key: Option<&'static str>,
    action: Action,
    hint: &'static str,
}

const ITEMS: &[Item] = &[
    Item {
        section: 0,
        name: "Model",
        scope: "this chat",
        key: Some("model"),
        action: Action::Shortcut(SlashCommand::Model),
        hint: "Choose a model with the existing model picker.",
    },
    Item {
        section: 0,
        name: "Reasoning effort",
        scope: "this chat",
        key: Some("model_reasoning_effort"),
        action: Action::Shortcut(SlashCommand::Effort),
        hint: "Choose reasoning effort.",
    },
    Item {
        section: 0,
        name: "Background model",
        scope: "new chats",
        key: Some("background_model"),
        action: Action::Shortcut(SlashCommand::MemoryModel),
        hint: "Choose the background model.",
    },
    Item {
        section: 0,
        name: "Account",
        scope: "this device",
        key: None,
        action: Action::None,
        hint: "Sign-in is managed by the Elpis account flow outside this terminal panel.",
    },
    Item {
        section: 1,
        name: "Permissions",
        scope: "this chat",
        key: Some("approval_policy"),
        action: Action::Shortcut(SlashCommand::Permissions),
        hint: "Choose the permission profile.",
    },
    Item {
        section: 1,
        name: "Full Access default",
        scope: "new chats",
        key: Some("sandbox_mode"),
        action: Action::Shortcut(SlashCommand::Yolo),
        hint: "Save Full Access as the default.",
    },
    Item {
        section: 1,
        name: "Experimental features",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Experimental),
        hint: "Open the existing experimental features panel.",
    },
    Item {
        section: 2,
        name: "Memories",
        scope: "new chats",
        key: Some("memories.use_memories"),
        action: Action::Shortcut(SlashCommand::Memories),
        hint: "Configure memory use and generation.",
    },
    Item {
        section: 2,
        name: "Smart Prune default",
        scope: "new chats",
        key: Some("features.automatic_context_pruning"),
        action: Action::ToggleSmartPruneDefault,
        hint: "Enter toggles the default for new chats.",
    },
    Item {
        section: 2,
        name: "Pruner model",
        scope: "this device",
        key: None,
        action: Action::Shortcut(SlashCommand::PrunerModel),
        hint: "Choose the maintenance model in pruner settings.",
    },
    Item {
        section: 2,
        name: "Context Ledger",
        scope: "this chat",
        key: None,
        action: Action::Shortcut(SlashCommand::Dashboard),
        hint: "Inspect admitted context and maintenance evidence.",
    },
    Item {
        section: 3,
        name: "MCP tools",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Mcp),
        hint: "Inspect MCP connections and sign in.",
    },
    Item {
        section: 3,
        name: "Apps",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Apps),
        hint: "Manage app connections.",
    },
    Item {
        section: 3,
        name: "Hooks",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Hooks),
        hint: "Inspect and manage lifecycle hooks.",
    },
    Item {
        section: 3,
        name: "Voice settings",
        scope: "this device",
        key: None,
        action: Action::VoiceSettings,
        hint: "Choose a voice with the existing voice settings control.",
    },
    Item {
        section: 4,
        name: "Theme",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Theme),
        hint: "Choose terminal colors.",
    },
    Item {
        section: 4,
        name: "Status line",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Statusline),
        hint: "Configure status line items.",
    },
    Item {
        section: 4,
        name: "Terminal title",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Title),
        hint: "Configure title items.",
    },
    Item {
        section: 4,
        name: "Keymap",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Keymap),
        hint: "Remap terminal shortcuts.",
    },
    Item {
        section: 4,
        name: "Vim mode",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Vim),
        hint: "Toggle composer Vim mode.",
    },
    Item {
        section: 4,
        name: "Pets",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Pets),
        hint: "Choose or hide the terminal pet.",
    },
    Item {
        section: 4,
        name: "TUI mode",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Tui),
        hint: "Choose the mode for the next launch.",
    },
    Item {
        section: 4,
        name: "Ledger width",
        scope: "terminal",
        key: None,
        action: Action::Shortcut(SlashCommand::Dashboard),
        hint: "Open the Ledger, then drag its divider to resize it.",
    },
    Item {
        section: 5,
        name: "Config layers",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::DebugConfig),
        hint: "Inspect effective config layers and managed requirements.",
    },
    Item {
        section: 5,
        name: "Open config file",
        scope: "this device",
        key: None,
        action: Action::None,
        hint: "Use your editor to open the config file shown by Config layers.",
    },
];

struct Snapshot {
    config: ConfigReadResponse,
    requirements: ConfigRequirementsReadResponse,
}

async fn read_snapshot(handle: AppServerRequestHandle, cwd: String) -> Result<Snapshot, String> {
    let config = tokio::time::timeout(
        Duration::from_secs(5),
        config_update::read_config_with_layers(handle.clone(), cwd),
    )
    .await
    .map_err(|_| "config/read timed out".to_string())?
    .map_err(|error| config_update::format_config_error(&error))?;
    let requirements = tokio::time::timeout(
        Duration::from_secs(5),
        handle.request_typed(ClientRequest::ConfigRequirementsRead {
            request_id: RequestId::String(format!(
                "tui-config-panel-requirements-{}",
                Uuid::new_v4()
            )),
            params: None,
        }),
    )
    .await
    .map_err(|_| "configRequirements/read timed out".to_string())?
    .map_err(|error| format!("configRequirements/read failed: {error}"))?;
    Ok(Snapshot {
        config,
        requirements,
    })
}

pub(crate) struct ConfigPanelView {
    handle: AppServerRequestHandle,
    cwd: String,
    app_event_tx: AppEventSender,
    local_values: HashMap<&'static str, String>,
    snapshot: Option<Snapshot>,
    read_rx: Option<oneshot::Receiver<Result<Snapshot, String>>>,
    write_rx: Option<oneshot::Receiver<Result<Snapshot, String>>>,
    query: String,
    selected: usize,
    detail_focus: bool,
    complete: bool,
    status: String,
}

impl ConfigPanelView {
    pub(crate) fn new(
        section: Option<&str>,
        handle: AppServerRequestHandle,
        cwd: String,
        app_event_tx: AppEventSender,
        local_values: HashMap<&'static str, String>,
    ) -> Self {
        let selected = section
            .and_then(section_index)
            .and_then(|index| ITEMS.iter().position(|item| item.section == index))
            .unwrap_or(0);
        let mut view = Self {
            handle,
            cwd,
            app_event_tx,
            local_values,
            snapshot: None,
            read_rx: None,
            write_rx: None,
            query: String::new(),
            selected,
            detail_focus: false,
            complete: false,
            status: "Loading effective settings…".to_string(),
        };
        view.refresh();
        view
    }

    fn refresh(&mut self) {
        let (tx, rx) = oneshot::channel();
        let handle = self.handle.clone();
        let cwd = self.cwd.clone();
        tokio::spawn(async move {
            let _ = tx.send(read_snapshot(handle, cwd).await);
        });
        self.read_rx = Some(rx);
    }

    fn filtered(&self) -> Vec<usize> {
        let query = self.query.to_lowercase();
        ITEMS
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                (query.is_empty()
                    || item.name.to_lowercase().contains(&query)
                    || SECTIONS[item.section].to_lowercase().contains(&query))
                .then_some(index)
            })
            .collect()
    }

    fn selected_item(&self) -> Option<Item> {
        ITEMS.get(*self.filtered().get(self.selected)?).copied()
    }

    fn value(&self, item: Item) -> String {
        if let Some(value) = self.local_values.get(item.name) {
            return value.clone();
        }
        let Some(snapshot) = &self.snapshot else {
            return "Loading…".to_string();
        };
        let Some(key) = item.key else {
            return "Open to view".to_string();
        };
        let config = serde_json::to_value(&snapshot.config.config).unwrap_or_default();
        let value = key
            .split('.')
            .fold(Some(&config), |node, part| node?.get(part));
        match value {
            Some(serde_json::Value::String(value)) => value.clone(),
            Some(serde_json::Value::Bool(value)) => if *value { "on" } else { "off" }.to_string(),
            Some(serde_json::Value::Number(value)) => value.to_string(),
            _ => "default".to_string(),
        }
    }

    fn source(&self, item: Item) -> &'static str {
        if item.scope == "terminal" {
            return "terminal preferences";
        }
        if item.scope == "this device" {
            return "device preferences";
        }
        let Some(key) = item.key else {
            return "current session";
        };
        let Some(snapshot) = &self.snapshot else {
            return if item.scope == "this chat" {
                "active thread"
            } else {
                "loading"
            };
        };
        let origin = snapshot.config.origins.get(key).map(|origin| &origin.name);
        if matches!(
            origin,
            Some(
                ConfigLayerSource::Mdm { .. }
                    | ConfigLayerSource::System { .. }
                    | ConfigLayerSource::EnterpriseManaged { .. }
                    | ConfigLayerSource::LegacyManagedConfigTomlFromFile { .. }
                    | ConfigLayerSource::LegacyManagedConfigTomlFromMdm
            )
        ) {
            return "managed config";
        }
        if item.scope == "this chat" {
            return "active thread";
        }
        match origin {
            Some(ConfigLayerSource::User { .. }) => "user config",
            Some(ConfigLayerSource::Project { .. }) => "project config",
            Some(ConfigLayerSource::SessionFlags) => "session flags",
            Some(ConfigLayerSource::PackagedDefaults { .. }) => "packaged defaults",
            _ => "built-in default",
        }
    }

    fn disabled_reason(&self, item: Item) -> Option<String> {
        if matches!(item.action, Action::None) {
            return Some(item.hint.to_string());
        }
        let Some(snapshot) = &self.snapshot else {
            return matches!(item.action, Action::ToggleSmartPruneDefault)
                .then(|| "Effective settings are unavailable.".to_string());
        };
        if let Some(key) = item.key {
            if matches!(
                snapshot.config.origins.get(key).map(|origin| &origin.name),
                Some(
                    ConfigLayerSource::Mdm { .. }
                        | ConfigLayerSource::System { .. }
                        | ConfigLayerSource::EnterpriseManaged { .. }
                        | ConfigLayerSource::LegacyManagedConfigTomlFromFile { .. }
                        | ConfigLayerSource::LegacyManagedConfigTomlFromMdm
                )
            ) {
                return Some("Managed policy controls this value.".to_string());
            }
            if matches!(
                snapshot.config.origins.get(key).map(|origin| &origin.name),
                Some(ConfigLayerSource::Project { .. } | ConfigLayerSource::SessionFlags)
            ) {
                return Some("A project or session override controls this value.".to_string());
            }
            if key == "features.automatic_context_pruning"
                && snapshot
                    .requirements
                    .requirements
                    .as_ref()
                    .and_then(|requirements| requirements.feature_requirements.as_ref())
                    .is_some_and(|features| features.contains_key("automatic_context_pruning"))
            {
                return Some("Managed policy controls Smart Prune.".to_string());
            }
            if key == "approval_policy"
                && snapshot
                    .requirements
                    .requirements
                    .as_ref()
                    .and_then(|requirements| requirements.allowed_approval_policies.as_ref())
                    .is_some_and(|policies| policies.len() == 1)
            {
                return Some("Managed policy allows only one approval policy.".to_string());
            }
        }
        if matches!(item.action, Action::ToggleSmartPruneDefault) && self.user_version().is_none() {
            return Some("Writable user config layer is unavailable.".to_string());
        }
        None
    }

    fn user_version(&self) -> Option<String> {
        self.snapshot
            .as_ref()?
            .config
            .layers
            .as_ref()?
            .iter()
            .find_map(|layer| {
                (layer.disabled_reason.is_none()
                    && matches!(&layer.name, ConfigLayerSource::User { profile: None, .. }))
                .then(|| layer.version.clone())
            })
    }

    fn activate(&mut self) {
        let Some(item) = self.selected_item() else {
            return;
        };
        if let Some(reason) = self.disabled_reason(item) {
            self.status = reason;
            return;
        }
        match item.action {
            Action::Shortcut(command) => {
                self.complete = true;
                self.app_event_tx
                    .send(AppEvent::ConfigPanelShortcut(command));
            }
            Action::VoiceSettings => {
                self.complete = true;
                self.app_event_tx.send(AppEvent::OpenRealtimeSettings);
            }
            Action::ToggleSmartPruneDefault => {
                if self.write_rx.is_some() {
                    return;
                }
                let Some(version) = self.user_version() else {
                    return;
                };
                let next = self.value(item) != "on";
                let edit = config_update::replace_config_value(
                    "features.automatic_context_pruning",
                    serde_json::json!(next),
                );
                let handle = self.handle.clone();
                let cwd = self.cwd.clone();
                let (tx, rx) = oneshot::channel();
                self.write_rx = Some(rx);
                self.status = "Saving default…".to_string();
                tokio::spawn(async move {
                    let result = async {
                        tokio::time::timeout(
                            Duration::from_secs(15),
                            config_update::write_config_batch_with_version(
                                handle.clone(),
                                vec![edit],
                                Some(version),
                            ),
                        )
                        .await
                        .map_err(|_| "config/batchWrite timed out".to_string())?
                        .map_err(|error| config_update::format_config_error(&error))?;
                        read_snapshot(handle, cwd)
                            .await
                            .map_err(|_| "readback failed after save".to_string())
                    }
                    .await;
                    let _ = tx.send(result);
                });
            }
            Action::None => {}
        }
    }
}

fn section_index(section: &str) -> Option<usize> {
    let normalized = section.trim().to_lowercase().replace('-', " ");
    SECTIONS
        .iter()
        .position(|name| name.to_lowercase() == normalized)
        .or_else(|| {
            SECTIONS
                .iter()
                .position(|name| name.to_lowercase().starts_with(&normalized))
        })
}

impl BottomPaneView for ConfigPanelView {
    fn handle_key_event(&mut self, key: KeyEvent) {
        match key {
            KeyEvent {
                code: KeyCode::Up, ..
            } => self.selected = self.selected.saturating_sub(1),
            KeyEvent {
                code: KeyCode::Down,
                ..
            } => {
                self.selected = (self.selected + 1).min(self.filtered().len().saturating_sub(1));
            }
            KeyEvent {
                code: KeyCode::Tab | KeyCode::BackTab,
                ..
            } => self.detail_focus = !self.detail_focus,
            KeyEvent {
                code: KeyCode::Enter,
                ..
            } => self.activate(),
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                self.query.pop();
                self.selected = 0;
            }
            KeyEvent {
                code: KeyCode::Char(ch),
                modifiers: KeyModifiers::NONE | KeyModifiers::SHIFT,
                ..
            } => {
                self.query.push(ch);
                self.selected = 0;
            }
            _ => {}
        }
    }

    fn on_ctrl_c(&mut self) -> CancellationEvent {
        self.complete = true;
        CancellationEvent::Handled
    }

    fn is_complete(&self) -> bool {
        self.complete
    }

    fn pre_draw_tick(&mut self, _now: Instant) -> bool {
        let mut changed = false;
        if let Some(rx) = self.read_rx.as_mut() {
            match rx.try_recv() {
                Ok(result) => {
                    self.read_rx = None;
                    match result {
                        Ok(snapshot) => {
                            self.snapshot = Some(snapshot);
                            self.status.clear();
                        }
                        Err(_error) => {
                            self.status =
                                "Could not load settings. Reopen /config to retry.".to_string()
                        }
                    }
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    self.read_rx = None;
                    self.status = "Settings read was interrupted.".to_string();
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
        }
        if let Some(rx) = self.write_rx.as_mut() {
            match rx.try_recv() {
                Ok(result) => {
                    self.write_rx = None;
                    match result {
                        Ok(snapshot) => {
                            self.snapshot = Some(snapshot);
                            self.status = "Default saved and re-read.".to_string();
                        }
                        Err(error) => self.status = save_failure_reason(&error).to_string(),
                    }
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    self.write_rx = None;
                    self.status = "Save outcome unknown. Reopen /config to re-read.".to_string();
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
        }
        changed
    }

    fn next_frame_delay(&self) -> Option<Duration> {
        (self.read_rx.is_some() || self.write_rx.is_some()).then(|| Duration::from_millis(100))
    }
}

fn save_failure_reason(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("readback") || error.contains("timed out") {
        "Save outcome unknown. Reopen /config to re-read the effective value."
    } else if error.contains("version") || error.contains("conflict") {
        "Default unchanged: config changed elsewhere. Reopen /config and retry."
    } else if error.contains("readonly")
        || error.contains("managed")
        || error.contains("requirement")
    {
        "Default unchanged: managed policy or a read-only layer prevents this change."
    } else if error.contains("validation") || error.contains("invalid") {
        "Default unchanged: the server rejected this value."
    } else {
        "Default unchanged: save failed. Reopen /config to re-read."
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy_core::config::ConfigBuilder;
    use codex_app_server_client::AppServerClient;

    async fn panel(
        section: Option<&str>,
    ) -> color_eyre::Result<(tempfile::TempDir, AppServerClient, ConfigPanelView)> {
        let home = tempfile::tempdir()?;
        let config = ConfigBuilder::default()
            .codex_home(home.path().to_path_buf())
            .build()
            .await?;
        let server =
            AppServerClient::InProcess(crate::tests::start_test_embedded_app_server(config).await?);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let view = ConfigPanelView::new(
            section,
            server.request_handle(),
            home.path().display().to_string(),
            AppEventSender::new(tx),
            HashMap::from([("Model", "gpt-5.5".to_string())]),
        );
        Ok((home, server, view))
    }

    #[tokio::test]
    async fn permissions_section_opens_at_first_permission_row() -> color_eyre::Result<()> {
        let (_home, _server, view) = panel(Some("permissions")).await?;
        assert_eq!(
            view.selected_item().map(|item| item.name),
            Some("Permissions")
        );
        assert_eq!(section_index("Permissions & behavior"), Some(1));
        Ok(())
    }

    #[tokio::test]
    async fn typing_filters_rows_and_tab_moves_focus() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = panel(None).await?;
        for ch in "theme".chars() {
            view.handle_key_event(KeyCode::Char(ch).into());
        }
        assert_eq!(view.filtered().len(), 1);
        assert_eq!(view.selected_item().map(|item| item.name), Some("Theme"));
        view.handle_key_event(KeyCode::Tab.into());
        assert!(view.detail_focus);
        view.handle_key_event(KeyCode::BackTab.into());
        assert!(!view.detail_focus);
        Ok(())
    }

    #[tokio::test]
    async fn managed_smart_prune_default_cannot_send_a_write() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = panel(Some("context")).await?;
        let config = ConfigReadResponse {
            config: serde_json::from_value(serde_json::json!({
                "features": {"automatic_context_pruning": true}
            }))?,
            origins: HashMap::from([(
                "features.automatic_context_pruning".to_string(),
                codex_app_server_protocol::ConfigLayerMetadata {
                    name: ConfigLayerSource::LegacyManagedConfigTomlFromMdm,
                    version: "managed".to_string(),
                },
            )]),
            layers: Some(Vec::new()),
        };
        let requirements = ConfigRequirementsReadResponse {
            supports_independent_speed_modes: None,
            requirements: None,
        };
        view.snapshot = Some(Snapshot {
            config,
            requirements,
        });
        view.selected = view
            .filtered()
            .iter()
            .position(|index| ITEMS[*index].name == "Smart Prune default")
            .unwrap();
        view.activate();
        assert!(view.write_rx.is_none());
        assert!(view.status.contains("Managed policy"));
        Ok(())
    }

    #[tokio::test]
    async fn smart_prune_default_write_returns_re_read_effective_value() -> color_eyre::Result<()> {
        let (home, server, mut view) = panel(Some("context")).await?;
        view.snapshot = Some(
            read_snapshot(server.request_handle(), home.path().display().to_string())
                .await
                .map_err(|error| color_eyre::eyre::eyre!(error))?,
        );
        view.read_rx = None;
        view.selected = view
            .filtered()
            .iter()
            .position(|index| ITEMS[*index].name == "Smart Prune default")
            .unwrap();
        view.activate();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            view.write_rx.take().expect("write requested"),
        )
        .await
        .expect("write timed out")
        .expect("write result dropped")
        .expect("write or readback failed");
        let effective = serde_json::to_value(&result.config.config)?;
        assert_eq!(effective["features"]["automatic_context_pruning"], true);
        Ok(())
    }

    #[tokio::test]
    async fn panel_at_80x24_snapshot() -> color_eyre::Result<()> {
        let (_home, _server, view) = panel(None).await?;
        let area = Rect::new(0, 0, 80, 24);
        let mut buffer = Buffer::empty(area);
        view.render(area, &mut buffer);
        let screen = (0..24)
            .map(|row| {
                (0..80)
                    .map(|col| buffer[(col, row)].symbol())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let labels = [
            "Settings  /config",
            "Search: _",
            "Models & accounts",
            "Model",
            "Value: gpt-5.5",
            "Scope: this chat",
            "Source: active thread",
            "Enter edit",
            "Loading effective settings",
        ];
        for label in labels {
            assert!(screen.contains(label), "missing {label} in 80x24 panel");
        }
        let positions = [
            ("title", "Settings  /config"),
            ("search", "Search: _"),
            ("section", "Models & accounts"),
            ("value", "Value: gpt-5.5"),
            ("scope", "Scope: this chat"),
            ("source", "Source: active thread"),
            ("hint", "Enter edit"),
            ("status", "Loading effective settings"),
        ]
        .map(|(name, needle)| {
            let row = screen
                .lines()
                .position(|line| line.contains(needle))
                .unwrap();
            format!("{name}: {row}")
        })
        .join("\n");
        insta::assert_snapshot!(positions, @"title: 0\nsearch: 1\nsection: 3\nvalue: 5\nscope: 6\nsource: 7\nhint: 22\nstatus: 23");
        Ok(())
    }
}

impl Renderable for ConfigPanelView {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let [heading, body, footer] = Layout::vertical([
            Constraint::Length(2),
            Constraint::Fill(1),
            Constraint::Length(2),
        ])
        .areas(area);
        Paragraph::new(vec![
            Line::from("Settings  /config".bold()),
            Line::from(format!("Search: {}_", self.query)),
        ])
        .render(heading, buf);
        let [list, detail] =
            Layout::horizontal([Constraint::Percentage(47), Constraint::Percentage(53)])
                .areas(body);
        let visible = self.filtered();
        let selected = self.selected_item();
        let mut lines = Vec::new();
        let mut previous_section = None;
        let max_rows = list.height.saturating_sub(2) as usize;
        let start = self.selected.saturating_sub(max_rows.saturating_sub(3));
        for (position, index) in visible.iter().enumerate().skip(start) {
            let item = ITEMS[*index];
            if previous_section != Some(item.section) {
                lines.push(Line::from(SECTIONS[item.section].bold()));
                previous_section = Some(item.section);
            }
            let prefix = if position == self.selected {
                "› "
            } else {
                "  "
            };
            lines.push(Line::from(format!("{prefix}{}", item.name)));
            if lines.len() >= max_rows {
                break;
            }
        }
        lines.truncate(max_rows);
        if visible.is_empty() {
            lines.push(Line::from("No matching settings"));
        }
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(if self.detail_focus {
                        "List"
                    } else {
                        "List ●"
                    }),
            )
            .render(list, buf);
        let detail_lines = if let Some(item) = selected {
            let reason = self.disabled_reason(item);
            vec![
                Line::from(item.name.bold()),
                Line::from(""),
                Line::from(format!("Value: {}", self.value(item))),
                Line::from(format!("Scope: {}", item.scope)),
                Line::from(format!("Source: {}", self.source(item))),
                Line::from(""),
                Line::from(reason.unwrap_or_else(|| item.hint.to_string())),
            ]
        } else {
            vec![Line::from("No matching setting")]
        };
        Paragraph::new(detail_lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(if self.detail_focus {
                        "Detail ●"
                    } else {
                        "Detail"
                    }),
            )
            .render(detail, buf);
        Paragraph::new(vec![
            Line::from("↑↓ move · Tab switch · Enter edit · Esc cancel"),
            Line::from(self.status.as_str()),
        ])
        .render(footer, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        22
    }
}

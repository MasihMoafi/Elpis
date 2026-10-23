//! Searchable settings catalog. Shared defaults come from the app server; terminal
//! controls hand off to their existing pickers and retain the composer draft.

use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ConfigLayerSource;
use codex_app_server_protocol::ConfigReadResponse;
use codex_app_server_protocol::ConfigRequirementsReadResponse;
use codex_app_server_protocol::GetAccountParams;
use codex_app_server_protocol::GetAccountResponse;
use codex_app_server_protocol::LoginAccountParams;
use codex_app_server_protocol::LoginAccountResponse;
use codex_app_server_protocol::RequestId;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::buffer::Buffer;
use ratatui::layout::Constraint;
use ratatui::layout::Layout;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Block;
use ratatui::widgets::Borders;
use ratatui::widgets::Paragraph;
use ratatui::widgets::StatefulWidgetRef;
use ratatui::widgets::Widget;
use ratatui::widgets::Wrap;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::config_update;
use crate::render::renderable::Renderable;
use crate::slash_command::SlashCommand;

use super::CancellationEvent;
use super::bottom_pane_view::BottomPaneView;
use super::textarea::TextArea;
use super::textarea::TextAreaState;

mod fields;
use fields::EditorKind;

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
    Edit(EditorKind),
    Account,
    ApiKey,
    OpenFile,
    ProviderKeys,
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
        action: Action::Edit(EditorKind::Model),
        hint: "Model ID for this chat only. The saved default stays unchanged.",
    },
    Item {
        section: 0,
        name: "Reasoning effort",
        scope: "this chat",
        key: Some("model_reasoning_effort"),
        action: Action::Edit(EditorKind::Choice(&[
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
            "persistent",
        ])),
        hint: "Reasoning effort for this chat only: none, minimal, low, medium, high, xhigh, max, ultra, persistent.",
    },
    Item {
        section: 0,
        name: "Default model",
        scope: "new chats",
        key: Some("model"),
        action: Action::Edit(EditorKind::Model),
        hint: "Model ID for new chats. Existing chats keep their model.",
    },
    Item {
        section: 0,
        name: "Default provider",
        scope: "new chats",
        key: Some("model_provider"),
        action: Action::Edit(EditorKind::Provider),
        hint: "Choose a configured provider ID.",
    },
    Item {
        section: 0,
        name: "Default reasoning effort",
        scope: "new chats",
        key: Some("model_reasoning_effort"),
        action: Action::Edit(EditorKind::Choice(&[
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
            "persistent",
        ])),
        hint: "none, minimal, low, medium, high, xhigh, max, ultra, persistent. Blank uses the model default.",
    },
    Item {
        section: 0,
        name: "Background model",
        scope: "new chats",
        key: Some("background_model"),
        action: Action::Edit(EditorKind::Model),
        hint: "Model ID used by maintenance when no explicit pruner model is set.",
    },
    Item {
        section: 0,
        name: "Background provider",
        scope: "new chats",
        key: Some("background_provider"),
        action: Action::Edit(EditorKind::Provider),
        hint: "Configured provider ID, or blank to inherit.",
    },
    Item {
        section: 0,
        name: "Account",
        scope: "this device",
        key: None,
        action: Action::Account,
        hint: "Enter starts the supported ChatGPT device-code sign-in. Complete it in your browser; reopen to check the account.",
    },
    Item {
        section: 0,
        name: "OpenAI API key",
        scope: "this device",
        key: None,
        action: Action::ApiKey,
        hint: "Save through the engine's private account login flow. Input is masked and never saved in config.toml.",
    },
    Item {
        section: 0,
        name: "Provider setup",
        scope: "new chats",
        key: Some("model_providers"),
        action: Action::Edit(EditorKind::ProviderSetup),
        hint: "JSON: {\"id\":\"local\",\"name\":\"Local\",\"base_url\":\"http://localhost:1234/v1\",\"wire_api\":\"responses\"}. For keys, use env_key with the name of an environment variable.",
    },
    Item {
        section: 0,
        name: "Provider keys",
        scope: "this device",
        key: None,
        action: Action::ProviderKeys,
        hint: "Open the provider picker, choose a provider, then Add API key. Claude accounts use their existing sign-in flow.",
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
        name: "Default sandbox",
        scope: "new chats",
        key: Some("sandbox_mode"),
        action: Action::Edit(EditorKind::Choice(&[
            "read-only",
            "workspace-write",
            "danger-full-access",
        ])),
        hint: "read-only, workspace-write, danger-full-access. Saves the permission profile when the engine uses profiles.",
    },
    Item {
        section: 1,
        name: "Default approval policy",
        scope: "new chats",
        key: Some("approval_policy"),
        action: Action::Edit(EditorKind::Choice(&["untrusted", "on-request", "never"])),
        hint: "untrusted, on-request, never. Blank restores the default.",
    },
    Item {
        section: 1,
        name: "Web search",
        scope: "new chats",
        key: Some("web_search"),
        action: Action::Edit(EditorKind::Choice(&[
            "disabled", "cached", "indexed", "live",
        ])),
        hint: "disabled, cached, indexed, live.",
    },
    Item {
        section: 1,
        name: "Output detail",
        scope: "new chats",
        key: Some("model_verbosity"),
        action: Action::Edit(EditorKind::Choice(&["low", "medium", "high"])),
        hint: "low, medium, high.",
    },
    Item {
        section: 1,
        name: "Reasoning summary",
        scope: "new chats",
        key: Some("model_reasoning_summary"),
        action: Action::Edit(EditorKind::Choice(&["auto", "concise", "detailed", "none"])),
        hint: "auto, concise, detailed, none.",
    },
    Item {
        section: 1,
        name: "Speed",
        scope: "new chats",
        key: Some("service_tier"),
        action: Action::Edit(EditorKind::Choice(&["default", "fast", "flex"])),
        hint: "default, fast, flex. Supported models only.",
    },
    Item {
        section: 1,
        name: "Custom instructions",
        scope: "new chats",
        key: Some("developer_instructions"),
        action: Action::Edit(EditorKind::Instructions),
        hint: "Instructions for new conversations. Shift+Enter inserts a line; Ctrl+S saves.",
    },
    Item {
        section: 1,
        name: "Feature default",
        scope: "new chats",
        key: Some("features"),
        action: Action::Edit(EditorKind::Feature),
        hint: "Enter a native feature key and on/off, for example: automatic_context_pruning on. Managed requirements are enforced.",
    },
    Item {
        section: 2,
        name: "Memory default",
        scope: "new chats",
        key: Some("features.memories"),
        action: Action::Edit(EditorKind::Switch),
        hint: "on/off. Enables memories for new chats; Ledger admission remains separate.",
    },
    Item {
        section: 2,
        name: "Use memories",
        scope: "new chats",
        key: Some("memories.use_memories"),
        action: Action::Edit(EditorKind::Switch),
        hint: "on/off. New chats may use saved memories if admitted in the Ledger.",
    },
    Item {
        section: 2,
        name: "Generate memories",
        scope: "new chats",
        key: Some("memories.generate_memories"),
        action: Action::Edit(EditorKind::Switch),
        hint: "on/off. Controls memory generation for new chats.",
    },
    Item {
        section: 2,
        name: "Skip external context",
        scope: "new chats",
        key: Some("memories.disable_on_external_context"),
        action: Action::Edit(EditorKind::Switch),
        hint: "on/off. Disable memories for chats with external context.",
    },
    Item {
        section: 2,
        name: "Extraction model",
        scope: "new chats",
        key: Some("memories.extract_model"),
        action: Action::Edit(EditorKind::Model),
        hint: "Memory extraction model ID, or blank to inherit.",
    },
    Item {
        section: 2,
        name: "Consolidation model",
        scope: "new chats",
        key: Some("memories.consolidation_model"),
        action: Action::Edit(EditorKind::Model),
        hint: "Memory consolidation model ID, or blank to inherit.",
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
        section: 3,
        name: "MCP tools",
        scope: "new chats",
        key: Some("mcp_servers"),
        action: Action::Shortcut(SlashCommand::Mcp),
        hint: "Inspect MCP connections and sign in.",
    },
    Item {
        section: 3,
        name: "MCP setup",
        scope: "new chats",
        key: Some("mcp_servers"),
        action: Action::Edit(EditorKind::Mcp),
        hint: "JSON: {\"name\":\"docs\",\"url\":\"https://example.com/mcp\"} or {\"name\":\"docs\",\"enabled\":false}. Also accepts command, args, env_vars, or name with remove:true. Secrets stay in environment variables.",
    },
    Item {
        section: 3,
        name: "Project root markers",
        scope: "new chats",
        key: Some("project_root_markers"),
        action: Action::Edit(EditorKind::Markers),
        hint: "One to sixteen file or folder names separated by commas, for example: .git, .hg. Blank restores the default.",
    },
    Item {
        section: 3,
        name: "Worktree root",
        scope: "new chats",
        key: Some("desktop.git-worktree-root"),
        action: Action::Edit(EditorKind::AbsolutePath),
        hint: "Absolute folder path. Blank uses the worktrees folder in the Elpis home.",
    },
    Item {
        section: 3,
        name: "Apps",
        scope: "new chats",
        key: Some("apps"),
        action: Action::Shortcut(SlashCommand::Apps),
        hint: "Manage app connections.",
    },
    Item {
        section: 3,
        name: "Hooks",
        scope: "new chats",
        key: Some("hooks"),
        action: Action::Shortcut(SlashCommand::Hooks),
        hint: "Inspect and manage lifecycle hooks.",
    },
    Item {
        section: 3,
        name: "Plugins",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Plugins),
        hint: "Browse plugins with the existing plugin manager.",
    },
    Item {
        section: 3,
        name: "Skills",
        scope: "new chats",
        key: None,
        action: Action::Shortcut(SlashCommand::Skills),
        hint: "Browse and manage skills with the existing skills control.",
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
        section: 3,
        name: "Dictation fallback",
        scope: "new chats",
        key: Some("mcp_servers.whispertype.env.WHISPERTYPE_BACKEND"),
        action: Action::Edit(EditorKind::Choice(&["local", "codex", "openrouter"])),
        hint: "WhisperType fallback: local, codex, openrouter. Blank uses the signed-in account, then Local. Add the whispertype MCP server first.",
    },
    Item {
        section: 3,
        name: "Transcription model",
        scope: "new chats",
        key: Some("mcp_servers.whispertype.env.WHISPERTYPE_CLOUD_MODEL"),
        action: Action::Edit(EditorKind::Model),
        hint: "OpenRouter transcription model ID. Add the whispertype MCP server first. New dictation requests use this value.",
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
        action: Action::OpenFile,
        hint: "Open this file in $VISUAL, $EDITOR or Rust Notes. Other advanced keys retain their native owners.",
    },
];

struct Snapshot {
    config: ConfigReadResponse,
    requirements: ConfigRequirementsReadResponse,
    account_connected: Option<bool>,
}

fn effective_values(snapshot: &Snapshot) -> serde_json::Value {
    let mut config = serde_json::to_value(&snapshot.config.config).unwrap_or_default();
    // The highest layer naming either syntax wins, even if the merged config
    // still contains a permission profile inherited from a lower layer.
    if let Some(layer) = snapshot.config.layers.as_ref().and_then(|layers| {
        layers.iter().find(|layer| {
            !layer.config["default_permissions"].is_null()
                || !layer.config["sandbox_mode"].is_null()
        })
    }) && layer.config["default_permissions"].is_null()
        && let Some(config) = config.as_object_mut()
    {
        config.remove("default_permissions");
    }
    config
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
    let account: Option<GetAccountResponse> = tokio::time::timeout(
        Duration::from_secs(5),
        handle.request_typed(ClientRequest::GetAccount {
            request_id: RequestId::String(Uuid::new_v4().to_string()),
            params: GetAccountParams {
                refresh_token: false,
                skip_workspace_routing: true,
            },
        }),
    )
    .await
    .ok()
    .and_then(Result::ok);
    Ok(Snapshot {
        config,
        requirements,
        account_connected: account.map(|account| account.account.is_some()),
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
    editor: Option<TextArea>,
    account_rx: Option<oneshot::Receiver<Result<LoginAccountResponse, String>>>,
    login_id: Option<String>,
    login_message: Option<String>,
    detail_scroll: u16,
    list_hits: RefCell<Vec<(Rect, usize)>>,
    editor_area: Cell<Rect>,
    editor_state: RefCell<TextAreaState>,
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
            editor: None,
            account_rx: None,
            login_id: None,
            login_message: None,
            detail_scroll: 0,
            list_hits: RefCell::new(Vec::new()),
            editor_area: Cell::new(Rect::default()),
            editor_state: RefCell::new(TextAreaState::default()),
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
        if item.name == "Account"
            && let Some(connected) = self
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.account_connected)
        {
            return if connected {
                "connected"
            } else {
                "not connected"
            }
            .to_string();
        }
        if let Some(value) = self.local_values.get(item.name) {
            return value.clone();
        }
        let Some(snapshot) = &self.snapshot else {
            return "Loading…".to_string();
        };
        if item.name == "Config layers" {
            return format!(
                "{} layers",
                snapshot.config.layers.as_ref().map_or(0, Vec::len)
            );
        }
        if item.name == "Open config file" {
            return snapshot
                .config
                .layers
                .as_ref()
                .and_then(|layers| {
                    layers.iter().find_map(|layer| {
                        if let ConfigLayerSource::User {
                            file,
                            profile: None,
                        } = &layer.name
                        {
                            Some(file.display().to_string())
                        } else {
                            None
                        }
                    })
                })
                .unwrap_or_else(|| "unavailable".to_string());
        }
        let Some(key) = item.key else {
            return "Open to view".to_string();
        };
        let config = effective_values(snapshot);
        if item.name == "Default sandbox" && fields::permission_profiles(&config) {
            return match config["default_permissions"].as_str() {
                Some(":read-only") => "read-only",
                Some(":workspace") => "workspace-write",
                Some(":danger-full-access") => "danger-full-access",
                Some(":bypass-permissions") => "bypass-permissions",
                _ => "custom",
            }
            .to_string();
        }
        if item.key == Some("service_tier") && config["service_tier"] == "priority" {
            return "fast".to_string();
        }
        let value = key
            .split('.')
            .fold(Some(&config), |node, part| node?.get(part));
        match value {
            Some(serde_json::Value::String(value)) => value.clone(),
            Some(serde_json::Value::Bool(value)) => if *value { "on" } else { "off" }.to_string(),
            Some(serde_json::Value::Number(value)) => value.to_string(),
            Some(serde_json::Value::Array(value)) => format!("{} configured", value.len()),
            Some(serde_json::Value::Object(value)) => format!("{} configured", value.len()),
            _ => "default".to_string(),
        }
    }

    fn source(&self, item: Item) -> &'static str {
        if item.name == "Pruner model" {
            return "pruner settings";
        }
        if item.name == "Open config file" {
            return "user config";
        }
        if item.name == "Config layers" {
            return "engine config";
        }
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
        let key =
            if key == "sandbox_mode" && fields::permission_profiles(&effective_values(snapshot)) {
                "default_permissions"
            } else {
                key
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
            _ if matches!(key, "features" | "mcp_servers" | "apps" | "hooks") => "merged layers",
            _ => "built-in default",
        }
    }

    fn disabled_reason(&self, item: Item) -> Option<String> {
        if matches!(item.action, Action::OpenFile)
            && crate::external_editor::resolve_config_editor_command().is_err()
        {
            return Some(
                "Set $VISUAL or $EDITOR before starting Elpis to open the config file.".to_string(),
            );
        }
        let Some(snapshot) = &self.snapshot else {
            return matches!(
                item.action,
                Action::ToggleSmartPruneDefault
                    | Action::Edit(_)
                    | Action::Account
                    | Action::ApiKey
                    | Action::OpenFile
            )
            .then(|| "Effective settings are unavailable.".to_string());
        };
        if matches!(item.action, Action::Account | Action::ApiKey) {
            let requirements =
                serde_json::to_value(&snapshot.requirements.requirements).unwrap_or_default();
            let method = if matches!(item.action, Action::Account) {
                "chatgpt"
            } else {
                "api"
            };
            if requirements["allowedLoginMethods"]
                .as_array()
                .is_some_and(|allowed| !allowed.iter().any(|value| value.as_str() == Some(method)))
            {
                return Some("Managed policy does not allow this sign-in method.".to_string());
            }
        }
        if item
            .key
            .is_some_and(|key| key.starts_with("mcp_servers.whispertype."))
        {
            let config = serde_json::to_value(&snapshot.config.config).unwrap_or_default();
            if config["mcp_servers"]["whispertype"].is_null() {
                return Some(
                    "Add the whispertype server in MCP setup before configuring dictation."
                        .to_string(),
                );
            }
        }
        if let Some(key) = item.key {
            let key = if key == "sandbox_mode"
                && fields::permission_profiles(&effective_values(snapshot))
            {
                "default_permissions"
            } else {
                key
            };
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
            if key.starts_with("features.")
                && snapshot
                    .requirements
                    .requirements
                    .as_ref()
                    .and_then(|requirements| requirements.feature_requirements.as_ref())
                    .is_some_and(|features| {
                        features.contains_key(key.trim_start_matches("features."))
                    })
            {
                return Some("Managed policy controls this feature.".to_string());
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
        if item.scope != "this chat"
            && matches!(
                item.action,
                Action::ToggleSmartPruneDefault | Action::Edit(_)
            )
            && self.user_version().is_none()
        {
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
            Action::ProviderKeys => {
                self.complete = true;
                self.app_event_tx.send(AppEvent::Elpis(
                    crate::elpis_app_event::ElpisAppEvent::Provider(
                        crate::chatwidget::ElpisProviderEvent::OpenProviders,
                    ),
                ));
            }
            Action::Shortcut(command) => {
                self.complete = true;
                self.app_event_tx
                    .send(AppEvent::ConfigPanelShortcut(command));
            }
            Action::VoiceSettings => {
                self.complete = true;
                self.app_event_tx.send(AppEvent::OpenRealtimeSettings);
            }
            Action::Edit(kind) => {
                let mut editor = TextArea::new();
                if !matches!(
                    kind,
                    EditorKind::Feature | EditorKind::Mcp | EditorKind::ProviderSetup
                ) {
                    let value = self.value(item);
                    let value = value.as_str();
                    if value != "default" && !value.ends_with(" configured") {
                        let text = if matches!(kind, EditorKind::Markers) {
                            self.snapshot
                                .as_ref()
                                .and_then(|snapshot| {
                                    serde_json::to_value(&snapshot.config.config).ok()
                                })
                                .and_then(|config| {
                                    config["project_root_markers"].as_array().map(|names| {
                                        names
                                            .iter()
                                            .filter_map(serde_json::Value::as_str)
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    })
                                })
                                .unwrap_or_default()
                        } else {
                            value.to_string()
                        };
                        editor.set_text_clearing_elements(&text);
                        editor.set_cursor(text.len());
                    }
                }
                self.editor = Some(editor);
                self.status = "Edit value · Ctrl+U clear · Ctrl+S save · Esc cancel".to_string();
            }
            Action::ApiKey => {
                self.editor = Some(TextArea::new());
                self.status = "Paste your OpenAI API key · Ctrl+S save · Esc cancel".to_string();
            }
            Action::Account => self.start_account_login(LoginAccountParams::ChatgptDeviceCode),
            Action::OpenFile => {
                let path = self.value(item);
                if path == "unavailable" {
                    self.status = "Writable config file is unavailable.".to_string();
                    return;
                }
                self.complete = true;
                self.app_event_tx
                    .send(AppEvent::OpenConfigFile(std::path::PathBuf::from(path)));
            }
            Action::ToggleSmartPruneDefault => {
                if self.write_rx.is_some() {
                    return;
                }
                let next = self.value(item) != "on";
                let edit = config_update::replace_config_value(
                    "features.automatic_context_pruning",
                    serde_json::json!(next),
                );
                self.persist_edits(vec![edit]);
            }
        }
    }

    fn start_account_login(&mut self, params: LoginAccountParams) {
        if self.account_rx.is_some() || self.login_id.is_some() {
            return;
        }
        let handle = self.handle.clone();
        let (tx, rx) = oneshot::channel();
        self.account_rx = Some(rx);
        self.status = "Starting account setup…".to_string();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(60),
                handle.request_typed(ClientRequest::LoginAccount {
                    request_id: RequestId::String(Uuid::new_v4().to_string()),
                    params,
                }),
            )
            .await
            .map_err(|_| "Account setup timed out.".to_string())?
            .map_err(|_| {
                "Account setup was refused. Check the allowed login methods in Config layers."
                    .to_string()
            });
            // A closed panel must not leave an unowned sign-in attempt running.
            if let Err(Ok(
                LoginAccountResponse::ChatgptDeviceCode { login_id, .. }
                | LoginAccountResponse::Chatgpt { login_id, .. },
            )) = tx.send(result)
            {
                cancel_login(handle, login_id).await;
            }
            Ok::<(), String>(())
        });
    }

    fn save_editor(&mut self) {
        if self.write_rx.is_some() || self.account_rx.is_some() {
            return;
        }
        let Some(item) = self.selected_item() else {
            return;
        };
        let Some(editor) = &self.editor else {
            return;
        };
        let text = editor.text().to_string();
        if matches!(item.action, Action::ApiKey) {
            if text.trim().is_empty() || text.len() > 8192 || text.chars().any(char::is_whitespace)
            {
                self.status =
                    "Enter an API key without whitespace (at most 8192 bytes).".to_string();
                return;
            }
            self.start_account_login(LoginAccountParams::ApiKey { api_key: text });
            // Do not retain a submitted secret in the form or its undo buffer.
            self.editor = None;
            return;
        }
        let Action::Edit(kind) = item.action else {
            return;
        };
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let config = effective_values(snapshot);
        let requirements =
            serde_json::to_value(&snapshot.requirements.requirements).unwrap_or_default();
        let edits = match fields::edits(
            kind,
            item.key.unwrap_or_default(),
            &text,
            &config,
            &requirements,
        ) {
            Ok(edits) => edits,
            Err(reason) => {
                self.status = reason;
                return;
            }
        };
        if item.scope == "this chat" {
            if item.key == Some("model_reasoning_effort") && text.trim().is_empty() {
                self.status = "Choose an explicit effort for this chat.".to_string();
                return;
            }
            let event = if item.key == Some("model") {
                AppEvent::UpdateModel(text.trim().to_string())
            } else {
                let effort = if text.trim().is_empty() {
                    None
                } else {
                    match serde_json::from_value(serde_json::json!(text.trim())) {
                        Ok(effort) => Some(effort),
                        Err(_) => {
                            self.status = "Choose a supported reasoning effort.".to_string();
                            return;
                        }
                    }
                };
                AppEvent::UpdateReasoningEffort(effort)
            };
            self.complete = true;
            self.app_event_tx.send(event);
            return;
        }
        self.persist_edits(edits);
    }

    fn persist_edits(&mut self, edits: Vec<codex_app_server_protocol::ConfigEdit>) {
        let Some(version) = self.user_version() else {
            self.status = "Writable user config layer is unavailable.".to_string();
            return;
        };
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
                        edits,
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
}

async fn cancel_login(handle: AppServerRequestHandle, login_id: String) {
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        handle.request_typed::<codex_app_server_protocol::CancelLoginAccountResponse>(
            ClientRequest::CancelLoginAccount {
                request_id: RequestId::String(Uuid::new_v4().to_string()),
                params: codex_app_server_protocol::CancelLoginAccountParams { login_id },
            },
        ),
    )
    .await;
}

impl Drop for ConfigPanelView {
    fn drop(&mut self) {
        if let Some(login_id) = self.login_id.take() {
            let handle = self.handle.clone();
            tokio::spawn(cancel_login(handle, login_id));
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
    fn handle_mouse_event(&mut self, event: MouseEvent) -> bool {
        if self.editor.is_some() {
            return false;
        }
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                let hit = self
                    .list_hits
                    .borrow()
                    .iter()
                    .find(|(rect, _)| rect.contains((event.column, event.row).into()))
                    .map(|(_, index)| *index);
                if let Some(index) = hit {
                    if self.selected == index {
                        self.activate();
                    } else {
                        self.selected = index;
                        self.detail_scroll = 0;
                    }
                    return true;
                }
            }
            MouseEventKind::ScrollDown | MouseEventKind::ScrollUp => {
                let down = matches!(event.kind, MouseEventKind::ScrollDown);
                if self.detail_focus {
                    self.detail_scroll = if down {
                        self.detail_scroll.saturating_add(1)
                    } else {
                        self.detail_scroll.saturating_sub(1)
                    };
                } else {
                    self.selected = if down {
                        (self.selected + 1).min(self.filtered().len().saturating_sub(1))
                    } else {
                        self.selected.saturating_sub(1)
                    };
                }
                return true;
            }
            _ => {}
        }
        false
    }
    fn handle_key_event(&mut self, key: KeyEvent) {
        if self.editor.is_some() {
            match key {
                KeyEvent {
                    code: KeyCode::Esc, ..
                } => {
                    if self.write_rx.is_some() {
                        self.status =
                            "Save in progress; wait for the effective value to be re-read."
                                .to_string();
                        return;
                    }
                    self.editor = None;
                    self.status = "Edit cancelled; saved default unchanged.".to_string();
                }
                KeyEvent {
                    code: KeyCode::Char('s'),
                    modifiers: KeyModifiers::CONTROL,
                    ..
                }
                | KeyEvent {
                    code: KeyCode::Enter,
                    modifiers: KeyModifiers::NONE,
                    ..
                } => self.save_editor(),
                KeyEvent {
                    code: KeyCode::Char('u'),
                    modifiers: KeyModifiers::CONTROL,
                    ..
                } => {
                    if let Some(editor) = &mut self.editor {
                        editor.set_text_clearing_elements("");
                    }
                }
                _ => {
                    if self.write_rx.is_none()
                        && let Some(editor) = &mut self.editor
                    {
                        editor.input(key);
                    }
                }
            }
            return;
        }
        if self.detail_focus {
            match key.code {
                KeyCode::Up => {
                    self.detail_scroll = self.detail_scroll.saturating_sub(1);
                    return;
                }
                KeyCode::Down => {
                    self.detail_scroll = self.detail_scroll.saturating_add(1);
                    return;
                }
                KeyCode::PageUp => {
                    self.detail_scroll = self.detail_scroll.saturating_sub(5);
                    return;
                }
                KeyCode::PageDown => {
                    self.detail_scroll = self.detail_scroll.saturating_add(5);
                    return;
                }
                _ => {}
            }
        }
        self.detail_scroll = 0;
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
                code: KeyCode::Home,
                ..
            } => self.selected = 0,
            KeyEvent {
                code: KeyCode::End, ..
            } => self.selected = self.filtered().len().saturating_sub(1),
            KeyEvent {
                code: KeyCode::PageDown,
                ..
            } => self.selected = (self.selected + 8).min(self.filtered().len().saturating_sub(1)),
            KeyEvent {
                code: KeyCode::PageUp,
                ..
            } => self.selected = self.selected.saturating_sub(8),
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
                code: KeyCode::Char('u'),
                modifiers: KeyModifiers::CONTROL,
                ..
            } => {
                self.query.clear();
                self.selected = 0;
            }
            KeyEvent {
                code: KeyCode::Char(ch),
                modifiers: KeyModifiers::NONE | KeyModifiers::SHIFT,
                ..
            } => {
                if self.query.chars().count() < 80 {
                    self.query.push(ch);
                }
                self.selected = 0;
            }
            _ => {}
        }
    }

    fn on_ctrl_c(&mut self) -> CancellationEvent {
        if self.write_rx.is_some() {
            self.status =
                "Save in progress; wait for the effective value to be re-read.".to_string();
            return CancellationEvent::Handled;
        }
        if self.editor.take().is_some() {
            self.status = "Edit cancelled; saved default unchanged.".to_string();
            return CancellationEvent::Handled;
        }
        self.complete = true;
        CancellationEvent::Handled
    }

    fn prefer_esc_to_handle_key_event(&self) -> bool {
        self.editor.is_some()
    }

    fn handle_paste(&mut self, pasted: String) -> bool {
        if self.write_rx.is_none()
            && let Some(editor) = &mut self.editor
        {
            if editor.text().len().saturating_add(pasted.len()) <= 128000 {
                editor.insert_str_at(editor.cursor(), &pasted);
            } else {
                self.status = "Pasted text is too long; no change was saved.".to_string();
            }
            return true;
        }
        if self.editor.is_none() {
            self.query.extend(
                pasted
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(80_usize.saturating_sub(self.query.chars().count())),
            );
            self.selected = 0;
            self.detail_scroll = 0;
            return true;
        }
        false
    }

    fn is_complete(&self) -> bool {
        self.complete
    }

    fn pre_draw_tick(&mut self, _now: Instant) -> bool {
        let mut changed = false;
        if let Some(rx) = self.account_rx.as_mut() {
            match rx.try_recv() {
                Ok(result) => {
                    self.account_rx = None;
                    match result {
                        Ok(LoginAccountResponse::ApiKey {}) => { self.status = "Account saved in private credential storage.".to_string(); self.refresh(); }
                        Ok(LoginAccountResponse::ChatgptDeviceCode { login_id, verification_url, user_code }) => {
                            self.login_id = Some(login_id);
                            self.login_message = Some(format!("Open {verification_url}\nCode: {user_code}\nComplete sign-in in your browser, then reopen /config. Esc cancels this sign-in attempt."));
                            self.status = "Waiting for browser sign-in. Esc cancels.".to_string();
                        }
                        Ok(_) => self.status = "Account setup returned an unsupported response. Reopen to check your account.".to_string(),
                        Err(reason) => self.status = reason,
                    }
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    self.account_rx = None;
                    self.status =
                        "Account setup interrupted. Reopen to check the account.".to_string();
                    changed = true;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
        }
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
                            self.editor = None;
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
        (self.read_rx.is_some() || self.write_rx.is_some() || self.account_rx.is_some())
            .then(|| Duration::from_millis(100))
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
    async fn fast_typing_and_paste_filter_the_catalog() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = panel(None).await?;
        assert!(view.handle_paste("theme".to_string()));
        assert_eq!(view.selected_item().map(|item| item.name), Some("Theme"));
        Ok(())
    }

    #[tokio::test]
    async fn first_middle_last_and_empty_results_stay_reachable_at_narrow_width()
    -> color_eyre::Result<()> {
        let (_home, _server, mut view) = panel(None).await?;
        for position in [0, ITEMS.len() / 2, ITEMS.len() - 1] {
            view.selected = position;
            let name = view.selected_item().unwrap().name;
            let mut buffer = Buffer::empty(Rect::new(0, 0, 44, 22));
            view.render(buffer.area, &mut buffer);
            let screen = buffer
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(
                screen.contains(&format!("› {name}")),
                "selected item must remain visible: {name}"
            );
        }
        view.query = "nothing-matches-this".to_string();
        view.selected = 0;
        view.activate();
        assert!(view.write_rx.is_none());
        assert!(!view.complete);
        assert!(view.filtered().is_empty());
        Ok(())
    }

    async fn loaded_panel()
    -> color_eyre::Result<(tempfile::TempDir, AppServerClient, ConfigPanelView)> {
        let (home, server, mut view) = panel(None).await?;
        view.snapshot = Some(
            read_snapshot(server.request_handle(), home.path().display().to_string())
                .await
                .map_err(|error| color_eyre::eyre::eyre!(error))?,
        );
        view.read_rx = None;
        Ok((home, server, view))
    }

    fn select(view: &mut ConfigPanelView, name: &str) {
        view.query.clear();
        view.selected = ITEMS
            .iter()
            .position(|item| item.name == name)
            .expect("catalog item");
    }

    #[tokio::test]
    async fn default_editors_save_and_re_read_through_the_real_engine() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = loaded_panel().await?;
        for (name, input, key, expected) in [
            (
                "Default model",
                "a32-default-model",
                "model",
                serde_json::json!("a32-default-model"),
            ),
            (
                "Default reasoning effort",
                "high",
                "model_reasoning_effort",
                serde_json::json!("high"),
            ),
            (
                "Web search",
                "cached",
                "web_search",
                serde_json::json!("cached"),
            ),
            (
                "Output detail",
                "low",
                "model_verbosity",
                serde_json::json!("low"),
            ),
            (
                "Reasoning summary",
                "concise",
                "model_reasoning_summary",
                serde_json::json!("concise"),
            ),
            ("Speed", "fast", "service_tier", serde_json::json!("fast")),
            (
                "Custom instructions",
                "Keep Persian: فارسی",
                "developer_instructions",
                serde_json::json!("Keep Persian: فارسی"),
            ),
            (
                "Use memories",
                "off",
                "memories.use_memories",
                serde_json::json!(false),
            ),
            (
                "Generate memories",
                "off",
                "memories.generate_memories",
                serde_json::json!(false),
            ),
            (
                "Skip external context",
                "on",
                "memories.disable_on_external_context",
                serde_json::json!(true),
            ),
            (
                "Project root markers",
                ".git, .hg",
                "project_root_markers",
                serde_json::json!([".git", ".hg"]),
            ),
            (
                "Worktree root",
                "/tmp/a32-worktrees",
                "desktop.git-worktree-root",
                serde_json::json!("/tmp/a32-worktrees"),
            ),
            (
                "Background model",
                "a32-maintenance",
                "background_model",
                serde_json::json!("a32-maintenance"),
            ),
            (
                "Background provider",
                "openai",
                "background_provider",
                serde_json::json!("openai"),
            ),
            (
                "Memory default",
                "off",
                "features.memories",
                serde_json::json!(false),
            ),
            (
                "Feature default",
                "shell_tool off",
                "features.shell_tool",
                serde_json::json!(false),
            ),
            (
                "MCP setup",
                r#"{"name":"a32docs","url":"https://example.com/mcp"}"#,
                "mcp_servers.a32docs.url",
                serde_json::json!("https://example.com/mcp"),
            ),
            (
                "MCP setup",
                r#"{"name":"a32docs","remove":true}"#,
                "mcp_servers.a32docs",
                serde_json::Value::Null,
            ),
            (
                "Provider setup",
                r#"{"id":"a32custom","name":"A32 custom","base_url":"http://localhost:1234/v1","wire_api":"responses"}"#,
                "model_providers.a32custom.name",
                serde_json::json!("A32 custom"),
            ),
        ] {
            select(&mut view, name);
            view.activate();
            view.editor
                .as_mut()
                .expect("editor opens")
                .set_text_clearing_elements(input);
            view.save_editor();
            let snapshot = tokio::time::timeout(
                Duration::from_secs(15),
                view.write_rx.take().expect("write requested"),
            )
            .await??
            .map_err(|error| color_eyre::eyre::eyre!(error))?;
            let config = serde_json::to_value(&snapshot.config.config)?;
            assert_eq!(fields::value_at(&config, key), &expected, "{name}");
            view.snapshot = Some(snapshot);
            view.editor = None;
        }
        Ok(())
    }

    #[tokio::test]
    async fn invalid_input_keeps_the_editor_and_sends_no_write() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = loaded_panel().await?;
        select(&mut view, "Web search");
        view.activate();
        view.editor
            .as_mut()
            .unwrap()
            .set_text_clearing_elements("banana");
        view.save_editor();
        assert!(view.write_rx.is_none());
        assert!(view.status.contains("Choose one of"));
        assert_eq!(view.editor.as_ref().unwrap().text(), "banana");
        view.handle_key_event(KeyCode::Esc.into());
        assert!(view.editor.is_none());
        assert!(!view.complete);
        Ok(())
    }

    #[tokio::test]
    async fn stale_client_cannot_overwrite_another_clients_default() -> color_eyre::Result<()> {
        let (home, server, mut view) = loaded_panel().await?;
        config_update::write_config_batch_with_version(
            server.request_handle(),
            vec![config_update::replace_config_value(
                "model_verbosity",
                serde_json::json!("high"),
            )],
            view.user_version(),
        )
        .await?;
        select(&mut view, "Output detail");
        view.activate();
        view.editor
            .as_mut()
            .unwrap()
            .set_text_clearing_elements("low");
        view.save_editor();
        let result =
            tokio::time::timeout(Duration::from_secs(10), view.write_rx.take().unwrap()).await??;
        assert!(result.is_err());
        let effective = read_snapshot(server.request_handle(), home.path().display().to_string())
            .await
            .map_err(|error| color_eyre::eyre::eyre!(error))?;
        assert_eq!(
            serde_json::to_value(effective.config.config)?["model_verbosity"],
            "high"
        );
        Ok(())
    }

    #[tokio::test]
    async fn current_chat_model_does_not_request_a_default_write() -> color_eyre::Result<()> {
        let (_home, _server, mut view) = loaded_panel().await?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        view.app_event_tx = AppEventSender::new(tx);
        select(&mut view, "Model");
        view.activate();
        view.editor
            .as_mut()
            .unwrap()
            .set_text_clearing_elements("a32-chat-only");
        view.save_editor();
        assert!(view.write_rx.is_none());
        assert!(
            matches!(rx.try_recv(), Ok(AppEvent::UpdateModel(model)) if model == "a32-chat-only")
        );
        Ok(())
    }

    #[tokio::test]
    async fn account_is_reachable_and_api_key_is_masked_at_narrow_width() -> color_eyre::Result<()>
    {
        let (_home, _server, mut view) = loaded_panel().await?;
        let account = *ITEMS.iter().find(|item| item.name == "Account").unwrap();
        assert!(matches!(account.action, Action::Account));
        assert!(view.disabled_reason(account).is_none());
        select(&mut view, "OpenAI API key");
        view.activate();
        view.editor
            .as_mut()
            .unwrap()
            .set_text_clearing_elements("sk-DO-NOT-RENDER");
        let mut buffer = Buffer::empty(Rect::new(0, 0, 44, 22));
        view.render(buffer.area, &mut buffer);
        let screen = buffer
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(!screen.contains("sk-DO-NOT-RENDER"));
        assert!(screen.contains('•'));
        view.on_ctrl_c();
        assert!(view.editor.is_none());
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
            account_connected: None,
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
        // Narrow terminals show the focused pane in full width. Tab exposes the
        // other pane; detail text scrolls instead of crowding out the conversation.
        let [list, detail] = if area.width < 72 {
            if self.detail_focus || self.editor.is_some() {
                [Rect::default(), body]
            } else {
                [body, Rect::default()]
            }
        } else {
            Layout::horizontal([Constraint::Percentage(47), Constraint::Percentage(53)]).areas(body)
        };
        let visible = self.filtered();
        let selected = self.selected_item();
        let mut rows = Vec::new();
        let mut previous_section = None;
        let max_rows = list.height.saturating_sub(2) as usize;
        let mut selected_row = 0;
        for (position, index) in visible.iter().enumerate() {
            let item = ITEMS[*index];
            if previous_section != Some(item.section) {
                rows.push((Line::from(SECTIONS[item.section].bold()), None));
                previous_section = Some(item.section);
            }
            if position == self.selected {
                selected_row = rows.len();
            }
            let prefix = if position == self.selected {
                "› "
            } else {
                "  "
            };
            rows.push((Line::from(format!("{prefix}{}", item.name)), Some(position)));
        }
        let start = selected_row
            .saturating_sub(max_rows.saturating_sub(3))
            .min(rows.len().saturating_sub(max_rows));
        let mut lines = Vec::new();
        let mut hits = self.list_hits.borrow_mut();
        hits.clear();
        for (row, (line, position)) in rows.into_iter().skip(start).take(max_rows).enumerate() {
            if let Some(position) = position {
                hits.push((
                    Rect::new(
                        list.x.saturating_add(1),
                        list.y.saturating_add(1 + row as u16),
                        list.width.saturating_sub(2),
                        1,
                    ),
                    position,
                ));
            }
            lines.push(line);
        }
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
            let mut lines = vec![
                Line::from(item.name.bold()),
                Line::from(""),
                Line::from(format!("Value: {}", self.value(item).replace('\n', " ↵ "))),
                Line::from(format!("Scope: {}", item.scope)),
                Line::from(format!("Source: {}", self.source(item))),
                Line::from(""),
                Line::from(reason.unwrap_or_else(|| item.hint.to_string())),
            ];
            if matches!(item.action, Action::Account)
                && let Some(message) = &self.login_message
            {
                lines.extend(message.lines().map(|line| Line::from(line.to_string())));
            }
            lines
        } else {
            vec![Line::from("No matching setting")]
        };
        let detail_block = Block::default().borders(Borders::ALL).title(
            if self.detail_focus || self.editor.is_some() {
                "Detail ●"
            } else {
                "Detail"
            },
        );
        if let Some(editor) = &self.editor {
            let inner = detail_block.inner(detail);
            detail_block.render(detail, buf);
            let [help, input] =
                Layout::vertical([Constraint::Percentage(45), Constraint::Percentage(55)])
                    .areas(inner);
            let help_lines = selected
                .map(|item| {
                    vec![
                        Line::from(item.name.bold()),
                        Line::from(self.status.clone()),
                        Line::from(item.hint),
                    ]
                })
                .unwrap_or_default();
            Paragraph::new(help_lines)
                .wrap(Wrap { trim: false })
                .scroll((self.detail_scroll, 0))
                .render(help, buf);
            self.editor_area.set(input);
            let mut state = self.editor_state.borrow_mut();
            if selected.is_some_and(|item| matches!(item.action, Action::ApiKey)) {
                editor.render_ref_masked(input, buf, &mut state, '•');
            } else {
                StatefulWidgetRef::render_ref(&editor, input, buf, &mut state);
            }
        } else {
            Paragraph::new(detail_lines)
                .wrap(Wrap { trim: false })
                .scroll((self.detail_scroll, 0))
                .block(detail_block)
                .render(detail, buf);
        }
        Paragraph::new(vec![
            Line::from(if self.editor.is_some() && area.width < 60 {
                "Ctrl+S save · Esc cancel"
            } else if self.editor.is_some() {
                "Enter/Ctrl+S save · Shift+Enter line · Esc cancel"
            } else if area.width < 72 {
                "↑↓ move · Tab detail · Enter edit · Esc cancel"
            } else {
                "↑↓ move · Tab switch · Enter edit · Esc cancel"
            }),
            Line::from(self.status.as_str()),
        ])
        .render(footer, buf);
    }

    fn desired_height(&self, _width: u16) -> u16 {
        22
    }

    fn cursor_pos(&self, _area: Rect) -> Option<(u16, u16)> {
        self.editor
            .as_ref()?
            .cursor_pos_with_state(self.editor_area.get(), *self.editor_state.borrow())
    }
}

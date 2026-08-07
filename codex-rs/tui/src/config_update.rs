//! App-server-backed config update helpers for the TUI.
//!
//! This module centralizes the small typed update helpers the TUI uses
//! when a config mutation must be owned by the app server rather than written
//! to the local `config.toml` directly.

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ConfigBatchWriteParams;
use codex_app_server_protocol::ConfigEdit;
use codex_app_server_protocol::ConfigReadParams;
use codex_app_server_protocol::ConfigReadResponse;
use codex_app_server_protocol::ConfigWriteResponse;
use codex_app_server_protocol::MergeStrategy;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::SkillsConfigWriteParams;
use codex_app_server_protocol::SkillsConfigWriteResponse;
use codex_config::loader::project_trust_key;
use codex_features::FEATURES;
use codex_protocol::config_types::SERVICE_TIER_DEFAULT_REQUEST_VALUE;
use codex_protocol::config_types::TrustLevel;
use codex_utils_absolute_path::AbsolutePathBuf;
use color_eyre::eyre::Result;
use color_eyre::eyre::WrapErr;
use serde_json::Value as JsonValue;
use std::fmt::Display;
use std::path::Path;
use uuid::Uuid;

pub(crate) fn replace_config_value(key_path: impl Into<String>, value: JsonValue) -> ConfigEdit {
    ConfigEdit {
        key_path: key_path.into(),
        value,
        merge_strategy: MergeStrategy::Replace,
    }
}

pub(crate) fn clear_config_value(key_path: impl Into<String>) -> ConfigEdit {
    replace_config_value(key_path, JsonValue::Null)
}

pub(crate) fn app_scoped_key_path(app_id: &str, key_path: &str) -> String {
    let app_id = serde_json::Value::String(app_id.to_string()).to_string();
    format!("apps.{app_id}.{key_path}")
}

pub(crate) fn format_config_error(err: &impl Display) -> String {
    format!("{err:#}")
}

fn trusted_project_edit(project_path: &Path) -> ConfigEdit {
    let project_key = project_trust_key(project_path)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    replace_config_value(
        format!("projects.\"{project_key}\".trust_level"),
        serde_json::json!(TrustLevel::Trusted.to_string()),
    )
}

pub(crate) fn build_model_selection_edits(
    model: &str,
    effort: Option<impl ToString>,
) -> Vec<ConfigEdit> {
    let effort_edit = effort.map_or_else(
        || clear_config_value("model_reasoning_effort"),
        |effort| {
            replace_config_value(
                "model_reasoning_effort",
                serde_json::json!(effort.to_string()),
            )
        },
    );
    vec![
        replace_config_value("model", serde_json::json!(model)),
        effort_edit,
        replace_config_value("features.auto_model_routing", serde_json::json!(false)),
    ]
}

/// Config edits for pinning a model to a specific provider.
///
/// `context_window` is the window the provider itself reports for this model, when it can be
/// discovered. Locally served models are absent from the bundled catalog, so without it every
/// context measurement uses generic fallback metadata and describes the wrong model. Passing
/// `None` clears any window a previous selection pinned rather than leaving it to apply to a
/// model it was never measured from.
pub(crate) fn build_provider_model_selection_edits(
    model: &str,
    provider_id: &str,
    context_window: Option<i64>,
) -> Vec<ConfigEdit> {
    vec![
        replace_config_value("model", serde_json::json!(model)),
        replace_config_value("model_provider", serde_json::json!(provider_id)),
        clear_config_value("model_reasoning_effort"),
        replace_config_value("features.auto_model_routing", serde_json::json!(false)),
        context_window.map_or_else(
            || clear_config_value("model_context_window"),
            |context_window| {
                replace_config_value("model_context_window", serde_json::json!(context_window))
            },
        ),
    ]
}

/// Providers the `/model` picker pins on the user's behalf. Selecting a model from a
/// different group has to release the pin, or the next launch starts on the old
/// endpoint with a model it does not serve. Providers outside this list were set up
/// by the user, so they are left alone.
const PICKER_MANAGED_PROVIDERS: [&str; 3] = [
    codex_model_provider_info::OLLAMA_OSS_PROVIDER_ID,
    codex_model_provider_info::LMSTUDIO_OSS_PROVIDER_ID,
    codex_model_provider_info::OPENROUTER_PROVIDER_ID,
];

/// Config edit that keeps `model_provider` consistent with a newly selected `model`.
///
/// Returns `None` when the selection carries no provider signal and the active provider
/// is one the user configured themselves.
pub(crate) fn build_model_provider_edits(
    model: &str,
    active_provider_id: &str,
) -> Vec<ConfigEdit> {
    if is_openrouter_model_slug(model) {
        return vec![
            replace_config_value(
                "model_provider",
                serde_json::json!(codex_model_provider_info::OPENROUTER_PROVIDER_ID),
            ),
            // A window measured from a local model says nothing about an OpenRouter one.
            clear_config_value("model_context_window"),
        ];
    }
    if PICKER_MANAGED_PROVIDERS.contains(&active_provider_id) {
        return vec![
            clear_config_value("model_provider"),
            clear_config_value("model_context_window"),
        ];
    }
    Vec::new()
}

/// Whether a model slug is only reachable through OpenRouter. Mirrors the provider
/// inference the core applies to a bare model slug.
pub(crate) fn is_openrouter_model_slug(model: &str) -> bool {
    model.contains('/')
        || model.contains(":free")
        || !codex_model_provider_info::openrouter_free_fallback_candidates(model).is_empty()
}

pub(crate) fn build_auto_model_routing_edits() -> Vec<ConfigEdit> {
    vec![
        replace_config_value("model", serde_json::json!("gpt-5.6-terra")),
        replace_config_value("model_reasoning_effort", serde_json::json!("medium")),
        replace_config_value("features.auto_model_routing", serde_json::json!(true)),
    ]
}

pub(crate) fn build_service_tier_selection_edits(service_tier: Option<&str>) -> Vec<ConfigEdit> {
    let service_tier_edit = service_tier.map_or_else(
        || clear_config_value("service_tier"),
        |service_tier| {
            let config_value = if service_tier == SERVICE_TIER_DEFAULT_REQUEST_VALUE {
                SERVICE_TIER_DEFAULT_REQUEST_VALUE
            } else {
                match codex_protocol::config_types::ServiceTier::from_request_value(service_tier) {
                    Some(codex_protocol::config_types::ServiceTier::Fast) => "fast",
                    Some(codex_protocol::config_types::ServiceTier::Flex) => "flex",
                    None => service_tier,
                }
            };
            replace_config_value("service_tier", serde_json::json!(config_value))
        },
    );
    vec![service_tier_edit]
}

#[cfg(target_os = "windows")]
pub(crate) fn build_windows_sandbox_mode_edits(elevated_enabled: bool) -> Vec<ConfigEdit> {
    let feature_key_path = |feature: &str| format!("features.{feature}");
    vec![
        replace_config_value(
            "windows.sandbox",
            serde_json::json!(if elevated_enabled {
                "elevated"
            } else {
                "unelevated"
            }),
        ),
        clear_config_value(feature_key_path("experimental_windows_sandbox")),
        clear_config_value(feature_key_path("elevated_windows_sandbox")),
        clear_config_value(feature_key_path("enable_experimental_windows_sandbox")),
    ]
}

pub(crate) fn build_feature_enabled_edit(feature_key: &str, enabled: bool) -> ConfigEdit {
    let key_path = format!("features.{feature_key}");
    let is_default_false_feature = FEATURES
        .iter()
        .find(|spec| spec.key == feature_key)
        .is_some_and(|spec| !spec.default_enabled);
    if enabled || !is_default_false_feature {
        replace_config_value(key_path, serde_json::json!(enabled))
    } else {
        clear_config_value(key_path)
    }
}

pub(crate) fn build_oss_provider_edit(provider: &str) -> ConfigEdit {
    replace_config_value("oss_provider", serde_json::json!(provider))
}

pub(crate) async fn write_config_batch(
    request_handle: AppServerRequestHandle,
    edits: Vec<ConfigEdit>,
) -> Result<ConfigWriteResponse> {
    let request_id = RequestId::String(format!("tui-config-write-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::ConfigBatchWrite {
            request_id,
            params: ConfigBatchWriteParams {
                edits,
                file_path: None,
                expected_version: None,
                reload_user_config: true,
            },
        })
        .await
        .wrap_err("config/batchWrite failed in TUI")
}

pub(crate) async fn write_trusted_project(
    request_handle: AppServerRequestHandle,
    project_path: &Path,
) -> Result<ConfigWriteResponse> {
    write_config_batch(request_handle, vec![trusted_project_edit(project_path)]).await
}

pub(crate) async fn read_effective_config(
    request_handle: AppServerRequestHandle,
    cwd: String,
) -> Result<ConfigReadResponse> {
    let request_id = RequestId::String(format!("tui-config-read-{}", Uuid::new_v4()));
    request_handle
        .request_typed(ClientRequest::ConfigRead {
            request_id,
            params: ConfigReadParams {
                include_layers: false,
                cwd: Some(cwd),
            },
        })
        .await
        .wrap_err("config/read failed in TUI")
}

pub(crate) async fn write_skill_enabled(
    request_handle: AppServerRequestHandle,
    path: AbsolutePathBuf,
    enabled: bool,
) -> Result<()> {
    let request_id = RequestId::String(format!("tui-skill-config-write-{}", Uuid::new_v4()));
    let _: SkillsConfigWriteResponse = request_handle
        .request_typed(ClientRequest::SkillsConfigWrite {
            request_id,
            params: SkillsConfigWriteParams {
                path: Some(path),
                name: None,
                enabled,
            },
        })
        .await
        .wrap_err("skills/config/write failed in TUI")?;
    Ok(())
}

#[cfg(test)]
#[path = "config_update_tests.rs"]
mod tests;

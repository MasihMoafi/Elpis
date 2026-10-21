//! Guided config edits. The app server validates the resulting TOML again before writing.
use codex_app_server_protocol::ConfigEdit;
use serde_json::Value;

use crate::config_update::replace_config_value;

#[derive(Clone, Copy)]
pub(super) enum EditorKind {
    Model,
    Provider,
    Choice(&'static [&'static str]),
    Instructions,
    Switch,
    Markers,
    AbsolutePath,
    Feature,
    Mcp,
    ProviderSetup,
}

pub(super) fn value_at<'a>(config: &'a Value, key: &str) -> &'a Value {
    key.split('.').fold(config, |node, part| &node[part])
}

pub(super) fn permission_profiles(config: &Value) -> bool {
    !config["default_permissions"].is_null()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn public_url(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|text| url::Url::parse(text).ok())
        .is_some_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
}

pub(super) fn edits(
    kind: EditorKind,
    key: &str,
    text: &str,
    config: &Value,
    requirements: &Value,
) -> Result<Vec<ConfigEdit>, String> {
    let raw_text = text;
    let text = text.trim();
    let mut key = key.to_string();
    let value = if text.is_empty() {
        if key == "model" || key == "model_provider" {
            return Err("Choose a default model and a configured provider.".to_string());
        }
        if matches!(
            kind,
            EditorKind::Mcp | EditorKind::ProviderSetup | EditorKind::Feature
        ) {
            return Err("Enter the setting described above; nothing was changed.".to_string());
        }
        Value::Null
    } else {
        match kind {
            EditorKind::Choice(choices) => {
                if !choices.contains(&text) {
                    return Err(format!("Choose one of: {}.", choices.join(", ")));
                }
                Value::String(text.to_string())
            }
            EditorKind::Switch => match text {
                "on" | "true" => Value::Bool(true),
                "off" | "false" => Value::Bool(false),
                _ => return Err("Choose on or off.".to_string()),
            },
            EditorKind::Model => {
                if text.len() > 200 || text.chars().any(char::is_control) {
                    return Err(
                        "Model IDs must be at most 200 bytes without control characters."
                            .to_string(),
                    );
                }
                Value::String(text.to_string())
            }
            EditorKind::Provider => {
                if !codex_model_provider_info::built_in_model_providers(None).contains_key(text)
                    && config["model_providers"].get(text).is_none()
                    && requirements["modelProviders"].get(text).is_none()
                {
                    return Err(
                        "Choose a configured provider ID; add it in Provider setup first."
                            .to_string(),
                    );
                }
                Value::String(text.to_string())
            }
            EditorKind::Instructions => {
                if raw_text.encode_utf16().count() > 32000 || raw_text.contains('\0') {
                    return Err(
                        "Instructions must be at most 32000 characters without NUL.".to_string()
                    );
                }
                Value::String(raw_text.to_string())
            }
            EditorKind::Markers => {
                let names = text.split(',').map(str::trim).collect::<Vec<_>>();
                if names.len() > 16
                    || names.iter().any(|name| {
                        name.is_empty()
                            || name.len() > 100
                            || matches!(*name, "." | "..")
                            || name.contains(['/', '\\', '\0', '\n', '\r'])
                    })
                {
                    return Err(
                        "Give one to sixteen file or folder names without slashes.".to_string()
                    );
                }
                serde_json::json!(names)
            }
            EditorKind::AbsolutePath => {
                if !std::path::Path::new(text).is_absolute()
                    || text.len() > 4096
                    || text.contains(['\0', '\n', '\r'])
                {
                    return Err("Give an absolute folder path without line breaks.".to_string());
                }
                Value::String(text.to_string())
            }
            EditorKind::Feature => {
                let parts = text.split_whitespace().collect::<Vec<_>>();
                if parts.len() != 2
                    || !codex_features::FEATURES.iter().any(|spec| {
                        spec.key == parts[0]
                            && !matches!(
                                spec.stage,
                                codex_features::Stage::Deprecated | codex_features::Stage::Removed
                            )
                    })
                {
                    return Err("Give a native feature key followed by on or off.".to_string());
                }
                let enabled = match parts[1] {
                    "on" | "true" => true,
                    "off" | "false" => false,
                    _ => return Err("Choose on or off.".to_string()),
                };
                key = format!("features.{}", parts[0]);
                if requirements["featureRequirements"].get(parts[0]).is_some() {
                    return Err("Managed policy controls this feature.".to_string());
                }
                Value::Bool(enabled)
            }
            EditorKind::Mcp | EditorKind::ProviderSetup => {
                let input: Value = serde_json::from_str(text).map_err(|_| {
                    "Enter a JSON object matching the example. No change was saved.".to_string()
                })?;
                let object = input.as_object().ok_or("Enter a JSON object.")?;
                let provider = matches!(kind, EditorKind::ProviderSetup);
                let id_key = if provider { "id" } else { "name" };
                let id = input[id_key]
                    .as_str()
                    .filter(|id| valid_id(id))
                    .ok_or("Give a name using letters, numbers, underscores or hyphens.")?;
                if provider
                    && codex_model_provider_info::built_in_model_providers(None).contains_key(id)
                {
                    return Err("Built-in providers keep their native setup. Use Provider keys for their credentials.".to_string());
                }
                let allowed = if provider {
                    &[
                        "id",
                        "name",
                        "base_url",
                        "wire_api",
                        "env_key",
                        "requires_openai_auth",
                    ][..]
                } else {
                    &[
                        "name",
                        "url",
                        "command",
                        "args",
                        "env_vars",
                        "bearer_token_env_var",
                        "enabled",
                        "remove",
                    ][..]
                };
                if object.keys().any(|key| !allowed.contains(&key.as_str())) {
                    return Err(
                        "Unsupported field. Keep keys and tokens in environment variables."
                            .to_string(),
                    );
                }
                let table = if provider {
                    "model_providers"
                } else {
                    "mcp_servers"
                };
                if provider && requirements["modelProviders"].get(id).is_some() {
                    return Err("Managed policy controls this provider.".to_string());
                }
                let existing = config[table].get(id);
                if !provider && input["remove"] == true {
                    if object.len() != 2 || existing.is_none() {
                        return Err(
                            "To remove an existing server, give only its name and remove: true."
                                .to_string(),
                        );
                    }
                    return Ok(vec![replace_config_value(
                        format!("mcp_servers.{id}"),
                        Value::Null,
                    )]);
                }
                if provider {
                    if input.get("base_url").is_some() && !public_url(&input["base_url"]) {
                        return Err(
                            "Give an HTTP(S) base URL without credentials, query or fragment."
                                .to_string(),
                        );
                    }
                    if existing.is_none()
                        && (input["name"].as_str().is_none() || !public_url(&input["base_url"]))
                    {
                        return Err("A new provider needs a name and HTTP(S) base_url.".to_string());
                    }
                } else {
                    if input.get("url").is_some() && !public_url(&input["url"]) {
                        return Err(
                            "Give an HTTP(S) MCP URL without credentials, query or fragment."
                                .to_string(),
                        );
                    }
                    if input.get("url").is_some() && input.get("command").is_some() {
                        return Err("Choose a URL or a command for the MCP server.".to_string());
                    }
                    if existing.is_none()
                        && input.get("url").is_none()
                        && input["command"].as_str().is_none()
                    {
                        return Err("A new MCP server needs a URL or command.".to_string());
                    }
                }
                let mut result = Vec::new();
                for (field, value) in object {
                    if field == id_key {
                        continue;
                    }
                    let valid = match field.as_str() {
                        "enabled" | "requires_openai_auth" => value.is_boolean(),
                        "remove" => {
                            return Err(
                                "Set remove: true by itself to remove a server, or omit remove."
                                    .to_string(),
                            );
                        }
                        "args" | "env_vars" => value
                            .as_array()
                            .is_some_and(|items| items.iter().all(Value::is_string)),
                        "env_key" | "bearer_token_env_var" => value.as_str().is_some_and(valid_id),
                        _ => value.as_str().is_some_and(|value| {
                            !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
                        }),
                    };
                    if !valid {
                        return Err("A field has the wrong type or an invalid value.".to_string());
                    }
                    // Write only submitted fields so unrelated settings and private credentials survive.
                    result.push(replace_config_value(
                        format!("{table}.{id}.{field}"),
                        value.clone(),
                    ));
                }
                if result.is_empty() {
                    return Err("Include at least one setting to change.".to_string());
                }
                return Ok(result);
            }
        }
    };
    let restriction = match key.as_str() {
        "model_provider" if !requirements["modelProvider"].is_null() => {
            if requirements["modelProvider"] != value {
                return Err("Managed policy pins the default provider.".to_string());
            }
            None
        }
        "approval_policy" => Some("allowedApprovalPolicies"),
        "sandbox_mode" => Some("allowedSandboxModes"),
        "web_search" => Some("allowedWebSearchModes"),
        _ => None,
    };
    if let Some(allowed) = restriction.and_then(|name| requirements[name].as_array())
        && !value.is_null()
        && !allowed.contains(&value)
    {
        return Err("This choice is restricted by managed settings.".to_string());
    }
    if key == "sandbox_mode" && permission_profiles(config) {
        key = "default_permissions".to_string();
        let value = match value.as_str() {
            Some("read-only") => serde_json::json!(":read-only"),
            Some("workspace-write") => serde_json::json!(":workspace"),
            Some("danger-full-access") => serde_json::json!(":danger-full-access"),
            _ => Value::Null,
        };
        return Ok(vec![replace_config_value(key, value)]);
    }
    Ok(vec![replace_config_value(key, value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_values_are_refused_before_writing() {
        let config = serde_json::json!({});
        for (kind, key, text) in [
            (
                EditorKind::Choice(&["low", "high"]),
                "model_verbosity",
                "banana",
            ),
            (EditorKind::Provider, "model_provider", "unknown"),
            (
                EditorKind::AbsolutePath,
                "desktop.git-worktree-root",
                "relative",
            ),
            (EditorKind::Markers, "project_root_markers", "../private"),
            (
                EditorKind::Mcp,
                "mcp_servers",
                r#"{"name":"docs","url":"https://example.com/?token=secret"}"#,
            ),
        ] {
            assert!(edits(kind, key, text, &config, &config).is_err());
        }
    }

    #[test]
    fn sandbox_edits_the_permission_profile_that_the_engine_reads() {
        let config = serde_json::json!({"default_permissions": ":workspace"});
        let edit = edits(
            EditorKind::Choice(&["read-only"]),
            "sandbox_mode",
            "read-only",
            &config,
            &Value::Null,
        )
        .unwrap();
        assert_eq!(edit[0].key_path, "default_permissions");
        assert_eq!(edit[0].value, ":read-only");
    }

    #[test]
    fn mcp_toggle_preserves_other_fields_and_secrets() {
        let config = serde_json::json!({"mcp_servers":{"docs":{"url":"https://example.com","http_headers":{"Authorization":"SECRET"}}}});
        let edit = edits(
            EditorKind::Mcp,
            "mcp_servers",
            r#"{"name":"docs","enabled":false}"#,
            &config,
            &Value::Null,
        )
        .unwrap();
        assert_eq!(edit.len(), 1);
        assert_eq!(edit[0].key_path, "mcp_servers.docs.enabled");
        assert_eq!(edit[0].value, false);
    }
}

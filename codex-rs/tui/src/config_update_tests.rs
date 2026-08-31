use super::*;
use color_eyre::eyre::WrapErr;
use pretty_assertions::assert_eq;
use std::path::Path;

#[test]
fn app_scoped_key_path_quotes_dotted_app_ids() {
    assert_eq!(
        app_scoped_key_path("plugin.linear", "enabled"),
        "apps.\"plugin.linear\".enabled"
    );
}

#[test]
fn trusted_project_edit_targets_project_trust_level() {
    assert_eq!(
        trusted_project_edit(Path::new("/workspace/team.project")),
        ConfigEdit {
            key_path: "projects.\"/workspace/team.project\".trust_level".to_string(),
            value: serde_json::json!("trusted"),
            merge_strategy: MergeStrategy::Replace,
        }
    );
}

#[test]
fn format_config_error_preserves_server_validation_message() {
    let err = Err::<(), _>(color_eyre::eyre::eyre!(
        "config/batchWrite failed: Invalid configuration: features.fast_mode=true violates \
         managed requirements; allowed set [fast_mode=false]"
    ))
    .wrap_err("config/batchWrite failed in TUI")
    .unwrap_err();

    assert_eq!(
        format_config_error(&err),
        "config/batchWrite failed in TUI: config/batchWrite failed: Invalid configuration: \
         features.fast_mode=true violates managed requirements; allowed set [fast_mode=false]"
    );
}

#[test]
fn model_selection_turns_auto_routing_off() {
    assert_eq!(
        build_model_selection_edits("gpt-5.6-sol", Some("high")),
        vec![
            replace_config_value("model", serde_json::json!("gpt-5.6-sol")),
            replace_config_value("model_reasoning_effort", serde_json::json!("high")),
            replace_config_value("features.auto_model_routing", serde_json::json!(false)),
        ]
    );
}

#[test]
fn provider_model_selection_retains_the_selected_reasoning_effort() {
    assert_eq!(
        build_provider_model_selection_edits(
            "unique-openai-model",
            "openai",
            Some(&codex_protocol::openai_models::ReasoningEffort::High),
            None,
        ),
        vec![
            replace_config_value("model", serde_json::json!("unique-openai-model")),
            replace_config_value("model_provider", serde_json::json!("openai")),
            replace_config_value("model_reasoning_effort", serde_json::json!("high")),
            replace_config_value("features.auto_model_routing", serde_json::json!(false)),
            clear_config_value("model_context_window"),
        ]
    );
}

#[test]
fn provider_model_selection_without_an_effort_clears_a_stale_value() {
    assert_eq!(
        build_provider_model_selection_edits("local-model", "ollama", None::<&str>, Some(8192)),
        vec![
            replace_config_value("model", serde_json::json!("local-model")),
            replace_config_value("model_provider", serde_json::json!("ollama")),
            clear_config_value("model_reasoning_effort"),
            replace_config_value("features.auto_model_routing", serde_json::json!(false)),
            replace_config_value("model_context_window", serde_json::json!(8192)),
        ]
    );
}

#[test]
fn auto_model_routing_persists_terra_as_the_safe_default() {
    assert_eq!(
        build_auto_model_routing_edits(),
        vec![
            replace_config_value("model", serde_json::json!("gpt-5.6-terra")),
            replace_config_value("model_reasoning_effort", serde_json::json!("medium")),
            replace_config_value("features.auto_model_routing", serde_json::json!(true)),
        ]
    );
}

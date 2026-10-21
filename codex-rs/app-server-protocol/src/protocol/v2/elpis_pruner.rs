//! Model selection for Elpis's tool-result pruning, separate from the main model.
use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct PrunerReadParams {}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct PrunerWriteParams {
    pub expected_version: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_edit: Option<PrunerPromptEdit>,
}

/// Omitted preserves the prompt; an explicit null inside this edit restores the default.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct PrunerPromptEdit {
    pub system_prompt: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct PrunerProviderChoice {
    pub id: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct PrunerReadResponse {
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<codex_protocol::openai_models::ReasoningEffort>,
    pub version: String,
    pub providers: Vec<PrunerProviderChoice>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub default_system_prompt: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_edits_distinguish_model_only_saves_from_restoring_the_default() {
        let base = serde_json::json!({ "expectedVersion": "v1", "model": null, "provider": null });
        let unchanged: PrunerWriteParams = serde_json::from_value(base.clone()).unwrap();
        assert!(unchanged.prompt_edit.is_none());
        let mut reset = base;
        reset["promptEdit"] = serde_json::json!({ "systemPrompt": null });
        let reset: PrunerWriteParams = serde_json::from_value(reset).unwrap();
        assert_eq!(reset.prompt_edit.unwrap().system_prompt, None);
    }
}

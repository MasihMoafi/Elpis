use super::*;
use codex_protocol::openai_models::ApplyPatchToolType;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ReasoningEffort;
use pretty_assertions::assert_eq;

/// Rows as core reads them: through the gateway's own check and core's `ModelsResponse`.
fn read(wire: GatewayWire, body: Value) -> Vec<ModelInfo> {
    let catalog = catalog_response(models_from_listing(wire, &body)).expect("core reads the catalog");
    serde_json::from_value::<ModelsResponse>(catalog)
        .expect("core reads the catalog")
        .models
}

#[test]
fn anthropic_models_are_read_from_the_listing() {
    let models = read(
        GatewayWire::AnthropicMessages,
        json!({"data": [
            {"type": "model", "id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6"},
            {"type": "model", "id": "claude-haiku-4-5"},
        ]}),
    );

    assert_eq!(models.len(), 2);
    assert_eq!(models[0].slug, "claude-sonnet-4-6");
    assert_eq!(models[0].display_name, "Claude Sonnet 4.6");
    // A missing display name falls back to the id rather than an invented one.
    assert_eq!(models[1].display_name, "claude-haiku-4-5");
    assert_eq!(models[0].context_window, Some(200_000));
    assert!(models[0].supported_reasoning_levels.is_empty());
}

#[test]
fn a_discovered_model_runs_with_the_agents_instructions_and_plain_tools() {
    let models = read(
        GatewayWire::AnthropicMessages,
        json!({"data": [{"id": "claude-sonnet-4-6"}]}),
    );

    assert_eq!(
        models[0]
            .model_messages
            .as_ref()
            .and_then(|messages| messages.instructions_template.as_deref()),
        Some(BASE_INSTRUCTIONS)
    );
    assert_eq!(
        models[0].apply_patch_tool_type,
        Some(ApplyPatchToolType::Freeform)
    );
    // Code mode is for OpenAI's models; a vendor model gets function tools.
    assert_eq!(models[0].tool_mode, None);
}

#[test]
fn gemini_lists_models_that_answer_turns_with_their_reported_window() {
    let models = read(
        GatewayWire::GeminiGenerateContent,
        json!({"models": [
            {
                "name": "models/gemini-3.5-flash",
                "displayName": "Gemini 3.5 Flash",
                "inputTokenLimit": 1_048_576u64,
                "supportedGenerationMethods": ["generateContent"],
            },
            {
                "name": "models/text-embedding-004",
                "inputTokenLimit": 2048u64,
                "supportedGenerationMethods": ["embedContent"],
            },
            {
                "name": "models/gemini-experimental",
                "supportedGenerationMethods": ["generateContent"],
            },
        ]}),
    );

    assert_eq!(
        models.iter().map(|model| model.slug.as_str()).collect::<Vec<_>>(),
        vec!["gemini-3.5-flash", "gemini-experimental"]
    );
    assert_eq!(models[0].context_window, Some(1_048_576));
    // No reported window stays unknown.
    assert_eq!(models[1].context_window, None);
}

#[test]
fn a_listing_that_cannot_be_read_lists_nothing() {
    for wire in [
        GatewayWire::Chat,
        GatewayWire::AnthropicMessages,
        GatewayWire::GeminiGenerateContent,
    ] {
        assert!(models_from_listing(wire, &json!({"error": {"message": "Invalid API key"}})).is_empty());
    }
    assert!(models_from_listing(GatewayWire::Chat, &json!({"data": "nope"})).is_empty());
    assert!(models_from_listing(GatewayWire::Chat, &json!([{"object": "model"}])).is_empty());
}

#[test]
fn chat_windows_are_read_from_whichever_key_the_provider_uses() {
    let models = read(
        GatewayWire::Chat,
        json!({"data": [
            {"id": "deepseek-chat", "object": "model"},
            {"id": "llama-3.3-70b-versatile", "context_window": 131_072u64},
            {"id": "mistral-large-latest", "max_context_length": 131_072u64},
            {"id": "anthropic/claude-sonnet-4.5", "name": "Anthropic: Claude Sonnet 4.5", "context_length": 200_000u64},
            {"id": "zero", "context_length": 0},
        ]}),
    );

    assert_eq!(models[0].context_window, None);
    assert_eq!(
        models[0].description.as_deref(),
        Some("context window not reported")
    );
    assert_eq!(models[1].context_window, Some(131_072));
    assert_eq!(models[2].context_window, Some(131_072));
    assert_eq!(models[3].display_name, "Anthropic: Claude Sonnet 4.5");
    assert_eq!(models[3].context_window, Some(200_000));
    // A zero window is the provider saying nothing, not a zero-token model.
    assert_eq!(models[4].context_window, None);
}

#[test]
fn reasoning_levels_and_tool_support_follow_the_listed_parameters() {
    let models = read(
        GatewayWire::Chat,
        json!({"data": [
            {"id": "deepseek/deepseek-v4.1-flash", "supported_parameters": ["tools", "reasoning"]},
            {"id": "meta-llama/llama-3.3-70b-instruct", "supported_parameters": ["tools", "temperature"]},
            // Cannot call tools, so it cannot run the agent.
            {"id": "some/chat-only-model", "supported_parameters": ["temperature"]},
            {"id": "some/model-that-says-nothing"},
        ]}),
    );

    assert_eq!(
        models.iter().map(|model| model.slug.as_str()).collect::<Vec<_>>(),
        vec![
            "deepseek/deepseek-v4.1-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "some/model-that-says-nothing",
        ]
    );
    assert_eq!(
        models[0]
            .supported_reasoning_levels
            .iter()
            .map(|preset| preset.effort.clone())
            .collect::<Vec<_>>(),
        vec![
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High
        ]
    );
    assert_eq!(
        models[0].default_reasoning_level,
        Some(ReasoningEffort::Medium)
    );
    assert!(models[1].supported_reasoning_levels.is_empty());
    assert_eq!(models[1].default_reasoning_level, None);
}

#[test]
fn a_bare_array_listing_is_read_like_a_data_envelope() {
    let models = read(
        GatewayWire::Chat,
        json!([
            {"id": "meta-llama/Llama-3.3-70B-Instruct-Turbo", "display_name": "Llama 3.3 70B", "context_length": 131_072u64},
            {"id": "BAAI/bge-large-en-v1.5", "type": "embedding"},
        ]),
    );

    assert_eq!(models.len(), 2);
    assert_eq!(models[0].display_name, "Llama 3.3 70B");
}

#[test]
fn a_row_core_cannot_read_is_caught_before_it_leaves() {
    assert!(catalog_response(vec![json!({"slug": "only-a-slug"})]).is_err());
}

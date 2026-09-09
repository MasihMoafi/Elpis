use codex_api::OpenAiVerbosity;
use codex_api::ResponsesApiRequest;
use codex_api::TextControls;
use codex_api::create_text_param_for_request;
use codex_protocol::config_types::ServiceTier;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ImageDetail;
use pretty_assertions::assert_eq;

use super::*;

fn prompt_with_image_outputs() -> Prompt {
    Prompt {
        input: vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputImage {
                    image_url: "https://example.com/image.png".to_string(),
                    detail: Some(ImageDetail::Original),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCallOutput {
                id: None,
                call_id: "function-call".to_string(),
                output: FunctionCallOutputPayload::from_content_items(vec![
                    FunctionCallOutputContentItem::InputImage {
                        image_url: "data:image/png;base64,function".to_string(),
                        detail: Some(ImageDetail::High),
                    },
                ]),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::CustomToolCallOutput {
                id: None,
                call_id: "custom-call".to_string(),
                name: None,
                output: FunctionCallOutputPayload::from_content_items(vec![
                    FunctionCallOutputContentItem::InputImage {
                        image_url: "data:image/png;base64,custom".to_string(),
                        detail: Some(ImageDetail::Auto),
                    },
                ]),
                internal_chat_message_metadata_passthrough: None,
            },
        ],
        ..Default::default()
    }
}

#[test]
fn responses_lite_request_copies_strip_image_details() {
    let prompt = prompt_with_image_outputs();
    let original = prompt.input.clone();

    let stripped = prompt.get_formatted_input_for_request(/*use_responses_lite*/ true);

    assert_eq!(
        stripped,
        vec![
            ResponseItem::Message {
                id: None,
                role: "user".to_string(),
                content: vec![ContentItem::InputImage {
                    image_url: "https://example.com/image.png".to_string(),
                    detail: None,
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCallOutput {
                id: None,
                call_id: "function-call".to_string(),
                output: FunctionCallOutputPayload::from_content_items(vec![
                    FunctionCallOutputContentItem::InputImage {
                        image_url: "data:image/png;base64,function".to_string(),
                        detail: None,
                    },
                ]),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::CustomToolCallOutput {
                id: None,
                call_id: "custom-call".to_string(),
                name: None,
                output: FunctionCallOutputPayload::from_content_items(vec![
                    FunctionCallOutputContentItem::InputImage {
                        image_url: "data:image/png;base64,custom".to_string(),
                        detail: None,
                    },
                ]),
                internal_chat_message_metadata_passthrough: None,
            },
        ]
    );
    assert_eq!(prompt.input, original);
    assert_eq!(
        prompt.get_formatted_input_for_request(/*use_responses_lite*/ false),
        original
    );
}

#[test]
fn prompt_context_attribution_comes_from_final_request_without_padding() {
    let message = |role: &str, text: &str| ResponseItem::Message {
        id: None,
        role: role.to_string(),
        content: vec![if role == "assistant" {
            ContentItem::OutputText {
                text: text.to_string(),
            }
        } else {
            ContentItem::InputText {
                text: text.to_string(),
            }
        }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    };
    let prompt = Prompt {
        input: vec![
            message("developer", &"developer ".repeat(200)),
            message("user", &"user ".repeat(200)),
            message("assistant", &"assistant ".repeat(200)),
            ResponseItem::Reasoning {
                id: None,
                summary: vec![
                    codex_protocol::models::ReasoningItemReasoningSummary::SummaryText {
                        text: "reasoning ".repeat(200),
                    },
                ],
                content: None,
                encrypted_content: None,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCall {
                id: None,
                name: "lookup".to_string(),
                namespace: None,
                arguments: r#"{"query":"evidence"}"#.to_string(),
                call_id: "call-1".to_string(),
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseItem::FunctionCallOutput {
                id: None,
                call_id: "call-1".to_string(),
                output: FunctionCallOutputPayload::from_text("result ".repeat(200)),
                internal_chat_message_metadata_passthrough: None,
            },
        ],
        tools: vec![codex_tools::ToolSpec::Freeform(codex_tools::FreeformTool {
            name: "lookup".to_string(),
            description: "Look up evidence".to_string(),
            format: codex_tools::FreeformToolFormat {
                r#type: "grammar".to_string(),
                syntax: "query".to_string(),
                definition: "root: query".to_string(),
            },
        })],
        base_instructions: codex_protocol::models::BaseInstructions {
            text: "system ".repeat(200),
        },
        output_schema: Some(serde_json::json!({"type": "string"})),
        ..Default::default()
    };

    let attribution = prompt.context_attribution_snapshot();
    for (label, tokens) in [
        ("system instructions", attribution.system_instructions),
        ("developer messages", attribution.developer_messages),
        ("user messages", attribution.user_messages),
        ("agent messages", attribution.agent_messages),
        ("reasoning", attribution.reasoning),
        ("tool calls", attribution.tool_calls),
        ("tool results", attribution.tool_results),
        ("tool definitions", attribution.tool_definitions),
        ("output schema", attribution.output_schema),
    ] {
        assert!(tokens > 0, "missing {label} attribution");
    }
    assert_eq!(
        attribution.estimated_total,
        attribution.system_instructions
            + attribution.developer_messages
            + attribution.user_messages
            + attribution.agent_messages
            + attribution.reasoning
            + attribution.tool_calls
            + attribution.tool_results
            + attribution.tool_definitions
            + attribution.output_schema
            + attribution.unrecognized_items,
        "the run-built estimate must be the exact sum, never a padded provider gap",
    );

    let empty = Prompt::default().context_attribution_snapshot();
    assert_eq!(empty.estimated_total, empty.system_instructions);
    assert!(empty.system_instructions > 0);
    assert_eq!(empty.developer_messages, 0);
    assert_eq!(empty.user_messages, 0);
    assert_eq!(empty.agent_messages, 0);
    assert_eq!(empty.reasoning, 0);
    assert_eq!(empty.tool_calls, 0);
    assert_eq!(empty.tool_results, 0);
    assert_eq!(empty.tool_definitions, 0);
    assert_eq!(empty.output_schema, 0);
    assert_eq!(empty.unrecognized_items, 0);
}

#[test]
fn serializes_text_verbosity_when_set() {
    let input: Vec<ResponseItem> = vec![];
    let tools: Vec<serde_json::Value> = vec![];
    let req = ResponsesApiRequest {
        prompt_cache_options: None,
        prompt_cache_breakpoints: Vec::new(),
        model: "gpt-5.4".to_string(),
        instructions: "i".to_string(),
        input,
        tools: Some(tools),
        tool_choice: "auto".to_string(),
        parallel_tool_calls: true,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: vec![],
        prompt_cache_key: None,
        service_tier: None,
        text: Some(TextControls {
            verbosity: Some(OpenAiVerbosity::Low),
            format: None,
        }),
        client_metadata: None,
    };

    let v = serde_json::to_value(&req).expect("json");
    assert_eq!(
        v.get("text")
            .and_then(|t| t.get("verbosity"))
            .and_then(|s| s.as_str()),
        Some("low")
    );
}

#[test]
fn serializes_text_schema_with_strict_format() {
    let input: Vec<ResponseItem> = vec![];
    let tools: Vec<serde_json::Value> = vec![];
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "answer": {"type": "string"}
        },
        "required": ["answer"],
    });
    let text_controls = create_text_param_for_request(
        /*verbosity*/ None,
        &Some(schema.clone()),
        /*output_schema_strict*/ true,
    )
    .expect("text controls");

    let req = ResponsesApiRequest {
        prompt_cache_options: None,
        prompt_cache_breakpoints: Vec::new(),
        model: "gpt-5.4".to_string(),
        instructions: "i".to_string(),
        input,
        tools: Some(tools),
        tool_choice: "auto".to_string(),
        parallel_tool_calls: true,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: vec![],
        prompt_cache_key: None,
        service_tier: None,
        text: Some(text_controls),
        client_metadata: None,
    };

    let v = serde_json::to_value(&req).expect("json");
    let text = v.get("text").expect("text field");
    assert!(text.get("verbosity").is_none());
    let format = text.get("format").expect("format field");

    assert_eq!(
        format.get("name"),
        Some(&serde_json::Value::String("codex_output_schema".into()))
    );
    assert_eq!(
        format.get("type"),
        Some(&serde_json::Value::String("json_schema".into()))
    );
    assert_eq!(format.get("strict"), Some(&serde_json::Value::Bool(true)));
    assert_eq!(format.get("schema"), Some(&schema));
}

#[test]
fn serializes_text_schema_with_non_strict_format() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "rationale": {"type": "string"}
        },
        "required": ["answer"],
        "additionalProperties": false
    });
    let text_controls = create_text_param_for_request(
        /*verbosity*/ None,
        &Some(schema.clone()),
        /*output_schema_strict*/ false,
    )
    .expect("text controls");

    let format = text_controls.format.expect("format field");
    assert!(!format.strict);
    assert_eq!(format.schema, schema);
}

#[test]
fn omits_text_when_not_set() {
    let input: Vec<ResponseItem> = vec![];
    let tools: Vec<serde_json::Value> = vec![];
    let req = ResponsesApiRequest {
        prompt_cache_options: None,
        prompt_cache_breakpoints: Vec::new(),
        model: "gpt-5.4".to_string(),
        instructions: "i".to_string(),
        input,
        tools: Some(tools),
        tool_choice: "auto".to_string(),
        parallel_tool_calls: true,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: vec![],
        prompt_cache_key: None,
        service_tier: None,
        text: None,
        client_metadata: None,
    };

    let v = serde_json::to_value(&req).expect("json");
    assert!(v.get("text").is_none());
}

#[test]
fn serializes_flex_service_tier_when_set() {
    let req = ResponsesApiRequest {
        prompt_cache_options: None,
        prompt_cache_breakpoints: Vec::new(),
        model: "gpt-5.4".to_string(),
        instructions: "i".to_string(),
        input: vec![],
        tools: Some(vec![]),
        tool_choice: "auto".to_string(),
        parallel_tool_calls: true,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: vec![],
        prompt_cache_key: None,
        service_tier: Some(ServiceTier::Flex.to_string()),
        text: None,
        client_metadata: None,
    };

    let v = serde_json::to_value(&req).expect("json");
    assert_eq!(
        v.get("service_tier").and_then(|tier| tier.as_str()),
        Some("flex")
    );
}

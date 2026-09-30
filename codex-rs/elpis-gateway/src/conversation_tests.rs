use super::*;
use crate::test_support::conversation;
use crate::test_support::core_tools;
use crate::test_support::responses_request;
use pretty_assertions::assert_eq;

#[test]
fn messages_keep_their_roles_and_developer_messages_become_system() {
    let request = responses_request(
        json!([
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "Rules."}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Hello"}]},
            {"type": "message", "role": "user", "content": []},
        ]),
        json!([]),
    );
    let conversation = conversation(&request);

    assert_eq!(conversation.instructions, "Be exact.");
    assert_eq!(
        conversation.turns,
        vec![
            Turn::System("Rules.".to_string()),
            Turn::User("Hi".to_string()),
            Turn::Assistant("Hello".to_string()),
        ]
    );
}

#[test]
fn a_freeform_tool_becomes_a_function_taking_its_raw_input() {
    let conversation = conversation(&responses_request(json!([]), core_tools()));
    let patch = conversation
        .tools
        .iter()
        .find(|tool| tool.name == "apply_patch")
        .expect("apply_patch is declared");

    assert_eq!(patch.parameters["required"], json!(["input"]));
    assert!(patch.description.starts_with("Edits files."));
    // The grammar the Responses API would enforce is shown to the model instead.
    assert!(patch.description.contains("lark grammar:\nstart: begin_patch"));
    assert_eq!(
        conversation.tool_map.restore("apply_patch"),
        Some(&ToolIdentity {
            name: "apply_patch".to_string(),
            namespace: None,
            custom: true,
        })
    );
    assert_eq!(
        conversation.tool_map.restore("exec_command").map(|tool| tool.custom),
        Some(false)
    );
}

#[test]
fn freeform_calls_in_history_are_replayed_as_function_calls() {
    let request = responses_request(
        json!([
            {"type": "custom_tool_call", "call_id": "c1", "name": "apply_patch", "input": "*** Begin Patch"},
            {"type": "custom_tool_call_output", "call_id": "c1", "output": "Done"},
            {"type": "function_call", "call_id": "c2", "name": "exec_command", "arguments": ""},
            {"type": "function_call_output", "call_id": "c2", "output": [{"type": "input_text", "text": "ok"}]},
        ]),
        core_tools(),
    );

    assert_eq!(
        conversation(&request).turns,
        vec![
            Turn::ToolCall {
                call_id: "c1".to_string(),
                name: "apply_patch".to_string(),
                arguments: json!({"input": "*** Begin Patch"}).to_string(),
            },
            Turn::ToolResult {
                call_id: "c1".to_string(),
                output: "Done".to_string(),
            },
            // Empty arguments are an empty object, which every vendor accepts.
            Turn::ToolCall {
                call_id: "c2".to_string(),
                name: "exec_command".to_string(),
                arguments: "{}".to_string(),
            },
            Turn::ToolResult {
                call_id: "c2".to_string(),
                output: "ok".to_string(),
            },
        ]
    );
}

#[test]
fn namespaced_tools_are_flattened_and_restored() {
    let tools = json!([{
        "type": "namespace",
        "name": "mcp__docs",
        "description": "Docs server.",
        "tools": [{"type": "function", "name": "search", "description": "Search.", "parameters": {"type": "object"}}],
    }]);
    let conversation = conversation(&responses_request(json!([]), tools));

    assert_eq!(conversation.tools.len(), 1);
    assert_eq!(conversation.tools[0].name, "mcp__docs__search");
    assert_eq!(
        conversation.tool_map.restore("mcp__docs__search"),
        Some(&ToolIdentity {
            name: "search".to_string(),
            namespace: Some("mcp__docs".to_string()),
            custom: false,
        })
    );
}

#[test]
fn tools_only_openai_can_run_are_dropped_not_refused() {
    let tools = json!([
        {"type": "web_search"},
        {"type": "image_generation", "name": "image_generation"},
        {"type": "tool_search", "execution": "client", "description": "", "parameters": {}},
        {"type": "function", "name": "exec_command", "description": "", "parameters": {}},
    ]);
    let conversation = conversation(&responses_request(json!([]), tools));

    assert_eq!(
        conversation
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["exec_command"]
    );
}

#[test]
fn an_image_becomes_a_placeholder_and_its_data_never_leaves() {
    let request = responses_request(
        json!([{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is this?"},
                {"type": "input_image", "image_url": "data:image/png;base64,SECRETPIXELS"},
            ],
        }]),
        json!([]),
    );
    let turns = conversation(&request).turns;

    assert_eq!(
        turns,
        vec![Turn::User(format!("What is this?\n{IMAGE_OMITTED}"))]
    );
    assert!(!format!("{turns:?}").contains("SECRETPIXELS"));
}

#[test]
fn a_tool_result_without_a_call_id_is_refused() {
    let request = responses_request(
        json!([{"type": "function_call_output", "output": "orphan"}]),
        json!([]),
    );

    let error = Conversation::from_request(&request).expect_err("an orphan result is refused");
    assert_eq!(error.status, http::StatusCode::BAD_REQUEST);
}

#[test]
fn gemini_signatures_are_recovered_and_openai_reasoning_is_ignored() {
    let request = responses_request(
        json!([
            {
                "type": "reasoning",
                "summary": [],
                "encrypted_content": format!(
                    "{GEMINI_SIGNATURE_PREFIX}{}",
                    json!({"call_id": "g1", "signature": "sig-1"})
                ),
            },
            {"type": "reasoning", "summary": [], "encrypted_content": "gAAAA-openai-state"},
            {"type": "web_search_call", "status": "completed", "action": {"type": "search", "query": "x"}},
        ]),
        json!([]),
    );
    let conversation = conversation(&request);

    assert_eq!(
        conversation.gemini_signatures,
        HashMap::from([("g1".to_string(), "sig-1".to_string())])
    );
    // OpenAI-only history items do not reach the vendor.
    assert_eq!(conversation.turns, Vec::new());
}

#[test]
fn vendor_tool_names_are_safe_stable_and_distinct() {
    assert_eq!(vendor_tool_name("exec_command", None), "exec_command");
    let dotted = vendor_tool_name("files.read", Some("my server"));
    assert!(is_vendor_safe(&dotted), "{dotted}");
    assert_eq!(dotted, vendor_tool_name("files.read", Some("my server")));
    assert_ne!(dotted, vendor_tool_name("files_read", Some("my server")));
    let long = vendor_tool_name(&"x".repeat(200), None);
    assert!(long.len() <= MAX_TOOL_NAME_LEN && is_vendor_safe(&long), "{long}");
    assert!(is_vendor_safe(&vendor_tool_name("9lives", None)));
}

use super::*;
use codex_protocol::models::FunctionCallOutputPayload;
use pretty_assertions::assert_eq;

fn message(role: &str, texts: &[&str]) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: role.to_string(),
        content: texts
            .iter()
            .map(|text| ContentItem::InputText {
                text: (*text).to_string(),
            })
            .collect(),
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn tool_call(call_id: &str) -> ResponseItem {
    ResponseItem::FunctionCall {
        id: None,
        name: "exec".to_string(),
        namespace: None,
        arguments: "{}".to_string(),
        call_id: call_id.to_string(),
        internal_chat_message_metadata_passthrough: None,
    }
}

fn tool_output(call_id: &str, text: &str) -> ResponseItem {
    ResponseItem::FunctionCallOutput {
        id: None,
        call_id: call_id.to_string(),
        output: FunctionCallOutputPayload::from_text(text.to_string()),
        internal_chat_message_metadata_passthrough: None,
    }
}

/// Preamble (developer instructions + AGENTS.md + opening user turn), then an agent loop.
fn session_input() -> Vec<ResponseItem> {
    vec![
        message("developer", &["base instructions", "# AGENTS.md"]),
        message("user", &["familiarize yourself with this project"]),
        ResponseItem::Reasoning {
            id: None,
            summary: Vec::new(),
            content: None,
            encrypted_content: None,
            internal_chat_message_metadata_passthrough: None,
        },
        tool_call("call-1"),
        tool_output("call-1", "a very long tool result"),
        tool_call("call-2"),
        tool_output("call-2", "another long tool result"),
    ]
}

#[test]
fn gpt_5_6_family_members_accept_explicit_caching() {
    for slug in ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6"] {
        assert!(
            model_supports_explicit_prompt_cache(slug),
            "{slug} should support explicit prompt caching"
        );
    }
}

#[test]
fn models_that_reject_the_fields_are_gated_out() {
    for slug in [
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5",
        "gpt-4o",
        "o3",
        "claude-opus-5",
        "gemini-3-pro",
        "",
    ] {
        assert!(
            !model_supports_explicit_prompt_cache(slug),
            "{slug} must not be sent prompt_cache_options"
        );
    }
}

#[test]
fn unsupported_models_and_providers_receive_no_cache_fields() {
    for (is_openai, slug) in [
        (true, "gpt-5.5"),
        (true, "gpt-4o"),
        (false, "gpt-5.6-sol"),
        (false, "claude-opus-5"),
    ] {
        assert_eq!(
            plan_prompt_cache_for_provider(is_openai, slug, &session_input(), false),
            PromptCachePlan::default(),
            "unsupported cache fields must be absent for provider={is_openai}, model={slug}"
        );
    }
}

#[test]
fn later_families_stay_supported_without_a_code_change() {
    assert!(model_supports_explicit_prompt_cache("gpt-5.7-sol"));
    assert!(model_supports_explicit_prompt_cache("gpt-6.0-sol"));
    assert!(model_supports_explicit_prompt_cache("gpt-6"));
}

/// Applies one pruning pass the way `run_context_prune` does: rewrite covered outputs
/// into receipts, drop dead-end calls, and seal the region with an epoch marker.
fn prune(input: &[ResponseItem], covered: &[&str], kept: &str) -> Vec<ResponseItem> {
    let mut items = input.to_vec();
    let record = context_pruner::PruneRecord {
        covered_call_ids: covered.iter().map(|id| (*id).to_string()).collect(),
        text: format!("{kept}: still relevant"),
    };
    context_pruner::apply_prune_record_untracked(&mut items, &record);
    items
}

#[test]
fn the_default_plan_stays_on_implicit_mode() {
    // Implicit mode already honours the breakpoints a request carries *and* writes the
    // latest-message one for free. Sending `mode: explicit` would disable that free write
    // to buy nothing, so the default must leave `options` unset.
    let plan = plan_prompt_cache(&session_input(), /*explicit_mode*/ false);

    assert_eq!(plan.options, None);
    assert!(!plan.breakpoints.is_empty());
}

#[test]
fn before_any_pruning_the_only_boundary_is_the_stable_prefix() {
    let plan = plan_prompt_cache(&session_input(), /*explicit_mode*/ false);

    assert_eq!(
        plan.breakpoints,
        // End of the preamble: last block of the opening user message. The epoch boundary
        // does not exist yet, and resolves to the same position, so it dedupes away.
        vec![PromptCacheBreakpointPosition {
            item: 1,
            content: 0
        }]
    );
}

#[test]
fn an_assistant_message_ends_the_stable_prefix_run() {
    let input = vec![
        message("developer", &["instructions"]),
        message("user", &["opening question"]),
        message("assistant", &["opening answer"]),
        message("user", &["follow-up"]),
    ];

    assert_eq!(
        plan_prompt_cache(&input, /*explicit_mode*/ false).breakpoints,
        vec![PromptCacheBreakpointPosition {
            item: 1,
            content: 0,
        }]
    );
}

#[test]
fn a_pruning_pass_adds_a_breakpoint_on_its_epoch_marker() {
    let pruned = prune(&session_input(), &["call-1", "call-2"], "call-1");
    let marker = context_pruner::frozen_prefix_len(&pruned) - 1;
    assert!(marker > 1, "the epoch marker must sit past the preamble");

    let plan = plan_prompt_cache(&pruned, /*explicit_mode*/ false);

    assert_eq!(
        plan.breakpoints,
        vec![
            PromptCacheBreakpointPosition {
                item: 1,
                content: 0
            },
            PromptCacheBreakpointPosition {
                item: marker,
                content: 0
            },
        ],
        "the frozen epoch boundary is the prefix the next pass falls back to"
    );
}

#[test]
fn gpt_5_6_serializes_the_breakpoint_on_the_frozen_epoch_boundary() {
    let input = prune(&session_input(), &["call-1", "call-2"], "call-1");
    let frozen = context_pruner::frozen_prefix_len(&input);
    let plan = plan_prompt_cache(&input, /*explicit_mode*/ false);
    let request = codex_api::ResponsesApiRequest {
        model: "gpt-5.6-sol".to_string(),
        instructions: String::new(),
        input,
        tools: None,
        tool_choice: "auto".to_string(),
        parallel_tool_calls: false,
        reasoning: None,
        store: false,
        stream: true,
        stream_options: None,
        include: Vec::new(),
        service_tier: None,
        prompt_cache_key: Some("session-1".to_string()),
        prompt_cache_options: plan.options,
        prompt_cache_breakpoints: plan.breakpoints,
        text: None,
        client_metadata: None,
    };

    let body = codex_api::encode_responses_request(&request).expect("request should encode");
    assert_eq!(body.get("prompt_cache_options"), None);
    assert_eq!(
        body["input"][frozen - 1]["content"][0]["prompt_cache_breakpoint"],
        serde_json::json!({"mode": "explicit"})
    );
    assert_eq!(
        body["input"][1]["content"][0]["prompt_cache_breakpoint"],
        serde_json::json!({"mode": "explicit"})
    );
}

#[test]
fn ordinary_turns_after_a_pass_leave_the_cached_prefix_byte_identical() {
    // The invariant the whole architecture exists for: between pruning events, ordinary
    // agent turns only append, so every byte up to the epoch breakpoint -- and the
    // breakpoint's own address -- is unchanged and still hits.
    let pruned = prune(&session_input(), &["call-1", "call-2"], "call-1");
    let before = plan_prompt_cache(&pruned, /*explicit_mode*/ false);
    let frozen = context_pruner::frozen_prefix_len(&pruned);

    let mut later = pruned.clone();
    later.push(message("user", &["now write it up"]));
    later.push(tool_call("call-3"));
    later.push(tool_output("call-3", "fresh output"));

    let after = plan_prompt_cache(&later, /*explicit_mode*/ false);

    assert_eq!(pruned[..frozen], later[..frozen]);
    assert_eq!(before.breakpoints, after.breakpoints);
}

#[test]
fn the_next_pass_starts_a_new_epoch_and_leaves_the_previous_one_untouched() {
    let first = prune(&session_input(), &["call-1"], "call-1");
    let first_frozen = context_pruner::frozen_prefix_len(&first);

    // A second working stretch, then a second pass over only the new material.
    let mut grown = first.clone();
    grown.push(tool_call("call-3"));
    grown.push(tool_output("call-3", "fresh output"));
    let second = prune(&grown, &["call-3"], "call-3");

    // Epoch 1's region is byte-identical, so the breakpoint written on its marker still
    // reads back after the pass that invalidated everything past it.
    assert_eq!(first[..first_frozen], second[..first_frozen]);
    let second_frozen = context_pruner::frozen_prefix_len(&second);
    assert!(
        second_frozen > first_frozen,
        "the second pass must seal a new, later epoch"
    );

    let plan = plan_prompt_cache(&second, /*explicit_mode*/ false);
    assert_eq!(
        plan.breakpoints.last(),
        Some(&PromptCacheBreakpointPosition {
            item: second_frozen - 1,
            content: 0
        })
    );
}

#[test]
fn explicit_mode_replaces_the_servers_tail_breakpoint_with_our_own() {
    let mut input = session_input();
    input.push(message("user", &["now write it up"]));

    let plan = plan_prompt_cache(&input, /*explicit_mode*/ true);

    assert_eq!(
        plan.options,
        Some(PromptCacheOptions {
            mode: PromptCacheMode::Explicit
        })
    );
    assert_eq!(
        plan.breakpoints,
        vec![
            PromptCacheBreakpointPosition {
                item: 1,
                content: 0
            },
            PromptCacheBreakpointPosition {
                item: 7,
                content: 0
            },
        ]
    );
}

#[test]
fn responses_lite_input_keeps_the_tool_block_inside_the_stable_prefix() {
    let input = vec![
        ResponseItem::AdditionalTools {
            id: None,
            role: "developer".to_string(),
            tools: Vec::new(),
        },
        message("developer", &["base instructions"]),
        message("user", &["go"]),
        tool_call("call-1"),
    ];

    let plan = plan_prompt_cache(&input, /*explicit_mode*/ false);

    assert_eq!(
        plan.breakpoints,
        vec![PromptCacheBreakpointPosition {
            item: 2,
            content: 0
        }]
    );
}

#[test]
fn an_input_with_no_eligible_block_sends_no_options_at_all() {
    // Explicit mode with zero breakpoints disables caching outright, so the plan has to
    // stay empty rather than emit `mode: explicit` on its own.
    let input = [tool_call("call-1"), tool_output("call-1", "out")];

    assert_eq!(
        plan_prompt_cache(&input, /*explicit_mode*/ true),
        PromptCachePlan::default()
    );
    assert_eq!(
        plan_prompt_cache(&input, /*explicit_mode*/ false),
        PromptCachePlan::default()
    );
}

#[test]
fn an_empty_input_sends_no_options() {
    assert_eq!(
        plan_prompt_cache(&[], /*explicit_mode*/ false),
        PromptCachePlan::default()
    );
}

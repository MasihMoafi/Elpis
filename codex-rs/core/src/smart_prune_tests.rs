use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputContentItem;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseItem;

use crate::smart_prune::AdmissionDecision;
use crate::smart_prune::AdmissionEvidence;
use crate::smart_prune::parse_decision_manifest;
use crate::smart_prune::transform_tool_output;

/// Break caught: replacing a fresh body accidentally changes or drops the function
/// output envelope the next provider request needs to pair with its tool call.
#[test]
fn compact_admission_changes_only_the_text_body() {
    let source_text = "important evidence line\n".repeat(600);
    let source = ResponseItem::FunctionCallOutput {
        id: None,
        call_id: "call-17".to_string(),
        output: FunctionCallOutputPayload {
            body: FunctionCallOutputBody::Text(source_text),
            success: Some(true),
        },
        internal_chat_message_metadata_passthrough: None,
    };
    let evidence = AdmissionEvidence {
        admission_id: "019a-test-admission",
        source_sha256: "0123456789abcdef",
    };

    let transformed = transform_tool_output(
        &source,
        "The command found 42 matching records in src/lib.rs.",
        evidence,
    )
    .expect("the large text result should be profitably compacted");

    let ResponseItem::FunctionCallOutput {
        id,
        call_id,
        output,
        internal_chat_message_metadata_passthrough,
    } = transformed.admitted
    else {
        panic!("function output must stay a function output");
    };

    assert_eq!(id, None);
    assert_eq!(call_id, "call-17");
    assert_eq!(output.success, Some(true));
    assert_eq!(internal_chat_message_metadata_passthrough, None);
    assert_eq!(
        output.body.to_text().as_deref(),
        Some(
            "The command found 42 matching records in src/lib.rs.\n\
[ELPIS SMART PRUNE]\n\
exact_source=smart-prune://019a-test-admission/call-17\n\
source_sha256=0123456789abcdef"
        )
    );
    assert!(transformed.saved_tokens >= 256);
}

/// Break caught: a partial or reordered model reply silently leaves one eligible output
/// without an explicit decision, making admission behavior dependent on parser accident.
#[test]
fn decision_manifest_requires_one_explicit_decision_per_call() {
    let raw = r#"{
        "items": [
            {"call_id":"call-a","decision":"compact","content":"kept fact A"},
            {"call_id":"call-b","decision":"unchanged"}
        ]
    }"#;

    let decisions = parse_decision_manifest(raw, &["call-a", "call-b"])
        .expect("complete manifest should parse");

    assert_eq!(
        decisions,
        vec![
            AdmissionDecision::Compact {
                call_id: "call-a".to_string(),
                content: "kept fact A".to_string(),
            },
            AdmissionDecision::Unchanged {
                call_id: "call-b".to_string(),
            },
        ]
    );
    assert!(parse_decision_manifest(raw, &["call-a", "call-b", "call-c"]).is_none());
}

#[test]
fn decision_manifest_rejects_unknown_duplicate_and_invalid_decisions() {
    let unknown = r#"{"items":[
        {"call_id":"call-a","decision":"unchanged"},
        {"call_id":"call-x","decision":"unchanged"}
    ]}"#;
    let duplicate = r#"{"items":[
        {"call_id":"call-a","decision":"unchanged"},
        {"call_id":"call-a","decision":"unchanged"}
    ]}"#;
    let unchanged_with_content =
        r#"{"items":[{"call_id":"call-a","decision":"unchanged","content":"extra"}]}"#;
    let compact_without_content = r#"{"items":[{"call_id":"call-a","decision":"compact"}]}"#;

    assert!(parse_decision_manifest(unknown, &["call-a", "call-b"]).is_none());
    assert!(parse_decision_manifest(duplicate, &["call-a", "call-b"]).is_none());
    assert!(parse_decision_manifest(unchanged_with_content, &["call-a"]).is_none());
    assert!(parse_decision_manifest(compact_without_content, &["call-a"]).is_none());
}

#[test]
fn admission_enforces_eligibility_boundary_for_text_and_non_text_output() {
    let output = |body| ResponseItem::FunctionCallOutput {
        id: None,
        call_id: "boundary".to_string(),
        output: FunctionCallOutputPayload {
            body,
            success: Some(true),
        },
        internal_chat_message_metadata_passthrough: None,
    };
    let evidence = AdmissionEvidence {
        admission_id: "boundary-admission",
        source_sha256: "source-hash",
    };

    assert!(
        transform_tool_output(
            &output(FunctionCallOutputBody::Text("x".repeat(4_092))),
            "kept",
            evidence,
        )
        .is_none(),
        "1,023 approximate tokens must remain ineligible"
    );
    assert!(
        transform_tool_output(
            &output(FunctionCallOutputBody::Text("x".repeat(4_096))),
            "kept",
            evidence,
        )
        .is_some(),
        "1,024 approximate tokens are eligible when savings clear the floor"
    );
    assert!(
        transform_tool_output(
            &output(FunctionCallOutputBody::ContentItems(vec![
                FunctionCallOutputContentItem::InputText {
                    text: "tool metadata".to_string(),
                },
                FunctionCallOutputContentItem::InputText {
                    text: "x".repeat(8_000),
                },
            ])),
            "kept",
            evidence,
        )
        .is_some(),
        "all-text structured output is the real exec shape and must be eligible"
    );
    assert!(
        transform_tool_output(
            &output(FunctionCallOutputBody::ContentItems(vec![
                FunctionCallOutputContentItem::InputText {
                    text: "x".repeat(8_000),
                },
                FunctionCallOutputContentItem::InputImage {
                    image_url: "data:image/png;base64,AAA".to_string(),
                    detail: None,
                },
            ])),
            "kept",
            evidence,
        )
        .is_none(),
        "multimodal output must remain byte-identical"
    );
}

#[test]
fn admission_rejects_compaction_below_either_savings_floor() {
    let output = |text| ResponseItem::FunctionCallOutput {
        id: None,
        call_id: "savings".to_string(),
        output: FunctionCallOutputPayload::from_text(text),
        internal_chat_message_metadata_passthrough: None,
    };
    let evidence = AdmissionEvidence {
        admission_id: "savings-admission",
        source_sha256: "source-hash",
    };

    assert!(
        transform_tool_output(&output("x".repeat(4_096)), &"y".repeat(3_500), evidence).is_none(),
        "an admission saving fewer than 256 approximate tokens must be rejected"
    );
    assert!(
        transform_tool_output(&output("x".repeat(40_000)), &"y".repeat(33_000), evidence,)
            .is_none(),
        "an admission saving less than 20 percent must be rejected"
    );
}

/// Break caught: custom-tool output is converted into a function output or loses its
/// custom name while replacing the body.
#[test]
fn compact_admission_preserves_custom_tool_envelope() {
    let source = ResponseItem::CustomToolCallOutput {
        id: None,
        call_id: "custom-9".to_string(),
        name: Some("query_database".to_string()),
        output: FunctionCallOutputPayload {
            body: FunctionCallOutputBody::Text("database row\n".repeat(900)),
            success: Some(false),
        },
        internal_chat_message_metadata_passthrough: None,
    };

    let transformed = transform_tool_output(
        &source,
        "The query failed because column account_id does not exist.",
        AdmissionEvidence {
            admission_id: "019a-custom",
            source_sha256: "fedcba9876543210",
        },
    )
    .expect("large custom-tool text should be compactable");

    let ResponseItem::CustomToolCallOutput {
        call_id,
        name,
        output,
        ..
    } = transformed.admitted
    else {
        panic!("custom output must stay a custom output");
    };
    assert_eq!(call_id, "custom-9");
    assert_eq!(name.as_deref(), Some("query_database"));
    assert_eq!(output.success, Some(false));
    assert!(
        output
            .body
            .to_text()
            .is_some_and(|text| text.contains("column account_id does not exist"))
    );
}

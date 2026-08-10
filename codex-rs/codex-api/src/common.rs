// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use crate::error::ApiError;
use codex_protocol::config_types::ReasoningSummary as ReasoningSummaryConfig;
use codex_protocol::config_types::Verbosity as VerbosityConfig;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort as ReasoningEffortConfig;
use codex_protocol::protocol::ModelVerification;
use codex_protocol::protocol::RateLimitSnapshot;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::TurnModerationMetadataEvent;
use codex_protocol::protocol::W3cTraceContext;
use futures::Stream;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;
use tokio::sync::mpsc;

pub const WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY: &str = "ws_request_header_traceparent";
pub const WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY: &str = "ws_request_header_tracestate";

/// Canonical input payload for the compaction endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct CompactionInput<'a> {
    pub model: &'a str,
    pub input: &'a [ResponseItem],
    #[serde(skip_serializing_if = "str::is_empty")]
    pub instructions: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub parallel_tool_calls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
}

#[derive(Debug)]
pub enum ResponseEvent {
    Created,
    SafetyBuffering(SafetyBuffering),
    OutputItemDone(ResponseItem),
    OutputItemAdded(ResponseItem),
    /// Emitted when the server includes `OpenAI-Model` on the stream response.
    /// This can differ from the requested model when backend safety routing applies.
    ServerModel(String),
    /// Emitted when the server recommends additional account verification.
    ModelVerifications(Vec<ModelVerification>),
    /// Emitted when the server includes moderation metadata for first-party turn presentation.
    TurnModerationMetadata(TurnModerationMetadataEvent),
    /// Emitted when `X-Reasoning-Included: true` is present on the response,
    /// meaning the server already accounted for past reasoning tokens and the
    /// client should not re-estimate them.
    ServerReasoningIncluded(bool),
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>,
        /// Did the model affirmatively end its turn? Some providers do not set this,
        /// so we rely on fallback logic when this is `None`.
        end_turn: Option<bool>,
    },
    OutputTextDelta(String),
    ToolCallInputDelta {
        item_id: String,
        call_id: Option<String>,
        delta: String,
    },
    ReasoningSummaryDelta {
        delta: String,
        summary_index: i64,
    },
    ReasoningSummaryDone {
        item_id: String,
        text: String,
        summary_index: i64,
    },
    ReasoningContentDelta {
        delta: String,
        content_index: i64,
    },
    ReasoningSummaryPartAdded {
        summary_index: i64,
    },
    RateLimits(RateLimitSnapshot),
    ModelsEtag(String),
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SafetyBuffering {
    pub use_cases: Vec<String>,
    pub reasons: Vec<String>,
    #[serde(skip)]
    pub show_buffering_ui: bool,
    #[serde(rename = "retry_model")]
    pub faster_model: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SafetyBufferingTreatment {
    pub faster_model: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContext {
    Auto,
    CurrentTurn,
    AllTurns,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Reasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<ReasoningEffortConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<ReasoningSummaryConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ReasoningContext>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSummaryDelivery {
    SequentialCutoff,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct StreamOptions {
    pub reasoning_summary_delivery: ReasoningSummaryDelivery,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TextFormatType {
    #[default]
    JsonSchema,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq)]
pub struct TextFormat {
    /// Format type used by the OpenAI text controls.
    pub r#type: TextFormatType,
    /// When true, the server is expected to strictly validate responses.
    pub strict: bool,
    /// JSON schema for the desired output.
    pub schema: Value,
    /// Friendly name for the format, used in telemetry/debugging.
    pub name: String,
}

/// Controls the `text` field for the Responses API, combining verbosity and
/// optional JSON schema output formatting.
#[derive(Debug, Serialize, Default, Clone, PartialEq)]
pub struct TextControls {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<OpenAiVerbosity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<TextFormat>,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiVerbosity {
    Low,
    #[default]
    Medium,
    High,
}

impl From<VerbosityConfig> for OpenAiVerbosity {
    fn from(v: VerbosityConfig) -> Self {
        match v {
            VerbosityConfig::Low => OpenAiVerbosity::Low,
            VerbosityConfig::Medium => OpenAiVerbosity::Medium,
            VerbosityConfig::High => OpenAiVerbosity::High,
        }
    }
}

/// Request-wide prompt cache policy (`prompt_cache_options`).
///
/// Accepted by GPT-5.6 and later model families only; older models reject the field, so
/// it must stay `None` for anything else. `ttl` is deliberately not modelled: its only
/// supported value is the default `30m`.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub struct PromptCacheOptions {
    pub mode: PromptCacheMode,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptCacheMode {
    /// Server picks one breakpoint near the end of the prompt. This is the API default.
    Implicit,
    /// Only the breakpoints in the request are used. A request in this mode with no
    /// breakpoints does not use prompt caching at all.
    Explicit,
}

/// Marks the end of a reusable prefix. Valid on `input_text`, `input_image`, and
/// `input_file` content blocks; the breakpoint covers that block and everything before it.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
pub struct PromptCacheBreakpoint {
    pub mode: PromptCacheBreakpointMode,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PromptCacheBreakpointMode {
    Explicit,
}

/// Address of one explicit breakpoint: an index into `input` and an index into that
/// item's `content` array.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptCacheBreakpointPosition {
    pub item: usize,
    pub content: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ResponsesApiRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    pub input: Vec<ResponseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_options: Option<PromptCacheOptions>,
    /// Content blocks that carry an explicit `prompt_cache_breakpoint`.
    ///
    /// `ResponseItem`/`ContentItem` are persisted history types, so the request-only
    /// marker is stamped during encoding (see [`encode_responses_request`]) instead of
    /// being stored on the item and leaking into rollouts.
    #[serde(skip)]
    pub prompt_cache_breakpoints: Vec<PromptCacheBreakpointPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}

/// Serializes a Responses request, stamping `prompt_cache_breakpoint` onto the content
/// blocks named by `prompt_cache_breakpoints`.
pub fn encode_responses_request(request: &ResponsesApiRequest) -> Result<Value, serde_json::Error> {
    let mut body = serde_json::to_value(request)?;
    stamp_prompt_cache_breakpoints(&mut body, &request.prompt_cache_breakpoints);
    Ok(body)
}

/// Serializes a websocket `response.create` request the same way.
///
/// `ResponsesWsRequest` is internally tagged, so the request fields -- `input` included --
/// sit at the top level of the encoded object, exactly as in the HTTP body.
pub fn encode_responses_ws_request(
    request: &ResponsesWsRequest,
) -> Result<Value, serde_json::Error> {
    let ResponsesWsRequest::ResponseCreate(create) = request;
    let breakpoints = create.prompt_cache_breakpoints.clone();
    let mut body = serde_json::to_value(request)?;
    stamp_prompt_cache_breakpoints(&mut body, &breakpoints);
    Ok(body)
}

/// Positions that do not resolve to a content-block object are skipped rather than
/// erroring: a stale index must not fail the request, it must only lose the breakpoint.
fn stamp_prompt_cache_breakpoints(body: &mut Value, positions: &[PromptCacheBreakpointPosition]) {
    if positions.is_empty() {
        return;
    }
    let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) else {
        return;
    };
    let Ok(breakpoint) = serde_json::to_value(PromptCacheBreakpoint {
        mode: PromptCacheBreakpointMode::Explicit,
    }) else {
        return;
    };
    for position in positions {
        let Some(block) = input
            .get_mut(position.item)
            .and_then(|item| item.get_mut("content"))
            .and_then(Value::as_array_mut)
            .and_then(|content| content.get_mut(position.content))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        block.insert("prompt_cache_breakpoint".to_string(), breakpoint.clone());
    }
}

impl From<&ResponsesApiRequest> for ResponseCreateWsRequest {
    fn from(request: &ResponsesApiRequest) -> Self {
        Self {
            model: request.model.clone(),
            instructions: request.instructions.clone(),
            previous_response_id: None,
            input: request.input.clone(),
            tools: request.tools.clone(),
            tool_choice: request.tool_choice.clone(),
            parallel_tool_calls: request.parallel_tool_calls,
            reasoning: request.reasoning.clone(),
            store: request.store,
            stream: request.stream,
            stream_options: request.stream_options.clone(),
            include: request.include.clone(),
            service_tier: request.service_tier.clone(),
            prompt_cache_key: request.prompt_cache_key.clone(),
            prompt_cache_options: request.prompt_cache_options,
            prompt_cache_breakpoints: request.prompt_cache_breakpoints.clone(),
            text: request.text.clone(),
            generate: None,
            client_metadata: request.client_metadata.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ResponseCreateWsRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    pub input: Vec<ResponseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<StreamOptions>,
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_options: Option<PromptCacheOptions>,
    /// See [`ResponsesApiRequest::prompt_cache_breakpoints`]; stamped by
    /// [`encode_responses_ws_request`].
    #[serde(skip)]
    pub prompt_cache_breakpoints: Vec<PromptCacheBreakpointPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}

pub fn response_create_client_metadata(
    client_metadata: Option<HashMap<String, String>>,
    trace: Option<&W3cTraceContext>,
) -> Option<HashMap<String, String>> {
    let mut client_metadata = client_metadata.unwrap_or_default();

    if let Some(traceparent) = trace.and_then(|trace| trace.traceparent.as_deref()) {
        client_metadata.insert(
            WS_REQUEST_HEADER_TRACEPARENT_CLIENT_METADATA_KEY.to_string(),
            traceparent.to_string(),
        );
    }
    if let Some(tracestate) = trace.and_then(|trace| trace.tracestate.as_deref()) {
        client_metadata.insert(
            WS_REQUEST_HEADER_TRACESTATE_CLIENT_METADATA_KEY.to_string(),
            tracestate.to_string(),
        );
    }

    (!client_metadata.is_empty()).then_some(client_metadata)
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)]
pub enum ResponsesWsRequest {
    #[serde(rename = "response.create")]
    ResponseCreate(ResponseCreateWsRequest),
}

pub fn create_text_param_for_request(
    verbosity: Option<VerbosityConfig>,
    output_schema: &Option<Value>,
    output_schema_strict: bool,
) -> Option<TextControls> {
    if verbosity.is_none() && output_schema.is_none() {
        return None;
    }

    Some(TextControls {
        verbosity: verbosity.map(std::convert::Into::into),
        format: output_schema.as_ref().map(|schema| TextFormat {
            r#type: TextFormatType::JsonSchema,
            strict: output_schema_strict,
            schema: schema.clone(),
            name: "codex_output_schema".to_string(),
        }),
    })
}

pub struct ResponseStream {
    pub rx_event: mpsc::Receiver<Result<ResponseEvent, ApiError>>,
    /// Server-assigned `x-request-id` response header, when present.
    pub upstream_request_id: Option<String>,
}

impl Stream for ResponseStream {
    type Item = Result<ResponseEvent, ApiError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx_event.poll_recv(cx)
    }
}

#[cfg(test)]
mod prompt_cache_tests {
    use super::*;
    use codex_protocol::models::ContentItem;
    use pretty_assertions::assert_eq;

    fn message(role: &str, blocks: Vec<ContentItem>) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.to_string(),
            content: blocks,
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }
    }

    fn request(input: Vec<ResponseItem>) -> ResponsesApiRequest {
        ResponsesApiRequest {
            model: "gpt-5.6-sol".to_string(),
            instructions: "Be exact.".to_string(),
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
            prompt_cache_options: None,
            prompt_cache_breakpoints: Vec::new(),
            text: None,
            client_metadata: None,
        }
    }

    #[test]
    fn an_unmarked_request_serializes_exactly_as_before() {
        let body = encode_responses_request(&request(vec![message(
            "user",
            vec![ContentItem::InputText {
                text: "hi".to_string(),
            }],
        )]))
        .expect("request should encode");

        assert_eq!(body.get("prompt_cache_options"), None);
        let block = &body["input"][0]["content"][0];
        assert_eq!(block.get("prompt_cache_breakpoint"), None);
    }

    #[test]
    fn explicit_mode_stamps_the_named_content_blocks_only() {
        let mut request = request(vec![
            message(
                "developer",
                vec![
                    ContentItem::InputText {
                        text: "instructions".to_string(),
                    },
                    ContentItem::InputText {
                        text: "agents.md".to_string(),
                    },
                ],
            ),
            message(
                "user",
                vec![ContentItem::InputText {
                    text: "do the thing".to_string(),
                }],
            ),
        ]);
        request.prompt_cache_options = Some(PromptCacheOptions {
            mode: PromptCacheMode::Explicit,
        });
        request.prompt_cache_breakpoints = vec![
            PromptCacheBreakpointPosition {
                item: 0,
                content: 1,
            },
            PromptCacheBreakpointPosition {
                item: 1,
                content: 0,
            },
        ];

        let body = encode_responses_request(&request).expect("request should encode");

        assert_eq!(
            body["prompt_cache_options"],
            serde_json::json!({"mode": "explicit"})
        );
        let content = &body["input"][0]["content"];
        assert_eq!(content[0].get("prompt_cache_breakpoint"), None);
        assert_eq!(
            content[1]["prompt_cache_breakpoint"],
            serde_json::json!({"mode": "explicit"})
        );
        assert_eq!(
            body["input"][1]["content"][0]["prompt_cache_breakpoint"],
            serde_json::json!({"mode": "explicit"})
        );
        // The marker is request-only: it must not appear on the typed history item.
        assert_eq!(
            serde_json::to_value(&request.input[0]).expect("item should serialize")["content"][1]
                .get("prompt_cache_breakpoint"),
            None
        );
    }

    #[test]
    fn implicit_mode_still_stamps_the_breakpoints_the_request_carries() {
        // The default path: no `prompt_cache_options`, so the server keeps its automatic
        // latest-message breakpoint *and* honours ours. Encoding must not make the
        // marker conditional on explicit mode.
        let mut request = request(vec![message(
            "developer",
            vec![ContentItem::InputText {
                text: "instructions".to_string(),
            }],
        )]);
        request.prompt_cache_breakpoints = vec![PromptCacheBreakpointPosition {
            item: 0,
            content: 0,
        }];

        let body = encode_responses_request(&request).expect("request should encode");

        assert_eq!(body.get("prompt_cache_options"), None);
        assert_eq!(
            body["input"][0]["content"][0]["prompt_cache_breakpoint"],
            serde_json::json!({"mode": "explicit"})
        );
    }

    #[test]
    fn a_position_that_no_longer_resolves_is_dropped_rather_than_failing() {
        let mut request = request(vec![message(
            "user",
            vec![ContentItem::InputText {
                text: "hi".to_string(),
            }],
        )]);
        request.prompt_cache_breakpoints = vec![
            PromptCacheBreakpointPosition {
                item: 9,
                content: 0,
            },
            PromptCacheBreakpointPosition {
                item: 0,
                content: 7,
            },
        ];

        let body = encode_responses_request(&request).expect("request should encode");

        assert_eq!(
            body["input"][0]["content"][0].get("prompt_cache_breakpoint"),
            None
        );
    }

    #[test]
    fn the_websocket_body_is_stamped_the_same_way() {
        let mut create = ResponseCreateWsRequest::from(&request(vec![message(
            "user",
            vec![ContentItem::InputText {
                text: "hi".to_string(),
            }],
        )]));
        create.prompt_cache_options = Some(PromptCacheOptions {
            mode: PromptCacheMode::Explicit,
        });
        create.prompt_cache_breakpoints = vec![PromptCacheBreakpointPosition {
            item: 0,
            content: 0,
        }];

        let body = encode_responses_ws_request(&ResponsesWsRequest::ResponseCreate(create))
            .expect("request should encode");

        assert_eq!(body["type"], "response.create");
        assert_eq!(
            body["input"][0]["content"][0]["prompt_cache_breakpoint"],
            serde_json::json!({"mode": "explicit"})
        );
    }
}

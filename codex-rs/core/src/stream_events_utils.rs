// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::pin::Pin;
use std::sync::Arc;

use codex_extension_api::ExtensionData;
use codex_protocol::ResponseItemId;
use codex_protocol::config_types::ModeKind;
use codex_protocol::items::TurnItem;
use codex_utils_stream_parser::strip_citations;
use tokio_util::sync::CancellationToken;

use crate::function_tool::FunctionCallError;
use crate::parse_turn_item;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::tools::parallel::ToolCallRuntime;
use crate::tools::router::ToolRouter;
use codex_memories_read::citations::parse_memory_citation;
use codex_memories_read::citations::thread_ids_from_memory_citation;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result;
use codex_protocol::memory_citation::MemoryCitation;
use codex_protocol::models::FunctionCallOutputBody;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::MessagePhase;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::ResponseItem;
use codex_rollout::state_db;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_stream_parser::strip_proposed_plan_blocks;
use futures::Future;
use tracing::debug;
use tracing::instrument;
use tracing::warn;

const GENERATED_IMAGE_ARTIFACTS_DIR: &str = "generated_images";

/// Returns the host-owned default artifact path for a generated image.
pub fn image_generation_artifact_path(
    codex_home: &AbsolutePathBuf,
    session_id: &str,
    call_id: &str,
) -> AbsolutePathBuf {
    let sanitize = |value: &str| {
        let mut sanitized: String = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        if sanitized.is_empty() {
            sanitized = "generated_image".to_string();
        }
        sanitized
    };

    codex_home
        .join(GENERATED_IMAGE_ARTIFACTS_DIR)
        .join(sanitize(session_id))
        .join(format!("{}.png", sanitize(call_id)))
}

fn strip_hidden_assistant_markup(text: &str, plan_mode: bool) -> String {
    let (without_citations, _) = strip_citations(text);
    if plan_mode {
        strip_proposed_plan_blocks(&without_citations)
    } else {
        without_citations
    }
}

fn strip_hidden_assistant_markup_and_parse_memory_citation(
    text: &str,
    plan_mode: bool,
) -> (
    String,
    Option<codex_protocol::memory_citation::MemoryCitation>,
) {
    let (without_citations, citations) = strip_citations(text);
    let visible_text = if plan_mode {
        strip_proposed_plan_blocks(&without_citations)
    } else {
        without_citations
    };
    (visible_text, parse_memory_citation(citations))
}

pub(crate) fn raw_assistant_output_text_from_item(item: &ResponseItem) -> Option<String> {
    if let ResponseItem::Message { role, content, .. } = item
        && role == "assistant"
    {
        let combined = content
            .iter()
            .filter_map(|ci| match ci {
                codex_protocol::models::ContentItem::OutputText { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        return Some(combined);
    }
    None
}

/// Persist a completed model response item and record any cited memory usage.
pub(crate) async fn record_completed_response_item(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
) {
    record_completed_response_item_with_finalized_facts(
        sess,
        turn_context,
        item,
        /*finalized_facts*/ None,
    )
    .await;
}

pub(crate) async fn record_completed_response_item_with_finalized_facts(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
    finalized_facts: Option<&FinalizedTurnItemFacts>,
) {
    sess.record_conversation_items(turn_context, std::slice::from_ref(item))
        .await;
    let defers_mailbox_delivery = finalized_facts.map_or_else(
        || {
            completed_item_defers_mailbox_delivery_to_next_turn(
                item,
                turn_context.mode == ModeKind::Plan,
            )
        },
        |facts| facts.defers_mailbox_delivery_to_next_turn,
    );
    if defers_mailbox_delivery {
        sess.input_queue
            .defer_mailbox_delivery_to_next_turn(&sess.active_turn, &turn_context.sub_id)
            .await;
    }
    mark_thread_memory_mode_polluted_if_external_context(sess, turn_context, item).await;
    let has_memory_citation = if let Some(memory_citation) =
        finalized_facts.and_then(|facts| facts.memory_citation.as_ref())
    {
        record_stage1_output_usage_for_memory_citation(
            sess.services.state_db.as_ref(),
            memory_citation,
        )
        .await
    } else {
        record_stage1_output_usage_and_detect_memory_citation(sess.services.state_db.as_ref(), item)
            .await
    };
    if has_memory_citation {
        sess.record_memory_citation_for_turn(&turn_context.sub_id)
            .await;
    }
}

fn response_item_may_include_external_context(item: &ResponseItem) -> bool {
    matches!(
        item,
        ResponseItem::ToolSearchCall { .. }
            | ResponseItem::ToolSearchOutput { .. }
            | ResponseItem::WebSearchCall { .. }
    )
}

pub(crate) async fn mark_thread_memory_mode_polluted_if_external_context(
    sess: &Session,
    turn_context: &TurnContext,
    item: &ResponseItem,
) {
    if !turn_context.config.memories.disable_on_external_context
        || !response_item_may_include_external_context(item)
    {
        return;
    }
    state_db::mark_thread_memory_mode_polluted(
        sess.services.state_db.as_deref(),
        sess.thread_id,
        "record_completed_response_item",
    )
    .await;
}

/// Rollout-summary slugs referenced by a tool call.
///
/// Summary files are named `<timestamp>-<hash>-<slug>.md`, so the slug is what survives
/// between the stored row and the path the model touched. Only text that names the
/// summaries directory is examined, so ordinary tool calls cost nothing.
pub(crate) fn rollout_summary_slugs_in(text: &str) -> Vec<String> {
    if !text.contains("rollout_summaries") {
        return Vec::new();
    }

    let mut slugs = Vec::new();
    for candidate in text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',')) {
        // Search results append `:<line>:` to the filename, so the name is what precedes
        // `.md` rather than the whole token.
        let Some(stem) = candidate
            .rsplit('/')
            .next()
            .and_then(|name| name.split_once(".md"))
            .map(|(stem, _)| stem)
        else {
            continue;
        };
        // `2026-07-26T13-54-10-yZ1q-<slug>`: six dash-separated fields of timestamp and
        // short hash precede the slug, which is the remainder and may contain dashes.
        let slug = stem.splitn(7, '-').nth(6).unwrap_or_default();
        if !slug.is_empty() && !slugs.iter().any(|existing| existing == slug) {
            slugs.push(slug.to_string());
        }
    }
    slugs
}

/// Text in which a memory retrieval can show itself.
///
/// Both halves of a tool round-trip qualify. A summary the model asks for by name appears
/// in the call; a summary that a search or a listing turned up appears only in the result,
/// and surfacing a memory in a search result is exactly the event openclaw counts as a
/// recall. Watching calls alone missed every retrieval the model did not already know the
/// filename for, which is most of them.
fn memory_retrieval_text(item: &ResponseItem) -> Option<String> {
    match item {
        ResponseItem::FunctionCall { arguments, .. } => Some(arguments.clone()),
        ResponseItem::CustomToolCall { input, .. } => Some(input.clone()),
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => output.body.to_text(),
        _ => None,
    }
}

/// Identifies the retrieval context so repeats can be told apart from fresh interest.
///
/// The text that produced the hit is the closest thing Elpis has to openclaw's query
/// string: re-running the same command returns the same text, while a different question
/// produces different text. Only the digest is stored, so nothing the model read is
/// persisted here.
fn retrieval_query_key(text: &str) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(text.as_bytes());
    format!("{digest:x}")
}

/// Counts a recall when a memory surfaces in a tool call or its result.
///
/// Citations alone almost never fire, so before this the recall counts feeding promotion
/// stayed at zero and nothing could ever become durable.
pub(crate) async fn record_stage1_output_usage_for_retrieval(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    items: &[ResponseItem],
) {
    let Some(db) = state_db_ctx else {
        return;
    };

    for item in items {
        let Some(text) = memory_retrieval_text(item) else {
            continue;
        };
        let slugs = rollout_summary_slugs_in(&text);
        if slugs.is_empty() {
            continue;
        }
        let Ok(thread_ids) = db.memories().thread_ids_for_rollout_slugs(&slugs).await else {
            continue;
        };
        if thread_ids.is_empty() {
            continue;
        }
        let _ = db
            .memories()
            .record_stage1_output_usage(&thread_ids, Some(&retrieval_query_key(&text)))
            .await;
    }
}

async fn record_stage1_output_usage_and_detect_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    item: &ResponseItem,
) -> bool {
    let Some(raw_text) = raw_assistant_output_text_from_item(item) else {
        return false;
    };

    let (_, citations) = strip_citations(&raw_text);
    let Some(memory_citation) = parse_memory_citation(citations) else {
        return false;
    };
    record_stage1_output_usage_for_memory_citation(state_db_ctx, &memory_citation).await
}

async fn record_stage1_output_usage_for_memory_citation(
    state_db_ctx: Option<&state_db::StateDbHandle>,
    memory_citation: &MemoryCitation,
) -> bool {
    let thread_ids = thread_ids_from_memory_citation(memory_citation);
    if thread_ids.is_empty() {
        return true;
    }

    if let Some(db) = state_db_ctx {
        // What the model cited is the retrieval context here; two answers leaning on the
        // same memory for the same reason on one day are one recall, not two.
        let cited = memory_citation.rollout_ids.join("\n");
        let _ = db
            .memories()
            .record_stage1_output_usage(&thread_ids, Some(&retrieval_query_key(&cited)))
            .await;
    }
    true
}

/// Handle a completed output item from the model stream, recording it and
/// queuing any tool execution futures. This records items immediately so
/// history and rollout stay in sync even if the turn is later cancelled.
pub(crate) type InFlightFuture<'f> =
    Pin<Box<dyn Future<Output = Result<ResponseInputItem>> + Send + 'f>>;

#[derive(Default)]
pub(crate) struct OutputItemResult {
    pub last_agent_message: Option<String>,
    pub needs_follow_up: bool,
    pub tool_future: Option<InFlightFuture<'static>>,
}

pub(crate) struct HandleOutputCtx {
    pub sess: Arc<Session>,
    pub turn_context: Arc<TurnContext>,
    pub turn_store: Arc<ExtensionData>,
    pub tool_runtime: ToolCallRuntime,
    pub cancellation_token: CancellationToken,
}

pub(crate) async fn apply_turn_item_contributors(
    sess: &Session,
    turn_store: &ExtensionData,
    item: &mut TurnItem,
) {
    let contributors = sess.services.extensions.turn_item_contributors().to_vec();
    for contributor in contributors {
        if let Err(err) = contributor
            .contribute(&sess.services.thread_extension_data, turn_store, item)
            .await
        {
            warn!("turn item contributor failed: {err}");
        }
    }
}

pub(crate) enum TurnItemContributorPolicy<'a> {
    Skip,
    Run(&'a ExtensionData),
}

pub(crate) struct FinalizedTurnItem {
    pub(crate) turn_item: TurnItem,
    pub(crate) facts: FinalizedTurnItemFacts,
}

#[derive(Clone, Default)]
pub(crate) struct FinalizedTurnItemFacts {
    pub(crate) memory_citation: Option<MemoryCitation>,
    pub(crate) last_agent_message: Option<String>,
    pub(crate) defers_mailbox_delivery_to_next_turn: bool,
}

pub(crate) async fn finalize_non_tool_response_item(
    sess: &Session,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<FinalizedTurnItem> {
    let turn_item =
        handle_non_tool_response_item(sess, contributor_policy, item, plan_mode).await?;
    let (memory_citation, last_agent_message, defers_mailbox_delivery_to_next_turn) =
        match &turn_item {
            TurnItem::AgentMessage(agent_message) => {
                let combined = agent_message
                    .content
                    .iter()
                    .map(|entry| match entry {
                        codex_protocol::items::AgentMessageContent::Text { text } => text.as_str(),
                    })
                    .collect::<String>();
                let last_agent_message = if combined.trim().is_empty() {
                    None
                } else {
                    Some(combined)
                };
                let defers_mailbox_delivery_to_next_turn =
                    !matches!(agent_message.phase, Some(MessagePhase::Commentary))
                        && last_agent_message.is_some();
                (
                    agent_message.memory_citation.clone(),
                    last_agent_message,
                    defers_mailbox_delivery_to_next_turn,
                )
            }
            _ => (None, None, false),
        };
    Some(FinalizedTurnItem {
        turn_item,
        facts: FinalizedTurnItemFacts {
            memory_citation,
            last_agent_message,
            defers_mailbox_delivery_to_next_turn,
        },
    })
}

#[instrument(level = "trace", skip_all)]
pub(crate) async fn handle_output_item_done(
    ctx: &mut HandleOutputCtx,
    item: ResponseItem,
    previously_active_item: Option<TurnItem>,
) -> Result<OutputItemResult> {
    let mut output = OutputItemResult::default();
    let plan_mode = ctx.turn_context.mode == ModeKind::Plan;

    match ToolRouter::build_tool_call(item.clone()) {
        // The model emitted a tool call; log it, persist the item immediately, and queue the tool execution.
        Ok(Some(call)) => {
            ctx.sess
                .input_queue
                .accept_mailbox_delivery_for_current_turn(
                    &ctx.sess.active_turn,
                    &ctx.turn_context.sub_id,
                )
                .await;

            let payload_preview = call.payload.log_payload().into_owned();
            tracing::info!(
                thread_id = %ctx.sess.thread_id,
                "ToolCall: {} {}",
                call.tool_name,
                payload_preview
            );

            record_completed_response_item(ctx.sess.as_ref(), ctx.turn_context.as_ref(), &item)
                .await;

            let cancellation_token = ctx.cancellation_token.child_token();
            let tool_future: InFlightFuture<'static> = Box::pin(
                ctx.tool_runtime
                    .clone()
                    .handle_tool_call(call, cancellation_token),
            );

            output.needs_follow_up = true;
            output.tool_future = Some(tool_future);
        }
        // No tool call: convert messages/reasoning into turn items and mark them as complete.
        Ok(None) => {
            let finalized_turn_item = finalize_non_tool_response_item(
                ctx.sess.as_ref(),
                TurnItemContributorPolicy::Run(ctx.turn_store.as_ref()),
                &item,
                plan_mode,
            )
            .await;
            let finalized_facts = finalized_turn_item
                .as_ref()
                .map(|finalized| finalized.facts.clone());
            if let Some(finalized_turn_item) = finalized_turn_item {
                if previously_active_item.is_none() {
                    ctx.sess
                        .emit_turn_item_started(&ctx.turn_context, &finalized_turn_item.turn_item)
                        .await;
                }

                ctx.sess
                    .emit_turn_item_completed(&ctx.turn_context, finalized_turn_item.turn_item)
                    .await;
            }
            record_completed_response_item_with_finalized_facts(
                ctx.sess.as_ref(),
                ctx.turn_context.as_ref(),
                &item,
                finalized_facts.as_ref(),
            )
            .await;

            output.last_agent_message = finalized_facts.and_then(|facts| facts.last_agent_message);
        }
        // The tool request should be answered directly (or was denied); push that response into the transcript.
        Err(FunctionCallError::RespondToModel(message)) => {
            let response = ResponseInputItem::FunctionCallOutput {
                call_id: String::new(),
                output: FunctionCallOutputPayload {
                    body: FunctionCallOutputBody::Text(message),
                    ..Default::default()
                },
            };
            record_completed_response_item(ctx.sess.as_ref(), ctx.turn_context.as_ref(), &item)
                .await;
            if let Some(response_item) = response_input_to_response_item(&response) {
                ctx.sess
                    .record_conversation_items(
                        &ctx.turn_context,
                        std::slice::from_ref(&response_item),
                    )
                    .await;
            }

            output.needs_follow_up = true;
        }
        // A fatal error occurred; surface it back into history.
        Err(FunctionCallError::Fatal(message)) => {
            return Err(CodexErr::Fatal(message));
        }
    }

    Ok(output)
}

pub(crate) async fn handle_non_tool_response_item(
    sess: &Session,
    contributor_policy: TurnItemContributorPolicy<'_>,
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<TurnItem> {
    let item_type = match item {
        ResponseItem::AdditionalTools { .. } => "additional_tools",
        ResponseItem::Message { .. } => "message",
        ResponseItem::AgentMessage { .. } => "agent_message",
        ResponseItem::Reasoning { .. } => "reasoning",
        ResponseItem::LocalShellCall { .. } => "local_shell_call",
        ResponseItem::FunctionCall { .. } => "function_call",
        ResponseItem::ToolSearchCall { .. } => "tool_search_call",
        ResponseItem::FunctionCallOutput { .. } => "function_call_output",
        ResponseItem::CustomToolCall { .. } => "custom_tool_call",
        ResponseItem::CustomToolCallOutput { .. } => "custom_tool_call_output",
        ResponseItem::ToolSearchOutput { .. } => "tool_search_output",
        ResponseItem::WebSearchCall { .. } => "web_search_call",
        ResponseItem::ImageGenerationCall { .. } => "image_generation_call",
        ResponseItem::Compaction { .. } => "compaction",
        ResponseItem::CompactionTrigger { .. } => "compaction_trigger",
        ResponseItem::ContextCompaction { .. } => "context_compaction",
        ResponseItem::Other => "other",
    };
    debug!(
        item_type,
        item_id = item.id().map(ResponseItemId::as_str),
        "Output item"
    );

    match item {
        ResponseItem::Message { .. }
        | ResponseItem::Reasoning { .. }
        | ResponseItem::WebSearchCall { .. } => {
            let mut turn_item = parse_turn_item(item)?;
            finalize_turn_item(sess, contributor_policy, &mut turn_item, plan_mode).await;
            Some(turn_item)
        }
        ResponseItem::FunctionCallOutput { .. }
        | ResponseItem::CustomToolCallOutput { .. }
        | ResponseItem::ToolSearchOutput { .. } => {
            debug!("unexpected tool output from stream");
            None
        }
        _ => None,
    }
}

pub(crate) async fn finalize_turn_item(
    sess: &Session,
    contributor_policy: TurnItemContributorPolicy<'_>,
    turn_item: &mut TurnItem,
    plan_mode: bool,
) {
    if let TurnItemContributorPolicy::Run(turn_store) = contributor_policy {
        apply_turn_item_contributors(sess, turn_store, turn_item).await;
    }
    if let TurnItem::AgentMessage(agent_message) = &mut *turn_item {
        let combined = agent_message
            .content
            .iter()
            .map(|entry| match entry {
                codex_protocol::items::AgentMessageContent::Text { text } => text.as_str(),
            })
            .collect::<String>();
        let (stripped, memory_citation) =
            strip_hidden_assistant_markup_and_parse_memory_citation(&combined, plan_mode);
        agent_message.content =
            vec![codex_protocol::items::AgentMessageContent::Text { text: stripped }];
        if agent_message.memory_citation.is_none() {
            agent_message.memory_citation = memory_citation;
        }
    }
}

pub(crate) fn last_assistant_message_from_item(
    item: &ResponseItem,
    plan_mode: bool,
) -> Option<String> {
    if let Some(combined) = raw_assistant_output_text_from_item(item) {
        if combined.is_empty() {
            return None;
        }
        let stripped = strip_hidden_assistant_markup(&combined, plan_mode);
        if stripped.trim().is_empty() {
            return None;
        }
        return Some(stripped);
    }
    None
}

fn completed_item_defers_mailbox_delivery_to_next_turn(
    item: &ResponseItem,
    plan_mode: bool,
) -> bool {
    match item {
        ResponseItem::Message { role, phase, .. } => {
            if role != "assistant" || matches!(phase, Some(MessagePhase::Commentary)) {
                return false;
            }
            // Treat `None` like final-answer text so untagged providers default
            // to the safer "defer mailbox mail" behavior.
            last_assistant_message_from_item(item, plan_mode).is_some()
        }
        _ => false,
    }
}

pub(crate) fn response_input_to_response_item(input: &ResponseInputItem) -> Option<ResponseItem> {
    match input {
        ResponseInputItem::FunctionCallOutput { call_id, output } => {
            Some(ResponseItem::FunctionCallOutput {
                id: None,
                call_id: call_id.clone(),
                output: output.clone(),
                internal_chat_message_metadata_passthrough: None,
            })
        }
        ResponseInputItem::CustomToolCallOutput {
            call_id,
            name,
            output,
        } => Some(ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: call_id.clone(),
            name: name.clone(),
            output: output.clone(),
            internal_chat_message_metadata_passthrough: None,
        }),
        ResponseInputItem::McpToolCallOutput { call_id, output } => {
            let output = output.as_function_call_output_payload();
            Some(ResponseItem::FunctionCallOutput {
                id: None,
                call_id: call_id.clone(),
                output,
                internal_chat_message_metadata_passthrough: None,
            })
        }
        ResponseInputItem::ToolSearchOutput {
            call_id,
            status,
            execution,
            tools,
        } => Some(ResponseItem::ToolSearchOutput {
            id: None,
            call_id: Some(call_id.clone()),
            status: status.clone(),
            execution: execution.clone(),
            tools: tools.clone(),
            internal_chat_message_metadata_passthrough: None,
        }),
        _ => None,
    }
}

#[cfg(test)]
#[path = "stream_events_utils_tests.rs"]
mod tests;

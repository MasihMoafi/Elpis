// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use crate::Prompt;
use crate::client::ModelClientSession;
use crate::client_common::ResponseEvent;
use crate::compaction_kinds::CompactionImplementation;
use crate::compaction_kinds::CompactionPhase;
use crate::compaction_kinds::CompactionReason;
use crate::compaction_kinds::CompactionTrigger;
use crate::context::world_state::WorldState;
use crate::hook_runtime::PostCompactHookOutcome;
use crate::hook_runtime::PreCompactHookOutcome;
use crate::hook_runtime::run_post_compact_hooks;
use crate::hook_runtime::run_pre_compact_hooks;
use crate::responses_metadata::CodexResponsesMetadata;
use crate::responses_metadata::CodexResponsesRequestKind;
use crate::responses_metadata::CompactionTurnMetadata;
#[cfg(test)]
use crate::session::PreviousTurnSettings;
use crate::session::session::Session;
use crate::session::turn::get_last_assistant_message_from_turn;
use crate::session::turn_context::TurnContext;
use crate::util::backoff;
use codex_protocol::error::CodexErr;
use codex_protocol::error::Result as CodexResult;
use codex_protocol::items::ContextCompactionItem;
use codex_protocol::items::TurnItem;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::InternalChatMessageMetadataPassthrough;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::CompactedItem;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::RawResponseCompletedEvent;
use codex_protocol::protocol::TurnStartedEvent;
use codex_protocol::protocol::WarningEvent;
use codex_protocol::user_input::UserInput;
use codex_rollout_trace::InferenceTraceContext;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::approx_token_count;
use codex_utils_output_truncation::truncate_text;
use futures::prelude::*;
use tracing::error;

use codex_model_provider_info::ModelProviderInfo;

pub use codex_prompts::CLEANUP_PROMPT;
pub use codex_prompts::SUMMARIZATION_PROMPT;
pub use codex_prompts::SUMMARY_PREFIX;
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;

/// Controls whether compaction replacement history must include initial context.
///
/// Pre-turn/manual compaction variants use `DoNotInject`: they replace history with a summary and
/// clear `reference_context_item`, so the next regular turn will fully reinject initial context
/// after compaction.
///
/// Mid-turn compaction must use `BeforeLastUserMessage` because the model is trained to see the
/// compaction summary as the last item in history after mid-turn compaction; we therefore inject
/// initial context into the replacement history just above the last real user message.
#[derive(Debug)]
pub(crate) enum InitialContextInjection {
    BeforeLastUserMessage(Arc<WorldState>),
    DoNotInject,
}

pub(crate) async fn build_compaction_initial_context(
    sess: &Session,
    turn_context: &TurnContext,
    initial_context_injection: &InitialContextInjection,
) -> (Vec<ResponseItem>, Option<Arc<WorldState>>) {
    // Return the rendered state with its items so history and its baseline stay identical.
    match initial_context_injection {
        InitialContextInjection::BeforeLastUserMessage(world_state) => {
            let items = sess
                .build_initial_context_with_world_state(turn_context, world_state.as_ref())
                .await;
            (items, Some(Arc::clone(world_state)))
        }
        InitialContextInjection::DoNotInject => (Vec::new(), None),
    }
}

pub(crate) fn should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool {
    provider.supports_remote_compaction()
}

pub(crate) async fn run_inline_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    initial_context_injection: InitialContextInjection,
    reason: CompactionReason,
    phase: CompactionPhase,
) -> CodexResult<()> {
    let prompt = turn_context
        .config
        .compact_prompt
        .as_deref()
        .unwrap_or(SUMMARIZATION_PROMPT)
        .to_string();
    let input = vec![UserInput::Text {
        text: prompt,
        // Compaction prompt is synthesized; no UI element ranges to preserve.
        text_elements: Vec::new(),
    }];

    run_compact_task_inner(
        sess,
        turn_context,
        input,
        initial_context_injection,
        CompactionTrigger::Auto,
        reason,
        phase,
    )
    .await?;
    Ok(())
}

pub(crate) async fn run_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
) -> CodexResult<()> {
    let start_event = EventMsg::TurnStarted(TurnStartedEvent {
        turn_id: turn_context.sub_id.clone(),
        trace_id: turn_context.trace_id.clone(),
        started_at: turn_context.turn_timing_state.started_at_unix_secs().await,
        model_context_window: turn_context.model_context_window(),
        collaboration_mode_kind: turn_context.mode,
    });
    sess.send_event(&turn_context, start_event).await;
    if !turn_context
        .config
        .features
        .enabled(codex_features::Feature::ElpisCompactCleanup)
        || turn_context
            .config
            .compact_prompt
            .as_deref()
            .is_some_and(|prompt| prompt != CLEANUP_PROMPT)
    {
        run_compact_task_inner(
            sess,
            turn_context,
            input,
            InitialContextInjection::DoNotInject,
            CompactionTrigger::Manual,
            CompactionReason::UserRequested,
            CompactionPhase::StandaloneTurn,
        )
        .await?;
        return Ok(());
    }
    run_cleanup_compact_task(sess, turn_context).await
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CleanupCandidate {
    id: String,
    item_index: usize,
    role: String,
    text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct CleanupRecord {
    delete_item_indices: HashSet<usize>,
}

fn cleanup_candidates(items: &[ResponseItem]) -> Vec<CleanupCandidate> {
    let protected_recent_start = items.iter().rposition(is_cleanup_user_message).unwrap_or(0);

    items[..protected_recent_start]
        .iter()
        .enumerate()
        .filter_map(|(item_index, item)| {
            let ResponseItem::Message { role, content, .. } = item else {
                return None;
            };
            if role != "assistant" && !(role == "user" && is_cleanup_user_message(item)) {
                return None;
            }
            let text = content_items_to_text(content)?;
            if text.trim().is_empty() || is_summary_message(&text) {
                return None;
            }
            Some((item_index, role.clone(), text))
        })
        .enumerate()
        .map(
            |(candidate_index, (item_index, role, text))| CleanupCandidate {
                id: format!("m{candidate_index}"),
                item_index,
                role,
                text,
            },
        )
        .collect()
}

fn cleanup_input(items: &[ResponseItem], candidates: &[CleanupCandidate]) -> String {
    let protected_recent_start = items
        .iter()
        .rposition(is_cleanup_user_message)
        .unwrap_or(items.len());
    let candidate_json = candidates
        .iter()
        .map(|candidate| {
            serde_json::json!({
                "id": candidate.id,
                "role": candidate.role,
                "text": candidate.text,
            })
        })
        .collect::<Vec<_>>();
    let protected_recent_context = items[protected_recent_start..]
        .iter()
        .filter_map(|item| {
            let ResponseItem::Message { role, content, .. } = item else {
                return None;
            };
            matches!(role.as_str(), "user" | "assistant").then(|| {
                content_items_to_text(content).map(|text| {
                    serde_json::json!({
                        "role": role,
                        "text": text,
                    })
                })
            })?
        })
        .collect::<Vec<_>>();
    serde_json::to_string_pretty(&serde_json::json!({
        "candidates": candidate_json,
        "protected_recent_context": protected_recent_context,
    }))
    .expect("cleanup input should serialize")
}

fn parse_cleanup_record(raw: &str, candidates: &[CleanupCandidate]) -> Option<CleanupRecord> {
    if candidates.is_empty() {
        return None;
    }
    let known = candidates
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate.item_index))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut delete_item_indices = HashSet::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (id, action) = line.split_once(':')?;
        let id = id.trim();
        let item_index = *known.get(id)?;
        if !seen.insert(id) {
            return None;
        }
        match action.trim() {
            "KEEP" => {}
            "DELETE" => {
                delete_item_indices.insert(item_index);
            }
            _ => return None,
        }
    }
    (seen.len() == candidates.len()).then_some(CleanupRecord {
        delete_item_indices,
    })
}

fn build_cleanup_replacement(items: &[ResponseItem], record: &CleanupRecord) -> Vec<ResponseItem> {
    items
        .iter()
        .enumerate()
        .filter(|(item_index, item)| {
            if record.delete_item_indices.contains(item_index) {
                return false;
            }
            match item {
                ResponseItem::Message { role, .. } if role == "user" => matches!(
                    crate::event_mapping::parse_turn_item(item),
                    Some(TurnItem::UserMessage(_) | TurnItem::HookPrompt(_))
                ),
                ResponseItem::Message { role, .. }
                    if matches!(role.as_str(), "system" | "developer") =>
                {
                    false
                }
                _ => true,
            }
        })
        .map(|(_, item)| item.clone())
        .collect()
}

fn is_cleanup_user_message(item: &ResponseItem) -> bool {
    matches!(
        crate::event_mapping::parse_turn_item(item),
        Some(TurnItem::UserMessage(_))
    )
}

async fn run_cleanup_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()> {
    let trigger = CompactionTrigger::Manual;
    let pre_compact_outcome = run_pre_compact_hooks(&sess, &turn_context, trigger).await;
    if let PreCompactHookOutcome::Stopped = pre_compact_outcome {
        return Err(CodexErr::TurnAborted);
    }

    let compaction_item = TurnItem::ContextCompaction(ContextCompactionItem::new());
    sess.emit_turn_item_started(&turn_context, &compaction_item)
        .await;

    // Tool evidence already has a conservative, audited cleanup path. Reuse it before
    // considering conversation messages so the cleanup model never rewrites tool output.
    crate::session::context_prune::run_manual_context_prune(&sess, &turn_context).await;

    let history = sess.clone_history().await;
    let items = history.raw_items();
    let candidates = cleanup_candidates(items);
    let record = run_cleanup_pass(&sess, &turn_context, items, &candidates).await;

    let Some(record) = record else {
        sess.emit_turn_item_completed(&turn_context, compaction_item)
            .await;
        sess.send_event(
            &turn_context,
            EventMsg::Warning(WarningEvent {
                message: "Context cleanup kept the conversation unchanged because no safe, valid deletion plan was available.".to_string(),
            }),
        )
        .await;
        if let PostCompactHookOutcome::Stopped =
            run_post_compact_hooks(&sess, &turn_context, trigger).await
        {
            return Err(CodexErr::TurnAborted);
        }
        return Ok(());
    };

    if record.delete_item_indices.is_empty() {
        sess.emit_turn_item_completed(&turn_context, compaction_item)
            .await;
        sess.send_event(
            &turn_context,
            EventMsg::Warning(WarningEvent {
                message: "Context cleanup found no conversation messages safe to remove."
                    .to_string(),
            }),
        )
        .await;
        if let PostCompactHookOutcome::Stopped =
            run_post_compact_hooks(&sess, &turn_context, trigger).await
        {
            return Err(CodexErr::TurnAborted);
        }
        return Ok(());
    }

    let new_history = build_cleanup_replacement(items, &record);
    let removed_count = record.delete_item_indices.len();
    let (window_number, window_ids) = sess.advance_auto_compact_window().await;
    let checkpoint_message = format!("elpis.context-cleanup.v1:removed_messages={removed_count}");
    sess.replace_compacted_history(
        turn_context.as_ref(),
        new_history.clone(),
        None,
        None,
        CompactedItem {
            message: checkpoint_message,
            replacement_history: Some(new_history),
            window_number: Some(window_number),
            first_window_id: Some(window_ids.first_window_id.to_string()),
            previous_window_id: window_ids.previous_window_id.map(|id| id.to_string()),
            window_id: Some(window_ids.window_id.to_string()),
        },
    )
    .await;
    sess.recompute_token_usage(&turn_context).await;
    sess.emit_turn_item_completed(&turn_context, compaction_item)
        .await;
    sess.send_event(
        &turn_context,
        EventMsg::Warning(WarningEvent {
            message: format!(
                "Context cleanup removed {removed_count} redundant conversation message(s); protected and uncertain content stayed verbatim."
            ),
        }),
    )
    .await;
    if let PostCompactHookOutcome::Stopped =
        run_post_compact_hooks(&sess, &turn_context, trigger).await
    {
        return Err(CodexErr::TurnAborted);
    }
    Ok(())
}

async fn run_cleanup_pass(
    sess: &Session,
    turn_context: &TurnContext,
    items: &[ResponseItem],
    candidates: &[CleanupCandidate],
) -> Option<CleanupRecord> {
    if candidates.is_empty() {
        return None;
    }
    let input = cleanup_input(items, candidates);
    let primary_slug =
        if turn_context.config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID {
            crate::context_pruner::PRUNE_MODEL_SLUG
        } else {
            turn_context.model_info.slug.as_str()
        };
    let mut client_session = sess.services.model_client.new_session();
    if let Some(record) = try_cleanup_pass(
        sess,
        turn_context,
        &mut client_session,
        candidates,
        &input,
        primary_slug,
    )
    .await
    {
        return Some(record);
    }

    let fallback_slug = turn_context.model_info.slug.as_str();
    if primary_slug == fallback_slug {
        return None;
    }
    try_cleanup_pass(
        sess,
        turn_context,
        &mut client_session,
        candidates,
        &input,
        fallback_slug,
    )
    .await
}

async fn try_cleanup_pass(
    sess: &Session,
    turn_context: &TurnContext,
    client_session: &mut ModelClientSession,
    candidates: &[CleanupCandidate],
    input: &str,
    model_slug: &str,
) -> Option<CleanupRecord> {
    let model_info = sess
        .services
        .models_manager
        .get_model_info(model_slug, &turn_context.config.to_models_manager_config())
        .await;
    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: input.to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: CLEANUP_PROMPT.to_string(),
        },
        ..Default::default()
    };
    let compaction_metadata = CompactionTurnMetadata::new(
        CompactionTrigger::Manual,
        CompactionReason::UserRequested,
        CompactionImplementation::Responses,
        CompactionPhase::StandaloneTurn,
    );
    let responses_metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "context-cleanup".to_string(),
        CodexResponsesRequestKind::Compaction(compaction_metadata),
    );
    let mut stream = match client_session
        .stream(
            &prompt,
            &model_info,
            &turn_context.session_telemetry,
            Some(ReasoningEffort::Max),
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            &responses_metadata,
            &InferenceTraceContext::disabled(),
        )
        .await
    {
        Ok(stream) => stream,
        Err(err) => {
            tracing::warn!("Context cleanup stream failed for model {model_slug}: {err}");
            return None;
        }
    };

    let mut collected = Vec::new();
    let mut streamed_text = String::new();
    loop {
        match stream.next().await {
            Some(Ok(ResponseEvent::OutputItemDone(item))) => collected.push(item),
            Some(Ok(ResponseEvent::OutputTextDelta(delta))) => streamed_text.push_str(&delta),
            Some(Ok(ResponseEvent::Completed { .. })) => break,
            Some(Ok(_)) => continue,
            Some(Err(err)) => {
                tracing::warn!("Context cleanup stream failed for model {model_slug}: {err}");
                return None;
            }
            None => break,
        }
    }
    let output = get_last_assistant_message_from_turn(&collected)
        .or_else(|| (!streamed_text.trim().is_empty()).then_some(streamed_text));
    let output = output?;
    let record = parse_cleanup_record(&output, candidates);
    if record.is_none() {
        tracing::warn!(
            "Context cleanup response was malformed for model {model_slug}; preserving conversation history"
        );
    }
    record
}

async fn run_compact_task_inner(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
    initial_context_injection: InitialContextInjection,
    trigger: CompactionTrigger,
    reason: CompactionReason,
    phase: CompactionPhase,
) -> CodexResult<()> {
    let compaction_metadata =
        CompactionTurnMetadata::new(trigger, reason, CompactionImplementation::Responses, phase);
    let pre_compact_outcome = run_pre_compact_hooks(&sess, &turn_context, trigger).await;
    match pre_compact_outcome {
        PreCompactHookOutcome::Continue => {}
        PreCompactHookOutcome::Stopped => {
            return Err(CodexErr::TurnAborted);
        }
    }
    let result = run_compact_task_inner_impl(
        Arc::clone(&sess),
        Arc::clone(&turn_context),
        input,
        initial_context_injection,
        compaction_metadata,
    )
    .await;
    if result.is_ok() {
        let post_compact_outcome = run_post_compact_hooks(&sess, &turn_context, trigger).await;
        if let PostCompactHookOutcome::Stopped = post_compact_outcome {
            return Err(CodexErr::TurnAborted);
        }
    }
    result.map(|_| ())
}

async fn run_compact_task_inner_impl(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
    initial_context_injection: InitialContextInjection,
    compaction_metadata: CompactionTurnMetadata,
) -> CodexResult<String> {
    let compaction_item = TurnItem::ContextCompaction(ContextCompactionItem::new());
    sess.emit_turn_item_started(&turn_context, &compaction_item)
        .await;
    let initial_input_for_turn: ResponseInputItem = ResponseInputItem::from(input);

    let mut history = sess.clone_history().await;
    history.record_items(
        &[initial_input_for_turn.into()],
        turn_context.model_info.truncation_policy.into(),
    );

    let max_retries = turn_context.provider.info().stream_max_retries();
    let mut retries = 0;
    let mut client_session = sess.services.model_client.new_session();
    // Reuse one client session so turn-scoped state (sticky routing, websocket incremental
    // request tracking)
    // survives retries within this compact turn.
    let window_id = sess.current_window_id().await;
    let responses_metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        window_id,
        CodexResponsesRequestKind::Compaction(compaction_metadata),
    );

    loop {
        // Clone is required because of the loop
        let turn_input = history
            .clone()
            .for_prompt(&turn_context.model_info.input_modalities);
        let turn_input_len = turn_input.len();
        let prompt = Prompt {
            input: turn_input,
            base_instructions: sess.get_base_instructions().await,
            ..Default::default()
        };
        let attempt_result = drain_to_completed(
            &sess,
            turn_context.as_ref(),
            &mut client_session,
            &responses_metadata,
            &prompt,
        )
        .await;

        match attempt_result {
            Ok(()) => {
                break;
            }
            Err(err @ (CodexErr::Interrupted | CodexErr::TurnAborted)) => {
                return Err(err);
            }
            Err(e @ CodexErr::SessionBudgetExceeded) => {
                let event = EventMsg::Error(e.to_error_event(/*message_prefix*/ None));
                sess.send_event(&turn_context, event).await;
                return Err(e);
            }
            Err(e @ CodexErr::ContextWindowExceeded) => {
                if turn_input_len > 1 {
                    // Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.
                    error!(
                        "Context window exceeded while compacting; removing oldest history item. Error: {e}"
                    );
                    history.remove_first_item();
                    retries = 0;
                    continue;
                }
                sess.set_total_tokens_full(turn_context.as_ref()).await;
                let event = EventMsg::Error(e.to_error_event(/*message_prefix*/ None));
                sess.send_event(&turn_context, event).await;
                return Err(e);
            }
            Err(e) => {
                if retries < max_retries {
                    retries += 1;
                    let delay = backoff(retries);
                    sess.notify_stream_error(
                        turn_context.as_ref(),
                        format!("Reconnecting... {retries}/{max_retries}"),
                        e,
                    )
                    .await;
                    tokio::time::sleep(delay).await;
                    continue;
                } else {
                    let event = EventMsg::Error(e.to_error_event(/*message_prefix*/ None));
                    sess.send_event(&turn_context, event).await;
                    return Err(e);
                }
            }
        }
    }

    let history_snapshot = sess.clone_history().await;
    let history_items = history_snapshot.raw_items();
    let summary_suffix = get_last_assistant_message_from_turn(history_items).unwrap_or_default();
    let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}");
    let user_messages = collect_user_messages(history_items);

    let mut new_history = build_compacted_history(Vec::new(), &user_messages, &summary_text);
    if let Some(summary_item) = new_history.last_mut() {
        // This replacement history skips `record_conversation_items`; only the appended summary
        // belongs to this compaction turn.
        summary_item.set_turn_id_if_missing(&turn_context.sub_id);
    }
    let (window_number, window_ids) = sess.advance_auto_compact_window().await;

    let (initial_context, world_state_baseline) = build_compaction_initial_context(
        sess.as_ref(),
        turn_context.as_ref(),
        &initial_context_injection,
    )
    .await;
    if !initial_context.is_empty() {
        new_history =
            insert_initial_context_before_last_real_user_or_summary(new_history, initial_context);
    }
    let reference_context_item = match initial_context_injection {
        InitialContextInjection::DoNotInject => None,
        InitialContextInjection::BeforeLastUserMessage(_) => {
            Some(turn_context.to_turn_context_item())
        }
    };
    let compacted_item = CompactedItem {
        message: summary_text.clone(),
        replacement_history: Some(new_history.clone()),
        window_number: Some(window_number),
        first_window_id: Some(window_ids.first_window_id.to_string()),
        previous_window_id: window_ids.previous_window_id.map(|id| id.to_string()),
        window_id: Some(window_ids.window_id.to_string()),
    };
    sess.replace_compacted_history(
        turn_context.as_ref(),
        new_history,
        reference_context_item,
        world_state_baseline,
        compacted_item,
    )
    .await;
    sess.recompute_token_usage(&turn_context).await;

    sess.emit_turn_item_completed(&turn_context, compaction_item)
        .await;
    let warning = EventMsg::Warning(WarningEvent {
        message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.".to_string(),
    });
    sess.send_event(&turn_context, warning).await;
    Ok(summary_suffix)
}

pub fn content_items_to_text(content: &[ContentItem]) -> Option<String> {
    let mut pieces = Vec::new();
    for item in content {
        match item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                if !text.is_empty() {
                    pieces.push(text.as_str());
                }
            }
            ContentItem::InputImage { .. } => {}
        }
    }
    if pieces.is_empty() {
        None
    } else {
        Some(pieces.join("\n"))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CompactedUserMessage {
    message: String,
    internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
}

pub(crate) fn collect_user_messages(items: &[ResponseItem]) -> Vec<CompactedUserMessage> {
    items
        .iter()
        .filter_map(|item| match crate::event_mapping::parse_turn_item(item) {
            Some(TurnItem::UserMessage(user)) => {
                if is_summary_message(&user.message()) {
                    None
                } else {
                    Some(CompactedUserMessage {
                        message: user.message(),
                        internal_chat_message_metadata_passthrough: match item {
                            ResponseItem::Message {
                                internal_chat_message_metadata_passthrough,
                                ..
                            } => internal_chat_message_metadata_passthrough.clone(),
                            _ => None,
                        },
                    })
                }
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn is_summary_message(message: &str) -> bool {
    message.starts_with(format!("{SUMMARY_PREFIX}\n").as_str())
}

/// Inserts canonical initial context into compacted replacement history at the
/// model-expected boundary.
///
/// Placement rules:
/// - Prefer immediately before the last real user message.
/// - If no real user messages remain, insert before the compaction summary so
///   the summary stays last.
/// - If there are no user messages, insert before the last compaction item so
///   that item remains last (remote compaction may return only compaction items).
/// - If there are no user messages or compaction items, append the context.
pub(crate) fn insert_initial_context_before_last_real_user_or_summary(
    mut compacted_history: Vec<ResponseItem>,
    initial_context: Vec<ResponseItem>,
) -> Vec<ResponseItem> {
    let mut last_user_or_summary_index = None;
    let mut last_real_user_index = None;
    for (i, item) in compacted_history.iter().enumerate().rev() {
        let Some(TurnItem::UserMessage(user)) = crate::event_mapping::parse_turn_item(item) else {
            continue;
        };
        // Compaction summaries are encoded as user messages, so track both:
        // the last real user message (preferred insertion point) and the last
        // user-message-like item (fallback summary insertion point).
        last_user_or_summary_index.get_or_insert(i);
        if !is_summary_message(&user.message()) {
            last_real_user_index = Some(i);
            break;
        }
    }
    let last_compaction_index = compacted_history
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, item)| {
            matches!(
                item,
                ResponseItem::Compaction { .. } | ResponseItem::ContextCompaction { .. }
            )
            .then_some(i)
        });
    let insertion_index = last_real_user_index
        .or(last_user_or_summary_index)
        .or(last_compaction_index);

    // Re-inject canonical context from the current session since we stripped it
    // from the pre-compaction history. Prefer placing it before the last real
    // user message; if there is no real user message left, place it before the
    // summary or compaction item so the compaction item remains last.
    if let Some(insertion_index) = insertion_index {
        compacted_history.splice(insertion_index..insertion_index, initial_context);
    } else {
        compacted_history.extend(initial_context);
    }

    compacted_history
}

pub(crate) fn build_compacted_history(
    initial_context: Vec<ResponseItem>,
    user_messages: &[CompactedUserMessage],
    summary_text: &str,
) -> Vec<ResponseItem> {
    build_compacted_history_with_limit(
        initial_context,
        user_messages,
        summary_text,
        COMPACT_USER_MESSAGE_MAX_TOKENS,
    )
}

fn build_compacted_history_with_limit(
    mut history: Vec<ResponseItem>,
    user_messages: &[CompactedUserMessage],
    summary_text: &str,
    max_tokens: usize,
) -> Vec<ResponseItem> {
    let mut selected_messages: Vec<CompactedUserMessage> = Vec::new();
    if max_tokens > 0 {
        let mut remaining = max_tokens;
        for message in user_messages.iter().rev() {
            if remaining == 0 {
                break;
            }
            let tokens = approx_token_count(&message.message);
            if tokens <= remaining {
                selected_messages.push(message.clone());
                remaining = remaining.saturating_sub(tokens);
            } else {
                let truncated =
                    truncate_text(&message.message, TruncationPolicy::Tokens(remaining));
                selected_messages.push(CompactedUserMessage {
                    message: truncated,
                    internal_chat_message_metadata_passthrough: message
                        .internal_chat_message_metadata_passthrough
                        .clone(),
                });
                break;
            }
        }
        selected_messages.reverse();
    }

    for message in &selected_messages {
        history.push(ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: message.message.clone(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: message
                .internal_chat_message_metadata_passthrough
                .clone(),
        });
    }

    let summary_text = if summary_text.is_empty() {
        "(no summary available)".to_string()
    } else {
        summary_text.to_string()
    };

    history.push(ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText { text: summary_text }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    });

    history
}

async fn drain_to_completed(
    sess: &Session,
    turn_context: &TurnContext,
    client_session: &mut ModelClientSession,
    responses_metadata: &CodexResponsesMetadata,
    prompt: &Prompt,
) -> CodexResult<()> {
    let mut stream = client_session
        .stream(
            prompt,
            &turn_context.model_info,
            &turn_context.session_telemetry,
            turn_context.reasoning_effort.clone(),
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            responses_metadata,
            // Rollout tracing currently models remote compaction only; local compaction streams
            // are left untraced until the reducer has a first-class local compaction lifecycle.
            &InferenceTraceContext::disabled(),
        )
        .await?;
    loop {
        let maybe_event = stream.next().await;
        let Some(event) = maybe_event else {
            return Err(CodexErr::Stream(
                "stream closed before response.completed".into(),
                None,
            ));
        };
        match event {
            Ok(ResponseEvent::OutputItemDone(item)) => {
                sess.record_conversation_items(turn_context, std::slice::from_ref(&item))
                    .await;
            }
            Ok(ResponseEvent::ServerReasoningIncluded(included)) => {
                sess.set_server_reasoning_included(included).await;
            }
            Ok(ResponseEvent::RateLimits(snapshot)) => {
                sess.update_rate_limits(turn_context, snapshot).await;
            }
            Ok(ResponseEvent::Completed {
                response_id,
                token_usage,
                ..
            }) => {
                sess.send_event(
                    turn_context,
                    EventMsg::RawResponseCompleted(RawResponseCompletedEvent {
                        response_id,
                        token_usage: token_usage.clone(),
                    }),
                )
                .await;
                sess.update_token_usage_info(turn_context, token_usage.as_ref())
                    .await?;
                return Ok(());
            }
            Ok(_) => continue,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
#[path = "compact_tests.rs"]
mod tests;

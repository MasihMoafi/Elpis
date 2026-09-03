//! First-exposure Smart Prune admission pass.
//!
//! Fresh client-side tool results arrive here after post-tool hooks and before
//! `record_conversation_items`. Failures return the exact pending outputs; only
//! compact envelopes backed by a durable audit are admitted.

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::SmartPruneAdmissionSnapshot;
use codex_protocol::protocol::SmartPruneSnapshot;
use codex_protocol::protocol::TokenUsage;
use codex_rollout_trace::InferenceTraceContext;
use codex_utils_string::approx_token_count;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::context_pruner::MAX_PRUNE_BATCH_TOKENS;
use crate::context_pruner::PRUNE_MODEL_SLUG;
use crate::context_pruner::PRUNE_REASONING_EFFORT;
use crate::responses_metadata::CodexResponsesRequestKind;
use crate::smart_prune::AdmissionDecision;
use crate::smart_prune::AdmissionEvidence;
use crate::smart_prune::MIN_SOURCE_TOKENS;
use crate::smart_prune::parse_decision_manifest;
use crate::smart_prune::textual_tool_output;
use crate::smart_prune::transform_tool_output;
use crate::tools::parallel::PendingToolOutput;

use super::session::Session;
use super::smart_prune_audit;
use super::turn_context::TurnContext;

const ADMISSION_TIMEOUT: Duration = Duration::from_secs(45);

const SMART_PRUNE_INSTRUCTIONS: &str = r#"You are Elpis Smart Prune. Compress fresh tool results before their first use by the main model.

Return exactly one JSON object and no markdown:
{"items":[{"call_id":"...","decision":"compact","content":"..."},{"call_id":"...","decision":"unchanged"}]}

Return exactly one item for every supplied call_id. Use "compact" only when content can be made materially smaller while retaining every fact, error, path, identifier, number, caveat, and next-step detail that may matter to the active request. The compact content must stand alone. Use "unchanged" whenever lossless semantic reduction is uncertain. Never request deletion and never invent facts."#;

#[derive(Clone)]
struct Candidate {
    pending_index: usize,
    call_id: String,
    source: ResponseItem,
    source_tokens: usize,
}

struct ModelAdmission {
    raw_response: String,
    usage: Option<TokenUsage>,
    model_slug: String,
    input: String,
}

/// Causal identity of the main-model attempt that first contains an admission.
///
/// This stays opaque to the sampling loop so a later response cannot be attached
/// by searching mutable session state for whichever admission happens to be latest.
pub(super) struct SmartPruneRequestLink {
    admission_id: String,
    audit_path: String,
    request_sequence: u64,
}

/// Optimizes a fresh sibling batch before any of its outputs enter history.
/// Every error is fail-open: callers receive the original vector byte-for-byte.
pub(super) async fn optimize_pending_outputs(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    mut pending: Vec<PendingToolOutput>,
    cancellation_token: &CancellationToken,
) -> Vec<PendingToolOutput> {
    if !turn_context.smart_prune_enabled || cancellation_token.is_cancelled() {
        return pending;
    }
    let candidates = select_candidates(&pending);
    if candidates.is_empty() {
        return pending;
    }
    if sess
        .state
        .lock()
        .await
        .smart_prune_failed_turn_id
        .as_deref()
        == Some(turn_context.sub_id.as_str())
    {
        return pending;
    }

    let history = sess.clone_history().await;
    let history_items = history.raw_items();
    let input = match build_admission_input(history_items, &candidates) {
        Ok(input) => input,
        Err(err) => {
            tracing::warn!(
                "Smart Prune input construction failed; preserving tool output: {err:#}"
            );
            record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
            return pending;
        }
    };

    if cancellation_token.is_cancelled() {
        return pending;
    }

    record_optimizer_started(sess).await;
    let optimizer_started = Instant::now();
    let admission_result = tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => {
            record_optimizer_finished(sess, optimizer_started.elapsed(), None).await;
            return pending;
        }
        result = tokio::time::timeout(
            ADMISSION_TIMEOUT,
            run_model_admission(sess, turn_context, input),
        ) => result,
    };
    let optimizer_usage = match &admission_result {
        Ok(Ok(admission)) => admission.usage.as_ref(),
        _ => None,
    };
    record_optimizer_finished(sess, optimizer_started.elapsed(), optimizer_usage).await;
    let admission = match admission_result {
        Ok(Ok(admission)) => admission,
        Ok(Err(err)) => {
            tracing::warn!("Smart Prune model pass failed; preserving tool output: {err:#}");
            record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
            return pending;
        }
        Err(_) => {
            tracing::warn!("Smart Prune model pass timed out; preserving tool output");
            record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
            return pending;
        }
    };

    let expected_ids = candidates
        .iter()
        .map(|candidate| candidate.call_id.as_str())
        .collect::<Vec<_>>();
    let Some(decisions) = parse_decision_manifest(&admission.raw_response, &expected_ids) else {
        tracing::warn!("Smart Prune response was malformed; preserving tool output");
        record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
        return pending;
    };

    let admission_id = uuid::Uuid::now_v7().to_string();
    let mut applied = Vec::new();
    for (candidate, decision) in candidates.iter().zip(decisions) {
        debug_assert_eq!(candidate.call_id, decision.call_id());
        let AdmissionDecision::Compact { content, .. } = decision else {
            continue;
        };
        let source_sha256 = match smart_prune_audit::response_item_sha256(&candidate.source) {
            Ok(hash) => hash,
            Err(err) => {
                tracing::warn!("Smart Prune source hashing failed; preserving batch: {err:#}");
                record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
                return pending;
            }
        };
        let Some(transformed) = transform_tool_output(
            &candidate.source,
            &content,
            AdmissionEvidence {
                admission_id: &admission_id,
                source_sha256: &source_sha256,
            },
        ) else {
            continue;
        };
        applied.push((candidate.clone(), source_sha256, transformed));
    }
    if applied.is_empty() {
        record_unchanged_batch(sess, candidates.len()).await;
        return pending;
    }

    let audit_items = applied
        .iter()
        .map(
            |(candidate, source_sha256, transformed)| smart_prune_audit::AdmissionAuditItem {
                call_id: candidate.call_id.clone(),
                decision: "compact",
                source_sha256: source_sha256.clone(),
                source: candidate.source.clone(),
                admitted: transformed.admitted.clone(),
                source_tokens: transformed.source_tokens,
                admitted_tokens: transformed.admitted_tokens,
                saved_tokens: transformed.saved_tokens,
            },
        )
        .collect::<Vec<_>>();
    let log_dir = sess.codex_home().await.join("logs");
    let session_id = sess.session_id().to_string();
    if let Err(err) = smart_prune_audit::write_admission(
        &log_dir,
        smart_prune_audit::AdmissionAuditInput {
            admission_id: &admission_id,
            session_id: &session_id,
            turn_id: &turn_context.sub_id,
            model_slug: &admission.model_slug,
            ace_instructions: SMART_PRUNE_INSTRUCTIONS,
            ace_input: &admission.input,
            raw_response: &admission.raw_response,
            usage: admission.usage.as_ref(),
            items: &audit_items,
        },
    ) {
        tracing::warn!("Smart Prune audit failed; preserving tool output: {err:#}");
        record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
        return pending;
    }

    record_applied_admission(sess, &admission_id, candidates.len(), &audit_items).await;

    for (candidate, _, transformed) in applied {
        let Some(admitted) = output_item_to_input(transformed.admitted) else {
            tracing::error!(
                "Smart Prune produced an unsupported admitted envelope; preserving item"
            );
            continue;
        };
        pending[candidate.pending_index].response = admitted;
    }
    tracing::info!(
        admission_id,
        admitted_items = audit_items.len(),
        saved_tokens = audit_items
            .iter()
            .map(|item| item.saved_tokens)
            .sum::<usize>(),
        "Smart Prune admitted fresh tool output before first main-model exposure"
    );
    pending
}

async fn record_batch_failure(sess: &Session, turn_id: &str, examined: usize) {
    let mut state = sess.state.lock().await;
    state.smart_prune_failed_turn_id = Some(turn_id.to_string());
    state.smart_prune.examined_outputs = state
        .smart_prune
        .examined_outputs
        .saturating_add(examined as u64);
    // Fail-open preserves the original candidate outputs, so they are unchanged even though
    // the optimizer batch failed. Keep the accounting partition complete.
    state.smart_prune.unchanged_outputs = state
        .smart_prune
        .unchanged_outputs
        .saturating_add(examined as u64);
    state.smart_prune.failed_batches = state.smart_prune.failed_batches.saturating_add(1);
}

async fn record_optimizer_started(sess: &Session) {
    let mut state = sess.state.lock().await;
    state.smart_prune.optimizer_requests = state.smart_prune.optimizer_requests.saturating_add(1);
}

async fn record_optimizer_finished(sess: &Session, elapsed: Duration, usage: Option<&TokenUsage>) {
    let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    let mut state = sess.state.lock().await;
    state.smart_prune.optimizer_latency_ms = state
        .smart_prune
        .optimizer_latency_ms
        .saturating_add(elapsed_ms);
    if let Some(usage) = usage {
        state.smart_prune.optimizer_usage_reports =
            state.smart_prune.optimizer_usage_reports.saturating_add(1);
        state.smart_prune.optimizer_usage.add_assign(usage);
    }
}

async fn record_unchanged_batch(sess: &Session, examined: usize) {
    let mut state = sess.state.lock().await;
    state.smart_prune.examined_outputs = state
        .smart_prune
        .examined_outputs
        .saturating_add(examined as u64);
    state.smart_prune.unchanged_outputs = state
        .smart_prune
        .unchanged_outputs
        .saturating_add(examined as u64);
}

async fn record_applied_admission(
    sess: &Session,
    admission_id: &str,
    examined: usize,
    items: &[smart_prune_audit::AdmissionAuditItem],
) {
    let admitted = items.len() as u64;
    let source_tokens = items
        .iter()
        .map(|item| item.source_tokens as u64)
        .sum::<u64>();
    let admitted_tokens = items
        .iter()
        .map(|item| item.admitted_tokens as u64)
        .sum::<u64>();
    let saved_tokens = items
        .iter()
        .map(|item| item.saved_tokens as u64)
        .sum::<u64>();
    let mut state = sess.state.lock().await;
    state.smart_prune.examined_outputs = state
        .smart_prune
        .examined_outputs
        .saturating_add(examined as u64);
    state.smart_prune.admitted_outputs =
        state.smart_prune.admitted_outputs.saturating_add(admitted);
    state.smart_prune.unchanged_outputs = state
        .smart_prune
        .unchanged_outputs
        .saturating_add((examined as u64).saturating_sub(admitted));
    state.smart_prune.approx_source_tokens = state
        .smart_prune
        .approx_source_tokens
        .saturating_add(source_tokens);
    state.smart_prune.approx_admitted_tokens = state
        .smart_prune
        .approx_admitted_tokens
        .saturating_add(admitted_tokens);
    state.smart_prune.approx_saved_tokens = state
        .smart_prune
        .approx_saved_tokens
        .saturating_add(saved_tokens);
    state.smart_prune.latest = Some(SmartPruneAdmissionSnapshot {
        admission_id: admission_id.to_string(),
        audit_path: format!("smart-prune/admissions/{admission_id}"),
        examined_outputs: examined as u64,
        admitted_outputs: admitted,
        approx_source_tokens: source_tokens,
        approx_admitted_tokens: admitted_tokens,
        approx_saved_tokens: saved_tokens,
        request_sequence: None,
        request_input_sha256: None,
        request_linkage_verified: false,
        response_id: None,
        response_usage: None,
        response_linkage_verified: false,
    });
}

impl Session {
    pub(crate) async fn smart_prune_snapshot(&self) -> SmartPruneSnapshot {
        let mut snapshot = self.state.lock().await.smart_prune.clone();
        snapshot.enabled = self.smart_prune_enabled();
        snapshot
    }

    /// Hash and durably link the logical prompt input before transport adaptation.
    pub(super) async fn record_smart_prune_request(
        &self,
        input: &[ResponseItem],
    ) -> Option<SmartPruneRequestLink> {
        let bytes = match serde_json::to_vec(input) {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!("Smart Prune request hashing failed: {err}");
                return None;
            }
        };
        let hash = format!("{:x}", Sha256::digest(bytes));
        let pending = {
            let mut state = self.state.lock().await;
            state.smart_prune.main_request_sequence =
                state.smart_prune.main_request_sequence.saturating_add(1);
            let sequence = state.smart_prune.main_request_sequence;
            state
                .smart_prune
                .latest
                .as_mut()
                .filter(|latest| latest.request_sequence.is_none())
                .map(|latest| {
                    latest.request_sequence = Some(sequence);
                    latest.request_input_sha256 = Some(hash.clone());
                    SmartPruneRequestLink {
                        admission_id: latest.admission_id.clone(),
                        audit_path: latest.audit_path.clone(),
                        request_sequence: sequence,
                    }
                })
        };
        let Some(link) = pending else {
            return None;
        };
        let log_dir = self.codex_home().await.join("logs");
        let verified = smart_prune_audit::write_request_linkage(
            &log_dir,
            std::path::Path::new(&link.audit_path),
            &link.admission_id,
            link.request_sequence,
            &hash,
        )
        .is_ok();
        if !verified {
            tracing::warn!("Smart Prune request linkage could not be published");
        }
        let mut state = self.state.lock().await;
        if let Some(latest) = state.smart_prune.latest.as_mut()
            && latest.admission_id == link.admission_id
            && latest.request_sequence == Some(link.request_sequence)
        {
            latest.request_linkage_verified = verified;
        }
        Some(link)
    }

    pub(super) async fn record_smart_prune_response(
        &self,
        request_link: &SmartPruneRequestLink,
        response_id: &str,
        usage: Option<&TokenUsage>,
    ) {
        let log_dir = self.codex_home().await.join("logs");
        let verified = smart_prune_audit::write_response_linkage(
            &log_dir,
            std::path::Path::new(&request_link.audit_path),
            &request_link.admission_id,
            response_id,
            usage,
        )
        .is_ok();
        if !verified {
            tracing::warn!("Smart Prune response linkage could not be published");
        }
        let mut state = self.state.lock().await;
        if let Some(latest) = state.smart_prune.latest.as_mut()
            && latest.admission_id == request_link.admission_id
            && latest.request_sequence == Some(request_link.request_sequence)
            && latest.response_id.is_none()
        {
            latest.response_id = Some(response_id.to_string());
            latest.response_usage = usage.cloned();
            latest.response_linkage_verified = verified;
        }
    }
}

fn select_candidates(pending: &[PendingToolOutput]) -> Vec<Candidate> {
    let mut selected = Vec::new();
    let mut selected_tokens = 0usize;
    for (pending_index, output) in pending.iter().enumerate() {
        if !output.smart_prune_eligible {
            continue;
        }
        let source = ResponseItem::from(output.response.clone());
        let Some((call_id, text)) = textual_tool_output(&source) else {
            continue;
        };
        let source_tokens = approx_token_count(text);
        if source_tokens < MIN_SOURCE_TOKENS
            || selected_tokens.saturating_add(source_tokens) > MAX_PRUNE_BATCH_TOKENS
        {
            continue;
        }
        selected_tokens = selected_tokens.saturating_add(source_tokens);
        selected.push(Candidate {
            pending_index,
            call_id: call_id.to_string(),
            source,
            source_tokens,
        });
    }
    selected
}

fn build_admission_input(
    history: &[ResponseItem],
    candidates: &[Candidate],
) -> anyhow::Result<String> {
    let active_question = crate::context_pruner::latest_user_message_text(history);
    let items = candidates
        .iter()
        .map(|candidate| {
            let invocation = history
                .iter()
                .rev()
                .find(|item| response_item_call_id(item) == Some(candidate.call_id.as_str()));
            serde_json::json!({
                "call_id": candidate.call_id,
                "source_tokens_estimate": candidate.source_tokens,
                "invocation": invocation,
                "source_output": candidate.source,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({
        "active_request": active_question,
        "items": items,
    }))
    .map_err(Into::into)
}

async fn run_model_admission(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    input: String,
) -> anyhow::Result<ModelAdmission> {
    let model_slug =
        if turn_context.config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID {
            PRUNE_MODEL_SLUG
        } else {
            turn_context.model_info.slug.as_str()
        };
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
                text: input.clone(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: SMART_PRUNE_INSTRUCTIONS.to_string(),
        },
        ..Default::default()
    };
    let metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "smart-prune".to_string(),
        CodexResponsesRequestKind::SmartPrune,
    );
    let mut client_session = sess.services.model_client.load().new_session();
    let mut stream = client_session
        .stream(
            &prompt,
            &model_info,
            &turn_context.session_telemetry,
            Some(PRUNE_REASONING_EFFORT),
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            &metadata,
            &InferenceTraceContext::disabled(),
        )
        .await?;

    let mut completed_items = Vec::new();
    let mut deltas = String::new();
    let mut usage = None;
    let mut saw_completed = false;
    while let Some(event) = stream.next().await {
        match event? {
            ResponseEvent::OutputItemDone(item) => completed_items.push(item),
            ResponseEvent::OutputTextDelta(delta) => deltas.push_str(&delta),
            ResponseEvent::Completed { token_usage, .. } => {
                usage = token_usage;
                saw_completed = true;
            }
            _ => {}
        }
    }
    anyhow::ensure!(
        saw_completed,
        "Smart Prune stream closed before response.completed"
    );
    let raw_response = super::turn::get_last_assistant_message_from_turn(&completed_items)
        .or_else(|| (!deltas.trim().is_empty()).then_some(deltas))
        .ok_or_else(|| anyhow::anyhow!("Smart Prune stream completed without assistant text"))?;
    Ok(ModelAdmission {
        raw_response,
        usage,
        model_slug: model_slug.to_string(),
        input,
    })
}

fn response_item_call_id(item: &ResponseItem) -> Option<&str> {
    match item {
        ResponseItem::FunctionCall { call_id, .. }
        | ResponseItem::CustomToolCall { call_id, .. } => Some(call_id),
        _ => None,
    }
}

fn output_item_to_input(item: ResponseItem) -> Option<ResponseInputItem> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id, output, ..
        } => Some(ResponseInputItem::FunctionCallOutput { call_id, output }),
        ResponseItem::CustomToolCallOutput {
            call_id,
            name,
            output,
            ..
        } => Some(ResponseInputItem::CustomToolCallOutput {
            call_id,
            name,
            output,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputBody;
    use codex_protocol::models::FunctionCallOutputContentItem;
    use codex_protocol::models::FunctionCallOutputPayload;

    #[test]
    fn selection_is_large_text_only_bounded_and_preserves_hook_opt_out() {
        let large = "evidence line\n".repeat(2_000);
        let make = |call_id: &str, text: String, eligible| PendingToolOutput {
            response: ResponseInputItem::FunctionCallOutput {
                call_id: call_id.to_string(),
                output: FunctionCallOutputPayload::from_text(text),
            },
            smart_prune_eligible: eligible,
        };
        let pending = vec![
            make("small", "tiny".to_string(), true),
            make("large", large.clone(), true),
            make("hook", large, false),
        ];
        let selected = select_candidates(&pending);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].call_id, "large");
        assert_eq!(selected[0].pending_index, 1);
    }

    #[test]
    fn output_conversion_keeps_custom_envelope_fields() {
        let output = ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: "custom-1".to_string(),
            name: Some("database".to_string()),
            output: FunctionCallOutputPayload::from_text("result".to_string()),
            internal_chat_message_metadata_passthrough: None,
        };
        assert_eq!(
            output_item_to_input(output),
            Some(ResponseInputItem::CustomToolCallOutput {
                call_id: "custom-1".to_string(),
                name: Some("database".to_string()),
                output: FunctionCallOutputPayload::from_text("result".to_string()),
            })
        );
    }

    #[tokio::test]
    async fn failed_batch_counts_every_preserved_output_as_unchanged() {
        let (session, _) = crate::session::tests::make_session_and_context().await;

        record_batch_failure(&session, "failed-turn", 3).await;

        let snapshot = session.smart_prune_snapshot().await;
        assert_eq!(snapshot.examined_outputs, 3);
        assert_eq!(snapshot.unchanged_outputs, 3);
        assert_eq!(snapshot.failed_batches, 1);
        assert_eq!(
            session
                .state
                .lock()
                .await
                .smart_prune_failed_turn_id
                .as_deref(),
            Some("failed-turn")
        );
    }

    #[tokio::test]
    async fn optimizer_accounting_accumulates_latency_and_optional_usage() {
        let (session, _) = crate::session::tests::make_session_and_context().await;
        let first = TokenUsage {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_write_tokens: None,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
        };
        let second = TokenUsage {
            input_tokens: 20,
            cached_input_tokens: 4,
            cache_write_tokens: Some(0),
            output_tokens: 5,
            reasoning_output_tokens: 2,
            total_tokens: 25,
        };

        record_optimizer_started(&session).await;
        record_optimizer_finished(&session, Duration::from_millis(7), Some(&first)).await;
        let first_snapshot = session.smart_prune_snapshot().await;
        assert_eq!(first_snapshot.optimizer_usage.cache_write_tokens, None);

        record_optimizer_started(&session).await;
        record_optimizer_finished(&session, Duration::from_millis(5), Some(&second)).await;
        record_optimizer_started(&session).await;
        record_optimizer_finished(&session, Duration::from_millis(3), None).await;

        let snapshot = session.smart_prune_snapshot().await;
        assert_eq!(snapshot.optimizer_requests, 3);
        assert_eq!(snapshot.optimizer_usage_reports, 2);
        assert_eq!(snapshot.optimizer_latency_ms, 15);
        assert_eq!(snapshot.optimizer_usage.input_tokens, 30);
        assert_eq!(snapshot.optimizer_usage.total_tokens, 38);
        assert_eq!(snapshot.optimizer_usage.cache_write_tokens, Some(0));
    }

    #[tokio::test]
    async fn cancelled_turn_skips_optimizer_before_launch() {
        let (session, mut turn_context) = crate::session::tests::make_session_and_context().await;
        turn_context.smart_prune_enabled = true;
        let session = Arc::new(session);
        let turn_context = Arc::new(turn_context);
        let original = PendingToolOutput {
            response: ResponseInputItem::FunctionCallOutput {
                call_id: "cancelled-call".to_string(),
                output: FunctionCallOutputPayload::from_text("evidence line\n".repeat(2_000)),
            },
            smart_prune_eligible: true,
        };
        let cancellation_token = CancellationToken::new();
        cancellation_token.cancel();

        let result = optimize_pending_outputs(
            &session,
            &turn_context,
            vec![original.clone()],
            &cancellation_token,
        )
        .await;

        assert_eq!(result, vec![original]);
        assert_eq!(session.smart_prune_snapshot().await.optimizer_requests, 0);
    }

    #[tokio::test]
    async fn ineligible_outputs_bypass_optimizer_byte_for_byte() {
        let (session, mut turn_context) = crate::session::tests::make_session_and_context().await;
        turn_context.smart_prune_enabled = true;
        let session = Arc::new(session);
        let turn_context = Arc::new(turn_context);
        let original = vec![
            PendingToolOutput {
                response: ResponseInputItem::FunctionCallOutput {
                    call_id: "hook-opt-out".to_string(),
                    output: FunctionCallOutputPayload::from_text("evidence line\n".repeat(2_000)),
                },
                smart_prune_eligible: false,
            },
            PendingToolOutput {
                response: ResponseInputItem::FunctionCallOutput {
                    call_id: "structured".to_string(),
                    output: FunctionCallOutputPayload {
                        body: FunctionCallOutputBody::ContentItems(vec![
                            FunctionCallOutputContentItem::InputText {
                                text: "evidence line\n".repeat(2_000),
                            },
                        ]),
                        success: Some(true),
                    },
                },
                smart_prune_eligible: true,
            },
        ];

        let result = optimize_pending_outputs(
            &session,
            &turn_context,
            original.clone(),
            &CancellationToken::new(),
        )
        .await;

        assert_eq!(result, original);
        assert_eq!(session.smart_prune_snapshot().await.optimizer_requests, 0);
    }
}

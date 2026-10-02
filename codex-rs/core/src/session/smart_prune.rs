//! Elpis: first-exposure Smart Prune admission pass.
//!
//! Fresh client-side tool results arrive here after post-tool hooks and before
//! `record_annotated_conversation_items`. Failures return the exact pending outputs; only
//! compact envelopes backed by a durable audit are admitted.
//!
//! Copied from v0.3.0 `core/src/session/smart_prune.rs`. On Codex 0.159:
//! - Pending outputs are history envelopes. An output is ineligible when the tool runtime
//!   marked its call id (explicit post-tool hook feedback, runtime-generated failures).
//! - The switch is the turn's `automatic_context_pruning` feature; a config refresh updates
//!   it for later turns, never for a turn already running.
//! - The source offered to the optimizer and audited is the item without its harness
//!   metadata; an admitted output keeps its envelope and metadata and only its body changes.
//! - There is no OpenRouter fallback: this build has no OpenRouter provider.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use codex_features::Feature;
use codex_history::ResponseItemEnvelope;
use codex_protocol::elpis_smart_prune::SmartPruneAdmissionSnapshot;
use codex_protocol::elpis_smart_prune::SmartPruneAttemptSnapshot;
use codex_protocol::elpis_smart_prune::SmartPruneSnapshot;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
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
use crate::responses_metadata::CodexResponsesRequestKind;
use crate::smart_prune::AdmissionDecision;
use crate::smart_prune::AdmissionEvidence;
use crate::smart_prune::MIN_SOURCE_TOKENS;
use crate::smart_prune::parse_decision_manifest;
use crate::smart_prune::textual_tool_output;
use crate::smart_prune::transform_tool_output;

use super::session::Session;
use super::smart_prune_audit;
use super::step_context::StepContext;
use super::turn_context::TurnContext;

/// Keep optimizer latency bounded independently of the chat model's effort.
/// Matched Low-effort evaluations are recorded in docs/evals/rq3.
const SMART_PRUNE_REASONING_EFFORT: ReasoningEffort = ReasoningEffort::Low;
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(180);

use crate::pruner_settings::DEFAULT_SYSTEM_PROMPT as SMART_PRUNE_INSTRUCTIONS;

#[derive(Clone)]
struct Candidate {
    pending_index: usize,
    call_id: String,
    source: ResponseItem,
    source_tokens: usize,
}

struct ModelAdmission {
    instructions: String,
    attempt_id: String,
    raw_response: String,
    usage: Option<TokenUsage>,
    model_slug: String,
    input: String,
    latency: Duration,
}

/// Kept outside the request future so errors and cancellation retain received evidence.
#[derive(Default)]
struct OptimizerProgress {
    completed_items: Vec<ResponseItem>,
    deltas: String,
    usage: Option<TokenUsage>,
}

impl OptimizerProgress {
    fn raw_response(&self) -> Option<String> {
        super::turn::get_last_assistant_message_from_turn(self.completed_items.iter())
            .or_else(|| (!self.deltas.trim().is_empty()).then(|| self.deltas.clone()))
    }
}

enum OptimizerAttemptFailure {
    Cancelled,
    Failed,
}

#[derive(Debug, Eq, PartialEq)]
struct OptimizerInactivityTimeout(Duration);

impl std::fmt::Display for OptimizerInactivityTimeout {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}-second optimizer inactivity timeout elapsed",
            self.0.as_secs()
        )
    }
}

impl std::error::Error for OptimizerInactivityTimeout {}

fn optimizer_provider_with_timeouts(
    mut provider: codex_model_provider_info::ModelProviderInfo,
    inactivity_timeout: Duration,
) -> codex_model_provider_info::ModelProviderInfo {
    // ACE must not inherit a shorter transport timeout than its own allowance.
    // Clone-only configuration keeps the main conversation's policy unchanged.
    if provider.websocket_connect_timeout() < inactivity_timeout {
        provider.websocket_connect_timeout_ms = Some(inactivity_timeout.as_millis() as u64);
    }
    if provider.stream_idle_timeout() < inactivity_timeout {
        provider.stream_idle_timeout_ms = Some(inactivity_timeout.as_millis() as u64);
    }
    provider
}

async fn next_optimizer_stream_item<S>(
    stream: &mut S,
    inactivity_timeout: Duration,
) -> Result<Option<S::Item>, OptimizerInactivityTimeout>
where
    S: futures::Stream + Unpin,
{
    tokio::time::timeout(inactivity_timeout, stream.next())
        .await
        .map_err(|_| OptimizerInactivityTimeout(inactivity_timeout))
}

async fn collect_optimizer_response<S>(
    stream: &mut S,
    inactivity_timeout: Duration,
    progress: &mut OptimizerProgress,
) -> anyhow::Result<String>
where
    S: futures::Stream<Item = codex_protocol::error::Result<ResponseEvent>> + Unpin,
{
    loop {
        let event = next_optimizer_stream_item(stream, inactivity_timeout)
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!("Smart Prune stream closed before response.completed")
            })?;
        match event? {
            ResponseEvent::OutputItemDone(item) => progress.completed_items.push(item),
            ResponseEvent::OutputTextDelta(delta) => progress.deltas.push_str(&delta),
            ResponseEvent::Completed { token_usage, .. } => {
                progress.usage = token_usage;
                // Completion is authoritative; the connection may stay open for reuse.
                return progress.raw_response().ok_or_else(|| {
                    anyhow::anyhow!("Smart Prune stream completed without assistant text")
                });
            }
            _ => {}
        }
    }
}

struct AttemptOutcome<'a> {
    instructions: &'a str,
    attempt_id: &'a str,
    turn_id: &'a str,
    model_slug: &'a str,
    input: &'a str,
    status: smart_prune_audit::AttemptStatus,
    raw_response: Option<&'a str>,
    error: Option<&'a str>,
    candidate_outputs: usize,
    admitted_outputs: usize,
    saved_tokens: usize,
    latency: Duration,
    usage: Option<&'a TokenUsage>,
    admission_id: Option<&'a str>,
}

/// Causal identity of the main-model attempt that first contains an admission.
///
/// This stays opaque to the sampling loop so a later response cannot be attached
/// by searching mutable session state for whichever admission happens to be latest.
pub(crate) struct SmartPruneRequestLink {
    admission_id: String,
    audit_path: String,
    request_sequence: u64,
}

/// Whether Smart Prune runs for this turn. The per-turn config is a snapshot, so switching
/// it on or off applies to later turns, not the one in flight.
pub(crate) fn enabled_for_turn(turn_context: &TurnContext) -> bool {
    turn_context
        .config
        .features
        .enabled(Feature::AutomaticContextPruning)
}

/// Optimizes a fresh sibling batch before any of its outputs enter history.
/// Every error is fail-open: callers receive the original vector byte-for-byte.
pub(crate) async fn optimize_pending_outputs(
    sess: &Arc<Session>,
    step_context: &StepContext,
    mut pending: Vec<ResponseItemEnvelope>,
    cancellation_token: &CancellationToken,
) -> Vec<ResponseItemEnvelope> {
    let turn_context = step_context.turn.as_ref();
    let ineligible = sess.take_smart_prune_ineligible_call_ids(&pending).await;
    if !enabled_for_turn(turn_context) || cancellation_token.is_cancelled() {
        return pending;
    }
    let candidates = select_candidates(&pending, &ineligible);
    if candidates.is_empty() {
        return pending;
    }
    if sess
        .state
        .lock()
        .await
        .smart_prune
        .failed_turn_id
        .as_deref()
        == Some(turn_context.sub_id.as_str())
    {
        return pending;
    }

    let history = sess.clone_history().await;
    let input = match build_admission_input(history.raw_items(), &candidates) {
        Ok(input) => input,
        Err(err) => {
            tracing::warn!(
                "Smart Prune input construction failed; preserving tool output: {err:#}"
            );
            record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
            return pending;
        }
    };
    drop(history);
    if cancellation_token.is_cancelled() {
        return pending;
    }
    let admission = match run_optimizer_attempt(
        sess,
        step_context,
        &input,
        candidates.len(),
        ADMISSION_TIMEOUT,
        cancellation_token,
    )
    .await
    {
        Ok(admission) => admission,
        Err(OptimizerAttemptFailure::Cancelled) => return pending,
        Err(OptimizerAttemptFailure::Failed) => {
            record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
            return pending;
        }
    };
    let optimizer_elapsed = admission.latency;

    let expected_ids = candidates
        .iter()
        .map(|candidate| candidate.call_id.as_str())
        .collect::<Vec<_>>();
    let Some(decisions) = parse_decision_manifest(&admission.raw_response, &expected_ids) else {
        tracing::warn!("Smart Prune response was malformed; preserving tool output");
        record_attempt(
            sess,
            AttemptOutcome {
                attempt_id: &admission.attempt_id,
                instructions: &admission.instructions,
                turn_id: &turn_context.sub_id,
                model_slug: &admission.model_slug,
                input: &input,
                status: smart_prune_audit::AttemptStatus::MalformedResponse,
                raw_response: Some(&admission.raw_response),
                error: Some("optimizer response did not match the decision manifest schema"),
                candidate_outputs: candidates.len(),
                admitted_outputs: 0,
                saved_tokens: 0,
                latency: optimizer_elapsed,
                usage: admission.usage.as_ref(),
                admission_id: None,
            },
        )
        .await;
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
                let error = format!("{err:#}");
                tracing::warn!("Smart Prune source hashing failed; preserving batch: {error}");
                record_attempt(
                    sess,
                    AttemptOutcome {
                        attempt_id: &admission.attempt_id,
                        instructions: &admission.instructions,
                        turn_id: &turn_context.sub_id,
                        model_slug: &admission.model_slug,
                        input: &input,
                        status: smart_prune_audit::AttemptStatus::SourceError,
                        raw_response: Some(&admission.raw_response),
                        error: Some(&error),
                        candidate_outputs: candidates.len(),
                        admitted_outputs: 0,
                        saved_tokens: 0,
                        latency: optimizer_elapsed,
                        usage: admission.usage.as_ref(),
                        admission_id: None,
                    },
                )
                .await;
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
        record_attempt(
            sess,
            AttemptOutcome {
                attempt_id: &admission.attempt_id,
                instructions: &admission.instructions,
                turn_id: &turn_context.sub_id,
                model_slug: &admission.model_slug,
                input: &input,
                status: smart_prune_audit::AttemptStatus::Unchanged,
                raw_response: Some(&admission.raw_response),
                error: None,
                candidate_outputs: candidates.len(),
                admitted_outputs: 0,
                saved_tokens: 0,
                latency: optimizer_elapsed,
                usage: admission.usage.as_ref(),
                admission_id: None,
            },
        )
        .await;
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
    let log_dir = sess.smart_prune_log_dir().await;
    let session_id = sess.session_id().to_string();
    if let Err(err) = smart_prune_audit::write_admission(
        &log_dir,
        smart_prune_audit::AdmissionAuditInput {
            admission_id: &admission_id,
            session_id: &session_id,
            turn_id: &turn_context.sub_id,
            model_slug: &admission.model_slug,
            ace_instructions: &admission.instructions,
            ace_input: &admission.input,
            raw_response: &admission.raw_response,
            usage: admission.usage.as_ref(),
            items: &audit_items,
        },
    ) {
        let error = format!("{err:#}");
        tracing::warn!("Smart Prune audit failed; preserving tool output: {error}");
        record_attempt(
            sess,
            AttemptOutcome {
                attempt_id: &admission.attempt_id,
                instructions: &admission.instructions,
                turn_id: &turn_context.sub_id,
                model_slug: &admission.model_slug,
                input: &input,
                status: smart_prune_audit::AttemptStatus::AuditError,
                raw_response: Some(&admission.raw_response),
                error: Some(&error),
                candidate_outputs: candidates.len(),
                admitted_outputs: 0,
                saved_tokens: 0,
                latency: optimizer_elapsed,
                usage: admission.usage.as_ref(),
                admission_id: None,
            },
        )
        .await;
        record_batch_failure(sess, &turn_context.sub_id, candidates.len()).await;
        return pending;
    }

    let saved_tokens = audit_items
        .iter()
        .map(|item| item.saved_tokens)
        .sum::<usize>();
    record_attempt(
        sess,
        AttemptOutcome {
            attempt_id: &admission.attempt_id,
            instructions: &admission.instructions,
            turn_id: &turn_context.sub_id,
            model_slug: &admission.model_slug,
            input: &input,
            status: smart_prune_audit::AttemptStatus::Admitted,
            raw_response: Some(&admission.raw_response),
            error: None,
            candidate_outputs: candidates.len(),
            admitted_outputs: audit_items.len(),
            saved_tokens,
            latency: optimizer_elapsed,
            usage: admission.usage.as_ref(),
            admission_id: Some(&admission_id),
        },
    )
    .await;
    record_applied_admission(sess, &admission_id, candidates.len(), &audit_items).await;

    for (candidate, _, transformed) in applied {
        if !admit_body(
            &mut pending[candidate.pending_index].item,
            transformed.admitted,
        ) {
            tracing::error!(
                "Smart Prune produced an unsupported admitted envelope; preserving item"
            );
        }
    }
    tracing::info!(
        admission_id,
        admitted_items = audit_items.len(),
        saved_tokens,
        "Smart Prune admitted fresh tool output before first main-model exposure"
    );
    pending
}

async fn run_optimizer_attempt(
    sess: &Arc<Session>,
    step_context: &StepContext,
    input: &str,
    candidate_outputs: usize,
    inactivity_timeout: Duration,
    cancellation_token: &CancellationToken,
) -> Result<ModelAdmission, OptimizerAttemptFailure> {
    let turn_context = step_context.turn.as_ref();
    let attempt_id = uuid::Uuid::now_v7().to_string();
    let settings =
        match crate::pruner_settings::PrunerSettings::load(&turn_context.config.codex_home) {
            Ok(settings) => settings,
            Err(error) => {
                let error = format!("Invalid pruner settings; preserving tool output: {error}");
                record_attempt(
                    sess,
                    AttemptOutcome {
                        attempt_id: &attempt_id,
                        instructions: SMART_PRUNE_INSTRUCTIONS,
                        turn_id: &turn_context.sub_id,
                        model_slug: selected_model_slug(step_context),
                        input,
                        status: smart_prune_audit::AttemptStatus::ModelError,
                        raw_response: None,
                        error: Some(&error),
                        candidate_outputs,
                        admitted_outputs: 0,
                        saved_tokens: 0,
                        latency: Duration::ZERO,
                        usage: None,
                        admission_id: None,
                    },
                )
                .await;
                return Err(OptimizerAttemptFailure::Failed);
            }
        };
    let instructions = settings
        .system_prompt
        .as_deref()
        .unwrap_or(SMART_PRUNE_INSTRUCTIONS);
    let model_slug = settings
        .model
        .as_deref()
        .unwrap_or_else(|| selected_model_slug(step_context));
    record_optimizer_started(sess).await;
    let started = Instant::now();
    let mut progress = OptimizerProgress::default();
    let result = tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => None,
        result = run_model_admission(
            sess,
            step_context,
            input.to_string(),
            model_slug,
            settings.provider.as_deref(),
            instructions,
            inactivity_timeout,
            &mut progress,
        ) => Some(result),
    };
    let elapsed = started.elapsed();
    let usage = progress.usage.as_ref();
    record_optimizer_finished(sess, elapsed, usage).await;
    let raw_response = progress.raw_response();
    let Some(result) = result else {
        record_attempt(
            sess,
            AttemptOutcome {
                attempt_id: &attempt_id,
                instructions,
                turn_id: &turn_context.sub_id,
                model_slug,
                input,
                status: smart_prune_audit::AttemptStatus::Cancelled,
                raw_response: raw_response.as_deref(),
                error: Some("turn cancelled while optimizer request was in flight"),
                candidate_outputs,
                admitted_outputs: 0,
                saved_tokens: 0,
                latency: elapsed,
                usage,
                admission_id: None,
            },
        )
        .await;
        return Err(OptimizerAttemptFailure::Cancelled);
    };
    match result {
        Ok(mut admission) => {
            admission.attempt_id = attempt_id;
            admission.latency = elapsed;
            Ok(admission)
        }
        Err(err) if err.downcast_ref::<OptimizerInactivityTimeout>().is_some() => {
            let error = err.to_string();
            tracing::warn!(
                model = model_slug,
                "Smart Prune optimizer attempt timed out after inactivity"
            );
            record_attempt(
                sess,
                AttemptOutcome {
                    attempt_id: &attempt_id,
                    instructions,
                    turn_id: &turn_context.sub_id,
                    model_slug,
                    input,
                    status: smart_prune_audit::AttemptStatus::TimedOut,
                    raw_response: raw_response.as_deref(),
                    error: Some(&error),
                    candidate_outputs,
                    admitted_outputs: 0,
                    saved_tokens: 0,
                    latency: elapsed,
                    usage,
                    admission_id: None,
                },
            )
            .await;
            Err(OptimizerAttemptFailure::Failed)
        }
        Err(err) => {
            let error = format!("{err:#}");
            tracing::warn!(
                model = model_slug,
                "Smart Prune optimizer attempt failed: {error}"
            );
            record_attempt(
                sess,
                AttemptOutcome {
                    attempt_id: &attempt_id,
                    instructions,
                    turn_id: &turn_context.sub_id,
                    model_slug,
                    input,
                    status: smart_prune_audit::AttemptStatus::ModelError,
                    raw_response: raw_response.as_deref(),
                    error: Some(&error),
                    candidate_outputs,
                    admitted_outputs: 0,
                    saved_tokens: 0,
                    latency: elapsed,
                    usage,
                    admission_id: None,
                },
            )
            .await;
            Err(OptimizerAttemptFailure::Failed)
        }
    }
}

async fn record_batch_failure(sess: &Session, turn_id: &str, examined: usize) {
    let mut state = sess.state.lock().await;
    state.smart_prune.failed_turn_id = Some(turn_id.to_string());
    let snapshot = &mut state.smart_prune.snapshot;
    snapshot.examined_outputs = snapshot.examined_outputs.saturating_add(examined as u64);
    // Fail-open preserves the original candidate outputs, so they are unchanged even though
    // the optimizer batch failed. Keep the accounting partition complete.
    snapshot.unchanged_outputs = snapshot.unchanged_outputs.saturating_add(examined as u64);
    snapshot.failed_batches = snapshot.failed_batches.saturating_add(1);
}

async fn record_optimizer_started(sess: &Session) {
    let mut state = sess.state.lock().await;
    let snapshot = &mut state.smart_prune.snapshot;
    snapshot.optimizer_requests = snapshot.optimizer_requests.saturating_add(1);
}

async fn record_optimizer_finished(sess: &Session, elapsed: Duration, usage: Option<&TokenUsage>) {
    let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    let mut state = sess.state.lock().await;
    let snapshot = &mut state.smart_prune.snapshot;
    snapshot.optimizer_latency_ms = snapshot.optimizer_latency_ms.saturating_add(elapsed_ms);
    if let Some(usage) = usage {
        snapshot.optimizer_usage_reports = snapshot.optimizer_usage_reports.saturating_add(1);
        snapshot.optimizer_usage.add_assign(usage);
    }
}

async fn record_attempt(sess: &Session, outcome: AttemptOutcome<'_>) {
    let elapsed_ms = u64::try_from(outcome.latency.as_millis()).unwrap_or(u64::MAX);
    let log_dir = sess.smart_prune_log_dir().await;
    let session_id = sess.session_id().to_string();
    let audit_path = match smart_prune_audit::write_attempt(
        &log_dir,
        smart_prune_audit::AttemptAuditInput {
            attempt_id: outcome.attempt_id,
            session_id: &session_id,
            turn_id: outcome.turn_id,
            status: outcome.status,
            model_slug: outcome.model_slug,
            reasoning_effort: SMART_PRUNE_REASONING_EFFORT.as_str(),
            instructions: outcome.instructions,
            input: outcome.input,
            raw_response: outcome.raw_response,
            error: outcome.error,
            candidate_outputs: outcome.candidate_outputs,
            admitted_outputs: outcome.admitted_outputs,
            saved_tokens: outcome.saved_tokens,
            latency_ms: elapsed_ms,
            usage: outcome.usage,
            admission_id: outcome.admission_id,
        },
    ) {
        Ok(receipt) => Some(receipt.audit_path.to_string_lossy().into_owned()),
        Err(err) => {
            tracing::warn!(
                attempt_id = outcome.attempt_id,
                "Smart Prune attempt evidence could not be published: {err:#}"
            );
            None
        }
    };

    let mut state = sess.state.lock().await;
    state.smart_prune.snapshot.latest_attempt = Some(SmartPruneAttemptSnapshot {
        attempt_id: outcome.attempt_id.to_string(),
        audit_path,
        status: outcome.status.as_str().to_string(),
        model_slug: outcome.model_slug.to_string(),
        reasoning_effort: SMART_PRUNE_REASONING_EFFORT.as_str().to_string(),
        candidate_outputs: outcome.candidate_outputs as u64,
        admitted_outputs: outcome.admitted_outputs as u64,
        approx_saved_tokens: outcome.saved_tokens as u64,
        latency_ms: elapsed_ms,
        usage: outcome.usage.cloned(),
    });
}

async fn record_unchanged_batch(sess: &Session, examined: usize) {
    let mut state = sess.state.lock().await;
    let snapshot = &mut state.smart_prune.snapshot;
    snapshot.examined_outputs = snapshot.examined_outputs.saturating_add(examined as u64);
    snapshot.unchanged_outputs = snapshot.unchanged_outputs.saturating_add(examined as u64);
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
    let snapshot = &mut state.smart_prune.snapshot;
    snapshot.examined_outputs = snapshot.examined_outputs.saturating_add(examined as u64);
    snapshot.admitted_outputs = snapshot.admitted_outputs.saturating_add(admitted);
    snapshot.unchanged_outputs = snapshot
        .unchanged_outputs
        .saturating_add((examined as u64).saturating_sub(admitted));
    snapshot.approx_source_tokens = snapshot.approx_source_tokens.saturating_add(source_tokens);
    snapshot.approx_admitted_tokens = snapshot
        .approx_admitted_tokens
        .saturating_add(admitted_tokens);
    snapshot.approx_saved_tokens = snapshot.approx_saved_tokens.saturating_add(saved_tokens);
    snapshot.latest = Some(SmartPruneAdmissionSnapshot {
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
        let state = self.state.lock().await;
        let mut snapshot = state.smart_prune.snapshot.clone();
        snapshot.enabled = state
            .session_configuration
            .original_config_do_not_use
            .features
            .enabled(Feature::AutomaticContextPruning);
        snapshot
    }

    /// The tool runtime keeps this output exact: post-tool hook feedback or a
    /// runtime-generated failure (`tools/parallel.rs`).
    pub(crate) async fn mark_smart_prune_ineligible(&self, call_id: &str) {
        self.state
            .lock()
            .await
            .smart_prune
            .ineligible_call_ids
            .insert(call_id.to_string());
    }

    /// Removes and returns the marks for `pending`, so none outlives its batch.
    async fn take_smart_prune_ineligible_call_ids(
        &self,
        pending: &[ResponseItemEnvelope],
    ) -> HashSet<String> {
        let mut state = self.state.lock().await;
        let marks = &mut state.smart_prune.ineligible_call_ids;
        pending
            .iter()
            .filter_map(|envelope| response_item_output_call_id(&envelope.item))
            .filter(|call_id| marks.remove(*call_id))
            .map(str::to_string)
            .collect()
    }

    async fn smart_prune_log_dir(&self) -> std::path::PathBuf {
        let state = self.state.lock().await;
        state
            .session_configuration
            .codex_home()
            .join("logs")
            .to_path_buf()
    }

    /// Hash and durably link the logical prompt input before transport adaptation.
    ///
    /// Every main-model attempt takes a sequence number; only the first attempt after an
    /// admission is hashed and linked, so requests without a fresh admission cost nothing.
    pub(crate) async fn record_smart_prune_request(
        &self,
        input: &[ResponseItem],
    ) -> Option<SmartPruneRequestLink> {
        let link = {
            let mut state = self.state.lock().await;
            let snapshot = &mut state.smart_prune.snapshot;
            snapshot.main_request_sequence = snapshot.main_request_sequence.saturating_add(1);
            let sequence = snapshot.main_request_sequence;
            snapshot
                .latest
                .as_mut()
                .filter(|latest| latest.request_sequence.is_none())
                .map(|latest| {
                    latest.request_sequence = Some(sequence);
                    SmartPruneRequestLink {
                        admission_id: latest.admission_id.clone(),
                        audit_path: latest.audit_path.clone(),
                        request_sequence: sequence,
                    }
                })
        }?;
        let hash = match serde_json::to_vec(input) {
            Ok(bytes) => Some(format!("{:x}", Sha256::digest(bytes))),
            Err(err) => {
                tracing::warn!("Smart Prune request hashing failed: {err}");
                None
            }
        };
        let verified = match &hash {
            Some(hash) => smart_prune_audit::write_request_linkage(
                &self.smart_prune_log_dir().await,
                std::path::Path::new(&link.audit_path),
                &link.admission_id,
                link.request_sequence,
                hash,
            )
            .is_ok(),
            None => false,
        };
        if !verified {
            tracing::warn!("Smart Prune request linkage could not be published");
        }
        let mut state = self.state.lock().await;
        if let Some(latest) = state.smart_prune.snapshot.latest.as_mut()
            && latest.admission_id == link.admission_id
            && latest.request_sequence == Some(link.request_sequence)
        {
            latest.request_input_sha256 = hash;
            latest.request_linkage_verified = verified;
        }
        Some(link)
    }

    pub(crate) async fn record_smart_prune_response(
        &self,
        request_link: &SmartPruneRequestLink,
        response_id: &str,
        usage: Option<&TokenUsage>,
    ) {
        let log_dir = self.smart_prune_log_dir().await;
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
        if let Some(latest) = state.smart_prune.snapshot.latest.as_mut()
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

fn select_candidates(
    pending: &[ResponseItemEnvelope],
    ineligible: &HashSet<String>,
) -> Vec<Candidate> {
    let mut selected = Vec::new();
    let mut selected_tokens = 0usize;
    for (pending_index, envelope) in pending.iter().enumerate() {
        let mut source = envelope.item.clone();
        // The optimizer and the audit see the tool output, not the harness's bookkeeping.
        source.clear_internal_chat_message_metadata_passthrough();
        let Some((call_id, source_tokens)) = textual_tool_output(&source)
            .map(|(call_id, text)| (call_id.to_string(), approx_token_count(text.as_ref())))
        else {
            continue;
        };
        if ineligible.contains(&call_id)
            || source_tokens < MIN_SOURCE_TOKENS
            || selected_tokens.saturating_add(source_tokens) > MAX_PRUNE_BATCH_TOKENS
        {
            continue;
        }
        selected_tokens = selected_tokens.saturating_add(source_tokens);
        selected.push(Candidate {
            pending_index,
            call_id,
            source,
            source_tokens,
        });
    }
    selected
}

fn build_admission_input<'a>(
    history: impl Clone + DoubleEndedIterator<Item = &'a ResponseItem>,
    candidates: &[Candidate],
) -> anyhow::Result<String> {
    let active_question = crate::context_pruner::latest_user_message_text(history.clone());
    let items = candidates
        .iter()
        .map(|candidate| {
            let invocation = history
                .clone()
                .rev()
                .find(|item| response_item_call_id(item) == Some(candidate.call_id.as_str()))
                .map(|item| {
                    let mut invocation = item.clone();
                    invocation.clear_internal_chat_message_metadata_passthrough();
                    invocation
                });
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

#[allow(clippy::too_many_arguments)]
async fn run_model_admission(
    sess: &Arc<Session>,
    step_context: &StepContext,
    input: String,
    primary_model: &str,
    primary_provider: Option<&str>,
    instructions: &str,
    inactivity_timeout: Duration,
    progress: &mut OptimizerProgress,
) -> anyhow::Result<ModelAdmission> {
    let turn_context = step_context.turn.as_ref();
    let model_info = sess
        .services
        .models_manager
        .get_model_info(primary_model, &turn_context.config.to_models_manager_config())
        .await;
    let model_slug = model_info.slug.clone();
    let prompt = optimizer_prompt(input.clone(), instructions);
    let metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "smart-prune".to_string(),
        CodexResponsesRequestKind::SmartPrune,
    );
    let model_client = &sess.services.model_client;
    // The pruner's model is chosen separately from the chat model, so the provider that
    // serves it has to travel with it instead of defaulting to the one this session happens
    // to be talking to.
    let provider =
        crate::context_pruner::pruner_provider_info(primary_provider, &turn_context.config)?
            .unwrap_or_else(|| model_client.provider_info());
    let mut client_session = model_client
        .with_provider(optimizer_provider_with_timeouts(
            provider,
            inactivity_timeout,
        ))
        .new_session();
    let mut stream = tokio::time::timeout(
        inactivity_timeout,
        client_session.stream(
            &prompt,
            &model_info,
            &step_context.session_telemetry,
            Some(SMART_PRUNE_REASONING_EFFORT),
            step_context.settings.reasoning_summary,
            step_context.settings.service_tier.clone(),
            &metadata,
            &InferenceTraceContext::disabled(),
        ),
    )
    .await
    .map_err(|_| OptimizerInactivityTimeout(inactivity_timeout))??;

    let raw_response =
        collect_optimizer_response(&mut stream, inactivity_timeout, progress).await?;
    Ok(ModelAdmission {
        instructions: instructions.to_string(),
        attempt_id: String::new(),
        raw_response,
        usage: progress.usage.clone(),
        model_slug,
        input,
        latency: Duration::ZERO,
    })
}

/// The optimizer request: one user message and the strict decision-manifest schema.
fn optimizer_prompt(input: String, instructions: &str) -> Prompt {
    Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText { text: input }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: instructions.to_string(),
            ..Default::default()
        },
        output_schema: Some(crate::smart_prune::decision_manifest_schema()),
        output_schema_strict: true,
        ..Default::default()
    }
}

/// The optimizer's raw decision manifest and the model that wrote it.
pub struct OptimizerReply {
    pub raw_response: String,
    pub model_slug: String,
}

/// Smart Prune decisions outside a session. The `elpis claude` proxy asks the same
/// optimizer, with the same `pruner.json` settings and prompt, that a session asks.
pub struct StandaloneOptimizer {
    config: Arc<crate::config::Config>,
    auth_manager: Arc<codex_login::AuthManager>,
    models_manager: codex_models_manager::manager::SharedModelsManager,
    thread_id: codex_protocol::ThreadId,
}

impl StandaloneOptimizer {
    pub fn new(
        config: Arc<crate::config::Config>,
        auth_manager: Arc<codex_login::AuthManager>,
    ) -> Self {
        let models_manager = crate::build_models_manager(&config, Arc::clone(&auth_manager));
        Self {
            config,
            auth_manager,
            models_manager,
            thread_id: codex_protocol::ThreadId::new(),
        }
    }

    /// Sends one admission input and returns the raw manifest. The caller parses it
    /// with `parse_decision_manifest` and keeps the source on any error.
    pub async fn decide(&self, input: String) -> anyhow::Result<OptimizerReply> {
        let config = self.config.as_ref();
        let settings = crate::pruner_settings::PrunerSettings::load(&config.codex_home)?;
        let instructions = settings
            .system_prompt
            .as_deref()
            .unwrap_or(SMART_PRUNE_INSTRUCTIONS);
        let default_slug =
            if config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID {
                PRUNE_MODEL_SLUG
            } else {
                config.model.as_deref().unwrap_or(PRUNE_MODEL_SLUG)
            };
        let model_slug = settings.model.clone().unwrap_or_else(|| {
            crate::context_pruner::background_model_slug(
                config.background_model.as_deref(),
                default_slug,
            )
            .to_string()
        });
        let provider =
            crate::context_pruner::pruner_provider_info(settings.provider.as_deref(), config)?
                .unwrap_or_else(|| config.model_provider.clone());
        let model_info = self
            .models_manager
            .get_model_info(&model_slug, &config.to_models_manager_config())
            .await;
        let session_source = codex_protocol::protocol::SessionSource::Exec;
        let originator = codex_login::default_client::originator().value;
        let model_client = crate::ModelClient::new(
            Some(Arc::clone(&self.auth_manager)),
            codex_login::AgentIdentityAuthPolicy::JwtOnly,
            self.thread_id,
            optimizer_provider_with_timeouts(provider, ADMISSION_TIMEOUT),
            session_source.clone(),
            originator.clone(),
            config.model_verbosity,
            config.features.enabled(Feature::ContentItemKinds),
            config.features.enabled(Feature::ReasoningEffortOverride),
            config.features.enabled(Feature::EnableRequestCompression),
            config.features.enabled(Feature::RuntimeMetrics),
            /*beta_features_header*/ None,
            /*concurrent_reasoning_summaries_enabled*/ false,
            /*attestation_provider*/ None,
            config.http_client_factory(),
            config.workspace_routing_context(),
            Vec::new(),
        );
        let telemetry = codex_otel::SessionTelemetry::new(
            self.thread_id,
            &model_slug,
            &model_slug,
            /*account_id*/ None,
            /*account_email*/ None,
            /*auth_mode*/ None,
            originator,
            /*log_user_prompts*/ false,
            codex_terminal_detection::user_agent(),
            session_source,
        );
        let thread_id = self.thread_id.to_string();
        let metadata = crate::responses_metadata::CodexResponsesMetadata {
            request_kind: Some(CodexResponsesRequestKind::SmartPrune),
            ..crate::responses_metadata::CodexResponsesMetadata::new(
                crate::resolve_installation_id(&config.codex_home).await?,
                thread_id.clone(),
                thread_id.clone(),
                format!("{thread_id}:0"),
            )
        };
        let prompt = optimizer_prompt(input, instructions);
        let mut client_session = model_client.new_session();
        let mut stream = tokio::time::timeout(
            ADMISSION_TIMEOUT,
            client_session.stream(
                &prompt,
                &model_info,
                &telemetry,
                Some(SMART_PRUNE_REASONING_EFFORT),
                config
                    .model_reasoning_summary
                    .unwrap_or(model_info.default_reasoning_summary),
                /*service_tier*/ None,
                &metadata,
                &InferenceTraceContext::disabled(),
            ),
        )
        .await
        .map_err(|_| OptimizerInactivityTimeout(ADMISSION_TIMEOUT))??;
        let mut progress = OptimizerProgress::default();
        let raw_response =
            collect_optimizer_response(&mut stream, ADMISSION_TIMEOUT, &mut progress).await?;
        Ok(OptimizerReply {
            raw_response,
            model_slug,
        })
    }
}

/// The pruner's model when `/pruner-model` sets none: the background model, else Luna on
/// OpenAI, else this step's own model.
fn selected_model_slug(step_context: &StepContext) -> &str {
    let config = &step_context.turn.config;
    let default_slug = if config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID
    {
        PRUNE_MODEL_SLUG
    } else {
        step_context.settings.model_info.slug.as_str()
    };
    crate::context_pruner::background_model_slug(config.background_model.as_deref(), default_slug)
}

fn response_item_call_id(item: &ResponseItem) -> Option<&str> {
    match item {
        ResponseItem::FunctionCall { call_id, .. }
        | ResponseItem::CustomToolCall { call_id, .. } => Some(call_id),
        _ => None,
    }
}

fn response_item_output_call_id(item: &ResponseItem) -> Option<&str> {
    match item {
        ResponseItem::FunctionCallOutput {
            call_id: Some(call_id),
            ..
        }
        | ResponseItem::CustomToolCallOutput { call_id, .. } => Some(call_id),
        _ => None,
    }
}

/// Puts the admitted body into the pending output, keeping its envelope and metadata.
fn admit_body(item: &mut ResponseItem, admitted: ResponseItem) -> bool {
    let body = match admitted {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => output.body,
        _ => return false,
    };
    match item {
        ResponseItem::FunctionCallOutput { output, .. }
        | ResponseItem::CustomToolCallOutput { output, .. } => {
            output.body = body;
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::FunctionCallOutputBody;
    use codex_protocol::models::FunctionCallOutputContentItem;
    use codex_protocol::models::FunctionCallOutputPayload;
    use codex_protocol::models::ImageReference;
    use pretty_assertions::assert_eq;

    fn function_output(call_id: &str, text: String) -> ResponseItemEnvelope {
        ResponseItemEnvelope::new(ResponseItem::FunctionCallOutput {
            id: None,
            call_id: Some(call_id.to_string()),
            name: None,
            namespace: None,
            output: FunctionCallOutputPayload::from_text(text),
            internal_chat_message_metadata_passthrough: None,
        })
    }

    #[test]
    fn selection_is_large_text_only_bounded_and_preserves_hook_opt_out() {
        let large = "evidence line\n".repeat(2_000);
        let pending = vec![
            function_output("small", "tiny".to_string()),
            function_output("large", large.clone()),
            function_output("hook", large),
        ];
        let ineligible = HashSet::from(["hook".to_string()]);
        let selected = select_candidates(&pending, &ineligible);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].call_id, "large");
        assert_eq!(selected[0].pending_index, 1);
    }

    #[test]
    fn admitted_body_keeps_the_custom_envelope_fields() {
        let mut item = ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: "custom-1".to_string(),
            name: Some("database".to_string()),
            output: FunctionCallOutputPayload::from_text("result".to_string()),
            internal_chat_message_metadata_passthrough: None,
        };
        let admitted = ResponseItem::CustomToolCallOutput {
            id: None,
            call_id: "custom-1".to_string(),
            name: None,
            output: FunctionCallOutputPayload::from_text("compact".to_string()),
            internal_chat_message_metadata_passthrough: None,
        };
        assert!(admit_body(&mut item, admitted));
        assert_eq!(
            item,
            ResponseItem::CustomToolCallOutput {
                id: None,
                call_id: "custom-1".to_string(),
                name: Some("database".to_string()),
                output: FunctionCallOutputPayload::from_text("compact".to_string()),
                internal_chat_message_metadata_passthrough: None,
            }
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
                .smart_prune
                .failed_turn_id
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
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
            ..Default::default()
        };
        let second = TokenUsage {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
            total_tokens: 25,
            ..Default::default()
        };

        record_optimizer_started(&session).await;
        record_optimizer_finished(&session, Duration::from_millis(7), Some(&first)).await;
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
    }

    #[tokio::test]
    async fn request_linking_completes_after_an_admission() {
        let (session, _) = crate::session::tests::make_session_and_context().await;
        record_applied_admission(&session, "deadlock-regression", 1, &[]).await;

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            session.record_smart_prune_request(&[]),
        )
        .await;

        assert!(result.is_ok(), "Smart Prune request linking deadlocked");
    }

    #[tokio::test]
    async fn ineligible_marks_are_consumed_by_their_batch() {
        let (session, _) = crate::session::tests::make_session_and_context().await;
        session.mark_smart_prune_ineligible("hook").await;
        session.mark_smart_prune_ineligible("other-batch").await;
        let pending = vec![function_output("hook", "x".to_string())];

        let taken = session.take_smart_prune_ineligible_call_ids(&pending).await;

        assert_eq!(taken, HashSet::from(["hook".to_string()]));
        assert_eq!(
            session
                .state
                .lock()
                .await
                .smart_prune
                .ineligible_call_ids,
            HashSet::from(["other-batch".to_string()])
        );
    }

    #[test]
    fn optimizer_waits_for_three_minutes_of_inactivity() {
        assert_eq!(ADMISSION_TIMEOUT, Duration::from_secs(180));
    }

    #[test]
    fn optimizer_transport_limits_do_not_shorten_its_allowance_or_change_main_policy() {
        let original = codex_model_provider_info::ModelProviderInfo::create_openai_provider(None);
        let adjusted = optimizer_provider_with_timeouts(original.clone(), ADMISSION_TIMEOUT);
        assert!(original.websocket_connect_timeout() < ADMISSION_TIMEOUT);
        assert_eq!(adjusted.websocket_connect_timeout(), ADMISSION_TIMEOUT);

        let mut short = original.clone();
        short.websocket_connect_timeout_ms = Some(5_000);
        short.stream_idle_timeout_ms = Some(5_000);
        let adjusted = optimizer_provider_with_timeouts(short, ADMISSION_TIMEOUT);
        assert_eq!(adjusted.websocket_connect_timeout(), ADMISSION_TIMEOUT);
        assert_eq!(adjusted.stream_idle_timeout(), ADMISSION_TIMEOUT);

        let mut longer = original;
        longer.websocket_connect_timeout_ms = Some(240_000);
        longer.stream_idle_timeout_ms = Some(450_000);
        let adjusted = optimizer_provider_with_timeouts(longer, ADMISSION_TIMEOUT);
        assert_eq!(
            adjusted.websocket_connect_timeout(),
            Duration::from_secs(240)
        );
        assert_eq!(adjusted.stream_idle_timeout(), Duration::from_secs(450));
    }

    fn optimizer_completed_event() -> ResponseEvent {
        ResponseEvent::Completed {
            response_id: "optimizer-completed".to_string(),
            token_usage: None,
            usage_metadata: None,
            end_turn: Some(true),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn optimizer_returns_completed_answer_without_waiting_for_stream_close() {
        let events = vec![
            Ok(ResponseEvent::OutputTextDelta(
                "completed answer".to_string(),
            )),
            Ok(optimizer_completed_event()),
        ];
        let mut stream = futures::stream::iter(events).chain(futures::stream::pending());
        let mut progress = OptimizerProgress::default();
        let answer = tokio::time::timeout(
            Duration::from_millis(1),
            collect_optimizer_response(&mut stream, ADMISSION_TIMEOUT, &mut progress),
        )
        .await
        .expect("a completed answer must not wait for EOF")
        .expect("completed answer should be usable");
        assert_eq!(answer, "completed answer");
    }

    #[tokio::test(start_paused = true)]
    async fn optimizer_never_admits_unfinished_output_or_empty_completion() {
        let mut unfinished = futures::stream::iter(vec![Ok(ResponseEvent::OutputTextDelta(
            "partial answer".to_string(),
        ))]);
        let mut progress = OptimizerProgress::default();
        let error = collect_optimizer_response(&mut unfinished, ADMISSION_TIMEOUT, &mut progress)
            .await
            .expect_err("EOF without completion is not an answer");
        assert!(error.to_string().contains("before response.completed"));
        assert_eq!(progress.raw_response().as_deref(), Some("partial answer"));

        let mut empty = futures::stream::iter(vec![Ok(optimizer_completed_event())]);
        assert!(
            collect_optimizer_response(
                &mut empty,
                ADMISSION_TIMEOUT,
                &mut OptimizerProgress::default()
            )
            .await
            .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn optimizer_inactivity_clock_restarts_after_each_stream_item() {
        let mut stream = Box::pin(futures::stream::unfold(0, |item| async move {
            if item == 2 {
                None
            } else {
                tokio::time::sleep(Duration::from_secs(120)).await;
                Some((item, item + 1))
            }
        }));
        let started = tokio::time::Instant::now();

        assert_eq!(
            next_optimizer_stream_item(&mut stream, ADMISSION_TIMEOUT).await,
            Ok(Some(0))
        );
        assert_eq!(
            next_optimizer_stream_item(&mut stream, ADMISSION_TIMEOUT).await,
            Ok(Some(1))
        );
        assert_eq!(started.elapsed(), Duration::from_secs(240));
    }

    #[tokio::test(start_paused = true)]
    async fn optimizer_inactivity_clock_expires_after_three_silent_minutes() {
        let mut stream = Box::pin(futures::stream::unfold(false, |sent| async move {
            if sent {
                None
            } else {
                tokio::time::sleep(Duration::from_secs(181)).await;
                Some(((), true))
            }
        }));

        let error = next_optimizer_stream_item(&mut stream, ADMISSION_TIMEOUT)
            .await
            .expect_err("a silent optimizer stream must time out");
        assert_eq!(
            error.to_string(),
            "180-second optimizer inactivity timeout elapsed"
        );
    }

    #[test]
    fn multimodal_output_is_not_a_candidate() {
        let pending = vec![ResponseItemEnvelope::new(ResponseItem::FunctionCallOutput {
            id: None,
            call_id: Some("mixed-image".to_string()),
            name: None,
            namespace: None,
            output: FunctionCallOutputPayload {
                body: FunctionCallOutputBody::ContentItems(vec![
                    FunctionCallOutputContentItem::InputText {
                        text: "evidence line\n".repeat(2_000),
                    },
                    FunctionCallOutputContentItem::InputImage {
                        image: ImageReference::Inline {
                            image_url: "data:image/png;base64,AA==".to_string(),
                        },
                        detail: None,
                    },
                ]),
                success: Some(true),
            },
            internal_chat_message_metadata_passthrough: None,
        })];
        assert!(select_candidates(&pending, &HashSet::new()).is_empty());
    }
}

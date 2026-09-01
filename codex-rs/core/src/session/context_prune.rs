//! Runs the Ace pass (`crate::context_pruner`) under whichever trigger applies: the
//! steady backlog floor, the 30% pressure boundary, or a manual `/prune`. Mirrors
//! `super::token_budget::maybe_record`: a small, independent, isolated step called
//! from the turn loop. Any failure here is swallowed and never propagated — a broken,
//! slow, or unavailable pruning pass must never break or stall the user's actual
//! turn.

use std::sync::Arc;

use crate::client::ModelClientSession;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::context_pruner;
use crate::responses_metadata::CodexResponsesRequestKind;
use codex_features::Feature;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::CompactedItem;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::WorldStateItem;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

/// Upper bound on the passes one `/prune` sweep will run, so an explicit sweep is
/// bounded even if the backlog keeps producing eligible batches.
const MAX_MANUAL_PRUNE_PASSES: usize = 12;

use super::context_prune_audit;
use super::session::Session;
use super::turn_context::TurnContext;

/// Whether an exhausted pressure pass may escalate to a context-window rollover.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Escalation {
    Allowed,
    Deferred,
}

struct PruneCancelled;

async fn await_or_cancelled<T>(
    cancellation_token: Option<&CancellationToken>,
    future: impl std::future::Future<Output = T>,
) -> Result<T, PruneCancelled> {
    match cancellation_token {
        Some(cancellation_token) => {
            tokio::select! {
                biased;
                _ = cancellation_token.cancelled() => Err(PruneCancelled),
                output = future => Ok(output),
            }
        }
        None => Ok(future.await),
    }
}

pub(super) async fn maybe_run_context_prune(sess: &Arc<Session>, turn_context: &Arc<TurnContext>) {
    if !turn_context
        .config
        .features
        .enabled(Feature::AutomaticContextPruning)
    {
        return;
    }
    run_context_prune(
        sess,
        turn_context,
        None,
        None,
        Escalation::Allowed,
        None,
    )
    .await;
}

/// The pre-request pass. Reclaims what it can so the history sent to the provider,
/// the context-limit check, and the UI snapshot describe the same state — but leaves
/// the rollover decision to the post-sampling pass, which already owns it and sees
/// fresh usage. Escalating here would stack a second rollover on top of one the model
/// just requested through `new_context`.
pub(super) async fn prune_before_request(sess: &Arc<Session>, turn_context: &Arc<TurnContext>) {
    if !turn_context
        .config
        .features
        .enabled(Feature::AutomaticContextPruning)
    {
        return;
    }
    run_context_prune(
        sess,
        turn_context,
        None,
        None,
        Escalation::Deferred,
        None,
    )
    .await;
}

pub(crate) async fn run_manual_context_prune(sess: &Arc<Session>, turn_context: &Arc<TurnContext>) {
    run_manual_context_prune_with_target(sess, turn_context, None, None).await;
}

pub(crate) async fn run_manual_context_prune_with_target(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    target_pct: Option<i64>,
    cancellation_token: Option<&CancellationToken>,
) {
    if let Some(pct) = target_pct {
        run_context_prune(
            sess,
            turn_context,
            Some(context_pruner::PruneTrigger::Pressure),
            Some(pct),
            Escalation::Allowed,
            cancellation_token,
        )
        .await;
        return;
    }
    // A single pass is capped so one model call stays bounded, but a bare `/prune` is
    // an explicit request to clear the backlog — so sweep it in bounded passes rather
    // than leaving the user with a partial reclaim and no indication why.
    for _ in 0..MAX_MANUAL_PRUNE_PASSES {
        if !run_context_prune(
            sess,
            turn_context,
            Some(context_pruner::PruneTrigger::Manual),
            None,
            Escalation::Allowed,
            cancellation_token,
        )
        .await
        {
            break;
        }
    }
}

/// Hands off to the existing compaction/rollover mechanism when Ace pruning cannot
/// (or, for a spent pressure episode, must not) reclaim any further. Setting the
/// request flag is idempotent -- repeated calls before it is consumed by the turn
/// loop do not queue up multiple rollovers.
async fn request_compaction_if_enabled(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    active_context_tokens: i64,
    reason: &str,
) {
    if turn_context.config.automatic_compaction_enabled() {
        tracing::info!(
            "Context pruning is exhausted ({reason}) at {active_context_tokens} tokens; requesting compaction"
        );
        sess.request_new_context_window().await;
    } else {
        tracing::info!(
            "Context pruning is exhausted ({reason}) at {active_context_tokens} tokens; automatic compaction is disabled"
        );
    }
}

async fn run_context_prune(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    requested_trigger: Option<context_pruner::PruneTrigger>,
    target_pct: Option<i64>,
    escalation: Escalation,
    cancellation_token: Option<&CancellationToken>,
) -> bool {
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return false;
    }
    let context_window = turn_context.model_context_window().unwrap_or(0);
    if requested_trigger.is_none() && context_window <= 0 {
        return false;
    }

    let active_context_tokens = sess.get_total_token_usage().await;

    let covered_call_ids = {
        let state = sess.state.lock().await;
        // A failed pass leaves its batch uncovered, so the next turn selects exactly
        // the same batch. Without this gate that repeats every turn indefinitely.
        if requested_trigger.is_none() && state.context_prune_backoff_active() {
            return false;
        }
        state.context_prune_covered.clone()
    };

    let history = sess.clone_history().await;
    let items = history.raw_items().to_vec();
    let before_model_items = history
        .clone()
        .for_prompt(&turn_context.model_info.input_modalities);
    let pressure_uncovered =
        context_pruner::uncovered_pressure_tokens(&items, &covered_call_ids, context_window);
    let trigger = requested_trigger.or_else(|| {
        context_pruner::select_trigger(active_context_tokens, pressure_uncovered, context_window)
    });

    // The hysteresis gate, and the only place an automatic pass is authorised.
    //
    // Every automatic check feeds the current measurement in: a cooling cycle re-arms
    // here, and *only* here, once use has climbed back to the 30% trigger. While it is
    // cooling `may_run` is false and we return without so much as selecting a batch, so
    // the 20-30% band cannot produce a pass of any kind. An open cycle keeps its
    // remaining budget available back-to-back, because those passes are one cycle
    // finishing its descent rather than separate cycles.
    if requested_trigger.is_none() {
        let mut state = sess.state.lock().await;
        if !state.observe_context_prune_usage(active_context_tokens, context_window) {
            let stalled = state.context_prune_cycle_stalled();
            drop(state);
            // A cycle that closed without reaching its target, while use is still past
            // the boundary, is the case the existing compaction/rollover mechanism owns.
            // A cycle merely cooling below the boundary is healthy and hands off nothing.
            if stalled
                && escalation == Escalation::Allowed
                && context_pruner::pressure_reached(active_context_tokens, context_window)
            {
                request_compaction_if_enabled(
                    sess,
                    turn_context,
                    active_context_tokens,
                    "the pruning cycle's Ace pass budget is spent",
                )
                .await;
            }
            return false;
        }
    }

    let batch = match trigger {
        Some(context_pruner::PruneTrigger::Manual) => {
            context_pruner::build_manual_prune_batch(&items, &covered_call_ids)
        }
        Some(context_pruner::PruneTrigger::Pressure) => {
            let pct = target_pct.unwrap_or(context_pruner::AUTO_PRUNE_TARGET_PERCENT);
            // Reclaim the distance from what the window holds now down to `pct`, and
            // no further. Anything larger distills evidence the session still needs.
            let reclaim_target =
                context_pruner::reclaim_target_tokens(active_context_tokens, context_window, pct);
            context_pruner::build_prune_batch_for_reclaim(
                &items,
                &covered_call_ids,
                reclaim_target,
                context_window,
            )
        }
        None => Vec::new(),
    };
    let Some((trigger, batch)) = trigger.zip((!batch.is_empty()).then_some(batch)) else {
        // Nothing reclaimable. Past the pressure boundary that means distillation is
        // exhausted — the window is full of messages and reasoning rather than tool
        // evidence — so the working set would climb from here with no layer left to
        // stop it. Hand off to compaction instead of letting it drift toward the
        // model's hard limit. The turn loop performs the rollover on its next step.
        // Only a cycle that actually wanted to prune is ended here. When the trigger did
        // not resolve at all, use is simply below the boundary and no cycle is running --
        // closing one then would leave the gate cooling with no sub-trigger observation
        // still owed, and pruning could never re-arm.
        if requested_trigger.is_none() && trigger == Some(context_pruner::PruneTrigger::Pressure) {
            sess.state.lock().await.close_context_prune_cycle();
            if escalation == Escalation::Allowed {
                request_compaction_if_enabled(
                    sess,
                    turn_context,
                    active_context_tokens,
                    "nothing left to reclaim",
                )
                .await;
            }
        }
        return false;
    };
    let active_question = context_pruner::latest_user_message_text(&items);
    // Keep maintenance inference isolated from the active turn's sticky routing and
    // incremental request state. This lets the pressure check run between tool
    // follow-ups without perturbing the user's model session.
    let mut prune_client_session = sess.services.model_client.load().new_session();

    let (pass_result, attempts) = match run_prune_pass(
        sess,
        turn_context,
        &mut prune_client_session,
        &batch,
        active_question.as_deref(),
        cancellation_token,
    )
    .await {
        Ok(result) => result,
        Err(PruneCancelled) => return false,
    };
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return false;
    }

    let Some((record, raw, model_slug, usage, pass_id)) = pass_result else {
        let log_dir = sess.codex_home().await.join("logs");
        let mut state = sess.state.lock().await;
        if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
            return false;
        }
        if let Err(err) = context_prune_audit::record_failed_attempts(&log_dir, &attempts) {
            tracing::warn!("Failed to record failed pruning attempt audit: {err:#}");
        }
        // Fail open. A failed or malformed pruning pass must not alter history or
        // mark any item as covered; the same batch remains eligible for a later pass,
        // once the backoff this records has elapsed.
        let failures = state.record_context_prune_failure();
        tracing::warn!(
            "Context prune pass failed ({failures} in a row); retrying after {:?}",
            context_pruner::retry_delay_after_failures(failures)
        );
        return false;
    };

    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return false;
    }
    let mut after_items = items;
    let saved = context_pruner::apply_prune_record_untracked(&mut after_items, &record);
    let mut after_history = history;
    after_history.replace(after_items.clone());
    let after_model_items = after_history.for_prompt(&turn_context.model_info.input_modalities);
    let ace_input = context_pruner::build_prune_input(&batch, active_question.as_deref());
    let log_dir = sess.codex_home().await.join("logs");
    let session_id = sess.session_id().to_string();
    let mut state = sess.state.lock().await;
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return false;
    }
    let audit = match context_prune_audit::write_applied_pass(
        &log_dir,
        context_prune_audit::PruneAuditInput {
            pass_id: &pass_id,
            session_id: Some(&session_id),
            turn_id: Some(turn_context.sub_id.as_str()),
            trigger: trigger.as_str(),
            model_slug: &model_slug,
            ace_instructions: codex_prompts::CONTEXT_PRUNE_PROMPT,
            ace_input: &ace_input,
            raw_response: &raw,
            usage: usage.as_ref(),
            attempts: &attempts,
            batch: &batch,
            record: &record,
            before_model_items: &before_model_items,
            after_model_items: &after_model_items,
            saved_chars: saved,
        },
    ) {
        Ok(audit) => audit,
        Err(err) => {
            tracing::warn!("Context prune audit failed; preserving history: {err:#}");
            state.record_context_prune_failure();
            return false;
        }
    };

    let saved_tokens = codex_utils_string::approx_tokens_from_byte_count(saved);
    let (context_prune_saved_tokens, window_number, window_ids, world_state_snapshot) = {
        // `ContextManager::replace` unconditionally clears the world-state baseline (it
        // has no way to know whether the rewritten items still match it). A prune pass
        // never touches world-state sections like AGENTS.md, so the pre-replace baseline
        // is still accurate — restore it immediately, the same way compaction re-applies
        // its baseline right after `replace_history` in `replace_compacted_history`.
        // Otherwise the very next turn treats every world-state section as unknown and
        // reinjects a spurious replacement notice, even with no resume in between.
        let world_state_snapshot = state.history.world_state_baseline();
        state.history.replace(after_items.clone());
        if let Some(snapshot) = world_state_snapshot.clone() {
            state.history.set_world_state_baseline(snapshot);
        }
        state
            .context_prune_covered
            .extend(record.covered_call_ids.iter().cloned());
        state.context_prune_saved_tokens = state
            .context_prune_saved_tokens
            .saturating_add(saved_tokens);
        state.clear_context_prune_failures();
        (
            state.context_prune_saved_tokens,
            state.auto_compact_window_number(),
            state.auto_compact_window_ids(),
            world_state_snapshot,
        )
    };
    drop(state);
    // Persist the rewritten working set as an append-only replacement checkpoint.
    // Raw rollout evidence remains intact, while resume starts from this compact base.
    sess.persist_rollout_items(&[RolloutItem::Compacted(CompactedItem {
        message: CompactedItem::context_prune_checkpoint_message(context_prune_saved_tokens),
        replacement_history: Some(after_items),
        window_number: Some(window_number),
        first_window_id: Some(window_ids.first_window_id.to_string()),
        previous_window_id: window_ids.previous_window_id.map(|id| id.to_string()),
        window_id: Some(window_ids.window_id.to_string()),
    })])
    .await;
    // Pair the checkpoint with a full world-state snapshot, mirroring what real
    // compaction does in `replace_compacted_history`. Without this, resume's backward
    // scan can resolve its replacement-history base at this checkpoint and stop before
    // ever finding a world-state baseline, leaving sections like AGENTS.md looking
    // "Unknown" and reinjected with a replacement notice even though nothing changed.
    if let Some(snapshot) = world_state_snapshot {
        sess.persist_rollout_items(&[RolloutItem::WorldState(WorldStateItem::full(
            snapshot.into_value(),
        ))])
        .await;
    }
    context_pruner::record_applied_prune(saved);
    // Count only an applied pass. A stream or parse failure leaves history untouched and must
    // not spend the hysteresis cycle's successful-pass budget.
    if requested_trigger.is_none() {
        sess.state.lock().await.record_context_prune_pass();
    }
    // The server count describes the pre-prune request. Re-estimate from the
    // rewritten working history immediately so every context meter reflects the pass
    // instead of staying stale until the next model response.
    sess.recompute_token_usage(turn_context).await;
    // Close the cycle as soon as the re-estimate says the target was met. This is what
    // turns "one pass reached 20%" into the ~10-point regrowth band: from here the gate
    // above refuses every automatic pass until use climbs back to 30%. If the target was
    // not met the cycle stays open and may spend the rest of its budget on the next
    // step -- still one logical cycle, still bounded.
    if requested_trigger.is_none() {
        let remaining = sess.get_total_token_usage().await;
        if context_pruner::target_reached(remaining, context_window) {
            sess.state.lock().await.close_context_prune_cycle();
        }
    }
    if let Err(err) = context_prune_audit::write_latest_report(&log_dir, &audit.report) {
        tracing::warn!(
            "Immutable pruning audit was saved at {}, but the latest report could not be updated: {err:#}",
            audit.pass_dir.display()
        );
    }
    true
}

async fn run_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<
    (
        Option<(
            crate::context_pruner::PruneRecord,
            String,
            String,
            Option<TokenUsage>,
            String,
        )>,
        Vec<context_prune_audit::PruneAttemptRecord>,
    ),
    PruneCancelled,
> {
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return Err(PruneCancelled);
    }
    let pass_id = uuid::Uuid::now_v7().to_string();
    let mut attempts = Vec::new();
    let primary_slug =
        if turn_context.config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID {
            context_pruner::PRUNE_MODEL_SLUG
        } else {
            turn_context.model_info.slug.as_str()
        };

    if let Some((record, output, usage)) = try_validated_prune_pass(
        sess,
        turn_context,
        client_session,
        batch,
        active_question,
        primary_slug,
        &pass_id,
        context_prune_audit::PruneAttemptKind::Primary,
        &mut attempts,
        cancellation_token,
    )
    .await?
    {
        return Ok((
            Some((record, output, primary_slug.to_string(), usage, pass_id)),
            attempts,
        ));
    }

    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return Err(PruneCancelled);
    }
    let fallback_slug = turn_context.model_info.slug.as_str();
    if primary_slug != fallback_slug {
        if let Some((record, output, usage)) = try_validated_prune_pass(
            sess,
            turn_context,
            client_session,
            batch,
            active_question,
            fallback_slug,
            &pass_id,
            context_prune_audit::PruneAttemptKind::Fallback,
            &mut attempts,
            cancellation_token,
        )
        .await?
        {
            return Ok((
                Some((record, output, fallback_slug.to_string(), usage, pass_id)),
                attempts,
            ));
        }
    }

    Ok((None, attempts))
}

async fn try_validated_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
    prune_model_slug: &str,
    pass_id: &str,
    kind: context_prune_audit::PruneAttemptKind,
    attempts: &mut Vec<context_prune_audit::PruneAttemptRecord>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<
    Option<(
        crate::context_pruner::PruneRecord,
        String,
        Option<TokenUsage>,
    )>,
    PruneCancelled,
> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let reasoning_effort = Some(context_pruner::PRUNE_REASONING_EFFORT.as_str().to_string());

    match try_stream_prune_pass(
        sess,
        turn_context,
        client_session,
        batch,
        active_question,
        prune_model_slug,
        cancellation_token,
    )
    .await?
    {
        Ok((output, usage)) => {
            if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
                return Err(PruneCancelled);
            }
            let Some(record) = context_pruner::parse_prune_output(&output, batch) else {
                tracing::warn!(
                    "Context prune response was malformed for model {prune_model_slug}; preserving history"
                );
                let input_text = context_pruner::build_prune_input(batch, active_question);
                log_prune_debug(
                    sess,
                    prune_model_slug,
                    &input_text,
                    "response did not parse as a decision manifest",
                    Some(&output),
                )
                .await;
                attempts.push(context_prune_audit::PruneAttemptRecord {
                    pass_id: pass_id.to_string(),
                    timestamp,
                    kind,
                    model_slug: prune_model_slug.to_string(),
                    reasoning_effort,
                    status: context_prune_audit::PruneAttemptStatus::ParseError,
                    error: Some("response did not parse as a decision manifest".to_string()),
                    usage,
                });
                return Ok(None);
            };
            attempts.push(context_prune_audit::PruneAttemptRecord {
                pass_id: pass_id.to_string(),
                timestamp,
                kind,
                model_slug: prune_model_slug.to_string(),
                reasoning_effort,
                status: context_prune_audit::PruneAttemptStatus::Success,
                error: None,
                usage: usage.clone(),
            });
            Ok(Some((record, output, usage)))
        }
        Err((err_msg, usage)) => {
            if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
                return Err(PruneCancelled);
            }
            attempts.push(context_prune_audit::PruneAttemptRecord {
                pass_id: pass_id.to_string(),
                timestamp,
                kind,
                model_slug: prune_model_slug.to_string(),
                reasoning_effort,
                status: context_prune_audit::PruneAttemptStatus::StreamError,
                error: Some(err_msg),
                usage,
            });
            Ok(None)
        }
    }
}

async fn try_stream_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
    prune_model_slug: &str,
    cancellation_token: Option<&CancellationToken>,
) -> Result<
    Result<(String, Option<TokenUsage>), (String, Option<TokenUsage>)>,
    PruneCancelled,
> {
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return Err(PruneCancelled);
    }
    let model_info = sess
        .services
        .models_manager
        .get_model_info(
            prune_model_slug,
            &turn_context.config.to_models_manager_config(),
        )
        .await;

    let input_text = context_pruner::build_prune_input(batch, active_question);
    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: input_text.clone(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: codex_prompts::CONTEXT_PRUNE_PROMPT.to_string(),
        },
        ..Default::default()
    };

    let responses_metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "context-prune".to_string(),
        CodexResponsesRequestKind::ContextPrune,
    );

    let stream = await_or_cancelled(
        cancellation_token,
        client_session.stream(
            &prompt,
            &model_info,
            &turn_context.session_telemetry,
            Some(context_pruner::PRUNE_REASONING_EFFORT),
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            &responses_metadata,
            &InferenceTraceContext::disabled(),
        ),
    )
    .await?;
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return Err(PruneCancelled);
    }
    let mut stream = match stream {
        Ok(stream) => stream,
        Err(err) => {
            let msg = format!("stream could not be opened: {err}");
            tracing::warn!("Context prune stream failed for model {prune_model_slug}: {err}");
            log_prune_debug(
                sess,
                prune_model_slug,
                &input_text,
                &msg,
                None,
            )
            .await;
            return Ok(Err((msg, None)));
        }
    };

    let mut events = Vec::new();
    while let Some(res) = await_or_cancelled(cancellation_token, stream.next()).await? {
        events.push(res);
    }
    if cancellation_token.is_some_and(CancellationToken::is_cancelled) {
        return Err(PruneCancelled);
    }

    let outcome = process_prune_stream_events(events);
    match &outcome {
        Ok((text, _)) => {
            tracing::info!("Context prune LLM response received ({prune_model_slug}): {text}");
        }
        Err((reason, _)) => {
            tracing::warn!("Context prune LLM stream error/empty ({prune_model_slug}): {reason}");
            log_prune_debug(sess, prune_model_slug, &input_text, reason, None).await;
        }
    }
    Ok(outcome)
}

fn process_prune_stream_events<E: std::fmt::Display>(
    events: impl IntoIterator<Item = Result<ResponseEvent, E>>,
) -> Result<(String, Option<TokenUsage>), (String, Option<TokenUsage>)> {
    let mut collected: Vec<ResponseItem> = Vec::new();
    let mut streamed_text = String::new();
    let mut safety_buffering = false;
    let mut usage: Option<TokenUsage> = None;
    let mut stream_err: Option<String> = None;

    for item in events {
        match item {
            Ok(ResponseEvent::OutputItemDone(item)) => collected.push(item),
            Ok(ResponseEvent::OutputTextDelta(delta)) => streamed_text.push_str(&delta),
            Ok(ResponseEvent::SafetyBuffering(_)) => {
                safety_buffering = true;
            }
            Ok(ResponseEvent::Completed { token_usage, .. }) => {
                usage = token_usage;
            }
            Ok(_) => continue,
            Err(err) => {
                let msg = format!("stream ended with an error: {err}");
                stream_err = Some(msg);
                break;
            }
        }
    }

    if let Some(err_msg) = stream_err {
        return Err((err_msg, usage));
    }

    let result = super::turn::get_last_assistant_message_from_turn(&collected)
        .or_else(|| (!streamed_text.trim().is_empty()).then(|| streamed_text.clone()));
    if let Some(text) = result {
        Ok((text, usage))
    } else {
        let reason = if safety_buffering {
            "stream completed with no assistant text after safety buffering"
        } else {
            "stream completed with no assistant text and no text deltas"
        };
        Err((reason.to_string(), usage))
    }
}

async fn log_prune_debug(
    sess: &Arc<Session>,
    model_slug: &str,
    input_text: &str,
    reason: &str,
    output_text: Option<&str>,
) {
    let log_dir = sess.codex_home().await.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    // Raw debug log only; prune_report.md describes the last successfully
    // applied pass and is never written from a failed or malformed attempt.
    let debug_file = log_dir.join("prune_debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(debug_file)
    {
        use std::io::Write;
        let ts = chrono::Utc::now().to_rfc3339();
        let out_str = output_text.unwrap_or("<none>");
        let _ = writeln!(
            file,
            "=== LAYER 2 PRUNING PASS [{ts}] ===\nMODEL: {model_slug}\nFAILURE: {reason}\n--- INPUT BATCH SENT TO LLM ---\n{input_text}\n--- LLM RESPONSE RECEIVED ---\n{out_str}\n=========================================\n"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_completed_stream_yields_success_and_provider_usage() {
        let usage = TokenUsage {
            cache_write_tokens: None,
            input_tokens: 1_000,
            cached_input_tokens: 300,
            output_tokens: 50,
            reasoning_output_tokens: 500,
            total_tokens: 1_550,
        };
        let events: Vec<Result<ResponseEvent, String>> = vec![
            Ok(ResponseEvent::OutputTextDelta("call_1: kept output".to_string())),
            Ok(ResponseEvent::Completed {
                token_usage: Some(usage.clone()),
                response_id: "res-123".to_string(),
                end_turn: None,
            }),
        ];

        let res = process_prune_stream_events(events);
        assert_eq!(res, Ok(("call_1: kept output".to_string(), Some(usage))));
    }

    #[test]
    fn stream_ending_without_completed_event_yields_none_usage_not_zero() {
        let events: Vec<Result<ResponseEvent, String>> = vec![
            Ok(ResponseEvent::OutputTextDelta("call_1: kept output".to_string())),
        ];

        let res = process_prune_stream_events(events);
        assert_eq!(res, Ok(("call_1: kept output".to_string(), None)));
    }

    #[test]
    fn stream_failure_yields_stream_error_and_retains_partial_usage() {
        let usage = TokenUsage {
            cache_write_tokens: None,
            input_tokens: 2_000,
            cached_input_tokens: 500,
            output_tokens: 20,
            reasoning_output_tokens: 0,
            total_tokens: 2_020,
        };
        let events: Vec<Result<ResponseEvent, String>> = vec![
            Ok(ResponseEvent::Completed {
                token_usage: Some(usage.clone()),
                response_id: "res-456".to_string(),
                end_turn: None,
            }),
            Err("connection reset by peer".to_string()),
        ];

        let res = process_prune_stream_events(events);
        assert_eq!(
            res,
            Err(("stream ended with an error: connection reset by peer".to_string(), Some(usage)))
        );
    }

    #[test]
    fn parse_failure_retains_attempt_record_with_parse_error_status() {
        let pass_id = "test-pass-999".to_string();
        let batch = vec![("call_1".to_string(), "tool output".to_string())];
        let mut attempts = Vec::new();
        let timestamp = "2026-08-08T12:00:00Z".to_string();
        let reasoning_effort = Some("max".to_string());
        let prune_model_slug = "gpt-5.6-terra";
        let output = "invalid manifest format".to_string();
        let usage = Some(TokenUsage {
            cache_write_tokens: None,
            input_tokens: 800,
            cached_input_tokens: 100,
            output_tokens: 30,
            reasoning_output_tokens: 0,
            total_tokens: 830,
        });

        // Simulate parse failure classification in try_validated_prune_pass
        let parsed = context_pruner::parse_prune_output(&output, &batch);
        assert!(parsed.is_none());
        attempts.push(context_prune_audit::PruneAttemptRecord {
            pass_id: pass_id.clone(),
            timestamp,
            kind: context_prune_audit::PruneAttemptKind::Primary,
            model_slug: prune_model_slug.to_string(),
            reasoning_effort,
            status: context_prune_audit::PruneAttemptStatus::ParseError,
            error: Some("response did not parse as a decision manifest".to_string()),
            usage: usage.clone(),
        });

        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].pass_id, "test-pass-999");
        assert_eq!(attempts[0].status, context_prune_audit::PruneAttemptStatus::ParseError);
        assert_eq!(attempts[0].usage, usage);
    }

    #[test]
    fn primary_failure_and_fallback_share_pass_id_and_correct_kinds() {
        let pass_id = "shared-pass-uuid-777".to_string();
        let mut attempts = Vec::new();

        // Primary attempt fails
        attempts.push(context_prune_audit::PruneAttemptRecord {
            pass_id: pass_id.clone(),
            timestamp: "2026-08-08T12:00:00Z".to_string(),
            kind: context_prune_audit::PruneAttemptKind::Primary,
            model_slug: "gpt-5.6-terra".to_string(),
            reasoning_effort: Some("max".to_string()),
            status: context_prune_audit::PruneAttemptStatus::StreamError,
            error: Some("stream could not be opened: connection timeout".to_string()),
            usage: None,
        });

        // Fallback attempt succeeds
        attempts.push(context_prune_audit::PruneAttemptRecord {
            pass_id: pass_id.clone(),
            timestamp: "2026-08-08T12:00:02Z".to_string(),
            kind: context_prune_audit::PruneAttemptKind::Fallback,
            model_slug: "gpt-4o".to_string(),
            reasoning_effort: Some("max".to_string()),
            status: context_prune_audit::PruneAttemptStatus::Success,
            error: None,
            usage: Some(TokenUsage {
                cache_write_tokens: None,
                input_tokens: 300,
                cached_input_tokens: 0,
                output_tokens: 20,
                reasoning_output_tokens: 0,
                total_tokens: 320,
            }),
        });

        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].pass_id, "shared-pass-uuid-777");
        assert_eq!(attempts[1].pass_id, "shared-pass-uuid-777");
        assert_eq!(attempts[0].kind, context_prune_audit::PruneAttemptKind::Primary);
        assert_eq!(attempts[1].kind, context_prune_audit::PruneAttemptKind::Fallback);
    }
}

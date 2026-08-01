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
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;

use super::context_prune_audit;
use super::session::Session;
use super::turn_context::TurnContext;

pub(super) async fn maybe_run_context_prune(sess: &Arc<Session>, turn_context: &Arc<TurnContext>) {
    run_context_prune(sess, turn_context, None, None).await;
}

pub(crate) async fn run_manual_context_prune(sess: &Arc<Session>, turn_context: &Arc<TurnContext>) {
    run_manual_context_prune_with_target(sess, turn_context, None).await;
}

pub(crate) async fn run_manual_context_prune_with_target(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    target_pct: Option<i64>,
) {
    let trigger = match target_pct {
        Some(_) => Some(context_pruner::PruneTrigger::Pressure),
        None => Some(context_pruner::PruneTrigger::Manual),
    };
    run_context_prune(sess, turn_context, trigger, target_pct).await;
}

async fn run_context_prune(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    requested_trigger: Option<context_pruner::PruneTrigger>,
    target_pct: Option<i64>,
) {
    let context_window = turn_context.model_context_window().unwrap_or(0);
    if requested_trigger.is_none() && context_window <= 0 {
        return;
    }

    let active_context_tokens = sess.get_total_token_usage().await;

    let covered_call_ids = {
        let state = sess.state.lock().await;
        state.context_prune_covered.clone()
    };

    let history = sess.clone_history().await;
    let items = history.raw_items().to_vec();
    let before_model_items = history
        .clone()
        .for_prompt(&turn_context.model_info.input_modalities);
    let uncovered = context_pruner::uncovered_completed_turn_tokens(&items, &covered_call_ids);
    let trigger = requested_trigger.or_else(|| {
        context_pruner::select_trigger(active_context_tokens, uncovered, context_window)
    });
    let batch = match trigger {
        Some(context_pruner::PruneTrigger::Manual) => {
            context_pruner::build_manual_prune_batch(&items, &covered_call_ids)
        }
        Some(context_pruner::PruneTrigger::Steady) => {
            context_pruner::build_steady_prune_batch(&items, &covered_call_ids)
        }
        Some(context_pruner::PruneTrigger::Pressure) => {
            let pct = target_pct.unwrap_or(context_pruner::AUTO_PRUNE_TARGET_PERCENT);
            let reclaim_target = (context_window as f64 * (1.0 - (pct as f64 / 100.0))) as usize;
            context_pruner::build_prune_batch_for_reclaim(&items, &covered_call_ids, reclaim_target.max(1))
        }
        None => Vec::new(),
    };
    let Some((trigger, batch)) = trigger.zip((!batch.is_empty()).then_some(batch)) else {
        // Nothing reclaimable. Past the pressure boundary that means distillation is
        // exhausted — the window is full of messages and reasoning rather than tool
        // evidence — so the working set would climb from here with no layer left to
        // stop it. Hand off to compaction instead of letting it drift toward the
        // model's hard limit. The turn loop performs the rollover on its next step.
        if requested_trigger.is_none()
            && context_pruner::pressure_reached(active_context_tokens, context_window)
        {
            tracing::info!(
                "Context pruning is exhausted at {active_context_tokens} tokens; requesting compaction"
            );
            sess.request_new_context_window().await;
        }
        return;
    };
    let active_question = context_pruner::latest_user_message_text(&items);
    // Keep maintenance inference isolated from the active turn's sticky routing and
    // incremental request state. This lets the pressure check run between tool
    // follow-ups without perturbing the user's model session.
    let mut prune_client_session = sess.services.model_client.new_session();

    let Some((record, raw, model_slug)) = run_prune_pass(
        sess,
        turn_context,
        &mut prune_client_session,
        &batch,
        active_question.as_deref(),
    )
    .await
    else {
        // Fail open. A failed or malformed pruning pass must not alter history or
        // mark any item as covered; the same batch remains eligible for a later pass.
        return;
    };

    let mut after_items = items;
    let saved = context_pruner::apply_prune_record_untracked(&mut after_items, &record);
    let mut after_history = history;
    after_history.replace(after_items.clone());
    let after_model_items = after_history.for_prompt(&turn_context.model_info.input_modalities);
    let ace_input = context_pruner::build_prune_input(&batch, active_question.as_deref());
    let log_dir = sess.codex_home().await.join("logs");
    let audit = match context_prune_audit::write_applied_pass(
        &log_dir,
        context_prune_audit::PruneAuditInput {
            trigger: trigger.as_str(),
            model_slug: &model_slug,
            ace_instructions: codex_prompts::CONTEXT_PRUNE_PROMPT,
            ace_input: &ace_input,
            raw_response: &raw,
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
            return;
        }
    };

    {
        let mut state = sess.state.lock().await;
        state.history.replace(after_items);
        state
            .context_prune_covered
            .extend(record.covered_call_ids.iter().cloned());
    }
    context_pruner::record_applied_prune(saved);
    // The server count describes the pre-prune request. Re-estimate from the
    // rewritten working history immediately so every context meter reflects the pass
    // instead of staying stale until the next model response.
    sess.recompute_token_usage(turn_context).await;
    if let Err(err) = context_prune_audit::write_latest_report(&log_dir, &audit.report) {
        tracing::warn!(
            "Immutable pruning audit was saved at {}, but the latest report could not be updated: {err:#}",
            audit.pass_dir.display()
        );
    }
}

async fn run_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
) -> Option<(crate::context_pruner::PruneRecord, String, String)> {
    let primary_slug =
        if turn_context.config.model_provider_id == codex_model_provider_info::OPENAI_PROVIDER_ID {
            context_pruner::PRUNE_MODEL_SLUG
        } else {
            turn_context.model_info.slug.as_str()
        };

    if let Some((record, output)) = try_validated_prune_pass(
        sess,
        turn_context,
        client_session,
        batch,
        active_question,
        primary_slug,
    )
    .await
    {
        return Some((record, output, primary_slug.to_string()));
    }

    let fallback_slug = turn_context.model_info.slug.as_str();
    if primary_slug != fallback_slug {
        return try_validated_prune_pass(
            sess,
            turn_context,
            client_session,
            batch,
            active_question,
            fallback_slug,
        )
        .await
        .map(|(record, output)| (record, output, fallback_slug.to_string()));
    }

    None
}

async fn try_validated_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
    prune_model_slug: &str,
) -> Option<(crate::context_pruner::PruneRecord, String)> {
    let output = try_stream_prune_pass(
        sess,
        turn_context,
        client_session,
        batch,
        active_question,
        prune_model_slug,
    )
    .await?;
    let Some(record) = context_pruner::parse_prune_output(&output, batch) else {
        tracing::warn!(
            "Context prune response was malformed for model {prune_model_slug}; preserving history"
        );
        let input_text = context_pruner::build_prune_input(batch, active_question);
        log_prune_debug(sess, prune_model_slug, &input_text, Some(&output)).await;
        return None;
    };
    Some((record, output))
}

async fn try_stream_prune_pass(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    batch: &[(String, String)],
    active_question: Option<&str>,
    prune_model_slug: &str,
) -> Option<String> {
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

    let mut stream = match client_session
        .stream(
            &prompt,
            &model_info,
            &turn_context.session_telemetry,
            None,
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            &responses_metadata,
            &InferenceTraceContext::disabled(),
        )
        .await
    {
        Ok(stream) => stream,
        Err(err) => {
            tracing::warn!("Context prune stream failed for model {prune_model_slug}: {err}");
            log_prune_debug(sess, prune_model_slug, &input_text, None).await;
            return None;
        }
    };

    let mut collected: Vec<ResponseItem> = Vec::new();
    loop {
        match stream.next().await {
            Some(Ok(ResponseEvent::OutputItemDone(item))) => collected.push(item),
            Some(Ok(ResponseEvent::Completed { .. })) => break,
            Some(Ok(_)) => continue,
            Some(Err(err)) => {
                tracing::warn!("Context prune stream error for model {prune_model_slug}: {err}");
                log_prune_debug(sess, prune_model_slug, &input_text, None).await;
                return None;
            }
            None => break,
        }
    }
    let result = super::turn::get_last_assistant_message_from_turn(&collected);
    if let Some(ref text) = result {
        tracing::info!("Context prune LLM response received ({prune_model_slug}): {text}");
    } else {
        tracing::warn!("Context prune LLM stream returned no assistant text ({prune_model_slug})");
        log_prune_debug(sess, prune_model_slug, &input_text, None).await;
    }
    result
}

async fn log_prune_debug(
    sess: &Arc<Session>,
    model_slug: &str,
    input_text: &str,
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
        let out_str = output_text.unwrap_or("<NO OUTPUT / FAILED>");
        let _ = writeln!(
            file,
            "=== LAYER 2 PRUNING PASS [{ts}] ===\nMODEL: {model_slug}\n--- INPUT BATCH SENT TO LLM ---\n{input_text}\n--- LLM RESPONSE RECEIVED ---\n{out_str}\n=========================================\n"
        );
    }
}

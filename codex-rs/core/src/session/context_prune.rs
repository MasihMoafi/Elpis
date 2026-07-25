//! Triggers Layer 2 context pruning (`crate::context_pruner`) once uncovered
//! turn-lifetime content has grown past the threshold. Mirrors
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
use codex_protocol::openai_models::ReasoningEffort;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;

use super::session::Session;
use super::turn_context::TurnContext;

pub(super) async fn maybe_run_context_prune(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
) {
    let context_window = turn_context
        .model_info
        .resolved_context_window()
        .unwrap_or(0);
    if context_window <= 0 {
        return;
    }

    let active_context_tokens = sess.get_total_token_usage().await;

    let covered_call_ids = {
        let state = sess.state.lock().await;
        state.context_prune_covered.clone()
    };

    let items = sess.clone_history().await.into_raw_items();
    let uncovered = context_pruner::uncovered_transient_chars(&items, &covered_call_ids);
    if !context_pruner::should_prune(active_context_tokens, uncovered, context_window) {
        return;
    }
    let batch = context_pruner::build_prune_batch(&items, &covered_call_ids);
    if batch.is_empty() {
        return;
    }
    let active_question = context_pruner::latest_user_message_text(&items);

    let Some((record, raw, model_slug)) = run_prune_pass(
        sess,
        turn_context,
        client_session,
        &batch,
        active_question.as_deref(),
    )
    .await
    else {
        // Fail open. A failed or malformed pruning pass must not alter history or
        // mark any item as covered; the same batch remains eligible for a later pass.
        return;
    };

    let saved = {
        let mut state = sess.state.lock().await;
        let mut items = state.history.raw_items().to_vec();
        let saved = context_pruner::apply_prune_record(&mut items, &record);
        state.history.replace(items);
        state
            .context_prune_covered
            .extend(record.covered_call_ids.iter().cloned());
        saved
    };

    write_prune_report(&batch, &record, &raw, &model_slug, saved);
}

/// Writes `~/.elpis/logs/prune_report.md` from the last applied pass: every
/// batch item with its real outcome (kept evidence line vs deleted dead end), the
/// model's raw decision, and chars saved. Failed and malformed attempts never reach
/// this function; their durable trail is `prune_debug.log`, and the source rollouts
/// remain untouched in `~/.elpis/sessions/`.
fn write_prune_report(
    batch: &[(String, String)],
    record: &crate::context_pruner::PruneRecord,
    raw: &str,
    model_slug: &str,
    saved: usize,
) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let log_dir = std::path::PathBuf::from(home).join(".elpis").join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let ts = chrono::Utc::now().to_rfc3339();
    let kept_count = record
        .text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    let mut body = format!(
        "# Elpis Layer 2 Context Pruning Report\n\n\
         **Timestamp**: `{ts}`  \n**Pruning model**: `{model_slug}`  \n\
         **This pass**: {} items reviewed · {} kept as evidence lines · {} deleted as dead ends · ≈{saved} chars removed  \n\
         **Session totals**: {} passes · ≈{} chars removed\n\n\
         ---\n\n## What was deleted or kept, item by item\n\n",
        batch.len(),
        kept_count,
        batch.len().saturating_sub(kept_count),
        crate::context_pruner::pass_count(),
        crate::context_pruner::saved_chars(),
    );
    for (id, text) in batch {
        let conclusion = record.text.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(line_id, _)| line_id.trim() == id)
                .map(|(_, rest)| rest.trim())
        });
        let excerpt: String = text
            .chars()
            .take(120)
            .collect::<String>()
            .replace('\n', " ");
        let chars = text.chars().count();
        match conclusion {
            Some(kept) => {
                body.push_str(&format!(
                    "- `{id}` ({chars} chars) — **KEPT** as: {kept}\n  - was: “{excerpt}…”\n"
                ));
            }
            None => {
                body.push_str(&format!(
                    "- `{id}` ({chars} chars) — **DELETED** (dead end, no evidence line earned)\n  - was: “{excerpt}…”\n"
                ));
            }
        }
    }
    body.push_str(&format!(
        "\n---\n\n## Model's raw decision\n\n```text\n{raw}\n```\n\n\
         Full originals remain in `~/.elpis/sessions/` and `~/.elpis/logs/prune_debug.log`.\n"
    ));
    let _ = std::fs::write(log_dir.join("prune_report.md"), body);
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
            Some(ReasoningEffort::Medium),
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
            log_prune_debug(prune_model_slug, &input_text, None);
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
                log_prune_debug(prune_model_slug, &input_text, None);
                return None;
            }
            None => break,
        }
    }
    let result = super::turn::get_last_assistant_message_from_turn(&collected);
    log_prune_debug(prune_model_slug, &input_text, result.as_deref());
    if let Some(ref text) = result {
        tracing::info!("Context prune LLM response received ({prune_model_slug}): {text}");
    } else {
        tracing::warn!("Context prune LLM stream returned no assistant text ({prune_model_slug})");
    }
    result
}

fn log_prune_debug(model_slug: &str, input_text: &str, output_text: Option<&str>) {
    if let Some(home) = std::env::var_os("HOME") {
        let log_dir = std::path::PathBuf::from(home).join(".elpis").join("logs");
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
}

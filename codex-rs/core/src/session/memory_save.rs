//! Bounded, opt-in Luna consolidation at continuity boundaries.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::WarningEvent;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;
use sha2::Digest;
use sha2::Sha256;

use super::session::Session;
use super::turn_context::TurnContext;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::memory_save::MemorySnapshot;
use crate::responses_metadata::CodexResponsesRequestKind;

const MODEL: &str = "gpt-5.6-luna";
const INPUT_CHARS: usize = 64_000;
const TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) async fn save_continuity(sess: &Arc<Session>, turn: &Arc<TurnContext>) {
    let result = save(sess, turn).await;
    if let Err(error) = result {
        tracing::warn!(
            thread_id = %sess.session_id(),
            turn_id = %turn.sub_id,
            error = %format!("{error:#}"),
            "memory save failed"
        );
        sess.send_event(
            turn,
            EventMsg::Warning(WarningEvent {
                message: format!("Memory save failed: {error:#}"),
            }),
        )
        .await;
    }
}

async fn save(sess: &Arc<Session>, turn: &Arc<TurnContext>) -> anyhow::Result<()> {
    let preparation_started = std::time::Instant::now();
    if turn.session_source.is_non_root_agent() {
        return Ok(());
    }
    let config = sess.get_config().await;
    let Some(cwd) = turn
        .environments
        .primary()
        .and_then(|env| env.cwd().to_abs_path().ok())
    else {
        return Ok(());
    };
    let Some(snapshot) =
        MemorySnapshot::open_when_available(config.memory_dir.as_path(), cwd.as_path()).await?
    else {
        return Ok(());
    };
    let history = sess.clone_history().await;
    let mut evidence = std::collections::BTreeMap::new();
    let mut remaining = INPUT_CHARS;
    // Reserve up to half for recent user instructions and corrections. Large tool
    // output must not crowd them out. Keep whole items and restore chronology below.
    for user_pass in [true, false] {
        let mut allowance = if user_pass {
            INPUT_CHARS / 2
        } else {
            remaining
        };
        for (index, item) in history.raw_items().iter().enumerate().rev() {
            if matches!(item, ResponseItem::Reasoning { .. }) {
                continue;
            }
            if matches!(item, ResponseItem::Message { role, .. } if role != "user" && role != "assistant")
            {
                continue;
            }
            let is_user = matches!(item, ResponseItem::Message { role, .. } if role == "user");
            if (user_pass && !is_user) || evidence.contains_key(&index) {
                continue;
            }
            let size = serde_json::to_string(item)?.chars().count();
            if size > allowance {
                continue;
            }
            allowance -= size;
            remaining -= size;
            evidence.insert(
                index,
                serde_json::json!({
                    "id": format!("{}:{}:{index}", sess.session_id(), turn.sub_id),
                    "item": item,
                }),
            );
        }
    }
    let evidence: Vec<_> = evidence.into_values().collect();
    if evidence.is_empty() {
        return Ok(());
    }
    // Citation IDs change between turns even when the evidence does not.
    let evidence_hash: [u8; 32] = Sha256::digest(serde_json::to_vec(&(
        &config.memory_dir,
        &cwd,
        &snapshot.goal,
        evidence.iter().map(|row| &row["item"]).collect::<Vec<_>>(),
    ))?)
    .into();
    let save_key = memory_save_key(&evidence_hash, &snapshot.memory, &snapshot.checkpoint)?;
    if sess.state.lock().await.last_successful_memory_save == Some(save_key) {
        return Ok(());
    }
    let input = serde_json::to_string(&serde_json::json!({
        "workspace": cwd,
        "goal": snapshot.goal,
        "previous_checkpoint": snapshot.checkpoint
            .split_once("\n## Consolidated State\n\n")
            .map(|(_, notes)| notes)
            .unwrap_or(&snapshot.checkpoint),
        "previous_memory": snapshot.memory,
        "character_budget": crate::memory_save::OUTPUT_CHARS,
        "evidence": evidence,
        "evidence_may_omit_older_or_oversized_items": true,
    }))?;
    let slug = crate::context_pruner::background_model_slug(
        turn.config.background_model.as_deref(),
        MODEL,
    );
    let model = sess
        .services
        .models_manager
        .get_model_info(slug, &turn.config.to_models_manager_config())
        .await;
    // Resolving to a different model would quietly spend a larger one on
    // routine maintenance, so a mismatch stays an error rather than a fallback.
    anyhow::ensure!(
        model.slug == slug,
        "{slug} is unavailable; no model fallback allowed"
    );
    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".into(),
            content: vec![ContentItem::InputText {
                text: input.clone(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: include_str!("../../templates/memory_consolidation.md").into(),
        },
        output_schema: Some(serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["checkpoint", "memory"],
            "properties": {
                "checkpoint": {"type": "string"},
                "memory": {"type": "string"}
            }
        })),
        output_schema_strict: true,
        ..Default::default()
    };
    let metadata = turn.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "memory-save".into(),
        CodexResponsesRequestKind::Memory,
    );
    let client = sess.services.model_client.load();
    let mut client_session = client.new_session();
    let preparation_ms = preparation_started.elapsed().as_millis() as u64;
    let request_started = std::time::Instant::now();
    let response = tokio::time::timeout(TIMEOUT, async {
        let mut stream = client_session
            .stream(
                &prompt,
                &model,
                &turn.session_telemetry,
                Some(ReasoningEffort::Low),
                turn.reasoning_summary,
                turn.config.service_tier.clone(),
                &metadata,
                &InferenceTraceContext::disabled(),
            )
            .await?;
        let mut items = Vec::new();
        while let Some(event) = stream.next().await {
            match event? {
                ResponseEvent::OutputItemDone(item) => items.push(item),
                ResponseEvent::Completed { token_usage, .. } => {
                    if let Some(usage) = &token_usage {
                        sess.record_rollout_budget_usage(usage)?;
                    }
                    let output = super::turn::get_last_assistant_message_from_turn(&items)
                        .context("Luna completed without a memory decision")?;
                    return Ok::<_, anyhow::Error>((output, token_usage));
                }
                _ => {}
            }
        }
        anyhow::bail!("Luna stream ended without completion")
    })
    .await;
    let request_ms = request_started.elapsed().as_millis() as u64;
    tracing::info!(
        thread_id = %sess.session_id(), turn_id = %turn.sub_id,
        preparation_ms, request_ms,
        succeeded = response.as_ref().is_ok_and(|result| result.is_ok()),
        "memory save request timing"
    );
    let response = response.context("Luna exceeded the 60-second memory limit")??;
    let decision = crate::memory_save::parse_decision(&response.0)?;
    let (memory, checkpoint) = snapshot.commit(
        &decision,
        &sess.session_id().to_string(),
        &turn.sub_id,
        response.1.as_ref(),
        Some(&input),
        crate::memory_save::MemorySaveTiming {
            preparation_ms,
            request_ms,
            commit_ms: 0,
        },
    )?;
    sess.state.lock().await.last_successful_memory_save =
        Some(memory_save_key(&evidence_hash, &memory, &checkpoint)?);
    Ok(())
}

fn memory_save_key(
    evidence_hash: &[u8; 32],
    memory: &str,
    checkpoint: &str,
) -> anyhow::Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(&(evidence_hash, memory, checkpoint))?).into())
}

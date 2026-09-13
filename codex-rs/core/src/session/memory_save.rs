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
    let Some(snapshot) = MemorySnapshot::open(config.memory_dir.as_path(), cwd.as_path())? else {
        return Ok(());
    };
    let history = sess.clone_history().await;
    let mut evidence = Vec::new();
    let mut remaining = INPUT_CHARS;
    // Whole items only: the model must not mistake an incomplete tool result for
    // complete evidence. Older state remains available through the previous notes.
    for (index, item) in history.raw_items().iter().enumerate().rev() {
        if matches!(item, ResponseItem::Reasoning { .. }) {
            continue;
        }
        if matches!(item, ResponseItem::Message { role, .. } if role != "user" && role != "assistant")
        {
            continue;
        }
        let text = serde_json::to_string(item)?;
        if text.chars().count() > remaining {
            continue;
        }
        remaining -= text.chars().count();
        evidence.push(serde_json::json!({
            "id": format!("{}:{}:{index}", sess.session_id(), turn.sub_id),
            "item": item,
        }));
    }
    evidence.reverse();
    if evidence.is_empty() {
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
    let model = sess
        .services
        .models_manager
        .get_model_info(MODEL, &turn.config.to_models_manager_config())
        .await;
    anyhow::ensure!(
        model.slug == MODEL,
        "Luna is unavailable; no model fallback allowed"
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
        ..Default::default()
    };
    let metadata = turn.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "memory-save".into(),
        CodexResponsesRequestKind::Memory,
    );
    let client = sess.services.model_client.load();
    let mut client_session = client.new_session();
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
    .await
    .context("Luna exceeded the 60-second memory limit")??;
    let decision = crate::memory_save::parse_decision(&response.0)?;
    snapshot.commit(
        &decision,
        &sess.session_id().to_string(),
        &turn.sub_id,
        response.1.as_ref(),
        Some(&input),
    )?;
    Ok(())
}

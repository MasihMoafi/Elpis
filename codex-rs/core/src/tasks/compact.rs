use std::sync::Arc;

use super::SessionTask;
use super::SessionTaskResult;
use super::emit_compact_metric;
use crate::session::TurnInput;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::state::TaskKind;
use codex_features::Feature;
use codex_model_provider::RemoteCompactionSupport;
use codex_protocol::error::CodexErrorDetails;
use codex_protocol::user_input::UserInput;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub(crate) struct CompactTask {
    // Elpis: `/compact <text>` guidance for this compaction's summary.
    instructions: Option<String>,
}

// Elpis: from v0.3.0. Blank guidance is a bare compaction.
impl CompactTask {
    pub(crate) fn new(instructions: Option<String>) -> Self {
        let instructions = instructions
            .map(|instructions| instructions.trim().to_string())
            .filter(|instructions| !instructions.is_empty());
        Self { instructions }
    }
}

impl SessionTask for CompactTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Compact
    }

    fn span_name(&self) -> &'static str {
        "session_task.compact"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<Session>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        _cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        let _profile_guard = ctx.turn_timing_state.begin_compaction();
        // Elpis: a token-budget reset writes no summary, so guided compaction summarizes instead.
        if self.instructions.is_none() && ctx.config.features.enabled(Feature::TokenBudget) {
            crate::compact_token_budget::run_manual_compact_task(session, ctx).await?;
            return Ok(None);
        }

        let result = match ctx.provider.capabilities().remote_compaction {
            RemoteCompactionSupport::V2 => {
                emit_compact_metric(
                    &session.services.session_telemetry,
                    "remote_v2",
                    /*manual*/ true,
                );
                crate::compact_remote_v2::run_remote_compact_task(
                    session.clone(),
                    ctx,
                    self.instructions.as_deref(), // Elpis
                )
                .await
            }
            RemoteCompactionSupport::Unsupported => {
                emit_compact_metric(
                    &session.services.session_telemetry,
                    "local",
                    /*manual*/ true,
                );
                let input = vec![UserInput::Text {
                    text: ctx
                        .config
                        .compact_prompt
                        .as_deref()
                        .unwrap_or(crate::compact::SUMMARIZATION_PROMPT)
                        .to_string(),
                    // Compaction prompt is synthesized; no UI element ranges to preserve.
                    text_elements: Vec::new(),
                }];
                crate::compact::run_compact_task(
                    session.clone(),
                    ctx,
                    input,
                    self.instructions.as_deref(), // Elpis
                )
                .await
            }
        };
        if let Err(err) = result
            && matches!(err.details(), CodexErrorDetails::TurnAborted)
        {
            return Err(err);
        }
        Ok(None)
    }
}

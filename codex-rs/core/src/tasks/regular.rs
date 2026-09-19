// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::session::TurnInput;
use crate::session::turn::run_turn;
use crate::session::turn_context::TurnContext;
use crate::session_startup_prewarm::SessionStartupPrewarmResolution;
use crate::state::TaskKind;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::TurnStartedEvent;
use tracing::Instrument;
use tracing::trace_span;

use super::SessionTask;
use super::SessionTaskContext;
use super::SessionTaskResult;

#[derive(Default)]
pub(crate) struct RegularTask;

impl RegularTask {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl SessionTask for RegularTask {
    fn kind(&self) -> TaskKind {
        TaskKind::Regular
    }

    fn span_name(&self) -> &'static str {
        "session_task.turn"
    }

    async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> SessionTaskResult {
        let sess = session.clone_session();
        let turn_extension_data = session.turn_extension_data();
        let run_turn_span = trace_span!("run_turn");
        // Regular turns emit `TurnStarted` inline so first-turn lifecycle does
        // not wait on startup prewarm resolution.
        let prewarmed_client_session = async {
            let event = EventMsg::TurnStarted(TurnStartedEvent {
                turn_id: ctx.sub_id.clone(),
                trace_id: ctx.trace_id.clone(),
                started_at: ctx.turn_timing_state.started_at_unix_secs().await,
                model_context_window: ctx.model_context_window(),
                collaboration_mode_kind: ctx.mode,
            });
            sess.send_event(ctx.as_ref(), event).await;
            sess.set_server_reasoning_included(/*included*/ false).await;
            sess.consume_startup_prewarm_for_regular_turn(&cancellation_token)
                .await
        }
        .instrument(trace_span!("regular_task.prepare_run_turn"))
        .await;
        let prewarmed_client_session = match prewarmed_client_session {
            SessionStartupPrewarmResolution::Cancelled => return Ok(None),
            SessionStartupPrewarmResolution::Unavailable { .. } => None,
            SessionStartupPrewarmResolution::Ready(prewarmed_client_session) => {
                Some(*prewarmed_client_session)
            }
        };
        let mut next_input = input;
        let mut prewarmed_client_session = prewarmed_client_session;
        loop {
            let last_agent_message = run_turn(
                Arc::clone(&sess),
                Arc::clone(&ctx),
                Arc::clone(&turn_extension_data),
                next_input,
                prewarmed_client_session.take(),
                cancellation_token.child_token(),
            )
            .instrument(run_turn_span.clone())
            .await?;
            if !sess.input_queue.has_pending_input(&sess.active_turn).await {
                if last_agent_message.is_some() {
                    // Consolidating memory, expiring reasoning and naming the
                    // thread are maintenance, not part of the answer. Awaiting
                    // them here kept the turn open after the model had stopped,
                    // so the next thing the owner typed was taken as an
                    // interruption of a turn that was already over and Esc was
                    // claimed by the interrupt path instead of the ledger. The
                    // wait was whatever the background model took -- minutes,
                    // on a slow third-party route.
                    //
                    // They keep their order relative to each other, because the
                    // save reads the history that expiry then rewrites. They
                    // just no longer hold the turn open to do it.
                    let sess = Arc::clone(&sess);
                    let ctx = Arc::clone(&ctx);
                    let cancellation_token = cancellation_token.child_token();
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = cancellation_token.cancelled() => return,
                            _ = crate::session::memory_save::save_continuity(&sess, &ctx) => {}
                        }
                        if !ctx.model_info.use_responses_lite {
                            sess.expire_reasoning_items_for_turn(&ctx.sub_id).await;
                        }
                        crate::session::session_title::start(&sess, &ctx).await;
                    });
                }
                return Ok(last_agent_message);
            }
            next_input = Vec::new();
        }
    }
}

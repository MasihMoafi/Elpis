//! Hidden Terra classification for the `/model` Auto selection.

use crate::client::ModelClientSession;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::responses_metadata::CodexResponsesRequestKind;
use crate::session::TurnInput;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use codex_features::Feature;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ModelRerouteEvent;
use codex_protocol::protocol::ModelRerouteReason;
use codex_protocol::user_input::UserInput;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;
use std::sync::Arc;

const LUNA_MODEL: &str = "gpt-5.6-luna";
const TERRA_MODEL: &str = "gpt-5.6-terra";
const SOL_MODEL: &str = "gpt-5.6-sol";
const ROUTER_INSTRUCTIONS: &str = "You are the Elpis model router. Choose exactly one of {luna}, {terra}, or {sol}. Use the supplied model descriptions and assess the request on three factors: importance, difficulty/complexity, and length/detail. Choose Luna only for clearly trivial mechanical work. Choose Sol only when the request is both important or difficult enough to need top-tier reasoning; a long, detailed specification can be difficult, while a short request seldom needs Sol. Choose Terra for ordinary work and whenever uncertain. Reply with the model ID only.";

pub(crate) async fn route_turn_if_enabled(
    sess: &Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: &[TurnInput],
) -> Arc<TurnContext> {
    if !turn_context
        .config
        .features
        .enabled(Feature::AutomaticModelRouting)
        || turn_context.model_info.slug != TERRA_MODEL
    {
        return turn_context;
    }

    let Some(request) = user_request(input) else {
        return turn_context;
    };
    let model = if let Some(prompt_text) = classifier_prompt(&request, &turn_context) {
        let mut classifier_session = sess.services.model_client.new_session();
        classify(sess, &turn_context, &mut classifier_session, prompt_text)
            .await
            .unwrap_or(TERRA_MODEL)
    } else {
        TERRA_MODEL
    };

    sess.send_event(
        &turn_context,
        EventMsg::ModelReroute(ModelRerouteEvent {
            from_model: "auto".to_string(),
            to_model: model.to_string(),
            reason: ModelRerouteReason::AutoModelRouting,
        }),
    )
    .await;

    Arc::new(
        turn_context
            .with_model(model.to_string(), &sess.services.models_manager)
            .await,
    )
}

fn user_request(input: &[TurnInput]) -> Option<String> {
    input.iter().find_map(|item| match item {
        TurnInput::UserInput { content, .. } => {
            let text = content
                .iter()
                .filter_map(|item| match item {
                    UserInput::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    })
}

fn classifier_prompt(request: &str, turn_context: &TurnContext) -> Option<String> {
    let descriptions = [LUNA_MODEL, TERRA_MODEL, SOL_MODEL]
        .into_iter()
        .map(|model| {
            turn_context
                .available_models
                .iter()
                .find(|preset| preset.model == model)
                .map(|preset| format!("{model}: {}", preset.description))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(format!(
        "Available models:\n{}\n\nUser request:\n{request}",
        descriptions.join("\n")
    ))
}

async fn classify(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    input: String,
) -> Option<&'static str> {
    let prompt = Prompt {
        input: vec![ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText { text: input }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        }],
        base_instructions: BaseInstructions {
            text: ROUTER_INSTRUCTIONS
                .replace("{luna}", LUNA_MODEL)
                .replace("{terra}", TERRA_MODEL)
                .replace("{sol}", SOL_MODEL),
        },
        ..Default::default()
    };
    let metadata = turn_context.turn_metadata_state.to_responses_metadata(
        sess.installation_id.clone(),
        "auto-model-route".to_string(),
        CodexResponsesRequestKind::Turn,
    );
    let mut stream = client_session
        .stream(
            &prompt,
            &turn_context.model_info,
            &turn_context.session_telemetry,
            Some(ReasoningEffort::Medium),
            turn_context.reasoning_summary,
            turn_context.config.service_tier.clone(),
            &metadata,
            &InferenceTraceContext::disabled(),
        )
        .await
        .ok()?;

    let mut streamed_text = String::new();
    let mut completed_text = None;
    while let Some(event) = stream.next().await {
        match event.ok()? {
            ResponseEvent::OutputTextDelta(delta) => streamed_text.push_str(&delta),
            ResponseEvent::OutputItemDone(item) => {
                completed_text = response_item_text(&item);
            }
            ResponseEvent::Completed { .. } => break,
            _ => {}
        }
    }
    parse_route(&streamed_text).or_else(|| completed_text.as_deref().and_then(parse_route))
}

fn response_item_text(item: &ResponseItem) -> Option<String> {
    let ResponseItem::Message { content, .. } = item else {
        return None;
    };
    let text = content
        .iter()
        .filter_map(|item| match item {
            ContentItem::OutputText { text } | ContentItem::InputText { text } => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.trim().is_empty()).then_some(text)
}

fn parse_route(response: &str) -> Option<&'static str> {
    match response.trim() {
        LUNA_MODEL => Some(LUNA_MODEL),
        TERRA_MODEL => Some(TERRA_MODEL),
        SOL_MODEL => Some(SOL_MODEL),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_model_ids() {
        assert_eq!(parse_route("gpt-5.6-luna\n"), Some(LUNA_MODEL));
        assert_eq!(parse_route("Use gpt-5.6-sol"), None);
        assert_eq!(parse_route("gpt-4.1"), None);
    }

    #[test]
    fn tells_terra_to_default_to_terra_when_uncertain() {
        assert!(ROUTER_INSTRUCTIONS.contains("importance"));
        assert!(ROUTER_INSTRUCTIONS.contains("difficulty/complexity"));
        assert!(ROUTER_INSTRUCTIONS.contains("length/detail"));
        assert!(ROUTER_INSTRUCTIONS.contains("whenever uncertain"));
    }
}

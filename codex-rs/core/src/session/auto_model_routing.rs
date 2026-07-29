//! Hidden Terra classification for the `/model` Auto selection.

use crate::client::ModelClientSession;
use crate::client_common::Prompt;
use crate::client_common::ResponseEvent;
use crate::session::TurnInput;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::responses_metadata::CodexResponsesRequestKind;
use codex_features::Feature;
use codex_protocol::config_types::ReasoningEffort;
use codex_protocol::models::BaseInstructions;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::user_input::UserInput;
use codex_rollout_trace::InferenceTraceContext;
use futures::StreamExt;
use std::sync::Arc;

const LUNA_MODEL: &str = "gpt-5.6-luna";
const TERRA_MODEL: &str = "gpt-5.6-terra";
const SOL_MODEL: &str = "gpt-5.6-sol";

pub(crate) async fn route_turn_if_enabled(
    sess: &Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: &[TurnInput],
) -> Arc<TurnContext> {
    if !turn_context.config.features.enabled(Feature::AutomaticModelRouting)
        || turn_context.model_info.slug != TERRA_MODEL
    {
        return turn_context;
    }

    let Some(request) = user_request(input) else {
        return turn_context;
    };
    let Some(prompt_text) = classifier_prompt(&request, &turn_context) else {
        return turn_context;
    };

    let mut classifier_session = sess.services.model_client.new_session();
    let Some(model) = classify(
        sess,
        &turn_context,
        &mut classifier_session,
        prompt_text,
    )
    .await else {
        return turn_context;
    };

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
            text: format!(
                "You are the Elpis model router. Choose exactly one of {LUNA_MODEL}, {TERRA_MODEL}, or {SOL_MODEL}. Use the supplied model descriptions and the user request. Choose Luna only for truly trivial mechanical work. Choose Sol only for genuinely complex, high-stakes, or long-horizon work. Choose Terra for everything else. Reply with the model ID only."
            ),
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

    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event.ok()? {
            ResponseEvent::OutputTextDelta(delta) => text.push_str(&delta),
            ResponseEvent::Completed { .. } => break,
            _ => {}
        }
    }
    parse_route(&text)
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
}

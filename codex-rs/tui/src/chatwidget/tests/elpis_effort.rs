//! Evals for `/effort`: the current model's effort levels, for GPT models, Claude subscription
//! models and Antigravity models (whose ids carry their level).
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::elpis_app_event::ElpisAppEvent;
use codex_protocol::openai_models::ReasoningEffortPreset;
use pretty_assertions::assert_eq;

const CLAUDE_MODEL: &str = "claude/opus";
const AGY_FAMILY: &str = "agy/gemini-3.8-flash";

/// Adds a bridged model to the app server's list, as the bridge does.
fn add_bridged_model(chat: &mut ChatWidget, model: &str, efforts: &[ReasoningEffortConfig]) {
    let mut preset = get_available_model(chat, "gpt-5.5");
    preset.id = model.to_string();
    preset.model = model.to_string();
    preset.display_name = model.to_string();
    preset.is_default = false;
    preset.supported_reasoning_efforts = efforts
        .iter()
        .map(|effort| ReasoningEffortPreset {
            effort: effort.clone(),
            description: String::new(),
        })
        .collect();
    Arc::make_mut(&mut chat.model_catalog)
        .models
        .insert(0, preset);
}

fn effort_events(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
) -> (Vec<String>, Vec<Option<ReasoningEffortConfig>>) {
    let mut models = Vec::new();
    let mut efforts = Vec::new();
    for event in std::iter::from_fn(|| rx.try_recv().ok()) {
        match event {
            AppEvent::UpdateModel(model) => models.push(model),
            AppEvent::UpdateReasoningEffort(effort) => efforts.push(effort),
            AppEvent::Elpis(ElpisAppEvent::Provider(event)) => {
                panic!("/effort changed the provider: {event:?}")
            }
            _ => {}
        }
    }
    (models, efforts)
}

fn history(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> String {
    drain_insert_history(rx)
        .iter()
        .map(|lines| lines_to_single_string(lines))
        .collect()
}

/// Positive: on a GPT model, `/effort` lists its levels and `/effort high` uses High on the same
/// model. Negative: an effort the model does not offer changes nothing and names the levels.
#[tokio::test]
async fn effort_changes_a_gpt_models_effort() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());

    chat.dispatch_command(SlashCommand::Effort);
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Select Reasoning Level for"), "{popup}");
    assert!(popup.contains("High"), "{popup}");

    chat.dispatch_command_with_args(SlashCommand::Effort, "high".to_string(), Vec::new());
    assert_eq!(
        effort_events(&mut rx),
        (
            vec!["gpt-5.5".to_string()],
            vec![Some(ReasoningEffortConfig::High)]
        )
    );

    chat.dispatch_command_with_args(SlashCommand::Effort, "turbo".to_string(), Vec::new());
    let said = history(&mut rx);
    assert!(said.contains("turbo"), "{said}");
    assert!(said.contains("high"), "{said}");
    assert_eq!(effort_events(&mut rx), (Vec::new(), Vec::new()));
}

/// Positive: on a Claude subscription model, `/effort xhigh` uses Extra high on the same model
/// and switches no provider. Negative: a Claude model without levels says so and changes nothing.
#[tokio::test]
async fn effort_changes_a_claude_models_effort() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    add_bridged_model(
        &mut chat,
        CLAUDE_MODEL,
        &[
            ReasoningEffortConfig::Low,
            ReasoningEffortConfig::Medium,
            ReasoningEffortConfig::High,
            ReasoningEffortConfig::XHigh,
        ],
    );
    chat.set_model(CLAUDE_MODEL);

    chat.dispatch_command(SlashCommand::Effort);
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains(CLAUDE_MODEL), "{popup}");
    assert!(popup.contains("Extra high"), "{popup}");

    chat.dispatch_command_with_args(SlashCommand::Effort, "xhigh".to_string(), Vec::new());
    assert_eq!(
        effort_events(&mut rx),
        (
            vec![CLAUDE_MODEL.to_string()],
            vec![Some(ReasoningEffortConfig::XHigh)]
        )
    );
    assert_eq!(chat.config.model_provider_id, "openai");

    add_bridged_model(&mut chat, "claude/haiku", &[]);
    chat.set_model("claude/haiku");
    chat.dispatch_command(SlashCommand::Effort);
    let said = history(&mut rx);
    assert!(said.contains("claude/haiku has no effort levels"), "{said}");
    assert_eq!(effort_events(&mut rx), (Vec::new(), Vec::new()));
}

/// Positive: an Antigravity model's levels are its family's ids, so `/effort` lists Low, Medium
/// and High with the current one marked, and `/effort low` picks the `-low` id. Negative: a
/// level its family lacks changes nothing.
#[tokio::test]
async fn effort_picks_an_antigravity_models_level_by_its_id() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    for level in ["high", "medium", "low"] {
        add_bridged_model(&mut chat, &format!("{AGY_FAMILY}-{level}"), &[]);
    }
    add_bridged_model(&mut chat, "agy/gemini-3.1-pro-low", &[]);
    chat.set_model(&format!("{AGY_FAMILY}-high"));

    chat.dispatch_command(SlashCommand::Effort);
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    for level in ["Low", "Medium", "High"] {
        assert!(popup.contains(level), "{level} missing:\n{popup}");
    }
    let selected = popup
        .lines()
        .find(|line| line.trim_start().starts_with('›'))
        .unwrap_or_default();
    assert!(selected.contains("High"), "{popup}");
    assert!(!popup.contains("gemini-3.1-pro"), "{popup}");

    chat.dispatch_command_with_args(SlashCommand::Effort, "low".to_string(), Vec::new());
    let (models, _) = effort_events(&mut rx);
    assert_eq!(models, vec![format!("{AGY_FAMILY}-low")]);

    chat.dispatch_command_with_args(SlashCommand::Effort, "xhigh".to_string(), Vec::new());
    assert!(history(&mut rx).contains("xhigh"));
    assert_eq!(effort_events(&mut rx), (Vec::new(), Vec::new()));
}

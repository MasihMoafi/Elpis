//! Evals for the live model catalog: every picker that opens asks for the engine's list, a model
//! added while Elpis runs appears, the current model stays selected, and a failed fetch is said.

use super::*;
use pretty_assertions::assert_eq;

/// A model that is not in the startup catalog, as one added to the engine's list later.
fn added_model(template: &ModelPreset) -> ModelPreset {
    let mut preset = template.clone();
    preset.id = "gpt-6.1-terra".to_string();
    preset.model = "gpt-6.1-terra".to_string();
    preset.display_name = "Terra 6.1".to_string();
    preset.description = "Added while Elpis runs".to_string();
    preset.show_in_picker = true;
    preset.is_default = false;
    preset
}

fn pending_fetch(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> uuid::Uuid {
    std::iter::from_fn(|| rx.try_recv().ok())
        .find_map(|event| match event {
            AppEvent::FetchModels { request_id } => Some(request_id),
            _ => None,
        })
        .expect("opening a model picker asks for the live list")
}

#[tokio::test]
async fn each_picker_open_fetches_and_shows_a_model_added_since_startup() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let startup = chat.model_catalog.try_list_models().unwrap();

    chat.open_model_popup();
    let first = pending_fetch(&mut rx);
    assert!(!render_bottom_popup(&chat, /*width*/ 120).contains("Terra 6.1"));
    assert!(!chat.on_models_loaded(first, Ok(startup.clone())));

    // Closed and reopened: a new fetch, whose list now carries the added model.
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.open_model_popup();
    let second = pending_fetch(&mut rx);
    assert_ne!(first, second);
    // A short list, so every row fits the rendered picker.
    let current = startup
        .iter()
        .find(|preset| preset.model == "gpt-5.5")
        .expect("gpt-5.5 in the startup catalog")
        .clone();
    let live = vec![added_model(&startup[0]), current];
    assert!(chat.on_models_loaded(second, Ok(live.clone())));
    assert_eq!(chat.model_catalog.try_list_models().unwrap(), live);
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Terra 6.1"), "{popup}");
    assert_eq!(chat.current_model(), "gpt-5.5");
}

#[tokio::test]
async fn the_current_model_stays_selected_when_the_live_list_drops_it() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let startup = chat.model_catalog.try_list_models().unwrap();
    let live = vec![added_model(&startup[0])];

    chat.open_model_popup();
    let request_id = pending_fetch(&mut rx);
    assert!(chat.on_models_loaded(request_id, Ok(live.clone())));
    assert_eq!(chat.current_model(), "gpt-5.5");

    // The provider-aware list (`/model` → provider) shows it as the current row.
    let provider_id = chat.config.model_provider_id.clone();
    chat.open_elpis_provider_models(provider_id, Ok(live));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Terra 6.1"), "{popup}");
    assert!(
        popup.contains("gpt-5.5 · current model, not in the latest list"),
        "{popup}"
    );
    assert_eq!(chat.current_model(), "gpt-5.5");
}

#[tokio::test]
async fn a_listed_current_model_gets_no_extra_row() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let startup = chat.model_catalog.try_list_models().unwrap();
    let listed: Vec<ModelPreset> = startup
        .into_iter()
        .filter(|preset| preset.model == "gpt-5.5")
        .collect();
    let provider_id = chat.config.model_provider_id.clone();
    chat.open_elpis_provider_models(provider_id, Ok(listed));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(!popup.contains("not in the latest list"), "{popup}");
}

#[tokio::test]
async fn a_failed_fetch_is_said_in_the_picker_and_the_selection_stays() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let startup = chat.model_catalog.try_list_models().unwrap();

    chat.open_model_popup();
    let request_id = pending_fetch(&mut rx);
    assert!(!chat.on_models_loaded(request_id, Err("network down".to_string())));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(
        popup.contains("Could not refresh the model list: network down"),
        "{popup}"
    );
    assert_eq!(chat.model_catalog.try_list_models().unwrap(), startup);
    assert_eq!(chat.current_model(), "gpt-5.5");

    // The next open clears the old error until its own reply.
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.open_model_popup();
    assert!(!render_bottom_popup(&chat, /*width*/ 120).contains("Could not refresh"));

    // The provider-aware list says it too, and keeps the current model.
    let provider_id = chat.config.model_provider_id.clone();
    chat.open_elpis_provider_models(provider_id, Err("network down".to_string()));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(
        popup.contains("Could not list its models: network down"),
        "{popup}"
    );
    assert!(
        popup.contains("current model, not in the latest list"),
        "{popup}"
    );
}

/// A Claude model through the Anthropic credits, with every level the gateway lists for it.
fn credits_sonnet(template: &ModelPreset) -> ModelPreset {
    use codex_protocol::openai_models::ReasoningEffortPreset;
    let mut preset = template.clone();
    preset.id = "claude-sonnet-5-5".to_string();
    preset.model = "claude-sonnet-5-5".to_string();
    preset.display_name = "Claude Sonnet 5.5".to_string();
    preset.default_reasoning_effort = ReasoningEffortConfig::Medium;
    preset.supported_reasoning_efforts = [
        ReasoningEffortConfig::Low,
        ReasoningEffortConfig::Medium,
        ReasoningEffortConfig::High,
        ReasoningEffortConfig::XHigh,
        ReasoningEffortConfig::Max,
    ]
    .into_iter()
    .map(|effort| ReasoningEffortPreset {
        effort,
        description: "level".to_string(),
    })
    .collect();
    preset
}

/// 1 Nov: "claude-sonnet-5-5 has no effort levels to choose from". A model on another provider
/// takes its levels from that provider's live list, xhigh and max included, and a refreshed list
/// keeps the chosen level.
#[tokio::test]
async fn a_model_on_another_provider_offers_its_levels_including_xhigh_and_max() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.thread_id = Some(ThreadId::new());
    let startup = chat.model_catalog.try_list_models().unwrap();
    chat.config.model_provider_id = "anthropic-credits".to_string();
    chat.set_model("claude-sonnet-5-5");
    assert!(
        chat.preset_for_current_model().is_none(),
        "not in the startup catalog"
    );

    let sonnet = credits_sonnet(&startup[0]);
    chat.remember_provider_presets("anthropic-credits".to_string(), vec![sonnet.clone()]);
    let preset = chat
        .preset_for_current_model()
        .expect("the credits list has it");
    assert_eq!(preset.supported_reasoning_efforts.len(), 5);

    chat.open_effort_popup();
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Extra high"), "{popup}");
    assert!(popup.contains("Max"), "{popup}");

    // The chosen level survives a refresh of either list.
    chat.handle_key_event(KeyEvent::from(KeyCode::Esc));
    chat.set_reasoning_effort(Some(ReasoningEffortConfig::Max));
    chat.remember_provider_presets("anthropic-credits".to_string(), vec![sonnet]);
    let mut refreshed = startup.clone();
    refreshed.push(added_model(&startup[0]));
    assert!(chat.replace_model_catalog(refreshed));
    assert_eq!(chat.current_model(), "claude-sonnet-5-5");
    assert_eq!(
        chat.current_reasoning_effort(),
        Some(ReasoningEffortConfig::Max)
    );
}

//! Evals for the provider-aware `/model` picker ("Choose a mind"): the provider header,
//! "Change provider…", "Add API key…", the provider list, browsing a provider and saving a key.
//!
//! Each behaviour has a positive case and a negative case.

use super::*;
use crate::chatwidget::ElpisProviderEvent;
use crate::chatwidget::elpis_providers::ElpisSecret;
use crate::elpis_app_event::ElpisAppEvent;
use codex_model_provider_info::GatewayWire;
use codex_model_provider_info::ModelProviderInfo;
use pretty_assertions::assert_eq;

const VENDOR: &str = "fixture-vendor";
const UNSET_KEY: &str = "ELPIS_TUI_TEST_KEY_THAT_IS_NEVER_SET";

/// A keyless Anthropic-protocol provider in a fresh home, so no saved key or real variable
/// can leak into the test.
fn add_keyless_vendor(chat: &mut ChatWidget, home: &Path) {
    let mut provider = ModelProviderInfo {
        name: "Fixture Vendor".to_string(),
        base_url: Some("https://vendor.example/v1".to_string()),
        env_key: Some(UNSET_KEY.to_string()),
        ..ModelProviderInfo::default()
    };
    codex_model_provider_info::route_through_gateway(
        VENDOR,
        GatewayWire::AnthropicMessages,
        &mut provider,
    )
    .expect("routed");
    chat.config
        .model_providers
        .insert(VENDOR.to_string(), provider);
    chat.config.codex_home = home.to_path_buf().abs();
}

fn fixture_preset() -> ModelPreset {
    let model: codex_protocol::openai_models::ModelInfo =
        serde_json::from_value(serde_json::json!({
            "slug": "fixture-model",
            "display_name": "Fixture Model",
            "description": "≈200k context",
            "supported_reasoning_levels": [],
            "shell_type": "shell_command",
            "visibility": "list",
            "supported_in_api": true,
            "priority": 0,
            "availability_nux": null,
            "upgrade": null,
            "model_messages": {"instructions_template": "base instructions"},
            "support_verbosity": false,
            "default_verbosity": null,
            "apply_patch_tool_type": "freeform",
            "truncation_policy": {"mode": "bytes", "limit": 10_000},
            "experimental_supported_tools": [],
        }))
        .expect("valid model");
    model.into()
}

fn provider_events(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
) -> Vec<ElpisProviderEvent> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter_map(|event| match event {
            AppEvent::Elpis(ElpisAppEvent::Provider(event)) => Some(event),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn the_model_picker_names_its_provider_and_offers_a_change_of_provider() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;

    chat.open_all_models_popup();
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    assert!(popup.contains("Choose a mind and effort"), "{popup}");
    assert!(popup.contains("Provider: OpenAI (openai)"), "{popup}");
    assert!(popup.contains("Protocol: OpenAI Responses"), "{popup}");
    assert!(popup.contains("Credential: your OpenAI sign-in"), "{popup}");
    // The provider rows open the list, as in v0.3.0. The list keeps the current model in
    // view, so from an old model near the end, Up reaches them.
    let mut popup = popup;
    for _ in 0..12 {
        if popup.contains("Change provider…") {
            break;
        }
        chat.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        popup = render_bottom_popup(&chat, /*width*/ 120);
    }
    assert!(popup.contains("Change provider…"), "{popup}");
    // On the default model the row shows at once, without scrolling.
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.open_all_models_popup();
    let first = render_bottom_popup(&chat, /*width*/ 120);
    assert!(first.contains("Change provider…"), "{first}");
    // The OpenAI sign-in is not an API key typed here.
    assert!(!popup.contains("Add API key…"), "{popup}");
    assert!(!popup.contains("Select Model"), "{popup}");
}

#[tokio::test]
async fn a_gateway_provider_without_a_key_says_so_and_offers_to_add_one() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.open_elpis_provider_models(VENDOR.to_string(), Ok(vec![fixture_preset()]));
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    assert!(
        popup.contains("Provider: Fixture Vendor (fixture-vendor)"),
        "{popup}"
    );
    assert!(
        popup.contains("Route: Elpis gateway → https://vendor.example/v1"),
        "{popup}"
    );
    assert!(popup.contains("Protocol: Anthropic Messages"), "{popup}");
    assert!(
        popup.contains(&format!(
            "Credential: missing · set {UNSET_KEY} or add a key"
        )),
        "{popup}"
    );
    assert!(popup.contains("Add API key…"), "{popup}");
    assert!(popup.contains("Fixture Model"), "{popup}");
    assert!(
        popup.contains("Picking a model continues this conversation on this provider."),
        "{popup}"
    );
}

#[tokio::test]
async fn picking_a_browsed_model_asks_to_switch_to_its_provider() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());
    chat.open_elpis_provider_models(VENDOR.to_string(), Ok(vec![fixture_preset()]));
    provider_events(&mut rx);

    for ch in "fixture model".chars() {
        chat.handle_key_event(KeyEvent::from(KeyCode::Char(ch)));
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));

    let events = provider_events(&mut rx);
    assert!(
        matches!(
            events.as_slice(),
            [ElpisProviderEvent::Switch { provider_id, model }]
                if provider_id == VENDOR && model == "fixture-model"
        ),
        "{events:?}"
    );
}

#[tokio::test]
async fn a_listing_error_is_shown_instead_of_models() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.open_elpis_provider_models(VENDOR.to_string(), Err("vendor unreachable".to_string()));
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    assert!(
        popup.contains("Could not list its models: vendor unreachable"),
        "{popup}"
    );
    assert!(!popup.contains("Fixture Model"), "{popup}");
    assert!(popup.contains("Change provider…"), "{popup}");
}

#[tokio::test]
async fn the_provider_list_names_every_configured_provider() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.open_elpis_provider_popup();
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    for name in [
        "Choose a provider",
        "Anthropic Claude",
        "Google Gemini",
        "Fixture Vendor",
    ] {
        assert!(popup.contains(name), "{name} missing:\n{popup}");
    }
    // OpenRouter sorts below the visible rows; the search finds it.
    for ch in "openrouter".chars() {
        chat.handle_key_event(KeyEvent::from(KeyCode::Char(ch)));
    }
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("OpenRouter"), "OpenRouter missing:\n{popup}");
}

#[tokio::test]
async fn the_provider_list_has_no_twin_names_and_hides_bedrock_until_used() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    chat.open_elpis_provider_popup();
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Ollama (local)"), "{popup}");
    assert!(!popup.contains("gpt-oss"), "{popup}");
    assert!(!popup.contains("Bedrock"), "{popup}");
    let rows: Vec<&str> = popup
        .lines()
        .filter_map(|line| line.trim_start_matches(['›', ' ']).split_once(". "))
        .map(|(_, rest)| rest.split("  ").next().unwrap_or(rest).trim())
        .collect();
    let mut unique = rows.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(rows.len(), unique.len(), "{popup}");
}

#[tokio::test]
async fn a_saved_key_lands_in_the_home_and_the_provider_is_listed_again() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.save_elpis_provider_key(VENDOR.to_string(), ElpisSecret("sk-fixture".to_string()));

    let stored = std::fs::read_to_string(codex_elpis_gateway::provider_keys_path(home.path()))
        .expect("key file");
    assert!(
        stored.contains("\"fixture-vendor\": \"sk-fixture\""),
        "{stored}"
    );
    assert!(matches!(
        provider_events(&mut rx).as_slice(),
        [ElpisProviderEvent::Browse { provider_id }] if provider_id == VENDOR
    ));
    // With a key saved, the picker no longer asks for one.
    chat.open_elpis_provider_models(VENDOR.to_string(), Ok(vec![fixture_preset()]));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(!popup.contains("Add API key…"), "{popup}");
    assert!(
        popup.contains("Credential: key saved in this Elpis home"),
        "{popup}"
    );
}

#[tokio::test]
async fn a_key_that_cannot_be_a_header_is_refused_and_nothing_is_listed() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.save_elpis_provider_key(VENDOR.to_string(), ElpisSecret("has space".to_string()));

    assert!(!codex_elpis_gateway::provider_keys_path(home.path()).exists());
    assert_eq!(provider_events(&mut rx).len(), 0);
}

#[tokio::test]
async fn openai_is_listed_from_the_bundled_catalog_and_other_direct_providers_explain() {
    let openai = ModelProviderInfo::create_openai_provider(/*base_url*/ None);
    let presets = crate::chatwidget::load_elpis_provider_models(
        std::env::temp_dir(),
        "openai".to_string(),
        openai,
    )
    .await
    .expect("bundled catalog");
    assert!(!presets.is_empty());

    let ollama = codex_model_provider_info::create_oss_provider_with_base_url(
        "http://localhost:11434/v1",
        codex_model_provider_info::WireApi::Responses,
    );
    let error = crate::chatwidget::load_elpis_provider_models(
        std::env::temp_dir(),
        "ollama".to_string(),
        ollama,
    )
    .await
    .expect_err("an app-server-only provider");
    assert!(error.contains("model_provider = \"ollama\""), "{error}");
}

const CLAUDE_MODEL: &str = "claude/opus";
const CLAUDE_NAME: &str = "Opus 5.5 (Claude subscription)";

/// Adds a Claude subscription model to the app server's list, as the Claude bridge does.
fn add_claude_subscription_model(chat: &mut ChatWidget) {
    let mut claude = get_available_model(chat, "gpt-5.5");
    claude.id = CLAUDE_MODEL.to_string();
    claude.model = CLAUDE_MODEL.to_string();
    claude.display_name = CLAUDE_NAME.to_string();
    claude.description = "Claude Code on your Pro/Max plan".to_string();
    claude.is_default = false;
    claude.supported_reasoning_efforts = Vec::new();
    Arc::make_mut(&mut chat.model_catalog)
        .models
        .insert(0, claude);
}

/// The names of the rows a rendered model list shows, in order: the lines between its search
/// field and its key hints.
fn row_names(popup: &str) -> Vec<String> {
    popup
        .lines()
        .skip_while(|line| line.trim() != "Search models")
        .skip(1)
        .map(|line| line.trim_start_matches(['›', ' ']))
        .filter(|row| !row.is_empty() && !matches!(*row, "↑" | "↓"))
        .take_while(|row| !row.starts_with("enter "))
        .map(|row| row.split("  ").next().unwrap_or(row).trim().to_string())
        .collect()
}

/// Positive: with a Claude subscription model in the list, the configured provider's own list
/// (after "Change provider…") shows it once, first; picking it changes the model as the main
/// list does and switches no provider. Negative: `claude_subscription_rows_appear_only_with_the_claude_bridge`.
#[tokio::test]
async fn claude_subscription_models_lead_a_provider_list_and_keep_the_provider() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    add_claude_subscription_model(&mut chat);
    // The configured provider is listed from the app server's list, which carries the model.
    let listed = chat.model_catalog.try_list_models().expect("models");
    chat.open_elpis_provider_models("openai".to_string(), Ok(listed));
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    let rows = row_names(&popup);
    assert_eq!(
        rows.iter().take(2).map(String::as_str).collect::<Vec<_>>(),
        vec!["Change provider…", CLAUDE_NAME],
        "{popup}"
    );
    assert_eq!(popup.matches(CLAUDE_NAME).count(), 1, "{popup}");
    std::iter::from_fn(|| rx.try_recv().ok()).for_each(drop);

    for ch in "opus".chars() {
        chat.handle_key_event(KeyEvent::from(KeyCode::Char(ch)));
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let preset = assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::OpenReasoningPopup { model }) => model
    );
    assert_eq!(preset.model, CLAUDE_MODEL);
    chat.open_reasoning_popup(preset);

    let events: Vec<AppEvent> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, AppEvent::UpdateModel(model) if model == CLAUDE_MODEL)),
        "{events:?}"
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::PersistModelSelection { model, .. } if model == CLAUDE_MODEL
        )),
        "{events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AppEvent::Elpis(ElpisAppEvent::Provider(_)))),
        "a provider event was sent: {events:?}"
    );
    assert_eq!(chat.config.model_provider_id, "openai");
}

/// Positive: another provider's list shows the Claude subscription model above its own.
/// Negative: without one in the model list, that list, the provider list and the main list
/// show no Claude subscription row.
#[tokio::test]
async fn claude_subscription_rows_appear_only_with_the_claude_bridge() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    let home = tempfile::tempdir().expect("tempdir");
    add_keyless_vendor(&mut chat, home.path());

    chat.open_elpis_provider_models(VENDOR.to_string(), Ok(vec![fixture_preset()]));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert_eq!(
        row_names(&popup),
        vec!["Change provider…", "Add API key…", "Fixture Model"],
        "{popup}"
    );
    chat.open_elpis_provider_popup();
    let providers = render_bottom_popup(&chat, /*width*/ 120);
    assert!(!providers.contains("Claude subscription"), "{providers}");
    chat.open_all_models_popup();
    let all_models = render_bottom_popup(&chat, /*width*/ 120);
    assert!(!all_models.contains("Claude subscription"), "{all_models}");

    add_claude_subscription_model(&mut chat);
    chat.open_elpis_provider_models(VENDOR.to_string(), Ok(vec![fixture_preset()]));
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert_eq!(
        row_names(&popup),
        vec![
            "Change provider…",
            "Add API key…",
            CLAUDE_NAME,
            "Fixture Model"
        ],
        "{popup}"
    );
}

/// Positive: with a Claude subscription model in the list, the provider list offers the Claude
/// subscription, which lists only its models and says how it answers. Negative: without one,
/// the provider list has no such row (`claude_subscription_rows_appear_only_with_the_claude_bridge`).
#[tokio::test]
async fn the_provider_list_offers_the_claude_subscription_with_its_models_alone() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    add_claude_subscription_model(&mut chat);

    chat.open_elpis_provider_popup();
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert!(popup.contains("Claude subscription"), "{popup}");
    assert!(popup.contains("your Claude sign-in"), "{popup}");
    provider_events(&mut rx);
    for ch in "subscription".chars() {
        chat.handle_key_event(KeyEvent::from(KeyCode::Char(ch)));
    }
    chat.handle_key_event(KeyEvent::from(KeyCode::Enter));
    let events = provider_events(&mut rx);
    assert!(
        matches!(
            events.as_slice(),
            [ElpisProviderEvent::Browse { provider_id }]
                if provider_id == crate::chatwidget::CLAUDE_SUBSCRIPTION_PROVIDER_ID
        ),
        "{events:?}"
    );

    // The App lists it from the model list it already has.
    chat.open_elpis_provider_models(
        crate::chatwidget::CLAUDE_SUBSCRIPTION_PROVIDER_ID.to_string(),
        Ok(Vec::new()),
    );
    let popup = render_bottom_popup(&chat, /*width*/ 120);
    assert_eq!(
        row_names(&popup),
        vec!["Change provider…", CLAUDE_NAME],
        "{popup}"
    );
    assert!(popup.contains("Provider: Claude subscription"), "{popup}");
    assert!(popup.contains("Credential: your Claude sign-in"), "{popup}");
}

#[tokio::test]
async fn the_model_command_starts_at_the_provider_list_on_the_current_provider() {
    let (mut chat, _rx, _op_rx) = make_chatwidget_manual(Some("gpt-5.5")).await;

    chat.dispatch_command(SlashCommand::Model);
    let popup = render_bottom_popup(&chat, /*width*/ 120);

    assert!(popup.contains("Choose a provider"), "{popup}");
    let selected = popup
        .lines()
        .find(|line| line.trim_start().starts_with('›'))
        .unwrap_or_default();
    assert!(selected.contains("OpenAI"), "current provider not selected:\n{popup}");
    // The long model list does not open first.
    assert!(!popup.contains("Choose a mind and effort"), "{popup}");
}

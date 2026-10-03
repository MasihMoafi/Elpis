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

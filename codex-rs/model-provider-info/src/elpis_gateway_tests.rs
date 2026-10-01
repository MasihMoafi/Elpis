use super::*;
use pretty_assertions::assert_eq;
use serde::Deserialize;

// These tests never call `set_elpis_gateway_address`: the address is process-wide, and other
// tests in this crate compare two `built_in_model_providers()` results that must agree.
const UNSTARTED_BASE_URL: &str = "http://elpis-gateway.invalid/v1";

#[derive(Deserialize)]
struct Config {
    #[serde(deserialize_with = "deserialize_configured_model_providers")]
    model_providers: HashMap<String, ModelProviderInfo>,
}

fn configured(text: &str) -> Result<HashMap<String, ModelProviderInfo>, String> {
    toml::from_str::<Config>(text)
        .map(|config| config.model_providers)
        .map_err(|error| error.to_string())
}

fn header(provider: &ModelProviderInfo, name: &str) -> Option<String> {
    provider
        .http_headers
        .as_ref()
        .and_then(|headers| headers.get(name))
        .map(|value| value.as_str().to_string())
}

#[test]
fn built_in_anthropic_is_a_responses_provider_pointing_at_the_gateway() {
    let providers: HashMap<_, _> = built_in_gateway_providers().into_iter().collect();
    let anthropic = &providers[ANTHROPIC_PROVIDER_ID];

    assert_eq!(anthropic.wire_api, WireApi::Responses);
    assert_eq!(anthropic.base_url.as_deref(), Some(UNSTARTED_BASE_URL));
    // Core must neither send the key itself nor fail on a missing variable.
    assert_eq!(anthropic.env_key, None);
    assert!(!anthropic.requires_openai_auth);
    assert!(!anthropic.supports_websockets);
    assert_eq!(
        gateway_route(anthropic),
        Some(GatewayRoute {
            provider_id: ANTHROPIC_PROVIDER_ID.to_string(),
            wire: GatewayWire::AnthropicMessages,
            upstream_base_url: ANTHROPIC_BASE_URL.to_string(),
            env_key: Some(ANTHROPIC_API_KEY_ENV.to_string()),
        })
    );
}

#[test]
fn built_in_catalog_names_the_gateway_providers_and_leaves_openai_direct() {
    let providers = crate::built_in_model_providers(/*openai_base_url*/ None);
    let routed = |id: &str| {
        providers
            .get(id)
            .and_then(gateway_route)
            .map(|route| route.wire)
    };

    assert_eq!(
        routed(ANTHROPIC_PROVIDER_ID),
        Some(GatewayWire::AnthropicMessages)
    );
    assert_eq!(
        routed(GOOGLE_GEMINI_PROVIDER_ID),
        Some(GatewayWire::GeminiGenerateContent)
    );
    assert_eq!(routed(OPENROUTER_PROVIDER_ID), Some(GatewayWire::Chat));
    assert_eq!(routed(crate::OPENAI_PROVIDER_ID), None);
    assert_eq!(routed(crate::OLLAMA_OSS_PROVIDER_ID), None);
}

#[test]
fn openrouter_forwards_its_title_header_under_the_gateway_prefix() {
    let providers: HashMap<_, _> = built_in_gateway_providers().into_iter().collect();
    let openrouter = &providers[OPENROUTER_PROVIDER_ID];

    assert_eq!(
        header(openrouter, "x-elpis-fwd-x-openrouter-title").as_deref(),
        Some("Elpis")
    );
    assert_eq!(header(openrouter, "X-OpenRouter-Title"), None);
}

#[test]
fn a_configured_chat_provider_is_routed_through_the_gateway() {
    let providers = configured(
        r#"
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "chat"
requires_openai_auth = true
request_max_retries = 0
http_headers = { "X-Title" = "Elpis" }
env_http_headers = { "X-Org" = "DEEPSEEK_ORG" }
"#,
    )
    .expect("a chat provider loads");
    let deepseek = &providers["deepseek"];

    assert_eq!(deepseek.wire_api, WireApi::Responses);
    assert_eq!(deepseek.base_url.as_deref(), Some(UNSTARTED_BASE_URL));
    assert_eq!(deepseek.env_key, None);
    // The OpenAI login is never handed to a third-party vendor.
    assert!(!deepseek.requires_openai_auth);
    assert_eq!(deepseek.request_max_retries, Some(0));
    assert_eq!(
        gateway_route(deepseek),
        Some(GatewayRoute {
            provider_id: "deepseek".to_string(),
            wire: GatewayWire::Chat,
            upstream_base_url: "https://api.deepseek.com/v1".to_string(),
            env_key: Some("DEEPSEEK_API_KEY".to_string()),
        })
    );
    assert_eq!(
        header(deepseek, "x-elpis-fwd-x-title").as_deref(),
        Some("Elpis")
    );
    assert_eq!(
        deepseek.env_http_headers,
        Some(HashMap::from([(
            "x-elpis-fwd-x-org".to_string(),
            "DEEPSEEK_ORG".to_string()
        )]))
    );
}

#[test]
fn v030_protocol_names_all_route_through_the_gateway() {
    let providers = configured(
        r#"
[model_providers.a]
name = "A"
base_url = "http://127.0.0.1:1/v1"
wire_api = "anthropic_messages"

[model_providers.g]
name = "G"
base_url = "http://127.0.0.1:2/v1beta"
wire_api = "gemini_generate_content"

[model_providers.c]
name = "C"
base_url = "http://127.0.0.1:3/v1"
wire_api = "chat_completions"
"#,
    )
    .expect("v0.3.0 protocol names load");
    let wire = |id: &str| gateway_route(&providers[id]).map(|route| route.wire);

    assert_eq!(wire("a"), Some(GatewayWire::AnthropicMessages));
    assert_eq!(wire("g"), Some(GatewayWire::GeminiGenerateContent));
    assert_eq!(wire("c"), Some(GatewayWire::Chat));
}

#[test]
fn a_configured_responses_provider_is_left_exactly_as_upstream_reads_it() {
    let text = r#"
name = "Local"
base_url = "http://localhost:8080/v1"
env_key = "LOCAL_KEY"
wire_api = "responses"
"#;
    let providers = configured(&format!("[model_providers.local]\n{text}"))
        .expect("a responses provider loads");
    let upstream: ModelProviderInfo = toml::from_str(text).expect("upstream parse");

    assert_eq!(providers["local"], upstream);
    assert_eq!(gateway_route(&providers["local"]), None);
}

#[test]
fn a_gateway_protocol_without_a_base_url_is_refused() {
    let error = configured(
        r#"
[model_providers.nowhere]
name = "Nowhere"
wire_api = "chat"
"#,
    )
    .expect_err("a chat provider needs a base_url");

    assert!(
        error.contains("model_providers.nowhere: wire_api = \"chat\" needs a base_url"),
        "{error}"
    );
}

#[test]
fn an_unknown_wire_api_is_still_refused() {
    let error = configured(
        r#"
[model_providers.odd]
name = "Odd"
base_url = "http://127.0.0.1:4/v1"
wire_api = "grpc"
"#,
    )
    .expect_err("an unknown protocol is refused");

    assert!(error.contains("grpc"), "{error}");
}

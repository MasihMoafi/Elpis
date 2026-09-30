use super::*;
use pretty_assertions::assert_eq;

const TOKEN: &str = "process-token";

fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(*name, HeaderValue::from_str(value).expect("header value"));
    }
    headers
}

fn anthropic_headers() -> HeaderMap {
    headers(&[
        (GATEWAY_TOKEN_HEADER, TOKEN),
        (GATEWAY_WIRE_HEADER, "anthropic_messages"),
        (GATEWAY_UPSTREAM_HEADER, "https://api.anthropic.com/v1/"),
        (GATEWAY_PROVIDER_HEADER, "anthropic"),
        (GATEWAY_ENV_KEY_HEADER, "ANTHROPIC_API_KEY"),
        ("x-elpis-fwd-x-title", "Elpis"),
        ("session_id", "not-for-the-vendor"),
    ])
}

#[test]
fn a_request_without_this_process_token_is_refused() {
    for token in ["", "another-process"] {
        let mut request = anthropic_headers();
        if token.is_empty() {
            request.remove(GATEWAY_TOKEN_HEADER);
        } else {
            request.insert(GATEWAY_TOKEN_HEADER, HeaderValue::from_static("another-process"));
        }
        let error = Route::from_headers(&request, TOKEN).expect_err("refused");
        assert_eq!(error.status, http::StatusCode::FORBIDDEN);
    }
    // An unstarted gateway has no token; nothing may match it.
    let unstarted = headers(&[(GATEWAY_TOKEN_HEADER, "")]);
    assert!(Route::from_headers(&unstarted, "").is_err());
}

#[test]
fn the_route_reads_the_vendor_and_only_forwards_configured_headers() {
    let route = Route::from_headers(&anthropic_headers(), TOKEN).expect("route");

    assert_eq!(route.provider_id, "anthropic");
    assert_eq!(route.wire, GatewayWire::AnthropicMessages);
    assert_eq!(route.upstream, "https://api.anthropic.com/v1");
    assert_eq!(route.env_key.as_deref(), Some("ANTHROPIC_API_KEY"));
    assert_eq!(route.bearer, None);
    assert_eq!(
        route
            .forwarded
            .iter()
            .map(|(name, value)| (name.as_str(), value.to_str().unwrap_or_default()))
            .collect::<Vec<_>>(),
        vec![("x-title", "Elpis")]
    );
}

#[test]
fn each_vendor_gets_its_own_key_header() {
    let anthropic = Route::from_headers(&anthropic_headers(), TOKEN).expect("route");
    let sent = anthropic.vendor_headers(Some("sk-ant")).expect("headers");
    assert_eq!(sent.get("x-api-key").and_then(|v| v.to_str().ok()), Some("sk-ant"));
    assert_eq!(
        sent.get("anthropic-version").and_then(|v| v.to_str().ok()),
        Some("2023-06-01")
    );
    assert_eq!(sent.get(AUTHORIZATION), None);

    let mut gemini = anthropic.clone();
    gemini.wire = GatewayWire::GeminiGenerateContent;
    let sent = gemini.vendor_headers(Some("gm-key")).expect("headers");
    assert_eq!(sent.get("x-goog-api-key").and_then(|v| v.to_str().ok()), Some("gm-key"));
    assert_eq!(sent.get("x-api-key"), None);

    let mut chat = anthropic.clone();
    chat.wire = GatewayWire::Chat;
    let sent = chat.vendor_headers(Some("or-key")).expect("headers");
    assert_eq!(
        sent.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
        Some("Bearer or-key")
    );
    // A local Chat server needs no key.
    assert_eq!(chat.vendor_headers(None).expect("headers").get(AUTHORIZATION), None);
}

#[test]
fn a_forwarded_anthropic_version_is_kept() {
    let mut request = anthropic_headers();
    request.insert("x-elpis-fwd-anthropic-version", HeaderValue::from_static("2025-01-01"));
    let route = Route::from_headers(&request, TOKEN).expect("route");
    let sent = route.vendor_headers(Some("sk-ant")).expect("headers");

    assert_eq!(
        sent.get("anthropic-version").and_then(|v| v.to_str().ok()),
        Some("2025-01-01")
    );
}

#[test]
fn a_missing_key_names_the_variable_to_set() {
    let route = Route::from_headers(&anthropic_headers(), TOKEN).expect("route");
    let error = route.vendor_headers(None).expect_err("Anthropic needs a key");

    assert_eq!(error.status, http::StatusCode::FORBIDDEN);
    assert!(error.message.contains("ANTHROPIC_API_KEY"), "{}", error.message);
}

#[test]
fn a_bearer_from_core_is_read() {
    let mut request = anthropic_headers();
    request.insert(AUTHORIZATION, HeaderValue::from_static("Bearer config-token"));

    assert_eq!(
        Route::from_headers(&request, TOKEN).expect("route").bearer.as_deref(),
        Some("config-token")
    );
}

#[test]
fn vendor_urls_follow_each_protocol() {
    let mut route = Route::from_headers(&anthropic_headers(), TOKEN).expect("route");
    assert_eq!(
        route.responses_url("claude-sonnet-4-6", None),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(route.models_url(), "https://api.anthropic.com/v1/models?limit=1000");

    route.wire = GatewayWire::GeminiGenerateContent;
    route.upstream = "https://generativelanguage.googleapis.com/v1beta".to_string();
    assert_eq!(
        route.responses_url("models/gemini-3.5-flash", Some("api-version=1")),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?api-version=1&alt=sse"
    );

    route.wire = GatewayWire::Chat;
    route.upstream = "https://openrouter.ai/api/v1".to_string();
    assert_eq!(
        route.responses_url("openrouter/free", None),
        "https://openrouter.ai/api/v1/chat/completions"
    );
    assert_eq!(route.models_url(), "https://openrouter.ai/api/v1/models");
}

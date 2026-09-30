//! The gateway over real HTTP, against a loopback fake vendor.

use std::collections::HashMap;

use super::*;
use crate::test_support::completed;
use crate::test_support::core_tools;
use crate::test_support::done_items;
use crate::test_support::failure;
use crate::test_support::responses_request;
use crate::test_support::streamed_text;
use codex_model_provider_info::GATEWAY_ENV_KEY_HEADER;
use codex_model_provider_info::GATEWAY_PROVIDER_HEADER;
use codex_model_provider_info::GATEWAY_TOKEN_HEADER;
use codex_model_provider_info::GATEWAY_UPSTREAM_HEADER;
use codex_model_provider_info::GATEWAY_WIRE_HEADER;
use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ModelsResponse;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

const UNSET_VARIABLE: &str = "ELPIS_GATEWAY_TEST_VARIABLE_THAT_IS_NEVER_SET";

fn client() -> reqwest::Client {
    // The tests talk to loopback servers; an inherited proxy must not intercept them.
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client")
}

fn route_headers(
    gateway: &GatewayHandle,
    wire: &str,
    upstream: &str,
    provider: &str,
) -> Vec<(String, String)> {
    vec![
        (GATEWAY_TOKEN_HEADER.to_string(), gateway.token().to_string()),
        (GATEWAY_WIRE_HEADER.to_string(), wire.to_string()),
        (GATEWAY_UPSTREAM_HEADER.to_string(), upstream.to_string()),
        (GATEWAY_PROVIDER_HEADER.to_string(), provider.to_string()),
        (GATEWAY_ENV_KEY_HEADER.to_string(), UNSET_VARIABLE.to_string()),
    ]
}

async fn send(
    method: reqwest::Method,
    url: String,
    headers: &[(String, String)],
    body: Option<&Value>,
) -> (StatusCode, String) {
    let mut request = client().request(method, url);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.expect("the gateway answers");
    let status = response.status();
    (status, response.text().await.expect("a body"))
}

fn vendor_sse(events: &[(&str, Value)]) -> String {
    events
        .iter()
        .map(|(kind, data)| format!("event: {kind}\ndata: {data}\n\n"))
        .collect()
}

fn parse_sse(text: &str) -> Vec<Value> {
    text.split("\n\n")
        .filter_map(|frame| frame.lines().find_map(|line| line.strip_prefix("data: ")))
        .map(|data| serde_json::from_str(data).expect("an event is JSON"))
        .collect()
}

fn user_turn() -> Value {
    json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "List files."}]}])
}

fn anthropic_tool_stream() -> String {
    vendor_sse(&[
        (
            "message_start",
            json!({"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 7, "output_tokens": 1}}}),
        ),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "exec_command", "input": {}}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"cmd\":\"ls\"}"}}),
        ),
        (
            "content_block_stop",
            json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 5}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ])
}

#[tokio::test]
async fn an_anthropic_tool_turn_round_trips_with_a_saved_key() {
    let vendor = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("x-api-key", "saved-anthropic-key"))
        .and(header("anthropic-version", "2023-06-01"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(anthropic_tool_stream(), "text/event-stream"),
        )
        .expect(1)
        .mount(&vendor)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "fixture-anthropic", "saved-anthropic-key").expect("save");
    let gateway = start(home.path().to_path_buf()).await.expect("gateway");

    let (status, text) = send(
        reqwest::Method::POST,
        format!("{}/v1/responses", gateway.origin()),
        &route_headers(
            &gateway,
            "anthropic_messages",
            &format!("{}/v1", vendor.uri()),
            "fixture-anthropic",
        ),
        Some(&responses_request(user_turn(), core_tools())),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{text}");
    let events = parse_sse(&text);
    match done_items(&events).as_slice() {
        [ResponseItem::FunctionCall {
            name,
            arguments,
            call_id,
            ..
        }] => {
            assert_eq!(
                (name.as_str(), arguments.as_str(), call_id.as_str()),
                ("exec_command", r#"{"cmd":"ls"}"#, "toolu_1")
            );
        }
        other => panic!("unexpected items: {other:?}"),
    }
    assert_eq!(completed(&events).expect("completed")["end_turn"], false);

    let received = vendor.received_requests().await.expect("recorded");
    let body: Value = serde_json::from_slice(&received[0].body).expect("json");
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["system"][0]["text"], "Be exact.");
    assert_eq!(
        body["messages"],
        json!([{"role": "user", "content": [{"type": "text", "text": "List files."}]}])
    );
    assert_eq!(body["tools"][1]["name"], "apply_patch");
    // Nothing core addressed to the gateway reaches the vendor.
    assert_eq!(body.get("input"), None);
    for name in [GATEWAY_TOKEN_HEADER, GATEWAY_UPSTREAM_HEADER, GATEWAY_ENV_KEY_HEADER] {
        assert!(received[0].headers.get(name).is_none(), "{name} leaked");
    }
}

#[tokio::test]
async fn a_request_without_the_process_token_never_reaches_the_vendor() {
    let vendor = MockServer::start().await;
    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "fixture-anthropic", "saved-anthropic-key").expect("save");
    let gateway = start(home.path().to_path_buf()).await.expect("gateway");
    let mut headers = route_headers(
        &gateway,
        "anthropic_messages",
        &format!("{}/v1", vendor.uri()),
        "fixture-anthropic",
    );
    headers.retain(|(name, _)| name != GATEWAY_TOKEN_HEADER);

    let (status, _) = send(
        reqwest::Method::POST,
        format!("{}/v1/responses", gateway.origin()),
        &headers,
        Some(&responses_request(user_turn(), core_tools())),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(vendor.received_requests().await.map(|requests| requests.len()), Some(0));
}

#[tokio::test]
async fn a_missing_key_and_a_rejected_key_are_errors_core_does_not_retry_as_logins() {
    let vendor = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_json(
            json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}),
        ))
        .mount(&vendor)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    let gateway = start(home.path().to_path_buf()).await.expect("gateway");
    let headers = route_headers(
        &gateway,
        "anthropic_messages",
        &format!("{}/v1", vendor.uri()),
        "fixture-anthropic",
    );
    let url = format!("{}/v1/responses", gateway.origin());
    let request = responses_request(user_turn(), core_tools());

    let (status, text) = send(reqwest::Method::POST, url.clone(), &headers, Some(&request)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text.contains(UNSET_VARIABLE), "{text}");
    assert_eq!(vendor.received_requests().await.map(|requests| requests.len()), Some(0));

    save_provider_key(home.path(), "fixture-anthropic", "wrong-key").expect("save");
    let (status, text) = send(reqwest::Method::POST, url, &headers, Some(&request)).await;
    // 403, not 401: core answers a 401 by refreshing the OpenAI login.
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(text.contains("invalid x-api-key"), "{text}");
}

#[tokio::test]
async fn models_are_served_as_a_catalog_core_reads() {
    let vendor = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("x-api-key", "saved-anthropic-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [
            {"id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6"},
            {"id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5"},
        ]})))
        .mount(&vendor)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "fixture-anthropic", "saved-anthropic-key").expect("save");
    let gateway = start(home.path().to_path_buf()).await.expect("gateway");

    let (status, text) = send(
        reqwest::Method::GET,
        format!("{}/v1/models?client_version=0.159.0", gateway.origin()),
        &route_headers(
            &gateway,
            "anthropic_messages",
            &format!("{}/v1", vendor.uri()),
            "fixture-anthropic",
        ),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{text}");
    let catalog: ModelsResponse = serde_json::from_str(&text).expect("core reads it");
    assert_eq!(
        catalog
            .models
            .iter()
            .map(|model| model.slug.as_str())
            .collect::<Vec<_>>(),
        vec!["claude-sonnet-4-6", "claude-haiku-4-5"]
    );
}

#[tokio::test]
async fn a_provider_routed_by_model_provider_info_reaches_its_vendor() {
    let vendor = MockServer::start().await;
    let stream = vendor_sse(&[
        ("", json!({"choices": [{"index": 0, "delta": {"content": "DONE"}}]})),
        (
            "",
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 7, "completion_tokens": 4}}),
        ),
    ]) + "data: [DONE]\n\n";
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer fixture-chat-key"))
        .and(header("x-title", "Elpis"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(stream, "text/event-stream"))
        .expect(1)
        .mount(&vendor)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    save_provider_key(home.path(), "fixture-chat", "fixture-chat-key").expect("save");
    // The only test that installs the process-wide address.
    let gateway = start_for_process(home.path()).await.expect("gateway");
    let mut provider = ModelProviderInfo {
        name: "Fixture Chat".to_string(),
        base_url: Some(format!("{}/v1", vendor.uri())),
        env_key: Some(UNSET_VARIABLE.to_string()),
        http_headers: Some(HashMap::from([("X-Title".to_string(), "Elpis".into())])),
        ..ModelProviderInfo::default()
    };
    codex_model_provider_info::route_through_gateway("fixture-chat", GatewayWire::Chat, &mut provider)
        .expect("routed");

    let base_url = provider.base_url.clone().expect("base url");
    assert_eq!(base_url, format!("{}/v1", gateway.origin()));
    // Core sends the provider's headers to its base URL; the gateway does the rest.
    let headers: Vec<(String, String)> = provider
        .http_headers
        .iter()
        .flatten()
        .map(|(name, value)| (name.clone(), value.as_str().to_string()))
        .collect();
    let (status, text) = send(
        reqwest::Method::POST,
        format!("{base_url}/responses"),
        &headers,
        Some(&responses_request(user_turn(), json!([]))),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{text}");
    let events = parse_sse(&text);
    assert_eq!(streamed_text(&events), "DONE");
    assert_eq!(failure(&events), None);
    let response = completed(&events).expect("completed");
    assert_eq!(response["usage"]["total_tokens"], 11);
}

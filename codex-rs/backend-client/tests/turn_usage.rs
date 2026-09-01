use codex_backend_client::ApiKeyResponseCost;
use codex_backend_client::ApiKeyTurnCost;
use codex_backend_client::ApiKeyTurnCostStatus;
use codex_backend_client::Client;
use codex_login::CodexAuth;
use pretty_assertions::assert_eq;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

#[tokio::test]
async fn api_key_turn_cost_query_sends_auth_and_only_provider_scope_headers() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/analytics/codex/turn-costs"))
        .and(header("authorization", "Bearer sk-test"))
        .and(header("openai-organization", "org-test"))
        .and(header("openai-project", "project-test"))
        .and(body_json(serde_json::json!({
            "turn_ids": ["turn-priced", "turn-response", "turn-pending"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "turns": [
                {
                    "turn_id": "turn-priced",
                    "status": "priced",
                    "total_usd": "1.2500000001",
                    "event_count": 2,
                    "model": "gpt-5.6",
                    "speed": "fast",
                    "reasoning_effort": "high"
                },
                {
                    "turn_id": "turn-response",
                    "status": "priced",
                    "total_usd": "0.5000000000",
                    "responses": [{
                        "response_id": "resp-one",
                        "total_usd": "0.5000000000"
                    }]
                },
                {
                    "turn_id": "turn-pending",
                    "status": "pending"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let auth = CodexAuth::from_api_key("sk-test");
    let client = Client::from_auth(format!("{}/backend-api", server.uri()), &auth)
        .expect("build authenticated backend client");
    let mut provider_headers = HeaderMap::new();
    provider_headers.insert("openai-organization", HeaderValue::from_static("org-test"));
    provider_headers.insert("openai-project", HeaderValue::from_static("project-test"));
    provider_headers.insert("x-should-not-leak", HeaderValue::from_static("secret"));

    let costs = client
        .query_api_key_turn_costs(
            &[
                "turn-priced".to_string(),
                "turn-response".to_string(),
                "turn-pending".to_string(),
            ],
            &provider_headers,
        )
        .await
        .expect("query API-key turn costs");

    assert_eq!(
        costs,
        vec![
            ApiKeyTurnCost {
                turn_id: "turn-priced".to_string(),
                status: ApiKeyTurnCostStatus::Priced,
                total_usd: Some("1.2500000001".to_string()),
                event_count: Some(2),
                responses: None,
                model: Some("gpt-5.6".to_string()),
                speed: Some("fast".to_string()),
                reasoning_effort: Some("high".to_string()),
            },
            ApiKeyTurnCost {
                turn_id: "turn-response".to_string(),
                status: ApiKeyTurnCostStatus::Priced,
                total_usd: Some("0.5000000000".to_string()),
                event_count: None,
                responses: Some(vec![ApiKeyResponseCost {
                    response_id: "resp-one".to_string(),
                    total_usd: "0.5000000000".to_string(),
                }]),
                model: None,
                speed: None,
                reasoning_effort: None,
            },
            ApiKeyTurnCost {
                turn_id: "turn-pending".to_string(),
                status: ApiKeyTurnCostStatus::Pending,
                total_usd: None,
                event_count: None,
                responses: None,
                model: None,
                speed: None,
                reasoning_effort: None,
            },
        ]
    );
    let requests = server
        .received_requests()
        .await
        .expect("read captured turn-cost request");
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].headers.contains_key("x-should-not-leak"));
}

#[tokio::test]
async fn custom_turn_cost_query_keeps_client_auth_authoritative() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/analytics/codex/turn-costs"))
        .and(header("authorization", "Bearer sk-test"))
        .and(header("chatgpt-account-id", "account-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "turns": []
        })))
        .expect(1)
        .mount(&server)
        .await;

    let auth = CodexAuth::from_api_key("sk-test");
    let client = Client::from_auth(server.uri(), &auth)
        .expect("build authenticated backend client")
        .with_chatgpt_account_id("account-test");
    let mut provider_headers = HeaderMap::new();
    provider_headers.insert(
        "authorization",
        HeaderValue::from_static("Bearer provider-override"),
    );
    provider_headers.insert(
        "chatgpt-account-id",
        HeaderValue::from_static("provider-account-override"),
    );

    let costs = client
        .query_api_key_turn_costs_at(
            &format!("{}/analytics/codex/turn-costs", server.uri()),
            &["turn-one".to_string()],
            &provider_headers,
        )
        .await
        .expect("query custom-provider turn costs");

    assert_eq!(costs, Vec::new());
}

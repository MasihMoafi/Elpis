use super::Client;
use super::RequestError;
use reqwest::Url;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyTurnCostStatus {
    Pending,
    Priced,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ApiKeyResponseCost {
    pub response_id: String,
    pub total_usd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ApiKeyTurnCost {
    pub turn_id: String,
    pub status: ApiKeyTurnCostStatus,
    pub total_usd: Option<String>,
    pub event_count: Option<u64>,
    pub responses: Option<Vec<ApiKeyResponseCost>>,
    pub model: Option<String>,
    pub speed: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Serialize)]
struct ApiKeyTurnCostsRequest<'a> {
    turn_ids: &'a [String],
}

#[derive(Deserialize)]
struct ApiKeyTurnCostsResponse {
    turns: Vec<ApiKeyTurnCost>,
}

impl Client {
    pub async fn query_api_key_turn_costs(
        &self,
        turn_ids: &[String],
        provider_headers: &HeaderMap,
    ) -> Result<Vec<ApiKeyTurnCost>, RequestError> {
        let mut url =
            Url::parse(&self.base_url).map_err(|error| RequestError::Other(error.into()))?;
        let analytics_host = match url.host_str() {
            Some("chatgpt.com" | "chat.openai.com") => Some("api.chatgpt.com"),
            Some("chatgpt-staging.com") => Some("api.chatgpt-staging.com"),
            _ => None,
        };
        if let Some(host) = analytics_host {
            url.set_host(Some(host))
                .map_err(|error| RequestError::Other(error.into()))?;
        }
        url.set_path("/v1/analytics/codex/turn-costs");
        url.set_query(None);
        url.set_fragment(None);
        let provider_scope_headers = provider_headers
            .iter()
            .filter(|(name, _)| {
                ["openai-organization", "openai-project"]
                    .iter()
                    .any(|allowed| name.as_str().eq_ignore_ascii_case(allowed))
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        self.query_api_key_turn_costs_at(url.as_ref(), turn_ids, &provider_scope_headers)
            .await
    }

    pub async fn query_api_key_turn_costs_at(
        &self,
        url: &str,
        turn_ids: &[String],
        provider_headers: &HeaderMap,
    ) -> Result<Vec<ApiKeyTurnCost>, RequestError> {
        let mut headers = provider_headers.clone();
        headers.extend(self.headers());
        let request = self
            .http
            .post(url)
            .headers(headers)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .json(&ApiKeyTurnCostsRequest { turn_ids });
        let (body, content_type) = self.exec_request_detailed(request, "POST", url).await?;
        let response: ApiKeyTurnCostsResponse = self
            .decode_json(url, &content_type, &body)
            .map_err(RequestError::Other)?;
        Ok(response.turns)
    }
}

//! Native hosted-provider protocol adapters.
//!
//! OpenAI and OpenRouter continue to use the existing Responses implementation. This module only
//! translates the canonical Responses-shaped request into Anthropic Messages or Gemini
//! GenerateContent and translates their SSE streams back into canonical `ResponseEvent`s.

use std::collections::HashMap;
use std::collections::HashSet;
use std::time::Duration;

use codex_api::ApiError;
use codex_api::AuthProvider;
use codex_api::Provider;
use codex_api::ResponseEvent;
use codex_api::ResponseStream;
use codex_api::ResponsesApiRequest;
use codex_http_client::ClientRouteClass;
use codex_http_client::HttpClientFactory;
use codex_model_provider_info::WireApi;
use codex_protocol::models::ContentItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::TokenUsage;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

const STREAM_CHANNEL_CAPACITY: usize = 1600;
const ANTHROPIC_MAX_TOKENS: u64 = 8192;

pub(crate) async fn stream_native_request(
    provider: Provider,
    auth: &dyn AuthProvider,
    http_client_factory: &HttpClientFactory,
    request: ResponsesApiRequest,
    wire_api: WireApi,
) -> Result<ResponseStream, ApiError> {
    let (path, body) = match wire_api {
        WireApi::AnthropicMessages => ("messages".to_string(), anthropic_request(&request)?),
        WireApi::GeminiGenerateContent => {
            let model = request
                .model
                .strip_prefix("models/")
                .unwrap_or(&request.model);
            (
                format!("models/{model}:streamGenerateContent"),
                gemini_request(&request)?,
            )
        }
        WireApi::Chat => (
            "chat/completions".to_string(),
            chat_completions_request(&request)?,
        ),
        WireApi::Responses => {
            return Err(ApiError::InvalidRequest {
                message: "native provider adapter called for the Responses protocol".to_string(),
            });
        }
    };

    let url = provider.url_for_path(&path);
    let client = http_client_factory
        .build_reqwest_client(reqwest::Client::builder(), &url, ClientRouteClass::Api)
        .map_err(|error| {
            ApiError::Stream(format!("failed to build provider HTTP client: {error}"))
        })?;

    let mut headers = provider.headers.clone();
    auth.add_auth_headers(&mut headers);
    headers.insert(
        http::header::ACCEPT,
        http::HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );

    let mut builder = client.post(&url).headers(headers).json(&body);
    if wire_api == WireApi::GeminiGenerateContent {
        builder = builder.query(&[("alt", "sse")]);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| ApiError::Stream(format!("provider request failed: {error}")))?;
    let status = response.status();
    let upstream_request_id = response
        .headers()
        .get("request-id")
        .or_else(|| response.headers().get("x-request-id"))
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);

    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "provider returned an unreadable error body".to_string());
        return Err(map_http_error(status, vendor_error_message(&body)));
    }

    let idle_timeout = provider.stream_idle_timeout;
    let (tx, rx_event) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let mut events = response.bytes_stream().eventsource();
    tokio::spawn(async move {
        if tx.send(Ok(ResponseEvent::Created)).await.is_err() {
            return;
        }
        let result = match wire_api {
            WireApi::AnthropicMessages => {
                stream_anthropic_events(&mut events, &tx, idle_timeout).await
            }
            WireApi::GeminiGenerateContent => {
                stream_gemini_events(&mut events, &tx, idle_timeout).await
            }
            WireApi::Chat => {
                stream_chat_completions_events(&mut events, &tx, idle_timeout).await
            }
            WireApi::Responses => unreachable!("validated before spawning stream"),
        };
        if let Err(error) = result {
            let _ = tx.send(Err(error)).await;
        }
    });

    Ok(ResponseStream {
        rx_event,
        upstream_request_id,
    })
}

fn map_http_error(status: StatusCode, message: String) -> ApiError {
    match status.as_u16() {
        429 => ApiError::RateLimit(message),
        500 | 502 | 503 | 504 => ApiError::Retryable {
            message,
            delay: None,
        },
        _ => ApiError::Api { status, message },
    }
}

fn vendor_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.pointer("/message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| body.to_string())
}

fn anthropic_request(request: &ResponsesApiRequest) -> Result<Value, ApiError> {
    let mut system = vec![request.instructions.clone()];
    let mut messages = Vec::<Value>::new();
    let mut current_role: Option<&str> = None;
    let mut current_content = Vec::<Value>::new();

    let flush = |messages: &mut Vec<Value>, role: &mut Option<&str>, content: &mut Vec<Value>| {
        if let Some(role_value) = role.take()
            && !content.is_empty()
        {
            messages.push(json!({"role": role_value, "content": std::mem::take(content)}));
        }
    };

    for item in &request.input {
        match item {
            ResponseItem::Message { role, content, .. }
                if role == "system" || role == "developer" =>
            {
                let text = content_text(content)?;
                if !text.is_empty() {
                    system.push(text);
                }
            }
            ResponseItem::Message { role, content, .. }
                if role == "user" || role == "assistant" =>
            {
                let target_role = if role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                if current_role != Some(target_role) {
                    flush(&mut messages, &mut current_role, &mut current_content);
                    current_role = Some(target_role);
                }
                let text = content_text(content)?;
                if !text.is_empty() {
                    current_content.push(json!({"type": "text", "text": text}));
                }
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                if current_role != Some("assistant") {
                    flush(&mut messages, &mut current_role, &mut current_content);
                    current_role = Some("assistant");
                }
                current_content.push(json!({
                    "type": "tool_use",
                    "id": call_id,
                    "name": name,
                    "input": parse_object(arguments, "Anthropic tool input")?,
                }));
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            } => {
                if current_role != Some("user") {
                    flush(&mut messages, &mut current_role, &mut current_content);
                    current_role = Some("user");
                }
                let text = output
                    .body
                    .to_text()
                    .ok_or_else(|| ApiError::InvalidRequest {
                        message: "Anthropic tool results currently support text content only"
                            .to_string(),
                    })?;
                current_content.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": text,
                    "is_error": output.success == Some(false),
                }));
            }
            ResponseItem::Reasoning { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::Other => {}
            unsupported => return Err(unsupported_history_item("Anthropic", unsupported)),
        }
    }
    flush(&mut messages, &mut current_role, &mut current_content);

    let tools = translate_anthropic_tools(request.tools.as_deref().unwrap_or_default())?;
    let mut body = json!({
        "model": request.model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "stream": true,
        "system": system.into_iter().filter(|text| !text.is_empty()).map(|text| json!({"type":"text", "text": text})).collect::<Vec<_>>(),
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    Ok(body)
}

fn gemini_request(request: &ResponsesApiRequest) -> Result<Value, ApiError> {
    let mut system = vec![request.instructions.clone()];
    let mut contents = Vec::<Value>::new();
    let mut current_role: Option<&str> = None;
    let mut current_parts = Vec::<Value>::new();
    let mut call_names = HashMap::<String, String>::new();

    let flush = |contents: &mut Vec<Value>, role: &mut Option<&str>, parts: &mut Vec<Value>| {
        if let Some(role_value) = role.take()
            && !parts.is_empty()
        {
            contents.push(json!({"role": role_value, "parts": std::mem::take(parts)}));
        }
    };

    for item in &request.input {
        match item {
            ResponseItem::Message { role, content, .. }
                if role == "system" || role == "developer" =>
            {
                let text = content_text(content)?;
                if !text.is_empty() {
                    system.push(text);
                }
            }
            ResponseItem::Message { role, content, .. }
                if role == "user" || role == "assistant" =>
            {
                let target_role = if role == "assistant" { "model" } else { "user" };
                if current_role != Some(target_role) {
                    flush(&mut contents, &mut current_role, &mut current_parts);
                    current_role = Some(target_role);
                }
                let text = content_text(content)?;
                if !text.is_empty() {
                    current_parts.push(json!({"text": text}));
                }
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                if current_role != Some("model") {
                    flush(&mut contents, &mut current_role, &mut current_parts);
                    current_role = Some("model");
                }
                call_names.insert(call_id.clone(), name.clone());
                current_parts.push(json!({
                    "functionCall": {
                        "id": call_id,
                        "name": name,
                        "args": parse_object(arguments, "Gemini function arguments")?,
                    }
                }));
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            } => {
                if current_role != Some("user") {
                    flush(&mut contents, &mut current_role, &mut current_parts);
                    current_role = Some("user");
                }
                let name = call_names
                    .get(call_id)
                    .ok_or_else(|| ApiError::InvalidRequest {
                        message: format!(
                            "Gemini function result `{call_id}` has no preceding function call name"
                        ),
                    })?;
                let text = output
                    .body
                    .to_text()
                    .ok_or_else(|| ApiError::InvalidRequest {
                        message: "Gemini function results currently support text content only"
                            .to_string(),
                    })?;
                current_parts.push(json!({
                    "functionResponse": {
                        "id": call_id,
                        "name": name,
                        "response": {
                            "output": text,
                            "success": output.success.unwrap_or(true),
                        }
                    }
                }));
            }
            ResponseItem::Reasoning { .. }
            | ResponseItem::Compaction { .. }
            | ResponseItem::ContextCompaction { .. }
            | ResponseItem::CompactionTrigger { .. }
            | ResponseItem::Other => {}
            unsupported => return Err(unsupported_history_item("Gemini", unsupported)),
        }
    }
    flush(&mut contents, &mut current_role, &mut current_parts);

    let declarations = translate_gemini_tools(request.tools.as_deref().unwrap_or_default())?;
    let mut body = json!({
        "systemInstruction": {
            "parts": system.into_iter().filter(|text| !text.is_empty()).map(|text| json!({"text": text})).collect::<Vec<_>>()
        },
        "contents": contents,
    });
    if !declarations.is_empty() {
        body["tools"] = json!([{"functionDeclarations": declarations}]);
        body["toolConfig"] = json!({"functionCallingConfig": {"mode": "AUTO"}});
    }
    Ok(body)
}

fn content_text(content: &[ContentItem]) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for item in content {
        match item {
            ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                parts.push(text.clone())
            }
            ContentItem::InputImage { .. } => {
                return Err(ApiError::InvalidRequest {
                    message: "native Anthropic/Gemini routing does not yet translate image inputs"
                        .to_string(),
                });
            }
        }
    }
    Ok(parts.join("\n"))
}

fn parse_object(text: &str, label: &str) -> Result<Value, ApiError> {
    let value: Value = serde_json::from_str(text).map_err(|error| ApiError::InvalidRequest {
        message: format!("{label} is not valid JSON: {error}"),
    })?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(ApiError::InvalidRequest {
            message: format!("{label} must be a JSON object"),
        })
    }
}

fn unsupported_history_item(provider: &str, item: &ResponseItem) -> ApiError {
    ApiError::InvalidRequest {
        message: format!(
            "{provider} native routing cannot translate history item type `{}`",
            serde_json::to_value(item)
                .ok()
                .and_then(|value| value
                    .get("type")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned))
                .unwrap_or_else(|| "unknown".to_string())
        ),
    }
}

fn translate_anthropic_tools(tools: &[Value]) -> Result<Vec<Value>, ApiError> {
    tools
        .iter()
        .map(|tool| {
            ensure_function_tool(tool, "Anthropic").map(|(name, description, parameters)| {
                json!({
                    "name": name,
                    "description": description,
                    "input_schema": parameters,
                })
            })
        })
        .collect()
}

fn translate_gemini_tools(tools: &[Value]) -> Result<Vec<Value>, ApiError> {
    tools
        .iter()
        .map(|tool| {
            ensure_function_tool(tool, "Gemini").map(|(name, description, parameters)| {
                json!({
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                })
            })
        })
        .collect()
}

fn ensure_function_tool(tool: &Value, provider: &str) -> Result<(String, String, Value), ApiError> {
    if tool.get("type").and_then(Value::as_str) != Some("function") {
        return Err(ApiError::InvalidRequest {
            message: format!(
                "{provider} native routing currently supports function tools only; `{}` is unsupported",
                tool.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ),
        });
    }
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::InvalidRequest {
            message: format!("{provider} function tool is missing `name`"),
        })?
        .to_string();
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let parameters = tool
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    Ok((name, description, parameters))
}

async fn stream_anthropic_events<S>(
    events: &mut S,
    tx: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: Duration,
) -> Result<(), ApiError>
where
    S: futures::Stream<
            Item = Result<
                eventsource_stream::Event,
                eventsource_stream::EventStreamError<reqwest::Error>,
            >,
        > + Unpin,
{
    let mut response_id = String::new();
    let mut input_tokens = 0_i64;
    let mut cached_input_tokens = 0_i64;
    let mut output_tokens = 0_i64;
    let mut stop_reason: Option<String> = None;
    let mut text = String::new();
    let mut tools = HashMap::<u64, ToolAccumulator>::new();

    loop {
        let next = tokio::select! {
            _ = tx.closed() => return Ok(()),
            next = tokio::time::timeout(idle_timeout, events.next()) => next.map_err(|_| {
                ApiError::Stream("Anthropic stream idle timeout".to_string())
            })?,
        };
        let Some(event) = next else { break };
        let event =
            event.map_err(|error| ApiError::Stream(format!("Anthropic SSE error: {error}")))?;
        if event.data == "[DONE]" {
            break;
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|error| ApiError::Stream(format!("invalid Anthropic SSE payload: {error}")))?;
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(event.event.as_str());
        match event_type {
            "message_start" => {
                let message = &value["message"];
                response_id = message["id"].as_str().unwrap_or_default().to_string();
                let usage = &message["usage"];
                input_tokens = anthropic_input_tokens(usage);
                cached_input_tokens = usage["cache_read_input_tokens"].as_i64().unwrap_or(0);
            }
            "content_block_start" => {
                let index = value["index"].as_u64().unwrap_or(0);
                let block = &value["content_block"];
                match block["type"].as_str() {
                    Some("text") => {
                        let initial = block["text"].as_str().unwrap_or_default();
                        if !initial.is_empty() {
                            text.push_str(initial);
                            send(tx, ResponseEvent::OutputTextDelta(initial.to_string())).await?;
                        }
                    }
                    Some("tool_use") => {
                        let call_id = block["id"].as_str().unwrap_or_default().to_string();
                        let name = block["name"].as_str().unwrap_or_default().to_string();
                        let mut arguments = String::new();
                        if let Some(input) = block.get("input")
                            && input.as_object().is_some_and(|object| !object.is_empty())
                        {
                            arguments = input.to_string();
                        }
                        let item = function_call_item(&name, &call_id, String::new());
                        send(tx, ResponseEvent::OutputItemAdded(item)).await?;
                        tools.insert(
                            index,
                            ToolAccumulator {
                                name,
                                call_id,
                                arguments,
                            },
                        );
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let index = value["index"].as_u64().unwrap_or(0);
                let delta = &value["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        let part = delta["text"].as_str().unwrap_or_default();
                        text.push_str(part);
                        send(tx, ResponseEvent::OutputTextDelta(part.to_string())).await?;
                    }
                    Some("input_json_delta") => {
                        let part = delta["partial_json"].as_str().unwrap_or_default();
                        if let Some(tool) = tools.get_mut(&index) {
                            tool.arguments.push_str(part);
                            send(
                                tx,
                                ResponseEvent::ToolCallInputDelta {
                                    item_id: tool.call_id.clone(),
                                    call_id: Some(tool.call_id.clone()),
                                    delta: part.to_string(),
                                },
                            )
                            .await?;
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = value["index"].as_u64().unwrap_or(0);
                if let Some(tool) = tools.remove(&index) {
                    send(
                        tx,
                        ResponseEvent::OutputItemDone(function_call_item(
                            &tool.name,
                            &tool.call_id,
                            tool.arguments,
                        )),
                    )
                    .await?;
                }
            }
            "message_delta" => {
                stop_reason = value["delta"]["stop_reason"]
                    .as_str()
                    .map(ToOwned::to_owned);
                output_tokens = value["usage"]["output_tokens"]
                    .as_i64()
                    .unwrap_or(output_tokens);
            }
            "message_stop" => {
                if response_id.is_empty() {
                    response_id = "anthropic-response".to_string();
                }
                if !text.is_empty() {
                    send(
                        tx,
                        ResponseEvent::OutputItemDone(assistant_message(text.clone())),
                    )
                    .await?;
                }
                let usage = token_usage(input_tokens, cached_input_tokens, output_tokens, 0);
                send(
                    tx,
                    ResponseEvent::Completed {
                        response_id,
                        token_usage: Some(usage),
                        end_turn: anthropic_end_turn(stop_reason.as_deref()),
                    },
                )
                .await?;
                return Ok(());
            }
            "error" => {
                let message = value["error"]["message"]
                    .as_str()
                    .unwrap_or("Anthropic stream error")
                    .to_string();
                return Err(ApiError::Stream(message));
            }
            "ping" => {}
            _ => {}
        }
    }
    Err(ApiError::Stream(
        "Anthropic stream ended without message_stop".to_string(),
    ))
}

async fn stream_gemini_events<S>(
    events: &mut S,
    tx: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: Duration,
) -> Result<(), ApiError>
where
    S: futures::Stream<
            Item = Result<
                eventsource_stream::Event,
                eventsource_stream::EventStreamError<reqwest::Error>,
            >,
        > + Unpin,
{
    let mut response_id = String::new();
    let mut text = String::new();
    let mut usage = TokenUsage::default();
    let mut completed = false;
    let mut call_counter = 0_u64;
    let mut saw_function_call = false;
    let mut seen_function_calls = HashSet::<String>::new();

    loop {
        let next = tokio::select! {
            _ = tx.closed() => return Ok(()),
            next = tokio::time::timeout(idle_timeout, events.next()) => next.map_err(|_| {
                ApiError::Stream("Gemini stream idle timeout".to_string())
            })?,
        };
        let Some(event) = next else { break };
        let event =
            event.map_err(|error| ApiError::Stream(format!("Gemini SSE error: {error}")))?;
        if event.data == "[DONE]" {
            break;
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|error| ApiError::Stream(format!("invalid Gemini SSE payload: {error}")))?;
        if let Some(error) = value.get("error") {
            return Err(ApiError::Stream(
                error["message"]
                    .as_str()
                    .unwrap_or("Gemini stream error")
                    .to_string(),
            ));
        }
        if response_id.is_empty() {
            response_id = value["responseId"].as_str().unwrap_or_default().to_string();
        }
        if let Some(model) = value["modelVersion"].as_str() {
            send(tx, ResponseEvent::ServerModel(model.to_string())).await?;
        }
        if let Some(metadata) = value.get("usageMetadata") {
            usage = gemini_usage(metadata);
        }
        if let Some(block_reason) = value
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            return Err(ApiError::Stream(format!(
                "Gemini blocked the prompt: {block_reason}"
            )));
        }
        let Some(candidate) = value["candidates"]
            .as_array()
            .and_then(|items| items.first())
        else {
            continue;
        };
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                if let Some(delta) = part["text"].as_str() {
                    text.push_str(delta);
                    send(tx, ResponseEvent::OutputTextDelta(delta.to_string())).await?;
                }
                if let Some(call) = part.get("functionCall") {
                    let name = call["name"].as_str().unwrap_or_default();
                    let arguments = call
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| json!({}))
                        .to_string();
                    let signature = format!("{name}:{arguments}");
                    if !seen_function_calls.insert(signature) {
                        continue;
                    }
                    call_counter += 1;
                    saw_function_call = true;
                    let call_id = call["id"]
                        .as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("gemini-call-{call_counter}"));
                    send(
                        tx,
                        ResponseEvent::OutputItemAdded(function_call_item(
                            name,
                            &call_id,
                            String::new(),
                        )),
                    )
                    .await?;
                    send(
                        tx,
                        ResponseEvent::ToolCallInputDelta {
                            item_id: call_id.clone(),
                            call_id: Some(call_id.clone()),
                            delta: arguments.clone(),
                        },
                    )
                    .await?;
                    send(
                        tx,
                        ResponseEvent::OutputItemDone(function_call_item(
                            name, &call_id, arguments,
                        )),
                    )
                    .await?;
                }
            }
        }
        if let Some(reason) = candidate["finishReason"].as_str() {
            if !text.is_empty() {
                send(
                    tx,
                    ResponseEvent::OutputItemDone(assistant_message(text.clone())),
                )
                .await?;
            }
            if response_id.is_empty() {
                response_id = "gemini-response".to_string();
            }
            send(
                tx,
                ResponseEvent::Completed {
                    response_id,
                    token_usage: Some(usage.clone()),
                    end_turn: if saw_function_call {
                        Some(false)
                    } else {
                        gemini_end_turn(Some(reason))
                    },
                },
            )
            .await?;
            completed = true;
            break;
        }
    }

    if completed {
        Ok(())
    } else {
        Err(ApiError::Stream(
            "Gemini stream ended without a finish reason".to_string(),
        ))
    }
}

async fn send(
    tx: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    event: ResponseEvent,
) -> Result<(), ApiError> {
    tx.send(Ok(event))
        .await
        .map_err(|_| ApiError::Stream("response consumer cancelled".to_string()))
}

#[derive(Debug)]
struct ToolAccumulator {
    name: String,
    call_id: String,
    arguments: String,
}

fn function_call_item(name: &str, call_id: &str, arguments: String) -> ResponseItem {
    ResponseItem::FunctionCall {
        id: None,
        name: name.to_string(),
        namespace: None,
        arguments,
        call_id: call_id.to_string(),
        internal_chat_message_metadata_passthrough: None,
    }
}

fn assistant_message(text: String) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText { text }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn anthropic_input_tokens(usage: &Value) -> i64 {
    usage["input_tokens"].as_i64().unwrap_or(0)
        + usage["cache_creation_input_tokens"].as_i64().unwrap_or(0)
        + usage["cache_read_input_tokens"].as_i64().unwrap_or(0)
}

fn gemini_usage(metadata: &Value) -> TokenUsage {
    let input_tokens = metadata["promptTokenCount"].as_i64().unwrap_or(0);
    let cached_input_tokens = metadata["cachedContentTokenCount"].as_i64().unwrap_or(0);
    let output_tokens = metadata["candidatesTokenCount"].as_i64().unwrap_or(0);
    let reasoning_output_tokens = metadata["thoughtsTokenCount"].as_i64().unwrap_or(0);
    let total_tokens = metadata["totalTokenCount"]
        .as_i64()
        .unwrap_or(input_tokens + output_tokens + reasoning_output_tokens);
    TokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
    }
}

fn token_usage(
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
) -> TokenUsage {
    TokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens: input_tokens + output_tokens + reasoning_output_tokens,
    }
}

fn anthropic_end_turn(reason: Option<&str>) -> Option<bool> {
    match reason {
        Some("end_turn" | "stop_sequence") => Some(true),
        Some("tool_use" | "max_tokens" | "pause_turn" | "refusal") => Some(false),
        Some(_) | None => None,
    }
}

fn gemini_end_turn(reason: Option<&str>) -> Option<bool> {
    match reason {
        Some("STOP") => Some(true),
        Some("FINISH_REASON_UNSPECIFIED") => None,
        Some(
            "MAX_TOKENS"
            | "SAFETY"
            | "RECITATION"
            | "LANGUAGE"
            | "OTHER"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "MALFORMED_FUNCTION_CALL"
            | "IMAGE_SAFETY"
            | "IMAGE_PROHIBITED_CONTENT"
            | "NO_IMAGE"
            | "IMAGE_RECITATION",
        ) => Some(false),
        Some(_) | None => None,
    }
}

fn chat_completions_request(request: &ResponsesApiRequest) -> Result<Value, ApiError> {
    let mut messages = Vec::<Value>::new();

    if !request.instructions.trim().is_empty() {
        messages.push(json!({
            "role": "system",
            "content": request.instructions.trim(),
        }));
    }

    for item in &request.input {
        match item {
            ResponseItem::Message { role, content, .. } => {
                let text = content_text(content)?;
                if !text.is_empty() {
                    let mapped_role = match role.as_str() {
                        "developer" => "system",
                        r => r,
                    };
                    messages.push(json!({
                        "role": mapped_role,
                        "content": text,
                    }));
                }
            }
            ResponseItem::FunctionCall {
                name,
                arguments,
                call_id,
                ..
            } => {
                messages.push(json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        }
                    }]
                }));
            }
            _ => {}
        }
    }

    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true }
    });

    if let Some(tools) = request.tools.as_deref()
        && !tools.is_empty()
    {
        let declarations = translate_gemini_tools(tools)?;
        let openai_tools: Vec<Value> = declarations
            .into_iter()
            .map(|decl| {
                json!({
                    "type": "function",
                    "function": decl
                })
            })
            .collect();
        body["tools"] = json!(openai_tools);
    }

    Ok(body)
}

async fn stream_chat_completions_events<S>(
    events: &mut S,
    tx: &mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: Duration,
) -> Result<(), ApiError>
where
    S: futures::Stream<
            Item = Result<
                eventsource_stream::Event,
                eventsource_stream::EventStreamError<reqwest::Error>,
            >,
        > + Unpin,
{
    let mut response_id = String::new();
    let mut text = String::new();
    let mut input_tokens = 0_i64;
    let mut output_tokens = 0_i64;
    let mut finish_reason: Option<String> = None;

    loop {
        let next = tokio::select! {
            _ = tx.closed() => return Ok(()),
            next = tokio::time::timeout(idle_timeout, events.next()) => next.map_err(|_| {
                ApiError::Stream("ChatCompletions stream idle timeout".to_string())
            })?,
        };
        let Some(event) = next else { break };
        let event = event.map_err(|error| ApiError::Stream(format!("OpenAI Chat SSE error: {error}")))?;
        let data = event.data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| ApiError::Stream(format!("invalid OpenAI Chat SSE payload: {error}")))?;

        if response_id.is_empty() {
            response_id = value["id"].as_str().unwrap_or("chat_response").to_string();
        }

        if let Some(choices) = value["choices"].as_array()
            && let Some(candidate) = choices.first()
        {
            if let Some(reason) = candidate["finish_reason"].as_str() {
                finish_reason = Some(reason.to_string());
            }
            if let Some(delta) = candidate["delta"]["content"].as_str()
                && !delta.is_empty()
            {
                text.push_str(delta);
                send(tx, ResponseEvent::OutputTextDelta(delta.to_string())).await?;
            }
        }

        if let Some(usage) = value.get("usage") {
            input_tokens = usage["prompt_tokens"].as_i64().unwrap_or(input_tokens);
            output_tokens = usage["completion_tokens"].as_i64().unwrap_or(output_tokens);
        }
    }

    if !text.is_empty() {
        send(
            tx,
            ResponseEvent::OutputItemDone(ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: std::mem::take(&mut text),
                }],
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            }),
        )
        .await?;
    }

    let token_usage = if input_tokens > 0 || output_tokens > 0 {
        Some(TokenUsage {
            input_tokens,
            output_tokens,
            total_tokens: input_tokens + output_tokens,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
        })
    } else {
        None
    };

    let end_turn = finish_reason.as_deref().map(|r| r != "tool_calls");
    send(
        tx,
        ResponseEvent::Completed {
            response_id,
            token_usage,
            end_turn,
        },
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use codex_api::SharedAuthProvider;
    use codex_http_client::OutboundProxyPolicy;
    use codex_protocol::models::FunctionCallOutputPayload;
    use eventsource_stream::Event;
    use eventsource_stream::EventStreamError;
    use futures::StreamExt;
    use http::HeaderMap;
    use pretty_assertions::assert_eq;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::body_partial_json;
    use wiremock::matchers::header;
    use wiremock::matchers::method;
    use wiremock::matchers::path;
    use wiremock::matchers::query_param;

    use super::*;

    #[derive(Debug)]
    struct TestAuth {
        header: &'static str,
        value: &'static str,
    }

    impl AuthProvider for TestAuth {
        fn add_auth_headers(&self, headers: &mut HeaderMap) {
            headers.insert(
                http::HeaderName::from_static(self.header),
                http::HeaderValue::from_static(self.value),
            );
        }
    }

    fn request() -> ResponsesApiRequest {
        ResponsesApiRequest {
            model: "test-model".to_string(),
            instructions: "Be exact.".to_string(),
            input: vec![
                ResponseItem::Message {
                    id: None,
                    role: "user".to_string(),
                    content: vec![ContentItem::InputText {
                        text: "Use the weather tool.".to_string(),
                    }],
                    phase: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::Message {
                    id: None,
                    role: "assistant".to_string(),
                    content: vec![ContentItem::OutputText {
                        text: "I will check.".to_string(),
                    }],
                    phase: None,
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCall {
                    id: None,
                    name: "weather".to_string(),
                    namespace: None,
                    arguments: "{\"city\":\"Helsinki\"}".to_string(),
                    call_id: "call-1".to_string(),
                    internal_chat_message_metadata_passthrough: None,
                },
                ResponseItem::FunctionCallOutput {
                    id: None,
                    call_id: "call-1".to_string(),
                    output: FunctionCallOutputPayload::from_text("12 C".to_string()),
                    internal_chat_message_metadata_passthrough: None,
                },
            ],
            tools: Some(vec![json!({
                "type": "function",
                "name": "weather",
                "description": "Read weather",
                "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
            })]),
            tool_choice: "auto".to_string(),
            parallel_tool_calls: false,
            reasoning: None,
            store: false,
            stream: true,
            stream_options: None,
            include: Vec::new(),
            service_tier: None,
            prompt_cache_key: None,
            text: None,
            client_metadata: None,
        }
    }

    #[test]
    fn anthropic_request_fixture_translates_messages_and_tools() {
        let body = anthropic_request(&request()).expect("Anthropic request");
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["system"][0]["text"], "Be exact.");
        assert_eq!(body["messages"][1]["content"][0]["text"], "I will check.");
        assert_eq!(body["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn gemini_request_fixture_translates_messages_and_tools() {
        let body = gemini_request(&request()).expect("Gemini request");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Be exact.");
        assert_eq!(body["contents"][1]["parts"][0]["text"], "I will check.");
        assert_eq!(
            body["contents"][1]["parts"][1]["functionCall"]["name"],
            "weather"
        );
        assert_eq!(
            body["contents"][2]["parts"][0]["functionResponse"]["name"],
            "weather"
        );
        assert_eq!(
            body["tools"][0]["functionDeclarations"][0]["parameters"]["type"],
            "object"
        );
    }

    #[tokio::test]
    async fn anthropic_mock_server_proves_endpoint_headers_shape_and_events() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "anthropic-test"))
            .and(header("anthropic-version", "2023-06-01"))
            .and(body_partial_json(json!({"model": "test-model", "stream": true})))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-1\",\"usage\":{\"input_tokens\":4}}}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-42\",\"name\":\"weather\",\"input\":{}}}\n\n",
                        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\\\"Helsinki\\\"}\"}}\n\n",
                        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":2}}\n\n",
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    )),
            )
            .mount(&server)
            .await;

        let provider = Provider {
            name: "Anthropic".to_string(),
            base_url: format!("{}/v1", server.uri()),
            query_params: None,
            headers: HeaderMap::from_iter([(
                http::HeaderName::from_static("anthropic-version"),
                http::HeaderValue::from_static("2023-06-01"),
            )]),
            retry: codex_api::RetryConfig {
                max_attempts: 1,
                base_delay: std::time::Duration::from_millis(1),
                retry_429: false,
                retry_5xx: false,
                retry_transport: false,
            },
            stream_idle_timeout: std::time::Duration::from_secs(5),
        };
        let auth: SharedAuthProvider = Arc::new(TestAuth {
            header: "x-api-key",
            value: "anthropic-test",
        });
        let mut stream = stream_native_request(
            provider,
            auth.as_ref(),
            &HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
            request(),
            WireApi::AnthropicMessages,
        )
        .await
        .expect("stream");
        let mut saw_text = false;
        let mut saw_tool = false;
        let mut completed = None;
        while let Some(event) = stream.next().await {
            match event.expect("event") {
                ResponseEvent::OutputTextDelta(delta) => saw_text |= delta == "hello",
                ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
                    name,
                    arguments,
                    ..
                }) => {
                    saw_tool |= name == "weather" && arguments.contains("Helsinki");
                }
                ResponseEvent::Completed {
                    token_usage,
                    end_turn,
                    ..
                } => {
                    completed = Some((token_usage, end_turn));
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_text);
        assert!(saw_tool);
        let (usage, end_turn) = completed.expect("completed");
        assert_eq!(usage.expect("usage").total_tokens, 6);
        assert_eq!(end_turn, Some(false));
    }

    #[tokio::test]
    async fn gemini_mock_server_proves_endpoint_headers_shape_and_events() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/test-model:streamGenerateContent"))
            .and(query_param("alt", "sse"))
            .and(header("x-goog-api-key", "gemini-test"))
            .and(body_partial_json(json!({"contents": [{"role": "user"}]})))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(concat!(
                        "data: {\"responseId\":\"gem-1\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"hi\"},{\"functionCall\":{\"id\":\"gem-call-1\",\"name\":\"weather\",\"args\":{\"city\":\"Helsinki\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1,\"totalTokenCount\":4}}\n\n",
                        "data: {\"responseId\":\"gem-1\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1,\"totalTokenCount\":4}}\n\n"
                    )),
            )
            .mount(&server)
            .await;

        let provider = Provider {
            name: "Gemini".to_string(),
            base_url: format!("{}/v1beta", server.uri()),
            query_params: None,
            headers: HeaderMap::new(),
            retry: codex_api::RetryConfig {
                max_attempts: 1,
                base_delay: std::time::Duration::from_millis(1),
                retry_429: false,
                retry_5xx: false,
                retry_transport: false,
            },
            stream_idle_timeout: std::time::Duration::from_secs(5),
        };
        let auth: SharedAuthProvider = Arc::new(TestAuth {
            header: "x-goog-api-key",
            value: "gemini-test",
        });
        let mut stream = stream_native_request(
            provider,
            auth.as_ref(),
            &HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault),
            request(),
            WireApi::GeminiGenerateContent,
        )
        .await
        .expect("stream");
        let mut saw_text = false;
        let mut saw_tool = false;
        let mut completed = None;
        while let Some(event) = stream.next().await {
            match event.expect("event") {
                ResponseEvent::OutputTextDelta(delta) => saw_text |= delta == "hi",
                ResponseEvent::OutputItemDone(ResponseItem::FunctionCall {
                    name,
                    arguments,
                    ..
                }) => {
                    saw_tool |= name == "weather" && arguments.contains("Helsinki");
                }
                ResponseEvent::Completed {
                    token_usage,
                    end_turn,
                    ..
                } => {
                    completed = Some((token_usage, end_turn));
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_text);
        assert!(saw_tool);
        let (usage, end_turn) = completed.expect("completed");
        assert_eq!(usage.expect("usage").total_tokens, 4);
        assert_eq!(end_turn, Some(false));
    }

    #[test]
    fn vendor_error_payloads_preserve_the_vendor_message() {
        assert_eq!(
            vendor_error_message(r#"{"error":{"message":"bad key"}}"#),
            "bad key"
        );
        assert_eq!(vendor_error_message("plain error"), "plain error");
    }

    #[tokio::test]
    async fn dropping_the_response_stream_cancels_native_parsing() {
        let mut events =
            futures::stream::pending::<Result<Event, EventStreamError<reqwest::Error>>>();
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            stream_anthropic_events(&mut events, &tx, Duration::from_secs(30)),
        )
        .await
        .expect("closed receiver should cancel promptly");
        assert!(result.is_ok());
    }

    #[test]
    fn finish_reason_mappings_are_explicit() {
        assert_eq!(anthropic_end_turn(Some("tool_use")), Some(false));
        assert_eq!(anthropic_end_turn(Some("end_turn")), Some(true));
        assert_eq!(gemini_end_turn(Some("MAX_TOKENS")), Some(false));
        assert_eq!(gemini_end_turn(Some("STOP")), Some(true));
        assert_eq!(gemini_end_turn(Some("FINISH_REASON_UNSPECIFIED")), None);
        assert_eq!(gemini_end_turn(Some("future_reason")), None);
    }
}

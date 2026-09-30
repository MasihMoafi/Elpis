//! Vendor model lists, served to core as a Codex model catalog.
//!
//! Ported from v0.3.0's `model-provider/src/native_models_endpoint.rs`: every field comes from
//! the vendor's own listing, and a listing that cannot be read yields no rows rather than an
//! invented one. The rows are built for 0.159's `ModelInfo` and checked against it before they
//! leave the gateway, because core drops a whole catalog that fails to parse.

use codex_model_provider_info::GatewayWire;
use codex_models_manager::model_info::BASE_INSTRUCTIONS;
use codex_protocol::openai_models::ModelsResponse;
use serde_json::Value;
use serde_json::json;

/// Anthropic's list reports no context window. This is Anthropic's published window for its
/// current models; the beta 1M window needs a header Elpis does not send.
const ANTHROPIC_DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

/// The keys an OpenAI-compatible `/models` row may use for its context window: OpenRouter and
/// Together use `context_length`, Groq `context_window`, Mistral `max_context_length`.
const CONTEXT_WINDOW_KEYS: &[&str] = &["context_length", "context_window", "max_context_length"];

/// Effort levels offered for a model whose listing says it accepts `reasoning`.
const REASONING_LEVELS: [(&str, &str); 3] = [
    ("low", "Answers soonest"),
    ("medium", "Balanced"),
    ("high", "Thinks longest before answering"),
];

/// The vendor path that lists models, relative to the vendor base URL.
pub(crate) fn models_path(wire: GatewayWire) -> &'static str {
    match wire {
        GatewayWire::Chat => "models",
        GatewayWire::AnthropicMessages => "models?limit=1000",
        GatewayWire::GeminiGenerateContent => "models?pageSize=1000",
    }
}

/// Parses a vendor listing into catalog rows.
pub(crate) fn models_from_listing(wire: GatewayWire, body: &Value) -> Vec<Value> {
    match wire {
        GatewayWire::Chat => openai_compatible_models(body),
        GatewayWire::AnthropicMessages => anthropic_models(body),
        GatewayWire::GeminiGenerateContent => gemini_models(body),
    }
}

/// Wraps rows as a `/models` response and proves core can read it.
pub(crate) fn catalog_response(models: Vec<Value>) -> Result<Value, String> {
    let catalog = json!({ "models": models });
    serde_json::from_value::<ModelsResponse>(catalog.clone())
        .map_err(|error| format!("the gateway built a model catalog core cannot read: {error}"))?;
    Ok(catalog)
}

fn model_row(
    slug: &str,
    display_name: &str,
    context_window: Option<u64>,
    priority: usize,
    reasons: bool,
) -> Value {
    let description = match context_window {
        Some(window) => format!("≈{}k context", window / 1_000),
        None => "context window not reported".to_string(),
    };
    let reasoning_levels: Vec<Value> = if reasons {
        REASONING_LEVELS
            .iter()
            .map(|(effort, description)| json!({"effort": effort, "description": description}))
            .collect()
    } else {
        Vec::new()
    };
    let mut row = json!({
        "slug": slug,
        "display_name": display_name,
        "description": description,
        "supported_reasoning_levels": reasoning_levels,
        // Plain function tools: code mode is for OpenAI's own models.
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": priority,
        "availability_nux": null,
        "upgrade": null,
        // The catalog entry is what the session runs on once a model is picked; without a
        // template every turn on a discovered model would lose the agent's instructions.
        "model_messages": {"instructions_template": BASE_INSTRUCTIONS},
        "supports_reasoning_summary_parameter": false,
        "support_verbosity": false,
        "default_verbosity": null,
        // The gateway turns the freeform patch tool into a function taking the patch text.
        "apply_patch_tool_type": "freeform",
        "truncation_policy": {"mode": "bytes", "limit": 10_000},
        "experimental_supported_tools": [],
        "input_modalities": ["text"],
    });
    if reasons {
        row["default_reasoning_level"] = json!("medium");
    }
    if let Some(window) = context_window {
        row["context_window"] = json!(window);
        row["max_context_window"] = json!(window);
    }
    row
}

/// `GET /v1/models`: `{"data":[{"id":…,"display_name":…}]}`.
fn anthropic_models(body: &Value) -> Vec<Value> {
    let Some(entries) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let slug = entry.get("id")?.as_str()?;
            let display_name = entry
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(slug);
            // The listing does not say which models think, and the Messages wire carries no
            // thinking budget yet, so no effort levels are offered.
            Some(model_row(
                slug,
                display_name,
                Some(ANTHROPIC_DEFAULT_CONTEXT_WINDOW),
                index,
                /*reasons*/ false,
            ))
        })
        .collect()
}

/// `GET /v1beta/models`: `{"models":[{"name":"models/…","inputTokenLimit":…}]}`. Only models
/// that can answer a turn are listed.
fn gemini_models(body: &Value) -> Vec<Value> {
    let Some(entries) = body.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|entry| {
            entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|method| method == "generateContent")
                })
        })
        .enumerate()
        .filter_map(|(index, entry)| {
            let name = entry.get("name")?.as_str()?;
            let slug = name.strip_prefix("models/").unwrap_or(name);
            let display_name = entry
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or(slug);
            let context_window = entry
                .get("inputTokenLimit")
                .and_then(Value::as_u64)
                .filter(|window| *window > 0);
            Some(model_row(
                slug,
                display_name,
                context_window,
                index,
                /*reasons*/ false,
            ))
        })
        .collect()
}

/// `GET {base_url}/models` in the OpenAI list shape, or a bare array (Together). A row whose
/// `supported_parameters` omit `tools` is left out: the agent cannot work without tools.
fn openai_compatible_models(body: &Value) -> Vec<Value> {
    let entries = match body.as_array() {
        Some(entries) => entries,
        None => match body.get("data").and_then(Value::as_array) {
            Some(entries) => entries,
            // An error body (`{"error": …}`) lists nothing.
            None => return Vec::new(),
        },
    };
    let parameters = |entry: &Value| {
        entry
            .get("supported_parameters")
            .and_then(Value::as_array)
            .map(|parameters| {
                parameters
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
    };
    entries
        .iter()
        .filter(|entry| {
            parameters(*entry).is_none_or(|parameters| parameters.iter().any(|p| p == "tools"))
        })
        .enumerate()
        .filter_map(|(index, entry)| {
            let slug = entry.get("id")?.as_str()?;
            let display_name = entry
                .get("display_name")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(slug);
            let context_window = CONTEXT_WINDOW_KEYS
                .iter()
                .find_map(|key| entry.get(*key).and_then(Value::as_u64))
                .filter(|window| *window > 0);
            let reasons = parameters(entry)
                .is_some_and(|parameters| parameters.iter().any(|p| p == "reasoning"));
            Some(model_row(slug, display_name, context_window, index, reasons))
        })
        .collect()
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

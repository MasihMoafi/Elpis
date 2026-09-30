//! Reads the Responses request core sends and normalizes it for the vendor translators.
//!
//! Adapted from v0.3.0's `core/src/chat_completions.rs` (which read typed `ResponseItem`s) and
//! the tool-name adapter of the September port (`chat_completions/native_tools.rs`). The gateway
//! sees the request as JSON, so it reads the Responses wire shape directly.

use std::collections::HashMap;

use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::GatewayError;

/// Opaque Gemini reasoning state rides in a reasoning item's `encrypted_content`, never in tool
/// arguments. Same envelope as v0.3.0, so v0.3.0 histories keep their signatures.
pub(crate) const GEMINI_SIGNATURE_PREFIX: &str = "elpis:gemini-tool-signature:v1:";
/// The strictest common limit across Anthropic, Gemini and OpenAI Chat tool names.
const MAX_TOOL_NAME_LEN: usize = 64;
const IMAGE_OMITTED: &str = "[image omitted: this provider route does not carry images]";
const AUDIO_OMITTED: &str = "[audio omitted: this provider route does not carry audio]";

/// One step of the conversation, in the order the vendor must see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Turn {
    /// A developer or system message. Anthropic and Gemini hoist these into the system prompt.
    System(String),
    User(String),
    Assistant(String),
    /// A tool call the model made; `name` is the vendor-safe alias.
    ToolCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    ToolResult {
        call_id: String,
        output: String,
    },
}

/// A tool declared to the vendor as a plain function.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FunctionTool {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) parameters: Value,
}

/// A requested JSON output schema (`text.format` in the Responses request).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OutputFormat {
    pub(crate) name: String,
    pub(crate) strict: bool,
    pub(crate) schema: Value,
}

#[derive(Debug)]
pub(crate) struct Conversation {
    pub(crate) model: String,
    pub(crate) instructions: String,
    pub(crate) turns: Vec<Turn>,
    pub(crate) tools: Vec<FunctionTool>,
    pub(crate) tool_map: ToolMap,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) output_format: Option<OutputFormat>,
    /// Gemini thought signatures by call ID, recovered from earlier reasoning items.
    pub(crate) gemini_signatures: HashMap<String, String>,
}

impl Conversation {
    pub(crate) fn from_request(request: &Value) -> Result<Self, GatewayError> {
        let model = request
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
            .ok_or_else(|| GatewayError::bad_request("the request names no model"))?
            .to_string();
        let instructions = request
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut conversation = Self {
            model,
            instructions,
            turns: Vec::new(),
            tools: Vec::new(),
            tool_map: ToolMap::default(),
            reasoning_effort: request
                .pointer("/reasoning/effort")
                .and_then(Value::as_str)
                .map(str::to_string),
            output_format: request
                .pointer("/text/format")
                .filter(|format| format.get("type").and_then(Value::as_str) == Some("json_schema"))
                .map(|format| OutputFormat {
                    name: format
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("output")
                        .to_string(),
                    strict: format
                        .get("strict")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    schema: format.get("schema").cloned().unwrap_or_else(|| json!({})),
                }),
            gemini_signatures: HashMap::new(),
        };
        let tools = request
            .get("tools")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        conversation.declare_tools(tools, /*namespace*/ None)?;
        let input = request
            .get("input")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for item in input {
            conversation.read_item(item)?;
        }
        Ok(conversation)
    }

    /// Declares function, custom (freeform) and namespaced tools as plain functions. Tools only
    /// OpenAI runs (web search, image generation, tool search, local shell) are dropped: the
    /// vendor cannot run them, and refusing the whole request would end the session.
    fn declare_tools(&mut self, tools: &[Value], namespace: Option<&str>) -> Result<(), GatewayError> {
        for tool in tools {
            let kind = tool.get("type").and_then(Value::as_str).unwrap_or_default();
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty());
            let declared = match (kind, name) {
                ("function", Some(name)) => FunctionTool {
                    name: self
                        .tool_map
                        .register(ToolIdentity::new(name, namespace, /*custom*/ false))?,
                    description: description(tool),
                    parameters: object_schema(tool.get("parameters")),
                },
                ("custom", Some(name)) => FunctionTool {
                    name: self
                        .tool_map
                        .register(ToolIdentity::new(name, namespace, /*custom*/ true))?,
                    description: custom_tool_description(tool),
                    parameters: custom_tool_parameters(),
                },
                ("namespace", Some(name)) if namespace.is_none() => {
                    let children = tool
                        .get("tools")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    self.declare_tools(children, Some(name))?;
                    continue;
                }
                _ => {
                    tracing::debug!(kind, "the Elpis gateway drops a tool the vendor cannot run");
                    continue;
                }
            };
            if !self.tools.iter().any(|tool| tool.name == declared.name) {
                self.tools.push(declared);
            }
        }
        Ok(())
    }

    fn read_item(&mut self, item: &Value) -> Result<(), GatewayError> {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        match kind {
            "message" => {
                let text = content_text(item.get("content"));
                if text.is_empty() {
                    return Ok(());
                }
                let turn = match item.get("role").and_then(Value::as_str).unwrap_or("user") {
                    "system" | "developer" => Turn::System(text),
                    "assistant" => Turn::Assistant(text),
                    _ => Turn::User(text),
                };
                self.turns.push(turn);
            }
            "function_call" => {
                let name = required_text(item, "name")?;
                let namespace = item.get("namespace").and_then(Value::as_str);
                let alias = self
                    .tool_map
                    .register(ToolIdentity::new(name, namespace, /*custom*/ false))?;
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .filter(|arguments| !arguments.trim().is_empty())
                    .unwrap_or("{}")
                    .to_string();
                self.turns.push(Turn::ToolCall {
                    call_id: required_text(item, "call_id")?.to_string(),
                    name: alias,
                    arguments,
                });
            }
            "custom_tool_call" => {
                let name = required_text(item, "name")?;
                let namespace = item.get("namespace").and_then(Value::as_str);
                let alias = self
                    .tool_map
                    .register(ToolIdentity::new(name, namespace, /*custom*/ true))?;
                let input = item
                    .get("input")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.turns.push(Turn::ToolCall {
                    call_id: required_text(item, "call_id")?.to_string(),
                    name: alias,
                    arguments: json!({ "input": input }).to_string(),
                });
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .filter(|call_id| !call_id.is_empty())
                    .ok_or_else(|| GatewayError::bad_request("a tool result has no call_id"))?;
                self.turns.push(Turn::ToolResult {
                    call_id: call_id.to_string(),
                    output: content_text(item.get("output")),
                });
            }
            "reasoning" => {
                if let Some(payload) = item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .and_then(|content| content.strip_prefix(GEMINI_SIGNATURE_PREFIX))
                    && let Ok(record) = serde_json::from_str::<Value>(payload)
                    && let (Some(call_id), Some(signature)) = (
                        record.get("call_id").and_then(Value::as_str),
                        record.get("signature").and_then(Value::as_str),
                    )
                {
                    self.gemini_signatures
                        .insert(call_id.to_string(), signature.to_string());
                }
            }
            "additional_tools" => {
                let tools = item
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                self.declare_tools(tools, /*namespace*/ None)?;
            }
            "agent_message" => {
                let author = item.get("author").and_then(Value::as_str).unwrap_or("agent");
                let recipient = item
                    .get("recipient")
                    .and_then(Value::as_str)
                    .unwrap_or("agent");
                let text = content_text(item.get("content"));
                self.turns.push(Turn::User(format!(
                    "Agent message from {author} to {recipient}:\n{text}"
                )));
            }
            // Items only the OpenAI Responses API produces or replays: web search and image
            // generation calls, tool search, remote compaction, local shell calls and
            // OpenAI's encrypted reasoning. The vendor cannot replay them, and the model's
            // later text already reflects what they did.
            _ => {}
        }
        Ok(())
    }
}

fn required_text<'a>(item: &'a Value, field: &str) -> Result<&'a str, GatewayError> {
    item.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::bad_request(format!("a history item has no `{field}`")))
}

/// The text of a message or tool output. Images and audio become a visible placeholder: the
/// model learns something was there, and one attachment does not make every later request fail.
pub(crate) fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("input_text" | "output_text" | "text") => part
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                Some("input_image") => Some(IMAGE_OMITTED.to_string()),
                Some("input_audio") => Some(AUDIO_OMITTED.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn description(tool: &Value) -> String {
    tool.get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn object_schema(parameters: Option<&Value>) -> Value {
    match parameters {
        Some(schema) if schema.is_object() => schema.clone(),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

/// A freeform tool becomes a function taking its raw input as one string. The grammar the
/// Responses API would have enforced goes into the description, so the model still sees it.
fn custom_tool_description(tool: &Value) -> String {
    let mut text = description(tool);
    text.push_str("\n\nPass the tool's complete raw input as the `input` string.");
    if let Some(format) = tool.get("format")
        && let Some(definition) = format.get("definition").and_then(Value::as_str)
    {
        let syntax = format
            .get("syntax")
            .and_then(Value::as_str)
            .unwrap_or("text");
        text.push_str(&format!(
            " The input must follow this {syntax} grammar:\n{definition}"
        ));
    }
    text
}

fn custom_tool_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "input": {"type": "string", "description": "The tool's complete raw input text."}
        },
        "required": ["input"],
        "additionalProperties": false,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolIdentity {
    pub(crate) name: String,
    pub(crate) namespace: Option<String>,
    /// A freeform tool, whose calls return to core as `custom_tool_call` items.
    pub(crate) custom: bool,
}

impl ToolIdentity {
    fn new(name: &str, namespace: Option<&str>, custom: bool) -> Self {
        Self {
            name: name.to_string(),
            namespace: namespace.map(str::to_string),
            custom,
        }
    }
}

/// Maps the vendor-safe tool names the model sees back to core's tools.
#[derive(Debug, Default)]
pub(crate) struct ToolMap {
    identities: HashMap<String, ToolIdentity>,
}

impl ToolMap {
    fn register(&mut self, identity: ToolIdentity) -> Result<String, GatewayError> {
        let alias = vendor_tool_name(&identity.name, identity.namespace.as_deref());
        if self
            .identities
            .get(&alias)
            .is_some_and(|previous| previous != &identity)
        {
            return Err(GatewayError::bad_request(format!(
                "two tools map to the vendor tool name `{alias}`"
            )));
        }
        self.identities.insert(alias.clone(), identity);
        Ok(alias)
    }

    pub(crate) fn restore(&self, alias: &str) -> Option<&ToolIdentity> {
        self.identities.get(alias)
    }
}

/// A tool name every vendor accepts: `[A-Za-z0-9_-]`, starting with a letter or underscore, at
/// most 64 characters. Plain valid names are kept, so the model sees `exec_command`. A name that
/// has to change keeps a readable prefix and gains a stable hash, so aliases never collide.
pub(crate) fn vendor_tool_name(name: &str, namespace: Option<&str>) -> String {
    let joined = match namespace {
        Some(namespace) => format!("{namespace}__{name}"),
        None => name.to_string(),
    };
    if is_vendor_safe(&joined) {
        return joined;
    }
    let mut safe: String = joined
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if !safe.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_') {
        safe.insert_str(0, "t_");
    }
    let digest = format!("{:x}", Sha256::digest(joined.as_bytes()));
    safe.truncate(MAX_TOOL_NAME_LEN - 13);
    format!("{safe}_{}", &digest[..12])
}

fn is_vendor_safe(name: &str) -> bool {
    name.len() <= MAX_TOOL_NAME_LEN
        && name.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
}

#[cfg(test)]
#[path = "conversation_tests.rs"]
mod tests;

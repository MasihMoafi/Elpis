import { wireObject } from "./bridge-wire.mts";
import type { AcpEvent,ToolState } from "./bridge-types.mts";

const string = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown) => value === undefined || string(value);
const nullableString = (value: unknown) => value === undefined || value === null || string(value);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optionalNumber = (value: unknown) => value === undefined || finite(value);

function configOptions(value: unknown) {
  return value == null || (Array.isArray(value) && value.every((option: unknown) => wireObject(option) && string(option.id)));
}

/** Check the replies whose fields the bridge uses; unrecognised methods stay opaque. */
export function validAcpReply(method: string, value: unknown): boolean {
  if (!["session/new", "session/fork", "session/set_config_option", "session/prompt", "_session/steering", "_elpis/contextFiles"].includes(method)) return true;
  if (!wireObject(value)) return false;
  switch (method) {
    case "session/new": return string(value.sessionId) && configOptions(value.configOptions)
      && (value.modes == null || (wireObject(value.modes) && (value.modes.availableModes === undefined
        || (Array.isArray(value.modes.availableModes) && value.modes.availableModes.every(mode => wireObject(mode) && string(mode.id))))));
    case "session/fork": return string(value.sessionId);
    case "session/set_config_option": return configOptions(value.configOptions);
    case "session/prompt": return string(value.stopReason)
      && (value._meta == null || wireObject(value._meta))
      && (value.usage == null || (wireObject(value.usage) && [value.usage.inputTokens, value.usage.outputTokens,
        value.usage.cachedReadTokens, value.usage.cachedWriteTokens, value.usage.totalTokens].every(optionalNumber)));
    case "_session/steering": return optionalString(value.outcome)
      && (value._meta == null || (wireObject(value._meta) && optionalString(value._meta.delivery)));
    case "_elpis/contextFiles": return Array.isArray(value.files) && value.files.every(file => wireObject(file)
      && string(file.path) && optionalNumber(file.estimatedTokens));
    default: return true;
  }
}

function toolRaw(value: unknown): value is ToolState["raw"] {
  return wireObject(value) && [value.file_path, value.notebook_path, value.content, value.command, value.pattern, value.path, value.description].every(optionalString);
}
function toolResponse(value: unknown): value is NonNullable<ToolState["response"]> {
  return wireObject(value) && [value.filePath, value.type, value.content, value.stdout, value.stderr].every(optionalString)
    && (value.structuredPatch === undefined || (Array.isArray(value.structuredPatch) && value.structuredPatch.every(h => wireObject(h)
      && [h.oldStart, h.oldLines, h.newStart, h.newLines].every(finite) && Array.isArray(h.lines) && h.lines.every(string))));
}

/** Validate the ACP fields the bridge consumes; retain activity for other event kinds. */
export function readAcpEvent(value: unknown): AcpEvent | null {
  if (!wireObject(value) || !string(value.sessionUpdate)) return null;
  switch (value.sessionUpdate) {
    case "agent_message_chunk": case "agent_thought_chunk": {
      if (!wireObject(value.content) || !string(value.content.type)) return null;
      if (value.content.type !== "text") return { sessionUpdate: "_unhandled", original: value.sessionUpdate };
      if (!string(value.content.text) || !nullableString(value.messageId)) return null;
      return { sessionUpdate: value.sessionUpdate, content: { type: "text", text: value.content.text }, ...(string(value.messageId) ? { messageId: value.messageId } : {}) };
    }
    case "session_message": {
      if (value.content != null && !Array.isArray(value.content)) return null;
      const content: { type: "text"; text: string }[] = [];
      for (const block of value.content ?? []) {
        if (!wireObject(block) || !string(block.type)) return null;
        if (block.type === "text") { if (!string(block.text)) return null; content.push({ type: "text", text: block.text }); }
      }
      return { sessionUpdate: "session_message", ...(value.content == null ? {} : { content }) };
    }
    case "subagent_update": {
      if (!string(value.sessionId) || !nullableString(value.title) || !nullableString(value.description)
        || (value.state != null && (!wireObject(value.state) || !string(value.state.state) || !nullableString(value.state.stopReason)))
        || (value.capabilities != null && !wireObject(value.capabilities))) return null;
      return { sessionUpdate: "subagent_update", sessionId: value.sessionId,
        ...(string(value.title) ? { title: value.title } : {}), ...(string(value.description) ? { description: value.description } : {}),
        ...(wireObject(value.state) && string(value.state.state) ? { state: { state: value.state.state, ...(string(value.state.stopReason) ? { stopReason: value.state.stopReason } : {}) } } : {}),
        ...(wireObject(value.capabilities) ? { capabilities: { cancel: value.capabilities.cancel } } : {}) };
    }
    case "usage_update": {
      if ((value.used !== undefined && !finite(value.used)) || (value.size !== undefined && !finite(value.size))
        || (value._meta != null && !wireObject(value._meta))) return null;
      return { sessionUpdate: "usage_update", ...(typeof value.used === "number" ? { used: value.used } : {}),
        ...(typeof value.size === "number" ? { size: value.size } : {}), ...(value.cost === undefined ? {} : { cost: value.cost }),
        ...(wireObject(value._meta) ? { _meta: value._meta } : {}) };
    }
    case "plan": {
      if (!Array.isArray(value.entries)) return null;
      const entries: { content: string; status: string }[] = [];
      for (const entry of value.entries) { if (!wireObject(entry) || !string(entry.content) || !string(entry.status)) return null; entries.push({ content: entry.content, status: entry.status }); }
      return { sessionUpdate: "plan", entries };
    }
    case "tool_call": case "tool_call_update": {
      if (!string(value.toolCallId) || !nullableString(value.kind) || !nullableString(value.title) || !nullableString(value.status)
        || (value._meta != null && !wireObject(value._meta)) || (value.content != null && !Array.isArray(value.content))) return null;
      const cc = wireObject(value._meta) ? value._meta.claudeCode : undefined;
      const content: NonNullable<Extract<AcpEvent, { sessionUpdate: "tool_call" | "tool_call_update" }>["content"]> = [];
      for (const block of value.content ?? []) {
        if (!wireObject(block) || !string(block.type)) return null;
        if (block.type === "diff") {
          if (!string(block.path) || !nullableString(block.oldText) || !nullableString(block.newText)) return null;
          content.push({ type: "diff", path: block.path, ...(string(block.oldText) || block.oldText === null ? { oldText: block.oldText } : {}), ...(string(block.newText) || block.newText === null ? { newText: block.newText } : {}) });
        } else if (block.type === "content" && wireObject(block.content) && block.content.type === "text") {
          if (!string(block.content.text)) return null;
          content.push({ type: "content", content: { type: "text", text: block.content.text } });
        }
      }
      return { sessionUpdate: value.sessionUpdate, toolCallId: value.toolCallId,
        ...(string(value.kind) ? { kind: value.kind } : {}), ...(string(value.title) ? { title: value.title } : {}),
        ...(string(value.status) ? { status: value.status } : {}), ...(toolRaw(value.rawInput) ? { rawInput: value.rawInput } : {}),
        ...(wireObject(cc) && string(cc.toolName) ? { toolName: cc.toolName } : {}), ...(wireObject(cc) && toolResponse(cc.toolResponse) ? { toolResponse: cc.toolResponse } : {}),
        ...(value.content == null ? {} : { content }) };
    }
    default: return { sessionUpdate: "_unhandled", original: value.sessionUpdate };
  }
}

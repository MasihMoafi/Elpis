import { string, boolean, numericFields, number } from "./projection-values.mts";
import type { RecordValue, RolloutItem, Usage, TokenUsage, Shares } from "./feature-types.mts";
export const usageKeys = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];
export const attributionKeys = [
  "systemInstructions",
  "developerMessages",
  "userMessages",
  "agentMessages",
  "reasoning",
  "toolCalls",
  "toolResults",
  "toolDefinitions",
  "outputSchema",
  "unrecognizedItems",
  "estimatedTotal",
];
export function tokenUsageSnapshot(raw: unknown) {
  const value = raw as
    | (RecordValue & {
        total?: unknown;
        last?: unknown;
        modelContextWindow?: unknown;
        contextAttribution?: unknown;
      })
    | null;
  if (!value || typeof value !== "object") return null;
  return {
    total: numericFields(value.total, usageKeys),
    last: numericFields(value.last, usageKeys),
    modelContextWindow: typeof value.modelContextWindow === "number" ? value.modelContextWindow : null,
    contextAttribution: numericFields(value.contextAttribution, attributionKeys),
  };
}
// The Context Ledger's categories, in the TUI's order and words (codex-rs/tui/src/chatwidget/context_usage.rs).
export const LEDGER_CATEGORIES: [string, string, string?][] = [
  ["userMessages", "User messages"],
  ["agentMessages", "Agent messages"],
  ["reasoning", "Reasoning + compaction"],
  ["toolCalls", "Tool calls"],
  ["toolResults", "Tool results"],
  ["systemInstructions", "System instructions"],
  ["developerMessages", "Developer messages"],
  ["toolDefinitions", "Tool definitions + schema", "outputSchema"],
  ["unrecognizedItems", "Unrecognized request items"],
];
/** The categories of one attribution, in the TUI's order and words, scaled to `used` by largest remainder so they sum to
 * it exactly (`reconcile_context_categories`); empty when nothing is attributed. */
export function reconciledCategories(attribution: Record<string, number> | null | undefined, used: number) {
  const estimated = LEDGER_CATEGORIES.map(([id, label, extra]) => ({
    id,
    label,
    tokens: (attribution?.[id] ?? 0) + (extra ? (attribution?.[extra] ?? 0) : 0),
  })).filter(row => row.tokens > 0);
  const total = estimated.reduce((sum, row) => sum + row.tokens, 0);
  if (!total) return [];
  const scaled = estimated.map((row, index) => ({
    ...row,
    tokens: Math.floor((row.tokens * used) / total),
    remainder: (row.tokens * used) % total,
    index,
  }));
  let remaining = used - scaled.reduce((sum, row) => sum + row.tokens, 0);
  for (const row of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index))
    if (remaining-- > 0) row.tokens++;
  return scaled.filter(row => row.tokens > 0).map(({ id, label, tokens }) => ({ id, label, tokens }));
}
/** The prompt cache's share of one usage record: the engine's `inputTokens` include cached and cache-written input, so
 * the parts are disjoint here and `hitPercent` is cached input over the whole prompt. Null when no prompt was measured. */
export function cacheShare(usage: Usage | null | undefined) {
  const prompt = number(usage?.inputTokens);
  if (prompt === null || prompt <= 0) return null;
  const cacheRead = Math.max(0, number(usage?.cachedInputTokens) ?? 0),
    cacheWrite = Math.max(0, number(usage?.cacheWriteInputTokens) ?? 0);
  return {
    prompt,
    cacheRead,
    cacheWrite,
    uncached: Math.max(0, prompt - cacheRead - cacheWrite),
    hitPercent: Math.round((cacheRead * 100) / prompt),
  };
}
/** The Ledger's Prompt cache row (4 Nov, Masih: "add that cache button which shows that important info"): the latest
 * request's share and the whole chat's. Null before the first measured request. */
export function cacheUse(tokenUsage: TokenUsage | null | undefined) {
  const last = cacheShare(tokenUsage?.last),
    total = cacheShare(tokenUsage?.total);
  return last || total ? { last, total } : null;
}
// A saved transcript is an estimate of the next request, never exactly it; this much over the measured total still counts.
export const TRANSCRIPT_SLACK = 1.15;
/** What the TUI's Context Ledger shows for a chat. `used` is measured: the latest request's total tokens, as the
 * ledger's `tokens_in_context_window`. `window` is the reported context window, or null when unknown. `categories`
 * are the core's estimated shares of the latest built request, scaled to `used` (`basis: 'engine'`); an empty list means
 * attribution is unavailable. The TUI has the shares only once its own process has seen a request, so a chat the engine
 * has not run since this app connected would have none: `transcript` (`rolloutShares`) then stands in for them
 * (`basis: 'transcript'`), with the rest of the measured total, which no transcript holds, as the tool definitions. */
export function contextLedger(tokenUsage: TokenUsage | null | undefined, transcript: Shares | null = null) {
  const used = number(tokenUsage?.last?.totalTokens),
    window = number(tokenUsage?.modelContextWindow);
  const ledger = {
    used: used !== null && used >= 0 ? used : null,
    window: window !== null && window > 0 ? window : null,
    categories: [],
  };
  if (!ledger.used) return ledger;
  const engine = reconciledCategories(tokenUsage?.contextAttribution, ledger.used);
  if (engine.length) return { ...ledger, categories: engine, basis: "engine" };
  const known = transcript ? Object.values(transcript).reduce((sum, tokens) => sum + tokens, 0) : 0;
  if (!known || known > ledger.used * TRANSCRIPT_SLACK) return ledger;
  const categories = reconciledCategories(
    { ...transcript, toolDefinitions: transcript!.toolDefinitions + Math.max(0, ledger.used - known) },
    ledger.used,
  );
  return categories.length ? { ...ledger, categories, basis: "transcript" } : ledger;
}
// ---- The shares of a chat the engine has not run yet, estimated from its saved transcript (rollout).
export const SHARE_KEYS = [
  "systemInstructions",
  "developerMessages",
  "userMessages",
  "agentMessages",
  "reasoning",
  "toolCalls",
  "toolResults",
  "toolDefinitions",
  "outputSchema",
  "unrecognizedItems",
];
export const IMAGE_BYTES = 7373;
export const textBytes = (value: unknown) => (typeof value === "string" ? Buffer.byteLength(value) : 0);
export const jsonBytes = (value: unknown) =>
  value === undefined || value === null ? 0 : Buffer.byteLength(JSON.stringify(value) ?? "");
export const partBytes = (part: RecordValue | null | undefined) =>
  part?.type === "input_image"
    ? IMAGE_BYTES
    : part?.type === "encrypted_content"
      ? Math.ceil((textBytes(part.encrypted_content) * 9) / 16)
      : textBytes(part?.text);
export const partsBytes = (parts: unknown) =>
  Array.isArray(parts) ? parts.reduce((sum, part) => sum + partBytes(part), 0) : 0;
/** One saved item as core classifies and sizes it (core elpis_context_attribution.rs `classify`, context_manager
 * `estimate_item_token_count`): its share and its model-visible bytes. Items it does not know weigh nothing. */
export function sizedItem(item: RolloutItem): [string, number] {
  const call = () =>
    textBytes(item.name) + textBytes(item.namespace ?? "functions") + textBytes(item.arguments ?? item.input);
  switch (item.type) {
    case "message":
      return [
        {
          system: "systemInstructions",
          developer: "developerMessages",
          user: "userMessages",
          assistant: "agentMessages",
        }[item.role as "system" | "developer" | "user" | "assistant"] ?? "unrecognizedItems",
        partsBytes(item.content),
      ];
    case "agent_message":
      return ["agentMessages", textBytes(item.author) + textBytes(item.recipient) + partsBytes(item.content)];
    // Encrypted model state: 1,287 characters of overhead, then a token per 14.14 (core `encrypted_reasoning_tokens`), as bytes here.
    case "reasoning":
    case "compaction":
    case "context_compaction":
      return [
        "reasoning",
        typeof item.encrypted_content === "string"
          ? Math.ceil((Math.max(0, item.encrypted_content.length - 1287) * 100) / 1414) * 4
          : 0,
      ];
    case "function_call":
    case "custom_tool_call":
      return ["toolCalls", call()];
    case "local_shell_call":
    case "web_search_call":
      return ["toolCalls", jsonBytes(item.action)];
    case "tool_search_call":
      return ["toolCalls", jsonBytes(item.arguments)];
    case "image_generation_call":
      return ["toolCalls", textBytes(item.revised_prompt) + (item.result ? IMAGE_BYTES : 0)];
    case "function_call_output":
    case "custom_tool_call_output": {
      const body =
        (
          item.output as
            | {
                body?: unknown;
              }
            | null
            | undefined
        )?.body ?? item.output;
      return [
        "toolResults",
        (typeof body === "string" ? textBytes(body) : partsBytes(body)) +
          textBytes(item.call_id) +
          textBytes(item.name) +
          textBytes(item.namespace),
      ];
    }
    case "tool_search_output":
      return ["toolResults", jsonBytes(item.tools)];
    case "additional_tools":
      return ["toolDefinitions", jsonBytes(item.tools)];
    default:
      return ["unrecognizedItems", 0];
  }
}
export function smartPruneSnapshot(raw: unknown) {
  const value = raw as
    | (RecordValue & {
        latestAttempt?: RecordValue | null;
      })
    | null;
  if (!value || typeof value !== "object") return null;
  const result = {
    enabled: boolean(value.enabled),
    ...numericFields(value, [
      "examinedOutputs",
      "admittedOutputs",
      "unchangedOutputs",
      "failedBatches",
      "approxSourceTokens",
      "approxAdmittedTokens",
      "approxSavedTokens",
      "optimizerRequests",
      "optimizerUsageReports",
      "optimizerLatencyMs",
      "mainRequestSequence",
    ]),
    optimizerUsage: numericFields(value.optimizerUsage, usageKeys),
    latestAttempt: null as null | {
      status: string | null;
      failureReason: string | null;
      modelSlug: string | null;
      reasoningEffort: string | null;
      usage: Record<string, unknown> | null;
    },
  };
  if (value.latestAttempt && typeof value.latestAttempt === "object") {
    const attempt = value.latestAttempt;
    result.latestAttempt = {
      status: string(attempt.status),
      failureReason: string(attempt.failureReason),
      modelSlug: string(attempt.modelSlug),
      reasoningEffort: string(attempt.reasoningEffort),
      ...numericFields(attempt, ["candidateOutputs", "admittedOutputs", "approxSavedTokens", "latencyMs"]),
      usage: numericFields(attempt.usage, usageKeys),
    };
  }
  return result;
}

import { usageKeys, SHARE_KEYS, textBytes, sizedItem } from "./token-accounting.mts";
import { string } from "./projection-values.mts";
import type { RecordValue, RolloutItem, Shares } from "./feature-types.mts";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { reverseRolloutLines } from "./rollout-lines.mts";
export const rolloutPath = (file: unknown): file is string =>
  typeof file === "string" && path.isAbsolute(file) && /\.jsonl(\.zst)?$/.test(file);
async function rolloutInput(file: string, limit: number) {
  if ((await fsp.stat(file)).size > limit) return null;
  if (!file.endsWith(".zst")) return fs.createReadStream(file);
  return typeof zlib.createZstdDecompress === "function"
    ? fs.createReadStream(file).pipe(zlib.createZstdDecompress())
    : null;
}
type AgentModel = { model: string; reasoningEffort: string | null };
/** A rollout line's model evidence: undefined when the line carries none, null when it records no model. */
function lineAgentModel(line: string, threadId: string): AgentModel | null | undefined {
  if (!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) return undefined;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  const context =
    row?.type === "turn_context"
      ? row.payload
      : row?.type === "event_msg" &&
          row.payload?.type === "thread_settings_applied" &&
          (!row.payload.thread_id || row.payload.thread_id === threadId)
        ? row.payload.thread_settings
        : null;
  if (!context) return undefined;
  const model = string(context.model)?.trim();
  return model ? { model, reasoningEffort: string(context.effort ?? context.reasoning_effort)?.trim() || null } : null;
}
/** The latest recorded turn is the evidence for a background agent's model and effort. */
export async function rolloutAgentModel(file: unknown, threadId: string, limit = 1 << 28): Promise<AgentModel | null> {
  if (!rolloutPath(file)) return null;
  let latest: AgentModel | null = null;
  try {
    if (!file.endsWith(".zst")) {
      for await (const line of reverseRolloutLines(file, Math.min(limit, 8 * 1024 * 1024))) {
        const found = lineAgentModel(line, threadId);
        if (found) return found;
      }
      return null;
    }
    const input = await rolloutInput(file, limit);
    if (!input) return null;
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const found = lineAgentModel(line, threadId);
      if (found !== undefined) latest = found;
    }
  } catch {
    return null;
  }
  return latest;
}
function lineTurnModel(line: string): { turnId: string; model: string } | null {
  if (!line.includes('"turn_context"')) return null;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  const turnId = string(row?.payload?.turn_id),
    model = string(row?.payload?.model);
  return row?.type === "turn_context" && turnId && model?.trim() ? { turnId, model } : null;
}
/** The model recorded for each saved turn. Old or imported rows without a model stay absent. */
export async function rolloutTurnModels(file: unknown, limit = 1 << 28, wanted?: ReadonlySet<string>, older = false) {
  const models = new Map<string, string>();
  if (!rolloutPath(file)) return models;
  try {
    if (!file.endsWith(".zst") && wanted) {
      // Older pages may precede the recent suffix. Seek their labels without retaining
      // intervening messages; opening a chat still has a fixed recent-read budget.
      for await (const line of reverseRolloutLines(file, older ? Infinity : Math.min(limit, 8 * 1024 * 1024))) {
        const found = lineTurnModel(line);
        if (found && wanted.has(found.turnId) && !models.has(found.turnId)) models.set(found.turnId, found.model);
        if (models.size === wanted.size) break;
      }
      return models;
    }
    const input = await rolloutInput(file, limit);
    if (!input) return models;
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      const found = lineTurnModel(line);
      if (found && (!wanted || wanted.has(found.turnId))) models.set(found.turnId, found.model);
    }
  } catch {
    /* An unreadable transcript has no model labels. */
  }
  return models;
}
/** The estimated tokens per category of a chat's saved transcript, as the engine would attribute its history, or null when
 * the transcript cannot say what the model last saw: no readable rollout, a compaction saved without its replacement
 * history, or a rolled-back turn. Plain rollouts are read whole, compressed ones streamed. The tool definitions and the
 * output schema are not in a rollout; `contextLedger` takes them from the measured total. */
export async function rolloutShares(file: unknown, limit = 1 << 28) {
  if (!rolloutPath(file)) return null;
  const tokens = Object.fromEntries(SHARE_KEYS.map(key => [key, 0])) as Shares;
  try {
    const input = await rolloutInput(file, limit);
    if (!input) return null;
    const add = (item: RolloutItem) => {
      const [key, size] = sizedItem(item);
      tokens[key] = tokens[key]! + Math.ceil(size / 4);
    };
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!/"(session_meta|response_item|compacted|thread_rolled_back)"/.test(line)) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = row?.payload;
      if (row?.type === "session_meta")
        tokens.systemInstructions = Math.ceil(textBytes(payload?.base_instructions?.text) / 4);
      else if (row?.type === "response_item" && payload) add(payload);
      else if (row?.type === "event_msg" && payload?.type === "thread_rolled_back") return null;
      else if (row?.type === "compacted") {
        if (!Array.isArray(payload?.replacement_history)) return null;
        for (const key of SHARE_KEYS) if (key !== "systemInstructions") tokens[key] = 0;
        for (const item of payload.replacement_history) add(item);
      }
    }
  } catch {
    return null;
  }
  return Object.values(tokens).some(count => count > 0) ? tokens : null;
}
// A rollout's `token_count` record carries usage in the engine's snake_case.
export function rolloutUsage(value: unknown): Record<string, number> | null {
  if (!record(value)) return null;
  const usage: Record<string, number> = {};
  for (const key of usageKeys) {
    const count = value[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)];
    if (typeof count === "number") usage[key] = count;
  }
  return usage;
}
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
export const countedUsage = (line: string): RecordValue | null => {
  if (!line.includes('"token_count"')) return null;
  try {
    const row: unknown = JSON.parse(line);
    const payload = record(row) && record(row.payload) ? row.payload : null;
    return payload?.type === "token_count" && record(payload.info) ? payload.info : null;
  } catch {
    return null;
  }
};
export async function lastCountFromEnd(file: string, chunk = 1 << 16, limit = 1 << 25) {
  const handle = await fsp.open(file, "r");
  try {
    let end = (await handle.stat()).size,
      carry = Buffer.alloc(0),
      scanned = 0;
    while (end > 0 && scanned < limit) {
      const start = Math.max(0, end - chunk),
        buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      scanned += buffer.length;
      end = start;
      const data = Buffer.concat([buffer, carry]);
      let stop = data.length;
      for (let index = data.length - 1; index >= 0; index--)
        if (data[index] === 10) {
          const found = countedUsage(data.toString("utf8", index + 1, stop));
          if (found) return found;
          stop = index;
        }
      if (start === 0) return countedUsage(data.toString("utf8", 0, stop));
      carry = data.subarray(0, stop);
    }
    return null;
  } finally {
    await handle.close();
  }
}
export async function lastCountInStream(input: Readable) {
  let found: RecordValue | null = null;
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity }))
    found = countedUsage(line) ?? found;
  return found;
}
/** The usage a chat's rollout recorded last: the `token_count` the engine restores on a cold resume
 * (app-server token_usage_replay.rs), so an old chat shows its numbers before it runs again. Rollouts keep no
 * category shares; those come with the next request. Plain rollouts are read from their end, compressed ones streamed. */
export async function restoredTokenUsage(file: unknown) {
  if (!rolloutPath(file)) return null;
  let info;
  try {
    if (!file.endsWith(".zst")) info = await lastCountFromEnd(file);
    else if (typeof zlib.createZstdDecompress === "function")
      info = await lastCountInStream(fs.createReadStream(file).pipe(zlib.createZstdDecompress()));
  } catch {
    return null;
  }
  if (!info) return null;
  return {
    total: rolloutUsage(info.total_token_usage),
    last: rolloutUsage(info.last_token_usage),
    modelContextWindow: typeof info.model_context_window === "number" ? info.model_context_window : null,
    contextAttribution: null,
  };
}

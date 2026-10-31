import { replyPortrait } from "../bridge/matilda-face.cjs";

export type HeartReaction = { threadId: string; itemId: string };
export const HEART_REACTION = "elpis:heart-reaction";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reaction(threadId: unknown, itemId: unknown, portrait: unknown): HeartReaction | null {
  if (typeof threadId !== "string" || !threadId || typeof itemId !== "string" || !itemId) return null;
  return portrait === "kissSoft" || portrait === "kissPuckered" ? { threadId, itemId } : null;
}

export function nativeHeartReaction(method: string, params: unknown): HeartReaction | null {
  if (method !== "item/completed") return null;
  const event = record(params), item = record(event?.item);
  if (item?.type !== "agentMessage" || typeof item.text !== "string") return null;
  return reaction(event?.threadId, item.id, replyPortrait(item.text).expression);
}

export function talkHeartReaction(snapshot: unknown): HeartReaction | null {
  const event = record(record(snapshot)?.heartReaction);
  return event ? reaction(event.threadId, event.itemId, event.portrait) : null;
}

export function createHeartDeduper() {
  const seen = new Set<string>();
  return (value: HeartReaction | null) => {
    if (!value) return false;
    const id = JSON.stringify([value.threadId, value.itemId]);
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    return true;
  };
}

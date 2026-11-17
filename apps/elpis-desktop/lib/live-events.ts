import type { Entry, Item } from "./api";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const itemKey = (turnId: string, itemId: string) => `${turnId}:${itemId}`;
// A delta received before its full item cannot safely replace a fetched baseline.
const unbasedItems = new WeakSet<Item>();
const deltaItemTypes: Record<string, "agentMessage" | "commandExecution" | "fileChange" | "reasoning"> = {
  "item/agentMessage/delta": "agentMessage",
  "item/commandExecution/outputDelta": "commandExecution",
  "item/fileChange/outputDelta": "fileChange",
  "item/reasoning/summaryTextDelta": "reasoning",
};

type LiveItemEvent =
  | { turnId: string; item: Item; model?: string | undefined }
  | {
      turnId: string;
      itemId: string;
      type: string;
      delta: string;
      summaryIndex: number;
      model?: string | undefined;
    };

function liveItemEvent(method: string, params: Record<string, unknown>): LiveItemEvent | null {
  const { turnId, itemId, delta } = params;
  const model = nonEmptyString(params.model) ? params.model : undefined;
  if (!nonEmptyString(turnId)) return null;
  if (method === "item/started" || method === "item/completed") {
    const item = record(params.item);
    return nonEmptyString(item.id) && nonEmptyString(item.type) ? { turnId, item: item as Item, model } : null;
  }
  const type = Object.hasOwn(deltaItemTypes, method) ? deltaItemTypes[method] : undefined;
  if (!type || !nonEmptyString(itemId) || typeof delta !== "string") return null;
  let summaryIndex = 0;
  if (type === "reasoning") {
    const index = params.summaryIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1024) return null;
    summaryIndex = index;
  }
  return { turnId, itemId, type, delta, summaryIndex, model };
}

/** Call after checking the event belongs to the selected chat. */
export function liveEventItemKey(method: string, params: Record<string, unknown>): string | null {
  const event = liveItemEvent(method, params);
  return event ? itemKey(event.turnId, "item" in event ? event.item.id : event.itemId) : null;
}

/** A cached stream must not shrink on reopening; a longer saved result can advance it. */
function cachedLiveIsNewer(entry: Entry, baseline: Entry): boolean {
  if (entry.item.type !== baseline.item.type) return false;
  const field = entry.item.type === "agentMessage" ? "text" : "aggregatedOutput";
  const current = entry.item[field], saved = baseline.item[field];
  if (typeof current === "string" && typeof saved === "string") {
    if (saved.length > current.length) return false;
    if (current.length > saved.length && current.startsWith(saved)) return true;
  }
  return !!entry.completedAtMs || (entry.item.status === "completed" && baseline.item.status !== "completed");
}

/** Keep the chronological snapshot, except for newer live items, including those cached before a chat switch. */
export function mergeHistoryWithLive(
  current: Entry[],
  snapshot: Entry[],
  changedSinceRead: ReadonlySet<string>,
  previouslyLive: ReadonlySet<string> = new Set(),
): Entry[] {
  const merged = new Map<string, Entry>();
  for (const entry of snapshot) merged.set(itemKey(entry.turnId, entry.item.id), entry);
  for (const entry of current) {
    const key = itemKey(entry.turnId, entry.item.id);
    const changed = changedSinceRead.has(key);
    if (!changed && !previouslyLive.has(key)) continue;
    const baseline = merged.get(key);
    if (unbasedItems.has(entry.item) && baseline && !unbasedItems.has(baseline.item)) continue;
    if (!changed && baseline && !cachedLiveIsNewer(entry, baseline)) continue;
    merged.set(key, entry);
  }
  const result = [...merged.values()];
  const snapshotKeys = new Set(snapshot.map(entry => itemKey(entry.turnId, entry.item.id)));
  // A saved page can have advanced while the chat was hidden. Missing cached stream items
  // belong after their preceding shared item, before the page's newer work.
  let previous: string | undefined;
  for (const entry of current) {
    const key = itemKey(entry.turnId, entry.item.id);
    if (!merged.has(key)) continue;
    if (previous && previouslyLive.has(key) && !changedSinceRead.has(key) && !snapshotKeys.has(key)) {
      const at = result.indexOf(entry);
      if (at >= 0) {
        result.splice(at, 1);
        const anchor = result.findIndex(row => itemKey(row.turnId, row.item.id) === previous);
        result.splice(anchor + 1, 0, entry);
      }
    }
    previous = key;
  }
  return result;
}

/** Update the selected conversation only; completion replaces its streamed item. */
export function mergeLiveItem(
  entries: Entry[],
  method: string,
  params: Record<string, unknown>,
  selectedId: string,
): Entry[] {
  if (params.threadId !== selectedId) return entries;
  const event = liveItemEvent(method, params);
  if (!event) return entries;
  let item: Item;
  if ("item" in event) {
    item = event.item;
    unbasedItems.delete(item);
  } else {
    const previous = entries.find(entry => entry.turnId === event.turnId && entry.item.id === event.itemId)?.item;
    item = { ...previous, id: event.itemId, type: event.type };
    if (!previous || unbasedItems.has(previous)) unbasedItems.add(item);
    if (event.type === "reasoning") {
      const index = event.summaryIndex;
      const summary = Array.isArray(previous?.summary) ? [...previous.summary] : [];
      while (summary.length <= index) summary.push("");
      summary[index] = (typeof summary[index] === "string" ? summary[index] : "") + event.delta;
      item.summary = summary;
    } else {
      const field =
        event.type === "agentMessage" ? "text" : event.type === "commandExecution" ? "aggregatedOutput" : "output";
      item[field] = (typeof previous?.[field] === "string" ? previous[field] : "") + event.delta;
    }
  }
  const index = entries.findIndex(entry => entry.turnId === event.turnId && entry.item.id === item.id);
  if (index < 0) return [...entries, { turnId: event.turnId, item, ...(event.model ? { model: event.model } : {}) }];
  return entries.map((entry, i) =>
    i === index ? { ...entry, item, ...(event.model ? { model: event.model } : {}) } : entry,
  );
}

export const RETRYING = " — retrying…";

export function runtimeErrorNotice(params: Record<string, unknown>): string | null {
  const message = record(params.error).message;
  if (typeof message !== "string" || !message.trim()) return null;
  return params.willRetry === true ? `${message}${RETRYING}` : message;
}

/** New output in a turn: an item started, streamed or finished. After a retry notice it means the retry worked. */
export function retryRecovered(method: string): boolean {
  return (
    method === "item/started" ||
    method === "item/completed" ||
    /^item\/[A-Za-z]+\/(?:delta|[A-Za-z]*Delta)$/.test(method)
  );
}

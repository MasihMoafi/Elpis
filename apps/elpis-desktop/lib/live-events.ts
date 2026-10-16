import type { Entry, Item } from "./api";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

type LiveItemEvent = { turnId: string; item: Item } | {
  turnId: string; itemId: string; type: string; delta: string; summaryIndex: number;
};

function liveItemEvent(method: string, params: Record<string, unknown>): LiveItemEvent | null {
  const { turnId, itemId, delta } = params;
  if (!nonEmptyString(turnId)) return null;
  if (method === "item/started" || method === "item/completed") {
    const item = record(params.item);
    return nonEmptyString(item.id) && nonEmptyString(item.type) ? { turnId, item: item as Item } : null;
  }
  const type = Object.hasOwn(deltaItemTypes, method) ? deltaItemTypes[method] : undefined;
  if (!type || !nonEmptyString(itemId) || typeof delta !== "string") return null;
  let summaryIndex = 0;
  if (type === "reasoning") {
    const index = params.summaryIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1024) return null;
    summaryIndex = index;
  }
  return { turnId, itemId, type, delta, summaryIndex };
}

/** Call after checking the event belongs to the selected chat. */
export function liveEventItemKey(method: string, params: Record<string, unknown>): string | null {
  const event = liveItemEvent(method, params);
  return event ? itemKey(event.turnId, "item" in event ? event.item.id : event.itemId) : null;
}

/** Keep the chronological snapshot, except for items changed while its read was in flight. */
export function mergeHistoryWithLive(current: Entry[], snapshot: Entry[], changedSinceRead: ReadonlySet<string>): Entry[] {
  const merged = new Map<string, Entry>();
  for (const entry of snapshot) merged.set(itemKey(entry.turnId, entry.item.id), entry);
  for (const entry of current) {
    const key = itemKey(entry.turnId, entry.item.id);
    if (!changedSinceRead.has(key)) continue;
    const baseline = merged.get(key);
    if (unbasedItems.has(entry.item) && baseline && !unbasedItems.has(baseline.item)) continue;
    merged.set(key, entry);
  }
  return [...merged.values()];
}

/** Update the selected conversation only; completion replaces its streamed item. */
export function mergeLiveItem(entries: Entry[], method: string, params: Record<string, unknown>, selectedId: string): Entry[] {
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
      const field = event.type === "agentMessage" ? "text" : event.type === "commandExecution" ? "aggregatedOutput" : "output";
      item[field] = (typeof previous?.[field] === "string" ? previous[field] : "") + event.delta;
    }
  }
  const index = entries.findIndex(entry => entry.turnId === event.turnId && entry.item.id === item.id);
  if (index < 0) return [...entries, { turnId: event.turnId, item }];
  return entries.map((entry, i) => i === index ? { ...entry, item } : entry);
}

export function runtimeErrorNotice(params: Record<string, unknown>): string | null {
  const message = record(params.error).message;
  if (typeof message !== "string" || !message.trim()) return null;
  return params.willRetry === true ? `${message} — retrying…` : message;
}

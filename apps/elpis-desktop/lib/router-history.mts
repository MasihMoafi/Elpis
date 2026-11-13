import type { Entry } from "./api.ts";
import type { HistoryPage } from "./chat-history.ts";

const BEFORE = "elpis:before:";
const key = (entry: Entry) => JSON.stringify([entry.turnId, entry.item.id]);

/** Keep ten recent requests, bounded also when worker replies arrive without a new request. */
export function recentRouterHistory(entries: Entry[], cursor: string | null) {
  let start = Math.max(0, entries.length - 100), requests = 0;
  for (let index = entries.length - 1; index >= start; index--)
    if (entries[index]!.item.type === "userMessage" && ++requests === 10) {
      start = index;
      break;
    }
  return start > 0
    ? { entries: entries.slice(start), cursor: BEFORE + key(entries[start]!) }
    : { entries, cursor };
}

/** A released prefix lives on disk. Find its boundary again without retaining newer pages or using offset cursors. */
export async function readEarlierHistory(
  cursor: string,
  read: (cursor?: string) => Promise<HistoryPage>,
): Promise<HistoryPage> {
  if (!cursor.startsWith(BEFORE)) return read(cursor);
  const boundary = cursor.slice(BEFORE.length), seen = new Set<string>();
  let next: string | undefined;
  do {
    const page = await read(next);
    const index = page.data.findIndex(entry => key(entry) === boundary);
    if (index >= 0) return { ...page, data: page.data.slice(index + 1) };
    if (!page.nextCursor) break;
    if (seen.has(page.nextCursor)) throw new Error("Repeated conversation cursor");
    seen.add(page.nextCursor);
    next = page.nextCursor;
  } while (next);
  throw new Error("Earlier messages changed. Refresh this conversation and try again.");
}

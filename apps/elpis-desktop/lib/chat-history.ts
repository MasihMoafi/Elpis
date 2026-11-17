import type { Entry } from "./api";

/** One page of a chat's history as the bridge returns it, newest first; `earliestHistoryMissing` when the record it
 * continued was deleted. */
export type HistoryPage = { data: Entry[]; nextCursor: string | null; earliestHistoryMissing?: boolean };

/** The bridge path of a chat's history page: the newest 100 items, or the 100 before `cursor`. */
export const historyPath = (threadId: string, cursor?: string | null) =>
  `/threads/${encodeURIComponent(threadId)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** A page's items in reading order (oldest first). */
export const inReadingOrder = (page: { data: Entry[] }) => [...page.data].reverse();

/** Keep the known older prefix when the latest page advances while this chat is hidden. */
export function cachedHistoryPrefix(cached: Entry[] | undefined, fresh: Entry[]): Entry[] {
  const keys = new Set(fresh.map(entry => `${entry.turnId}:${entry.item.id}`));
  const overlap = cached?.findIndex(entry => keys.has(`${entry.turnId}:${entry.item.id}`)) ?? -1;
  return cached && overlap !== 0 ? cached.slice(0, overlap < 0 ? undefined : overlap) : [];
}

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, type Entry, type Thread } from "@/lib/api";
import { historyPath, inReadingOrder, type HistoryPage } from "@/lib/chat-history";
import { mergeHistoryWithLive } from "@/lib/live-events";
import { TranscriptCache } from './transcript-cache.mts';

export function useTranscriptHistory(selected: Thread | null, loading: boolean, entries: Entry[], setEntries: Dispatch<SetStateAction<Entry[]>>) {
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  // Chats whose earliest part is gone open with what remains and say so.
  const [historyGaps, setHistoryGaps] = useState<ReadonlySet<string>>(() => new Set());
  const noteHistoryGap = useCallback((id: string, page: { earliestHistoryMissing?: boolean }) => setHistoryGaps(gaps => gaps.has(id) === !!page.earliestHistoryMissing ? gaps
    : new Set(page.earliestHistoryMissing ? [...gaps, id] : [...gaps].filter(gap => gap !== id))), []);
  // Earlier entries already read but not shown yet; a fresh read drops them with the old cursor.
  const heldEarlier = useRef(new Map<string, Entry[]>());
  const [heldCount, setHeldCount] = useState(0);
  /** Reopening a chat draws its last read transcript at once while it rereads. */
  const transcripts = useRef(new TranscriptCache());
  useEffect(() => { heldEarlier.current.clear(); }, [selected?.id]);
  useEffect(() => { if (selected && !loading) transcripts.current.set(selected.id, { entries, cursor: itemCursor }); }, [selected, loading, entries, itemCursor]);
  // A hover reads recent history so a click can show it immediately.
  const prefetching = useRef(new Map<string, Promise<void>>());
  const prefetchThread = useCallback((thread: Thread) => {
    if (transcripts.current.has(thread.id) || prefetching.current.size) return;
    prefetching.current.set(thread.id, api<{ data: Entry[]; nextCursor: string | null }>(historyPath(thread.id))
      .then(result => { if (Array.isArray(result.data) && !transcripts.current.has(thread.id)) transcripts.current.set(thread.id, { entries: inReadingOrder(result), cursor: result.nextCursor }); })
      .catch(() => {}) // The click reads it again and reports a failure.
      .finally(() => prefetching.current.delete(thread.id)));
  }, []);
  const liveRevision = useRef(0), liveVersions = useRef(new Map<string, number>());
  const liveKeysAfter = useCallback((revision: number) => new Set([...liveVersions.current].filter(([, version]) => version > revision).map(([key]) => key)), []);
  /** Merge a history page with newer live items, and note its cursor and gap. */
  const applyHistoryPage = useCallback((id: string, page: HistoryPage, revision: number, keepOlder = false) => {
    const fresh = inReadingOrder(page), cached = keepOlder ? transcripts.current.get(id) : undefined;
    const keys = new Set(fresh.map(entry => `${entry.turnId}:${entry.item.id}`));
    const overlap = cached?.entries.findIndex(entry => keys.has(`${entry.turnId}:${entry.item.id}`)) ?? -1;
    const prefix = overlap > 0 ? cached!.entries.slice(0, overlap) : [];
    const snapshot = !fresh.length && cached ? cached.entries : [...prefix, ...fresh];
    setEntries(previous => mergeHistoryWithLive(previous, snapshot, liveKeysAfter(revision)));
    setItemCursor(cached && (!fresh.length || prefix.length) ? cached.cursor : page.nextCursor);
    noteHistoryGap(id, page); if (!cached || fresh.length && !prefix.length) heldEarlier.current.delete(id);
  }, [liveKeysAfter, noteHistoryGap, setEntries]);
  return { itemCursor, setItemCursor, historyGaps, noteHistoryGap, heldEarlier, heldCount, setHeldCount, transcripts, prefetching, prefetchThread, liveRevision, liveVersions, liveKeysAfter, applyHistoryPage };
}

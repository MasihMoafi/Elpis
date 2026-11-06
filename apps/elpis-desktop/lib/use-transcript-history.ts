import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Entry, Thread } from "@/lib/api";
import { inReadingOrder, type HistoryPage } from "@/lib/chat-history";
import { mergeHistoryWithLive } from "@/lib/live-events";

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
  const transcripts = useRef(new Map<string, { entries: Entry[]; cursor: string | null }>());
  useEffect(() => { if (selected && !loading) transcripts.current.set(selected.id, { entries, cursor: itemCursor }); }, [selected, loading, entries, itemCursor]);
  const liveRevision = useRef(0), liveVersions = useRef(new Map<string, number>());
  const liveKeysAfter = useCallback((revision: number) => new Set([...liveVersions.current].filter(([, version]) => version > revision).map(([key]) => key)), []);
  /** Merge a history page with newer live items, and note its cursor and gap. */
  const applyHistoryPage = useCallback((id: string, page: HistoryPage, revision: number) => {
    setEntries(previous => mergeHistoryWithLive(previous, inReadingOrder(page), liveKeysAfter(revision))); setItemCursor(page.nextCursor);
    noteHistoryGap(id, page); heldEarlier.current.delete(id);
  }, [liveKeysAfter, noteHistoryGap, setEntries]);
  return { itemCursor, setItemCursor, historyGaps, noteHistoryGap, heldEarlier, heldCount, setHeldCount, transcripts, liveRevision, liveVersions, liveKeysAfter, applyHistoryPage };
}

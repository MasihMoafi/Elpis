import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, unreadable, type Entry, type Thread } from "@/lib/api";
import { historyPath, inReadingOrder } from "@/lib/chat-history";
import { mergeHistoryWithLive } from "@/lib/live-events";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import type { View } from "@/lib/workspace-types";

type Inputs = {
  selected: Thread | null; selectedLiveError: string | undefined; view: View; loading: boolean; selectedRef: RefObject<Thread | null>;
  history: ReturnType<typeof useTranscriptHistory>; conversations: ReturnType<typeof useConversationList>; setEntries: Dispatch<SetStateAction<Entry[]>>;
};

/** Refresh a conversation by reading it when its live subscription failed. */
export function useHistoryFallback({ selected, selectedLiveError, view, loading, selectedRef, history, conversations, setEntries }: Inputs) {
  const { liveRevision, liveKeysAfter } = history;
  const { select } = conversations;
  useEffect(() => {
    if (!selected || !selectedLiveError || view !== "chat" || loading) return;
    const id = selected.id; let disposed = false, inFlight = false;
    const timer = setInterval(() => { void (async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const historyRevision = liveRevision.current;
      try {
        const result = await api<{ thread: Thread; data: Entry[] }>(historyPath(id)); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
        if (disposed || selectedRef.current?.id !== id) return;
        select(result.thread);
        setEntries(prev => {
          const fresh = inReadingOrder(result); const byId = new Map(fresh.map(entry => [`${entry.turnId}:${entry.item.id}`, entry]));
          const merged = prev.map(entry => byId.get(`${entry.turnId}:${entry.item.id}`) || entry);
          const previousIds = new Set(prev.map(entry => `${entry.turnId}:${entry.item.id}`));
          merged.push(...fresh.filter(entry => !previousIds.has(`${entry.turnId}:${entry.item.id}`)));
          const preserved = mergeHistoryWithLive(prev, merged, liveKeysAfter(historyRevision));
          return JSON.stringify(preserved) === JSON.stringify(prev) ? prev : preserved;
        });
      } catch { /* Read again in 3 s; the chat stays on screen meanwhile. */ } finally { inFlight = false; }
    })(); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selectedLiveError, view, loading, select, liveKeysAfter]);
}

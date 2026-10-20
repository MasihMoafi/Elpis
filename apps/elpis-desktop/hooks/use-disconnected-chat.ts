/** Refreshes a selected chat by reading it when its live subscription is unavailable. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { api, unreadable, type Entry, type Thread } from "@/lib/api";
import { mergeHistoryWithLive } from "@/lib/live-events";
import type { View } from "@/hooks/use-chat-navigation";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = { selected: Thread | null; liveError: Record<string, string>; view: View; loading: boolean;
  liveRevision: Ref<number>; selectedRef: Ref<Thread | null>; select: (thread: Thread | null) => void;
  setEntries: Setter<Entry[]>; liveKeysAfter: (revision: number) => Set<string>; setError: Setter<string> };

export function useDisconnectedChat({ selected, liveError, view, loading, liveRevision, selectedRef,
  select, setEntries, liveKeysAfter, setError }: Props) {
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useEffect(() => {
    if (!selected || !selectedLiveError || view !== "chat" || loading) return;
    const id = selected.id; let disposed = false, inFlight = false;
    const timer = setInterval(async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const historyRevision = liveRevision.current;
      try {
        const result = await api<{ thread: Thread; data: Entry[] }>(`/threads/${encodeURIComponent(id)}?limit=100`); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
        if (disposed || selectedRef.current?.id !== id) return;
        select(result.thread);
        setEntries(prev => {
          const fresh = [...result.data].reverse(); const byId = new Map(fresh.map(entry => [`${entry.turnId}:${entry.item.id}`, entry]));
          const merged = prev.map(entry => byId.get(`${entry.turnId}:${entry.item.id}`) || entry);
          const previousIds = new Set(prev.map(entry => `${entry.turnId}:${entry.item.id}`));
          merged.push(...fresh.filter(entry => !previousIds.has(`${entry.turnId}:${entry.item.id}`)));
          const preserved = mergeHistoryWithLive(prev, merged, liveKeysAfter(historyRevision));
          return JSON.stringify(preserved) === JSON.stringify(prev) ? prev : preserved;
        });
      } catch (e) { if (!disposed) setError(String(e)); } finally { inFlight = false; }
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected?.id, selectedLiveError, view, loading, select, liveKeysAfter]);
  return selectedLiveError;
}

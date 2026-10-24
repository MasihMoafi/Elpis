import { useCallback, useEffect, useRef, useState } from "react";
import { readAttention, saveAttention, type Attention } from "@/lib/attention";
import { readPins, savePins } from "@/lib/pins";
import { readBookmarks, saveBookmarks } from "@/lib/bookmarks";

/** Which chats have an answer not yet read and which wait on a plan, kept on this computer. A plan the person has answered stops waiting.
 * `planTurns` remembers each chat's latest plan turn while the window is open. */
export function useChatAttention(planAnswered: Record<string, string>, onError: (message: string) => void) {
  const [attention, setAttention] = useState<Attention>({ unread: [], plans: {} });
  const [loaded, setLoaded] = useState(false);
  const planTurns = useRef(new Map<string, string>());
  useEffect(() => { setAttention(readAttention()); setLoaded(true); }, []);
  useEffect(() => {
    if (loaded) try { saveAttention(attention); } catch { onError("Could not save chat attention on this device."); }
  }, [attention, loaded, onError]);
  const markRead = useCallback((id: string) => setAttention(previous => previous.unread.includes(id) ? { ...previous, unread: previous.unread.filter(value => value !== id) } : previous), []);
  useEffect(() => {
    setAttention(previous => {
      const answered = Object.keys(previous.plans).filter(id => previous.plans[id] === planAnswered[id]);
      if (!answered.length) return previous;
      return { ...previous, plans: Object.fromEntries(Object.entries(previous.plans).filter(([id]) => !answered.includes(id))) };
    });
  }, [planAnswered]);
  return { attention, setAttention, planTurns, markRead };
}

function useChatMarks(read: () => string[], save: (ids: string[]) => void) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => { setIds(read()); }, [read]);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [id, ...ids];
    setIds(next); save(next);
  };
  return [ids, toggle] as const;
}

/** The chats pinned to the top of the sidebar, newest pin first, kept on this computer. */
export function usePins() {
  const [pins, togglePinned] = useChatMarks(readPins, savePins);
  return { pins, togglePinned };
}

/** Bookmarks mark chats without changing their sidebar section or order. */
export function useBookmarks() {
  const [bookmarks, toggleBookmarked] = useChatMarks(readBookmarks, saveBookmarks);
  return { bookmarks, toggleBookmarked };
}

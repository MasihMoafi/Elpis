import { useCallback, useEffect, useRef, useState } from "react";
import { readAttention, saveAttention, type Attention } from "@/lib/attention";
import { readPins, savePins } from "@/lib/pins";

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

/** The chats pinned to the top of the sidebar, newest pin first, kept on this computer. */
export function usePins() {
  const [pins, setPins] = useState<string[]>([]);
  useEffect(() => { setPins(readPins()); }, []);
  const togglePinned = (id: string) => {
    const next = pins.includes(id) ? pins.filter(value => value !== id) : [id, ...pins];
    setPins(next); savePins(next);
  };
  return { pins, togglePinned };
}

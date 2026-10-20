/** Owns unread and plan attention for chats, including local persistence. */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readAttention, saveAttention, type Attention } from "@/lib/attention";

export function useChatAttention(setError: Dispatch<SetStateAction<string>>) {
  const [planAnswered, setPlanAnswered] = useState<Record<string, string>>({});
  const [attention, setAttention] = useState<Attention>({ unread: [], plans: {} });
  const [attentionLoaded, setAttentionLoaded] = useState(false);
  const planTurns = useRef(new Map<string, string>());
  useEffect(() => { setAttention(readAttention()); setAttentionLoaded(true); }, []);
  useEffect(() => {
    if (attentionLoaded) try { saveAttention(attention); } catch { setError("Could not save chat attention on this device."); }
  }, [attention, attentionLoaded]);
  const markRead = useCallback((id: string) => setAttention(previous => previous.unread.includes(id) ? { ...previous, unread: previous.unread.filter(value => value !== id) } : previous), []);
  useEffect(() => {
    setAttention(previous => {
      const answered = Object.keys(previous.plans).filter(id => previous.plans[id] === planAnswered[id]);
      if (!answered.length) return previous;
      return { ...previous, plans: Object.fromEntries(Object.entries(previous.plans).filter(([id]) => !answered.includes(id))) };
    });
  }, [planAnswered]);
  return { attention, setAttention, planAnswered, setPlanAnswered, planTurns, markRead };
}

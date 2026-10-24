"use client";

import { useEffect, useRef, useState } from "react";
import { useReadAloud } from "@/components/read-aloud";
import { api, type Entry } from "@/lib/api";
import { entryKey } from "@/lib/submitted-messages";

/** Subscribe before the next turn, then speak its live prose through the board's existing sentence queue. */
export function MatildaAutoVoice({ threadId, activeTurnId, entries, disabled }: { threadId: string; activeTurnId: string | null; entries: Entry[]; disabled: boolean }) {
  const speech = useReadAloud();
  const latest = useRef({ speech, threadId, disabled }); latest.current = { speech, threadId, disabled };
  const alive = useRef(false), spoken = useRef(new Set<string>());
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    void api<{ thread: { id: string } | null }>("/love-spot/talk").then(value => {
      if (alive.current) setReady(value.thread?.id === threadId);
    }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : "Automatic voice could not connect."); });
    return () => { alive.current = false; };
  }, [threadId]);
  useEffect(() => {
    if (!ready || disabled || !activeTurnId || !latest.current.speech || spoken.current.has(activeTurnId)) return;
    const entry = entries.find(entry => entry.turnId === activeTurnId && entry.item.type === "agentMessage" && (!entry.item.phase || entry.item.phase === "final_answer") && typeof entry.item.text === "string" && entry.item.text.trim());
    if (!entry) return;
    spoken.current.add(activeTurnId); setError("");
    void api<{ enabled: boolean }>("/love-spot/voice/settings").then(voice => {
      if (alive.current && latest.current.threadId === threadId && !latest.current.disabled && voice.enabled) latest.current.speech?.stream(entryKey(entry));
    }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : "Automatic voice could not start."); });
  }, [ready, disabled, activeTurnId, entries, threadId]);
  return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";

type Snapshot = { threadId: string; used: number; window: number };

/** The share of the context window the chat's latest request used (Settings → General → Show context window usage).
 * Shows nothing until Elpis has reported both numbers for this chat. */
export function ContextUsage({ threadId }: { threadId?: string }) {
  const { showContextUsage } = usePreferences();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (!threadId || !showContextUsage) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      if (document.visibilityState === "visible") try {
        const value = await api<{ threadId: string; tokenUsage: { last: { inputTokens?: number } | null; modelContextWindow: number | null } | null }>(`/threads/${encodeURIComponent(threadId)}/context`);
        const used = value.tokenUsage?.last?.inputTokens, window = value.tokenUsage?.modelContextWindow;
        if (!disposed && value.threadId === threadId) setSnapshot(typeof used === "number" && typeof window === "number" && window > 0 ? { threadId, used, window } : null);
      } catch { if (!disposed) setSnapshot(null); }
      if (!disposed) timer = setTimeout(read, 5000);
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  }, [threadId, showContextUsage]);
  if (!showContextUsage || !snapshot || snapshot.threadId !== threadId) return null;
  const share = Math.min(100, snapshot.used / snapshot.window * 100);
  const radius = 7, circumference = 2 * Math.PI * radius;
  const label = `Context: ${snapshot.used.toLocaleString()} of ${snapshot.window.toLocaleString()} tokens (${Math.round(share)}%)`;
  // A ring with its numbers in the tooltip, as in the ChatGPT app's composer.
  return <span className="context-ring" role="meter" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)} title={label}>
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} className="context-ring-track" />
      <circle cx="9" cy="9" r={radius} className="context-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - share / 100)} transform="rotate(-90 9 9)" />
    </svg>
  </span>;
}

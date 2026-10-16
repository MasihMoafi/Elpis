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
  const radius = 6, circumference = 2 * Math.PI * radius;
  return <span className="composer-chip" role="meter" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}
    title={`Latest request: ${snapshot.used.toLocaleString()} of ${snapshot.window.toLocaleString()} tokens`}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" /><circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${share / 100 * circumference} ${circumference}`} transform="rotate(-90 8 8)" /></svg>
    {Math.round(share)}% context
  </span>;
}

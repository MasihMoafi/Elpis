"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "@/components/chat-message";
import { Transcript } from "@/components/transcript";
import { api, unreadable, type Entry, type Thread } from "@/lib/api";

/** A subagent's conversation shown inside the chat that started it, as the ChatGPT app shows its agents (Masih, 30 Oct:
 * "I can! But in another chat only!"). "Show here" opens it under the agent's row; while the agent works it refreshes.
 * "Open chat" still moves to the agent's own chat. */
export function AgentInline({ id, threads }: { id: string; threads: Thread[] }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const name = threads.find(thread => thread.id === id)?.name || "the agent";
  const working = threads.find(thread => thread.id === id)?.status?.type === "active";
  useEffect(() => {
    if (!open) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const page = await api<{ data: Entry[] }>(`/threads/${encodeURIComponent(id)}?limit=100`);
        if (!Array.isArray(page?.data)) throw unreadable("agent conversation");
        if (!stopped) { setEntries(page.data); setError(""); }
      } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!stopped && working) timer = setTimeout(() => void load(), 2000);
    };
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [id, open, working]);
  return <div className="agent-inline">
    <Button variant="ghost" size="xs" aria-expanded={open} aria-label={`${open ? "Hide here" : "Show here"}: ${name}`} onClick={() => setOpen(value => !value)}>{open ? "Hide here" : "Show here"}</Button>
    {open && <div className="agent-inline-body" role="region" aria-label="Agent conversation">
      {error ? <p className="text-xs text-destructive">{error}</p>
        : !entries ? <p className="text-xs text-muted-foreground">Reading…</p>
        : !entries.length ? <p className="text-xs text-muted-foreground">No messages yet.</p>
        : <Transcript entries={entries} activeTurnId={null} renderItem={entry => <ChatMessage item={entry.item} model={entry.model} threads={threads} />} />}
    </div>}
  </div>;
}

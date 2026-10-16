"use client";

import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThreadActions } from "@/components/thread-actions";
import { api, title, type Thread } from "@/lib/api";

type Props = { onUnarchived: (thread: Thread) => void; onDelete: (thread: Thread) => Promise<void> };

/** Chats archived in Elpis: restore them to the sidebar, or delete them. */
export function ArchivedView({ onUnarchived, onDelete }: Props) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (after?: string) => {
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?archived=true&limit=100${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      setThreads(prev => after && prev ? [...prev, ...result.data.filter(item => !prev.some(p => p.id === item.id))] : result.data);
      setCursor(result.nextCursor); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function unarchive(thread: Thread) {
    setBusy(thread.id); setError("");
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/unarchive`, {});
      setThreads(prev => prev?.filter(item => item.id !== thread.id) ?? prev);
      onUnarchived(result.thread);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function remove(thread: Thread) {
    await onDelete(thread);
    setThreads(prev => prev?.filter(item => item.id !== thread.id) ?? prev);
  }
  return <div aria-label="Archived conversations">
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {threads === null && !error && <p className="text-sm text-muted-foreground" role="status">Loading archived conversations…</p>}
    {threads?.length === 0 && <p className="text-sm text-muted-foreground">No archived conversations. Archive a chat from its ⋯ menu in the sidebar.</p>}
    <ul className="archived-list">
      {threads?.map(thread => <li key={thread.id} className="archived-row" data-thread-id={thread.id}>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{title(thread)}</p>
          {thread.agentNickname && <p className="text-xs text-muted-foreground">{thread.agentNickname}</p>}
        </div>
        <Button variant="outline" size="sm" disabled={busy === thread.id} onClick={() => unarchive(thread)} aria-label={`Unarchive ${title(thread)}`}><ArchiveRestore size={14} />{busy === thread.id ? "Restoring…" : "Unarchive"}</Button>
        <ThreadActions thread={thread} onDelete={remove} />
      </li>)}
    </ul>
    {cursor && <Button variant="ghost" className="mt-2 w-full" onClick={() => load(cursor)}>Load more</Button>}
  </div>;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SettingsEmpty, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { ThreadActions } from "@/components/thread-actions";
import { api, title, type Thread } from "@/lib/api";

type Props = { onUnarchived: (thread: Thread) => void; onDelete: (thread: Thread) => Promise<void> };

/** Chats archived in Elpis: restore them to the sidebar, or delete them. */
export function ArchivedView({ onUnarchived, onDelete }: Props) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const term = search.trim(), latest = useRef(0);
  const load = useCallback(async (after?: string) => {
    const request = ++latest.current;
    try {
      const result = await api<{ data: Thread[]; nextCursor: string | null }>(`/threads?archived=true&limit=100${term ? `&searchTerm=${encodeURIComponent(term)}` : ""}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
      if (request !== latest.current) return;
      setThreads(prev => after && prev ? [...prev, ...result.data.filter(item => !prev.some(p => p.id === item.id))] : result.data);
      setCursor(result.nextCursor); setError("");
    } catch (e) { if (request === latest.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [term]);
  useEffect(() => { const timer = setTimeout(() => void load(), term ? 250 : 0); return () => clearTimeout(timer); }, [load, term]);
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
  // The ChatGPT app's archived list: one card of rows, each with the chat's name and its actions on the right.
  return <div aria-label="Archived conversations">
    <SettingsHeader title="Archived chats" />
    <SearchField aria-label="Search archived chats" placeholder="Search archived chats" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {threads === null && !error && <SettingsNotice>Loading archived conversations…</SettingsNotice>}
    {threads?.length === 0 && (term
      ? <SettingsEmpty title={`No archived chats match “${term}”`}>Try another word from the chat’s name.</SettingsEmpty>
      : <SettingsEmpty title="No archived conversations">Archive a chat from its ⋯ menu in the sidebar.</SettingsEmpty>)}
    {!!threads?.length && <ul className="settings-rows">
      {threads.map(thread => <ThreadActions key={thread.id} thread={thread} onDelete={remove} area={<li className="settings-row archived-row" data-thread-id={thread.id} />}>{menu => <>
        <div className="settings-row-text">
          <div className="settings-row-title truncate">{title(thread)}</div>
          {thread.agentNickname && <div className="settings-row-description">{thread.agentNickname}</div>}
        </div>
        <div className="settings-row-control">
          <Button variant="outline" size="sm" disabled={busy === thread.id} onClick={() => unarchive(thread)} aria-label={`Unarchive ${title(thread)}`}><ArchiveRestore />{busy === thread.id ? "Restoring…" : "Unarchive"}</Button>
          {menu}
        </div>
      </>}</ThreadActions>)}
    </ul>}
    {cursor && <Button variant="ghost" className="mt-2 w-full" onClick={() => load(cursor)}>Load more</Button>}
  </div>;
}

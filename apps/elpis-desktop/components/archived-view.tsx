"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SettingRow, SettingsEmpty, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { DeleteChatsDialog, ThreadActions } from "@/components/thread-actions";
import { api, unreadable, title, type Thread } from "@/lib/api";

type Props = { onUnarchived: (thread: Thread) => void; onDelete: (thread: Thread) => Promise<void> };

type Page = { data: Thread[]; nextCursor: string | null };

/** Chats archived in Elpis: restore them to the sidebar, or delete them, one by one or selected together. */
export function ArchivedView({ onUnarchived, onDelete }: Props) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Thread[] | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const term = search.trim(), latest = useRef(0);
  const page = useCallback(async (after?: string | null) => { const result = await api<Page>(`/threads?archived=true&limit=100${term ? `&searchTerm=${encodeURIComponent(term)}` : ""}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`); if (!Array.isArray(result.data)) throw unreadable("archived conversations"); return result; }, [term]);
  const load = useCallback(async (after?: string) => {
    const request = ++latest.current;
    if (!after) setPicked([]);
    try {
      const result = await page(after);
      if (request !== latest.current) return;
      setThreads(prev => after && prev ? [...prev, ...result.data.filter(item => !prev.some(p => p.id === item.id))] : result.data);
      setCursor(result.nextCursor); setError("");
    } catch (e) { if (request === latest.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [page]);
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
    setPicked(prev => prev.filter(id => id !== thread.id));
  }
  /** Select all covers every archived chat (matching the search), loading the pages not shown yet. */
  async function selectAll(on: boolean) {
    if (!on) { setPicked([]); return; }
    const request = ++latest.current;
    setSelectingAll(true);
    try {
      let all = threads ?? [], next = cursor;
      while (next) { const result = await page(next); all = [...all, ...result.data.filter(item => !all.some(p => p.id === item.id))]; next = result.nextCursor; }
      if (request !== latest.current) return;
      setThreads(all); setCursor(null); setPicked(all.map(item => item.id));
    } catch (e) { if (request === latest.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { setSelectingAll(false); }
  }
  const pickedThreads = (threads ?? []).filter(item => picked.includes(item.id));
  async function unarchivePicked() {
    for (const thread of pickedThreads) await unarchive(thread);
    setPicked([]);
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
    {!!threads?.length && <div className="archived-bulk">
      <label className="archived-check"><input type="checkbox" className="accent-primary" aria-label="Select all" checked={selectingAll || (!cursor && picked.length === threads.length)} onChange={event => void selectAll(event.target.checked)} />Select all</label>
      {picked.length > 0 && <>
        <Button variant="outline" disabled={!!busy} onClick={() => void unarchivePicked()}><ArchiveRestore />Unarchive {picked.length}</Button>
        <Button variant="destructive" disabled={!!busy} onClick={() => setDeleting(pickedThreads)}><Trash2 />Delete {picked.length}</Button>
      </>}
    </div>}
    <DeleteChatsDialog threads={deleting} onDelete={remove} onClose={() => setDeleting(null)} alwaysConfirm />
    {!!threads?.length && <ul className="settings-rows">
      {threads.map(thread => <ThreadActions key={thread.id} thread={thread} onDelete={remove} area={<li className="archived-row" data-thread-id={thread.id} />}>{menu => <SettingRow title={title(thread)} scope={null}
        leading={<input type="checkbox" className="accent-primary archived-row-check" aria-label={`Select ${title(thread)}`} checked={picked.includes(thread.id)} onChange={event => setPicked(prev => event.target.checked ? [...prev, thread.id] : prev.filter(id => id !== thread.id))} />}
        description={<>
          {thread.agentNickname && <div>{thread.agentNickname}</div>}
          <div>{thread.archivedAt ? <time dateTime={new Date(thread.archivedAt).toISOString()}>Archived {new Date(thread.archivedAt).toLocaleString()}</time> : "Archive date unavailable"}</div>
          <div>{thread.archiveReason || "Reason unavailable for this older archive."}</div>
        </>}>
          <Button variant="outline" disabled={busy === thread.id} onClick={() => unarchive(thread)} aria-label={`Unarchive ${title(thread)}`}><ArchiveRestore />{busy === thread.id ? "Restoring…" : "Unarchive"}</Button>
          {menu}
      </SettingRow>}</ThreadActions>)}
    </ul>}
    {cursor && <Button variant="ghost" className="mt-2 w-full" onClick={() => load(cursor)}>Load more</Button>}
  </div>;
}

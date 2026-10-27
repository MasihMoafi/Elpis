"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, title, type Thread } from "@/lib/api";

type Page = { data: Thread[]; nextCursor?: string | null };
/** Resume is an explicit saved-chat choice, independent of sidebar visibility or folds. */
export function ResumeConversation({ open, chats, onClose, onChoose, returnFocus }: {
  open: boolean; chats: readonly Thread[]; onClose: () => void; onChoose: (chat: Thread) => void; returnFocus: RefObject<HTMLElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null), version = useRef(0);
  const [query, setQuery] = useState(""), [rows, setRows] = useState<Thread[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => { if (open) { setQuery(""); setRows([...chats]); setLoadedQuery(null); setError(""); } }, [open]);
  useEffect(() => {
    if (!open) return;
    let alive = true; ++version.current;
    setLoading(true); setError(""); setCursor(null);
    const timer = setTimeout(() => {
      api<Page>(`/threads?limit=50${query.trim() ? `&searchTerm=${encodeURIComponent(query.trim())}` : ""}`)
        .then(result => { if (!Array.isArray(result.data)) throw Error("Saved conversations could not be read."); if (alive) { setRows(result.data); setLoadedQuery(query); setCursor(result.nextCursor ?? null); } })
        .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { if (alive) setLoading(false); });
    }, query ? 200 : 0);
    return () => { alive = false; ++version.current; clearTimeout(timer); };
  }, [open, query, revision]);
  async function more() {
    if (!cursor || loading) return;
    const ticket = version.current;
    setLoading(true); setError("");
    try {
      const result = await api<Page>(`/threads?limit=50${query.trim() ? `&searchTerm=${encodeURIComponent(query.trim())}` : ""}&cursor=${encodeURIComponent(cursor)}`);
      if (ticket !== version.current) return;
      if (!Array.isArray(result.data)) throw Error("Saved conversations could not be read.");
      setRows(previous => [...new Map([...previous, ...result.data].map(chat => [chat.id, chat])).values()]); setCursor(result.nextCursor ?? null);
    } catch (cause) { if (ticket === version.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (ticket === version.current) setLoading(false); }
  }
  const term = query.trim().toLocaleLowerCase();
  const visible = loadedQuery === query ? rows : rows.filter(chat => !term || `${title(chat)} ${chat.cwd ?? ""} ${chat.preview ?? ""}`.toLocaleLowerCase().includes(term));
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal>
    <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45" />
    <Dialog.Popup initialFocus={input} finalFocus={returnFocus} className="hud-dialog fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3 outline-none">
      <Dialog.Title className="text-base font-semibold">Resume conversation</Dialog.Title>
      <Dialog.Description className="text-sm text-muted-foreground">Choose a saved chat to continue where you left off.</Dialog.Description>
      <Input ref={input} aria-label="Find saved conversations" placeholder="Search saved chats" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading saved conversations…</p>}
      {error && <div role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></div>}
      <div className="max-h-[min(55vh,420px)] min-h-0 overflow-y-auto" aria-label="Saved conversations">
        {visible.map(chat => <Button key={chat.id} variant="ghost" className="h-auto w-full min-w-0 flex-col items-start gap-1 py-2 text-left" onClick={() => onChoose(chat)}>
          <span className="w-full truncate font-medium">{title(chat)}</span>{chat.cwd && <span className="w-full truncate text-xs text-muted-foreground" title={chat.cwd}>{chat.cwd}</span>}
        </Button>)}
        {!loading && !error && !visible.length && <p className="py-4 text-sm text-muted-foreground">{term ? "No matching conversations." : "No saved conversations yet."}</p>}
      </div>
      <div className="flex justify-end gap-2">{cursor && <Button variant="outline" disabled={loading} onClick={() => void more()}>Load more</Button>}<Dialog.Close render={<Button variant="outline" />}>Close</Dialog.Close></div>
    </Dialog.Popup>
  </Dialog.Portal></Dialog.Root>;
}

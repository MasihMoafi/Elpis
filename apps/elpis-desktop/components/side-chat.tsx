"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage } from "@/components/chat-message";
import { api, type Entry } from "@/lib/api";
import { mergeLiveItem, runtimeErrorNotice } from "@/lib/live-events";

export type SideRequest = { id: number; text: string; kind?: "recap" };

/** An ephemeral fork's messages live only in this panel, never in the main transcript or drafts, until Forward sends
 * its latest answer to the working agent (Masih, A38). */
export function SideChat({ parentId, open, question, onClose, onForward }: { parentId: string; open: boolean; question?: SideRequest; onClose: () => void; onForward?: (answer: string) => void }) {
  const isRecap = question?.kind === "recap";
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null), content = useRef<HTMLDivElement>(null);
  const threadId = useRef<string | null>(null), sending = useRef(false), disposed = useRef(false);
  const requested = useRef<number | null>(null), completed = useRef(new Set<string>());
  const sequence = useRef(0), latestDraft = useRef(draft); latestDraft.current = draft;
  useEffect(() => {
    disposed.current = false;
    const onEvent = (event: Event) => {
      const message = (event as CustomEvent<{ method: string; params: Record<string, unknown> }>).detail;
      if (message.params.threadId !== threadId.current) return;
      const { method, params } = message;
      if ((params.item as { type?: string } | undefined)?.type !== "userMessage") setEntries(previous => mergeLiveItem(previous, method, params, threadId.current!));
      if (method === "turn/completed") {
        const turn = params.turn as { id?: string; error?: { message?: string } } | undefined;
        if (turn?.id) completed.current.add(turn.id);
        setBusy(false); sending.current = false;
        if (turn?.error?.message) setError(turn.error.message);
      }
      if (method === "error") { const notice = runtimeErrorNotice(params); if (notice) setError(notice); }
      if (method === "thread/closed") { threadId.current = null; setBusy(false); sending.current = false; setError("Side chat closed. Send your question again to start a new side chat."); }
    };
    window.addEventListener("elpis:side-chat", onEvent);
    return () => {
      disposed.current = true; window.removeEventListener("elpis:side-chat", onEvent);
      if (threadId.current) void api(`/side-chats/${encodeURIComponent(threadId.current)}/close`, {}).catch(() => {});
    };
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const answer = busy ? "" : [...entries].reverse().find(entry => entry.item.type === "agentMessage" && typeof entry.item.text === "string" && entry.item.text.trim())?.item.text?.trim() ?? "";
  useEffect(() => { if (content.current) content.current.scrollTop = content.current.scrollHeight; }, [entries, busy]);

  async function send(text = latestDraft.current) {
    if (!text.trim() || sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      if (!threadId.current) {
        const created = await api<{ threadId: string }>(`/threads/${encodeURIComponent(parentId)}/side-chat`, {});
        if (disposed.current) { await api(`/side-chats/${encodeURIComponent(created.threadId)}/close`, {}); return; }
        threadId.current = created.threadId; setEntries([]);
      }
      const result = await api<{ turn: { id: string } }>(`/side-chats/${encodeURIComponent(threadId.current)}/turns`, { text });
      if (disposed.current) return;
      const id = `side-prompt-${++sequence.current}`;
      setEntries(previous => {
        const prompt: Entry = { turnId: result.turn.id, item: { id, type: "userMessage", content: [{ type: "text", text: isRecap && text === question?.text ? "Recap this conversation" : text }] } };
        const at = previous.findIndex(entry => entry.turnId === result.turn.id);
        return at < 0 ? [...previous, prompt] : [...previous.slice(0, at), prompt, ...previous.slice(at)];
      });
      if (latestDraft.current === text) setDraft("");
      if (completed.current.has(result.turn.id)) { setBusy(false); sending.current = false; }
    } catch (e) {
      if (!disposed.current) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); sending.current = false; }
    }
  }
  useEffect(() => {
    if (!question || requested.current === question.id) return;
    requested.current = question.id; setDraft(question.text);
    if (question.text.trim()) void send(question.text);
  }, [question]); // eslint-disable-line react-hooks/exhaustive-deps

  return <section role="region" aria-label={isRecap ? "Recap" : "Side chat"} hidden={!open} className="side-chat" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <header className="side-chat-heading"><div><h2>{isRecap ? "Recap" : "Side chat"}</h2><p>{isRecap ? "The goal, decisions, progress and next step" : "Ask a quick side question without adding to the session"}</p></div><Button variant="ghost" size="icon-sm" aria-label={isRecap ? "Close recap" : "Close side chat"} onClick={onClose}><X size={16} /></Button></header>
    <div className="side-chat-content" ref={content} aria-live="polite">
      {entries.map(entry => <ChatMessage key={entry.item.id} item={entry.item} />)}
      {busy && <p role="status" className="text-sm text-muted-foreground">Elpising…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {answer && onForward && <Button variant="outline" size="sm" className="self-start" title="Send this answer to the working agent" onClick={() => onForward(answer)}>Forward</Button>}
    </div>
    <form className="side-chat-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <Textarea ref={input} aria-label="Side question" placeholder="Ask a side question…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} />
      <Button type="submit" size="sm" disabled={busy || !draft.trim()}>Send</Button>
    </form>
  </section>;
}

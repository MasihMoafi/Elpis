"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendIcon } from "@/components/elpis-icons";
import { MarkdownText } from "@/components/markdown-text";
import { api, unreadable, type Entry } from "@/lib/api";
import { MATILDA_CHANGED, savedPersona } from "@/lib/matilda";
import "@/components/matilda-mini-chat.css";

type Conversation = { entries: Entry[]; busy: boolean; error?: string };
function received(value: Conversation) {
  if (!Array.isArray(value.entries) || typeof value.busy !== "boolean") throw unreadable("Matilda conversation");
  return value;
}

/** Keep the conversation and unsent text in the companion, independent of popup mounting and the main chat. */
export function useMatildaMiniChat(open: boolean) {
  const [draft, setDraft] = useState("");
  const [conversation, setConversation] = useState<Conversation>({ entries: [], busy: false });
  const [error, setError] = useState(""), [posting, setPosting] = useState(false);
  const mounted = useRef(false), sending = useRef(false), latestRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; latestRead.current++; }; }, []);
  const read = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRead.current;
    try {
      const result = received(await api<Conversation>("/love-spot/talk", undefined, signal));
      if (mounted.current && request === latestRead.current) { setConversation(result); setError(result.error || ""); }
    } catch (cause) {
      if (!signal?.aborted && mounted.current && request === latestRead.current) setError(cause instanceof Error ? cause.message : "Matilda could not load. Try again.");
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); void read(controller.signal);
    const changed = () => { if (!sending.current) void read(controller.signal); };
    window.addEventListener(MATILDA_CHANGED, changed);
    return () => { controller.abort(); latestRead.current++; window.removeEventListener(MATILDA_CHANGED, changed); };
  }, [open, read]);
  useEffect(() => {
    if (!open || !conversation.busy || posting) return;
    const controller = new AbortController(), timer = setTimeout(() => void read(controller.signal), 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, conversation, posting, read]);
  async function send() {
    const sent = draft.trim();
    if (!sent || sending.current || conversation.busy) return;
    sending.current = true; setPosting(true); setError(""); latestRead.current++;
    try {
      const result = received(await api<Conversation>("/love-spot/talk", { text: sent, persona: savedPersona() }));
      if (!mounted.current) return;
      setConversation(result); setDraft(current => current.trim() === sent ? "" : current); setError(result.error || "");
      window.dispatchEvent(new Event(MATILDA_CHANGED));
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Message not sent. Try again."); }
    finally { sending.current = false; if (mounted.current) setPosting(false); }
  }
  return { draft, setDraft, conversation, error, posting, send, retry: read };
}

function message(entry: Entry) {
  if (entry.item.type === "agentMessage") return typeof entry.item.text === "string" ? entry.item.text : "";
  if (entry.item.type !== "userMessage" || !Array.isArray(entry.item.content)) return "";
  return entry.item.content.filter(part => part && typeof part === "object" && part.type === "text").map(part => part.text).join("\n");
}

export function MatildaMiniChat({ chat }: { chat: ReturnType<typeof useMatildaMiniChat> }) {
  const log = useRef<HTMLDivElement>(null);
  const entries = chat.conversation.entries.filter(entry => message(entry).trim()).slice(-4);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [chat.conversation.entries]);
  return <div className="matilda-mini-chat" role="dialog" aria-label="Small chat with Matilda">
    {!!entries.length && <div ref={log} className="matilda-mini-messages" role="log" aria-label="Matilda conversation" aria-live="polite" aria-relevant="additions text">
      {entries.map(entry => <div key={`${entry.turnId}:${entry.item.id}`} className="matilda-mini-message" data-speaker={entry.item.type === "userMessage" ? "you" : "matilda"}>
        <span className="sr-only">{entry.item.type === "userMessage" ? "You" : "Matilda"}: </span><MarkdownText text={message(entry)} allowImages={false} />
      </div>)}
    </div>}
    {(chat.posting || chat.conversation.busy) && <p className="matilda-mini-status" role="status">Matilda is replying…</p>}
    {chat.error && <div className="matilda-mini-error" role="alert"><span>{chat.error}</span><Button variant="ghost" size="xs" onClick={() => void chat.retry()}>Retry</Button></div>}
    <form aria-label="Message Matilda" className="matilda-mini-composer" onSubmit={event => { event.preventDefault(); void chat.send(); }}>
      <Textarea aria-label="Message Matilda" placeholder="Message Matilda…" rows={1} autoFocus value={chat.draft} onChange={event => chat.setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="Send to Matilda" title="Send to Matilda" disabled={!chat.draft.trim() || chat.posting || chat.conversation.busy}><SendIcon size={18} /></Button>
    </form>
  </div>;
}

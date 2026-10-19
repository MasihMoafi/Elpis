"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dictation } from "@/components/dictation";
import { ModelPicker } from "@/components/model-picker";
import { ChatMessage } from "@/components/chat-message";
import { api, choiceById, type Entry, type Model, type ProviderChoice, type Thread } from "@/lib/api";
import { insertTranscript } from "@/lib/dictation";

type Conversation = { thread: Thread | null; entries: Entry[]; busy: boolean; error: string };
export type LoveSpotQuote = { id: number; text: string };
export function LoveSpotTalk({ open, onClose, quote, model, choiceId, choices, models, onModel, provider, disabled, onDictating, sendWithBoard }: {
  open: boolean; onClose: () => void; quote?: LoveSpotQuote; model: string; choiceId: string; choices: ProviderChoice[]; models: Model[];
  onModel: (value: { model: string; choiceId: string }) => void; provider: string; disabled: boolean; onDictating: (busy: boolean) => void; sendWithBoard: (send: (revision: string) => Promise<void>) => Promise<void>;
}) {
  const [conversation, setConversation] = useState<Conversation>({ thread: null, entries: [], busy: false, error: "" });
  const [draft, setDraft] = useState(""), [sending, setSending] = useState(false), [dictating, setDictating] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null), content = useRef<HTMLDivElement>(null), pending = useRef(false), currentDraft = useRef(draft);
  currentDraft.current = draft;
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const events = new EventSource("/api/love-spot/talk/events");
    events.onmessage = event => {
      if (disposed) return;
      try { setConversation(JSON.parse(event.data)); setError(""); } catch { setError("Love Spot could not read its conversation. Try opening Talk again."); }
    };
    events.onerror = () => { if (!disposed) setError("Talk is reconnecting… Your message is still here."); };
    input.current?.focus();
    return () => { disposed = true; events.close(); };
  }, [open]);
  useEffect(() => {
    if (!quote) return;
    setDraft(`> ${quote.text.replaceAll("\n", "\n> ")}\n\n`);
    requestAnimationFrame(() => input.current?.focus());
  }, [quote]);
  useEffect(() => { if (content.current) content.current.scrollTop = content.current.scrollHeight; }, [conversation.entries, conversation.busy]);
  useEffect(() => { onDictating(dictating); return () => onDictating(false); }, [dictating, onDictating]);
  const busy = sending || conversation.busy;
  async function send() {
    const text = currentDraft.current;
    if (!text.trim() || busy || pending.current || disabled || dictating) return;
    pending.current = true; setSending(true); setError("");
    try {
      await sendWithBoard(async revision => {
        const choice = choiceById(choices, choiceId);
        if (!choice) throw new Error("This connection is no longer available. Choose another model.");
        const result = await api<Conversation>("/love-spot/talk", { text, model, ...(choice.provider ? { provider: choice.provider } : {}), revision });
        setConversation(result);
        if (currentDraft.current === text) setDraft("");
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Love Spot could not send your message."); }
    finally { pending.current = false; setSending(false); }
  }
  // An existing chat keeps its configured connection, exactly as the main composer does.
  const available = conversation.thread?.modelProvider
    ? choices.filter(c => !c.provider || c.provider === conversation.thread?.modelProvider)
    : choices;
  return <section role="region" aria-label="Love Spot Talk" hidden={!open} className="love-spot-talk" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className="love-spot-talk-heading"><strong>Talk</strong><Button variant="ghost" size="icon-sm" aria-label="Fold Talk" onClick={onClose}><ChevronDown size={16} /></Button></header>
    <div className="love-spot-talk-messages" aria-live="polite" ref={content}>
      {!conversation.entries.length && !busy && <p className="text-muted-foreground text-sm">I’m here. What’s on your mind?</p>}
      {conversation.entries.filter(e => ["userMessage", "agentMessage"].includes(e.item.type)).map(entry => <ChatMessage key={`${entry.turnId}:${entry.item.id}`} item={entry.item.type === "userMessage" ? { ...entry.item, content: entry.item.content?.filter(c => c.type === "text").slice(0, 1) } : entry.item} />)}
      {busy && <p role="status" className="text-muted-foreground text-sm">Elpising…</p>}
    </div>
    {(error || conversation.error) && <p role="alert" className="love-spot-talk-error">{error || conversation.error}</p>}
    <form className="love-spot-talk-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <Textarea ref={input} aria-label="Message Elpis" placeholder="Talk with Elpis…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} />
      <div className="love-spot-talk-controls">
        <ModelPicker choices={available} models={models} model={model} choiceId={choiceId} disabled={busy || disabled} allowCustom={false} onChange={onModel} />
        <Dictation provider={provider} disabled={busy || disabled || !open} onBusy={setDictating}
          selection={() => ({ text: currentDraft.current, start: input.current?.selectionStart ?? currentDraft.current.length, end: input.current?.selectionEnd ?? currentDraft.current.length })}
          onTranscript={(selection, text) => { const next = insertTranscript(currentDraft.current, selection, text); setDraft(next.text); requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); }); }} />
        <Button type="submit" size="sm" disabled={busy || dictating || disabled || !draft.trim()}>Send</Button>
      </div>
    </form>
  </section>;
}

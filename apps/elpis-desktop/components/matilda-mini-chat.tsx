"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendIcon } from "@/components/elpis-icons";
import { MarkdownText } from "@/components/markdown-text";
import { api, unreadable, type Entry } from "@/lib/api";
import { MATILDA_CHANGED, savedPersona } from "@/lib/matilda";
import { subscribeLoveSpotTalk } from "@/lib/love-spot-talk-events";
import { HEART_REACTION, talkHeartReaction } from "@/lib/heart-reactions";
import { replyPortrait } from "@/bridge/matilda-face.cjs";
import { attachedFile } from "@/lib/prompt-history";
import { LoadOnScroll } from "@/components/load-on-scroll";
import { MatildaFace } from "@/components/matilda-face";
import { MatildaSwitch } from "@/components/matilda-switch";
import { useMatildaSettings } from "@/lib/matilda-settings";
import "@/components/matilda-mini-chat.css";

/** Earlier messages shown when the chat opens, and how many more each scroll to the top reveals (Masih, 31 Oct: "show some by
 * default, and when I hover up load them"). */
const EARLIER_STEP = 6;

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
  const streamedWhileSending = useRef<Conversation | null>(null);
  // Turns already there when the chat opens are "earlier": the last few show at once, and more as he scrolls up. A reply still
  // on its way stays shown.
  const [earlier, setEarlier] = useState<Set<string> | null>(null), [shownEarlier, setShownEarlier] = useState(EARLIER_STEP);
  const openRef = useRef(open); openRef.current = open;
  const rememberEarlier = useCallback((result: Conversation, sentTurn?: string) => {
    const pending = sentTurn ?? (result.busy ? result.entries.at(-1)?.turnId : undefined);
    setEarlier(current => current ?? new Set(result.entries.map(entry => entry.turnId).filter(turn => turn !== pending)));
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; latestRead.current++; }; }, []);
  const read = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRead.current;
    try {
      const result = received(await api<Conversation>("/love-spot/talk", undefined, signal));
      if (mounted.current && request === latestRead.current) {
        if (openRef.current && !sending.current) rememberEarlier(result);
        setConversation(result); setError(result.error || ""); return result;
      }
    } catch (cause) {
      if (!signal?.aborted && mounted.current && request === latestRead.current) setError(cause instanceof Error ? cause.message : "Matilda could not load. Try again.");
    }
  }, [rememberEarlier]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void read(controller.signal);
    const stop = subscribeLoveSpotTalk(event => {
      try {
        latestRead.current++;
        const result = received(JSON.parse(event.data));
        const reaction = talkHeartReaction(result);
        if (reaction) window.dispatchEvent(new CustomEvent(HEART_REACTION, { detail: reaction }));
        if (sending.current) streamedWhileSending.current = result;
        else rememberEarlier(result);
        setConversation(result); setError(result.error || "");
      } catch { if (!sending.current) void read(controller.signal); }
    }, () => { if (!sending.current) void read(controller.signal); });
    const changed = () => { if (!sending.current) void read(controller.signal); };
    window.addEventListener(MATILDA_CHANGED, changed);
    return () => { stop(); controller.abort(); latestRead.current++; window.removeEventListener(MATILDA_CHANGED, changed); setEarlier(null); setShownEarlier(EARLIER_STEP); };
  }, [open, read, rememberEarlier]);
  // Ask again every second while she replies. A failed or superseded read must not end the asking (28 Oct: her reply had
  // arrived, and the small chat still said "Matilda is replying…" minutes later).
  useEffect(() => {
    if (!open || !conversation.busy || posting) return;
    const controller = new AbortController(), timer = setInterval(() => void read(controller.signal), 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [open, conversation.busy, posting, read]);
  async function send() {
    const sent = draft.trim();
    if (!sent || sending.current || conversation.busy) return;
    sending.current = true; streamedWhileSending.current = null; setPosting(true); setError(""); latestRead.current++;
    try {
      const response = received(await api<Conversation>("/love-spot/talk", { text: sent, persona: savedPersona() }));
      if (!mounted.current) return;
      const responseTurn = response.entries.at(-1)?.turnId;
      const streamed = streamedWhileSending.current as Conversation | null;
      const result = responseTurn && streamed?.entries.some(entry => entry.turnId === responseTurn && entry.item.type === "agentMessage") ? streamed : response;
      if (openRef.current) rememberEarlier(result, responseTurn);
      setConversation(result); setDraft(current => current.trim() === sent ? "" : current); setError(result.error || "");
      window.dispatchEvent(new Event(MATILDA_CHANGED));
      // A scripted or cached model can complete before the POST snapshot catches its final entry and before the live
      // stream finishes connecting. Reconcile that finished turn briefly; slow turns stay on the live stream.
      const turnId = responseTurn;
      if (!result.busy && turnId && !result.entries.some(entry => entry.turnId === turnId && entry.item.type === "agentMessage")) void (async () => {
        for (const delay of [50, 75, 125, 250, 500]) {
          await new Promise(resolve => setTimeout(resolve, delay));
          if (!mounted.current) return;
          const current = await read();
          if (current?.entries.some(entry => entry.turnId === turnId && entry.item.type === "agentMessage")) return;
        }
      })();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Message not sent. Try again."); }
    finally { sending.current = false; if (mounted.current) setPosting(false); }
  }
  return { draft, setDraft, conversation, error, posting, send, retry: read, earlier, shownEarlier, showMoreEarlier: () => setShownEarlier(count => count + EARLIER_STEP) };
}

function message(entry: Entry) {
  if (entry.item.type === "agentMessage") return typeof entry.item.text === "string" ? entry.item.text : "";
  if (entry.item.type !== "userMessage" || !Array.isArray(entry.item.content)) return "";
  return entry.item.content.filter(part => part && typeof part === "object" && part.type === "text" && !attachedFile(part)).map(part => part.text).join("\n");
}

export function MatildaMiniChat({ chat }: { chat: ReturnType<typeof useMatildaMiniChat> }) {
  const shared = useMatildaSettings(), off = shared.settings?.replies === false;
  const log = useRef<HTMLDivElement>(null), fromBottom = useRef<number | null>(null);
  // Revealing earlier messages keeps what he is reading where it is.
  const reveal = () => { if (log.current) fromBottom.current = log.current.scrollHeight - log.current.scrollTop; chat.showMoreEarlier(); };
  useLayoutEffect(() => {
    if (log.current && fromBottom.current !== null) log.current.scrollTop = log.current.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [chat.shownEarlier]);
  const said = chat.conversation.entries.filter(entry => message(entry).trim());
  const before = chat.earlier ? said.filter(entry => chat.earlier!.has(entry.turnId)) : said;
  const entries = [...before.slice(-chat.shownEarlier), ...said.filter(entry => !before.includes(entry))];
  const moreEarlier = before.length > chat.shownEarlier;
  // The newest message is in view whenever one arrives, grows or the earlier ones open (29 Oct: they opened at the oldest,
  // her answers below the fold); asking again while she replies changes nothing, so it never moves what he scrolled to.
  const last = entries.at(-1), newest = last ? `${last.turnId}:${last.item.id}:${message(last).length}` : "";
  useLayoutEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [newest]);
  return <div className="matilda-mini-chat" role="dialog" aria-label="Small chat with Matilda">
    {!!entries.length && <div ref={log} className="matilda-mini-messages" role="log" aria-label="Matilda conversation" aria-live="polite" aria-relevant="additions text">
      {moreEarlier && <LoadOnScroll label="Loading earlier messages" onLoad={reveal} />}
      {entries.map(entry => <div key={`${entry.turnId}:${entry.item.id}`} className="matilda-mini-message flow-root" data-speaker={entry.item.type === "userMessage" ? "you" : "matilda"}>
        {entry.item.type === "agentMessage" && <MatildaFace expression={typeof entry.item.portrait === "string" ? entry.item.portrait : undefined} size={32} className="float-left mr-2" />}
        <span className="sr-only">{entry.item.type === "userMessage" ? "You" : "Matilda"}: </span><MarkdownText text={entry.item.type === "agentMessage" ? replyPortrait(message(entry)).text : message(entry)} allowImages={false} />
      </div>)}
    </div>}
    {(chat.posting || chat.conversation.busy) && <p className="matilda-mini-status" role="status">Matilda is replying…</p>}
    {chat.error && <div className="matilda-mini-error" role="alert"><span>{chat.error}</span><Button variant="ghost" size="xs" onClick={() => void chat.retry()}>Retry</Button></div>}
    <div className="matilda-mini-bar"><MatildaSwitch settings={shared.settings} onChange={on => void shared.update({ replies: on })} /></div>
    <form aria-label="Message Matilda" className="matilda-mini-composer" onSubmit={event => { event.preventDefault(); void chat.send(); }}>
      <Textarea aria-label="Message Matilda" placeholder={off ? "Matilda is off" : "Message Matilda…"} disabled={off} rows={1} autoFocus value={chat.draft} onChange={event => chat.setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="Send to Matilda" title="Send to Matilda" disabled={!chat.draft.trim() || chat.posting || chat.conversation.busy}><SendIcon size={18} /></Button>
    </form>
  </div>;
}

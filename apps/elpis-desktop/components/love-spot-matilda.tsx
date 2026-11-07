"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { PROTOCOL, keepPersona, savedPersona } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";
import { errorText } from "@/lib/error-text.mts";

/** How long the board stays quiet before she looks at what was written or drawn (ms). */
const QUIET = 300;
const RETRY = 250;
type Handover = { done: Promise<void>; finish: () => void; touched: Set<string>; cancelled: boolean };
// A new visit to the same page waits for the previous visit's handover to settle.
const handovers = new Map<string, Handover>();
function startHandover(context: string | undefined) {
  let finish = () => {};
  const handover: Handover = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), touched: new Set(), cancelled: false };
  if (context) handovers.set(context, handover);
  return handover;
}
function finishHandover(context: string | undefined, handover: Handover) {
  if (context && handovers.get(context) === handover) handovers.delete(context);
  handover.finish();
}
// Notes still waiting for her, per board page, outlive the board: leaving Love Spot unmounts it (27 Oct: a note written
// just before leaving was never answered).
const PENDING = "elpis-matilda-pending-v1";
function pendingNotes(): Record<string, string[]> {
  try { const value = JSON.parse(appStorage().getItem(PENDING) || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
function keepPending(context: string | undefined, ids: ReadonlySet<string>) {
  if (!context) return;
  try { const all = pendingNotes(); if (ids.size) all[context] = [...ids]; else delete all[context]; appStorage().setItem(PENDING, JSON.stringify(all)); } catch { /* kept for this visit only */ }
}
function addPending(context: string | undefined, ids: ReadonlySet<string>) {
  if (context) keepPending(context, new Set([...(pendingNotes()[context] ?? []), ...ids]));
}
function removePending(context: string | undefined, ids: ReadonlySet<string>) {
  if (context) keepPending(context, new Set((pendingNotes()[context] ?? []).filter(id => !ids.has(id))));
}

/** Matilda reads the board once it has been quiet for a moment, then answers on it; the bridge places the reply (bridge/love-spot-talk.mts). */
export function useMatilda({ ready, enabled, context, told, drawingOnly, send, onError }: {
  ready: () => boolean; /** Replies on: off means nothing is sent, not even on leaving the board. */ enabled: () => boolean; context?: string; told: (ids: ReadonlySet<string>) => string; drawingOnly: (ids: ReadonlySet<string>) => boolean; send: (text: string, persona: string, isCurrent: () => boolean, drawingOnly: boolean) => Promise<"sent" | "wait" | "stale">; onError: (message: string) => void;
}) {
  const [persona, setPersona] = useState(savedPersona), [replying, setReplying] = useState(false);
  const latest = useRef({ ready, enabled, context, told, drawingOnly, send, onError, persona });
  latest.current = { ready, enabled, context, told, drawingOnly, send, onError, persona };
  const ids = useRef(new Set<string>()), timer = useRef<ReturnType<typeof setTimeout>>(undefined), busy = useRef(false), working = useRef(false);
  const said = useRef<string | null>(null), asking = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false), poll = useRef(0), generation = useRef(0), held = useRef(false);
  // What she would be told now; the editor is already gone when the board unmounts.
  const waiting = useRef(""), waitingDrawingOnly = useRef(false);
  useEffect(() => { generation.current++; ids.current.clear(); held.current = false; clearTimeout(timer.current); }, [context]);
  /** Fallback when the shared live conversation stream disconnects. */
  const ask = useCallback(async () => {
    if (!mounted.current) return;
    clearTimeout(asking.current);
    const request = ++poll.current;
    try {
      const state = await api<{ busy?: boolean; error?: string }>("/love-spot/talk");
      if (!mounted.current || request !== poll.current) return;
      busy.current = !!state.busy; setReplying(busy.current);
      // An error left from an earlier visit is not news.
      if (said.current !== null && state.error && state.error !== said.current) latest.current.onError(state.error);
      said.current = state.error ?? "";
      if (busy.current) asking.current = setTimeout(ask, RETRY);
    } catch { if (mounted.current && request === poll.current) asking.current = setTimeout(ask, RETRY); }
  }, []);
  const look = useCallback(async () => {
    if (!mounted.current || !ids.current.size) return;
    const now = latest.current;
    const previous = now.context ? handovers.get(now.context) : undefined;
    if (previous) {
      void previous.done.then(() => {
        if (!mounted.current || now.context !== latest.current.context) return;
        ids.current = new Set(now.context ? pendingNotes()[now.context] ?? [] : []);
        held.current = false;
        if (ids.current.size) { clearTimeout(timer.current); timer.current = setTimeout(() => void look(), QUIET); }
      });
      return;
    }
    if (!now.ready()) { timer.current = setTimeout(look, QUIET); return; }
    if (busy.current || working.current) { timer.current = setTimeout(look, RETRY); return; }
    const batch = ids.current, token = generation.current;
    const text = now.told(batch), onlyDrawing = now.drawingOnly(batch); ids.current = new Set(); waiting.current = "";
    if (!text) { keepPending(now.context, ids.current); return; }
    const handover = startHandover(now.context);
    const acknowledge = () => {
      const done = new Set([...batch].filter(id => !handover.touched.has(id)));
      removePending(now.context, done);
      if (now.context === latest.current.context) for (const id of done) ids.current.delete(id);
    };
    const isCurrent = () => mounted.current && token === generation.current && now.context === latest.current.context && latest.current.ready();
    const hold = () => {
      if (!now.enabled() || handover.cancelled) return;
      if (now.context === latest.current.context) { for (const id of batch) ids.current.add(id); held.current = generation.current === token; }
      else addPending(now.context, batch);
    };
    working.current = true; said.current = "";
    try {
      const result = await now.send(text, now.persona.trim() || PROTOCOL, isCurrent, onlyDrawing);
      if (result === "sent") { acknowledge(); void ask(); }
      else if (result === "wait") hold();
      // Left while she was being told (the board's send gives up once it unmounts): send it as leaving does, or it is lost
      // (5 Nov: on a slower machine a note written just before leaving never reached her).
      else if (!mounted.current && now.enabled()) {
        const reply = await api<{ waitingForPicture?: boolean }>("/love-spot/talk", { text, persona: now.persona.trim() || PROTOCOL, drawingOnly: onlyDrawing, ...(now.context ? { pageSession: now.context } : {}) });
        if (reply.waitingForPicture) hold();
        else acknowledge();
      }
      else if (mounted.current && now.enabled() && now.context === latest.current.context) for (const id of batch) ids.current.add(id);
      else hold();
    }
    catch (cause) { hold(); if (mounted.current) now.onError(errorText(cause, "Matilda could not answer.")); }
    finally {
      working.current = false;
      if (now.context === latest.current.context) { if (mounted.current) keepPending(now.context, ids.current); else addPending(now.context, ids.current); }
      finishHandover(now.context, handover);
      if (mounted.current && ids.current.size && !held.current) { clearTimeout(timer.current); timer.current = setTimeout(look, latest.current.ready() ? 0 : QUIET); }
    }
  }, [ask]);
  const notice = useCallback((found: string[], finished = false) => {
    generation.current++;
    held.current = false;
    const current = latest.current.context ? handovers.get(latest.current.context) : undefined;
    if (current) for (const id of found) current.touched.add(id);
    for (const id of found) ids.current.add(id);
    keepPending(latest.current.context, ids.current);
    try { waiting.current = ids.current.size ? latest.current.told(ids.current) : ""; waitingDrawingOnly.current = !!ids.current.size && latest.current.drawingOnly(ids.current); } catch { /* told again when she looks */ }
    clearTimeout(timer.current);
    if (ids.current.size) timer.current = setTimeout(look, finished ? 0 : QUIET);
  }, [look]);
  const wake = useCallback(() => {
    generation.current++;
    if (!held.current) return;
    held.current = false;
    if (mounted.current && ids.current.size) { clearTimeout(timer.current); timer.current = setTimeout(() => void look(), QUIET); }
  }, [look]);
  // A page's waiting notes come back when it is shown again.
  useEffect(() => {
    for (const id of context ? pendingNotes()[context] ?? [] : []) ids.current.add(id);
    if (ids.current.size) { clearTimeout(timer.current); timer.current = setTimeout(look, QUIET); }
  }, [context, look]);
  useEffect(() => {
    mounted.current = true; ask();
    return () => {
      mounted.current = false; poll.current++; clearTimeout(timer.current); clearTimeout(asking.current);
      // Leaving the board sends what she has not been told yet; if she is still writing, it waits for the next visit.
      const now = latest.current, batch = new Set(ids.current);
      if (!now.enabled()) { keepPending(now.context, new Set()); return; }
      if (!batch.size || busy.current || working.current) return;
      if (held.current) { keepPending(now.context, batch); return; }
      if (now.context && handovers.has(now.context)) { addPending(now.context, batch); return; }
      let text = "", onlyDrawing = false; try { text = now.told(batch); onlyDrawing = now.drawingOnly(batch); } catch { /* the editor is gone */ }
      if (!text) { text = waiting.current; onlyDrawing = waitingDrawingOnly.current; }
      if (!text) return;
      const handover = startHandover(now.context);
      void api<{ waitingForPicture?: boolean }>("/love-spot/talk", { text, persona: now.persona.trim() || PROTOCOL, drawingOnly: onlyDrawing, ...(now.context ? { pageSession: now.context } : {}) })
        .then(reply => {
          if (reply.waitingForPicture) { if (now.enabled() && !handover.cancelled) addPending(now.context, batch); }
          else removePending(now.context, new Set([...batch].filter(id => !handover.touched.has(id))));
        }).catch(() => { if (now.enabled() && !handover.cancelled) addPending(now.context, batch); })
        .finally(() => finishHandover(now.context, handover));
    };
  }, [ask]);
  /** Replies off (Masih, 31 Oct: "I disabled her replies yet she still was thinking"): forget what was waiting and stop the reply she is writing. */
  const quiet = useCallback(async () => {
    generation.current++; ids.current.clear(); waiting.current = ""; held.current = false; clearTimeout(timer.current);
    const handover = latest.current.context ? handovers.get(latest.current.context) : undefined;
    if (handover) handover.cancelled = true;
    keepPending(latest.current.context, new Set());
    try { await api("/love-spot/talk/stop", {}); } catch (cause) { latest.current.onError(errorText(cause, "Matilda could not be stopped.")); }
  }, []);
  return { persona, keep: (value: string) => { setPersona(value); keepPersona(value); }, replying, notice, wake, quiet };
}

/** Who Matilda is: the person writes her the protocol she works by; it goes with everything she is told. Her model is on the Love Spot bar. */
export function MatildaWho({ open, onOpenChange, persona, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; persona: string; onSave: (persona: string) => void;
}) {
  const [draft, setDraft] = useState(persona);
  useEffect(() => { if (open) setDraft(persona); }, [open, persona]);
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent role="dialog">
      <AlertDialogHeader><AlertDialogTitle>Who Matilda is</AlertDialogTitle><AlertDialogDescription>She follows this protocol in everything she answers. Write her the method of any profession you like.</AlertDialogDescription></AlertDialogHeader>
      <Textarea aria-label="Who Matilda is" rows={8} value={draft} onChange={event => setDraft(event.target.value)} autoFocus />
      <AlertDialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="outline" disabled={draft === PROTOCOL} onClick={() => setDraft(PROTOCOL)}>Back to her usual way</Button>
        <Button disabled={!draft.trim()} onClick={() => { onSave(draft); onOpenChange(false); }}>Save</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

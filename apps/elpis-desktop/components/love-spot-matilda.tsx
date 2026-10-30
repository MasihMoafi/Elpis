"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { PROTOCOL, keepPersona, savedPersona } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";

/** How long the board stays quiet before she looks at what was written or drawn (ms). */
const QUIET = 300;
const RETRY = 250;
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

/** Matilda reads the board once it has been quiet for a moment, then answers on it; the bridge places the reply (bridge/love-spot-talk.mjs). */
export function useMatilda({ ready, context, told, send, onError }: {
  ready: () => boolean; context?: string; told: (ids: ReadonlySet<string>) => string; send: (text: string, persona: string, isCurrent: () => boolean) => Promise<boolean>; onError: (message: string) => void;
}) {
  const [persona, setPersona] = useState(savedPersona), [replying, setReplying] = useState(false);
  const latest = useRef({ ready, context, told, send, onError, persona });
  latest.current = { ready, context, told, send, onError, persona };
  const ids = useRef(new Set<string>()), timer = useRef<ReturnType<typeof setTimeout>>(undefined), busy = useRef(false), working = useRef(false);
  const said = useRef<string | null>(null), asking = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(false), poll = useRef(0), generation = useRef(0);
  // What she would be told now; the editor is already gone when the board unmounts.
  const waiting = useRef("");
  useEffect(() => { generation.current++; ids.current.clear(); clearTimeout(timer.current); }, [context]);
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
    if (!now.ready()) { timer.current = setTimeout(look, QUIET); return; }
    if (busy.current || working.current) { timer.current = setTimeout(look, RETRY); return; }
    const batch = ids.current, token = generation.current;
    const text = now.told(batch); ids.current = new Set(); waiting.current = "";
    if (!text) { keepPending(now.context, ids.current); return; }
    const isCurrent = () => mounted.current && token === generation.current && now.context === latest.current.context && latest.current.ready();
    working.current = true; said.current = "";
    try {
      if (await now.send(text, now.persona.trim() || PROTOCOL, isCurrent)) ask();
      else if (mounted.current && now.context === latest.current.context) for (const id of batch) ids.current.add(id);
    }
    catch (cause) { if (mounted.current) now.onError(cause instanceof Error ? cause.message : "Matilda could not answer."); }
    finally {
      working.current = false;
      if (now.context === latest.current.context) keepPending(now.context, ids.current);
      if (mounted.current && ids.current.size) { clearTimeout(timer.current); timer.current = setTimeout(look, latest.current.ready() ? 0 : QUIET); }
    }
  }, [ask]);
  const notice = useCallback((found: string[], finished = false) => {
    generation.current++;
    for (const id of found) ids.current.add(id);
    keepPending(latest.current.context, ids.current);
    try { waiting.current = ids.current.size ? latest.current.told(ids.current) : ""; } catch { /* told again when she looks */ }
    clearTimeout(timer.current);
    if (ids.current.size) timer.current = setTimeout(look, finished ? 0 : QUIET);
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
      if (!batch.size || busy.current || working.current) return;
      let text = ""; try { text = now.told(batch); } catch { /* the editor is gone */ }
      text ||= waiting.current;
      if (!text) return;
      keepPending(now.context, new Set());
      void api("/love-spot/talk", { text, persona: now.persona.trim() || PROTOCOL }).catch(() => keepPending(now.context, batch));
    };
  }, [ask]);
  return { persona, keep: (value: string) => { setPersona(value); keepPersona(value); }, replying, notice };
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

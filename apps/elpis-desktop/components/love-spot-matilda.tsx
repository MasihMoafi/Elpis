"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { PROTOCOL, keepPersona, savedPersona } from "@/lib/matilda";

/** How long the board stays quiet before she looks at what was written or drawn (ms). */
const QUIET = 4000;

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
  useEffect(() => { generation.current++; ids.current.clear(); clearTimeout(timer.current); }, [context]);
  /** Asks the bridge whether she is still writing, once a second while she is: no stream stays open, because each window's streams share the browser's six connections. */
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
      if (busy.current) asking.current = setTimeout(ask, 1000);
    } catch { if (mounted.current && request === poll.current) asking.current = setTimeout(ask, 1000); }
  }, []);
  const look = useCallback(async () => {
    if (!mounted.current || !ids.current.size) return;
    const now = latest.current;
    if (!now.ready() || busy.current || working.current) { timer.current = setTimeout(look, QUIET); return; }
    const batch = ids.current, token = generation.current;
    const text = now.told(batch); ids.current = new Set();
    if (!text) return;
    const isCurrent = () => mounted.current && token === generation.current && now.context === latest.current.context && latest.current.ready();
    working.current = true; said.current = "";
    try {
      if (await now.send(text, now.persona.trim() || PROTOCOL, isCurrent)) ask();
      else if (mounted.current && now.context === latest.current.context) for (const id of batch) ids.current.add(id);
    }
    catch (cause) { if (mounted.current) now.onError(cause instanceof Error ? cause.message : "Matilda could not answer."); }
    finally {
      working.current = false;
      if (mounted.current && ids.current.size) { clearTimeout(timer.current); timer.current = setTimeout(look, QUIET); }
    }
  }, [ask]);
  const notice = useCallback((found: string[]) => {
    generation.current++;
    for (const id of found) ids.current.add(id);
    clearTimeout(timer.current);
    if (ids.current.size) timer.current = setTimeout(look, QUIET);
  }, [look]);
  useEffect(() => { mounted.current = true; ask(); return () => { mounted.current = false; poll.current++; clearTimeout(timer.current); clearTimeout(asking.current); }; }, [ask]);
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

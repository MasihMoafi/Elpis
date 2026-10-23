"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { PARTNER, keepPersona, savedPersona } from "@/lib/matilda";

/** How long the board stays quiet before she looks at what was written or drawn (ms). */
const QUIET = 4000;

/** Matilda reads the board once it has been quiet for a moment, then answers on it; the bridge places the reply (bridge/love-spot-talk.mjs). */
export function useMatilda({ ready, writing, told, send, onError }: {
  ready: boolean; writing: () => boolean; told: (ids: ReadonlySet<string>) => string; send: (text: string, persona: string) => Promise<void>; onError: (message: string) => void;
}) {
  const [persona, setPersona] = useState(savedPersona), [replying, setReplying] = useState(false);
  const latest = useRef({ ready, writing, told, send, onError, persona });
  latest.current = { ready, writing, told, send, onError, persona };
  const ids = useRef(new Set<string>()), timer = useRef<ReturnType<typeof setTimeout>>(undefined), busy = useRef(false), working = useRef(false);
  const look = useCallback(async () => {
    if (!ids.current.size) return;
    const now = latest.current;
    if (!now.ready || now.writing() || busy.current || working.current) { timer.current = setTimeout(look, QUIET); return; }
    const text = now.told(ids.current); ids.current = new Set();
    if (!text) return;
    working.current = true;
    try { await now.send(text, now.persona.trim() || PARTNER); }
    catch (cause) { now.onError(cause instanceof Error ? cause.message : "Matilda could not answer."); }
    finally { working.current = false; }
  }, []);
  const notice = useCallback((found: string[]) => {
    if (!found.length) return;
    for (const id of found) ids.current.add(id);
    clearTimeout(timer.current); timer.current = setTimeout(look, QUIET);
  }, [look]);
  useEffect(() => {
    let first = true, said = "";
    const events = new EventSource("/api/love-spot/talk/events");
    events.onmessage = event => {
      try {
        const state: { busy?: boolean; error?: string } = JSON.parse(event.data);
        busy.current = !!state.busy; setReplying(busy.current);
        // An error left from an earlier visit is not news.
        if (!first && state.error && state.error !== said) latest.current.onError(state.error);
        said = state.error ?? ""; first = false;
      } catch { /* The next message carries the whole state. */ }
    };
    return () => { events.close(); clearTimeout(timer.current); };
  }, []);
  return { persona, keep: (value: string) => { setPersona(value); keepPersona(value); }, replying, notice };
}

/** Who Matilda is: the person writes her into whoever they like; it goes with everything she is told. */
export function MatildaWho({ open, onOpenChange, persona, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; persona: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(persona);
  useEffect(() => { if (open) setDraft(persona); }, [open, persona]);
  return <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent role="dialog">
      <AlertDialogHeader><AlertDialogTitle>Who Matilda is</AlertDialogTitle><AlertDialogDescription>She follows this in everything she answers. Write her into whoever you like.</AlertDialogDescription></AlertDialogHeader>
      <Textarea aria-label="Who Matilda is" rows={8} value={draft} onChange={event => setDraft(event.target.value)} autoFocus />
      <AlertDialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="outline" disabled={draft === PARTNER} onClick={() => setDraft(PARTNER)}>Back to her usual self</Button>
        <Button disabled={!draft.trim()} onClick={() => { onSave(draft); onOpenChange(false); }}>Save</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

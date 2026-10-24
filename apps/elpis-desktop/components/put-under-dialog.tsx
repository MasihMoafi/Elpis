"use client";
import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { title, type Thread } from "@/lib/api";

export function PutUnderDialog({ chats, candidates, onPutUnder, onClose }: {
  chats: Thread[] | null; candidates: Thread[]; onPutUnder: (parent: string) => Promise<void>; onClose: () => void;
}) {
  const [parent, setParent] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setParent(""); setError(""); }, [chats]);
  const valid = candidates.some(chat => chat.id === parent);
  async function save() {
    setBusy(true); setError("");
    try { await onPutUnder(parent); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <AlertDialog open={!!chats} onOpenChange={open => { if (!open && !busy) onClose(); }}><AlertDialogContent>
    <AlertDialogHeader><AlertDialogTitle>Put chats under a chat</AlertDialogTitle><AlertDialogDescription>{chats?.length === 1 ? title(chats[0]) : `${chats?.length ?? 0} chats`} will appear under the chosen chat. Take out returns them to the list.</AlertDialogDescription></AlertDialogHeader>
    <label className="field">Parent chat<OptionSelect aria-label="Parent chat" value={parent} onChange={event => setParent(event.target.value)} disabled={busy}>
      <option value="" disabled>Choose a chat</option>{candidates.map(chat => <option key={chat.id} value={chat.id}>{title(chat)}</option>)}
    </OptionSelect></label>
    {!candidates.length && <p className="text-sm text-muted-foreground">No other top-level chat is available. Take out this chat’s nested chats first.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !valid} disabledReason={busy ? "Saving chat placement…" : "Choose a parent chat."} onClick={() => void save()}>Put under</Button></AlertDialogFooter>
  </AlertDialogContent></AlertDialog>;
}

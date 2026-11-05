"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { readPreferences, savePreferences } from "@/lib/preferences";

/** One confirmation and preference for named deletions. A failed automatic delete opens the dialog for retry. */
export function ConfirmDelete<T>({ request, names, noun, description, onDelete, onClose, alwaysConfirm, finalFocus, children }: {
  request: T | null; names: string[]; noun: string; description: ReactNode; onDelete: (request: T) => Promise<void>; onClose: () => void;
  alwaysConfirm?: boolean; finalFocus?: () => HTMLElement | null | undefined; children?: ReactNode;
}) {
  const [opened, setOpened] = useState<T | null>(null), [confirm, setConfirm] = useState(true), [skip, setSkip] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const removing = useRef(false);
  if (opened !== request) { setOpened(request); setConfirm(request !== null ? !!alwaysConfirm || readPreferences().confirmDeleteChats : true); setSkip(false); setError(""); }
  useEffect(() => { if (request !== null && !confirm) void remove(); }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  async function remove() {
    if (request === null || removing.current) return;
    removing.current = true; setBusy(true); setError("");
    try {
      if (skip) savePreferences({ confirmDeleteChats: false });
      await onDelete(request); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { removing.current = false; setBusy(false); }
  }
  return <AlertDialog open={request !== null && (confirm || !!error)} onOpenChange={value => { if (!busy && !value) onClose(); }}>
    <AlertDialogContent finalFocus={finalFocus}>
      <AlertDialogHeader>
        <AlertDialogTitle>{names.length === 1 ? `Delete “${names[0]}”?` : `Delete ${names.length} ${noun}s?`}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      {confirm && !alwaysConfirm && <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" className="accent-primary" checked={skip} disabled={busy} onChange={event => setSkip(event.target.checked)} />Don’t show me this again</label>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

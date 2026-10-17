"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** "Rewind to here" discards turns, so it asks first: `turns` is how many go (that turn and every later one), null when
 * nothing is being asked. A failure stays in the dialog as Elpis reported it. */
export function RewindDialog({ turns, onConfirm, onClose }: { turns: number | null; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function rewind() {
    setBusy(true); setError("");
    try { await onConfirm(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <AlertDialog open={turns !== null} onOpenChange={value => { if (!busy && !value) { setError(""); onClose(); } }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Rewind to here?</AlertDialogTitle>
        <AlertDialogDescription>
          This message and everything after it ({turns === 1 ? "1 turn" : `${turns ?? 0} turns`}) are removed from the chat. This cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button type="button" variant="outline" autoFocus disabled={busy} />}>Cancel</AlertDialogClose>
        <Button type="button" variant="destructive" disabled={busy} onClick={() => void rewind()}>{busy ? "Rewinding…" : "Rewind"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

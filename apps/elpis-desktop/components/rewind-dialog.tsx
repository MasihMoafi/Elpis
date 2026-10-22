"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { ChangeCounts } from "@/components/change-counts";

export type RestoreMode = "both" | "conversation" | "code";
type Preview = { available: boolean; reason?: string; version?: string; files?: string[]; added?: number; removed?: number; diff?: string; truncated?: boolean };

/** Restore to before a message. A failure stays in the dialog; historical messages without snapshots remain rewindable. */
export function RewindDialog({ threadId, turnId, prompt, turns, onConfirm, onClose }: { threadId?: string; turnId: string | null; prompt: string; turns: number | null; onConfirm: (mode: RestoreMode, version?: string) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState<RestoreMode>("both"), [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!turnId || !threadId) return;
    let disposed = false; setPreview(null); setMode("both"); setError("");
    api<Preview>(`/threads/${encodeURIComponent(threadId)}/rewind`, { action: "preview", beforeTurnId: turnId }).then(value => {
      if (disposed) return;
      setPreview(value); if (!value.available) setMode("conversation");
    }).catch(cause => { if (!disposed) { setPreview({ available: false, reason: cause instanceof Error ? cause.message : String(cause) }); setMode("conversation"); } });
    return () => { disposed = true; };
  }, [threadId, turnId]);
  async function rewind() {
    setBusy(true); setError("");
    try { await onConfirm(mode, mode === "conversation" ? undefined : preview?.version); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <AlertDialog open={turns !== null} onOpenChange={value => { if (!busy && !value) { setError(""); onClose(); } }}>
    <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle>Rewind to this message?</AlertDialogTitle>
        <AlertDialogDescription>
          Restore to before this message ({turns === 1 ? "1 turn" : `${turns ?? 0} turns`} ago).
        </AlertDialogDescription>
      </AlertDialogHeader>
      {prompt && <p className="max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm" dir="auto">{prompt.trim().slice(0, 600)}</p>}
      <div className="grid gap-1.5 text-sm"><span>Restore</span>
        <Select value={mode} disabled={busy || !preview} onValueChange={value => { if (value) setMode(value as RestoreMode); }}>
          <SelectTrigger aria-label="Restore" className="w-full"><SelectValue>{mode === "both" ? "Code and conversation" : mode === "code" ? "Code only" : "Conversation only"}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="both" disabled={!preview?.available}>Code and conversation</SelectItem><SelectItem value="conversation">Conversation only</SelectItem><SelectItem value="code" disabled={!preview?.available}>Code only</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="grid min-w-0 gap-2 text-sm text-muted-foreground" aria-live="polite">
        {!preview ? <p>Checking for file changes…</p> : !preview.available ? <p>{preview.reason || "No file checkpoint for this message."}</p> : mode !== "conversation" && <>
          <p>{preview.files?.length ?? 0} {preview.files?.length === 1 ? "file" : "files"} · <ChangeCounts added={preview.added ?? 0} removed={preview.removed ?? 0} /></p>
          {preview.diff && <details className="min-w-0"><DisclosureSummary className="cursor-pointer">View changes</DisclosureSummary><pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background p-2 text-xs leading-relaxed">{preview.diff.split("\n").map((line, index) => <span key={index} className={`block ${line.startsWith("+") && !line.startsWith("+++") ? "text-[var(--success)]" : line.startsWith("-") && !line.startsWith("---") ? "text-destructive" : ""}`}>{line || " "}</span>)}</pre>{preview.truncated && <p>Showing the first part of the diff.</p>}</details>}
          <p>Commits stay in place.</p>
        </>}
        {mode !== "code" && <p>Undo rewind brings back the messages. Your files stay as they are. Undo works until you send your next message.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button type="button" variant="outline" autoFocus disabled={busy} />}>Cancel</AlertDialogClose>
        <Button type="button" variant="destructive" disabled={busy || !preview} disabledReason={busy ? "Rewinding the conversation…" : error || "A rewind preview is required. Wait for it to load, or close and try again."} onClick={() => void rewind()}>{busy ? "Rewinding…" : "Rewind"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

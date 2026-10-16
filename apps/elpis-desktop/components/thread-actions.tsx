"use client";

import { useState } from "react";
import { Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isAgent, title, type Thread } from "@/lib/api";

type Action = "rename" | "delete" | null;
type Props = {
  thread: Thread;
  onDelete: (thread: Thread) => Promise<void>;
  onRename?: (thread: Thread, name: string) => Promise<void>;
  /** Reports its own failures; the menu closes immediately. */
  onArchive?: (thread: Thread) => Promise<void>;
};

/** Row menu: Rename, Archive and Delete, each through Elpis. Failures are shown as Elpis reported them. */
export function ThreadActions({ thread, onDelete, onRename, onArchive }: Props) {
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = title(thread);
  const open = (next: Action) => { setError(""); setName(thread.name?.trim() || current); setAction(next); };
  async function run(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); setAction(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="thread-actions" aria-label={`Actions for ${current}`} title="Rename, archive or delete" />}>
        <MoreHorizontal size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {onRename && <DropdownMenuItem onClick={() => open("rename")}><Pencil size={14} />Rename</DropdownMenuItem>}
        {onArchive && <DropdownMenuItem onClick={() => void onArchive(thread)}><Archive size={14} />Archive</DropdownMenuItem>}
        <DropdownMenuItem variant="destructive" onClick={() => open("delete")}><Trash2 size={14} />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={action === "rename"} onOpenChange={value => { if (!busy && !value) setAction(null); }}>
      <AlertDialogContent>
        <form aria-label="Rename conversation" onSubmit={event => { event.preventDefault(); if (name.trim() && onRename) void run(() => onRename(thread, name.trim())); }}>
          <AlertDialogTitle>Rename conversation</AlertDialogTitle>
          <AlertDialogDescription>The new name is saved in Elpis and shown in every client.</AlertDialogDescription>
          <Input className="my-4" aria-label="Conversation name" maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus />
          {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={action === "delete"} onOpenChange={value => { if (!busy && !value) setAction(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete “{current}”?</AlertDialogTitle>
        <AlertDialogDescription>
          {isAgent(thread) ? "This permanently deletes this agent's chat from Elpis." : "This permanently deletes the conversation and all of its agents from Elpis."} Chats continued from these agents are deleted too. This cannot be undone.
        </AlertDialogDescription>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => run(() => onDelete(thread))}>{busy ? "Deleting…" : "Delete"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

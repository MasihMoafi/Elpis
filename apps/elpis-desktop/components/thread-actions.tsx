"use client";

import { useEffect, useRef, useState } from "react";
import { AgentsIcon, ArchiveIcon, PinIcon } from "@/components/elpis-icons";
import { MoreHorizontal, Pencil, PinOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { readPreferences, savePreferences } from "@/lib/preferences";
import { isAgent, title, type Thread } from "@/lib/api";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

type Props = {
  thread: Thread;
  /** Deletes after this menu's own confirmation. */
  onDelete?: (thread: Thread) => Promise<void>;
  /** Hands Delete to the sidebar's shared confirmation instead, which also covers several selected chats. */
  onRequestDelete?: (thread: Thread) => void;
  onRename?: (thread: Thread, name: string) => Promise<void>;
  /** Reports its own failures; the menu closes immediately. */
  onArchive?: (thread: Thread) => Promise<void>;
  pinned?: boolean;
  onPin?: (thread: Thread) => void;
  /** The sidebar's list of this chat's agents, under its row. */
  agents?: { shown: boolean; onToggle: () => void };
  /** Set by the rename shortcut; the rename dialog opens once. */
  renameRequested?: boolean;
  onRenameRequestHandled?: () => void;
  /** The trigger's name; the header's copy is "Chat actions", as in the ChatGPT app. */
  label?: string;
};

/** Row menu: Rename, Pin, Archive and Delete, each through Elpis. Failures are shown as Elpis reported them. */
export function ThreadActions({ thread, onDelete, onRequestDelete, onRename, onArchive, pinned, onPin, agents, renameRequested, onRenameRequestHandled, label }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<Thread[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = title(thread);
  const rename = () => { setError(""); setName(thread.name?.trim() || current); setRenaming(true); };
  useEffect(() => {
    if (!renameRequested || !onRename) return;
    rename();
    onRenameRequestHandled?.();
  }, [renameRequested]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(value: string) {
    if (!onRename) return;
    setBusy(true); setError("");
    try { await onRename(thread, value); setRenaming(false); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="thread-actions" aria-label={label ?? `Actions for ${current}`} title="Rename, archive or delete" />}>
        <MoreHorizontal size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {onRename && <DropdownMenuItem onClick={rename}><Pencil size={14} />Rename</DropdownMenuItem>}
        {onPin && <DropdownMenuItem onClick={() => onPin(thread)}>{pinned ? <PinOff size={14} /> : <PinIcon size={14} />}{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>}
        {agents && <DropdownMenuItem onClick={agents.onToggle}><AgentsIcon size={14} />{agents.shown ? "Hide agents" : "Show agents"}</DropdownMenuItem>}
        {onArchive && <DropdownMenuItem onClick={() => void onArchive(thread)}><ArchiveIcon size={14} />Archive</DropdownMenuItem>}
        {(onRequestDelete || onDelete) && <DropdownMenuItem variant="destructive" onClick={() => onRequestDelete ? onRequestDelete(thread) : setDeleting([thread])}><Trash2 size={14} />Delete<kbd aria-hidden="true" className="ml-auto text-xs opacity-70">D</kbd></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={renaming} onOpenChange={value => { if (!busy && !value) setRenaming(false); }}>
      <AlertDialogContent>
        <form aria-label="Rename conversation" onSubmit={event => { event.preventDefault(); if (name.trim()) void save(name.trim()); }}>
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
    {onDelete && !onRequestDelete && <DeleteChatsDialog threads={deleting} onDelete={onDelete} onClose={() => setDeleting(null)} />}
  </>;
}

/** Confirms deleting chats as one decision: one chat by name, several by count. Once confirmation is off
 * ("Don’t show me this again", Settings → General) it deletes at once and opens only to show a failure. */
export function DeleteChatsDialog({ threads, onDelete, onClose }: { threads: Thread[] | null; onDelete: (thread: Thread) => Promise<void>; onClose: () => void }) {
  const [opened, setOpened] = useState<Thread[] | null>(null), [confirm, setConfirm] = useState(true), [skip, setSkip] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const deleted = useRef(new Set<string>());
  // A new request is decided before it renders, so a turned-off confirmation never flashes open.
  if (opened !== threads) { setOpened(threads); setConfirm(threads ? readPreferences().confirmDeleteChats : true); setSkip(false); setError(""); }
  useEffect(() => { deleted.current.clear(); if (threads && !confirm) void remove(); }, [threads]); // eslint-disable-line react-hooks/exhaustive-deps
  async function remove() {
    if (!threads) return;
    setBusy(true); setError("");
    try {
      if (skip) savePreferences({ confirmDeleteChats: false });
      for (const thread of threads) {
        if (deleted.current.has(thread.id)) continue;
        try { await onDelete(thread); } catch (e) { throw Error(threads.length > 1 ? `Could not delete “${title(thread)}”: ${message(e)}` : message(e)); }
        deleted.current.add(thread.id);
      }
      onClose();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const only = threads?.length === 1 ? threads[0] : null;
  return <AlertDialog open={!!threads && (confirm || !!error)} onOpenChange={value => { if (!busy && !value) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogTitle>{only ? `Delete “${title(only)}”?` : `Delete ${threads?.length ?? 0} chats?`}</AlertDialogTitle>
      <AlertDialogDescription>
        {only ? isAgent(only) ? "This permanently deletes this agent's chat from Elpis." : "This permanently deletes the conversation and all of its agents from Elpis." : "This permanently deletes these conversations and all of their agents from Elpis."} Chats continued from these agents are deleted too. This cannot be undone.
      </AlertDialogDescription>
      {confirm && <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" className="accent-primary" checked={skip} disabled={busy} onChange={event => setSkip(event.target.checked)} />Don’t show me this again</label>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

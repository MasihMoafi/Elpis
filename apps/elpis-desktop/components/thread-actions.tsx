"use client";

import { cloneElement, useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { AgentsIcon, ArchiveIcon, PinIcon, TerminalIcon } from "@/components/elpis-icons";
import { Bookmark, BookmarkMinus, CircleCheck, Columns2, Eye, EyeOff, FolderInput, FolderPlus, Pencil, PinOff, Plus, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { MoreMenu, RightClickMenu, type MenuAction } from "@/components/action-menu";
import { readPreferences, savePreferences } from "@/lib/preferences";
import { shortcutHint } from "@/lib/shortcuts";
import { isAgent, title, type Thread } from "@/lib/api";
import type { ChatGroup } from "@/lib/chat-groups";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

type Props = {
  onMoveToProject?: (threads: Thread[]) => void;
  onNewProject?: (threads: Thread[]) => void;
  onPutUnder?: (threads: Thread[]) => void;
  onTakeOut?: (threads: Thread[]) => void;
  thread: Thread;
  /** Deletes after this menu's own confirmation. */
  onDelete?: (thread: Thread) => Promise<void>;
  /** Hands Delete to the sidebar's shared confirmation instead, which also covers several selected chats. */
  onRequestDelete?: (thread: Thread) => void;
  onRename?: (thread: Thread, name: string) => Promise<void>;
  /** Archives this chat, or the selection it belongs to; reports its own failures, and the menu closes immediately. */
  onArchive?: (threads: Thread[]) => void;
  pinned?: boolean;
  onPin?: (thread: Thread) => void;
  bookmarked?: boolean;
  onBookmark?: (thread: Thread) => void;
  /** The sidebar's list of this chat's agents, under its row. */
  agents?: { shown: boolean; onToggle: () => void };
  /** Set by the rename shortcut; the rename dialog opens once. */
  renameRequested?: boolean;
  onRenameRequestHandled?: () => void;
  /** The trigger's name; the header's copy is "Chat actions", as in the ChatGPT app. */
  label?: string;
  /** The element the chat sits in (a row, a tab): right-click anywhere on it opens the same menu as "…". */
  area: ReactElement;
  /** Draws the area's contents; `menu` is the "…" button, to place where it belongs. */
  children: (menu: ReactNode) => ReactNode;
  /** Several chats selected in the sidebar, this one among them: the menu then acts on all of them. */
  selection?: Thread[];
  /** Resumes this chat in the Elpis TUI, in its integrated terminal (desktop app only). */
  onOpenInTui?: (thread: Thread) => void;
  /** Mark as read or unread (U), as in Claude's sidebar; a plan waiting for review is marked completed instead. */
  onOpenSplit?: (thread: Thread) => void;
  onOpenWindow?: (thread: Thread) => void;
  attention?: { unread: boolean; planReady: boolean; onToggleRead: () => void; onComplete: () => void };
  /** "Move to group" (several selected: "Move N chats to group"), as in Claude's sidebar: the groups, the chat's own one
   * checked (`current`; undefined when the selected chats are in different ones), Ungrouped, and New group…. */
  group?: { groups: ChatGroup[]; current: string | null | undefined; onMove: (groupId: string | null) => void; onNew: () => void };
};

/** A chat's menu: Rename, Pin, Archive and Delete, each through Elpis. One list drawn by the "…" button and by right-click.
 * Failures are shown as Elpis reported them. */
export function ThreadActions({ thread, onDelete, onRequestDelete, onRename, onArchive, pinned, onPin, bookmarked, onBookmark, agents, renameRequested, onRenameRequestHandled, label, area, children, selection, onOpenInTui, onOpenSplit, onOpenWindow, attention, group, onMoveToProject, onNewProject, onPutUnder, onTakeOut }: Props) {
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
  /** F2 on the focused row renames that row's chat; text fields, and the menu and dialog (portals), keep F2 to themselves. */
  const renameKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.key !== "F2" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    if (!event.currentTarget.contains(target) || target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=menu], [role=dialog], [role=alertdialog]")) return;
    event.preventDefault(); rename();
  };
  const many = selection && selection.length > 1 ? selection : null, suffix = many ? ` ${many.length} chats` : "";
  const remove: MenuAction | undefined = onRequestDelete || onDelete ? { id: "delete", label: `Delete${suffix}`, icon: <Trash2 size={14} />, hint: "D", destructive: true, run: () => onRequestDelete ? onRequestDelete(thread) : setDeleting([thread]) } : undefined;
  const archive: MenuAction | undefined = onArchive ? { id: "archive", label: `Archive${suffix}`, icon: <ArchiveIcon size={14} />, hint: shortcutHint("archive"), run: () => onArchive(many ?? [thread]) } : undefined;
  const move: MenuAction | undefined = group ? { id: "move", label: many ? `Move ${many.length} chats to group` : "Move to group", icon: <FolderInput size={14} />, run: () => {}, items: [
    ...group.groups.map(item => ({ id: `group:${item.id}`, label: item.name, checked: group.current === item.id, run: () => group.onMove(item.id) })),
    { id: "ungrouped", label: "Ungrouped", checked: group.current === null, run: () => group.onMove(null) },
    { id: "new-group", label: "New group…", icon: <FolderPlus size={14} />, separated: true, run: group.onNew },
  ] } : undefined;
  const organization: (MenuAction | undefined)[] = [
    move,
    onPutUnder ? { id: "put-under", label: "Put under…", icon: <FolderInput size={14} />, run: () => onPutUnder(many ?? [thread]) } : undefined,
    onTakeOut ? { id: "take-out", label: "Take out", run: () => onTakeOut(many ?? [thread]) } : undefined,
    onMoveToProject ? { id: "project", label: "Move to project…", icon: <FolderInput size={14} />, run: () => onMoveToProject(many ?? [thread]) } : undefined,
    onNewProject ? { id: "new-project", label: "New project from these…", icon: <FolderPlus size={14} />, run: () => onNewProject(many ?? [thread]) } : undefined,
  ];
  const actions = (many ? [...organization, archive, remove] : [
    onRename ? { id: "rename", label: "Rename", icon: <Pencil size={14} />, hint: "F2", run: rename } : undefined,
    onPin ? { id: "pin", label: pinned ? "Unpin" : "Pin", icon: pinned ? <PinOff size={14} /> : <PinIcon size={14} />, hint: shortcutHint("pin"), run: () => onPin(thread) } : undefined,
    onBookmark ? { id: "bookmark", label: bookmarked ? "Remove bookmark" : "Bookmark", icon: bookmarked ? <BookmarkMinus size={14} /> : <Bookmark size={14} />, run: () => onBookmark(thread) } : undefined,
    ...organization,
    attention ? attention.planReady ? { id: "completed", label: "Mark as completed", icon: <CircleCheck size={14} />, hint: "U", run: attention.onComplete }
      : { id: "read", label: attention.unread ? "Mark as read" : "Mark as unread", icon: attention.unread ? <Eye size={14} /> : <EyeOff size={14} />, hint: "U", run: attention.onToggleRead } : undefined,
    agents ? { id: "agents", label: agents.shown ? "Hide agents" : "Show agents", icon: <AgentsIcon size={14} />, run: agents.onToggle } : undefined,
    onOpenInTui ? { id: "tui", label: "Open in Elpis TUI", icon: <TerminalIcon size={14} />, run: () => onOpenInTui(thread) } : undefined,
    onOpenSplit ? { id: "split", label: "Open session in split view", icon: <Columns2 size={14} />, hint: "Alt+click", run: () => onOpenSplit(thread) } : undefined,
    onOpenWindow ? { id: "window", label: "Open session in new window", icon: <SquareArrowOutUpRight size={14} />, run: () => onOpenWindow(thread) } : undefined,
    archive, remove,
  ]).filter((action): action is MenuAction => !!action);
  return <>
    <RightClickMenu actions={actions} area={many || !onRename ? area : cloneElement(area as ReactElement<{ onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void }>, { onKeyDown: event => { (area.props as { onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void }).onKeyDown?.(event); renameKey(event); } })}>
      {children(<MoreMenu actions={actions} className="thread-actions" label={label ?? `Actions for ${current}`} title="Rename, archive or delete" />)}
    </RightClickMenu>
    <AlertDialog open={renaming} onOpenChange={value => { if (!busy && !value) setRenaming(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rename conversation</AlertDialogTitle>
          <AlertDialogDescription>The new name is saved in Elpis and shown in every client.</AlertDialogDescription>
        </AlertDialogHeader>
        <form aria-label="Rename conversation" className="grid gap-4" onSubmit={event => { event.preventDefault(); if (name.trim()) void save(name.trim()); }}>
          <Input aria-label="Conversation name" maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button type="submit" disabled={busy || !name.trim()} disabledReason={busy ? "Saving the conversation name…" : "Enter a conversation name."}>{busy ? "Saving…" : "Save"}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
    {onDelete && !onRequestDelete && <DeleteChatsDialog threads={deleting} onDelete={onDelete} onClose={() => setDeleting(null)} />}
  </>;
}

/** Confirms deleting chats as one decision: one chat by name, several by count. Once confirmation is off
 * ("Don’t show me this again", Settings → General) it deletes at once and opens only to show a failure.
 * `onDelete` deletes each chat for good; `trash` instead deletes them all as one step Ctrl+Z undoes (the sidebar's). */
export function DeleteChatsDialog({ threads, onDelete, trash, onClose, alwaysConfirm }: { threads: Thread[] | null; onDelete?: (thread: Thread) => Promise<void>; trash?: (threads: Thread[]) => Promise<void>; onClose: () => void; /** Bulk deletes ask even when confirmation is off. */ alwaysConfirm?: boolean }) {
  const [opened, setOpened] = useState<Thread[] | null>(null), [confirm, setConfirm] = useState(true), [skip, setSkip] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const deleted = useRef(new Set<string>());
  // A new request is decided before it renders, so a turned-off confirmation never flashes open.
  if (opened !== threads) { setOpened(threads); setConfirm(threads ? alwaysConfirm || readPreferences().confirmDeleteChats : true); setSkip(false); setError(""); }
  useEffect(() => { deleted.current.clear(); if (threads && !confirm) void remove(); }, [threads]); // eslint-disable-line react-hooks/exhaustive-deps
  async function remove() {
    if (!threads) return;
    setBusy(true); setError("");
    try {
      if (skip) savePreferences({ confirmDeleteChats: false });
      if (trash) { await trash(threads); onClose(); return; }
      // Four at a time, so Select all in Archived chats finishes in seconds; the first failure stops the rest.
      const queue = threads.filter(thread => !deleted.current.has(thread.id));
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let thread = queue.shift(); thread; thread = queue.shift()) {
          try { await onDelete!(thread); } catch (e) { queue.length = 0; throw Error(threads.length > 1 ? `Could not delete “${title(thread)}”: ${message(e)}` : message(e)); }
          deleted.current.add(thread.id);
        }
      }));
      onClose();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const only = threads?.length === 1 ? threads[0] : null;
  return <AlertDialog open={!!threads && (confirm || !!error)} onOpenChange={value => { if (!busy && !value) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
      <AlertDialogTitle>{only ? `Delete “${title(only)}”?` : `Delete ${threads?.length ?? 0} chats?`}</AlertDialogTitle>
      <AlertDialogDescription>
        {trash
          ? <>{only ? isAgent(only) ? "This deletes this agent's chat from Elpis." : "This deletes the conversation and all of its agents from Elpis." : "This deletes these conversations and all of their agents from Elpis."} Chats continued from these agents are deleted too. Ctrl+Z brings {only ? "it" : "them"} back until you quit Elpis.</>
          : <>{only ? isAgent(only) ? "This permanently deletes this agent's chat from Elpis." : "This permanently deletes the conversation and all of its agents from Elpis." : "This permanently deletes these conversations and all of their agents from Elpis."} Chats continued from these agents are deleted too. This cannot be undone.</>}
      </AlertDialogDescription>
      </AlertDialogHeader>
      {confirm && !alwaysConfirm && <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" className="accent-primary" checked={skip} disabled={busy} onChange={event => setSkip(event.target.checked)} />Don’t show me this again</label>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

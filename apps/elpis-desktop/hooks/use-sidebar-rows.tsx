"use client";

/** Owns sidebar chat rows, selection, attention, deletion, groups, and drag order. */
import { cloneElement, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Layers } from "lucide-react";
import { ArchiveIcon, PinIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { ThreadActions } from "@/components/thread-actions";
import { GroupActions } from "@/components/chat-groups";
import { SidebarGroup } from "@/components/sidebar-group";
import { letterKey } from "@/components/action-menu";
import { agentState, attentionLine, stateLabels } from "@/lib/agents";
import { api, isAgent, isAgentRun, title, type Approval, type Thread } from "@/lib/api";
import { deleteGroup, moveChats, placeChat, renameGroup, toggleCollapsed, type ChatGroup, type ChatGroups } from "@/lib/chat-groups";
import { move } from "@/lib/nav-order";
import { savePins } from "@/lib/pins";
import { savePreferences, type Preferences } from "@/lib/preferences";
import { keptNotice, type WorktreeOutcome } from "@/lib/chat-worktree";
import { without } from "@/lib/without";
import type { Attention } from "@/lib/attention";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Grouped = { groups: { group: ChatGroup; chats: Thread[] }[]; ungrouped: Thread[] } | null;
type Props = {
  selected: Thread | null; view: string; searchedThreads: Thread[]; filtered: Thread[]; expanded: Record<string, boolean>;
  ordinaryThreads: Thread[]; preferences: Preferences; searchTerm: string;
  pins: string[]; setPins: Setter<string[]>; marked: string[]; setMarked: Setter<string[]>;
  markAnchor: Ref<string | null>; threadList: Ref<HTMLDivElement | null>;
  deletedNotice: string | null; setDeletedNotice: Setter<string | null>;
  setDeleteTargets: Setter<Thread[] | null>; setDeleteRunHistory: Setter<boolean>;
  selectedRef: Ref<Thread | null>; shownWhenDeleted: Ref<Set<string>>; hidden: Ref<Set<string>>;
  setError: Setter<string>; noteKept: (text: string) => void; removeThreads: (ids: Set<string>, permanent: boolean) => void;
  upsertThread: (thread: Thread) => void; remember: (thread: Thread) => Thread;
  refreshThreads: () => Promise<void>; loadThread: (thread: Thread) => Promise<void>;
  openSplit: (thread: Thread) => void; openInNewTab: (thread: Thread) => void;
  attention: Attention; setAttention: Setter<Attention>; setPlanAnswered: Setter<Record<string, string>>;
  chatGroups: ChatGroups; updateGroups: (change: (state: ChatGroups) => ChatGroups) => void;
  setNewGroupFor: Setter<string[] | null>; listedRoots: Thread[]; pinnedChats: Thread[];
  recentChats: Thread[]; grouped: Grouped; waitingIds: Set<string>; approvals: Approval[];
  find: (id?: string | null) => Thread | undefined; hasTerminal: boolean; openInTui: (thread: Thread) => void;
  splitPane: boolean; windowAvailable: boolean; openSessionWindow: (thread?: Thread) => void;
  agentRunsOpen: boolean; setAgentRunsOpen: Setter<boolean>;
  loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>;
  desktop: boolean; renameThread: (thread: Thread, name: string) => Promise<void>;
  archiveThread: (thread: Thread) => Promise<void>; markRead: (id: string) => void;
};

export function useSidebarRows({ selected, view, searchedThreads, filtered, expanded, ordinaryThreads, preferences,
  searchTerm, pins, setPins, marked, setMarked, markAnchor, threadList, deletedNotice, setDeletedNotice,
  setDeleteTargets, setDeleteRunHistory, selectedRef, shownWhenDeleted, hidden, setError, noteKept, removeThreads,
  upsertThread, remember, refreshThreads, loadThread, openSplit, openInNewTab, attention, setAttention,
  setPlanAnswered, chatGroups, updateGroups, setNewGroupFor, listedRoots, pinnedChats, recentChats, grouped,
  waitingIds, approvals, find, hasTerminal, openInTui, splitPane, windowAvailable, openSessionWindow,
  agentRunsOpen, setAgentRunsOpen, loadChildren, desktop, renameThread, archiveThread, markRead }: Props) {
  function togglePin(thread: Thread) {
    const next = pins.includes(thread.id) ? pins.filter(id => id !== thread.id) : [thread.id, ...pins];
    setPins(next); savePins(next);
  }
  /** The sidebar's chat buttons in screen order (a project's chats also appear under Recents). */
  const rowLinks = () => [...threadList.current?.querySelectorAll<HTMLButtonElement>(".thread-row > .thread-link") ?? []];
  const rowOf = (element: Element | null) => element?.closest<HTMLElement>(".thread-row")?.dataset.threadId ?? null;
  /** Opens the shared delete confirmation for these chats. */
  const chatsOf = (ids: string[]) => ids.map(id => searchedThreads.find(thread => thread.id === id) ?? find(id)).filter((thread): thread is Thread => !!thread);
  /** Deletes these chats as one step Ctrl+Z undoes: after the shared confirmation, or at once when it is turned off.
   * `focusAt` is the sidebar row to focus afterwards, so Ctrl+Z reaches the app and not a text field. */
  function deleteChats(ids: string[], focusAt?: number) {
    setDeleteRunHistory(false);
    const targets = chatsOf(ids);
    if (!targets.length) return;
    if (preferences.confirmDeleteChats) { setDeleteTargets(targets); return; }
    void trashChats(targets).then(() => { if (focusAt !== undefined) requestAnimationFrame(() => { const links = rowLinks(); (links[focusAt] ?? links.at(-1))?.focus(); }); }, e => setError(String(e instanceof Error ? e.message : e)));
  }
  /** The bridge archives them now and deletes them for good when Elpis quits (bridge/trash.mjs). */
  async function trashChats(targets: Thread[]) {
    const ids = targets.map(thread => thread.id);
    if (selectedRef.current && ids.includes(selectedRef.current.id)) shownWhenDeleted.current.add(selectedRef.current.id);
    const { trashed, worktrees } = await api<{ trashed: string[]; worktrees?: { threadId: string; worktree: WorktreeOutcome }[] }>("/trash", { threadIds: ids });
    for (const { threadId, worktree } of worktrees ?? []) { const thread = targets.find(item => item.id === threadId); if (thread) noteKept(keptNotice(title(thread), "deleted", worktree)); }
    removeThreads(new Set(trashed), false);
    setDeletedNotice(targets.length === 1 ? `Deleted “${title(targets[0])}”` : `Deleted ${targets.length} chats`);
  }
  /** Ctrl+Z and the notice's Undo: the newest deletion comes back, with the chat that was open opened again. */
  async function undoDelete() {
    try {
      const { threads: back, restored } = await api<{ threads: Thread[]; restored?: string[] }>("/trash/undo", {});
      if (!back.length) return;
      setDeletedNotice(null);
      for (const id of restored ?? back.map(thread => thread.id)) hidden.current.delete(id);
      for (const thread of back) upsertThread(remember(thread));
      await refreshThreads();
      const reopen = back.find(thread => shownWhenDeleted.current.has(thread.id));
      for (const thread of back) shownWhenDeleted.current.delete(thread.id);
      if (reopen) await loadThread(reopen);
    } catch (e) { setError(`Could not bring back the deleted chat: ${e instanceof Error ? e.message : String(e)}`); }
  }
  useEffect(() => { if (!deletedNotice) return; const timer = setTimeout(() => setDeletedNotice(null), 8000); return () => clearTimeout(timer); }, [deletedNotice]);
  /** A click opens the chat; Ctrl+click marks or unmarks it; Shift+click marks the range from the last click, as in a file manager. */
  function clickRow(thread: Thread, event: React.MouseEvent<HTMLButtonElement>) {
    if (event.altKey) { event.preventDefault(); openSplit(thread); return; }
    const ids = [...new Set(rowLinks().map(rowOf).filter((id): id is string => !!id))];
    if (event.ctrlKey || event.metaKey) {
      const base = marked.length ? marked : selected && ids.includes(selected.id) ? [selected.id] : [];
      setMarked(base.includes(thread.id) ? base.filter(id => id !== thread.id) : [...base, thread.id]); markAnchor.current = thread.id;
    } else if (event.shiftKey) {
      const to = ids.indexOf(thread.id), at = ids.indexOf(markAnchor.current ?? selected?.id ?? thread.id), from = at < 0 ? to : at;
      setMarked(ids.slice(Math.min(from, to), Math.max(from, to) + 1)); event.currentTarget.focus();
    } else { setMarked([]); markAnchor.current = thread.id; void loadThread(thread); }
  }
  /** Navigation moves focus; Enter activates the focused control. Menus and text editing keep their own keys. */
  function sidebarKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(".nav-list > button, input[aria-label='Search conversations'], .sidebar-group-toggle, .thread-row > .thread-link, [data-sidebar-stop]")]
      .filter(element => !element.matches(":disabled") && element.getClientRects().length > 0);
    const at = stops.indexOf(target);
    if (at < 0 || !event.currentTarget.contains(target)) return;
    if (target instanceof HTMLInputElement && target.value && (event.key === "Home" || event.key === "End")) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : Math.max(0, Math.min(stops.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); stops[index]?.focus();
  }
  /** Keys on a focused chat row: D deletes, U changes attention, and Escape clears the marks. */
  function listKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement, id = rowOf(target);
    if (!id || !event.currentTarget.contains(target) || event.ctrlKey || event.metaKey) return;
    if (event.altKey) {
      if (event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || target.closest(".thread-row.child")) return;
      event.preventDefault(); reorderBy(id, event.key === "ArrowUp" ? -1 : 1); return;
    }
    if (event.key === "Escape" && marked.length) setMarked([]);
    else if (letterKey(event) === "u") attentionFor(id).planReady ? attentionFor(id).onComplete() : attentionFor(id).onToggleRead();
    else if (letterKey(event) === "d") deleteChats(marked.length ? marked : [id], rowLinks().findIndex(link => link.parentElement === target.closest(".thread-row")));
    else return;
    event.preventDefault();
  }
  function attentionFor(id: string) {
    return { unread: attention.unread.includes(id), planReady: !!attention.plans[id],
      onToggleRead: () => setAttention(previous => ({ ...previous, unread: previous.unread.includes(id) ? previous.unread.filter(value => value !== id) : [...previous.unread, id] })),
      onComplete: () => {
        setPlanAnswered(previous => ({ ...previous, [id]: attention.plans[id] }));
        setAttention(previous => ({ unread: previous.unread.filter(value => value !== id), plans: without(previous.plans, id) }));
      },
    };
  }
  /** "Move to group" for these chats (the row's chat, or the selection it belongs to), as Claude's session menu has it.
   * Only top-level chats are grouped; an agent's chat stays under its parent. */
  function groupMenu(thread: Thread, ids: string[]) {
    if (thread.parentThreadId || isAgentRun(thread)) return undefined;
    const known = (id: string) => chatGroups.groups.some(group => group.id === chatGroups.members[id]) ? chatGroups.members[id] : null;
    const currents = new Set(ids.map(known));
    return { groups: chatGroups.groups, current: currents.size === 1 ? [...currents][0] : undefined,
      onMove: (groupId: string | null) => { updateGroups(state => moveChats(state, ids, groupId)); setMarked([]); },
      onNew: () => setNewGroupFor(ids) };
  }
  // Manual order: drag a chat onto another (or onto a group's heading, or Recents') or press Alt+Up/Down on it. Pinned chats
  // stay pinned and others stay unpinned; a drop in another section moves the chat there. The first move makes Sort by Manual.
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; mark: "before" | "after" | "into" } | null>(null);
  const sectionOf = (id: string) => pins.includes(id) ? "pinned" : chatGroups.groupBy === "custom" && chatGroups.groups.some(group => group.id === chatGroups.members[id]) ? `group:${chatGroups.members[id]}` : "recents";
  const sectionChats = (section: string) => section === "pinned" ? pinnedChats : section === "recents" ? recentChats : grouped?.groups.find(item => `group:${item.group.id}` === section)?.chats ?? [];
  const canDrop = (section: string) => !!dragging.current && !searchTerm && (section === "pinned") === (sectionOf(dragging.current) === "pinned");
  function placeDragged(id: string, section: string, place?: { target: string; after: boolean }) {
    const ids = listedRoots.map(thread => thread.id);
    updateGroups(state => placeChat(state, place && place.target !== id ? move(ids, id, place) : ids, id, section === "pinned" ? undefined : section === "recents" ? null : section.slice(6)));
  }
  function reorderBy(id: string, by: -1 | 1) {
    const section = sectionOf(id), list = sectionChats(section), neighbour = list[list.findIndex(thread => thread.id === id) + by];
    if (!neighbour || searchTerm) return;
    placeDragged(id, section, { target: neighbour.id, after: by > 0 });
    requestAnimationFrame(() => threadList.current?.querySelector<HTMLElement>(`.thread-row[data-thread-id="${CSS.escape(id)}"] .thread-link`)?.focus());
  }
  /** Where a drag may end on `key` (a chat id, or a section): the heading of a group or of Recents takes the chat at its end or its start. */
  const dropTarget = (section: string, key: string, onHeading?: boolean) => {
    const over = (event: React.DragEvent<HTMLElement>) => {
      if (!canDrop(section) || dragging.current === key) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect(), mark = onHeading ? "into" : event.clientY > box.top + box.height / 2 ? "after" : "before";
      setDrop(previous => previous?.id === key && previous.mark === mark ? previous : { id: key, mark });
    };
    return { onDragEnter: over, onDragOver: over,
    onDragLeave: (event: React.DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(previous => previous?.id === key ? null : previous); },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const id = dragging.current, mark = drop?.id === key ? drop.mark : null, allowed = canDrop(section); dragging.current = null; setDrop(null);
      if (!id || !allowed || id === key) return;
      event.preventDefault();
      if (!onHeading) { placeDragged(id, section, { target: key, after: mark === "after" }); return; }
      const others = sectionChats(section).filter(thread => thread.id !== id);
      placeDragged(id, section, section === "recents" && others[0] ? { target: others[0].id, after: false } : others.at(-1) ? { target: others.at(-1)!.id, after: true } : undefined);
    },
    };
  };
  function threadRow(thread: Thread, depth = 0, section?: string) {
    const name = title(thread), state = agentState(thread, waitingIds, isAgentRun(thread) ? new Set() : new Set(attention.unread)), pinned = pins.includes(thread.id);
    const runParent = find(thread.parentThreadId);
    const subtitle = attentionLine(approvals.find(approval => (approval.params.threadId ?? approval.ownerThreadId) === thread.id), !!attention.plans[thread.id]);
    return <ThreadActions key={thread.id} thread={thread} onRequestDelete={() => deleteChats(marked.includes(thread.id) ? marked : [thread.id])} onRename={renameThread} onArchive={archiveThread} pinned={pinned} onPin={togglePin} onOpenInTui={hasTerminal ? openInTui : undefined} onOpenSplit={!splitPane ? openSplit : undefined} onOpenWindow={windowAvailable ? openSessionWindow : undefined} onNewWindow={windowAvailable ? () => openSessionWindow() : undefined}
      attention={attentionFor(thread.id)}
      selection={marked.length > 1 && marked.includes(thread.id) ? chatsOf(marked) : undefined}
      group={depth ? undefined : groupMenu(thread, marked.length > 1 && marked.includes(thread.id) ? marked : [thread.id])}
      agents={!depth && !isAgent(thread) ? { shown: preferences.showAgentRuns && agentRunsOpen, onToggle: () => {
        try { if (!preferences.showAgentRuns) savePreferences({ showAgentRuns: true }); }
        catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); return; }
        setAgentRunsOpen(!preferences.showAgentRuns || !agentRunsOpen); if (!preferences.showAgentRuns || !agentRunsOpen) void loadChildren(thread.id, undefined, false);
      } } : undefined}
      area={<div className={`thread-row${depth ? " child" : ""}${selected?.id === thread.id && view === "chat" ? " active" : ""}${marked.includes(thread.id) ? " selected" : ""} data-[drop=before]:shadow-[inset_0_2px_0_0_var(--primary)] data-[drop=after]:shadow-[inset_0_-2px_0_0_var(--primary)] data-[dragging]:opacity-50`} data-thread-id={thread.id} data-drop={drop?.id === thread.id ? drop.mark : undefined} data-dragging={dragging.current === thread.id && drop ? "" : undefined}
        {...(section && !depth && !searchTerm ? { draggable: true, ...dropTarget(section, thread.id),
          onDragStart: (event: React.DragEvent<HTMLElement>) => { dragging.current = thread.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/x-elpis-chat", thread.id); },
          onDragEnd: () => { dragging.current = null; setDrop(null); } } : {})} style={depth ? { paddingLeft: `${Math.min(depth, 5) * 14}px` } : undefined} />}>
      {menu => <>
      {state === "unread" ? <button data-slot="thread-dot" className="thread-dot" data-state={state} aria-label="Unread response. Mark as read" title="Unread response. Mark as read" onClick={() => markRead(thread.id)} /> : <span className="thread-dot" role="img" data-state={state} aria-label={stateLabels[state]} title={stateLabels[state]} />}
      <button data-slot="chat-row" className="thread-link" onMouseDown={event => { if (event.shiftKey || event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1 && desktop) { event.preventDefault(); openInNewTab(thread); } }} onClick={event => clickRow(thread, event)} title={name}>
        <span className="thread-title">{name}</span>
        {isAgentRun(thread) && thread.parentThreadId && <span className="text-xs text-muted-foreground">from {runParent ? title(runParent) : "parent conversation"}</span>}
        {subtitle && <span className="thread-subtitle" title={subtitle}>{subtitle}</span>}
        {thread.forkedFromId && <span className="thread-nickname">Continued agent chat</span>}
      </button>
      {!depth && <span className="row-hover-actions"><Button variant="ghost" size="icon-xs" aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`} title={pinned ? "Unpin" : "Pin"} onClick={() => togglePin(thread)}><PinIcon size={13} className={pinned ? "fill-current" : undefined} /></Button><Button variant="ghost" size="icon-xs" aria-label={`Archive ${name}`} title="Archive" onClick={() => void archiveThread(thread)}><ArchiveIcon size={13} /></Button></span>}
      {menu}
      </>}
    </ThreadActions>;
  }
  function descendants(parentId: string, depth: number, seen = new Set<string>()): React.ReactNode {
    if (seen.has(parentId)) return null; const next = new Set(seen).add(parentId);
    return filtered.filter(c => c.parentThreadId === parentId).map(child => <div key={child.id}>{threadRow(child, depth)}{descendants(child.id, depth + 1, next)}</div>);
  }
  /** A listed chat and, when shown, its agents under it. */
  const chatRows = (section: string) => (thread: Thread) => <div key={thread.id}>{threadRow(thread, 0, section)}{expanded[thread.id] && descendants(thread.id, 1)}</div>;
  const needsYou = (thread: Thread) => agentState(thread, waitingIds) === "waiting" || !!attention.plans[thread.id];
  /** A group the person made, drawn as a project is: open or closed, its menu (Rename group, Delete group), its chats. A
   * closed group holding a chat that needs you says so, as Claude's does. */
  function chatGroupSection({ group, chats }: { group: ChatGroup; chats: Thread[] }) {
    const open = !chatGroups.collapsed.includes(group.id), waiting = !open && chats.some(needsYou), note = "A chat in this group is waiting on you";
    return <SidebarGroup key={group.id} kind="chat" name={group.name} icon={<Layers size={14} aria-hidden="true" />} open={open} onToggle={() => updateGroups(state => toggleCollapsed(state, group.id))}
      note={waiting ? <span className="thread-dot" data-state="waiting" role="img" aria-label={note} title={note} /> : undefined}
      wrap={(area, content) => <GroupActions group={group} state={chatGroups} area={cloneElement(area, { className: `${(area.props as { className?: string }).className} data-[drop=into]:bg-[var(--selected)] data-[drop=into]:shadow-[inset_0_0_0_1px_var(--primary)]`, "data-drop": drop?.id === `group:${group.id}` ? "into" : undefined, ...dropTarget(`group:${group.id}`, `group:${group.id}`, true) } as object)} count={ordinaryThreads.filter(thread => chatGroups.members[thread.id] === group.id).length}
        onRename={name => updateGroups(state => renameGroup(state, group.id, name))} onDelete={() => updateGroups(state => deleteGroup(state, group.id))}>{content}</GroupActions>}
      empty={!chats.length}>{chats.map(chatRows(`group:${group.id}`))}</SidebarGroup>;
  }
  return { togglePin, chatsOf, deleteChats, trashChats, undoDelete, sidebarKeys, listKeys,
    attentionFor, groupMenu, drop, dropTarget, threadRow, chatRows, chatGroupSection };
}
export function useSidebarState() {
  /** Chats awaiting the shared delete confirmation. */
  const [deleteTargets, setDeleteTargets] = useState<Thread[] | null>(null);
  const [deleteRunHistory, setDeleteRunHistory] = useState(false);
  /** "Deleted …" with its Undo, after the sidebar deletes chats. */
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);
  const shownWhenDeleted = useRef(new Set<string>());
  /** Chats marked with Ctrl+click or Shift+click in the sidebar. */
  const [marked, setMarked] = useState<string[]>([]);
  const markAnchor = useRef<string | null>(null);
  const threadList = useRef<HTMLDivElement>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  return { deleteTargets, setDeleteTargets, deleteRunHistory, setDeleteRunHistory,
    deletedNotice, setDeletedNotice, shownWhenDeleted, marked, setMarked, markAnchor,
    threadList, collapsedProjects, setCollapsedProjects };
}


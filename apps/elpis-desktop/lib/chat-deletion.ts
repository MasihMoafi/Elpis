import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, title, type Thread } from "@/lib/api";
import { recordChatStep, stepChatHistory, type ChatStep } from "@/lib/chat-undo";
import { keptNotice, type WorktreeOutcome } from "@/lib/chat-worktree";
import { errorText } from "@/lib/error-text.mts";
import type { useAppPreferences } from "@/lib/preferences";
import type { useConversationList } from "@/lib/use-conversation-list";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  conversations: ReturnType<typeof useConversationList>;
  preferences: ReturnType<typeof useAppPreferences>;
  selectedRef: RefObject<Thread | null>;
  shownWhenDeleted: RefObject<Set<string>>;
  withNested: (ids: string[]) => string[];
  chatsOf: (ids: string[]) => Thread[];
  find: (id?: string | null) => Thread | undefined;
  archiveThread: (thread: Thread) => Promise<void>;
  rowLinks: () => HTMLButtonElement[];
  setDeleteRunHistory: Setter<boolean>;
  setDeleteTargets: Setter<Thread[] | null>;
  setDeletedNotice: Setter<string | null>;
  setHistoryNotice: Setter<string>;
  setError: Setter<string>;
  noteKept: (text: string) => void;
  removeThreads: (ids: Set<string>, permanent: boolean) => void;
  loadThread: (thread: Thread) => Promise<void>;
};

export function createChatDeletion({
  conversations,
  preferences,
  selectedRef,
  shownWhenDeleted,
  withNested,
  chatsOf,
  find,
  archiveThread,
  rowLinks,
  setDeleteRunHistory,
  setDeleteTargets,
  setDeletedNotice,
  setHistoryNotice,
  setError,
  noteKept,
  removeThreads,
  loadThread,
}: Inputs) {
  const { hidden, upsertThread, remember, refreshThreads } = conversations;
  /** Archive, from a row's button, the menus, Ctrl+Shift+A and /archive: these chats with the chats put under them. An agent
   * whose chat is archived too is left to go with it (bridge archiveThread), so it is not archived twice. */
  function archiveChats(chats: Thread[]) {
    const ids = withNested(chats.map(chat => chat.id)),
      all = [...chats, ...chatsOf(ids.filter(id => !chats.some(chat => chat.id === id)))];
    const archiving = new Set(all.map(chat => chat.id));
    const covered = (chat: Thread) => {
      for (
        let parent = chat.parentThreadId, depth = 0;
        parent && depth < 50;
        parent = find(parent)?.parentThreadId, depth++
      )
        if (archiving.has(parent)) return true;
      return false;
    };
    for (const chat of all) if (!covered(chat)) void archiveThread(chat);
  }
  /** Deletes these chats as one step Ctrl+Z undoes: after the shared confirmation, or at once when it is turned off.
   * `focusAt` is the sidebar row to focus afterwards, so Ctrl+Z reaches the app and not a text field. */
  function deleteChats(ids: string[], focusAt?: number) {
    setDeleteRunHistory(false);
    const targets = chatsOf(withNested(ids));
    if (!targets.length) return;
    if (preferences.confirmDeleteChats) {
      setDeleteTargets(targets);
      return;
    }
    void trashChats(targets).then(
      () => {
        if (focusAt !== undefined)
          requestAnimationFrame(() => {
            const links = rowLinks();
            (links[focusAt] ?? links.at(-1))?.focus();
          });
      },
      e => setError(String(errorText(e))),
    );
  }
  /** The bridge archives them now and deletes them for good when Elpis quits (bridge/trash.mts). One step Ctrl+Z undoes. */
  async function trashChats(targets: Thread[]) {
    await trash(targets);
    recordChatStep({
      kind: "delete",
      label: targets.length === 1 ? `deleted “${title(targets[0]!)}”` : `deleted ${targets.length} chats`,
      undo: restoreDeleted,
      redo: () => trash(targets),
    });
  }
  async function trash(targets: Thread[]) {
    const ids = targets.map(thread => thread.id);
    if (selectedRef.current && ids.includes(selectedRef.current.id))
      shownWhenDeleted.current.add(selectedRef.current.id);
    const { trashed, worktrees } = await api<{
      trashed: string[];
      worktrees?: { threadId: string; worktree: WorktreeOutcome }[];
    }>("/trash", { threadIds: ids });
    for (const { threadId, worktree } of worktrees ?? []) {
      const thread = targets.find(item => item.id === threadId);
      if (thread) noteKept(keptNotice(title(thread), "deleted", worktree));
    }
    // An agent deleted with its chat is not listed as trashed itself (bridge/trash.mts); it leaves the list all the same.
    removeThreads(new Set([...trashed, ...ids]), false);
    setDeletedNotice(targets.length === 1 ? `Deleted “${title(targets[0]!)}”` : `Deleted ${targets.length} chats`);
  }
  /** The bridge's newest deletion comes back, with the chat that was open opened again. */
  async function restoreDeleted() {
    const { threads: back, restored } = await api<{ threads: Thread[]; restored?: string[] }>("/trash/undo", {});
    if (!back.length) return false;
    setDeletedNotice(null);
    for (const id of restored ?? back.map(thread => thread.id)) hidden.current.delete(id);
    for (const thread of back) upsertThread(remember(thread));
    await refreshThreads();
    const reopen = back.find(thread => shownWhenDeleted.current.has(thread.id));
    for (const thread of back) shownWhenDeleted.current.delete(thread.id);
    if (reopen) await loadThread(reopen);
    return true;
  }
  /** Ctrl+Z, Ctrl+Shift+Z and the Deleted notice's Undo (`pick` the newest deletion) through the one history
   * (lib/chat-undo.ts), with a line saying what changed. With nothing recorded in this window, Ctrl+Z still brings back a
   * deletion the bridge kept from before a reload. */
  async function chatHistory(direction: "undo" | "redo", pick?: (step: ChatStep) => boolean) {
    try {
      const step = await stepChatHistory(direction, pick);
      if (step) setHistoryNotice(`${direction === "undo" ? "Undone" : "Redone"}: ${step.label}`);
      else if (direction === "undo") await restoreDeleted();
    } catch (e) {
      setError(
        pick
          ? `Could not bring back the deleted chat: ${errorText(e)}`
          : `Could not ${direction} the last chat action: ${errorText(e)}`,
      );
    }
  }
  return {
    archiveChats,
    deleteChats,
    trashChats,
    undoDelete: () => chatHistory("undo", step => step.kind === "delete"),
    undoChat: () => chatHistory("undo"),
    redoChat: () => chatHistory("redo"),
  };
}

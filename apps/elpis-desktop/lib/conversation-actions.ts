import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, title, unreadable, type Thread } from "@/lib/api";
import { recordChatStep } from "@/lib/chat-undo";
import { keptNotice, type WorktreeOutcome } from "@/lib/chat-worktree";
import { errorText } from "@/lib/error-text.mts";
import { scanDeletionThreads } from "@/lib/thread-deletion";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  conversations: ReturnType<typeof useConversationList>;
  runtime: ReturnType<typeof useRuntimeState>;
  selectedRef: RefObject<Thread | null>;
  request: RefObject<number>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  loadThread: (thread: Thread) => Promise<void>;
  loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>;
  restoreComposerFocus: (origin: Element | null) => void;
  removeThreads: (ids: Set<string>, permanent: boolean) => void;
  noteKept: (message: string) => void;
};

/** Chats being archived now, across re-renders (the actions are re-created each render). */
const archiving = new Set<string>();

export function createConversationActions({
  conversations,
  runtime,
  selectedRef,
  request,
  setBusy,
  setError,
  loadThread,
  loadChildren,
  restoreComposerFocus,
  removeThreads,
  noteKept,
}: Inputs) {
  const { upsertThread, patchThread, hidden, refreshThreads } = conversations;
  const { ready, connected, activeTurns } = runtime;
  /** ChatGPT's "Fork chat from here": a new chat with the history through that turn, opened at once. */
  async function forkFrom(thread: Thread, lastTurnId: string, lastItemId?: string) {
    const originalFocus = document.activeElement,
      originalRequest = request.current;
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/fork`, {
        lastTurnId,
        ...(lastItemId ? { lastItemId } : {}),
      });
      if (!result.thread || typeof result.thread.id !== "string") throw unreadable("fork");
      upsertThread(result.thread);
      if (request.current !== originalRequest || selectedRef.current?.id !== thread.id) return;
      await loadThread(result.thread);
      if (selectedRef.current?.id === result.thread.id) restoreComposerFocus(originalFocus);
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function continueHere(thread: Thread) {
    const originalRequest = request.current;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/continue`, {});
      if (!result.thread?.id) throw unreadable("continued chat");
      upsertThread(result.thread);
      if (request.current === originalRequest && selectedRef.current?.id === thread.id) await loadThread(result.thread);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function stop(thread: Thread) {
    if (!ready || !connected) return;
    const originalFocus = document.activeElement,
      originalRequest = request.current;
    try {
      await api(
        `/threads/${encodeURIComponent(thread.id)}/interrupt`,
        activeTurns[thread.id] ? { turnId: activeTurns[thread.id] } : {},
      );
    } catch (e) {
      setError(String(errorText(e)));
    } finally {
      if (request.current === originalRequest && selectedRef.current?.id === thread.id)
        restoreComposerFocus(originalFocus);
    }
  }
  async function deleteThread(thread: Thread) {
    const ids = new Set([thread.id]);
    const descendants = await scanDeletionThreads<Thread>(({ archived, limit, cursor }) =>
      api(
        `/threads?ancestorThreadId=${encodeURIComponent(thread.id)}&archived=${archived}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    for (const child of descendants) ids.add(child.id);
    const result = await api<{ alsoDeleted: string[]; worktree?: WorktreeOutcome }>(
      `/threads/${encodeURIComponent(thread.id)}/delete`,
      {},
    );
    for (const id of result.alsoDeleted) ids.add(id);
    removeThreads(ids, true);
    noteKept(keptNotice(title(thread), "deleted", result.worktree));
  }
  async function setName(id: string, name: string) {
    const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(id)}/rename`, { name });
    const named = result.thread.name ?? name;
    patchThread(id, { name: named });
    return named;
  }
  /** Ctrl+Z gives the chat the name it showed before; a chat that had no name of its own gets the title it showed, since
   * the engine cannot clear a name. */
  async function renameThread(thread: Thread, name: string) {
    const before = thread.name?.trim() || title(thread),
      after = await setName(thread.id, name);
    if (before !== after)
      recordChatStep({
        kind: "rename",
        label: `renamed “${before}” to “${after}”`,
        undo: () => setName(thread.id, before),
        redo: () => setName(thread.id, after),
      });
  }
  // Elpis archives the chat with the agents it spawned; hide every loaded one. A chat with many agents takes the engine a
  // minute (10 Nov: "Pointt: book OCR", 58 sub-chats); a second Archive meanwhile found it gone and reported a failure,
  // so it says at once that it is archiving, ignores a repeat, and a chat already archived just leaves the list.
  async function archiveThread(thread: Thread) {
    if (await archive(thread))
      recordChatStep({
        kind: "archive",
        label: `archived “${title(thread)}”`,
        undo: () => unarchive(thread),
        redo: () => archive(thread, true),
      });
  }
  /** True when the engine archived it now. `strict` (a redo) passes a failure on instead of showing it. */
  async function archive(thread: Thread, strict = false) {
    if (archiving.has(thread.id)) return false;
    archiving.add(thread.id);
    const slow = setTimeout(() => noteKept(`Archiving “${title(thread)}” and its agents…`), 800);
    try {
      const result = await api<{ worktree?: WorktreeOutcome }>(`/threads/${encodeURIComponent(thread.id)}/archive`, {});
      removeThreads(new Set([thread.id]), false);
      noteKept(keptNotice(title(thread), "archived", result.worktree));
      return true;
    } catch (e) {
      if (strict) throw e;
      if (/no rollout found for thread id/.test(errorText(e))) removeThreads(new Set([thread.id]), false);
      else setError(`Could not archive “${title(thread)}”: ${errorText(e)}`);
      return false;
    } finally {
      clearTimeout(slow);
      archiving.delete(thread.id);
    }
  }
  /** Ctrl+Z after Archive: the same route as Settings › Archived chats › Unarchive, with the agents archived with it. */
  async function unarchive(thread: Thread) {
    const result = await api<{ thread: Thread; restored?: string[] }>(
      `/threads/${encodeURIComponent(thread.id)}/unarchive`,
      {},
    );
    unarchived(result.thread, result.restored ?? []);
  }
  /** A chat back from Archived chats, with the agents archived with it (`restored`), which show under it again. */
  function unarchived(thread: Thread, restored: string[] = []) {
    for (const id of [thread.id, ...restored]) hidden.current.delete(id);
    upsertThread(thread);
    refreshThreads().catch(e => setError(String(e)));
    if (restored.length) void loadChildren(thread.id, undefined, false);
  }
  return { forkFrom, continueHere, stop, deleteThread, renameThread, archiveThread, unarchived };
}

import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, title, unreadable, type Thread } from "@/lib/api";
import { keptNotice, type WorktreeOutcome } from "@/lib/chat-worktree";
import { errorText } from "@/lib/error-text.mjs";
import { scanDeletionThreads } from "@/lib/thread-deletion";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useRuntimeState } from "@/lib/use-runtime-state";

type Inputs = {
  conversations: ReturnType<typeof useConversationList>; runtime: ReturnType<typeof useRuntimeState>;
  selectedRef: RefObject<Thread | null>; request: RefObject<number>; setBusy: Dispatch<SetStateAction<boolean>>; setError: Dispatch<SetStateAction<string>>;
  loadThread: (thread: Thread) => Promise<void>; loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>;
  restoreComposerFocus: (origin: Element | null) => void; removeThreads: (ids: Set<string>, permanent: boolean) => void; noteKept: (message: string) => void;
};

export function createConversationActions({ conversations, runtime, selectedRef, request, setBusy, setError, loadThread, loadChildren, restoreComposerFocus, removeThreads, noteKept }: Inputs) {
  const { upsertThread, patchThread, hidden, refreshThreads } = conversations;
  const { ready, connected, activeTurns } = runtime;
  /** ChatGPT's "Fork chat from here": a new chat with the history through that turn, opened at once. */
  async function forkFrom(thread: Thread, lastTurnId: string, lastItemId?: string) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/fork`, { lastTurnId, ...(lastItemId ? { lastItemId } : {}) }); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("fork"); upsertThread(result.thread);
      if (request.current !== originalRequest || selectedRef.current?.id !== thread.id) return;
      await loadThread(result.thread);
      if (selectedRef.current?.id === result.thread.id) restoreComposerFocus(originalFocus);
    }
    catch (error) { setError(errorText(error)); }
  }
  async function continueHere(thread: Thread) {
    const originalRequest = request.current;
    setBusy(true); setError("");
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/continue`, {});
      if (!result.thread?.id) throw unreadable("continued chat");
      upsertThread(result.thread);
      if (request.current === originalRequest && selectedRef.current?.id === thread.id) await loadThread(result.thread);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function stop(thread: Thread) {
    if (!ready || !connected) return;
    const originalFocus = document.activeElement, originalRequest = request.current;
    try { await api(`/threads/${encodeURIComponent(thread.id)}/interrupt`, activeTurns[thread.id] ? { turnId: activeTurns[thread.id] } : {}); }
    catch (e) { setError(String(errorText(e))); }
    finally { if (request.current === originalRequest && selectedRef.current?.id === thread.id) restoreComposerFocus(originalFocus); }
  }
  async function deleteThread(thread: Thread) {
    const ids = new Set([thread.id]);
    const descendants = await scanDeletionThreads<Thread>(({ archived, limit, cursor }) => api(`/threads?ancestorThreadId=${encodeURIComponent(thread.id)}&archived=${archived}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    for (const child of descendants) ids.add(child.id);
    const result = await api<{ alsoDeleted: string[]; worktree?: WorktreeOutcome }>(`/threads/${encodeURIComponent(thread.id)}/delete`, {});
    for (const id of result.alsoDeleted) ids.add(id);
    removeThreads(ids, true); noteKept(keptNotice(title(thread), "deleted", result.worktree));
  }
  async function renameThread(thread: Thread, name: string) {
    const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/rename`, { name });
    patchThread(thread.id, { name: result.thread.name ?? name });
  }
  // Elpis archives the chat with the agents it spawned; hide every loaded one.
  async function archiveThread(thread: Thread) {
    try { const result = await api<{ worktree?: WorktreeOutcome }>(`/threads/${encodeURIComponent(thread.id)}/archive`, {}); removeThreads(new Set([thread.id]), false); noteKept(keptNotice(title(thread), "archived", result.worktree)); }
    catch (e) { setError(`Could not archive “${title(thread)}”: ${errorText(e)}`); }
  }
  /** A chat back from Archived chats, with the agents archived with it (`restored`), which show under it again. */
  function unarchived(thread: Thread, restored: string[] = []) {
    for (const id of [thread.id, ...restored]) hidden.current.delete(id);
    upsertThread(thread); refreshThreads().catch(e => setError(String(e)));
    if (restored.length) void loadChildren(thread.id, undefined, false);
  }
  return { forkFrom, continueHere, stop, deleteThread, renameThread, archiveThread, unarchived };
}

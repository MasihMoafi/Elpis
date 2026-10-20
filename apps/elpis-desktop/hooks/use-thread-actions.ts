/** Owns chat thread fork, continuation, rename, removal, and approval actions. */
import type { Dispatch, SetStateAction } from "react";
import { api, title, unreadable, type Approval, type Thread } from "@/lib/api";
import { keptNotice, type WorktreeOutcome } from "@/lib/chat-worktree";
import { scanDeletionThreads } from "@/lib/thread-deletion";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = { current: T };
type Props = { request: Ref<number>; selectedRef: Ref<Thread | null>;
  upsertThread: (thread: Thread) => void; loadThread: (thread: Thread) => Promise<void>;
  restoreComposerFocus: (origin: Element | null) => void; setError: Setter<string>;
  setBusy: Setter<boolean>; removeThreads: (ids: Set<string>, permanent: boolean) => void;
  noteKept: (text: string) => void; patchThread: (id: string, patch: Partial<Thread>) => void;
  hidden: Ref<Set<string>>; refreshThreads: () => Promise<void>;
  submitDraft: (key: string, send: () => Promise<unknown>) => Promise<unknown>;
  setApprovals: Setter<Approval[]>; clearApprovalDraft: (id: string) => void };

export function useThreadActions({ request, selectedRef, upsertThread, loadThread, restoreComposerFocus,
  setError, setBusy, removeThreads, noteKept, patchThread, hidden, refreshThreads, submitDraft,
  setApprovals, clearApprovalDraft }: Props) {
  /** ChatGPT's "Fork chat from here": a new chat with the history through that turn, opened at once. */
  async function forkFrom(thread: Thread, lastTurnId: string) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/fork`, { lastTurnId }); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("fork"); upsertThread(result.thread);
      if (request.current !== originalRequest || selectedRef.current?.id !== thread.id) return;
      await loadThread(result.thread);
      if (selectedRef.current?.id === result.thread.id) restoreComposerFocus(originalFocus);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  async function continueHere(thread: Thread) {
    const originalRequest = request.current;
    setBusy(true); setError("");
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/continue`, {});
      if (!result.thread?.id) throw unreadable("continued chat");
      upsertThread(result.thread);
      if (request.current === originalRequest && selectedRef.current?.id === thread.id) await loadThread(result.thread);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
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
    catch (e) { setError(`Could not archive “${title(thread)}”: ${e instanceof Error ? e.message : String(e)}`); }
  }
  function unarchived(thread: Thread) { hidden.current.delete(thread.id); upsertThread(thread); refreshThreads().catch(e => setError(String(e))); }
  /** Answers a request; `instead` is "Deny, and tell Elpis what to do instead" (body: { text }). */
  async function answer(id: string, body: unknown, key: string, instead = false) {
    const originalFocus = document.activeElement, originalRequest = request.current;
    await submitDraft(key, () => api(`/approvals/${encodeURIComponent(id)}${instead ? "/instead" : ""}`, body));
    setApprovals(prev => prev.filter(a => a.id !== id)); clearApprovalDraft(id);
    if (request.current === originalRequest) restoreComposerFocus(originalFocus);
  }
  return { forkFrom, continueHere, deleteThread, renameThread, archiveThread, unarchived, answer };
}

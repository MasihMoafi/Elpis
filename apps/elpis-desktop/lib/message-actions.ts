import { announceScrollIntent } from "@/lib/scroll-intent";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { RestoreMode } from "@/components/rewind-dialog";
import { api, unreadable, type Entry, type Thread } from "@/lib/api";
import type { replacementEligibility, MessageVersion } from "@/lib/turn-replacement";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useDraftStore, useSubmitOnce } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import { without } from "@/lib/utils";
import type { NextTurn } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  composer: ReturnType<typeof useComposerState>;
  conversations: ReturnType<typeof useConversationList>;
  drafts: ReturnType<typeof useDraftStore>;
  history: ReturnType<typeof useTranscriptHistory>;
  runtime: ReturnType<typeof useRuntimeState>;
  selectedRef: RefObject<Thread | null>;
  request: RefObject<number>;
  stickToBottom: RefObject<boolean>;
  rewindSwitch: RefObject<string | null>;
  replacementOptions: Map<string, ReturnType<typeof replacementEligibility>>;
  entries: Entry[];
  nextTurn: Record<string, NextTurn>;
  submitDraft: ReturnType<typeof useSubmitOnce>["submit"];
  setRuntimeNotices: Setter<Record<string, string>>;
  setMessageEdits: Setter<Record<string, string>>;
  setNextTurn: Setter<Record<string, NextTurn>>;
  setEntries: Setter<Entry[]>;
  setThreads: Setter<Thread[]>;
  setRewindBusy: Setter<boolean>;
  setRewindActions: Setter<Record<string, "undo" | "redo" | undefined>>;
  setMessageVersions: Setter<Record<string, MessageVersion[]>>;
  loadThread: (thread: Thread) => Promise<void>;
  editDraft: (value: string) => void;
  focusComposer: () => void;
  restoreComposerFocus: (origin: Element | null) => void;
};

export function createMessageActions({
  composer,
  conversations,
  drafts,
  history,
  runtime,
  selectedRef,
  request,
  stickToBottom,
  rewindSwitch,
  replacementOptions,
  entries,
  nextTurn,
  submitDraft,
  setRuntimeNotices,
  setMessageEdits,
  setNextTurn,
  setEntries,
  setThreads,
  setRewindBusy,
  setRewindActions,
  setMessageVersions,
  loadThread,
  editDraft,
  focusComposer,
  restoreComposerFocus,
}: Inputs) {
  const { textRef } = composer;
  const { hidden, upsertThread } = conversations;
  const { savedDraft, savedAttachments, saveDraft } = drafts;
  const { transcripts } = history;
  const { markTurnStarted } = runtime;
  /** Edit-and-resend and regenerate: Elpis replaces the turn and every later one, then runs the new text. */
  async function replaceFrom(turnId: string, replacement: string, editKey?: string, retryModel?: string) {
    const thread = selectedRef.current;
    if (!thread) return;
    const originalFocus = document.activeElement,
      originalRequest = request.current;
    if (savedDraft(`recovery-${thread.id}`) || savedAttachments(`recovery-${thread.id}`).length)
      throw new Error("Recover the saved edited message before replacing another turn.");
    const eligibility = replacementOptions.get(turnId);
    if (!eligibility?.allowed)
      throw new Error(
        eligibility && !eligibility.allowed ? eligibility.reason : "The complete input for this turn is unavailable.",
      );
    const index = entries.findIndex(entry => entry.turnId === turnId);
    const stale = new Set(entries.slice(Math.max(index, 0)).map(entry => entry.turnId));
    const overrides = retryModel ? { ...nextTurn[thread.id], model: retryModel } : nextTurn[thread.id];
    const sendReplacement = () =>
      api<{ turn?: { id: string }; rewound?: boolean; sendError?: string }>(
        `/threads/${encodeURIComponent(thread.id)}/revert`,
        { beforeTurnId: turnId, text: replacement, ...(overrides?.model ? { model: overrides.model } : {}) },
      );
    const result = editKey ? await submitDraft(editKey, sendReplacement) : await sendReplacement();
    if (result.rewound && result.sendError) {
      saveDraft(`recovery-${thread.id}`, replacement);
      if (selectedRef.current?.id === thread.id) await loadThread(thread);
      setRuntimeNotices(prev => ({
        ...prev,
        [thread.id]: `${result.sendError} Your edited message is saved separately below; your composer draft is unchanged.`,
      }));
      return;
    }
    if (!result.turn)
      throw new Error("Elpis did not acknowledge the replacement turn. Check the conversation before retrying.");
    if (editKey)
      setMessageEdits(previous => (previous[editKey] === replacement ? without(previous, editKey) : previous));
    const startedTurn = result.turn;
    if (overrides) setNextTurn(prev => without(prev, thread.id));
    if (selectedRef.current?.id === thread.id) {
      stickToBottom.current = true;
      announceScrollIntent();
      setEntries(prev => prev.filter(entry => !stale.has(entry.turnId)));
    }
    markTurnStarted(thread.id, startedTurn.id);
    loadVersions(thread.id);
    if (request.current === originalRequest && selectedRef.current?.id === thread.id)
      restoreComposerFocus(originalFocus);
  }
  /** "Rewind to here": Elpis drops the turn and every later one (thread/revert, as edit-and-resend does) without sending anything;
   * the turn's prompt returns to an empty message box when it can be resent as text. */
  async function rewindFrom(turnId: string, mode: RestoreMode, version?: string) {
    const thread = selectedRef.current;
    if (!thread) return;
    const prompt = replacementOptions.get(turnId);
    await switchRewind(
      { action: "restore", beforeTurnId: turnId, mode, ...(version ? { version } : {}) },
      mode === "code",
    );
    if (mode !== "code" && prompt?.allowed && !textRef.current.trim()) editDraft(prompt.prompt);
    if (mode !== "code") focusComposer();
  }
  // 3 Nov, Masih: "delete should be available too - to delete messages". The conversation goes back to before this
  // message (the engine can only cut a conversation at a point); files stay; Undo brings it back until the next send.
  async function deleteFrom(turnId: string) {
    await switchRewind({ action: "restore", beforeTurnId: turnId, mode: "conversation" });
    focusComposer();
  }
  /** The chat on screen gives way to `next` (a rewound copy or another version): read afresh, and the old one leaves the list. */
  async function replaceShownChat(previous: Thread, next: Thread) {
    transcripts.current.delete(next.id);
    hidden.current.delete(next.id);
    upsertThread(next);
    if (next.id !== previous.id) {
      hidden.current.add(previous.id);
      setThreads(prev => prev.filter(item => item.id !== previous.id));
    }
    setEntries([]);
    await loadThread(next);
  }
  async function switchRewind(
    body: { action: string; beforeTurnId?: string; mode?: RestoreMode; version?: string },
    filesOnly = false,
  ) {
    const thread = selectedRef.current;
    if (!thread) return;
    const draft = textRef.current;
    rewindSwitch.current = thread.id;
    setRewindBusy(true);
    try {
      const result = await api<{ thread?: Thread; undo?: "undo" | "redo" }>(
        `/threads/${encodeURIComponent(thread.id)}/rewind`,
        body,
      );
      if (filesOnly || selectedRef.current?.id !== thread.id) return;
      const next = result.thread ?? thread;
      await replaceShownChat(thread, next);
      if (draft.trim()) editDraft(draft);
      setRewindActions(prev => ({ ...prev, [thread.id]: undefined, [next.id]: result.undo }));
    } finally {
      rewindSwitch.current = null;
      setRewindBusy(false);
    }
  }
  function loadVersions(id: string, stale = () => false) {
    api<{ versions?: MessageVersion[] }>(`/threads/${encodeURIComponent(id)}/versions`, { action: "list" })
      .then(result => {
        if (!stale()) setMessageVersions(prev => ({ ...prev, [id]: result.versions ?? [] }));
      })
      .catch(() => {});
  }
  /** ‹ / ›: the chat shows another version of an edited message; that version's chat takes this one's place. */
  async function showVersion(target: string) {
    const thread = selectedRef.current;
    if (!thread) return;
    // The switch archives this chat; its archive notice must not close the chat that replaces it (as for Rewind).
    rewindSwitch.current = thread.id;
    try {
      const result = await api<{ thread: Thread }>(`/threads/${encodeURIComponent(thread.id)}/versions`, {
        action: "switch",
        threadId: target,
      });
      if (!result.thread || typeof result.thread.id !== "string") throw unreadable("version");
      if (selectedRef.current?.id !== thread.id) return;
      await replaceShownChat(thread, result.thread);
    } finally {
      rewindSwitch.current = null;
    }
  }
  return { replaceFrom, rewindFrom, deleteFrom, switchRewind, loadVersions, showVersion };
}

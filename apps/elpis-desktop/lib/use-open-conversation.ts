import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { api, retryableSessionError, unreadable, type Entry, type Thread } from "@/lib/api";
import { activate, tabFor } from "@/lib/chat-tabs";
import { historyPath, type HistoryPage } from "@/lib/chat-history";
import { errorText } from "@/lib/error-text.mjs";
import { mergeHistoryWithLive } from "@/lib/live-events";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import { without } from "@/lib/utils";
import type { Live, View } from "@/lib/workspace-types";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Ref<T> = RefObject<T>;
type OpenInputs = {
  runtime: ReturnType<typeof useRuntimeState>; conversations: ReturnType<typeof useConversationList>;
  history: ReturnType<typeof useTranscriptHistory>; drafts: ReturnType<typeof useDraftStore>; attachments: ReturnType<typeof useComposerAttachments>;
  tabsRef: ReturnType<typeof useChatTabs>["tabsRef"]; updateTabs: ReturnType<typeof useChatTabs>["updateTabs"];
  selectedRef: Ref<Thread | null>; newDraftKey: Ref<string>; textRef: Ref<string>; setText: (text: string) => void;
  markRead: (id: string) => void; request: Ref<number>; stickToBottom: Ref<boolean>; followingBottom: Ref<boolean>;
  restoreScroll: Ref<{ height: number; top: number } | null>; setView: Setter<View>; setSidebar: Setter<boolean>;
  setLoading: Setter<boolean>; setError: Setter<string>; setEntries: Setter<Entry[]>;
  rememberModes: (id: string, live: Live) => void;
};

export function useOpenConversation({ runtime, conversations, history, drafts, attachments, tabsRef, updateTabs, selectedRef, newDraftKey, textRef, setText, markRead, request, stickToBottom, followingBottom, restoreScroll, setView, setSidebar, setLoading, setError, setEntries, rememberModes }: OpenInputs) {
  const { setHistoryOnly, turnRevisions, modeRevisions, setActiveTurns, completedTurns, setLiveError } = runtime;
  const { select, remember, upsertThread, statusRevisions } = conversations;
  const { liveRevision, liveVersions, liveKeysAfter, applyHistoryPage, noteHistoryGap, transcripts, prefetching, setItemCursor } = history;
  const { saveDraft, savedDraft } = drafts;
  const { restoreAttachments } = attachments;
  const rememberFollowing = useCallback((id: string, live: Live) => {
    setHistoryOnly(previous => live.followingLive === false ? { ...previous, [id]: true } : without(previous, id));
  }, []);
  const reconcileLiveThread = useCallback((id: string, live: Live) => {
    remember(live.thread); upsertThread(live.thread);
    if (selectedRef.current?.id === id) select({ ...selectedRef.current, ...live.thread });
    if (live.thread.status) statusRevisions.current[id] = (statusRevisions.current[id] ?? 0) + 1;
    turnRevisions.current[id] = (turnRevisions.current[id] ?? 0) + 1;
    setActiveTurns(previous => live.activeTurnId && !completedTurns.current.has(live.activeTurnId) ? { ...previous, [id]: live.activeTurnId } : without(previous, id));
    setLiveError(previous => without(previous, id));
  }, [select, upsertThread]);

  const loadThread = useCallback(async (thread: Thread) => {
    markRead(thread.id);
    // A chat that is already open in another tab brings that tab forward instead of opening twice.
    const owner = tabFor(tabsRef.current, thread.id);
    if (owner && owner.id !== tabsRef.current.activeId) updateTabs(activate(tabsRef.current, owner.id));
    saveDraft(selectedRef.current?.id || newDraftKey.current, textRef.current); setText(savedDraft(thread.id));
    const id = ++request.current; stickToBottom.current = true; followingBottom.current = false; restoreScroll.current = null;
    liveVersions.current.clear(); const historyRevision = liveRevision.current;
    let unread = false;
    const shown = transcripts.current.get(thread.id);
    select(thread); setView("chat"); setSidebar(false); setEntries(shown?.entries ?? []); setItemCursor(shown?.cursor ?? null); setLoading(true); setError(""); restoreAttachments(thread.id);
    try {
      const result = await api<HistoryPage & { thread: Thread }>(historyPath(thread.id)); if (!Array.isArray(result.data)) throw unreadable("conversations"); if (!result.thread || typeof result.thread.id !== "string") throw unreadable("conversation");
      if (request.current !== id) return;
      select(remember(result.thread)); applyHistoryPage(thread.id, result, historyRevision);
      // The engine lists a chat's items only once it has loaded the chat; until then a saved chat reads as empty. Like
      // the Codex TUI, which resumes before it reads history, read it again once the resume below has loaded it.
      unread = !result.data.length && !result.nextCursor;
    } catch (e) {
      // 5 Nov, Masih: "this error doesn't even need to show ... the chat was loaded when this error showed." A chat already
      // on screen from its saved copy stays as it is; only a chat with nothing to show reports the failure.
      // The hover's early read may have landed while this one failed: show its copy instead of an error.
      await prefetching.current.get(thread.id);
      const landed = !shown && request.current === id ? transcripts.current.get(thread.id) : undefined;
      if (landed) { setEntries(previous => mergeHistoryWithLive(previous, landed.entries, liveKeysAfter(historyRevision))); setItemCursor(landed.cursor); }
      if (request.current !== id) return;
      if (!shown && !landed) { if (!retryableSessionError(e)) setError(String(e)); return; }
      // Something is on screen: still follow the chat live below, which re-reads it if that fails.
    }
    finally { if (request.current === id) setLoading(false); }
    // Follow it live in this app: subscribe, and learn the turn it is running now.
    try {
      const turnRevision = turnRevisions.current[thread.id], modeRevision = modeRevisions.current[thread.id];
      const live = await api<Live>(`/threads/${encodeURIComponent(thread.id)}/resume`, {});
      if (request.current !== id || live.thread?.id !== thread.id) return;
      rememberFollowing(thread.id, live);
      if (modeRevisions.current[thread.id] === modeRevision) rememberModes(thread.id, live);
      if (turnRevisions.current[thread.id] === turnRevision) reconcileLiveThread(thread.id, live);
      if (unread || live.thread?.canAcceptDirectInput === false) {
        const again = await api<HistoryPage>(historyPath(thread.id));
        if (request.current === id && Array.isArray(again.data)) { applyHistoryPage(thread.id, again, historyRevision); }
      }
    } catch (e) { if (request.current === id) setLiveError(prev => ({ ...prev, [thread.id]: errorText(e) })); }
  }, [select, setText, reconcileLiveThread, rememberFollowing, saveDraft, savedDraft, liveKeysAfter, applyHistoryPage, restoreAttachments, updateTabs, markRead, noteHistoryGap]);

  // Navigation to the visible chat preserves its live transcript, draft and scroll. Explicit reloads still use loadThread.
  const openThread = useCallback(async (thread: Thread) => {
    if (selectedRef.current?.id === thread.id) { markRead(thread.id); setView("chat"); setSidebar(false); return; }
    await loadThread(thread);
  }, [loadThread, markRead]);

  return { rememberFollowing, reconcileLiveThread, loadThread, openThread };
}

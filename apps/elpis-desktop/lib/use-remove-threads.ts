import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { forgetChats } from "@/lib/chat-tabs";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useComposerAttachments } from "@/lib/use-composer-attachments";
import type { useDraftStore } from "@/lib/use-drafts";
import type { useSidebarSelection } from "@/lib/use-sidebar-selection";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useBrowser } from "@/components/browser-panel";

type Inputs = {
  session: ReturnType<typeof useConversationSession>; conversations: ReturnType<typeof useConversationList>;
  history: ReturnType<typeof useTranscriptHistory>; composer: ReturnType<typeof useComposerState>;
  attachments: ReturnType<typeof useComposerAttachments>; drafts: ReturnType<typeof useDraftStore>;
  selection: ReturnType<typeof useSidebarSelection>; runtime: ReturnType<typeof useRuntimeState>;
  tabs: ReturnType<typeof useChatTabs>; browser: ReturnType<typeof useBrowser>; newDraftKey: RefObject<string>;
  setMessageEdits: Dispatch<SetStateAction<Record<string, string>>>;
};

export function useRemoveThreads({ session, conversations, history, composer, attachments, drafts, selection, runtime, tabs, browser, newDraftKey, setMessageEdits }: Inputs) {
  const { selectedRef, request, setThreads, setEntries } = session;
  const { select, threadsRef, hidden } = conversations, { transcripts, setItemCursor } = history;
  const { setText } = composer, { restoreAttachments } = attachments, { savedDraft } = drafts;
  const { setMarked } = selection, { setApprovals } = runtime, { tabsRef, updateTabs } = tabs;
  return useCallback((ids: Set<string>, permanent: boolean) => {
    for (let grew = true; grew;) { grew = false; for (const thread of threadsRef.current) if (thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id)) { ids.add(thread.id); grew = true; } }
    for (const id of ids) { hidden.current.add(id); transcripts.current.delete(id); browser.closeSession(id); }
    if (permanent) {
      drafts.forget(ids);
      setMessageEdits(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !ids.has((JSON.parse(key) as [string, string, string])[0]))));
    }
    updateTabs(forgetChats(tabsRef.current, ids));
    setThreads(prev => prev.filter(thread => !ids.has(thread.id)));
    setMarked(prev => prev.some(id => ids.has(id)) ? prev.filter(id => !ids.has(id)) : prev);
    setApprovals(prev => prev.filter(approval => !ids.has(approval.params.threadId ?? "")));
    if (selectedRef.current && ids.has(selectedRef.current.id)) { request.current++; select(null); setText(savedDraft(newDraftKey.current)); restoreAttachments(newDraftKey.current); setEntries([]); setItemCursor(null); }
  }, [select, setText, savedDraft, restoreAttachments, updateTabs, browser.closeSession]);
}

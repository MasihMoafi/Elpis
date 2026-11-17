import { useEffect, type RefObject } from "react";
import { useHistoryFallback } from "@/lib/use-history-fallback";
import { useRelatedConversations } from "@/lib/use-related-conversations";
import { useTranscriptPresentation } from "@/lib/use-transcript-presentation";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useChildConversations } from "@/lib/use-child-conversations";
import type { View } from "@/lib/workspace-types";

type Inputs = {
  session: ReturnType<typeof useConversationSession>;
  runtime: ReturnType<typeof useRuntimeState>;
  history: ReturnType<typeof useTranscriptHistory>;
  conversations: ReturnType<typeof useConversationList>;
  children: ReturnType<typeof useChildConversations>;
  view: View;
  showAgentRuns: boolean;
  agentRunsOpen: boolean;
  newDraftKey: RefObject<string>;
  autoRead: (id: string, turn?: string) => void;
  markRead: (id: string) => void;
  pending: Record<string, string[]>;
};

export function useConversationView({
  session,
  runtime,
  history,
  conversations,
  children,
  view,
  showAgentRuns,
  agentRunsOpen,
  newDraftKey,
  autoRead,
  markRead,
  pending,
}: Inputs) {
  const {
    selected,
    threads,
    entries,
    submissions,
    setSubmissions,
    scroll,
    restoreScroll,
    pendingPosition,
    stickToBottom,
    loading,
    displayedThreadId,
    readIntent,
    setReadIntent,
    request,
  } = session;
  const { ready, liveError } = runtime,
    { loadChildren } = children;
  const selectedTeamId = selected?.parentThreadId ?? selected?.id;
  useEffect(() => {
    if (ready && selectedTeamId) void loadChildren(selectedTeamId);
  }, [ready, selectedTeamId, loadChildren]);
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useHistoryFallback({ session, selectedLiveError, view, history, conversations });
  const related = useRelatedConversations(selected, threads, showAgentRuns, agentRunsOpen);
  const { shownEntries, newestPrompt } = useTranscriptPresentation({
    selected,
    entries,
    submissions,
    setSubmissions,
    newDraftKey,
    scroll,
    restoreScroll,
    pendingPosition,
    stickToBottom,
    loading,
    view,
  });
  useEffect(() => {
    const readDisplayed = () => {
      if (view !== "chat" || !selected || displayedThreadId !== selected.id || loading ||
          document.visibilityState !== "visible" || !document.hasFocus()) return;
      const outstanding = new Set(pending[selected.id] ?? []);
      const turns = new Set(shownEntries.filter(entry =>
        (entry.item.type === "agentMessage" || entry.item.type === "plan") &&
        (!entry.item.phase || entry.item.phase === "final_answer") &&
        typeof entry.item.text === "string" && entry.item.text.trim(),
      ).map(entry => entry.turnId));
      if (readIntent?.id === selected.id && readIntent.request === request.current && turns.size &&
          [...outstanding].every(turn => turns.has(turn))) {
        setReadIntent(null);
        markRead(selected.id);
        return;
      }
      for (const turn of turns) if (outstanding.has(turn)) autoRead(selected.id, turn);
    };
    readDisplayed();
    window.addEventListener("focus", readDisplayed);
    document.addEventListener("visibilitychange", readDisplayed);
    return () => {
      window.removeEventListener("focus", readDisplayed);
      document.removeEventListener("visibilitychange", readDisplayed);
    };
  }, [view, selected?.id, displayedThreadId, loading, shownEntries, pending, autoRead, readIntent, markRead]);
  return { selectedLiveError, related, shownEntries, newestPrompt };
}

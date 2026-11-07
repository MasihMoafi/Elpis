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
  session: ReturnType<typeof useConversationSession>; runtime: ReturnType<typeof useRuntimeState>;
  history: ReturnType<typeof useTranscriptHistory>; conversations: ReturnType<typeof useConversationList>;
  children: ReturnType<typeof useChildConversations>; view: View; showAgentRuns: boolean; agentRunsOpen: boolean;
  newDraftKey: RefObject<string>;
};

export function useConversationView({ session, runtime, history, conversations, children, view, showAgentRuns, agentRunsOpen, newDraftKey }: Inputs) {
  const { selected, threads, entries, submissions, setSubmissions, scroll, restoreScroll, pendingPosition, stickToBottom } = session;
  const { ready, liveError } = runtime, { loadChildren } = children;
  const selectedTeamId = selected?.parentThreadId ?? selected?.id;
  useEffect(() => { if (ready && selectedTeamId) void loadChildren(selectedTeamId); }, [ready, selectedTeamId, loadChildren]);
  // Chats this app could not subscribe to are refreshed by reading them instead.
  const selectedLiveError = selected ? liveError[selected.id] : undefined;
  useHistoryFallback({ session, selectedLiveError, view, history, conversations });
  const related = useRelatedConversations(selected, threads, showAgentRuns, agentRunsOpen);
  const { shownEntries, newestPrompt } = useTranscriptPresentation({ selected, entries, submissions, setSubmissions, newDraftKey, scroll, restoreScroll, pendingPosition, stickToBottom, view });
  return { selectedLiveError, related, shownEntries, newestPrompt };
}

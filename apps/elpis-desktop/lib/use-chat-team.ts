import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { agentColourSlots } from "@/components/agent-identity";
import { agentState } from "@/lib/agents";
import { prioritizeChats } from "@/lib/chat-groups";
import type { Thread } from "@/lib/api";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useRuntimeState } from "@/lib/use-runtime-state";

export type AgentPanelState = { open: boolean; held: ReadonlySet<string> };
type Inputs = {
  session: ReturnType<typeof useConversationSession>; runtime: ReturnType<typeof useRuntimeState>;
  find: (id?: string | null) => Thread | undefined; checkedChildren: RefObject<Set<string>>;
  workingAgentsOnly: boolean; agentsPanelState: AgentPanelState; setAgentsPanelState: Dispatch<SetStateAction<AgentPanelState>>;
  panelShown: boolean;
};

export function useChatTeam({ session, runtime, find, checkedChildren, workingAgentsOnly, agentsPanelState, setAgentsPanelState, panelShown }: Inputs) {
  const { selected, threads, loading } = session;
  const { approvals, ready, connected } = runtime;
  const waitingIds = new Set(approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId));
  // The chat's team: a root shows its agents; an agent shows its siblings and the way back to the root.
  const teamRoot = selected ? (selected.parentThreadId ? find(selected.parentThreadId) ?? { id: selected.parentThreadId } as Thread : selected) : null;
  const team = teamRoot ? prioritizeChats(threads.filter(thread => thread.parentThreadId === teamRoot.id), thread => agentState(thread, waitingIds)) : [];
  const workingTeam = team.filter(thread => agentState(thread, waitingIds) === "working");
  const shownTeam = workingAgentsOnly ? workingTeam : team;
  const agentColours = useMemo(() => agentColourSlots(threads), [threads]);
  const agentsPanel = agentsPanelState.open && !(selected && teamRoot && (agentsPanelState.held.has(selected.id) || agentsPanelState.held.has(teamRoot.id)));
  const awaitingTeam = !!(selected && teamRoot && agentsPanel && !panelShown && ready && connected &&
    ((!checkedChildren.current.has(teamRoot.id) && !team.length) || (loading && !find(selected.id))));
  const openAgentsPanel = () => setAgentsPanelState(previous => {
    const held = new Set(previous.held);
    if (selected) held.delete(selected.id);
    if (teamRoot) held.delete(teamRoot.id);
    return { open: true, held };
  });
  return { waitingIds, teamRoot, team, workingTeam, shownTeam, agentColours, agentsPanel, awaitingTeam, openAgentsPanel };
}

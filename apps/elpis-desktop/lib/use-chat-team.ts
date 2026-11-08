import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { agentColourSlots } from "@/components/agent-identity";
import { agentParentId } from "@/lib/agent-runs.mts";
import { agentState } from "@/lib/agents";
import { prioritizeChats, sidebarParents, type ChatGroups } from "@/lib/chat-groups";
import type { Thread } from "@/lib/api";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useRuntimeState } from "@/lib/use-runtime-state";

export type AgentPanelState = { open: boolean; held: ReadonlySet<string> };
type Inputs = {
  session: ReturnType<typeof useConversationSession>;
  runtime: ReturnType<typeof useRuntimeState>;
  find: (id?: string | null) => Thread | undefined;
  checkedChildren: RefObject<Set<string>>;
  workingAgentsOnly: boolean;
  agentsPanelState: AgentPanelState;
  setAgentsPanelState: Dispatch<SetStateAction<AgentPanelState>>;
  panelShown: boolean;
  chatGroups: ChatGroups;
};

export function useChatTeam({
  session,
  runtime,
  find,
  checkedChildren,
  workingAgentsOnly,
  agentsPanelState,
  setAgentsPanelState,
  panelShown,
  chatGroups,
}: Inputs) {
  const { selected, threads, loading } = session;
  const { approvals, ready, connected } = runtime;
  const waitingIds = new Set(approvals.map(approval => approval.params.threadId ?? approval.ownerThreadId));
  // Use the same saved placement as the sidebar while keeping the engine's recorded lineage intact.
  const parents = useMemo(
    () =>
      sidebarParents(
        threads.map(thread => thread.id),
        chatGroups,
        Object.fromEntries(threads.map(thread => [thread.id, agentParentId(thread)])),
      ),
    [threads, chatGroups],
  );
  const selectedParent = selected && agentParentId(selected) ? parents[selected.id] : undefined;
  const teamRoot = selected
    ? selectedParent
      ? (find(selectedParent) ?? ({ id: selectedParent } as Thread))
      : selected
    : null;
  const team = teamRoot
    ? prioritizeChats(
        threads.filter(thread => agentParentId(thread) && parents[thread.id] === teamRoot.id),
        thread => agentState(thread, waitingIds),
      )
    : [];
  const workingTeam = team.filter(thread => agentState(thread, waitingIds) === "working");
  const shownTeam = workingAgentsOnly ? workingTeam : team;
  const agentColours = useMemo(() => agentColourSlots(threads), [threads]);
  const agentsPanel =
    agentsPanelState.open &&
    !(selected && teamRoot && (agentsPanelState.held.has(selected.id) || agentsPanelState.held.has(teamRoot.id)));
  const awaitingTeam = !!(
    selected &&
    teamRoot &&
    agentsPanel &&
    !panelShown &&
    ready &&
    connected &&
    ((!checkedChildren.current.has(teamRoot.id) && !team.length) || (loading && !find(selected.id)))
  );
  const openAgentsPanel = () =>
    setAgentsPanelState(previous => {
      const held = new Set(previous.held);
      if (selected) held.delete(selected.id);
      if (teamRoot) held.delete(teamRoot.id);
      return { open: true, held };
    });
  return {
    waitingIds,
    teamRoot,
    team,
    workingTeam,
    shownTeam,
    agentColours,
    agentsPanel,
    awaitingTeam,
    openAgentsPanel,
  };
}

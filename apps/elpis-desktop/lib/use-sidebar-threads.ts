import { useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MenuAction } from "@/components/action-menu";
import { useChatListOrder } from "@/components/chat-groups";
import { agentParentId } from "@/lib/agent-runs.mts";
import { agentState, mergeListedThreads } from "@/lib/agents";
import { isAgent, isAgentRun, title, type Thread } from "@/lib/api";
import { groupSections, prioritizeChats, sidebarParents, sortChats, type ChatGroups } from "@/lib/chat-groups";
import { errorText } from "@/lib/error-text.mts";
import { chatOrigin } from "@/lib/love-activity";
import { LOVE_SPOT_CHAT, useLoveChatCharacters } from "@/lib/use-love-chat-characters";
import { savePreferences, type useAppPreferences } from "@/lib/preferences";
import { rankBySearch } from "@/lib/search-rank";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useSidebarSearch } from "@/lib/use-sidebar-search";
import type { useChatAttention } from "@/lib/use-sidebar-state";
import { workflowMembers, type WorkflowRun } from "@/lib/workflow-identity";
import { useWorkflowSidebar } from "@/lib/use-workflow-sidebar";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  ready: boolean; connected: boolean; threads: Thread[]; hidden: ReturnType<typeof useConversationList>["hidden"];
  selected: Thread | null; chatGroups: ChatGroups; loveActivity: ReturnType<typeof useLoveActivity>; expanded: Record<string, boolean>;
  setExpanded: Setter<Record<string, boolean>>; recordedWorkflow: Pick<WorkflowRun, "id" | "rootThreadId"> | undefined;
  loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>; search: ReturnType<typeof useSidebarSearch>;
  attention: ReturnType<typeof useChatAttention>["attention"]; waitingIds: Set<string>; pins: string[]; projectChats: Record<string, string>;
  releaseChatOrder: RefObject<() => void>; searchInput: RefObject<HTMLInputElement | null>; setError: Setter<string>;
  setDeleteRunHistory: Setter<boolean>; setDeleteTargets: Setter<Thread[] | null>; hiddenPages: string[];
  preferences: ReturnType<typeof useAppPreferences>; collapsedSections: Record<string, boolean>; collapsedProjects: Record<string, boolean>;
  checkedChildren: RefObject<Set<string>>; agentRunsOpen: boolean;
};

export function useSidebarThreads({ ready, connected, threads, hidden, selected, chatGroups, loveActivity, expanded, setExpanded, recordedWorkflow, loadChildren, search, attention, waitingIds, pins: manualPins, projectChats, releaseChatOrder, searchInput, setError, setDeleteRunHistory, setDeleteTargets, hiddenPages, preferences, collapsedSections, collapsedProjects, checkedChildren, agentRunsOpen }: Inputs) {
  const pins = [...manualPins, ...threads.filter(thread => thread.motherAgent).map(thread => thread.id)];
  const searchTerm = search.searchTerm;
  const loveChatCharacter = useLoveChatCharacters(threads, selected, preferences);
  const { catalog: workflowCatalog, runs: workflowRuns, roots: workflowRoots, steps: workflowSteps, sidebarTitle: workflowTitle } = useWorkflowSidebar(ready && connected, threads, hidden,
    ended => setExpanded(previous => ({ ...previous, ...Object.fromEntries(ended.map(run => [`workflow:${run.id}`, false])) })));
  const selectedWorkflow = selected ? workflowRoots.get(selected.id) : undefined;
  const sidebarThreads = useMemo(() => [...threads, ...[...workflowRoots.values()].filter(run => !threads.some(thread => thread.id === run.rootThreadId)).map(run => ({ id: run.rootThreadId, name: run.name, status: { type: run.status === "running" ? "active" : "idle" } } as Thread))], [threads, workflowRoots]);
  const nativeParents = useMemo(() => Object.fromEntries(sidebarThreads.map(thread => [thread.id, agentParentId(thread) ?? workflowSteps.get(thread.id)?.parent ?? null])), [sidebarThreads, workflowSteps]);
  const treeParents = useMemo(() => sidebarParents(sidebarThreads.map(thread => thread.id), chatGroups, nativeParents), [sidebarThreads, chatGroups.parents, nativeParents]);
  const sidebarParent = (thread: Thread) => treeParents[thread.id];
  const originOf = (thread: Thread) => workflowRoots.has(thread.id) || workflowSteps.has(thread.id) ? "Workflows" : chatOrigin(thread, loveActivity.threads);
  const branchOpen = (id: string) => expanded[id] ?? false;
  const workflowOpen = (run: WorkflowRun) => expanded[`workflow:${run.id}`] ?? false;
  const workflowChild = (child: Thread, run: WorkflowRun) => {
    const owner = workflowSteps.get(child.id);
    return !owner?.mother && !owner?.check && sidebarParent(child) === run.rootThreadId && (owner?.parent === run.rootThreadId
      ? owner.runId === run.id : workflowRoots.get(run.rootThreadId)?.id === run.id);
  };
  // Follow agents whose parent is expanded in the sidebar. An expanded workflow is keyed `workflow:<run id>`: follow its
  // chat, as its Expand button does; the bridge refuses any other key as an invalid thread ID.
  const observedIds = JSON.stringify([...new Set(Object.keys(expanded).filter(id => expanded[id]).flatMap(id => id.startsWith("workflow:")
    ? workflowRuns.filter(run => `workflow:${run.id}` === id).map(run => run.rootThreadId) : [id]).concat(selectedWorkflow ? [selectedWorkflow.rootThreadId] : [], recordedWorkflow ? [recordedWorkflow.rootThreadId] : []))].sort());
  useEffect(() => {
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const ids = JSON.parse(observedIds) as string[];
        for (let start = 0; start < ids.length && !disposed; start += 3) await Promise.all(ids.slice(start, start + 3).map(id => loadChildren(id, undefined, false)));
      } catch { /* The next refresh tries again. */ }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [observedIds, loadChildren]);
  const searchedThreads = search.results ? mergeListedThreads(sidebarThreads, search.results.data, hidden.current) : sidebarThreads;
  const matchedOnServer = new Set(search.results?.data.map(thread => thread.id) ?? []);
  const unreadIds = new Set(attention.unread);
  const sidebarState = (thread: Thread) => agentState(thread, waitingIds, unreadIds);
  const needsYou = (thread: Thread) => sidebarState(thread) === "waiting" || !!attention.plans[thread.id];
  // Working chats stay first; the selected sort orders chats within each status tier.
  const isTreeChat = (thread: Thread) => !isAgentRun(thread) || !!agentParentId(thread) || Object.hasOwn(chatGroups.parents ?? {}, thread.id) || workflowSteps.has(thread.id);
  // S18: Pinned, Projects, Groups and Recents list only the chats Masih started himself. Workflow runs
  // keep their Workflows section; agent runs (codex exec, including the "Task ID …" chats) and agents or chats whose maker is
  // not listed sit in Background runs; both sections follow their switches, off by default. Other agents nest under their parent.
  // A chat he placed himself (pinned, moved, in a project or a group) counts as his.
  const placedByHim = (thread: Thread) => pins.includes(thread.id) || Object.hasOwn(chatGroups.parents ?? {}, thread.id) || !!projectChats[thread.id] || !!chatGroups.members?.[thread.id];
  const ownChat = (thread: Thread) => placedByHim(thread) || (!isAgentRun(thread) && !agentParentId(thread) && originOf(thread) !== "Workflows");
  const sortedChats = sortChats(sidebarThreads.filter(isTreeChat), chatGroups.sortBy, title, chatGroups.order);
  const chatListOrder = useChatListOrder(prioritizeChats(sortedChats, thread => sidebarState(thread) === "working" ? "working" : needsYou(thread) ? "waiting" : sidebarState(thread)));
  releaseChatOrder.current = chatListOrder.release;
  // Hover holds ordinary rows still, but a newly working chat must still rise immediately. Once it finishes with an unread
  // reply (or needs him) it stays risen, right after the working chats, until the hold ends (1 Nov: "the unread chat that's
  // just finished should show after the working chats; no idle chat should sit in between them").
  const roseWhileHeld = useRef(new Set<string>());
  if (!chatListOrder.holding) roseWhileHeld.current.clear();
  else for (const thread of chatListOrder.chats) if (sidebarState(thread) === "working") roseWhileHeld.current.add(thread.id);
  const ordinaryThreads = prioritizeChats(chatListOrder.chats, thread => sidebarState(thread) === "working" ? "working"
    : roseWhileHeld.current.has(thread.id) && (needsYou(thread) || sidebarState(thread) === "unread") ? "waiting" : "idle");
  // Missing parents never hide chats (for example, when only part of history is loaded).
  const ordinaryIds = useMemo(() => new Set(sidebarThreads.map(thread => thread.id)), [sidebarThreads]);
  const displayParentIds = useMemo(() => new Set(Object.values(chatGroups.parents ?? {}).filter((id): id is string => !!id)), [chatGroups.parents]);
  const agentRuns = threads.filter(thread => isAgentRun(thread) && !isTreeChat(thread));
  const agentRunIds = new Set(agentRuns.map(thread => thread.id));
  const agentParents = new Set(Object.values(treeParents));
  const runActions: MenuAction[] = [
    { id: "hide", label: "Hide Agent runs", run: () => {
      try { savePreferences({ showAgentRuns: false }); requestAnimationFrame(() => searchInput.current?.focus()); }
      catch (cause) { setError(`Could not save this preference: ${errorText(cause)}`); }
    } },
    { id: "delete", label: agentRuns.length > 100 ? "Delete 100 Agent runs…" : "Delete Agent run history…", destructive: true, run: () => { setDeleteRunHistory(true); setDeleteTargets(agentRuns.slice(0, 100)); } },
  ];
  // The engine's search matches letter case exactly; a listed chat's title and first message match in any case here.
  const filtered = searchedThreads.filter(t => isTreeChat(t) && (matchedOnServer.has(t.id) || `${title(t)} ${t.preview || ""} ${t.agentNickname || ""} ${t.model || ""} ${t.id}`.toLowerCase().includes(searchTerm.toLowerCase())));
  // Search results are one flat list of every matching chat, as in the ChatGPT app: a hit is never hidden in its parent.
  const isOrphan = (thread: Thread) => !searchTerm && !sidebarParent(thread) && !Object.hasOwn(chatGroups.parents ?? {}, thread.id) && !!agentParentId(thread) && !ordinaryIds.has(agentParentId(thread)!);
  const roots = filtered.filter(t => !isOrphan(t) && (!!searchTerm || !sidebarParent(t))).filter(t => searchTerm || (ownChat(t) ? !projectChats[t.id] || pins.includes(t.id) : originOf(t) === "Workflows"));
  // Agents and chats that cannot nest under a listed maker (missing or a broken lineage) join Background runs.
  const unlinked = searchTerm ? [] : filtered.filter(t => isOrphan(t) || (!sidebarParent(t) && !ownChat(t) && originOf(t) !== "Workflows"));
  // The chat list in screen order: Pinned, the groups (when the list is drawn by them), then Recents; sorted as chosen.
  // Search results rank by how well each chat matches (lib/search-rank.ts).
  const rootIds = new Set(roots.map(thread => thread.id));
  const listedRoots = searchTerm ? rankBySearch(roots, searchTerm, title, thread => `${thread.preview || ""} ${thread.agentNickname || ""} ${thread.cwd || ""}`) : ordinaryThreads.filter(thread => rootIds.has(thread.id));
  // A search shows one ranked list: a pinned hit takes its rank among the others.
  const pinnedChats = searchTerm ? [] : listedRoots.filter(t => pins.includes(t.id)), unpinnedChats = searchTerm ? listedRoots : listedRoots.filter(t => !pins.includes(t.id));
  const grouped = !searchTerm && chatGroups.groupBy === "custom" ? groupSections(unpinnedChats.filter(ownChat), chatGroups) : null;
  const ungroupedChats = grouped ? [...grouped.ungrouped, ...unpinnedChats.filter(thread => !ownChat(thread))] : unpinnedChats;
  const loveChats = searchTerm ? [] : ungroupedChats.filter(thread => originOf(thread) === "Love Spot");
  const workflowChats = searchTerm || hiddenPages.includes("canvas") || !preferences.sidebarWorkflows ? [] : ungroupedChats.filter(thread => originOf(thread) === "Workflows");
  const recentChats = searchTerm ? ungroupedChats : ungroupedChats.filter(thread => !originOf(thread));
  const ordered = [...(collapsedSections.pinned && !searchTerm ? [] : pinnedChats), ...(collapsedSections.groups ? [] : grouped?.groups.flatMap(section => chatGroups.collapsed.includes(section.group.id) ? [] : section.chats) ?? []), ...(collapsedSections.love ? [] : loveChats), ...(collapsedSections.workflows ? [] : workflowChats), ...(collapsedSections.recents ? [] : recentChats)];
  /** Mark all as read counts only rows on screen: a chat folded away in a collapsed section or project, a hidden subagent or a
   * background thread never lights it (29 Oct, Masih: "This mark all as read also doesn't make sense when I've already read all of them!"). */
  const shownChats = [...ordered, ...ordinaryThreads.filter(thread => !isAgent(thread) && projectChats[thread.id] && !collapsedProjects[projectChats[thread.id]!] && !collapsedSections.projects && !pins.includes(thread.id))];
  const ordinaryUnread = shownChats.filter(thread => attention.unread.includes(thread.id));
  // An expanded chat owns its visible agents, including background runs. History must not duplicate those rows.
  const inlineAgents = new Set<string>();
  const collectAgents = (id: string, seen = new Set<string>()) => {
    if (!branchOpen(id) || seen.has(id)) return;
    const next = new Set(seen).add(id);
    for (const child of searchedThreads.filter(thread => sidebarParent(thread) === id)) {
      inlineAgents.add(child.id); collectAgents(child.id, next);
    }
  };
  for (const root of shownChats) collectAgents(root.id);
  for (const run of workflowRuns) if (workflowOpen(run) && !collapsedSections.workflows) for (const member of workflowMembers(run)) { inlineAgents.add(member.threadId); collectAgents(member.threadId); }
  const topLevelAgentRuns = agentRuns.filter(thread => !inlineAgents.has(thread.id) && (!thread.parentThreadId || !agentRunIds.has(thread.parentThreadId)));
  // Check newly visible agents once, so only agents with actual children get an expansion control.
  useEffect(() => {
    for (const thread of threads) if ((isAgent(thread) || isAgentRun(thread)) && !checkedChildren.current.has(thread.id)
      && (inlineAgents.has(thread.id) || (preferences.showAgentRuns && agentRunsOpen))) void loadChildren(thread.id, undefined, false);
  });
  const sidebarTitle = (thread: Thread) => { const name = workflowTitle(thread); return name === LOVE_SPOT_CHAT ? loveChatCharacter(thread) : name; };
  return { workflowCatalog, workflowRuns, workflowRoots, workflowSteps, sidebarTitle, selectedWorkflow, sidebarThreads, nativeParents, treeParents, sidebarParent, originOf, branchOpen, workflowOpen, workflowChild, searchedThreads, unreadIds, sidebarState, needsYou, ownChat, chatListOrder, ordinaryThreads, ordinaryIds, displayParentIds, agentRuns, agentParents, runActions, filtered, roots, unlinked, pinnedChats, grouped, loveChats, workflowChats, recentChats, ordered, ordinaryUnread, topLevelAgentRuns };
}

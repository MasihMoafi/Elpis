import type { Dispatch, SetStateAction } from "react";
import { agentParentId } from "@/lib/agent-runs.mts";
import type { Thread } from "@/lib/api";
import { chatSelectionRoots, chatSubtree, moveChats, sidebarParents, type ChatGroups } from "@/lib/chat-groups";
import type { createProjectActions } from "@/lib/project-actions";
import type { useChildConversations } from "@/lib/use-child-conversations";
import type { useProjectState } from "@/lib/use-project-state";
import type { useChatGroups, useSidebarFolds } from "@/lib/use-sidebar-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";

type Setter<T> = Dispatch<SetStateAction<T>>;
type Inputs = {
  model: ReturnType<typeof useSidebarThreads>; projectState: ReturnType<typeof useProjectState>; children: ReturnType<typeof useChildConversations>;
  chatGroups: ReturnType<typeof useChatGroups>["chatGroups"]; updateGroups: ReturnType<typeof useChatGroups>["updateGroups"];
  foldsRef: ReturnType<typeof useSidebarFolds>["foldsRef"]; changeFolds: ReturnType<typeof useSidebarFolds>["changeFolds"];
  pins: string[]; marked: string[]; setMarked: Setter<string[]>; setNewGroupFor: Setter<string[] | null>; setError: Setter<string>;
  assignProject: ReturnType<typeof createProjectActions>["assignProject"]; newProjectFrom: ReturnType<typeof createProjectActions>["newProjectFrom"];
};

export function createSidebarPlacement({ model, projectState, children, chatGroups, updateGroups, foldsRef, changeFolds, pins, marked, setMarked, setNewGroupFor, setError, assignProject, newProjectFrom }: Inputs) {
  const { sidebarParent, treeParents, ordinaryIds, nativeParents, workflowSteps, workflowRoots, sidebarThreads, originOf } = model;
  const { projectChatsRef, setProjectMove, setNestTargets } = projectState;
  const { setExpanded, checkedChildren, loadChildren } = children;
  /** "Move to group" for these chats (the row's chat, or the selection it belongs to), as Claude's session menu has it.
   * Only top-level chats are grouped; an agent's chat stays under its parent. */
  function groupMenu(thread: Thread, ids: string[]) {
    if (sidebarParent(thread)) return undefined;
    const known = (id: string) => chatGroups.groups.some(group => group.id === chatGroups.members[id]) ? chatGroups.members[id] : null;
    const currents = new Set(ids.map(known));
    return { groups: chatGroups.groups, current: currents.size === 1 ? [...currents][0] : undefined,
      onMove: (groupId: string | null) => { updateGroups(state => moveChats(state, ids, groupId)); setMarked([]); },
      onNew: () => setNewGroupFor(ids) };
  }
  const movingIds = (id: string) => chatSelectionRoots(marked.includes(id) ? marked : [id], treeParents);
  function canNest(ids: string[], parent: string) {
    return ordinaryIds.has(parent) && ids.length > 0 && ids.every(id => ordinaryIds.has(id)) && !chatSubtree(ids, treeParents).includes(parent);
  }
  function placementReveal(target: string, state: ChatGroups, memberships: Record<string, string>, moved: string[]) {
    const parents = sidebarParents(Object.keys(nativeParents), state, nativeParents), opened: Record<string, boolean> = {};
    let root = target;
    for (let child of moved.length ? moved : [undefined]) {
      const seen = new Set<string>();
      for (let id: string | undefined = target; id && !seen.has(id); id = parents[id]) {
        seen.add(id); root = id;
        const owner = child ? workflowSteps.get(child) : undefined;
        const runId = owner?.parent === id ? owner.runId : workflowRoots.get(id)?.id;
        if (moved.length) opened[runId ? `workflow:${runId}` : id] = true;
        child = id;
      }
    }
    const thread = sidebarThreads.find(thread => thread.id === root), project = pins.includes(root) ? undefined : memberships[root];
    const orphan = thread && !Object.hasOwn(state.parents ?? {}, root) && agentParentId(thread) && !ordinaryIds.has(agentParentId(thread)!);
    const group = !pins.includes(root) && !project && !orphan && state.groupBy === "custom" ? state.groups.find(group => group.id === state.members[root])?.id : undefined;
    const origin = thread && originOf(thread);
    const section = pins.includes(root) ? "pinned" : project ? "projects" : orphan ? "unlinked" : group ? "groups" : origin === "Workflows" ? "workflows" : origin === "Love Spot" ? "love" : "recents";
    return { opened, section, project, group };
  }
  function revealPlacement(paths: ReturnType<typeof placementReveal>[]) {
    const opened = Object.fromEntries(paths.flatMap(path => Object.entries(path.opened)));
    if (Object.keys(opened).length) setExpanded(previous => ({ ...previous, ...opened }));
    if (paths.some(({ section, project }) => foldsRef.current.sections[section] || project && foldsRef.current.projects[project])) changeFolds(previous => {
      const next = { sections: { ...previous.sections }, projects: { ...previous.projects } };
      for (const { section, project } of paths) { next.sections[section] = false; if (project) next.projects[project] = false; }
      return next;
    });
  }
  async function nestChats(ids: string[], parent: string) {
    await assignProject(ids, projectChatsRef.current[parent] ?? null, parent);
    if (!checkedChildren.current.has(parent)) void loadChildren(parent, undefined, false);
  }
  function organizationActions(thread: Thread) {
    if (!ordinaryIds.has(thread.id)) return {};
    return { onMoveToProject: setProjectMove, onNewProject: newProjectFrom, onPutUnder: setNestTargets,
      ...(movingIds(thread.id).some(id => treeParents[id]) ? { onTakeOut: (chats: Thread[]) => {
        void assignProject(chats.map(chat => chat.id), undefined).catch(cause => setError(String(cause)));
      } } : {}) };
  }
  return { groupMenu, movingIds, canNest, placementReveal, revealPlacement, nestChats, organizationActions };
}

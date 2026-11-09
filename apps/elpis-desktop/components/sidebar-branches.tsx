import { type ReactNode } from "react";
import type { useReorder } from "@/components/reorder";
import type { createSidebarThreadRow } from "@/components/sidebar-thread-row";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/api";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useChatGroups } from "@/lib/use-sidebar-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import { workflowMembers } from "@/lib/workflow-identity";

type Inputs = {
  model: ReturnType<typeof useSidebarThreads>;
  threadRow: ReturnType<typeof createSidebarThreadRow>;
  chatReorder: ReturnType<typeof useReorder>;
  chatGroups: ReturnType<typeof useChatGroups>["chatGroups"];
  updateGroups: ReturnType<typeof useChatGroups>["updateGroups"];
  hidden: ReturnType<typeof useConversationList>["hidden"];
  expanded: Record<string, boolean>;
  childCursors: Record<string, string | null>;
  loadingChildren: Record<string, boolean>;
  searchTerm: string;
  loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>;
  find: (id?: string | null) => Thread | undefined;
};

export function createSidebarBranches({
  model,
  threadRow,
  hidden,
  expanded,
  childCursors,
  loadingChildren,
  searchTerm,
  loadChildren,
  find,
}: Inputs) {
  const {
    ordinaryThreads,
    sidebarParent,
    sidebarTitle,
    workflowRoots,
    branchOpen,
    searchedThreads,
    workflowRuns,
    workflowChild,
    workflowOpen,
  } = model;
  function descendants(parentId: string, depth: number, seen = new Set<string>()): ReactNode {
    if (seen.has(parentId)) return null;
    const next = new Set(seen).add(parentId);
    const children = ordinaryThreads.filter(c => sidebarParent(c) === parentId);
    return (
      <>
        {children.map(child => threadBranch(child, depth, next))}
        {moreChildren(parentId, depth)}
      </>
    );
  }
  function moreChildren(parentId: string, depth: number) {
    const cursor = childCursors[parentId];
    return !searchTerm && cursor && !hidden.current.has(parentId) ? (
      <Button
        variant="ghost"
        size="xs"
        className="thread-more w-full justify-start"
        style={{ paddingLeft: `${depth * 14}px` }}
        disabled={loadingChildren[parentId]}
        onClick={() => void loadChildren(parentId, cursor, false)}
      >
        <span className="truncate">
          More agents from {find(parentId) ? sidebarTitle(find(parentId)!) : "parent conversation"}
        </span>
      </Button>
    ) : null;
  }
  /** `inOrigin`: drawn inside its origin's section (Workflows), which already names the origin (28 Oct: every row there
   * read "… / Workflows"). */
  function threadBranch(thread: Thread, depth = 0, seen = new Set<string>(), inOrigin = false) {
    if (seen.has(thread.id)) return null;
    if (workflowRoots.has(thread.id)) return workflowBranches(thread, depth, seen);
    return (
      <div key={thread.id}>
        {threadRow(thread, depth, inOrigin)}
        {!searchTerm && branchOpen(thread.id) && descendants(thread.id, depth + 1, seen)}
      </div>
    );
  }
  function runDescendants(parentId: string, depth: number, seen = new Set<string>()): ReactNode {
    if (seen.has(parentId)) return null;
    const next = new Set(seen).add(parentId);
    return (
      <>
        {searchedThreads
          .filter(child => sidebarParent(child) === parentId)
          .map(child => (
            <div key={child.id}>
              {threadRow(child, depth)}
              {expanded[child.id] && runDescendants(child.id, depth + 1, next)}
            </div>
          ))}
        {moreChildren(parentId, depth)}
      </>
    );
  }
  /** A listed chat and, when shown, its agents under it. */
  const chatRows = (thread: Thread) => threadBranch(thread);
  function workflowBranches(thread: Thread, depth: number, seen: Set<string>): ReactNode {
    if (seen.has(thread.id)) return null;
    const next = new Set(seen).add(thread.id);
    return workflowRuns
      .filter(run => run.rootThreadId === thread.id)
      .map(run => {
        const order = workflowMembers(run).map(member => member.threadId),
          at = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
        const children = ordinaryThreads.filter(child => workflowChild(child, run)).sort((a, b) => at(a.id) - at(b.id));
        return (
          <div key={run.id}>
            {threadRow(thread, depth, true, run)}
            {!searchTerm && workflowOpen(run) && (
              <>
                {children.map(child => threadBranch(child, depth + 1, next, true))}
                {workflowRoots.get(thread.id)?.id === run.id && moreChildren(thread.id, depth + 1)}
              </>
            )}
          </div>
        );
      });
  }
  /** A group the person made, drawn as a project is: open or closed, its menu (Rename group, Delete group), its chats. A
   * closed group holding a chat that needs you says so, as Claude's does. */
  return { descendants, threadBranch, runDescendants, chatRows };
}

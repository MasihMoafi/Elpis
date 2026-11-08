import type React from "react";
import { Bookmark, ChevronRight } from "lucide-react";
import { AgentIdentity, type agentColourSlots } from "@/components/agent-identity";
import { ReorderItem, type useReorder } from "@/components/reorder";
import { ThreadActions } from "@/components/thread-actions";
import { Button } from "@/components/ui/button";
import { agentState, attentionLine, stateLabels } from "@/lib/agents";
import { isAgent, isAgentRun, title, type Thread } from "@/lib/api";
import { ElpisMarkIcon } from "@/components/elpis-icons";
import { errorText } from "@/lib/error-text.mts";
import { chatOrigin, originLabel } from "@/lib/love-activity";
import { savePreferences, type useAppPreferences } from "@/lib/preferences";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useChatAttention } from "@/lib/use-sidebar-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import { runSummary, type WorkflowRun } from "@/lib/workflow-identity";
import type { View } from "@/lib/workspace-types";

type ThreadProps = React.ComponentProps<typeof ThreadActions>;
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
type Inputs = {
  model: ReturnType<typeof useSidebarThreads>; runtime: ReturnType<typeof useRuntimeState>; loveActivity: ReturnType<typeof useLoveActivity>;
  attention: ReturnType<typeof useChatAttention>["attention"]; threads: Thread[]; selected: Thread | null; view: View; waitingIds: Set<string>; pins: string[]; bookmarks: string[]; marked: string[];
  childCursors: Record<string, string | null>; searchTerm: string; agentColours: ReturnType<typeof agentColourSlots>;
  preferences: ReturnType<typeof useAppPreferences>; agentRunsOpen: boolean; setAgentRunsOpen: Setter<boolean>;
  setExpanded: Setter<Record<string, boolean>>; checkedChildren: React.RefObject<Set<string>>;
  setError: Setter<string>; loadChildren: (id: string, cursor?: string, expand?: boolean) => Promise<void>;
  chatReorder: ReturnType<typeof useReorder>; desktop: boolean; hasTerminal: boolean; pane: boolean; windowAvailable: boolean;
  find: (id?: string | null) => Thread | undefined; deleteChats: (ids: string[], focusAt?: number) => void;
  renameDisplayedThread: (thread: Thread, name: string, runId?: string) => Promise<void>; archiveChats: (chats: Thread[]) => void;
  togglePin: (thread: Thread) => void; toggleBookmark: (thread: Thread) => void; openInTui: (thread: Thread) => void;
  openSplit: (thread: Thread) => void; openSessionWindow: (thread?: Thread) => void;
  organizationActions: (thread: Thread) => Pick<ThreadProps, "onMoveToProject" | "onNewProject" | "onPutUnder" | "onTakeOut">;
  attentionFor: (id: string) => NonNullable<ThreadProps["attention"]>; chatsOf: (ids: string[]) => Thread[];
  groupMenu: (thread: Thread, ids: string[]) => ThreadProps["group"]; movingIds: (id: string) => string[];
  markRead: ReturnType<typeof useChatAttention>["markRead"]; prefetchThread: (thread: Thread) => void;
  openInNewTab: (thread: Thread) => void; clickRow: (thread: Thread, event: React.MouseEvent<HTMLButtonElement>) => void;
};

export function createSidebarThreadRow({ model, runtime, loveActivity, attention, threads, selected, view, waitingIds, pins, bookmarks, marked, childCursors, searchTerm, agentColours, preferences, agentRunsOpen, setAgentRunsOpen, setExpanded, checkedChildren, setError, loadChildren, chatReorder, desktop, hasTerminal, pane, windowAvailable, find, deleteChats, renameDisplayedThread, archiveChats, togglePin, toggleBookmark, openInTui, openSplit, openSessionWindow, organizationActions, attentionFor, chatsOf, groupMenu, movingIds, markRead, prefetchThread, openInNewTab, clickRow }: Inputs) {
  const { workflowRoots, workflowCatalog, sidebarTitle, workflowOpen, branchOpen, workflowChild, unreadIds, workflowSteps, ordinaryThreads, agentParents, displayParentIds } = model;
  const { approvals } = runtime;
  /** `inOrigin`: the row sits in the group named for its origin, so the origin is not written again beside its title. */
  function threadRow(thread: Thread, depth = 0, inOrigin = false, recordedRun?: WorkflowRun) {
    const run = recordedRun ?? workflowRoots.get(thread.id), identity = run ? workflowCatalog.identities[run.id] : undefined, name = identity?.name ?? sidebarTitle(thread);
    const expandId = run ? `workflow:${run.id}` : thread.id, open = run ? workflowOpen(run) : branchOpen(thread.id);
    const state = run ? run.status === "running" || threads.some(child => workflowChild(child, run) && child.status?.type === "active") ? "working" : run.status === "failed" ? "error" : workflowRoots.get(thread.id)?.id === run.id && unreadIds.has(thread.id) ? "unread" : "idle" : agentState(thread, waitingIds, isAgentRun(thread) ? new Set() : new Set(attention.unread)), pinned = !!thread.motherAgent || pins.includes(thread.id), bookmarked = bookmarks.includes(thread.id);
    const origin = workflowSteps.has(thread.id) ? null : chatOrigin(thread, loveActivity.threads);
    const runParent = find(thread.parentThreadId);
    const parentLabel = isAgentRun(thread) && thread.parentThreadId && !workflowSteps.has(thread.id) ? `from ${runParent ? title(runParent) : "parent conversation"}` : null;
    const subtitle = attentionLine(approvals.find(approval => (approval.params.threadId ?? approval.ownerThreadId) === thread.id), !!attention.plans[thread.id]);
    const hasAgents = (run ? ordinaryThreads.some(child => workflowChild(child, run)) : agentParents.has(thread.id)) || !!childCursors[thread.id];
    const canExpandAgents = !searchTerm && hasAgents, branchName = displayParentIds.has(thread.id) ? "chats" : "agents";
    const group = depth ? undefined : groupMenu(thread, movingIds(thread.id));
    const selection = marked.length > 1 && marked.includes(thread.id) ? chatsOf(marked) : undefined;
    const colourSlot = agentColours.get(thread.id), role = run ? runSummary(run) : undefined;
    const rowModel = run ? null : thread.model, provider = run ? null : thread.modelProvider;
    return <ThreadActions key={thread.id} thread={{ ...thread, name }} onRequestDelete={() => deleteChats(marked.includes(thread.id) ? marked : [thread.id])} onRename={(thread, name) => renameDisplayedThread(thread, name, identity?.id)} onArchive={archiveChats} pinned={pinned} {...(!thread.motherAgent ? { onPin: togglePin } : {})} {...(hasTerminal ? { onOpenInTui: openInTui } : {})} {...(!pane ? { onOpenSplit: openSplit } : {})} {...(windowAvailable ? { onOpenWindow: openSessionWindow } : {})}
      bookmarked={bookmarked} onBookmark={toggleBookmark}
      {...(identity ? { renameDescription: "The workflow name is saved on this device." } : {})}
      {...organizationActions(thread)}
      attention={attentionFor(thread.id)}
      {...(selection ? { selection } : {})}
      {...(group ? { group } : {})}
      {...(!depth && !isAgent(thread) && hasAgents && !searchTerm ? { agents: { shown: preferences.showAgentRuns && agentRunsOpen, onToggle: () => {
        try { if (!preferences.showAgentRuns) savePreferences({ showAgentRuns: true }); }
        catch (cause) { setError(String(errorText(cause))); return; }
        setAgentRunsOpen(!preferences.showAgentRuns || !agentRunsOpen); if (!preferences.showAgentRuns || !agentRunsOpen) void loadChildren(thread.id, undefined, false);
      } } } : {})}
      area={<ReorderItem reorder={chatReorder} itemId={thread.id} enabled={!searchTerm}
        render={<div className={`thread-row${origin === "Love Spot" ? " love-chat accent-scope" : ""}${depth ? " child" : ""}${selected?.id === thread.id && view === "chat" ? " active" : ""}${marked.includes(thread.id) ? " selected" : ""}`} data-thread-id={thread.id} data-workflow-run={run?.id} data-depth={depth} style={{ "--thread-depth": depth, ...(depth ? { paddingLeft: `${depth * 14}px` } : {}) } as React.CSSProperties} />} />}>
      {menu => <>
      {canExpandAgents && <Button variant="ghost" size="icon-xs" aria-label={`${open ? "Collapse" : "Expand"} ${branchName} in ${name}`} aria-expanded={!!open} title={`${open ? "Collapse" : "Expand"} ${branchName} in ${name}`} onClick={() => {
        if (open) setExpanded(previous => ({ ...previous, [expandId]: false }));
        else { setExpanded(previous => ({ ...previous, [expandId]: true })); if (!checkedChildren.current.has(thread.id)) void loadChildren(thread.id, undefined, false); }
      }}><ChevronRight size={14} className={open ? "rotate-90" : undefined} /></Button>}
      {!canExpandAgents && depth > 0 && <span aria-hidden="true" className="size-6 shrink-0" />}
      <span className="conversation-state-slot">{state === "unread" ? <button data-slot="thread-dot" className="thread-dot conversation-status" data-state={state} aria-label="Unread response. Mark as read" title="Unread response. Mark as read" onClick={() => markRead(thread.id)} /> : state === "idle" ? <span className="thread-dot" data-state={state} aria-hidden="true" /> : <span className="thread-dot conversation-status" role="img" data-state={state} aria-label={stateLabels[state]} title={stateLabels[state]} />}</span>
      <button data-slot="chat-row" className="thread-link" onPointerEnter={() => prefetchThread(thread)} onFocus={() => prefetchThread(thread)} onMouseDown={event => { if (event.shiftKey || event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1 && desktop) { event.preventDefault(); openInNewTab(thread); } }} onClick={event => clickRow(thread, event)} title={name}>
        <>{thread.motherAgent ? <><ElpisMarkIcon className="shrink-0" size={16} aria-hidden="true" /><span className="thread-title">Elpis</span></> : isAgent(thread) || workflowSteps.has(thread.id) || run ? <AgentIdentity compact id={thread.id} {...(colourSlot !== undefined ? { colourSlot } : {})} name={name} nameClassName="thread-title" {...(rowModel !== undefined ? { model: rowModel } : {})} {...(provider !== undefined ? { provider } : {})} {...(role !== undefined ? { role } : {})} /> : <span className="thread-title" title={name}>{name}</span>}</>
        {parentLabel && <span className="text-xs text-muted-foreground" title={parentLabel}>{parentLabel}</span>}
        {subtitle && <span className="thread-subtitle" title={subtitle}>{subtitle}</span>}
        {originLabel(origin, name) && !inOrigin && <span className="thread-nickname thread-origin" data-origin={origin}>{origin}</span>}
        {thread.forkedFromId && <span className="thread-nickname">Continued agent chat</span>}
      </button>
      {bookmarked && <span className="thread-bookmark" role="img" aria-label="Bookmarked" title="Bookmarked"><Bookmark size={13} fill="currentColor" aria-hidden="true" /></span>}
      {menu}
      </>}
    </ThreadActions>;
  }
  return threadRow;
}

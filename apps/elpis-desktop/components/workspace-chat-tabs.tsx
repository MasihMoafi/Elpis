import { cloneElement, type ReactElement, type ReactNode } from "react";
import { ChatIcon } from "@/components/elpis-icons";
import { ThreadActions } from "@/components/thread-actions";
import { Tab } from "@/components/tab-strip";
import { WorkflowMark } from "@/components/workflow-identity";
import type { Thread } from "@/lib/api";
import type { ChatTab } from "@/lib/chat-tabs";
import type { View } from "@/lib/workspace-types";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { createSidebarPlacement } from "@/lib/sidebar-placement";
import type { useChatTabs } from "@/lib/use-chat-tabs";

type Inputs = {
  model: ReturnType<typeof useSidebarThreads>; placement: ReturnType<typeof createSidebarPlacement>;
  selected: Thread | null; view: View; tabs: ReturnType<typeof useChatTabs>["tabs"];
  marked: string[]; pins: string[]; bookmarks: string[]; renameRequest: boolean; pane: boolean;
  hasTerminal: boolean; windowAvailable: boolean;
  find: (id?: string | null) => Thread | undefined; chatsOf: (ids: string[]) => Thread[];
  attentionFor: (id: string) => NonNullable<React.ComponentProps<typeof ThreadActions>["attention"]>;
  deleteChats: (ids: string[]) => void; renameDisplayedThread: (thread: Thread, name: string) => Promise<void>;
  archiveChats: (threads: Thread[]) => void; togglePin: (thread: Thread) => void; toggleBookmark: (thread: Thread) => void;
  openInTui: (thread: Thread) => void; openSplit: (thread: Thread) => void; openSessionWindow: (thread: Thread) => void;
  setRenameRequest: (value: boolean) => void; showTab: (tab: ChatTab) => void; closeChatTab: (id: string) => void;
};

export function createWorkspaceChatTabs({ model, placement, selected, view, tabs, marked, pins, bookmarks, renameRequest, pane, hasTerminal, windowAvailable, find, chatsOf, attentionFor, deleteChats, renameDisplayedThread, archiveChats, togglePin, toggleBookmark, openInTui, openSplit, openSessionWindow, setRenameRequest, showTab, closeChatTab }: Inputs) {
  const { sidebarTitle, workflowRoots, workflowSteps, workflowCatalog } = model;
  const { groupMenu, movingIds, organizationActions } = placement;
  /** A chat's menu around its tab or title: the "…" button and right-click on `area` share one list. The shown chat's is "Chat actions". */
  const threadMenu = (thread: Thread, area: ReactElement, content: (menu: ReactNode) => ReactNode, shown: boolean) => {
    const group = groupMenu(thread, movingIds(thread.id));
    return <ThreadActions {...(shown ? { label: "Chat actions" } : {})} thread={{ ...thread, name: sidebarTitle(thread) }} attention={attentionFor(thread.id)} {...(group ? { group } : {})} {...(marked.includes(thread.id) ? { selection: chatsOf(marked) } : {})} onRequestDelete={() => deleteChats(movingIds(thread.id))} onRename={renameDisplayedThread} {...(workflowRoots.has(thread.id) ? { renameDescription: "The workflow name is saved on this device." } : {})} onArchive={archiveChats} pinned={pins.includes(thread.id)} onPin={togglePin} bookmarked={bookmarks.includes(thread.id)} onBookmark={toggleBookmark} {...(hasTerminal ? { onOpenInTui: openInTui } : {})} {...(!pane ? { onOpenSplit: openSplit } : {})} {...(windowAvailable ? { onOpenWindow: openSessionWindow } : {})} renameRequested={shown && renameRequest} onRenameRequestHandled={() => setRenameRequest(false)} {...organizationActions(thread)} area={area}>{content}</ThreadActions>;
  };
  const chatActions = (area: ReactElement, content: ReactNode) => view === "chat" && selected
    ? threadMenu(selected, area, menu => <>{content}{menu}</>, true)
    : cloneElement(area, undefined, content);
  /** One chat tab: its title and close button, the "…" on the shown one, and the chat's menu on right-click. */
  function chatTab(tab: ChatTab) {
    const shown = tab.id === tabs.activeId, thread = tab.threadId ? (shown && selected?.id === tab.threadId ? selected : find(tab.threadId)) : undefined;
    const label = thread ? sidebarTitle(thread) : tab.threadId ? tab.title || "Chat" : "New chat";
    const identity = thread ? workflowCatalog.identities[workflowSteps.get(thread.id)?.runId ?? workflowRoots.get(thread.id)?.id ?? ""] : undefined;
    return <Tab key={tab.id} chat icon={identity ? <WorkflowMark identity={identity} neutral /> : <ChatIcon size={14} />} label={label} active={shown} closeLabel={`Close ${label} tab`} trailing={shown}
      {...(thread ? { wrap: (area: ReactElement, content: (menu: ReactNode) => ReactNode) => threadMenu(thread, area, content, shown) } : {})} onSelect={() => showTab(tab)} onClose={() => closeChatTab(tab.id)} />;
  }
  return { chatActions, chatTab };
}

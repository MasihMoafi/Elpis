import type React from "react";
import { ChevronRight, EyeOff } from "lucide-react";
import { MoreMenu, RightClickMenu } from "@/components/action-menu";
import type { useBrowser } from "@/components/browser-panel";
import { GroupAndSortMenu } from "@/components/chat-groups";
import { AgentsIcon, BrowserIcon, PinIcon } from "@/components/elpis-icons";
import { LoadOnScroll } from "@/components/load-on-scroll";
import type { useReorder } from "@/components/reorder";
import { SidebarProjects } from "@/components/sidebar-projects";
import { Button } from "@/components/ui/button";
import type { Thread } from "@/lib/api";
import type { useBrowserPins } from "@/lib/browser-pins";
import type { ChatGroup } from "@/lib/chat-groups";
import { savePreferences, type useAppPreferences } from "@/lib/preferences";
import type { createProjectActions } from "@/lib/project-actions";
import type { useConversationList } from "@/lib/use-conversation-list";
import type { useProjectState } from "@/lib/use-project-state";
import type { useSidebarSearch } from "@/lib/use-sidebar-search";
import type { useChatAttention, useChatGroups, useSidebarFolds } from "@/lib/use-sidebar-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { View } from "@/lib/workspace-types";

type Props = {
  model: ReturnType<typeof useSidebarThreads>; projectState: ReturnType<typeof useProjectState>; search: ReturnType<typeof useSidebarSearch>;
  browser: ReturnType<typeof useBrowser>; browserPins: ReturnType<typeof useBrowserPins>; preferences: ReturnType<typeof useAppPreferences>;
  chatGroups: ReturnType<typeof useChatGroups>["chatGroups"]; updateGroups: ReturnType<typeof useChatGroups>["updateGroups"];
  setAttention: ReturnType<typeof useChatAttention>["setAttention"]; conversations: ReturnType<typeof useConversationList>;
  threadList: React.RefObject<HTMLDivElement | null>; listKeys: React.KeyboardEventHandler<HTMLDivElement>;
  collapsedSections: Record<string, boolean>; collapsedProjects: Record<string, boolean>; expanded: Record<string, boolean>; pins: string[];
  setCollapsedProjects: ReturnType<typeof useSidebarFolds>["setCollapsedProjects"]; chatReorder: ReturnType<typeof useReorder>; projectReorder: ReturnType<typeof useReorder>;
  foldable: (key: string, name: string) => React.ReactNode; addProject: ReturnType<typeof createProjectActions>["addProject"];
  removeProject: ReturnType<typeof createProjectActions>["removeProject"]; selectProject: ReturnType<typeof createProjectActions>["selectProject"];
  chatRows: (thread: Thread) => React.ReactNode; chatGroupSection: (section: { group: ChatGroup; chats: Thread[] }) => React.ReactNode;
  threadRow: (thread: Thread, depth?: number, inOrigin?: boolean) => React.ReactNode; descendants: (id: string, depth: number) => React.ReactNode;
  threadBranch: (thread: Thread, depth?: number, seen?: Set<string>, inOrigin?: boolean) => React.ReactNode; runDescendants: (id: string, depth: number) => React.ReactNode;
  show: (view: View) => void; ready: boolean; busy: boolean; threads: Thread[]; agentRunsOpen: boolean; setAgentRunsOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export function SidebarChatList({ model, projectState, search, browser, browserPins, preferences, chatGroups, updateGroups, setAttention, conversations, threadList, listKeys, collapsedSections, collapsedProjects, expanded, pins, setCollapsedProjects, chatReorder, projectReorder, foldable, addProject, removeProject, selectProject, chatRows, chatGroupSection, threadRow, descendants, threadBranch, runDescendants, show, ready, busy, threads, agentRunsOpen, setAgentRunsOpen }: Props) {
  const { workflowCatalog, ordinaryThreads, sidebarParent, ownChat, pinnedChats, grouped, loveChats, workflowChats, recentChats, roots, ordinaryUnread, filtered, agentRuns, unlinked, runActions, topLevelAgentRuns, chatListOrder } = model;
  const { nextCursor, moreLoading, loadMoreConversations } = conversations;
  const searchTerm = search.searchTerm;
  return <div className="thread-list" ref={threadList} onKeyDown={listKeys} {...chatListOrder.pointer}>
        {workflowCatalog.error && <p role="alert" className="px-2 text-xs text-destructive">{workflowCatalog.error}</p>}
        {!searchTerm && <SidebarProjects projectState={projectState} collapsedSections={collapsedSections} collapsedProjects={collapsedProjects} ordinaryThreads={ordinaryThreads} sidebarParent={sidebarParent} pins={pins} ownChat={ownChat} chatReorder={chatReorder} projectReorder={projectReorder} setCollapsedProjects={setCollapsedProjects} foldable={foldable} addProject={addProject} removeProject={removeProject} selectProject={selectProject} ready={ready} busy={busy} chatRows={chatRows} />}
        {!searchTerm && browserPins.pins.length > 0 && <section aria-label="Pinned browser pages"><div className="section-label-row">{foldable("browser", "Browser")}</div>
          {!collapsedSections.browser && browserPins.pins.map(pin => <div key={pin.url} className="thread-row">
            <Button variant="ghost" className="thread-name w-full justify-start" title={`${pin.title}\n${pin.url}\nOpen in this chat’s browser`} onClick={() => { show("chat"); void browser.command("new", { url: pin.url }); }}><BrowserIcon size={14} /><span className="truncate">{pin.title}</span></Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Unpin ${pin.title} from sidebar`} title="Unpin from sidebar" onClick={() => void browserPins.toggle(pin)}><PinIcon size={14} /></Button>
          </div>)}
        </section>}
        {pinnedChats.length > 0 && <section aria-label="Pinned"><div className="section-label-row">{foldable("pinned", "Pinned")}</div>{(searchTerm || !collapsedSections.pinned) && pinnedChats.map(chatRows)}</section>}
        {grouped && grouped.groups.length > 0 && <section aria-label="Groups"><div className="section-label-row">{foldable("groups", "Groups")}</div>{!collapsedSections.groups && grouped.groups.map(chatGroupSection)}</section>}
        {loveChats.length > 0 && <section role="group" aria-label="Love Spot"><div className="section-label-row">{foldable("love", "Love Spot")}</div>{!collapsedSections.love && loveChats.map(thread => <div key={thread.id}>{threadRow(thread, 0, true)}{expanded[thread.id] && descendants(thread.id, 1)}</div>)}</section>}
        {workflowChats.length > 0 && <section role="group" aria-label="Workflows"><div className="section-label-row">{foldable("workflows", "Workflows")}<Button variant="ghost" size="icon-xs" className="section-hide" aria-label="Hide Workflows from the sidebar" title="Hide Workflows from the sidebar · Settings → General shows them again" onClick={() => { try { savePreferences({ sidebarWorkflows: false }); } catch { /* the section stays */ } }}><EyeOff size={14} /></Button></div>{!collapsedSections.workflows && workflowChats.map(thread => threadBranch(thread, 0, new Set(), true))}</section>}
        {(searchTerm ? recentChats.length > 0 : roots.length > 0 || ordinaryThreads.length > 0) && <section aria-label={searchTerm ? "Results" : "Recents"} {...(!searchTerm ? chatReorder.targetProps("recents", true) : {})}><div className="section-label-row" {...(grouped ? chatReorder.targetProps("recents", true) : {})}>{searchTerm ? <div className="section-label">Results</div> : foldable("recents", "Recents")}
          {!searchTerm && ordinaryUnread.length > 0 && <Button variant="ghost" size="xs" onClick={() => setAttention(previous => ({ ...previous, unread: [] }))}>Mark all as read</Button>}
          {!searchTerm && <GroupAndSortMenu state={chatGroups} onChange={change => updateGroups(state => ({ ...state, ...change }))} />}</div>
          {(searchTerm || !collapsedSections.recents) && recentChats.map(chatRows)}
        </section>}
        {ready && !threads.length && <p className="px-2 text-xs text-muted-foreground">Your conversations will appear here.</p>}
        {search.results?.loading && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Searching saved conversations…</p>}
        {search.results?.error && <p role="alert" className="px-2 py-3 text-xs text-destructive">Could not search saved conversations: {search.results?.error}</p>}
        {search.results && !search.results.loading && !search.results.error && !filtered.length && <p className="px-2 py-3 text-xs text-muted-foreground">No matching conversations.</p>}
        {searchTerm ? search.results?.nextCursor && <LoadOnScroll className="thread-more" loading={search.results.loading} label="Loading more search results" onLoad={() => void search.loadMore()} /> : nextCursor && <LoadOnScroll className="thread-more" loading={moreLoading} label="Loading more chats" onLoad={() => void loadMoreConversations()} />}
        {!searchTerm && preferences.showAgentRuns && agentRuns.length + unlinked.length > 0 && <section className="mt-4" aria-label="Background runs">
          <RightClickMenu actions={runActions} area={<div className="flex items-center" />}>
            <Button data-sidebar-stop variant="ghost" size="sm" className="min-w-0 flex-1 justify-start text-muted-foreground" aria-expanded={agentRunsOpen} aria-controls="agent-runs" onClick={() => setAgentRunsOpen(open => !open)}><ChevronRight size={13} className={agentRunsOpen ? "rotate-90" : undefined} /><AgentsIcon size={14} />Agent runs ({agentRuns.length + unlinked.length})</Button>
            <MoreMenu actions={runActions} label="Agent runs actions" title="Hide Agent runs or delete their history" />
          </RightClickMenu>
          {agentRunsOpen && <div id="agent-runs" role="region" aria-label="Agent runs">{topLevelAgentRuns.map(thread => <div key={thread.id}>{threadRow(thread, 1)}{expanded[thread.id] && runDescendants(thread.id, 2)}</div>)}{unlinked.map(thread => threadBranch(thread, 1))}
          </div>}
        </section>}
      </div>;
}

import type { AgentPanelState } from "@/lib/use-chat-team";
import type React from "react";
import { PanelLeft, PanelRightClose, PanelRightOpen, RefreshCw, X } from "lucide-react";
import { BrandWordmark } from "@/components/brand-wordmark";
import { AgentsIcon, LoveSpotIcon, PlusIcon } from "@/components/elpis-icons";
import { ImproveElpis } from "@/components/improve-elpis";
import { PendingInputTrigger } from "@/components/pending-input";
import { Segmented } from "@/components/settings/rows";
import type { useSidePanel } from "@/components/side-panel";
import type { useSessionSplit } from "@/components/session-split";
import { TabStrip } from "@/components/tab-strip";
import { Button } from "@/components/ui/button";
import { agentModelLabel, title, type Approval, type Model, type Thread } from "@/lib/api";
import { isAgentRun } from "@/lib/agent-runs.mts";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { ChatTab } from "@/lib/chat-tabs";
import { chatOrigin, originLabel } from "@/lib/love-activity";
import type { useAppPreferences } from "@/lib/preferences";
import { shortcutTitle } from "@/lib/shortcuts";
import type { useChatTabs } from "@/lib/use-chat-tabs";
import type { useComposerState } from "@/lib/use-composer-state";
import type { useLoveActivity } from "@/lib/use-love-activity";
import type { useOpenConversation } from "@/lib/use-open-conversation";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { View } from "@/lib/workspace-types";

type Props = {
  pages: ReturnType<typeof useWorkspacePagesState>; preferences: ReturnType<typeof useAppPreferences>;
  composer: ReturnType<typeof useComposerState>; loveActivity: ReturnType<typeof useLoveActivity>;
  side: ReturnType<typeof useSidePanel>; split: ReturnType<typeof useSessionSplit>; tabs: ReturnType<typeof useChatTabs>["tabs"];
  selected: Thread | null; threads: Thread[]; models: Model[]; outsideChatApprovals: Approval[]; pendingInputButton: React.RefObject<HTMLButtonElement | null>;
  pendingInputOpen: boolean; setPendingInputOpen: React.Dispatch<React.SetStateAction<boolean>>;
  heading: string; meta: string; dark: boolean; desktop: boolean; loading: boolean; panelShown: boolean;
  team: Thread[]; awaitingTeam: boolean; agentsPanel: boolean;
  setAgentsPanelState: React.Dispatch<React.SetStateAction<AgentPanelState>>;
  setLoveToolbarHost: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
  find: (id?: string | null) => Thread | undefined; show: (view: View) => void; showSidebar: (open: boolean) => void;
  openById: (id: string) => Promise<void>; loadThread: ReturnType<typeof useOpenConversation>["loadThread"];
  newChatTab: ReturnType<typeof createChatNavigation>["newChatTab"]; openAgentsPanel: () => void;
  chatTab: (tab: ChatTab) => React.ReactNode; chatActions: (area: React.ReactElement, content: React.ReactNode) => React.ReactNode;
};

export function WorkspaceHeader({ pages, preferences, composer, loveActivity, side, split, tabs, selected, threads, models, outsideChatApprovals, pendingInputButton, pendingInputOpen, setPendingInputOpen, heading, meta, dark, desktop, loading, panelShown, team, awaitingTeam, agentsPanel, setAgentsPanelState, setLoveToolbarHost, find, show, showSidebar, openById, loadThread, newChatTab, openAgentsPanel, chatTab, chatActions }: Props) {
  const { view, workflowTab, setWorkflowTab } = pages;
  const { composerRef } = composer;
  const parent = find(selected?.parentThreadId), source = find(selected?.forkedFromId);
  return (
      <header className={`workspace-header${heading ? "" : " untitled"}`}>
        <ImproveElpis {...(view === "chat" && selected ? { threadId: selected.id } : {})} onChat={loadThread} />
        {outsideChatApprovals.length > 0 && <PendingInputTrigger approvals={outsideChatApprovals} threads={threads} button={pendingInputButton} setOpen={setPendingInputOpen} open={pendingInputOpen} />}
        <Button className="mobile-menu sidebar-open" variant="ghost" size="icon-sm" aria-label="Open sidebar" title={shortcutTitle("Open sidebar", "sidebar", preferences)} onClick={() => showSidebar(true)}><PanelLeft size={16} /></Button>
        <BrandWordmark className="mobile-brand" dark={dark} width={49} height={24} />
        <div className="header-titles min-w-0 flex-1">
          {view === "chat" && desktop && !split.pane
            ? <TabStrip label="Chat tabs" activeKey={tabs.activeId} add={<Button type="button" variant="ghost" size="icon-sm" className="task-tab-new" aria-label="New chat tab" title="New chat tab (Ctrl+T)" onClick={newChatTab}><PlusIcon size={16} /></Button>}>
                {tabs.tabs.map(chatTab)}
              </TabStrip>
            : chatActions(<div className="header-title-row" />, <h1>{heading}</h1>)}
          {view === "canvas" && <Segmented label="Workflows view" className="workflow-view-switch" value={workflowTab} onChange={setWorkflowTab} options={[{ value: "board", label: "Board" }, { value: "scheduled", label: "Scheduled" }]} />}
          {view === "chat" && selected?.motherAgent && <Button variant="outline" size="xs" onClick={() => show("mother")}>Mother panel</Button>}
          {view === "chat" && selected && originLabel(chatOrigin(selected, loveActivity.threads), title(selected)) === "Love Spot" && <Button variant="ghost" size="xs" className="thread-origin" data-origin="Love Spot" onClick={() => show("loveSpot")}><LoveSpotIcon size={13} />Love Spot</Button>}
          {view === "chat" && selected && meta && <p className="thread-meta">{meta}</p>}
          {view === "chat" && selected && isAgentRun(selected) && !!selected.model && <p className="thread-meta basis-full">{agentModelLabel(selected, models)}</p>}
          {view === "chat" && selected && (selected.parentThreadId || selected.forkedFromId) && <p className="thread-links">
            {selected.parentThreadId && <Button variant="link" size="xs" aria-label={`Open parent: ${parent ? title(parent) : "parent conversation"}`} onClick={() => { void openById(selected.parentThreadId!); }}>Agent of {parent ? title(parent) : "its parent conversation"}</Button>}
            {selected.forkedFromId && <Button variant="link" size="xs" aria-label={`Open original: ${source ? title(source) : "original chat"}`} onClick={() => { void openById(selected.forkedFromId!); }}>Continued from {source ? title(source) : "the original chat"}</Button>}
          </p>}
        </div>
        {view === "loveSpot" && <div ref={setLoveToolbarHost} className="love-spot-toolbar-host" />}
        {view === "chat" && desktop && <Button className="header-action" variant="ghost" size="icon-sm" aria-pressed={side.open} aria-label={side.open ? "Hide side panel" : "Show side panel"} title={side.open ? "Hide side panel" : "Side panel: terminals and browser tabs"} onClick={() => side.open ? side.closePanel() : side.openPanel()}>{side.open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</Button>}
        {selected && view === "chat" && (team.length > 0 || awaitingTeam) && !panelShown && <Button className={`header-action${team.length ? "" : " team-pending-toggle"}`} variant="ghost" size="icon-sm" aria-label={agentsPanel ? "Hide agents panel" : "Show agents panel"} aria-pressed={agentsPanel} title={awaitingTeam && !team.length ? "Hide agents panel and open the chat" : agentsPanel ? "Hide agents panel" : "Show agents panel"} onClick={() => {
          if (agentsPanel) { setAgentsPanelState(previous => ({ ...previous, open: false })); if (awaitingTeam) requestAnimationFrame(() => composerRef.current?.focus()); }
          else openAgentsPanel();
        }}><AgentsIcon size={16} /></Button>}
        {(split.pane || (split.thread && view === "chat")) && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Close split view" title="Close split view" onClick={split.close}><X size={16} /></Button>}
        {selected && view === "chat" && <Button className="header-action" variant="ghost" size="icon-sm" aria-label="Refresh conversation" disabled={loading} onClick={() => { void loadThread(selected); }}><RefreshCw size={16} /></Button>}
      </header>
  );
}

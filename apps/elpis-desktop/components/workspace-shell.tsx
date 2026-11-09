"use client";

import { type CSSProperties } from "react";
import { DeleteChatsDialog } from "@/components/thread-actions";
import { SidebarChatList } from "@/components/sidebar-chat-list";
import { WorkflowPages } from "@/components/workflow-pages";
import { PendingInputPanel } from "@/components/pending-input";
import { WorkspaceSettings } from "@/components/workspace-settings";
import { WorkspaceGuideAndLab, OtherWorkspacePages } from "@/components/other-workspace-pages";
import { WorkspaceTitleBar } from "@/components/workspace-title-bar";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { WorkspaceHeader } from "@/components/workspace-header";
import { RewindDialog } from "@/components/rewind-dialog";
import { ReadAloud } from "@/components/read-aloud";
import { LiveVoiceProvider } from "@/components/live-voice";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { DocumentReviewProvider } from "@/components/document-review";
import { ResumeConversation } from "@/components/resume-conversation";
import { agentState } from "@/lib/agents";
import { SidePanel, sideMinWidth } from "@/components/side-panel";
import { FloatChatBar, FloatChatPill } from "@/components/float-chat";
import { title, agentName } from "@/lib/api";
import { WorkspaceAlertArea } from "@/components/workspace-alert-area";
import { PAGE_NAMES } from "@/lib/workspace-navigation-pages";
import { WorkspaceOrganizationDialogs } from "@/components/workspace-organization-dialogs";
import { WorkspaceCommandDialogs } from "@/components/workspace-command-dialogs";
import type { WorkspaceController } from "@/components/use-workspace-controller";
import { WorkspaceChatPage } from "@/components/workspace-chat-page";

/** The workspace page's layout. */
export function WorkspaceShell({ workspace }: { workspace: WorkspaceController }) {
  const heading =
    workspace.view === "chat" ? (workspace.selected ? title(workspace.selected) : "") : PAGE_NAMES[workspace.view];
  const chatName = workspace.selected ? title(workspace.selected) : "New chat";
  const chatState = workspace.selected ? agentState(workspace.selected, workspace.waitingIds) : "idle",
    floatState = workspace.activeTurn && chatState === "idle" ? "working" : chatState;
  const meta = workspace.selected
    ? [
        agentName(workspace.selected),
        workspace.selected.agentRole && workspace.selected.agentRole !== "default"
          ? workspace.selected.agentRole
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const alerts = (
    <WorkspaceAlertArea
      notices={workspace.notices}
      session={workspace.session}
      runtime={workspace.runtime}
      composer={workspace.composer}
      attachments={workspace.attachmentState}
      drafts={workspace.draftStore}
      rewind={workspace.rewindState}
      catalog={workspace.catalog}
      activeTurn={workspace.activeTurn}
      undoDelete={workspace.undoDelete}
      switchRewind={workspace.switchRewind}
      editDraft={workspace.editDraft}
    />
  );
  const chatCovered =
    (workspace.panelShown && workspace.panelDrawer) || (workspace.fullView && workspace.side.chatCollapsed);

  // One Matilda voice and one live call for the whole app: both go on when he leaves the board or Love Spot's chat; her face shows and controls them.
  return (
    <DocumentReviewProvider onAttach={parts => workspace.attachFromBrowser(parts, false)}>
      <LiveVoiceProvider>
        <ReadAloud
          threadId="love-spot"
          enabled
          available={LOVE_SPOT_AUDIO.readAloudAvailable}
          unavailableReason={LOVE_SPOT_AUDIO.available ? undefined : LOVE_SPOT_AUDIO.reason}
        >
          <div
            data-workspace={workspace.view}
            data-desktop={workspace.desktop || undefined}
            className={`app-shell${workspace.split.pane ? " session-pane" : ""}${workspace.split.thread && workspace.view === "chat" ? " session-split" : ""}${workspace.dark ? " dark" : ""} has-title-bar${workspace.sidebarCollapsed ? " sidebar-collapsed" : ""}${workspace.view === "settings" ? " settings-mode" : ""}${workspace.panelShown ? " panel-active" : ""}`}
            style={{ "--sidebar-width": `${workspace.sidebarWidth}px` } as CSSProperties}
          >
            <title>
              {workspace.view === "canvas"
                ? "Workflows · Elpis"
                : workspace.view === "experimentLab"
                  ? "Lab · Elpis"
                  : workspace.view === "customize"
                    ? "Customize — Elpis"
                    : "Elpis"}
            </title>
            <WorkspaceTitleBar
              desktop={workspace.desktop}
              preferences={workspace.preferences}
              navHistory={workspace.navHistory}
              sidebar={workspace.sidebar}
              sidebarCollapsed={workspace.sidebarCollapsed}
              panelShown={workspace.panelShown}
              panelDrawer={workspace.panelDrawer}
              setError={workspace.setError}
              newChat={workspace.newChat}
              goHistory={workspace.goHistory}
              addProject={workspace.addProject}
              show={workspace.show}
              showSidebar={workspace.showSidebar}
              narrow={workspace.narrow}
              shortcutAction={workspace.shortcutAction}
            />
            <WorkspaceCommandDialogs
              session={workspace.session}
              runtime={workspace.runtime}
              notices={workspace.notices}
              pages={workspace.pages}
              dialogs={workspace.dialogs}
              projectState={workspace.projectState}
              sidebarModel={workspace.sidebarModel}
              childrenState={workspace.children}
              split={workspace.split}
              desktop={workspace.desktop}
              panelShown={workspace.panelShown}
              actions={workspace.commandActions}
              openThread={workspace.openThread}
              selectProject={workspace.selectProject}
              newChat={workspace.newChat}
              setDesktopPrompt={workspace.setDesktopPrompt}
            />
            <WorkspaceOrganizationDialogs
              projectState={workspace.projectState}
              dialogs={workspace.dialogs}
              model={workspace.sidebarModel}
              groups={workspace.groups}
              selection={workspace.selection}
              placement={workspace.placement}
              actions={workspace.projectActions}
            >
              <ResumeConversation
                open={workspace.resumeOpen}
                chats={workspace.sidebarThreads}
                returnFocus={workspace.composerRef}
                onClose={() => workspace.setResumeOpen(false)}
                onChoose={thread => {
                  workspace.setResumeOpen(false);
                  void workspace.openThread(thread);
                }}
              />
            </WorkspaceOrganizationDialogs>
            <DeleteChatsDialog
              threads={workspace.deleteTargets}
              trash={workspace.trashChats}
              alwaysConfirm={workspace.deleteRunHistory}
              onClose={() => {
                workspace.setDeleteTargets(null);
                workspace.setDeleteRunHistory(false);
              }}
            />
            <RewindDialog
              threadId={workspace.selected?.id}
              turnId={workspace.rewindTurn}
              prompt={
                workspace.rewindTurn
                  ? (workspace.turnEntries
                      .get(workspace.rewindTurn)
                      ?.find(entry => entry.item.type === "userMessage")
                      ?.item.content?.map(part => part.text ?? "")
                      .join("\n") ?? "")
                  : ""
              }
              turns={
                workspace.rewindTurn
                  ? Math.max(
                      1,
                      workspace.turnEntries.size - [...workspace.turnEntries.keys()].indexOf(workspace.rewindTurn),
                    )
                  : null
              }
              onConfirm={(mode, version) => workspace.rewindFrom(workspace.rewindTurn!, mode, version)}
              onClose={() => workspace.setRewindTurn(null)}
            />
            <WorkspaceSidebar
              sidebar={workspace.sidebar}
              sidebarKeys={workspace.sidebarKeys}
              appearance={workspace.appearance}
              pages={workspace.pages}
              preferences={workspace.preferences}
              projectState={workspace.projectState}
              runtime={workspace.runtime}
              loveActivity={workspace.loveActivity}
              search={workspace.search}
              searchInput={workspace.searchInput}
              selected={workspace.selected}
              arrangedPages={workspace.arrangedPages}
              pageReorder={workspace.pageReorder}
              show={workspace.showPage}
              showSidebar={workspace.showSidebar}
              focusComposer={workspace.focusComposer}
              openSettings={workspace.openSettings}
              newChat={workspace.newChat}
            >
              <SidebarChatList
                model={workspace.sidebarModel}
                projectState={workspace.projectState}
                search={workspace.search}
                browser={workspace.browser}
                browserPins={workspace.browserPins}
                preferences={workspace.preferences}
                chatGroups={workspace.chatGroups}
                updateGroups={workspace.updateGroups}
                setAttention={workspace.setAttention}
                conversations={workspace.conversations}
                threadList={workspace.threadList}
                listKeys={workspace.listKeys}
                collapsedSections={workspace.collapsedSections}
                collapsedProjects={workspace.collapsedProjects}
                expanded={workspace.expanded}
                pins={workspace.pins}
                setCollapsedProjects={workspace.setCollapsedProjects}
                chatReorder={workspace.chatReorder}
                projectReorder={workspace.projectReorder}
                foldable={workspace.foldable}
                addProject={workspace.addProject}
                removeProject={workspace.removeProject}
                selectProject={workspace.selectProject}
                chatRows={workspace.chatRows}
                threadRow={workspace.threadRow}
                descendants={workspace.descendants}
                threadBranch={workspace.threadBranch}
                runDescendants={workspace.runDescendants}
                show={workspace.show}
                ready={workspace.ready}
                busy={workspace.busy}
                threads={workspace.threads}
                agentRunsOpen={workspace.agentRunsOpen}
                setAgentRunsOpen={workspace.setAgentRunsOpen}
              />
            </WorkspaceSidebar>
            <main
              className={`workspace${workspace.view === "chat" && workspace.selectedLoveChat ? " love-chat accent-scope" : ""}`}
              style={
                workspace.panelShown && !workspace.fullView
                  ? ({
                      "--side-min": `${sideMinWidth(workspace.side.shown)}px`,
                      ...(workspace.side.width
                        ? {
                            "--side-w": `clamp(${sideMinWidth(workspace.side.shown)}px, ${workspace.side.width}px, 70%)`,
                          }
                        : {}),
                    } as CSSProperties)
                  : undefined
              }
            >
              <WorkspaceHeader
                pages={workspace.pages}
                preferences={workspace.preferences}
                composer={workspace.composer}
                loveActivity={workspace.loveActivity}
                side={workspace.side}
                split={workspace.split}
                tabs={workspace.tabs}
                selected={workspace.selected}
                threads={workspace.threads}
                models={workspace.models}
                outsideChatApprovals={workspace.outsideChatApprovals}
                pendingInputButton={workspace.pendingInputButton}
                pendingInputOpen={workspace.pendingInputOpen}
                setPendingInputOpen={workspace.setPendingInputOpen}
                heading={heading}
                meta={meta}
                dark={workspace.dark}
                desktop={workspace.desktop}
                loading={workspace.loading}
                panelShown={workspace.panelShown}
                team={workspace.team}
                awaitingTeam={workspace.awaitingTeam}
                agentsPanel={workspace.agentsPanel}
                setAgentsPanelState={workspace.setAgentsPanelState}
                setLoveToolbarHost={workspace.setLoveToolbarHost}
                find={workspace.find}
                show={workspace.show}
                showSidebar={workspace.showSidebar}
                openById={workspace.openById}
                loadThread={workspace.loadThread}
                newChatTab={workspace.newChatTab}
                openAgentsPanel={workspace.openAgentsPanel}
                chatTab={workspace.chatTab}
                chatActions={workspace.chatActions}
              />
              {workspace.outsideChatApprovals.length > 0 && workspace.pendingInputOpen && (
                <PendingInputPanel
                  approvals={workspace.outsideChatApprovals}
                  threads={workspace.threads}
                  button={workspace.pendingInputButton}
                  setOpen={workspace.setPendingInputOpen}
                  openById={id => {
                    void workspace.openById(id);
                  }}
                  approvalCardProps={workspace.approvalCardProps}
                />
              )}
              <div
                className={`workspace-body${workspace.panelShown ? " panel-open" : ""}${workspace.fullView ? ` full-view${workspace.side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${workspace.view !== "chat" ? " no-browser" : ""}`}
              >
                <div
                  className="workspace-content"
                  {...(workspace.fullView ? { role: "region", "aria-label": "Floating chat" } : {})}
                >
                  {workspace.fullView && (
                    <FloatChatBar title={chatName} onCollapse={() => workspace.side.setChatCollapsed(true)} />
                  )}
                  <WorkspaceSettings
                    pages={workspace.pages}
                    selected={workspace.selected}
                    permissionMode={workspace.permissionMode}
                    appearance={workspace.appearance}
                    conversations={workspace.conversations}
                    runtime={workspace.runtime}
                    unarchived={workspace.unarchived}
                    deleteThread={workspace.deleteThread}
                    browser={workspace.browser}
                    busy={workspace.busy}
                    show={workspace.show}
                    focusComposer={workspace.focusComposer}
                    openComposerControl={workspace.openComposerControl}
                    refreshModels={workspace.refreshModels}
                  />
                  <WorkspaceGuideAndLab view={workspace.view} show={workspace.show} />
                  <WorkflowPages
                    pages={workspace.pages}
                    sidebarModel={workspace.sidebarModel}
                    projectState={workspace.projectState}
                    runtime={workspace.runtime}
                    threads={workspace.threads}
                    models={workspace.models}
                    workflowFolder={workspace.workflowFolder}
                    workflowSandbox={workspace.workflowSandbox}
                    dark={workspace.dark}
                    show={workspace.show}
                    openById={id => {
                      void workspace.openById(id);
                    }}
                    keepWorkflowTab={workspace.keepWorkflowTab}
                    selectProject={workspace.selectProject}
                    addProject={workspace.addProject}
                    workIn={workspace.workIn}
                    finishReplay={workspace.finishReplay}
                  />
                  <OtherWorkspacePages
                    onOpenThread={id => {
                      void workspace.openById(id);
                    }}
                    view={workspace.view}
                    selected={workspace.selected}
                    threads={workspace.threads}
                    cwd={workspace.cwd}
                    dark={workspace.dark}
                    loveToolbarHost={workspace.loveToolbarHost}
                    side={workspace.side}
                    hasTerminal={workspace.hasTerminal}
                    setTuiLaunch={workspace.setTuiLaunch}
                    show={workspace.show}
                    openSettings={workspace.openSettings}
                    newChat={workspace.newChat}
                    editDraft={workspace.editDraft}
                  />
                  {workspace.view === "chat" && (
                    <WorkspaceChatPage workspace={workspace} transcriptAlerts={!chatCovered && alerts} />
                  )}
                </div>
                {workspace.fullView && workspace.side.chatCollapsed && (
                  <FloatChatPill
                    title={chatName}
                    state={floatState}
                    onRestore={() => workspace.side.setChatCollapsed(false)}
                  />
                )}
                {workspace.desktop && (
                  <SidePanel
                    panel={workspace.side}
                    browser={workspace.browser}
                    hasTerminal={workspace.hasTerminal}
                    dark={workspace.dark}
                    cwd={workspace.selected?.cwd || workspace.cwd}
                    threadId={workspace.selected?.id}
                    running={!!workspace.activeTurn}
                    launch={workspace.tuiLaunch}
                    covered={workspace.pendingInputOpen || workspace.sidebar || workspace.view !== "chat"}
                    onAttach={workspace.attachFromBrowser}
                    imagesAllowed={
                      !(
                        workspace.knownModel?.inputModalities && !workspace.knownModel.inputModalities.includes("image")
                      )
                    }
                  />
                )}
              </div>
              {(workspace.view !== "chat" || chatCovered) && alerts}
              {workspace.split.thread && workspace.view === "chat" && (
                <iframe
                  key={workspace.split.thread.id}
                  ref={workspace.split.frame}
                  className="split-session"
                  title="Split session"
                  src={`/?pane=1&session=${encodeURIComponent(workspace.split.thread.id)}`}
                />
              )}
            </main>
          </div>
        </ReadAloud>
      </LiveVoiceProvider>
    </DocumentReviewProvider>
  );
}

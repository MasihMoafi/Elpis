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
  const {
    activeTurn,
    addProject,
    agentRunsOpen,
    agentsPanel,
    appearance,
    approvalCardProps,
    arrangedPages,
    attachFromBrowser,
    attachmentState,
    awaitingTeam,
    browser,
    browserPins,
    busy,
    catalog,
    chatActions,
    chatGroupSection,
    chatGroups,
    chatReorder,
    chatRows,
    chatTab,
    children,
    collapsedProjects,
    collapsedSections,
    commandActions,
    composer,
    composerRef,
    conversations,
    cwd,
    dark,
    deleteRunHistory,
    deleteTargets,
    deleteThread,
    descendants,
    desktop,
    dialogs,
    draftStore,
    editDraft,
    expanded,
    find,
    finishReplay,
    focusComposer,
    foldable,
    fullView,
    goHistory,
    groups,
    hasTerminal,
    keepWorkflowTab,
    knownModel,
    listKeys,
    loadThread,
    loading,
    loveActivity,
    loveToolbarHost,
    models,
    narrow,
    navHistory,
    newChat,
    newChatTab,
    notices,
    openAgentsPanel,
    openById,
    openComposerControl,
    openSettings,
    openThread,
    outsideChatApprovals,
    pageReorder,
    pages,
    panelDrawer,
    panelShown,
    pendingInputButton,
    pendingInputOpen,
    permissionMode,
    pins,
    placement,
    preferences,
    projectActions,
    projectReorder,
    projectState,
    ready,
    refreshModels,
    removeProject,
    resumeOpen,
    rewindFrom,
    rewindState,
    rewindTurn,
    runDescendants,
    runtime,
    search,
    searchInput,
    selectProject,
    selected,
    selectedLoveChat,
    selection,
    session,
    setAgentRunsOpen,
    setAgentsPanelState,
    setAttention,
    setCollapsedProjects,
    setDeleteRunHistory,
    setDeleteTargets,
    setDesktopPrompt,
    setError,
    setLoveToolbarHost,
    setPendingInputOpen,
    setResumeOpen,
    setRewindTurn,
    setTuiLaunch,
    shortcutAction,
    show,
    showPage,
    showSidebar,
    side,
    sidebar,
    sidebarCollapsed,
    sidebarKeys,
    sidebarModel,
    sidebarThreads,
    sidebarWidth,
    split,
    switchRewind,
    tabs,
    team,
    threadBranch,
    threadList,
    threadRow,
    threads,
    trashChats,
    tuiLaunch,
    turnEntries,
    unarchived,
    undoDelete,
    updateGroups,
    view,
    waitingIds,
    workIn,
    workflowFolder,
    workflowSandbox,
  } = workspace;
  const heading = view === "chat" ? (selected ? title(selected) : "") : PAGE_NAMES[view];
  const chatName = selected ? title(selected) : "New chat";
  const chatState = selected ? agentState(selected, waitingIds) : "idle",
    floatState = activeTurn && chatState === "idle" ? "working" : chatState;
  const meta = selected
    ? [agentName(selected), selected.agentRole && selected.agentRole !== "default" ? selected.agentRole : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  const alerts = (
    <WorkspaceAlertArea
      notices={notices}
      session={session}
      runtime={runtime}
      composer={composer}
      attachments={attachmentState}
      drafts={draftStore}
      rewind={rewindState}
      catalog={catalog}
      activeTurn={activeTurn}
      undoDelete={undoDelete}
      switchRewind={switchRewind}
      editDraft={editDraft}
    />
  );
  const chatCovered = (panelShown && panelDrawer) || (fullView && side.chatCollapsed);

  // One Matilda voice and one live call for the whole app: both go on when he leaves the board or Love Spot's chat; her face shows and controls them.
  return (
    <DocumentReviewProvider onAttach={parts => attachFromBrowser(parts, false)}>
      <LiveVoiceProvider>
        <ReadAloud
          threadId="love-spot"
          enabled
          available={LOVE_SPOT_AUDIO.readAloudAvailable}
          unavailableReason={LOVE_SPOT_AUDIO.available ? undefined : LOVE_SPOT_AUDIO.reason}
        >
          <div
            data-workspace={view}
            data-desktop={desktop || undefined}
            className={`app-shell${split.pane ? " session-pane" : ""}${split.thread && view === "chat" ? " session-split" : ""}${dark ? " dark" : ""} has-title-bar${sidebarCollapsed ? " sidebar-collapsed" : ""}${view === "settings" ? " settings-mode" : ""}${panelShown ? " panel-active" : ""}`}
            style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
          >
            <title>
              {view === "canvas"
                ? "Workflows · Elpis"
                : view === "experimentLab"
                  ? "Lab · Elpis"
                  : view === "customize"
                    ? "Customize — Elpis"
                    : "Elpis"}
            </title>
            <WorkspaceTitleBar
              desktop={desktop}
              preferences={preferences}
              navHistory={navHistory}
              sidebar={sidebar}
              sidebarCollapsed={sidebarCollapsed}
              panelShown={panelShown}
              panelDrawer={panelDrawer}
              setError={setError}
              newChat={newChat}
              goHistory={goHistory}
              addProject={addProject}
              show={show}
              showSidebar={showSidebar}
              narrow={narrow}
              shortcutAction={shortcutAction}
            />
            <WorkspaceCommandDialogs
              session={session}
              runtime={runtime}
              notices={notices}
              pages={pages}
              dialogs={dialogs}
              projectState={projectState}
              sidebarModel={sidebarModel}
              childrenState={children}
              split={split}
              desktop={desktop}
              panelShown={panelShown}
              actions={commandActions}
              openThread={openThread}
              selectProject={selectProject}
              newChat={newChat}
              setDesktopPrompt={setDesktopPrompt}
            />
            <WorkspaceOrganizationDialogs
              projectState={projectState}
              dialogs={dialogs}
              model={sidebarModel}
              groups={groups}
              selection={selection}
              placement={placement}
              actions={projectActions}
            >
              <ResumeConversation
                open={resumeOpen}
                chats={sidebarThreads}
                returnFocus={composerRef}
                onClose={() => setResumeOpen(false)}
                onChoose={thread => {
                  setResumeOpen(false);
                  void openThread(thread);
                }}
              />
            </WorkspaceOrganizationDialogs>
            <DeleteChatsDialog
              threads={deleteTargets}
              trash={trashChats}
              alwaysConfirm={deleteRunHistory}
              onClose={() => {
                setDeleteTargets(null);
                setDeleteRunHistory(false);
              }}
            />
            <RewindDialog
              threadId={selected?.id}
              turnId={rewindTurn}
              prompt={
                rewindTurn
                  ? (turnEntries
                      .get(rewindTurn)
                      ?.find(entry => entry.item.type === "userMessage")
                      ?.item.content?.map(part => part.text ?? "")
                      .join("\n") ?? "")
                  : ""
              }
              turns={rewindTurn ? Math.max(1, turnEntries.size - [...turnEntries.keys()].indexOf(rewindTurn)) : null}
              onConfirm={(mode, version) => rewindFrom(rewindTurn!, mode, version)}
              onClose={() => setRewindTurn(null)}
            />
            <WorkspaceSidebar
              sidebar={sidebar}
              sidebarKeys={sidebarKeys}
              appearance={appearance}
              pages={pages}
              preferences={preferences}
              projectState={projectState}
              runtime={runtime}
              loveActivity={loveActivity}
              search={search}
              searchInput={searchInput}
              selected={selected}
              arrangedPages={arrangedPages}
              pageReorder={pageReorder}
              show={showPage}
              showSidebar={showSidebar}
              focusComposer={focusComposer}
              openSettings={openSettings}
              newChat={newChat}
            >
              <SidebarChatList
                model={sidebarModel}
                projectState={projectState}
                search={search}
                browser={browser}
                browserPins={browserPins}
                preferences={preferences}
                chatGroups={chatGroups}
                updateGroups={updateGroups}
                setAttention={setAttention}
                conversations={conversations}
                threadList={threadList}
                listKeys={listKeys}
                collapsedSections={collapsedSections}
                collapsedProjects={collapsedProjects}
                expanded={expanded}
                pins={pins}
                setCollapsedProjects={setCollapsedProjects}
                chatReorder={chatReorder}
                projectReorder={projectReorder}
                foldable={foldable}
                addProject={addProject}
                removeProject={removeProject}
                selectProject={selectProject}
                chatRows={chatRows}
                chatGroupSection={chatGroupSection}
                threadRow={threadRow}
                descendants={descendants}
                threadBranch={threadBranch}
                runDescendants={runDescendants}
                show={show}
                ready={ready}
                busy={busy}
                threads={threads}
                agentRunsOpen={agentRunsOpen}
                setAgentRunsOpen={setAgentRunsOpen}
              />
            </WorkspaceSidebar>
            <main
              className={`workspace${view === "chat" && selectedLoveChat ? " love-chat accent-scope" : ""}`}
              style={
                panelShown && !fullView
                  ? ({
                      "--side-min": `${sideMinWidth(side.shown)}px`,
                      ...(side.width
                        ? { "--side-w": `clamp(${sideMinWidth(side.shown)}px, ${side.width}px, 70%)` }
                        : {}),
                    } as CSSProperties)
                  : undefined
              }
            >
              <WorkspaceHeader
                pages={pages}
                preferences={preferences}
                composer={composer}
                loveActivity={loveActivity}
                side={side}
                split={split}
                tabs={tabs}
                selected={selected}
                threads={threads}
                models={models}
                outsideChatApprovals={outsideChatApprovals}
                pendingInputButton={pendingInputButton}
                pendingInputOpen={pendingInputOpen}
                setPendingInputOpen={setPendingInputOpen}
                heading={heading}
                meta={meta}
                dark={dark}
                desktop={desktop}
                loading={loading}
                panelShown={panelShown}
                team={team}
                awaitingTeam={awaitingTeam}
                agentsPanel={agentsPanel}
                setAgentsPanelState={setAgentsPanelState}
                setLoveToolbarHost={setLoveToolbarHost}
                find={find}
                show={show}
                showSidebar={showSidebar}
                openById={openById}
                loadThread={loadThread}
                newChatTab={newChatTab}
                openAgentsPanel={openAgentsPanel}
                chatTab={chatTab}
                chatActions={chatActions}
              />
              {outsideChatApprovals.length > 0 && pendingInputOpen && (
                <PendingInputPanel
                  approvals={outsideChatApprovals}
                  threads={threads}
                  button={pendingInputButton}
                  setOpen={setPendingInputOpen}
                  openById={id => {
                    void openById(id);
                  }}
                  approvalCardProps={approvalCardProps}
                />
              )}
              <div
                className={`workspace-body${panelShown ? " panel-open" : ""}${fullView ? ` full-view${side.chatCollapsed ? " chat-collapsed" : ""}` : ""}${view !== "chat" ? " no-browser" : ""}`}
              >
                <div
                  className="workspace-content"
                  {...(fullView ? { role: "region", "aria-label": "Floating chat" } : {})}
                >
                  {fullView && <FloatChatBar title={chatName} onCollapse={() => side.setChatCollapsed(true)} />}
                  <WorkspaceSettings
                    pages={pages}
                    selected={selected}
                    permissionMode={permissionMode}
                    appearance={appearance}
                    conversations={conversations}
                    runtime={runtime}
                    unarchived={unarchived}
                    deleteThread={deleteThread}
                    browser={browser}
                    busy={busy}
                    show={show}
                    focusComposer={focusComposer}
                    openComposerControl={openComposerControl}
                    refreshModels={refreshModels}
                  />
                  <WorkspaceGuideAndLab view={view} show={show} />
                  <WorkflowPages
                    pages={pages}
                    sidebarModel={sidebarModel}
                    projectState={projectState}
                    runtime={runtime}
                    threads={threads}
                    models={models}
                    workflowFolder={workflowFolder}
                    workflowSandbox={workflowSandbox}
                    dark={dark}
                    show={show}
                    openById={id => {
                      void openById(id);
                    }}
                    keepWorkflowTab={keepWorkflowTab}
                    selectProject={selectProject}
                    addProject={addProject}
                    workIn={workIn}
                    finishReplay={finishReplay}
                  />
                  <OtherWorkspacePages
                    onOpenThread={id => {
                      void openById(id);
                    }}
                    view={view}
                    selected={selected}
                    threads={threads}
                    cwd={cwd}
                    dark={dark}
                    loveToolbarHost={loveToolbarHost}
                    side={side}
                    hasTerminal={hasTerminal}
                    setTuiLaunch={setTuiLaunch}
                    show={show}
                    openSettings={openSettings}
                    newChat={newChat}
                    editDraft={editDraft}
                  />
                  {view === "chat" && (
                    <WorkspaceChatPage workspace={workspace} transcriptAlerts={!chatCovered && alerts} />
                  )}
                </div>
                {fullView && side.chatCollapsed && (
                  <FloatChatPill title={chatName} state={floatState} onRestore={() => side.setChatCollapsed(false)} />
                )}
                {desktop && (
                  <SidePanel
                    panel={side}
                    browser={browser}
                    hasTerminal={hasTerminal}
                    dark={dark}
                    cwd={selected?.cwd || cwd}
                    threadId={selected?.id}
                    running={!!activeTurn}
                    launch={tuiLaunch}
                    covered={pendingInputOpen || sidebar || view !== "chat"}
                    onAttach={attachFromBrowser}
                    imagesAllowed={!(knownModel?.inputModalities && !knownModel.inputModalities.includes("image"))}
                  />
                )}
              </div>
              {(view !== "chat" || chatCovered) && alerts}
              {split.thread && view === "chat" && (
                <iframe
                  key={split.thread.id}
                  ref={split.frame}
                  className="split-session"
                  title="Split session"
                  src={`/?pane=1&session=${encodeURIComponent(split.thread.id)}`}
                />
              )}
            </main>
          </div>
        </ReadAloud>
      </LiveVoiceProvider>
    </DocumentReviewProvider>
  );
}

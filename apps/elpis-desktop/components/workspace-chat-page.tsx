"use client";

import type { ReactNode } from "react";
import { ViewBoundary } from "@/components/view-boundary";
import { WorkspaceTranscript } from "@/components/workspace-transcript";
import { WorkspaceComposer } from "@/components/workspace-composer";
import { WorkspaceComposerInput } from "@/components/workspace-composer-input";
import { ChatTeamPanel } from "@/components/chat-team-panel";
import type { WorkspaceController } from "@/components/use-workspace-controller";

/** The conversation: transcript, message box and agents panel. */
export function WorkspaceChatPage({
  workspace,
  transcriptAlerts,
}: {
  workspace: WorkspaceController;
  transcriptAlerts: ReactNode;
}) {
  const {
    activeTurn,
    activity,
    addProject,
    agentColours,
    agentsPanel,
    answerPlan,
    approvalCardProps,
    attachmentState,
    awaitingTeam,
    chatConversation,
    chatFolder,
    closePanel,
    composer,
    continueHere,
    continues,
    conversationCommands,
    conversationSettings,
    dark,
    draftStore,
    earlier,
    editDraft,
    editQueued,
    error,
    fastSuccess,
    focusComposer,
    history,
    imageBlocked,
    loveSpotAudioReason,
    mention,
    models,
    moveChat,
    moveChatToFolder,
    newDraftKey,
    newWorktree,
    openById,
    openSettings,
    openThread,
    options,
    pages,
    panel,
    panelShown,
    permissionMode,
    personal,
    planMode,
    preferences,
    projectState,
    promptKeys,
    proposedPlan,
    providerSettings,
    readOnlyRun,
    replaceFrom,
    replacement,
    restoreComposerFocus,
    runtime,
    selectProject,
    selected,
    selectedLiveError,
    selectedLoveChat,
    selectedModel,
    send,
    sendBlocked,
    sendShell,
    session,
    sessionRows,
    setError,
    setNewWorktree,
    setPanel,
    setSideChat,
    setSlashNotice,
    setWorkingAgentsOnly,
    setWorkingHost,
    settingsSnapshot,
    show,
    shownEntries,
    shownTeam,
    sideChat,
    sidebarModel,
    slash,
    slashNotice,
    startReview,
    stop,
    team,
    teamRoot,
    visibleSlashNotice,
    waitingIds,
    workingAgentsOnly,
    workingHost,
    workingTeam,
  } = workspace;
  return (
    <ViewBoundary label="Chat" resetKey={selected?.id}>
      <div className="chat-split">
        <div
          className={`chat-view${!selected && !shownEntries.length ? " empty-chat" : ""}`}
          data-team-loading={awaitingTeam || undefined}
        >
          <WorkspaceTranscript
            session={session}
            runtime={runtime}
            history={history}
            projectState={projectState}
            pages={pages}
            sidebarModel={sidebarModel}
            selectedModel={selectedModel}
            replacement={replacement}
            earlier={earlier}
            personal={personal}
            shownEntries={shownEntries}
            models={models}
            chatConversation={chatConversation}
            workingHost={workingHost}
            activeTurn={activeTurn}
            proposedPlan={proposedPlan}
            permissionMode={permissionMode}
            error={error}
            dark={dark}
            awaitingTeam={awaitingTeam}
            continues={continues}
            readOnlyRun={readOnlyRun}
            selectProject={selectProject}
            addProject={addProject}
            replaceFrom={replaceFrom}
            answerPlan={answerPlan}
            approvalCardProps={approvalCardProps}
            openById={openById}
            show={show}
          >
            {transcriptAlerts}
          </WorkspaceTranscript>
          <WorkspaceComposer
            session={session}
            runtime={runtime}
            projectState={projectState}
            sideChat={sideChat}
            setSideChat={setSideChat}
            panel={panel}
            setPanel={setPanel}
            sessionRows={sessionRows}
            closePanel={closePanel}
            openSettings={openSettings}
            startReview={startReview}
            visibleSlashNotice={visibleSlashNotice}
            fastSuccess={fastSuccess}
            slashNotice={slashNotice}
            setSlashNotice={setSlashNotice}
            selectedLiveError={selectedLiveError}
            setError={setError}
            restoreComposerFocus={restoreComposerFocus}
            editQueued={editQueued}
            send={send}
            focusComposer={focusComposer}
            activeTurn={activeTurn}
            chatFolder={chatFolder}
            newWorktree={newWorktree}
            setNewWorktree={setNewWorktree}
            readOnlyRun={readOnlyRun}
            setWorkingHost={setWorkingHost}
            continueHere={continueHere}
            selectProject={selectProject}
            addProject={addProject}
            moveChat={moveChat}
            moveChatToFolder={moveChatToFolder}
          >
            <WorkspaceComposerInput
              session={session}
              options={options}
              composer={composer}
              attachmentsState={attachmentState}
              drafts={draftStore}
              runtime={runtime}
              projectState={projectState}
              pages={pages}
              preferences={preferences}
              selectedModel={selectedModel}
              settings={conversationSettings}
              commands={conversationCommands}
              slash={slash}
              mention={mention}
              promptKeys={promptKeys}
              models={models}
              settingsSnapshot={settingsSnapshot}
              providerSettings={providerSettings}
              newDraftKey={newDraftKey}
              permissionMode={permissionMode}
              planMode={planMode}
              activeTurn={activeTurn}
              readOnlyRun={readOnlyRun}
              continues={continues}
              sendBlocked={sendBlocked}
              imageBlocked={imageBlocked}
              selectedLoveChat={selectedLoveChat}
              loveSpotAudioReason={loveSpotAudioReason}
              send={send}
              sendShell={sendShell}
              stop={stop}
              editDraft={editDraft}
              focusComposer={focusComposer}
              show={show}
            />
          </WorkspaceComposer>
        </div>
        {selected && teamRoot && team.length > 0 && agentsPanel && !panelShown && (
          <ChatTeamPanel
            selected={selected}
            teamRoot={teamRoot}
            team={team}
            workingTeam={workingTeam}
            shownTeam={shownTeam}
            workingAgentsOnly={workingAgentsOnly}
            setWorkingAgentsOnly={setWorkingAgentsOnly}
            waitingIds={waitingIds}
            activity={activity}
            models={models}
            agentColours={agentColours}
            openById={openById}
            openThread={openThread}
          />
        )}
      </div>
    </ViewBoundary>
  );
}

import type React from "react";
import { ArrowDown } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { BrandWordmark } from "@/components/brand-wordmark";
import type { PermissionMode } from "@/components/composer-controls";
import { FailedTurnCard } from "@/components/failed-turn-card";
import { LoadOnScroll } from "@/components/load-on-scroll";
import { PersonalTip, type usePersonal } from "@/components/personal-tip";
import { PlanCard } from "@/components/plan-card";
import { ProjectMenu } from "@/components/project-picker";
import { PromptRail } from "@/components/prompt-rail";
import { WorkingPlacement } from "@/components/transcript";
import { Button } from "@/components/ui/button";
import { WorkflowChat } from "@/components/workflow-chat";
import type { Entry, Model } from "@/lib/api";
import type { createApprovalActions } from "@/lib/approval-actions";
import type { createConversationSettings } from "@/lib/conversation-settings";
import type { createEarlierMessages } from "@/lib/earlier-messages";
import type { createMessageActions } from "@/lib/message-actions";
import type { modelSelection } from "@/lib/model-selection";
import type { createProjectActions } from "@/lib/project-actions";
import { approvalDraftKey } from "@/lib/use-drafts";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { useTranscriptHistory } from "@/lib/use-transcript-history";
import type { useTurnReplacementView } from "@/lib/use-turn-replacement-view";
import type { useWorkspacePagesState } from "@/lib/use-workspace-pages-state";
import type { View } from "@/lib/workspace-types";

type Props = {
  session: ReturnType<typeof useConversationSession>;
  runtime: ReturnType<typeof useRuntimeState>;
  history: ReturnType<typeof useTranscriptHistory>;
  projectState: ReturnType<typeof useProjectState>;
  pages: ReturnType<typeof useWorkspacePagesState>;
  sidebarModel: ReturnType<typeof useSidebarThreads>;
  selectedModel: ReturnType<typeof modelSelection>;
  replacement: ReturnType<typeof useTurnReplacementView>;
  earlier: ReturnType<typeof createEarlierMessages>;
  personal: ReturnType<typeof usePersonal>;
  shownEntries: Entry[];
  models: Model[];
  chatConversation: React.ReactNode;
  workingHost: HTMLDivElement | null;
  activeTurn: string | undefined;
  proposedPlan: string | null | undefined;
  permissionMode: PermissionMode;
  error: string;
  dark: boolean;
  awaitingTeam: boolean;
  continues: boolean;
  readOnlyRun: boolean;
  selectProject: ReturnType<typeof createProjectActions>["selectProject"];
  addProject: ReturnType<typeof createProjectActions>["addProject"];
  replaceFrom: ReturnType<typeof createMessageActions>["replaceFrom"];
  answerPlan: ReturnType<typeof createConversationSettings>["answerPlan"];
  approvalCardProps: ReturnType<typeof createApprovalActions>["approvalCardProps"];
  openById: (id: string) => Promise<void>;
  show: (view: View) => void;
  children: React.ReactNode;
};

export function WorkspaceTranscript({
  session,
  runtime,
  history,
  projectState,
  pages,
  sidebarModel,
  selectedModel,
  replacement,
  earlier,
  personal,
  shownEntries,
  models,
  chatConversation,
  workingHost,
  activeTurn,
  proposedPlan,
  permissionMode,
  error,
  dark,
  awaitingTeam,
  continues,
  readOnlyRun,
  selectProject,
  addProject,
  replaceFrom,
  answerPlan,
  approvalCardProps,
  openById,
  show,
  children,
}: Props) {
  const {
    selected,
    threads,
    loading,
    busy,
    scroll,
    stickToBottom,
    followingBottom,
    awayFromBottom,
    setAwayFromBottom,
  } = session;
  const { ready, connected, stoppedTurns, failedTurns, approvals } = runtime;
  const { itemCursor, heldCount, historyGaps } = history;
  const { project, projects } = projectState;
  const { setRecordedWorkflow } = pages;
  const { workflowCatalog, selectedWorkflow } = sidebarModel;
  const { selectedChoice } = selectedModel;
  const { replaceable, replacementOptions } = replacement;
  const { earlierHeld, older } = earlier;
  const workflowIdentity = selectedWorkflow ? workflowCatalog.identities[selectedWorkflow.id] : undefined;
  const failedTurn = selected ? failedTurns[selected.id] : undefined;
  const failedInput = failedTurn ? replacementOptions.get(failedTurn.turnId) : undefined;
  return (
    <div className="chat-scroll-wrap">
      <div
        className="chat-scroll"
        aria-busy={awaitingTeam || undefined}
        ref={scroll}
        onClickCapture={event => {
          if (event.target instanceof Element && event.target.closest("[data-preserve-scroll]")) {
            followingBottom.current = false;
            stickToBottom.current = false;
          }
        }}
        onWheel={() => {
          followingBottom.current = false;
        }}
        onPointerDown={() => {
          followingBottom.current = false;
        }}
        onKeyDown={event => {
          if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key))
            followingBottom.current = false;
        }}
        onScrollEnd={event => {
          if (followingBottom.current) {
            followingBottom.current = false;
            event.currentTarget.scrollTo({ top: event.currentTarget.scrollHeight });
          }
        }}
        onScroll={event => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          stickToBottom.current = followingBottom.current || atBottom;
          setAwayFromBottom(!atBottom);
        }}
      >
        <div className="chat-content">
          {itemCursor || (heldCount >= 0 && earlierHeld(selected?.id)) ? (
            <LoadOnScroll
              className="load-earlier-messages"
              loading={loading}
              paused={!!error}
              label="Loading earlier messages"
              onLoad={() => void older()}
            />
          ) : (
            !loading &&
            selected &&
            historyGaps.has(selected.id) && (
              <div className="context-event" role="note">
                The earliest part of this chat is missing, so it opened with the history that remains.
              </div>
            )
          )}
          {loading && !shownEntries.length && (
            <p role="status" className="chat-loading text-muted-foreground">
              Loading conversation…
            </p>
          )}
          {selectedWorkflow && (
            <WorkflowChat
              threads={threads}
              run={selectedWorkflow}
              {...(workflowIdentity !== undefined ? { identity: workflowIdentity } : {})}
              ready={ready && connected}
              models={models}
              onOpenChat={id => void openById(id)}
              onOpenCanvas={run => {
                setRecordedWorkflow({ id: run.id, rootThreadId: run.rootThreadId });
                show("canvas");
              }}
            />
          )}
          {!selectedWorkflow && !loading && !shownEntries.length && !activeTurn && (
            <div className="empty-state">
              {selected ? (
                <>
                  <h2>This conversation has no messages yet.</h2>
                  <p>Messages and tool activity appear here.</p>
                </>
              ) : (
                <>
                  <BrandWordmark className="empty-mark" dark={dark} />
                  <h2>
                    {project ? (
                      <>
                        What should we build in{" "}
                        <ProjectMenu
                          variant="heading"
                          projects={projects}
                          selected={project}
                          disabled={!ready || busy}
                          onSelect={selectProject}
                          onAdd={() => void addProject()}
                        />
                        ?
                      </>
                    ) : (
                      "What should we build?"
                    )}
                  </h2>
                  {personal.showTip && <PersonalTip onOpen={personal.open} onDismiss={personal.dismiss} />}
                </>
              )}
            </div>
          )}
          <WorkingPlacement.Provider value={workingHost}>{chatConversation}</WorkingPlacement.Provider>
          {selected && stoppedTurns[selected.id] && !activeTurn && (
            <p className="turn-stopped" role="status">
              Stopped. The reply above is where it was when the turn was stopped.
            </p>
          )}
          {failedTurn && (
            <FailedTurnCard
              key={`${selected?.id}:${failedTurn.turnId}`}
              failure={failedTurn}
              models={selectedChoice?.models ?? models}
              {...(selected?.model !== undefined ? { currentModel: selected.model } : {})}
              disabled={!replaceable}
              {...(continues
                ? { blockedReason: "Continue this conversation here before trying again." }
                : failedInput?.allowed
                  ? {}
                  : {
                      blockedReason:
                        failedInput?.reason ??
                        "The original complete input is unavailable, so this turn cannot be safely resent.",
                    })}
              {...(!continues && failedInput?.allowed
                ? {
                    onRetry: (retryModel: string | undefined) =>
                      replaceFrom(failedTurn.turnId, failedInput.prompt, undefined, retryModel),
                  }
                : {})}
            />
          )}
          {selected && proposedPlan && !readOnlyRun && (
            <PlanCard
              mode={permissionMode}
              busy={busy || !connected}
              onImplement={permissions =>
                answerPlan(selected, proposedPlan, { implement: true, ...(permissions ? { permissions } : {}) })
              }
              onKeepPlanning={feedback => answerPlan(selected, proposedPlan, { feedback })}
            />
          )}
          {approvals
            .filter(a => a.params.threadId === selected?.id)
            .map(a => (
              <ApprovalCard key={approvalDraftKey(a)} {...approvalCardProps(a)} />
            ))}
          {children}
        </div>
        <PromptRail
          scroller={scroll}
          threadId={selected?.id ?? null}
          entries={shownEntries}
          onLoadEarlier={older}
          onNavigate={() => {
            followingBottom.current = false;
            stickToBottom.current = false;
          }}
        />
        {awayFromBottom && (
          <Button
            variant="outline"
            size="icon-lg"
            className="scroll-to-bottom"
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            onClick={() => {
              followingBottom.current = true;
              stickToBottom.current = true;
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <ArrowDown size={16} />
          </Button>
        )}
      </div>
      {awaitingTeam && (
        <p role="status" className="chat-loading chat-team-loading text-muted-foreground">
          Loading conversation…
        </p>
      )}
    </div>
  );
}

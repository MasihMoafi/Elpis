import type React from "react";
import { BranchChip } from "@/components/branch-chip";
import { ElpisFeatures } from "@/components/elpis-features";
import { EnvironmentMenu, ProjectMenu } from "@/components/project-picker";
import { QueuedFollowUps } from "@/components/queued-follow-ups";
import type { SettingsDestination } from "@/components/settings-view";
import { SideChat } from "@/components/side-chat";
import { DiffPanel, ReviewPanel, SessionPanel } from "@/components/slash-panels";
import { TaskList } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { ViewBoundary } from "@/components/view-boundary";
import { AGENT_RUN_NOTICE } from "@/lib/api";
import type { createChatSend } from "@/lib/chat-send";
import type { createCommandActions } from "@/lib/command-actions";
import type { createConversationActions } from "@/lib/conversation-actions";
import type { createProjectActions } from "@/lib/project-actions";
import type { createReplyActions } from "@/lib/reply-actions";
import type { useConversationSession } from "@/lib/use-conversation-session";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { ComposerPanel, SideChatState } from "@/lib/use-composer-panels";

type Props = {
  session: ReturnType<typeof useConversationSession>; runtime: ReturnType<typeof useRuntimeState>; projectState: ReturnType<typeof useProjectState>;
  sideChat: SideChatState; setSideChat: React.Dispatch<React.SetStateAction<SideChatState>>;
  panel: ComposerPanel; setPanel: React.Dispatch<React.SetStateAction<ComposerPanel>>; sessionRows: [string, string][]; closePanel: () => void;
  openSettings: (tab: SettingsDestination) => void; startReview: ReturnType<typeof createCommandActions>["startReview"];
  visibleSlashNotice: string; fastSuccess: RegExpExecArray | null; slashNotice: string; setSlashNotice: React.Dispatch<React.SetStateAction<string>>;
  selectedLiveError: string | undefined; setError: React.Dispatch<React.SetStateAction<string>>; restoreComposerFocus: (origin: Element | null) => number;
  editQueued: ReturnType<typeof createReplyActions>["editQueued"]; send: ReturnType<typeof createChatSend>; focusComposer: () => void;
  activeTurn: string | undefined; chatFolder: string | null | undefined; newWorktree: boolean; setNewWorktree: React.Dispatch<React.SetStateAction<boolean>>;
  readOnlyRun: boolean; setWorkingHost: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>;
  continueHere: ReturnType<typeof createConversationActions>["continueHere"];
  selectProject: ReturnType<typeof createProjectActions>["selectProject"]; addProject: ReturnType<typeof createProjectActions>["addProject"];
  moveChat: ReturnType<typeof createProjectActions>["moveChat"]; moveChatToFolder: ReturnType<typeof createProjectActions>["moveChatToFolder"];
  children: React.ReactNode;
};

export function WorkspaceComposer({ session, runtime, projectState, sideChat, setSideChat, panel, setPanel, sessionRows, closePanel, openSettings, startReview, visibleSlashNotice, fastSuccess, slashNotice, setSlashNotice, selectedLiveError, setError, restoreComposerFocus, editQueued, send, focusComposer, activeTurn, chatFolder, newWorktree, setNewWorktree, readOnlyRun, setWorkingHost, continueHere, selectProject, addProject, moveChat, moveChatToFolder, children }: Props) {
  const { selected, busy, loading } = session;
  const { ready, connected, plans, activeTurns, historyOnly } = runtime;
  const { projects, project } = projectState;
  const selectedPlan = selected ? plans[selected.id] : undefined;
  const folder = (path?: string | null) => path ? path.split("/").filter(Boolean).at(-1) || path : "";
  return (
        <div className="composer-wrap">
          {sideChat && selected?.id === sideChat.parentId && <SideChat key={`${sideChat.parentId}:${sideChat.question?.kind === "recap" ? sideChat.question.id : "side"}`} parentId={sideChat.parentId} open={sideChat.open} {...(sideChat.question !== undefined ? { question: sideChat.question } : {})} onClose={() => { setSideChat(previous => previous ? { ...previous, open: false } : null); focusComposer(); }}  onForward={answer => void send(`From the side chat:\n\n${answer}`)} />}
          <ViewBoundary label="This panel" resetKey={panel}>
          {panel === "status" && <SessionPanel rows={sessionRows} {...(selected ? { threadId: selected.id } : {})} onUsage={() => { setPanel(null); openSettings("usage"); }} onClose={closePanel} />}
          {panel === "review" && selected && <ReviewPanel threadId={selected.id} onStart={target => void startReview(selected, target)} onClose={closePanel} />}
          {panel === "diff" && selected && <DiffPanel threadId={selected.id} onClose={closePanel} />}
          </ViewBoundary>
          {visibleSlashNotice && <p key={visibleSlashNotice} role="status" data-fast-notice={fastSuccess ? "" : undefined} onAnimationEnd={fastSuccess ? () => setSlashNotice(current => current === slashNotice ? "" : current) : undefined} className="mx-auto mb-2 w-full max-w-[var(--transcript-width,740px)] px-1 text-sm text-muted-foreground">{visibleSlashNotice}</p>}
          {selected && selectedPlan && <TaskList plan={selectedPlan} running={activeTurns[selected.id] === selectedPlan.turnId} />}
          <QueuedFollowUps {...(selected ? { threadId: selected.id } : {})} {...(activeTurn !== undefined ? { activeTurnId: activeTurn } : {})} onError={setError} onComplete={restoreComposerFocus} onEdit={editQueued} />
          {!selected && <div className="composer-tray"><EnvironmentMenu folder={chatFolder || null} disabled={!ready || busy} worktree={newWorktree} onWorktree={setNewWorktree} /><ProjectMenu variant="chip" projects={projects} selected={project} disabled={!ready || busy} onSelect={selectProject} onAdd={() => void addProject()} /></div>}
          <div className="composer-working" ref={setWorkingHost} />
          {readOnlyRun ? <div className="mx-auto flex w-full max-w-[var(--transcript-width,740px)] flex-col gap-3 rounded-lg border p-4 text-sm text-muted-foreground" role="status">
            <p>{AGENT_RUN_NOTICE}</p>
            {selected?.desktopAccess?.canContinue && !activeTurn && selected.status?.type !== "active" && <Button variant="outline" size="sm" className="self-start" disabled={busy || !connected || loading} onClick={() => void continueHere(selected)}>Continue here</Button>}
          </div> : children}
          <div className="composer-meta">
            {selected && <ProjectMenu variant="chip" label="Change folder" addLabel="Choose folder…" allowNone={false} projects={projects} disabled={!ready || !connected || readOnlyRun}
              selected={projects.find(item => item.cwd.replace(/\/+$/, "") === selected.cwd?.replace(/\/+$/, "")) ?? (selected.cwd ? { id: `folder:${selected.cwd}`, name: folder(selected.cwd), cwd: selected.cwd } : null)}
              onSelect={moveChat} onAdd={() => void moveChatToFolder()} />}
            {selected?.cwd && <BranchChip key={selected.id} threadId={selected.id} running={!!activeTurn} onNotice={setSlashNotice} />}
            <span className="composer-hint">{selectedLiveError ? `Not following live (${selectedLiveError}); the chat refreshes every few seconds.` : selected && historyOnly[selected.id] ? "This agent is running in an earlier Elpis runtime. Its completed history will appear when it finishes." : ""}</span>
            <ElpisFeatures />
          </div>
        </div>

  );
}

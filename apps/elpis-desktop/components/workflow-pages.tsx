import type React from "react";
import { AgentsCanvas } from "@/components/agents-canvas";
import { AutomationsView, type WorkflowPrefill } from "@/components/automations-view";
import { CanvasGuideHelp } from "@/components/canvas-guide-help";
import { ProjectMenu } from "@/components/project-picker";
import { ViewBoundary } from "@/components/view-boundary";
import type { Model, Thread } from "@/lib/api";
import type { createChatNavigation } from "@/lib/chat-navigation";
import type { createProjectActions } from "@/lib/project-actions";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { useSidebarThreads } from "@/lib/use-sidebar-threads";
import type { WorkflowRun } from "@/lib/workflow-identity";
import type { View, WorkflowReplay } from "@/lib/workspace-types";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
type Props = {
  view: View; workflowTab: "board" | "scheduled"; setWorkflowTab: Setter<"board" | "scheduled">;
  recordedWorkflow: Pick<WorkflowRun, "id" | "rootThreadId"> | undefined; setRecordedWorkflow: Setter<Pick<WorkflowRun, "id" | "rootThreadId"> | undefined>;
  workflowPrefill: WorkflowPrefill | null; setWorkflowPrefill: Setter<WorkflowPrefill | null>;
  sidebarModel: ReturnType<typeof useSidebarThreads>; projectState: ReturnType<typeof useProjectState>; runtime: ReturnType<typeof useRuntimeState>;
  threads: Thread[]; models: Model[]; workflowFolder: string | undefined; workflowSandbox: string | undefined; dark: boolean;
  show: (view: View) => void; openById: (id: string) => void; keepWorkflowTab: ReturnType<typeof createChatNavigation>["keepWorkflowTab"];
  selectProject: ReturnType<typeof createProjectActions>["selectProject"]; addProject: ReturnType<typeof createProjectActions>["addProject"]; workIn: ReturnType<typeof createProjectActions>["workIn"];
  finishReplay: (replay: WorkflowReplay, result: { threadId?: string; error?: string }) => void;
};

export function WorkflowPages({ view, workflowTab, setWorkflowTab, recordedWorkflow, setRecordedWorkflow, workflowPrefill, setWorkflowPrefill, sidebarModel, projectState, runtime, threads, models, workflowFolder, workflowSandbox, dark, show, openById, keepWorkflowTab, selectProject, addProject, workIn, finishReplay }: Props) {
  const { workflowCatalog } = sidebarModel;
  const { projects, workflowProject, projectChanging } = projectState;
  const { ready, connected, replays } = runtime;
  return <>
      {/* 6 Nov, Masih: "automation is kind of a workflow, isn't it? couldn't we have merged those?" Workflows has two views:
          the board and its Scheduled automations (components/automations-view.tsx). The board stays mounted, so its draft
          survives a look at the schedule. */}
      {view === "canvas" && <ViewBoundary label="Workflows"><div className="contents" hidden={workflowTab !== "board"}><CanvasGuideHelp onOpen={() => show("agentsGuide")}><AgentsCanvas threads={threads} key={recordedWorkflow?.id ?? "draft"} {...(recordedWorkflow ? { recordedRun: recordedWorkflow } : {})} onLeaveRecordedRun={() => setRecordedWorkflow(undefined)} onOpenRecordedRun={run => setRecordedWorkflow(run)} ready={ready && connected} workflowCatalog={workflowCatalog} models={models} {...(workflowFolder !== undefined ? { cwd: workflowFolder } : {})} dark={dark} onOpenChat={id => { show("chat"); void openById(id); }} onRunStarted={keepWorkflowTab} onSchedule={workflow => { setWorkflowPrefill(workflow); setWorkflowTab("scheduled"); }}
        projectMenu={<ProjectMenu variant="chip" projects={projects} selected={workflowProject ?? { id: "workflow-sandbox", name: "Sandbox", cwd: workflowSandbox ?? "" }} allowNone={!!workflowProject} noneLabel="Use sandbox" disabled={!ready || projectChanging} onSelect={selectProject} onAdd={() => void addProject()} />} onUseFolder={workIn} /></CanvasGuideHelp></div>
        {workflowTab === "scheduled" && <AutomationsView projects={projects} prefill={workflowPrefill} onPrefillUsed={() => setWorkflowPrefill(null)} onOpenChat={id => { show("chat"); void openById(id); }} />}</ViewBoundary>}
      {replays.map(replay => <div key={replay.token} hidden aria-hidden="true"><AgentsCanvas threads={threads} workflowCatalog={workflowCatalog} models={models} {...(replay.cwd != null ? { cwd: replay.cwd } : {})} dark={dark} ready={ready && connected}
        onOpenChat={id => { show("chat"); void openById(id); }} scheduled={{ board: replay.board, onDone: result => finishReplay(replay, result) }} /></div>)}
  </>;
}

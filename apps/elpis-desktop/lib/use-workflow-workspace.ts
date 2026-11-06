import { useCallback, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import { useWorkflowSandbox } from "@/lib/workflow-identity";
import type { useProjectState } from "@/lib/use-project-state";
import type { useRuntimeState } from "@/lib/use-runtime-state";
import type { View, WorkflowReplay } from "@/lib/workspace-types";

export function useWorkflowWorkspace(view: View, projects: ReturnType<typeof useProjectState>, runtime: ReturnType<typeof useRuntimeState>, setError: Dispatch<SetStateAction<string>>) {
  const { workflowProject } = projects, { ready, connected, setReplays } = runtime;
  /** Scheduled workflows this window claimed replay their saved board out of sight and report the run's chat. */
  const finishReplay = useCallback((replay: WorkflowReplay, result: { threadId?: string; error?: string }) => {
    setReplays(previous => previous.filter(item => item.token !== replay.token));
    void api(`/automations/${replay.taskId}`, { action: "result", token: replay.token, ...result }).catch(() => {});
  }, []);
  const workflowSandbox = useWorkflowSandbox(view === "canvas" && ready && connected && !workflowProject, setError);
  const workflowFolder = workflowProject?.cwd || workflowSandbox;
  return { finishReplay, workflowSandbox, workflowFolder };
}

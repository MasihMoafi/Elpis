import { loveNodeSpec } from "./love-agents.mts";
import { workerBudget } from "./memory-budget.mts";
import type {
  WorkflowRecord,
  AcpControl,
  CheckpointContext,
  ModelRoute,
  WorkflowOptions,
} from "./workflow-acp/types.mts";
import { createRunStorage } from "./workflow-acp/create-run-storage.mts";
import { createRunProgress } from "./workflow-acp/create-run-progress.mts";
import { createNodeRouting } from "./workflow-acp/create-node-routing.mts";
import { createMotherTurns } from "./workflow-acp/create-mother-turns.mts";
import { createRunOutputs } from "./workflow-acp/create-run-outputs.mts";
import { createSupervision } from "./workflow-acp/create-supervision.mts";
import { createReplanning } from "./workflow-acp/create-replanning.mts";
import { createReview } from "./workflow-acp/create-review.mts";
import { createExecution } from "./workflow-acp/create-execution.mts";
import { createRunApi } from "./workflow-acp/create-run-api.mts";

/** ACP owns node execution. This scheduler owns Kahn dependencies, bounded rounds, concurrency and failure state. */
/** `onEnd(record)` hears each run's final record once it is saved: the bridge starts a run's next stage from it. */
export function createWorkflowRuns(
  {
    stateDir,
    nodeSpec = loveNodeSpec,
    env = process.env,
    timeoutMs,
    onSession,
    onEnd,
    modelRoutes,
    modelDefaults,
    observeThread,
    listThreadDescendants,
    budget = workerBudget,
  }: WorkflowOptions = {} as WorkflowOptions,
) {
  const records = new Map<string, WorkflowRecord>(),
    active = new Map<string, AbortController>();
  const controls = new Map<string, AcpControl>(),
    progressTimers = new Map<string, ReturnType<typeof setTimeout>>(),
    supervision = new Map<string, Promise<unknown>>(),
    routeSnapshots = new Map<string, Promise<ModelRoute[]>>(),
    exhaustedProviders = new Map<string, Set<string>>();
  const mergingSources = new Set<string>(),
    mergeControllers = new Map<string, AbortController>(),
    checkpoints = new Map<string, CheckpointContext>();
  const { save, freeRun, load, gone } = createRunStorage({ stateDir, records });
  const { progress, permission, logLine } = createRunProgress({ save, progressTimers });
  const { runNode } = createNodeRouting({
    modelRoutes,
    routeSnapshots,
    exhaustedProviders,
    progress,
    save,
    nodeSpec,
    env,
    onSession,
  });
  const { motherRoute, motherOf, askMother } = createMotherTurns({ runNode, progress });
  const { handed, spill } = createRunOutputs({ stateDir });
  const { cancelCheckpoints, supervise, queueSupervision, finishCheckpoints } = createSupervision({
    supervision,
    checkpoints,
    motherRoute,
    motherOf,
    save,
    askMother,
    handed,
    timeoutMs,
    progress,
    controls,
    permission,
  });
  const { decide } = createReplanning({
    motherRoute,
    motherOf,
    logLine,
    save,
    handed,
    askMother,
    timeoutMs,
    progress,
    controls,
    permission,
  });
  const { reviewAndMerge } = createReview({
    motherRoute,
    motherOf,
    save,
    askMother,
    handed,
    timeoutMs,
    progress,
    controls,
    permission,
    progressTimers,
  });
  const { execute } = createExecution({
    handed,
    save,
    runNode,
    timeoutMs,
    permission,
    progress,
    controls,
    cancelCheckpoints,
    supervise,
    spill,
    queueSupervision,
    decide,
    logLine,
    budget,
    finishCheckpoints,
    reviewAndMerge,
    freeRun,
    progressTimers,
    supervision,
    routeSnapshots,
    exhaustedProviders,
    active,
    stateDir,
    records,
    onEnd,
  });
  return createRunApi({
    active,
    mergingSources,
    load,
    records,
    mergeControllers,
    stateDir,
    modelDefaults,
    save,
    execute,
    gone,
    observeThread,
    listThreadDescendants,
    routeSnapshots,
    exhaustedProviders,
    freeRun,
    reviewAndMerge,
    controls,
  });
}

export { createWorkflowHistory } from "./workflow-acp/history.mts";
export { validateWorkflow } from "./workflow-acp/validation.mts";
export { REPLAN_LIMIT, ADD_LIMIT } from "./workflow-acp/limits.mts";
export { summarize } from "./workflow-acp/format.mts";

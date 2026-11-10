import type { runAcpNode } from "../acp-nodes.mts";
import type { workflowDefaults } from "../workflow-models.mts";
import type { workflowWorktrees, checkWorkflowReview } from "../workflow-worktrees.mts";
import type { workerBudget } from "../memory-budget.mts";

export type WorkflowTask = {
  id: string;
  kind: string;
  dependsOn: string[];
  feedbackFrom?: string[];
  writeScopes: string[];
  unchecked?: boolean;
  status?: string;
  cancelledBy?: string;
};

export type ProgressEntry =
  | { kind: "thinking" | "text"; messageId?: string | null | undefined; text: string; at: number; title?: never }
  | {
      kind: "tool";
      id?: string | undefined;
      at?: number;
      title?: string;
      status?: string;
      text?: never;
      messageId?: never;
    };

export type ProgressUpdate = {
  sessionUpdate?: string;
  messageId?: string | null | undefined;
  content?: { type?: string; text: string };
  toolCallId?: string;
  title?: string;
  status?: string;
};

export type HistoryRun = {
  id: string;
  status: string;
  next?: { status: string };
  tasks?: { status: string }[];
  mother?: { status?: string };
  review?: { status: string };
};

export type RouteAttempt = {
  model: string;
  provider: string;
  runsOn?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  reason?: string;
};

export type SteerMessage = {
  id: string;
  text: string;
  status: string;
  at: number;
  round: number;
  delivery?: string;
  error?: string;
};

export type TaskResult = {
  summary: string;
  file?: string;
  candidateCommit?: string;
  reviewedCommit?: string;
  diff?: string;
  commits?: { sha: string; subject: string }[];
  relocated?: { from: string; to: string }[];
};

export type StoredTask = WorkflowTask & {
  title: string;
  instruction: string;
  acceptanceCriteria: string[];
  status: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  assignedThreadId?: string | null;
  sessionId?: string | null;
  threads?: string[];
  addedBy?: string;
  result?: TaskResult | null;
  failureReason?: string | null;
  progress?: ProgressEntry[];
  permissions?: {
    at: number;
    round: number;
    sessionId?: string | undefined;
    toolCallId?: string | undefined;
    title: string;
    optionId: string | null;
  }[];
  messages?: (SteerMessage & { source?: string })[];
  manualRevision?: number;
  cwd?: string;
  worktree?: ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>["paths"]>[number] | undefined;
  parts?: string[];
  output?: string;
  flow?: boolean;
  fixed?: boolean;
  scopeFixed?: boolean;
  supervisedRound?: number;
  supervisorInstruction?: string;
  activeReview?: { status: string };
  routing?: {
    requested: { model: string; provider: string };
    actual: { model: string; provider: string } | null;
    attempts: RouteAttempt[];
  };
};

export type ReadyReview = Parameters<typeof checkWorkflowReview>[0] & {
  status: string;
  stat?: string;
  error?: string | undefined;
};

export type WorkflowReview = (
  Awaited<ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>["review"]>> | ReadyReview
) & { error?: string | undefined };

export type Mother = Partial<StoredTask> & {
  id: string;
  title: string;
  decisions: (Record<string, unknown> & { status?: string; kind?: string; reasons?: string })[];
  replans?: number;
  replanLimitNoted?: boolean;
};

export type WorkflowRecord = {
  id: string;
  rootThreadId: string;
  name: string;
  status: string;
  ownerPid: number;
  startedAt: number;
  createdAt?: number;
  round: number;
  tasks: StoredTask[];
  goal?: string;
  roundLimit?: number;
  maxConcurrency?: number;
  maxRuntimeSeconds?: number;
  runLimitSeconds?: number;
  isolation?: string;
  runsOn?: string;
  replan?: boolean;
  autoMerge?: boolean;
  projectCwd?: string;
  defaults?: ReturnType<typeof workflowDefaults>;
  motherModel?: { model: string; provider: string; reasoningEffort?: string };
  mother?: Mother;
  review?: WorkflowReview;
  next?: { status: string; threadId?: string; tasks?: StoredTask[]; [key: string]: unknown };
  worktreeBase?: string;
  worktrees?: ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>["paths"]>;
  cleanup?: { status: string; at: number; error?: string };
  recovery?: { model: string; provider?: string; at: number };
  endedAt?: number;
  resumedAt?: number;
  error?: string | null | undefined;
  persistenceError?: string;
  log?: { at: number; text: string }[];
};

export type WorkflowParams = Omit<WorkflowRecord, "id" | "status" | "ownerPid" | "startedAt" | "round" | "tasks"> & {
  tasks: Omit<StoredTask, "status">[];
};

export type StartedRun = { graphId: string; threadId: string; turnId: string };

export type AcpOptions = NonNullable<Parameters<typeof runAcpNode>[2]>;

export type AcpControl = Parameters<NonNullable<AcpOptions["onControl"]>>[0];

export type NodeInput = { task: string; inputs?: { name: string; answer: string; file?: string }[] };

export type NodeOptions = AcpOptions & { lowEffort?: boolean };

export type RequestedRoute = { model: string; provider: string };

export type Root = { cwd: string; model?: string; modelProvider?: string };

export type PermissionRequest = {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string };
  options?: { kind: string; optionId: string; name?: string }[];
};

export type CheckpointContext = {
  record: object;
  task: object;
  reason?: string;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  queued: boolean;
  checkpoint: { status: string; reason?: string };
  unlink: () => void;
};

export type ModelRoute = {
  model: string;
  provider: string;
  exhausted?: boolean;
  reason?: string;
  efforts?: string[] | undefined;
  defaultEffort?: string | null | undefined;
};

export type WorkflowOptions = {
  stateDir: string;
  nodeSpec?: (
    node: { name: string; prompt: string; model: string; provider: string },
    env: NodeJS.ProcessEnv,
  ) => Parameters<typeof runAcpNode>[0];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSession?: (record: unknown, owner: unknown, id: string) => void | (() => void);
  onEnd?: (record: unknown) => unknown;
  modelRoutes?: () => ModelRoute[] | Promise<ModelRoute[]>;
  modelDefaults?: () => ReturnType<typeof workflowDefaults> | Promise<ReturnType<typeof workflowDefaults>>;
  observeThread?: (id: string) => Promise<{ status?: { type?: string } | null } | null>;
  listThreadDescendants?: (options: {
    ancestorThreadId: string;
    limit: number;
    cursor?: string;
  }) => Promise<{
    data?: { id: string; parentThreadId?: string | null; source?: unknown }[];
    nextCursor?: string | null;
  }>;
  budget?: typeof workerBudget;
};

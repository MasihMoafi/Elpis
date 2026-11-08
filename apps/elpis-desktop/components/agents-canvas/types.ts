import { type MouseEvent as ReactMouseEvent } from "react";
import { type XYPosition } from "@xyflow/react";
import { type WorkflowRunRef, type RecordedWorkflow } from "@/components/workflow-chat";
import type { WorkflowCatalog, WorkflowIdentity } from "@/lib/workflow-identity";
import { type Model, type Thread } from "@/lib/api";
import { type AgentData, type CanvasEdge, type CanvasGraph, type RunTask, type TaskStatus } from "@/lib/canvas";
import type * as React from "react";

/** A run: the Mother's part, and the Father agent's when the graph has more agents than she runs (lib/canvas.ts `parents`):
 * his tasks wait in `father` until her part has succeeded, then run in his own chat. */
export type Run = {
  rootThreadId: string;
  graphId: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  father?: {
    tasks: RunTask[];
    threadId?: string | undefined;
    graphId?: string | undefined;
    status: string;
    reported?: boolean | undefined;
  };
};

/** `next`: the stage the bridge runs after this one (the Father's part): his chat and run, and whether his report reached her. */
export type Listed = {
  data: {
    id: string;
    name?: string;
    status: string;
    error?: string | null;
    next?: { threadId?: string; graphId?: string; status: string; reported?: boolean; error?: string | null };
    mother?: NonNullable<RecordedWorkflow["mother"]>;
    tasks: {
      id: string;
      title?: string;
      kind?: string;
      status: TaskStatus;
      assignedThreadId: string | null;
      addedBy?: string;
      dependsOn?: string[];
      instruction?: string;
      writeScopes?: string[];
      acceptanceCriteria?: string[];
      failureReason?: string | null;
      result?: unknown;
      progress?: { kind?: string; text?: string; title?: string; status?: string; at?: number }[];
    }[];
  }[];
};

export type HandleEnd = "source" | "target";

/** `clash` is the files of a merge clash that stopped the run on this agent (lib/canvas-isolation.ts). */
export type AgentNodeData = AgentData & {
  status?: TaskStatus;
  check?: TaskStatus;
  clash?: string[];
  modelLabel?: string;
  activity?: string;
  wave?: number;
  onHandle?: (id: string, end: HandleEnd, event: ReactMouseEvent) => void;
  onQuick?: (id: string) => void;
};

export type MotherData = {
  run: "idle" | "running" | "finished" | "cancelled" | "failed";
  children: number;
  limit: number;
  identity?: WorkflowIdentity | undefined;
  onHandle?: AgentNodeData["onHandle"];
};

/** Where the command bar drops its agents, and the agent it was opened from (`as` is the end the new agents take) or
 * the wire they are inserted on. */
export type Adding = {
  at: XYPosition;
  isoAt?: XYPosition | undefined;
  left: number;
  top: number;
  height: number;
  from?: { id: string; as: HandleEnd };
  between?: CanvasEdge;
  seed?: string;
};

/** A menu's place: where it was asked for, and its corner inside the board. */
export type MenuAt = { client: XYPosition; left: number; top: number };

export type BoardMenu =
  | (MenuAt & { kind: "wire"; edge: CanvasEdge })
  | (MenuAt & { kind: "nodes"; ids: string[] })
  | (MenuAt & { kind: "mother" })
  | (MenuAt & { kind: "board" });

export type Provider = {
  id: string | null;
  label: string;
  state: "ready" | "loading" | "key" | "error";
  error?: string | undefined;
};

/** The agents canvas: the Mother, ready-made architectures, agents wired by what they wait for and laid out in Kahn's
 * waves, and a run that follows each agent live. The graph is kept on this device (lib/canvas.ts). */
/** `projectMenu` is the app's project chooser (components/project-picker.tsx), shown in the header: agents write inside the project. */
export type Props = {
  threads?: readonly Thread[];
  workflowCatalog: WorkflowCatalog;
  models: Model[];
  cwd?: string;
  dark: boolean;
  ready: boolean;
  onOpenChat: (id: string) => void;
  onRunStarted?: (thread: Thread) => void;
  projectMenu?: React.ReactNode;
  recordedRun?: WorkflowRunRef;
  onLeaveRecordedRun?: () => void;
  onOpenRecordedRun?: (run: WorkflowRunRef) => void;
  /** Makes `folder` the workflows' project (an existing project with it, or a new one named after it). */
  onUseFolder?: (folder: string) => Promise<void>;
  /** Schedule: hands this workflow (its id, name, request and project) to Workflows' Scheduled view. */
  onSchedule?: (workflow: { id: string; name: string; request: string; cwd?: string; board: CanvasGraph }) => void;
  /** A scheduled replay (6 Nov): this board, as saved with its automation, starts itself once and reports the run's chat
   * or why it did not start. It never saves over the draft on the Workflows page. */
  scheduled?: { board: CanvasGraph; onDone: (result: { threadId?: string; error?: string }) => void };
};

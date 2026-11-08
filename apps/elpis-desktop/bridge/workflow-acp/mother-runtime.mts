import type { createMotherTurns } from "./create-mother-turns.mts";
import type { createRunOutputs } from "./create-run-outputs.mts";
import type { createRunProgress } from "./create-run-progress.mts";
import type { createRunStorage } from "./create-run-storage.mts";
import type { AcpControl, WorkflowOptions } from "./types.mts";

export type MotherRuntime = Pick<ReturnType<typeof createMotherTurns>, "motherRoute" | "motherOf" | "askMother"> &
  Pick<ReturnType<typeof createRunOutputs>, "handed"> &
  Pick<ReturnType<typeof createRunProgress>, "progress" | "permission"> &
  Pick<ReturnType<typeof createRunStorage>, "save"> & {
    timeoutMs: WorkflowOptions["timeoutMs"];
    controls: Map<string, AcpControl>;
  };

/** How every Mother-agent turn in a run reports progress, control and permission, under the run's time limit. */
export function motherRunOptions<
  Run extends { id: string; maxRuntimeSeconds?: number | null },
  Node,
  Update,
  Control,
  Request, Answer
>(
  run: {
    record: Run;
    mother: Node;
    controls: { set(key: string, control: Control): unknown };
    progress: (record: Run, mother: Node, update: Update) => unknown;
    permission: (record: Run, mother: Node, request: Request) => Answer;
    timeoutMs?: number | undefined;
  },
  cwd: string,
  signal: AbortSignal,
) {
  const { record, mother, controls, progress, permission, timeoutMs } = run;
  return {
    cwd,
    signal,
    timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
    onUpdate: (update: Update) => progress(record, mother, update),
    onControl: (control: Control) => controls.set(`${record.id}:mother`, control),
    onPermission: (request: Request) => permission(record, mother, request),
  };
}

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

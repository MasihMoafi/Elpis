import fs from "node:fs/promises";
import path from "node:path";
import type { TaskResult, WorkflowOptions } from "./types.mts";
import { summarize } from "./format.mts";

export function createRunOutputs({ stateDir }: { stateDir: NonNullable<WorkflowOptions["stateDir"]> }) {
  /** Writes a child's whole answer to the run's folder and returns what later agents get: its summary and that file. */
  async function spill(record: { id: string }, task: { id: string }, round: number, answer: string) {
    try {
      const dir = path.join(stateDir, "outputs", record.id),
        file = path.join(dir, `${task.id}${round > 1 ? `-round-${round}` : ""}.md`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, answer, { mode: 0o600 });
      return { answer: summarize(answer), file };
    } catch {
      return { answer };
    }
  }

  const handed = (task: { result?: TaskResult | null }) => ({
    answer: summarize(task.result?.summary),
    ...(task.result?.file ? { file: task.result.file } : {}),
  });
  return { handed, spill };
}

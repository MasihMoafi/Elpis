import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { Run, Live, LaunchState, WorkerMessage } from './workflow-types.mts';
/** Owns script worker startup and termination; scheduling remains with WorkflowRunner. */
export function createWorkflowProcesses(maxItems: number) {
    const liveRuns = new Map<string, Live>();
    function launch(run: Run, state: LaunchState, message: (live: Live, value: WorkerMessage) => void, finish: (outcome: {
        status: string;
        error?: string;
    }) => void) {
        const source = fs.readFileSync(run.scriptPath, "utf8");
        const spent = new SharedArrayBuffer(8);
        const controller = new AbortController();
        const live: Live = { controller, spent, agents: new Map(), state, worker: null };
        Atomics.store(new BigInt64Array(spent), 0, BigInt(run.spent ?? 0));
        liveRuns.set(run.id, live);
        const worker = live.worker = new Worker(new URL("./workflow-worker.mts", import.meta.url), {
            workerData: { source, args: run.argsGiven ? run.args : undefined, budgetTotal: run.budget, spent, maxItems: maxItems, scriptPath: run.scriptPath },
            resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
        });
        worker.on("message", (m) => message(live, m));
        worker.on("error", (e) => { if (liveRuns.get(run.id) === live)
            finish({ status: "failed", error: e.message }); });
        worker.on("exit", () => { if (liveRuns.get(run.id) === live && run.status === "running")
            finish({ status: "failed", error: "The script stopped without returning." }); });
    }
    function halt(id: string, reason: Error) {
        const live = liveRuns.get(id);
        if (!live)
            return false;
        liveRuns.delete(id);
        live.controller.abort(reason);
        for (const controller of live.agents.values())
            controller.abort(reason);
        void live.worker?.terminate().catch(() => { });
        return true;
    }
    return { live: liveRuns, launch, halt };
}

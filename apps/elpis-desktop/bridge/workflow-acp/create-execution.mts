import type { AcpControl, ModelRoute } from "./types.mts";
import type { createRunOutputs } from "./create-run-outputs.mts";
import type { createRunStorage } from "./create-run-storage.mts";
import type { createNodeRouting } from "./create-node-routing.mts";
import type { createRunProgress } from "./create-run-progress.mts";
import type { createSupervision } from "./create-supervision.mts";
import type { createReplanning } from "./create-replanning.mts";
import type { createReview } from "./create-review.mts";
import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../validate.mts";
import { workflowWorktrees } from "../workflow-worktrees.mts";
import type { StoredTask, WorkflowRecord, Root, WorkflowOptions } from "./types.mts";
import { ended, settled } from "./status.mts";
import { projectFolder } from "./validation.mts";

export function createExecution({
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
}: {
  handed: ReturnType<typeof createRunOutputs>["handed"];
  save: ReturnType<typeof createRunStorage>["save"];
  runNode: ReturnType<typeof createNodeRouting>["runNode"];
  timeoutMs: WorkflowOptions["timeoutMs"];
  permission: ReturnType<typeof createRunProgress>["permission"];
  progress: ReturnType<typeof createRunProgress>["progress"];
  controls: Map<string, AcpControl>;
  cancelCheckpoints: ReturnType<typeof createSupervision>["cancelCheckpoints"];
  supervise: ReturnType<typeof createSupervision>["supervise"];
  spill: ReturnType<typeof createRunOutputs>["spill"];
  queueSupervision: ReturnType<typeof createSupervision>["queueSupervision"];
  decide: ReturnType<typeof createReplanning>["decide"];
  logLine: ReturnType<typeof createRunProgress>["logLine"];
  budget: NonNullable<WorkflowOptions["budget"]>;
  finishCheckpoints: ReturnType<typeof createSupervision>["finishCheckpoints"];
  reviewAndMerge: ReturnType<typeof createReview>["reviewAndMerge"];
  freeRun: ReturnType<typeof createRunStorage>["freeRun"];
  progressTimers: Map<string, NodeJS.Timeout>;
  supervision: Map<string, Promise<unknown>>;
  routeSnapshots: Map<string, Promise<ModelRoute[]>>;
  exhaustedProviders: Map<string, Set<string>>;
  active: Map<string, AbortController>;
  stateDir: NonNullable<WorkflowOptions["stateDir"]>;
  records: Map<string, WorkflowRecord>;
  onEnd: WorkflowOptions["onEnd"];
}) {
  async function execute(record: WorkflowRecord, root: Root, controller: AbortController, resuming = false) {
    let isolation: Awaited<ReturnType<typeof workflowWorktrees>> | null = null;
    const inflight = new Set<Promise<void>>();
    // The whole run's time limit (Masih, 29 Oct: "set a time limit for these workflows"): past it, every agent stops and the
    // run ends as stopped, saying why. Each agent also keeps its own maxRuntimeSeconds.
    let overTime = false;
    const endsAt = record.runLimitSeconds
      ? (resuming ? Date.now() : record.startedAt) + record.runLimitSeconds * 1000
      : null;
    const deadline = endsAt
      ? setTimeout(
          () => {
            overTime = true;
            controller.abort();
          },
          Math.max(0, endsAt - Date.now()),
        )
      : null;
    // Agents are told the time left, so they finish inside the limit instead of being cut off by it (29 Oct: "agents are,
    // should be, forced to finish in that designated time").
    const minutesLeft = () => {
      const n = Math.max(1, Math.floor((endsAt! - Date.now()) / 60000));
      return `${n} minute${n === 1 ? "" : "s"}`;
    };
    const timeLeft = () =>
      endsAt
        ? `Time left for the whole run: about ${minutesLeft()}. Finish well inside it; if time is short, return your best complete result now rather than start long work.`
        : null;
    try {
      isolation = record.isolation
        ? await workflowWorktrees(
            root.cwd,
            record.id,
            resuming ? (record as Parameters<typeof workflowWorktrees>[2]) : undefined,
          )
        : null;
      if (isolation) record.worktreeBase = isolation.base;
      let previous = new Map<string, { answer: string; file?: string }>();
      for (let round = resuming ? record.round : 1; round <= (record.roundLimit ?? 1); round++) {
        record.round = round;
        const answers = new Map<string, { answer: string; file?: string }>(),
          running = new Map<string, Promise<void>>();
        record.tasks.forEach(task => {
          if (task.cancelledBy === "mother") return;
          if (resuming && round === record.round && task.status === "succeeded") {
            answers.set(task.id, handed(task));
            return;
          }
          task.status = "pending";
          task.failureReason = null;
          task.assignedThreadId = null;
          task.result = null;
        });
        // Rebuilt for each round; the Mother's additions join it as they come (decide, below).
        const byId = new Map(record.tasks.map(t => [t.id, t]));
        /** The one finished step a failed check sends back, once per check. */
        const fixable = (task: StoredTask, error: unknown) =>
          task.kind === "verify" &&
          !task.fixed &&
          /^Check failed:/.test((error as { message?: string } | null)?.message ?? "") &&
          task.dependsOn.map(id => byId.get(id)).find(step => step?.kind !== "verify" && step!.status === "succeeded");
        const run = async (task: StoredTask) => {
          try {
            if (controller.signal.aborted) throw new BridgeError("Workflow cancelled", 409);
            task.status = "running";
            await save(record);
            const cwd = isolation ? await isolation.prepare(task, round) : root.cwd;
            task.cwd = cwd;
            if (isolation)
              task.worktree = isolation.paths().find(place => place.taskId === task.id && place.round === round);
            // An isolated task runs in its own worktree, where the agent folders are new again.
            for (const scope of task.writeScopes) await projectFolder(cwd, scope);
            const scopes = task.writeScopes;
            // A check looks for the files its criteria name where the checked agents could write (27 Oct: a correct file in
            // the agent's own folder failed a check that looked only at the workspace root).
            const checked =
              task.kind === "verify" ? [...new Set(task.dependsOn.flatMap(id => byId.get(id)?.writeScopes ?? []))] : [];
            const instructions = [
              `Acceptance criteria:\n${task.acceptanceCriteria.map(c => `- ${c}`).join("\n")}`,
              scopes.length ? `Write only in: ${scopes.join(", ")}.` : "Read only. Do not change files.",
              ...(endsAt ? [timeLeft()] : []),
              ...(checked.length
                ? [
                    `The agents you check could write only in: ${checked.join(", ")}. Look for a file the criteria name there as well as at the path given.`,
                  ]
                : []),
              task.kind === "verify"
                ? 'Return only JSON: {"passed": true or false, "summary": "criteria and observed evidence"}. Set passed false if any criterion fails or cannot be checked.'
                : "Return your final answer with observed evidence.",
            ].join("\n\n");
            // A dependency the Mother cancelled has no answer; the agent goes on without it.
            const inputs = [
              ...task.dependsOn
                .filter(id => answers.has(id))
                .map(id => ({ name: byId.get(id)!.title, ...answers.get(id)! })),
              ...(round > 1
                ? (task.feedbackFrom ?? [])
                    .filter(id => previous.has(id))
                    .map(id => ({ name: `${byId.get(id)!.title} · round ${round - 1}`, ...previous.get(id)! }))
                : []),
            ];
            // A model he set on the agent wins; else the run's default for children (workflow-models.mts), else the chat's.
            const requested = record.recovery?.model
              ? { model: record.recovery.model, provider: record.recovery.provider ?? root.modelProvider ?? "" }
              : task.model
                ? { model: task.model, provider: task.provider ?? root.modelProvider ?? "" }
                : record.defaults?.child
                  ? { ...record.defaults.child }
                  : { model: root.model ?? "", provider: root.modelProvider ?? "" };
            const attempt = async () => {
              if (task.kind === "join") {
                const inside = (rel: string) => {
                  const full = path.resolve(cwd, rel);
                  if (full !== cwd && !full.startsWith(`${cwd}${path.sep}`))
                    throw new BridgeError(`${rel} is outside the project`, 409);
                  return full;
                };
                const texts = await Promise.all(
                  task.parts!.map(async part => (await fs.readFile(inside(part), "utf8")).trim()),
                );
                const out = inside(task.output!);
                await fs.mkdir(path.dirname(out), { recursive: true });
                await fs.writeFile(
                  out,
                  `${texts.reduce((all, part) => (!all ? part : `${all}${task.flow && !/[.!?:;"”’)\]]$/.test(all) ? " " : "\n\n"}${part}`), "")}\n`,
                );
                return { result: { answer: `Joined ${task.parts!.length} parts into ${task.output}.` }, changes: {} };
              }
              const result = await runNode(
                record,
                task,
                requested,
                instructions,
                {
                  task:
                    (record.roundLimit ? `Round ${round} of ${record.roundLimit}.\n` : "") +
                    task.instruction +
                    (task.supervisorInstruction
                      ? `\n\nMother agent's corrective guidance:\n${task.supervisorInstruction}`
                      : ""),
                  inputs,
                },
                {
                  cwd,
                  signal: controller.signal,
                  timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
                  onPermission: request => permission(record, task, request),
                  onUpdate: update => progress(record, task, update),
                  onControl: control => {
                    controls.set(`${record.id}:${task.id}`, control);
                  },
                },
              );
              cancelCheckpoints(record, task, "The child turn ended before guidance could be delivered.");
              controls.delete(`${record.id}:${task.id}`);
              if (task.kind === "verify") {
                let verdict;
                try {
                  verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
                } catch {
                  /* invalid check cannot pass */
                }
                if (verdict?.passed !== true || typeof verdict.summary !== "string" || !verdict.summary.trim())
                  throw new BridgeError(
                    `Check failed: ${verdict?.summary || "the agent did not return a passing check with evidence"}`,
                    409,
                  );
              }
              const changes = isolation ? await isolation.complete(task, round) : {};
              return { result, changes };
            };
            let completed;
            try {
              completed = await attempt();
            } catch (error) {
              task.failureReason = (error as Error).message;
              // A failed check goes back to its step first (below); Mother is asked only once that fix is spent.
              if (fixable(task, error)) throw error;
              if (!(await supervise(record, task, error, root, controller))) {
                // When the Mother cannot decide, a file saved outside the agent's folders still gets one plain correction
                // (1 Nov live run: Haiku saved answer-1.md at the project root, she gave up, and the whole Voting run failed).
                const misplaced = /changed files outside its write scopes: (.+?)\. Kept at /.exec(
                  (error as Error).message,
                )?.[1];
                if (!misplaced || task.scopeFixed || controller.signal.aborted) throw error;
                task.scopeFixed = true;
                task.supervisorInstruction = `You saved ${misplaced} outside your allowed folders (${task.writeScopes.join(", ")}). Move ${misplaced.includes(",") ? "them" : "it"} into ${task.writeScopes[0]} with the same name, leave nothing outside your allowed folders, and change nothing else.`;
              }
              completed = await attempt();
            }
            const { result, changes } = completed;
            const passed = await spill(record, task, round, result.answer);
            answers.set(task.id, passed);
            task.result = { summary: result.answer, ...(passed.file ? { file: passed.file } : {}), ...changes };
            task.status = "succeeded";
            task.failureReason = null;
            if (!["verify", "join"].includes(task.kind)) afterSuccess(task);
          } catch (error) {
            const step = !controller.signal.aborted && fixable(task, error);
            if (step) {
              // 28 Oct: a check found a dropped clause and the run stopped, since Mother may only retry the failed node, the
              // check itself. Its step runs once more with the findings, then the check runs again; a second failure stops.
              task.fixed = true;
              task.status = "pending";
              task.failureReason = null;
              step.status = "pending";
              step.supervisorInstruction = `Your check found a problem: ${(error as Error).message.replace(/^Check failed: /, "")}\nFix exactly that in your files and change nothing else.`;
            } else {
              task.status = controller.signal.aborted ? "cancelled" : "failed";
              task.failureReason = (error as Error).message;
            }
          }
          cancelCheckpoints(record, task, "The child finished before guidance could be delivered.");
          controls.delete(`${record.id}:${task.id}`);
          await save(record);
        };
        // The Mother re-plans when a child succeeds (1 Nov, Masih approved "1) yes"): one call at a time, and children that
        // finish meanwhile reach her together in the next. Plain code first: with nothing left to run she is not asked.
        const replan: { waiting: string[]; pending: Promise<void> | null } = { waiting: [], pending: null };
        const afterSuccess = (task: StoredTask) => {
          if (!record.replan || controller.signal.aborted) return;
          replan.waiting.push(task.id);
          const kick = () => {
            if (replan.pending || !replan.waiting.length) return;
            replan.pending = queueSupervision(record, async () => {
              while (replan.waiting.length && !controller.signal.aborted)
                await decide(record, replan.waiting.splice(0), root, controller, byId);
            })
              .catch(error => logLine(record, `Mother agent could not re-plan: ${(error as Error).message}`))
              .finally(() => {
                replan.pending = null;
                kick();
              });
          };
          kick();
        };
        while (record.tasks.some(t => !ended.has(t.status)) || replan.pending) {
          for (const task of record.tasks.filter(t => t.status === "pending")) {
            if (controller.signal.aborted) {
              task.status = "cancelled";
              continue;
            }
            if (
              task.dependsOn.some(
                id => ["failed", "blocked", "cancelled"].includes(byId.get(id)!.status) && !settled(byId.get(id)!),
              )
            ) {
              task.status = "blocked";
              continue;
            }
            if (
              running.size >= (record.maxConcurrency ?? Infinity) ||
              !task.dependsOn.every(id => settled(byId.get(id)!))
            )
              continue;
            if (
              !isolation &&
              record.tasks.some(
                other =>
                  running.has(other.id) &&
                  task.writeScopes.some(a =>
                    other.writeScopes.some(
                      b => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
                    ),
                  ),
              )
            )
              continue;
            // One budget for every workflow in this process: a node slot and enough memory (bridge/memory-budget.mjs).
            const release = await budget
              .acquire(controller.signal, text => logLine(record, text))
              .catch(error => {
                if (controller.signal.aborted) return null;
                throw error;
              });
            if (!release) continue;
            // A check that failed during the wait sent its step back; that step finishes again first.
            if (task.status !== "pending" || !task.dependsOn.every(id => settled(byId.get(id)!))) {
              release();
              continue;
            }
            const promise = run(task).finally(() => {
              release();
              running.delete(task.id);
              inflight.delete(promise);
            });
            running.set(task.id, promise);
            inflight.add(promise);
          }
          if (running.size || replan.pending)
            await Promise.race([...running.values(), ...(replan.pending ? [replan.pending] : [])]);
        }
        await Promise.all(running.values());
        if (controller.signal.aborted || record.tasks.some(t => !settled(t))) break;
        previous = answers;
        resuming = false;
      }
      await finishCheckpoints(record, "The children finished before guidance could be delivered.");
      const status = controller.signal.aborted ? "cancelled" : record.tasks.every(settled) ? "succeeded" : "failed";
      if (status === "failed") record.error = record.tasks.find(task => task.failureReason)?.failureReason;
      if (status === "succeeded" && isolation) {
        record.review = await isolation.review(controller.signal);
        if ((record.autoMerge || record.next) && record.review.status === "ready")
          await reviewAndMerge(record, controller.signal);
        // Freed before the run shows as ended, so nothing it made outlives it.
        if (["merged", "empty"].includes(record.review.status)) {
          record.worktrees = isolation.paths();
          await freeRun(record);
        }
      }
      record.status = status;
      if (overTime) record.error = `Stopped at its ${Math.round(record.runLimitSeconds! / 60)}-minute time limit.`;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      controller.abort();
      await Promise.allSettled(inflight);
      record.status = cancelled ? "cancelled" : "failed";
      record.error = overTime
        ? `Stopped at its ${Math.round(record.runLimitSeconds! / 60)}-minute time limit.`
        : (error as Error).message;
    } finally {
      clearTimeout(deadline as ReturnType<typeof setTimeout> | undefined);
      await finishCheckpoints(record, "The workflow ended before guidance could be delivered.");
      record.tasks.forEach(task => {
        if (!ended.has(task.status)) task.status = record.status === "cancelled" ? "cancelled" : "blocked";
      });
      record.endedAt = Date.now();
      clearTimeout(progressTimers.get(record.id));
      progressTimers.delete(record.id);
      if (isolation) record.worktrees = isolation.paths();
      const completed = { ...record };
      record.status = "running";
      try {
        await save(completed);
      } catch (error) {
        completed.status = "failed";
        completed.error = `Could not save the workflow result: ${(error as Error).message}`;
      } finally {
        supervision.delete(record.id);
        routeSnapshots.delete(record.id);
        exhaustedProviders.delete(record.id);
        active.delete(record.rootThreadId);
        await fs.unlink(path.join(stateDir, `${record.rootThreadId}.lock`)).catch(() => {});
        records.set(record.id, completed);
        if (onEnd)
          void Promise.resolve()
            .then(() => onEnd(structuredClone(completed)))
            .catch(error => console.error("Workflow next stage:", (error as Error).message));
      }
    }
  }
  return { execute };
}

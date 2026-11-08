import type { MotherRuntime } from "./mother-runtime.mts";

import { randomUUID } from "node:crypto";
import { BridgeError } from "../validate.mts";
import type { StoredTask, WorkflowRecord, Root, CheckpointContext } from "./types.mts";

export function createSupervision({
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
}: MotherRuntime & {
  supervision: Map<string, Promise<unknown>>;
  checkpoints: Map<string, CheckpointContext>;
}) {
  function queueSupervision<T>(record: { id: string }, work: () => Promise<T>) {
    const pending = (supervision.get(record.id) ?? Promise.resolve()).catch(() => {}).then(work);
    supervision.set(record.id, pending);
    return pending;
  }

  function cancelCheckpoints(record: object, task: object | null, reason: string) {
    for (const [key, context] of checkpoints) {
      if (context.record !== record || (task && context.task !== task)) continue;
      context.reason = reason;
      clearTimeout(context.timer);
      context.controller.abort();
      if (!context.queued) {
        context.checkpoint.status = "expired";
        context.checkpoint.reason = reason;
        context.unlink();
        checkpoints.delete(key);
      }
    }
  }

  async function finishCheckpoints(record: { id: string }, reason: string) {
    cancelCheckpoints(record, null, reason);
    await supervision.get(record.id)?.catch(() => {});
  }

  // Mother reviews a step only when it fails (supervise, below); she no longer looks in during every run, which spent the
  // person's Claude quota on Opus for every step (28 Oct, Masih: no check-ins).
  function supervise(
    record: WorkflowRecord,
    task: StoredTask,
    error: unknown,
    root: Root,
    controller: AbortController,
  ) {
    cancelCheckpoints(record, null, "A failed node needs Mother agent’s recovery decision first.");
    return queueSupervision(record, () => superviseNode(record, task, error, root, controller));
  }

  async function superviseNode(
    record: WorkflowRecord,
    task: StoredTask,
    error: unknown,
    root: Root,
    controller: AbortController,
  ) {
    if (controller.signal.aborted || task.supervisedRound === record.round) return false;
    task.supervisedRound = record.round;
    // She runs on the model chosen for her chat (the run's root), not on a fixed Opus that spent his Claude subscription.
    const route = motherRoute(
      record,
      root.model
        ? { model: root.model, provider: root.modelProvider ?? "" }
        : { model: "claude/opus", provider: "claude" },
    );
    const mother = motherOf(record, route);
    mother.status = "running";
    await save(record);
    try {
      const instructions =
        'You are the Mother agent, the active workflow supervisor. Inspect the failed node and current evidence. Read only; do not edit files, run agents, merge, install or change permissions. Return only JSON: {"action":"retry","taskId":"the failed node","instruction":"specific corrective guidance","reason":"evidence"}, {"action":"steer","taskId":"one currently running node","message":"specific guidance","reason":"evidence"}, or {"action":"stop","reason":"actionable recovery needed"}. Retry only when specific new guidance can address the failure. Never repeat an unchanged failing tool, alter scope, or claim success without checks.';
      const result = await askMother(
        record,
        route,
        instructions,
        {
          task: `Workflow: ${record.name}. Goal: ${record.goal ?? ""}. Failed node: ${task.id}. Failure: ${(error as Error).message}.\nCurrent nodes:\n${JSON.stringify(record.tasks.map(node => ({ id: node.id, status: node.status, instruction: node.instruction, evidence: node.result ? handed(node) : undefined, failure: node.failureReason, recentProgress: node.progress?.slice(-3) }))).slice(0, 22000)}`,
        },
        {
          cwd: root.cwd,
          signal: controller.signal,
          timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
          onUpdate: update => progress(record, mother, update),
          onControl: control => controls.set(`${record.id}:mother`, control),
          onPermission: request => permission(record, mother, request),
        },
      );
      let decision;
      try {
        decision = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        throw new BridgeError(
          "Mother agent could not give a valid recovery decision. Choose a model and resume the failed nodes.",
          409,
        );
      }
      if (
        !["retry", "steer", "stop"].includes(decision?.action) ||
        typeof decision.reason !== "string" ||
        !decision.reason.trim()
      )
        throw new BridgeError(
          "Mother agent did not give an actionable recovery decision. Choose a model and resume the failed nodes.",
          409,
        );
      const entry: { at: number; taskId: string; decision: string; reasons: string; delivery?: string } = {
        at: Date.now(),
        taskId: decision.taskId ?? task.id,
        decision: decision.action,
        reasons: decision.reason.slice(0, 2000),
      };
      mother.decisions.push(entry);
      if (decision.action === "retry") {
        if (
          decision.taskId !== task.id ||
          typeof decision.instruction !== "string" ||
          !decision.instruction.trim() ||
          decision.instruction.length > 4000
        )
          throw new BridgeError("Mother agent requested an invalid retry. Completed work was preserved.", 409);
        task.supervisorInstruction = decision.instruction.trim();
        mother.status = "succeeded";
        await save(record);
        return true;
      }
      if (decision.action === "steer") {
        const target = record.tasks.find(
            node => node.id === decision.taskId && node.id !== task.id && node.status === "running",
          ),
          control = target && controls.get(`${record.id}:${target.id}`);
        if (
          !control ||
          typeof decision.message !== "string" ||
          !decision.message.trim() ||
          decision.message.length > 4000
        )
          throw new BridgeError(
            "Mother agent could not reach that running node. Resume the failed work after choosing a model.",
            409,
          );
        const delivered = await control.steer(decision.message.trim());
        entry.delivery = delivered.delivery;
        (target.messages ??= []).push({
          id: randomUUID(),
          text: decision.message.trim(),
          status: "delivered",
          delivery: delivered.delivery,
          at: Date.now(),
          round: record.round,
          source: "mother",
        });
      }
      mother.status = "succeeded";
      await save(record);
      return false;
    } catch (failure) {
      mother.status = controller.signal.aborted ? "cancelled" : "failed";
      mother.failureReason = (failure as Error).message;
      mother.decisions.push({ at: Date.now(), taskId: task.id, decision: "stop", reasons: (failure as Error).message });
      await save(record);
      return false;
    } finally {
      controls.delete(`${record.id}:mother`);
    }
  }
  return { cancelCheckpoints, supervise, queueSupervision, finishCheckpoints };
}

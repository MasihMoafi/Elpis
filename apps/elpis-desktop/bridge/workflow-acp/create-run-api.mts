import type { AcpControl, ModelRoute } from "./types.mts";
import type { createRunStorage } from "./create-run-storage.mts";
import type { createExecution } from "./create-execution.mts";
import type { createReview } from "./create-review.mts";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, text } from "../validate.mts";
import { agentParentId } from "../../lib/agent-runs.mts";
import type { SteerMessage, WorkflowRecord, WorkflowParams, StartedRun, Root, WorkflowOptions } from "./types.mts";
import { acquireLock } from "./locks.mts";
import { projectFolder, validateWorkflow } from "./validation.mts";

export function createRunApi({
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
}: {
  active: Map<string, AbortController>;
  mergingSources: Set<string>;
  load: ReturnType<typeof createRunStorage>["load"];
  records: Map<string, WorkflowRecord>;
  mergeControllers: Map<string, AbortController>;
  stateDir: NonNullable<WorkflowOptions["stateDir"]>;
  modelDefaults: WorkflowOptions["modelDefaults"];
  save: ReturnType<typeof createRunStorage>["save"];
  execute: ReturnType<typeof createExecution>["execute"];
  gone: ReturnType<typeof createRunStorage>["gone"];
  observeThread: WorkflowOptions["observeThread"];
  listThreadDescendants: WorkflowOptions["listThreadDescendants"];
  routeSnapshots: Map<string, Promise<ModelRoute[]>>;
  exhaustedProviders: Map<string, Set<string>>;
  freeRun: ReturnType<typeof createRunStorage>["freeRun"];
  reviewAndMerge: ReturnType<typeof createReview>["reviewAndMerge"];
  controls: Map<string, AcpControl>;
}) {
  return {
    busy: () => active.size > 0 || mergingSources.size > 0,
    async list(rootThreadId?: string) {
      await load();
      return structuredClone(
        [...records.values()].filter(r => rootThreadId === undefined || r.rootThreadId === rootThreadId),
      );
    },
    async start(params: WorkflowParams, root: Root): Promise<StartedRun> {
      validateWorkflow(params.tasks, params.roundLimit);
      await load();
      if (mergeControllers.has(params.rootThreadId))
        throw new BridgeError("Mother agent is reviewing this workflow", 409);
      if (!path.isAbsolute(root.cwd ?? "")) throw new BridgeError("Choose a project folder before running a workflow");
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      for (const task of params.tasks) for (const scope of task.writeScopes) await projectFolder(root.cwd, scope);
      const lock = path.join(stateDir, `${params.rootThreadId}.lock`);
      if (!(await acquireLock(lock))) return this.start(params, root);
      // The run's default models, read once from the real catalogues (workflow-models.mts workflowDefaults).
      const defaults = modelDefaults
        ? await Promise.resolve()
            .then(modelDefaults)
            .catch(() => null)
        : null;
      const record: WorkflowRecord = {
        ...structuredClone(params),
        ...(defaults ? { defaults } : {}),
        projectCwd: root.cwd,
        id: randomUUID(),
        ownerPid: process.pid,
        status: "running",
        startedAt: Date.now(),
        round: 1,
        tasks: params.tasks.map(task => ({
          ...structuredClone(task),
          status: "pending",
          assignedThreadId: null,
          result: null,
          failureReason: null,
        })),
      };
      const controller = new AbortController();
      active.set(params.rootThreadId, controller);
      records.set(record.id, record);
      try {
        await save(record);
      } catch (error) {
        record.status = "failed";
        record.error = (error as Error).message;
        active.delete(params.rootThreadId);
        await fs.unlink(lock);
        throw error;
      }
      void execute(record, root, controller).catch(error =>
        console.error("Could not save ACP workflow state:", (error as Error).message),
      );
      return { graphId: record.id, threadId: params.rootThreadId, turnId: record.id };
    },
    async resume(id: string, root: Root, overrides: { model?: string; provider?: string } = {}): Promise<StartedRun> {
      await load();
      const record = records.get(id);
      if (!record) throw new BridgeError("Workflow not found", 404);
      if (!["failed", "blocked", "cancelled"].includes(record.status))
        throw new BridgeError("Only failed or stopped workflow nodes need recovery", 409);
      if (active.has(record.rootThreadId) || mergeControllers.has(record.rootThreadId))
        throw new BridgeError("This workflow is already running", 409);
      if (record.cleanup) throw new BridgeError(gone, 409);
      if (observeThread) {
        const memberIds = new Set(
          [
            record.mother?.assignedThreadId,
            record.mother?.sessionId,
            record.next?.threadId,
            ...[...record.tasks, ...(record.next?.tasks ?? [])].map(task => task.assignedThreadId),
          ].filter((id): id is string => Boolean(id && id !== record.rootThreadId)),
        );
        if (listThreadDescendants) {
          try {
            const listed = [],
              cursors = new Set();
            let cursor;
            do {
              const page = await listThreadDescendants({
                ancestorThreadId: record.rootThreadId,
                limit: 100,
                ...(cursor ? { cursor } : {}),
              });
              if (!Array.isArray(page?.data)) throw new Error("Invalid live team list");
              listed.push(...page.data);
              cursor = page.nextCursor;
              if (cursor && cursors.has(cursor)) throw new Error("Repeated live team page");
              if (cursor) cursors.add(cursor);
            } while (cursor);
            for (let changed = true; changed;) {
              changed = false;
              for (const thread of listed)
                if (!memberIds.has(thread.id) && memberIds.has(agentParentId(thread) as string)) {
                  memberIds.add(thread.id);
                  changed = true;
                }
            }
          } catch {
            throw new BridgeError(
              "Could not check the workflow’s current agents. Refresh live progress or open their chats before retrying recovery.",
              409,
            );
          }
        }
        const ids = [...new Set([record.rootThreadId, ...memberIds])];
        for (let offset = 0; offset < ids.length; offset += 3) {
          let observed;
          try {
            observed = await Promise.all(ids.slice(offset, offset + 3).map(id => observeThread(id)));
          } catch {
            throw new BridgeError(
              "Could not check the workflow’s current agents. Refresh live progress or open their chats before retrying recovery.",
              409,
            );
          }
          if (observed.some(thread => ["active", "running", "inProgress"].includes(thread?.status?.type as string))) {
            throw new BridgeError(
              "A workflow agent is already working. Open its chat to follow or steer it; recovery has not started another copy.",
              409,
            );
          }
        }
      }
      if (record.tasks.some(task => task.status === "succeeded" && typeof task.result?.summary !== "string"))
        throw new BridgeError(
          "Completed workflow evidence is incomplete. Saved work was preserved; inspect the run before recovery.",
          409,
        );
      if ((record.round ?? 1) > 1)
        throw new BridgeError(
          "This multi-round run lacks retained earlier-round evidence for recovery. Start a new workflow using its saved results; existing work was preserved.",
          409,
        );
      if (overrides.model)
        record.recovery = {
          model: overrides.model,
          ...(overrides.provider ? { provider: overrides.provider } : {}),
          at: Date.now(),
        };
      if (record.tasks.every(task => task.status === "succeeded") && record.review?.status === "ready") {
        await this.merge(id);
        return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id };
      }
      if (!path.isAbsolute(root.cwd ?? "")) throw new BridgeError("Choose the workflow project before recovery");
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      const originalCwd =
        record.projectCwd ?? (!record.isolation ? record.tasks.find(task => task.cwd)?.cwd : undefined);
      if (originalCwd && root.cwd !== originalCwd)
        throw new BridgeError(
          "Recover this workflow in its original project. Its work and results have been preserved.",
          409,
        );
      record.projectCwd ??= root.cwd;
      const lock = path.join(stateDir, `${record.rootThreadId}.lock`);
      if (!(await acquireLock(lock))) return this.resume(id, root, overrides);
      record.status = "running";
      record.ownerPid = process.pid;
      record.resumedAt = Date.now();
      delete record.endedAt;
      delete record.error;
      if (overrides.model)
        record.recovery = {
          model: overrides.model,
          ...(overrides.provider ? { provider: overrides.provider } : {}),
          at: Date.now(),
        };
      for (const task of record.tasks) if (task.status !== "succeeded") delete task.supervisedRound;
      routeSnapshots.delete(id);
      exhaustedProviders.delete(id);
      const controller = new AbortController();
      active.set(record.rootThreadId, controller);
      try {
        await save(record);
      } catch (error) {
        active.delete(record.rootThreadId);
        record.status = "failed";
        await fs.unlink(lock);
        throw error;
      }
      void execute(record, root, controller, true).catch(error =>
        console.error("Could not save recovered workflow state:", (error as Error).message),
      );
      return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id };
    },
    /** Frees a run removed from History, whatever its status, and retries any earlier removal that failed. Never throws. */
    async free(id: string) {
      await load();
      const busy = (record: WorkflowRecord) =>
        active.has(record.rootThreadId) || mergeControllers.has(record.rootThreadId);
      for (const record of records.values()) {
        if ((record.id !== id && record.cleanup?.status !== "failed") || busy(record)) continue;
        await freeRun(record);
        await save(record).catch(error => {
          record.persistenceError = (error as Error).message;
        });
      }
      return records.get(id)?.cleanup ?? null;
    },
    cancel(rootThreadId: string) {
      const controller = active.get(rootThreadId) ?? mergeControllers.get(rootThreadId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    async merge(id: string) {
      await load();
      const record = records.get(id);
      if (!record) throw new BridgeError("Workflow not found", 404);
      const retryMother =
        record.status === "failed" &&
        record.mother?.status === "failed" &&
        record.review?.status === "ready" &&
        record.tasks.every(task => task.status === "succeeded");
      if (record.status !== "succeeded" && !retryMother)
        throw new BridgeError("Only a successful workflow can be merged", 409);
      if (record.review?.status === "merged") {
        if (record.review.error) {
          delete record.review.error;
          await save(record);
        }
        return { review: structuredClone(record.review) };
      }
      if (record.review?.status !== "ready") throw new BridgeError("This workflow has no changes ready to merge", 409);
      if (record.cleanup) throw new BridgeError(gone.replace("resume", "merge"), 409);
      const source = record.review.source;
      if (mergingSources.has(source))
        throw new BridgeError("A workflow merge is already running for this project", 409);
      mergingSources.add(source);
      const controller = new AbortController();
      mergeControllers.set(record.rootThreadId, controller);
      try {
        await reviewAndMerge(record, controller.signal);
        record.status = "succeeded";
        delete record.error;
        await freeRun(record);
        await save(record);
        return { review: structuredClone(record.review) };
      } catch (error) {
        record.review.error = (error as Error).message;
        await save(record);
        throw error;
      } finally {
        mergingSources.delete(source);
        mergeControllers.delete(record.rootThreadId);
      }
    },
    async noteManualSteer(threadId: string) {
      for (const record of records.values()) {
        if (record.status !== "running") continue;
        const tasks = record.tasks.filter(
          task => task.status === "running" && [task.assignedThreadId, task.sessionId].includes(threadId),
        );
        if (!tasks.length) continue;
        for (const task of tasks) task.manualRevision = (task.manualRevision ?? 0) + 1;
        await save(record);
      }
    },
    async steer(id: string, taskId: string, input: { id?: unknown; text?: unknown }) {
      await load();
      const record = records.get(id);
      if (!record) throw new BridgeError("Workflow not found", 404);
      const task = taskId === "mother" ? record.mother : record.tasks.find(task => task.id === taskId);
      if (!task) throw new BridgeError("Workflow node not found", 404);
      const message: SteerMessage = {
        id: input.id === undefined ? randomUUID() : text(input.id, "message ID", 100),
        text: text(input.text, "message", 16000),
        status: "pending",
        at: Date.now(),
        round: record.round,
      };
      const previous = task.messages?.find(entry => entry.id === message.id);
      if (previous) {
        if (previous.text !== message.text) throw new BridgeError("Message ID already used", 409);
        return { message: structuredClone(previous) };
      }
      const control = controls.get(`${record.id}:${task.id}`);
      if (
        (record.status !== "running" && record.review?.status !== "reviewing") ||
        task.status !== "running" ||
        !control
      )
        throw new BridgeError("This workflow node is not running or is still starting", 409);
      if ((task.messages?.length ?? 0) >= 100) throw new BridgeError("This node has reached its message limit", 409);
      task.manualRevision = (task.manualRevision ?? 0) + 1;
      (task.messages ??= []).push(message);
      await save(record);
      void control
        .steer(message.text)
        .then(
          result => {
            message.status = "delivered";
            message.delivery = result.delivery;
          },
          error => {
            message.status = "failed";
            message.error = (error as Error).message;
          },
        )
        .then(() => save(records.get(id)!))
        .catch(error => {
          record.persistenceError = (error as Error).message;
        });
      return { message: structuredClone(message) };
    },
    /** Records how a run's next stage goes (`next`: its chat, run, status, whether its report was delivered). */
    async note(id: string, patch: Record<string, unknown>) {
      await load();
      const record = records.get(id);
      if (!record?.next) return;
      record.next = { ...record.next, ...patch };
      await save(record);
    },
    close() {
      for (const controller of [...active.values(), ...mergeControllers.values()]) controller.abort();
    },
  };
}

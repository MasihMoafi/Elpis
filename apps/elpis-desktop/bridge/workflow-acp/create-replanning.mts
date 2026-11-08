import type { MotherRuntime } from "./mother-runtime.mts";

import type { createRunProgress } from "./create-run-progress.mts";

import { randomUUID } from "node:crypto";
import { BridgeError } from "../validate.mts";
import { checkPlan } from "../canvas-plan.mts";
import type { StoredTask, WorkflowRecord, Root } from "./types.mts";
import { ended } from "./status.mts";
import { slug } from "./format.mts";
import { validateWorkflow } from "./validation.mts";
import { REPLAN_LIMIT, ADD_LIMIT } from "./limits.mts";

export function createReplanning({
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
}: MotherRuntime & {
  logLine: ReturnType<typeof createRunProgress>["logLine"];
}) {
  /** The Mother's re-plan after children succeeded (`finished`: their ids). She answers with one decision: continue, add
   * agents, cancel pending ones or steer a running one. Her answer passes the planner's checks (canvas-plan.mts) and the
   * graph's (validateWorkflow) before it changes anything; an invalid one is ignored and logged. */
  async function decide(
    record: WorkflowRecord,
    finished: string[],
    root: Root,
    controller: AbortController,
    byId: Map<string, StoredTask>,
  ) {
    if (!record.tasks.some(task => !ended.has(task.status))) return; // nothing left to run: plain code finishes the run
    const route = motherRoute(
      record,
      root.model
        ? { model: root.model, provider: root.modelProvider ?? "" }
        : { model: "claude/opus", provider: "claude" },
    );
    const mother = motherOf(record, route);
    if ((mother.replans ?? 0) >= REPLAN_LIMIT) {
      if (!mother.replanLimitNoted) {
        mother.replanLimitNoted = true;
        logLine(record, `Mother agent reached her ${REPLAN_LIMIT} re-plans for this run; the plan stays as it is.`);
      }
      return;
    }
    mother.replans = (mother.replans ?? 0) + 1;
    mother.status = "running";
    await save(record);
    const title = (id: string) => byId.get(id)?.title ?? id;
    const note = (decision: string, line: string, extra = {}) => {
      mother.decisions.push({ at: Date.now(), kind: "replan", decision, summary: line.slice(0, 300), ...extra });
      logLine(record, `Mother agent · ${line}`.slice(0, 400));
    };
    try {
      const done = record.tasks
        .filter(task => task.status === "succeeded")
        .map(task => ({
          id: task.id,
          title: task.title,
          kind: task.kind,
          justFinished: finished.includes(task.id),
          ...handed(task),
        }));
      const left = record.tasks
        .filter(task => task.status !== "succeeded")
        .map(task => ({
          id: task.id,
          title: task.title,
          kind: task.kind,
          status: task.status,
          dependsOn: task.dependsOn,
          folders: task.writeScopes,
          instruction: task.instruction.slice(0, 600),
        }));
      const folders = [...new Set(record.tasks.flatMap(task => task.writeScopes))];
      const instructions = `You are the Mother agent, the workflow coordinator. A child agent has just finished. Decide whether the remaining plan still reaches the goal. Read only: you may read the files listed; do not edit files, run agents, merge or install. Return only JSON, one of:
{"decision":"continue","why":"one short line"}
{"decision":"add","why":"one short line","agents":[{"key":"short-lowercase-key","title":"plain name","prompt":"what to do and where","folders":[],"doneWhen":["a check anyone can verify"],"waitsFor":["ids it builds on"]}]} (1 to ${ADD_LIMIT} agents; folders copied from the project folder list, or empty; each also gets its own folder)
{"decision":"cancel","why":"one short line","taskIds":["ids of pending agents"]}
{"decision":"steer","why":"one short line","taskId":"one running agent","message":"specific guidance"}
Prefer continue. Add only for a part the plan misses; cancel only work that is no longer needed; steer only with specific new guidance.`;
      const result = await askMother(
        record,
        route,
        instructions,
        {
          task: `Workflow: ${record.name}. Goal: ${record.goal ?? ""}.\nJust finished: ${finished.map(title).join(", ")}.\nFinished agents (summary and the file with the whole answer):\n${JSON.stringify(done).slice(0, 14000)}\nRemaining plan:\n${JSON.stringify(left).slice(0, 8000)}\nProject folders: ${JSON.stringify(folders)}`,
        },
        {
          cwd: root.cwd,
          signal: controller.signal,
          timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
          onUpdate: update => progress(record, mother, update),
          onControl: control => controls.set(`${record.id}:mother`, control),
          onPermission: request => permission(record, mother, request),
        },
      ).finally(() => controls.delete(`${record.id}:mother`));
      let answer;
      try {
        answer = JSON.parse(result.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch {
        throw new BridgeError("her answer was not JSON");
      }
      const why = typeof answer?.why === "string" ? answer.why.trim().slice(0, 300) : "";
      if (!why) throw new BridgeError("her answer gave no reason");
      if (answer.decision === "continue") note("continue", `Continued — ${why}`);
      else if (answer.decision === "add") {
        if (!Array.isArray(answer.agents) || !answer.agents.length || answer.agents.length > ADD_LIMIT)
          throw new BridgeError(`add needs 1 to ${ADD_LIMIT} agents`);
        // The run as a plan, with her agents added: the planner's own check of keys, folders, wiring and loops.
        const board = record.tasks.map(task => ({
          key: task.id,
          title: task.title,
          prompt: "",
          folders: task.writeScopes,
          doneWhen: [],
          waitsFor: task.dependsOn,
        }));
        let plan;
        try {
          plan = checkPlan(
            JSON.stringify({
              name: record.name,
              mode: "team",
              why,
              agents: [...board.map(agent => ({ ...agent, title: "" })), ...answer.agents],
            }),
            { folders, agents: board, maxAgents: board.length + ADD_LIMIT },
          );
        } catch (error) {
          throw new BridgeError((error as Error).message.replace(/^Elpis returned a plan that cannot be used: /, ""));
        }
        const known = new Set(record.tasks.map(task => task.id)),
          taken = new Set(record.tasks.flatMap(task => task.writeScopes));
        const fresh = plan.agents.filter(agent => !known.has(agent.key)),
          checks = new Set([...known, ...fresh.map(agent => `${agent.key}-check`)]);
        const added = fresh.flatMap(agent => {
          let own = `agents/${slug(agent.title) || agent.key}`;
          for (let n = 2; taken.has(own); n++) own = `agents/${slug(agent.title) || agent.key}-${n}`;
          taken.add(own);
          const criteria = agent.doneWhen.length
            ? agent.doneWhen
            : ["Its result is saved in its folder, with evidence"];
          const base = {
            status: "pending",
            assignedThreadId: null,
            result: null,
            failureReason: null,
            addedBy: "mother",
          };
          return [
            {
              ...base,
              id: agent.key,
              kind: "implement",
              title: agent.title,
              instruction: [
                record.goal && `Goal of the whole run: ${record.goal}`,
                agent.prompt,
                `Save your result as files inside your allowed folders. Write your report to ${own}/report.md. Include the answer and file paths in your final answer so the next agent can use them.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              dependsOn: agent.waitsFor.flatMap(id =>
                checks.has(`${id}-check`) && !agent.waitsFor.includes(`${id}-check`) ? [id, `${id}-check`] : [id],
              ),
              writeScopes: [...agent.folders.filter(folder => folder !== own), own],
              acceptanceCriteria: criteria,
            },
            {
              ...base,
              id: `${agent.key}-check`,
              kind: "verify",
              title: `Check: ${agent.title}`.slice(0, 256),
              instruction: `Check the work of “${agent.title}”. Its prompt was:\n${agent.prompt}\n\nRead what it wrote and say plainly whether each of these holds: ${criteria.join("; ")}\n\nChange nothing of its work. Write your report to ${own}/check/report.md.`,
              dependsOn: [agent.key],
              writeScopes: [`${own}/check`],
              acceptanceCriteria: [`Each of “${agent.title}”'s criteria is shown to hold or not, with evidence`],
            },
          ];
        });
        if (!added.length) throw new BridgeError("add named no new agent");
        try {
          validateWorkflow([...record.tasks, ...added], record.roundLimit);
        } catch (error) {
          throw new BridgeError((error as Error).message);
        }
        record.tasks.push(...added);
        for (const task of added) byId.set(task.id, task);
        note("add", `Added: ${fresh.map(agent => agent.title).join(", ")} — ${why}`, {
          taskIds: fresh.map(agent => agent.key),
        });
      } else if (answer.decision === "cancel") {
        const ids = Array.isArray(answer.taskIds) ? [...new Set<string>(answer.taskIds)] : [];
        const targets = ids.map(id => byId.get(id)!);
        if (!ids.length || targets.some(task => task?.status !== "pending"))
          throw new BridgeError("cancel names only pending agents");
        // An agent's own check goes with it.
        const cancelled = [
          ...targets,
          ...record.tasks.filter(
            task =>
              task.kind === "verify" &&
              task.status === "pending" &&
              task.dependsOn.length &&
              task.dependsOn.every(id => ids.includes(id)),
          ),
        ];
        for (const task of new Set(cancelled))
          Object.assign(task, {
            status: "cancelled",
            cancelledBy: "mother",
            failureReason: `Cancelled by Mother agent: ${why}`,
          });
        note("cancel", `Cancelled: ${targets.map(task => task.title).join(", ")} — ${why}`, { taskIds: ids });
      } else if (answer.decision === "steer") {
        const target = byId.get(answer.taskId),
          control = target?.status === "running" && controls.get(`${record.id}:${target.id}`);
        const message = typeof answer.message === "string" ? answer.message.trim() : "";
        if (!control || !message || message.length > 4000)
          throw new BridgeError("steer needs a running agent and a message");
        const delivered = await control.steer(message);
        (target.messages ??= []).push({
          id: randomUUID(),
          text: message,
          status: "delivered",
          delivery: delivered.delivery,
          at: Date.now(),
          round: record.round,
          source: "mother",
        });
        note("steer", `Steered: ${target.title} — ${why}`, { taskId: target.id, delivery: delivered.delivery });
      } else throw new BridgeError("her answer was not one of continue, add, cancel or steer");
      mother.status = "succeeded";
    } catch (error) {
      if (controller.signal.aborted) {
        mother.status = "cancelled";
        return;
      }
      mother.status = "succeeded";
      note("invalid", `Ignored her answer — ${(error as Error).message}`.slice(0, 300));
    } finally {
      await save(record);
    }
  }
  return { decide };
}

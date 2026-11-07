import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { executionGraph } from "@/lib/canvas";
import { api, type Thread } from "@/lib/api";
import { runPayload, wantsIsolation } from "@/lib/canvas-isolation";
import { type ReadyMade, runParts, type CanvasGraph, type CanvasNode, type CatalogModel, type MotherSettings, type RunTask, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { type LogLine } from "@/lib/run-log";
import type * as React from "react";
import { Run, Props } from "./types";
import { over, OFFLINE_WORKFLOW, runFailure } from "./run-state";
import { DRAWN, RUN_MINUTES, MOTHER_FIRST } from "./constants";
import { useProjectFolders } from "./folders";

export function canvasRun({ allowed, mother, graph, cwd, readyMade, requestText, recordedRun, runtimeAttempt, startingRun, planning, run, setNotice, setStarting, project, letElpis, agents, setUndoLoad, setStates, setClashes, setLog, said, decisionsSeen, reports, followLog, workflowCatalog, identity, models, catalog, setIdentity, setRun, startedThread, onRunStarted }: {
  allowed: { graph: number; atOnce: number; source: string; };
  mother: MotherSettings;
  graph: CanvasGraph;
  cwd: Props["cwd"];
  readyMade: (id?: string) => ReadyMade | undefined;
  requestText: string;
  recordedRun: Props["recordedRun"];
  runtimeAttempt: () => () => boolean;
  startingRun: React.RefObject<boolean>;
  planning: string;
  run: Run | null;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  setStarting: React.Dispatch<React.SetStateAction<boolean>>;
  project: ReturnType<typeof useProjectFolders>;
  letElpis: (goal: string, scope?: CanvasGraph, newWorkflow?: boolean, forRun?: boolean) => Promise<CanvasGraph | null>;
  agents: Extract<CanvasNode, { type: "agent" }>[];
  setUndoLoad: React.Dispatch<React.SetStateAction<{ loaded: string; previous: CanvasGraph; } | null>>;
  setStates: React.Dispatch<React.SetStateAction<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined; }>>>;
  setClashes: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setLog: React.Dispatch<React.SetStateAction<LogLine[]>>;
  said: React.RefObject<Record<string, TaskStatus>>;
  decisionsSeen: React.RefObject<number>;
  reports: React.RefObject<Set<string>>;
  followLog: React.RefObject<boolean>;
  workflowCatalog: Props["workflowCatalog"];
  identity: WorkflowIdentity | undefined;
  models: Props["models"];
  catalog: CatalogModel[];
  setIdentity: (patch: Partial<Pick<CanvasGraph, "workflowId" | "name">>) => void;
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
  startedThread: React.RefObject<string | null>;
  onRunStarted: Props["onRunStarted"]
}) {
  // The Father's part: his own chat, on her model, told who he is; it starts once hers has succeeded.
  /** The Father's part as the bridge starts it after hers: his chat (her model, the goal and his role as instructions)
   * and his tasks, in worktrees when he has several writers in a git repository. */
  // oxlint-disable-next-line typescript/require-await -- Preserve the existing async validation contract.
  async function workflowLimit() {
    if (allowed.atOnce < 1) throw Error("No workflow agents are available for this session.");
    return allowed.atOnce;
  }
  async function fatherPart(tasks: RunTask[], current: () => boolean) {
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const goal = mother.brief.trim(), name = `Father agent · ${graph.name || "Workflows"}`.slice(0, 120);
    const repository = Boolean(cwd) && !readyMade(graph.planningPattern) && wantsIsolation(tasks) && await api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(cwd!)}`).then(result => result.repository === true, () => false);
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const limit = await workflowLimit(); if (!current()) throw Error(OFFLINE_WORKFLOW);
    const { rootThreadId: _root, name: _name, ...stage } = runPayload("", name, tasks, limit, repository);
    return { ...stage, name, thread: { name, instructions: [goal && `Goal of the whole run: ${goal}`, "You are the Father agent: you run the agents past the Mother agent's ten, after her part has succeeded, and you report to her."].filter(Boolean).join("\n\n"),
      ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}) } };
  }
  // Sends one part of the run. With several writing agents in a git repository, each works in its own worktree and
  // Elpis merges them into the project's branch after the run; without a repository Elpis refuses that, so it isn't asked.
  async function runPart(rootThreadId: string, name: string, tasks: RunTask[], current: () => boolean, next?: Awaited<ReturnType<typeof fatherPart>>) {
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const repository = Boolean(cwd) && !readyMade(graph.planningPattern) && wantsIsolation(tasks) && await api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(cwd!)}`).then(result => result.repository === true, () => false);
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const limit = await workflowLimit(); if (!current()) throw Error(OFFLINE_WORKFLOW);
    return api<{ graphId: string }>("/workflows/run", { ...(graph.template === "recursive" ? { roundLimit: graph.roundLimit } : {}), ...runPayload(rootThreadId, name, tasks, limit, repository), runLimitSeconds: (graph.timeLimit ?? RUN_MINUTES) * 60, replan: graph.replan !== false, ...(graph.runsOn === "cloudroom" ? { runsOn: "cloudroom" } : {}), ...(mother.model ? { motherModel: { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } } : {}), ...(mother.brief.trim() || requestText.trim() ? { goal: mother.brief.trim() || requestText.trim() } : {}), ...(next ? { next } : {}) });
  }
  async function start(targets?: string[]) {
    if (recordedRun) return;
    const current = runtimeAttempt();
    if (!current()) return;
    if (startingRun.current || planning || run && !over(run)) { setNotice("Wait for this run to finish before starting another."); return; }
    if (!cwd) { setNotice("Choose the project the agents work in, then run again."); return; }
    startingRun.current = true; setStarting(true);
    try {
      // Fill only when work in this execution scope needs it; muted and unrelated agents never start it.
      const scope = executionGraph(graph, targets);
      const empty = scope.nodes.some(node => node.type === "agent" && (!node.data.instruction.trim() || !node.data.writeScopes.length && Boolean(project.folders?.length)));
      const planned = empty ? await letElpis(mother.brief.trim() || DRAWN, targets || agents.some(node => node.data.muted) ? scope : undefined, false, true) : graph;
      if (!planned || !current()) return;
      const ready = executionGraph(planned, targets), built = runParts(ready);
      if ("error" in built) { setNotice(built.error); return; }
      setNotice(""); setUndoLoad(null); setStates({}); setClashes({}); setLog([]); said.current = {}; decisionsSeen.current = 0; reports.current.clear(); followLog.current = true;
      const runIdentity = workflowCatalog.ensure(identity?.rootThreadId ? crypto.randomUUID() : graph.workflowId || crypto.randomUUID(), ready.name);
      // Mother runs on her model only while it is offered here: a saved claude/opus with Claude signed out made Run graph
      // fail with a bare ELPIS_REQUEST_REJECTED (28 Oct). Otherwise she takes the best one offered, and the notice says so.
      const offered = [...models.map(item => ({ model: item.model, provider: null as string | null })), ...catalog];
      const offers = (model: string, provider?: string | null) => offered.some(item => item.model === model && (item.provider ?? null) === (provider ?? null));
      const named = (model: string) => catalog.find(item => item.model === model)?.label ?? models.find(item => item.model === model)?.displayName ?? model;
      let motherRoute = mother.model ? { model: mother.model, provider: mother.provider ?? null } : null;
      if (motherRoute && offered.length && !offers(motherRoute.model, motherRoute.provider)) {
        const instead = MOTHER_FIRST.map(test => offered.find(item => test.test(item.model))).find(Boolean) ?? null;
        setNotice(`Mother agent's model, ${named(motherRoute.model)}, is not available here, so she runs on ${instead ? named(instead.model) : "the default model"}.`);
        motherRoute = instead;
      }
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), agents: true, name: runIdentity.name,
        ...(motherRoute ? { model: motherRoute.model, ...(motherRoute.provider ? { provider: motherRoute.provider } : {}) } : {}), ...(mother.brief.trim() ? { instructions: mother.brief.trim() } : {}) });
      const result = await runPart(created.thread.id, runIdentity.name, built.mother, current, built.father.length ? await fatherPart(built.father, current) : undefined);
      workflowCatalog.attach(runIdentity.id, result.graphId, created.thread.id);
      setIdentity({ workflowId: result.graphId, name: runIdentity.name });
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running", startedAt: Date.now(), ...(built.father.length ? { father: { tasks: built.father, status: "pending" } } : {}) });
      startedThread.current = created.thread.id;
      onRunStarted?.(created.thread);
    } catch (error) { if (current()) setNotice(runFailure(errorText(error))); }
    finally { startingRun.current = false; setStarting(false); }
  }
  return { start };
}
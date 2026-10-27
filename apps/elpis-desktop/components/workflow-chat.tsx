"use client";

import { useEffect, useMemo, useState } from "react";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/agent-identity";
import { ModelPicker } from "@/components/model-picker";
import { MarkdownText } from "@/components/markdown-text";
import { WorkflowProgress, useWorkflowTeam, workflowThreadActive } from "@/components/workflow-progress";
import { agentParentId } from "@/lib/agent-runs.mjs";
import { WorkflowMark } from "@/components/workflow-identity";
import { api, providerChoices, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { arrange, withMother, type CanvasGraph, type CanvasNode, type TaskStatus } from "@/lib/canvas";
import type { WorkflowIdentity, WorkflowRun } from "@/lib/workflow-identity";

export type RecordedTask = {
  id: string; title?: string; status?: string; kind?: string; instruction?: string; dependsOn?: string[]; feedbackFrom?: string[];
  assignedThreadId?: string | null; model?: string; provider?: string; reasoningEffort?: string; writeScopes?: string[]; acceptanceCriteria?: string[];
  failureReason?: string | null; result?: { summary?: string } | string | null;
  routing?: { requested?: { model?: string; provider?: string }; actual?: { model?: string; provider?: string }; attempts?: { model?: string; provider?: string; status?: string; reason?: string }[] };
};
export type RecordedWorkflow = Omit<WorkflowRun, "tasks" | "mother"> & {
  tasks?: RecordedTask[]; error?: string | null; endedAt?: number;
  mother?: WorkflowRun["mother"] & { status?: string; model?: string; provider?: string; decisions?: { at?: number; taskId?: string; decision: string; reasons?: string[] | string; delivery?: string }[] };
  next?: { threadId?: string; graphId?: string; status: string; reported?: boolean; tasks?: RecordedTask[] };
};
export type WorkflowRunRef = Pick<WorkflowRun, "id" | "rootThreadId">;
const ACTIVE = new Set(["running", "pending", "inProgress"]);
export function taskState(value?: string): TaskStatus {
  if (value === "completed") return "succeeded";
  return (["pending", "running", "succeeded", "failed", "blocked", "cancelled"] as const).find(status => status === value) ?? "pending";
}
/** Both presentations read the exact retained run, never the latest run on a different root. */
export async function readWorkflowRun(ref: WorkflowRunRef): Promise<RecordedWorkflow> {
  const listed = await api<{ data: RecordedWorkflow[] }>(`/workflows?threadId=${encodeURIComponent(ref.rootThreadId)}`);
  const found = listed.data?.find(run => run.id === ref.id);
  if (!found || found.rootThreadId && found.rootThreadId !== ref.rootThreadId) throw Error("This saved workflow could not be loaded. Refresh and try again.");
  return { ...found, rootThreadId: ref.rootThreadId };
}
/** Rebuild the saved task DAG; generated verification tasks remain each agent's check. Positions are presentation only. */
export function graphForWorkflow(run: RecordedWorkflow, liveAgents: readonly Thread[] = []): CanvasGraph {
  const tasks = [...(run.tasks ?? []), ...(run.next?.tasks ?? [])], byId = new Map(tasks.map(task => [task.id, task]));
  const agents = tasks.filter(task => task.kind !== "verify");
  const ids = new Set(agents.map(task => task.id));
  const sources = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const task = byId.get(id);
    return task?.kind === "verify" ? (task.dependsOn ?? []).flatMap(parent => sources(parent, seen)) : ids.has(id) ? [id] : [];
  };
  const nodes: CanvasNode[] = agents.map((task, index) => ({ id: task.id, type: "agent", position: { x: 0, y: index * 140 }, data: {
    title: task.title || task.id, instruction: task.instruction ?? "", model: task.model ?? null, provider: task.provider ?? null,
    effort: task.reasoningEffort ?? null, writeScopes: task.writeScopes ?? [], acceptanceCriteria: task.acceptanceCriteria ?? [],
  } }));
  const edges = agents.flatMap(task => [...new Set((task.dependsOn ?? []).flatMap(id => sources(id)))].filter(id => id !== task.id)
    .map(source => ({ id: `${source}->${task.id}`, source, target: task.id })));
  const assigned = new Map(agents.flatMap(task => task.assignedThreadId ? [[task.assignedThreadId, task.id] as const] : []));
  const extra = liveAgents.filter(thread => !assigned.has(thread.id));
  for (const thread of extra) assigned.set(thread.id, `live:${thread.id}`);
  for (const thread of extra) {
    const id = assigned.get(thread.id)!;
    nodes.push({ id, type: "agent", position: { x: 0, y: nodes.length * 140 }, data: { title: thread.agentNickname || thread.name || "Agent", instruction: "", model: thread.model ?? null, provider: thread.modelProvider ?? null, writeScopes: [], acceptanceCriteria: [] } });
    const parent = assigned.get(agentParentId(thread) ?? "");
    if (parent && parent !== id) edges.push({ id: `${parent}->${id}`, source: parent, target: id });
  }
  return arrange(withMother({ name: run.name || "Workflow", workflowId: run.id, nodes, edges }));
}

export function WorkflowChat({ run, identity, ready, models = [], threads = [], onOpenChat, onOpenCanvas }: {
  run: WorkflowRun; identity?: WorkflowIdentity; ready: boolean; models?: Model[]; threads?: readonly Thread[];
  onOpenChat: (threadId: string) => void; onOpenCanvas: (run: WorkflowRun) => void;
}) {
  const [record, setRecord] = useState<RecordedWorkflow>(run), [error, setError] = useState(""), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  const [pick, setPick] = useState({ model: "", choiceId: "" });
  const team = useWorkflowTeam(record, ready, threads);
  const working = team.agents.some(workflowThreadActive) || workflowThreadActive(team.mother);
  const settings = useElpisSettings().data;
  const choices = useMemo(() => providerChoices(models, settings as ProviderSettings | null), [models, settings]);
  useEffect(() => {
    setRecord(run); setError(""); setPick({ model: "", choiceId: "" });
  }, [run.id, run.rootThreadId]); // Preserve a live record across catalog refreshes.
  useEffect(() => {
    if (!ready) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await readWorkflowRun(run);
        if (!live) return;
        setRecord(next); setError("");
        timer = setTimeout(read, ACTIVE.has(next.status) || next.next && !next.next.reported && ACTIVE.has(next.next.status) ? 1500 : 5000);
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [run.id, run.rootThreadId, run.status, ready, revision]);
  async function resume() {
    if (!ready || pending || working || team.loading || team.error) return;
    const owner = record.id;
    setPending(true); setError("");
    try {
      const provider = choices.find(choice => choice.id === pick.choiceId)?.provider;
      await api(`/workflows/${encodeURIComponent(owner)}/resume`, pick.model ? { model: pick.model, ...(provider ? { provider } : {}) } : {});
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  const tasks = record.tasks ?? [], complete = tasks.filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length;
  return <section className="context-event space-y-3" role="region" aria-label="Workflow run">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">{identity && <WorkflowMark identity={identity} neutral />}{identity?.name || record.name || "Workflow"}</h2><span role="status">{record.status} · {complete}/{tasks.length} tasks complete</span></div>
    <WorkflowProgress run={record} team={team} onOpenChat={onOpenChat} onRefresh={() => { team.refresh(); setRevision(value => value + 1); }} />
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" onClick={() => onOpenCanvas(record)}>Open workflow canvas</Button>
      {["failed", "blocked", "cancelled"].includes(record.status) && <><Button variant="outline" size="sm" disabled={!ready || pending || working || team.loading || !!team.error} title={working ? "A workflow agent is already working; open its chat to steer it." : undefined} onClick={() => void resume()}>{pending ? "Resuming…" : "Resume workflow"}</Button>
        {!!choices.length && <div role="group" aria-label="Model for retry"><ModelPicker choices={choices} models={models} model={pick.model} choiceId={pick.choiceId} disabled={!ready || pending} allowCustom={false} onChange={setPick} /></div>}</>}
    </div>
    {working && ["failed", "blocked", "cancelled"].includes(record.status) && <p role="status">An agent is working now. The failure below belongs to the saved attempt; open the live team to follow or steer the current work. Resume is unavailable while work is active.</p>}
    {!ready && <p role="status">Reconnect to refresh or resume this workflow. Its saved state remains visible.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!tasks.length && <p>No task details have been recorded for this run.</p>}
    <details open={!working}><DisclosureSummary>Saved attempt · {record.status}</DisclosureSummary>{record.error && !tasks.some(task => task.failureReason === record.error) && <p className="text-destructive">{record.error}</p>}<ol className="space-y-3 pt-3" aria-label="Saved workflow tasks">{tasks.map(task => <li key={task.id} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><AgentIdentity id={task.assignedThreadId || `${record.id}:${task.id}`} name={task.title || task.id} model={task.routing?.actual?.model} provider={task.routing?.actual?.provider} /><span>{task.status || "not recorded"}</span></div>
      {!!task.dependsOn?.length && <p className="text-xs text-muted-foreground">After: {task.dependsOn.map(id => tasks.find(item => item.id === id)?.title || id).join(", ")}</p>}
      {task.failureReason && <p className="text-destructive">{task.failureReason}</p>}
      {task.routing?.requested && (task.routing.requested.model !== task.routing.actual?.model || task.routing.requested.provider !== task.routing.actual?.provider) && <p className="text-xs text-muted-foreground">Requested: {task.routing.requested.provider || "not recorded"} / {task.routing.requested.model || "not recorded"}</p>}
      {!!task.routing?.attempts?.length && <details><DisclosureSummary>Model attempts</DisclosureSummary><ol>{task.routing.attempts.map((attempt, index) => <li key={index}>{attempt.provider} / {attempt.model} · {attempt.status}{attempt.reason ? ` · ${attempt.reason}` : ""}</li>)}</ol></details>}
      {task.result && <details><DisclosureSummary>Result</DisclosureSummary><MarkdownText text={typeof task.result === "string" ? task.result : task.result.summary || "A result was recorded without a text summary."} allowImages={false} /></details>}
      {task.assignedThreadId && <Button variant="ghost" size="sm" onClick={() => onOpenChat(task.assignedThreadId!)}>Open {task.title || task.id} chat</Button>}
    </li>)}</ol></details>
    {record.mother?.status && <p>Mother: {record.mother.status}{record.mother.model ? ` · ${record.mother.model}` : ""}</p>}
    {!!record.mother?.decisions?.length && <details><DisclosureSummary>Mother decisions</DisclosureSummary><ol>{record.mother.decisions.map((decision, index) => <li key={index}>{decision.taskId ? `${decision.taskId}: ` : ""}{decision.decision}{decision.reasons ? ` · ${Array.isArray(decision.reasons) ? decision.reasons.join("; ") : decision.reasons}` : ""}{decision.delivery ? ` · ${decision.delivery}` : ""}</li>)}</ol></details>}
  </section>;
}

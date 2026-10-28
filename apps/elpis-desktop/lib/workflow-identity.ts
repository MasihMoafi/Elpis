"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { appStorage } from "./projects";

export const WORKFLOW_COLOURS = ["blue", "teal", "violet", "rose", "green", "amber"] as const;
export type WorkflowColour = typeof WORKFLOW_COLOURS[number];
export type WorkflowIdentity = { id: string; name: string; colour: WorkflowColour; rootThreadId?: string };
export type WorkflowRun = { id: string; rootThreadId: string; name?: string; status: string; startedAt?: number; createdAt?: number; tasks?: { id: string; title?: string; kind?: string; dependsOn?: string[]; assignedThreadId?: string | null; sessionId?: string; threads?: string[]; status?: string }[]; mother?: { threads?: string[]; assignedThreadId?: string; sessionId?: string } };
type Identities = Record<string, WorkflowIdentity>;
const KEY = "elpis-workflow-identities-v1";
/** Every chat a run's steps and Mother opened, each once, in run order: they fold under the run's chat (SPEC OM1). The
 * Mother's own reviews are marked: the run's row is the Mother, so they fold into it rather than under it (28 Oct, Masih:
 * "mother should be here", at the run's row). Checks are marked too: each folds into the step it checks. */
export function workflowMembers(run: WorkflowRun) {
  const chats = (owner: { assignedThreadId?: string | null; sessionId?: string; threads?: string[] } | undefined, fallback?: boolean) =>
    [...owner?.threads ?? [], ...owner?.assignedThreadId ? [owner.assignedThreadId] : fallback && owner?.sessionId ? [owner.sessionId] : []];
  const members: { threadId: string; title: string; mother?: true; check?: true }[] = [...(run.tasks ?? []).flatMap(task => chats(task).map(threadId => ({ threadId, title: task.title || "Step", ...(task.kind === "verify" ? { check: true as const } : {}) }))),
    ...chats(run.mother, true).map(threadId => ({ threadId, title: "Mother", mother: true as const }))];
  return members.filter((member, index) => member.threadId !== run.rootThreadId && members.findIndex(other => other.threadId === member.threadId) === index);
}
/** A run row's second line, "2 of 2 done": how the run went, not who leads it (28 Oct, Masih: "mothers all over the
 * place"). The row's dot shows running or finished; the words name only a run that ended badly. A step is done once it
 * and its checks have passed. */
export function runSummary(run: WorkflowRun) {
  const tasks = run.tasks ?? [], steps = tasks.filter(task => task.kind !== "verify");
  const done = steps.filter(step => step.status === "succeeded" && tasks.every(task => task.kind !== "verify" || !task.dependsOn?.includes(step.id) || task.status === "succeeded")).length;
  const ended = { failed: "Failed", cancelled: "Cancelled" }[run.status];
  return `${ended ? `${ended} · ` : ""}${done} of ${steps.length} done`;
}
const nameKey = (name: string) => name.trim().normalize("NFKC").toLocaleLowerCase();
export function workflowNameProblem(identities: Identities, id: string, name: string): string | null {
  if (!name.trim()) return "Name the workflow.";
  if (name.trim().length > 120) return "Use 120 characters or fewer.";
  return Object.values(identities).some(item => item.id !== id && nameKey(item.name) === nameKey(name)) ? "A workflow with this name already exists." : null;
}
function allocate(identities: Identities, id: string, preferred: string, colour?: WorkflowColour): WorkflowIdentity {
  const base = preferred.trim().slice(0, 120) || "Workflow";
  let name = base;
  for (let n = 2; workflowNameProblem(identities, id, name); n++) name = `${base.slice(0, 120 - String(n).length - 1)} ${n}`;
  const entries = Object.values(identities), last = entries.at(-1)?.colour;
  const colours = WORKFLOW_COLOURS.filter(value => value !== last);
  const leastUsed = [...colours].sort((a, b) => entries.filter(item => item.colour === a).length - entries.filter(item => item.colour === b).length)[0];
  return { id, name, colour: colour ?? leastUsed };
}

/** One desktop owner for draft/run identity. Saved engine metadata supplies membership; names never mutate threads. */
export function useWorkflowCatalog(enabled: boolean) {
  const [identities, setIdentities] = useState<Identities>({}), current = useRef<Identities>({});
  const [runs, setRuns] = useState<WorkflowRun[]>([]), [hydrated, setHydrated] = useState(false), [error, setError] = useState("");
  const pending = useRef<Promise<void> | null>(null);
  const commit = useCallback((next: Identities) => {
    try { appStorage().setItem(KEY, JSON.stringify(next)); }
    catch { throw Error("Could not save workflow names and colours on this device."); }
    current.current = next; setIdentities(next); setError("");
  }, []);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(appStorage().getItem(KEY) || "{}");
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw Error("Invalid workflow identities");
      const next: Identities = {};
      for (const [id, raw] of Object.entries(saved as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>, colour = WORKFLOW_COLOURS.find(colour => colour === item.colour);
        if (typeof item.name !== "string" || !colour) continue;
        next[id] = { ...allocate(next, id, item.name, colour), ...(typeof item.rootThreadId === "string" ? { rootThreadId: item.rootThreadId } : {}) };
      }
      current.current = next; setIdentities(next);
    } catch { setError("Could not read saved workflow names and colours."); }
    setHydrated(true);
  }, []);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const task = (async () => {
      try {
        const result = await api<{ data?: WorkflowRun[] }>("/workflows/history");
        if (!Array.isArray(result.data)) return;
        const listed = result.data.filter(run => typeof run.id === "string" && typeof run.rootThreadId === "string");
        let next = current.current;
        for (const run of [...listed].sort((a, b) => (a.startedAt ?? a.createdAt ?? 0) - (b.startedAt ?? b.createdAt ?? 0))) {
          if (next[run.id]?.rootThreadId === run.rootThreadId) continue;
          next = { ...next, [run.id]: { ...(next[run.id] ?? allocate(next, run.id, run.name || "Workflow")), rootThreadId: run.rootThreadId } };
        }
        if (next !== current.current) commit(next);
        setRuns(listed);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    })().finally(() => { pending.current = null; });
    pending.current = task; return task;
  }, [commit]);
  useEffect(() => { if (enabled && hydrated) void refresh(); }, [enabled, hydrated, refresh]);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 250); };
    window.addEventListener("elpis:workflow-history", changed);
    return () => { clearTimeout(timer); window.removeEventListener("elpis:workflow-history", changed); };
  }, [enabled, refresh]);
  const ensure = useCallback((id: string, name: string) => {
    if (current.current[id]) return current.current[id];
    const identity = allocate(current.current, id, name); commit({ ...current.current, [id]: identity }); return identity;
  }, [commit]);
  const rename = useCallback((id: string, name: string) => {
    const problem = workflowNameProblem(current.current, id, name);
    if (problem) return problem;
    try { commit({ ...current.current, [id]: { ...current.current[id], name: name.trim() } }); return null; }
    catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
  }, [commit]);
  const recolour = useCallback((id: string, colour: WorkflowColour) => { commit({ ...current.current, [id]: { ...current.current[id], colour } }); }, [commit]);
  const attach = useCallback((from: string, id: string, rootThreadId: string) => {
    const next = { ...current.current }, identity = next[from]; delete next[from];
    next[id] = { ...identity, id, rootThreadId }; commit(next); void refresh();
  }, [commit, refresh]);
  return { identities, runs, hydrated, error, ensure, rename, recolour, attach, refresh };
}
export type WorkflowCatalog = ReturnType<typeof useWorkflowCatalog>;

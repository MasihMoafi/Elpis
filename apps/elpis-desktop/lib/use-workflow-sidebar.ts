"use client";
// The sidebar's view of workflow runs: which listed chats are a run's root or one of its steps, their names, and keeping
// the run records fresh while a run goes or a workflow chat arrives before its run.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { title, type Thread } from "./api";
import { chatOrigin } from "./love-activity";
import { useWorkflowCatalog, workflowMembers, type WorkflowRun } from "./workflow-identity";

const PREFIX = "Workflows · ";
type Step = { parent: string; title: string; runId: string; mother: boolean; check: boolean };

export function useWorkflowSidebar(enabled: boolean, threads: Thread[], hidden: RefObject<Set<string>>, onRunsEnded: (runs: WorkflowRun[]) => void) {
  const catalog = useWorkflowCatalog(enabled);
  const listed = useMemo(() => new Set(threads.map(thread => thread.id)), [threads]);
  /** Runs with a chat in the list, not deleted. */
  const runs = useMemo(() => catalog.runs.filter(run => !hidden.current.has(run.rootThreadId) && (listed.has(run.rootThreadId) || workflowMembers(run).some(member => listed.has(member.threadId)))), [catalog.runs, listed]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Each run by its root chat; the newest run wins a root it shares. */
  const roots = useMemo(() => new Map([...runs].sort((a, b) => (a.startedAt ?? a.createdAt ?? 0) - (b.startedAt ?? b.createdAt ?? 0)).map(run => [run.rootThreadId, run])), [runs]);
  const steps = useMemo(() => new Map<string, Step>(runs.flatMap(run => workflowMembers(run).map(member => [member.threadId, { parent: run.rootThreadId, title: member.title, runId: run.id, mother: !!member.mother, check: !!member.check }] as const))), [runs]);

  // A run started or moving on in another window tells this one nothing, and a new step's chat arrives before its run's
  // record does: a workflow chat no run claims, or a run still going, reads the runs again (28 Oct: another window's run
  // left its step, check and Mother chats loose here until a restart).
  const unclaimed = useMemo(() => threads.filter(thread => chatOrigin(thread) === "Workflows" && !steps.has(thread.id) && !roots.has(thread.id)).map(thread => thread.id).sort().join(" "), [threads, steps, roots]);
  const running = catalog.runs.some(run => run.status === "running"), refresh = catalog.refresh;
  useEffect(() => { if (enabled && unclaimed) void refresh(); }, [enabled, unclaimed, refresh]);
  useEffect(() => {
    if (!enabled || !running) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [enabled, running, refresh]);

  const statuses = useRef(new Map<string, string>()), ended = useRef(onRunsEnded); ended.current = onRunsEnded;
  useEffect(() => {
    const finished = catalog.runs.filter(run => statuses.current.get(run.id) === "running" && run.status !== "running");
    statuses.current = new Map(catalog.runs.map(run => [run.id, run.status]));
    if (finished.length) ended.current(finished);
  }, [catalog.runs]);

  /** A step keeps the name he gave it, else its task; a run's chat shows the workflow's name. */
  const sidebarTitle = (thread: Thread) => {
    const step = steps.get(thread.id), chosen = thread.name?.trim();
    if (step) return chosen && !chosen.startsWith(PREFIX) ? chosen : step.title;
    return catalog.identities[roots.get(thread.id)?.id ?? ""]?.name ?? (chosen?.startsWith(PREFIX) ? chosen.slice(PREFIX.length) : title(thread));
  };
  return { catalog, runs, roots, steps, sidebarTitle };
}

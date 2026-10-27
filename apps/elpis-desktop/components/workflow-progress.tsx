"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIdentity } from "@/components/agent-identity";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button } from "@/components/ui/button";
import { api, type Entry, type Thread } from "@/lib/api";
import { agentParentId } from "@/lib/agent-runs.mjs";
import type { RecordedWorkflow } from "./workflow-chat";
import "./workflow-progress.css";

const EMPTY_THREADS: readonly Thread[] = [];

export function workflowThreadActive(thread?: Thread): boolean {
  return ["active", "running", "inProgress"].includes(thread?.status?.type ?? "");
}

function members(run: RecordedWorkflow, threads: readonly Thread[]): Thread[] {
  const ids = new Set([...run.tasks ?? [], ...run.next?.tasks ?? []].flatMap(task => task.assignedThreadId ? [task.assignedThreadId] : []));
  const mother = run.mother?.assignedThreadId ?? run.mother?.sessionId;
  // The root can contain several saved runs. Only explicit members and their descendants belong here.
  if (mother && mother !== run.rootThreadId) ids.add(mother);
  for (let changed = true; changed;) {
    changed = false;
    for (const thread of threads) if (!ids.has(thread.id) && ids.has(agentParentId(thread) ?? "")) {
      ids.add(thread.id); changed = true;
    }
  }
  return threads.filter(thread => ids.has(thread.id) && thread.id !== mother && thread.id !== run.rootThreadId);
}

function report(entries: Entry[]): { text: string; at: number } | undefined {
  const messages = entries.filter(entry => entry.item.type === "agentMessage" && typeof entry.item.text === "string" && entry.item.text.trim());
  // Pages arrive newest first. Timestamps take precedence when a page supplies them.
  const latest = messages.reduce<Entry | undefined>((best, entry) => !best || (entry.completedAtMs ?? entry.startedAtMs ?? 0) > (best.completedAtMs ?? best.startedAtMs ?? 0) ? entry : best, undefined);
  return typeof latest?.item.text === "string" ? { text: latest.item.text.trim(), at: latest.completedAtMs ?? latest.startedAtMs ?? 0 } : undefined;
}

export function useWorkflowTeam(run: RecordedWorkflow | undefined, ready: boolean, threads: readonly Thread[] = EMPTY_THREADS) {
  const [observed, setObserved] = useState<Thread[]>([]), [lastUpdate, setLastUpdate] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const supplied = useRef(threads); supplied.current = threads;
  const currentRun = useRef(run); currentRun.current = run;
  const motherId = run ? run.mother?.assignedThreadId ?? run.mother?.sessionId ?? run.rootThreadId : undefined;
  const seedKey = JSON.stringify(run ? [...run.tasks ?? [], ...run.next?.tasks ?? []].flatMap(task => task.assignedThreadId ? [task.assignedThreadId] : []) : []);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    setObserved([]); setLastUpdate(""); setError("");
  }, [run?.id, run?.rootThreadId]);
  useEffect(() => {
    setObserved(previous => {
      const merged = new Map(previous.map(thread => [thread.id, thread]));
      for (const thread of threads) merged.set(thread.id, { ...merged.get(thread.id), ...thread });
      return [...merged.values()];
    });
  }, [threads]);

  useEffect(() => {
    if (!ready || !run || !motherId) { setLoading(false); return; }
    const root = run.rootThreadId, controller = new AbortController();
    let disposed = false, pending = false;
    const read = async () => {
      if (disposed || pending || document.visibilityState === "hidden" || !navigator.onLine) return;
      pending = true; setLoading(true);
      try {
        const listed: Thread[] = [], cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: { data: Thread[]; nextCursor?: string | null } = await api(`/threads?ancestorThreadId=${encodeURIComponent(root)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, controller.signal);
          if (!Array.isArray(page.data)) throw Error("Could not read the workflow’s live team.");
          listed.push(...page.data); cursor = page.nextCursor ?? null;
          if (cursor && cursors.has(cursor)) throw Error("The live team list repeated a page. Refresh to try again.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        const record = currentRun.current;
        if (!record || disposed) return;
        const merged = new Map(supplied.current.map(thread => [thread.id, thread]));
        for (const thread of listed) merged.set(thread.id, { ...merged.get(thread.id), ...thread });
        const children = members(record, [...merged.values()]);
        const recent = [...children].sort((a, b) => Number(workflowThreadActive(b)) - Number(workflowThreadActive(a)) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        const missing = (JSON.parse(seedKey) as string[]).filter(id => !merged.has(id));
        const ids = [...new Set([motherId, ...missing, ...(recent ? [recent.id] : [])])];
        let latest = "", latestAt = -Infinity, motherReport = "";
        const failures: string[] = [];
        for (let offset = 0; offset < ids.length && !disposed; offset += 3) {
          const details = await Promise.allSettled(ids.slice(offset, offset + 3).map(async id => ({ id, result: await api<{ thread: Thread; data?: Entry[] }>(`/threads/${encodeURIComponent(id)}?limit=20`, undefined, controller.signal) })));
          for (let index = 0; index < details.length; index++) {
            const detail = details[index], id = ids[offset + index];
            if (detail.status === "rejected") { failures.push(`Could not read ${id === motherId ? "Mother" : "an agent"}: ${detail.reason instanceof Error ? detail.reason.message : String(detail.reason)}`); continue; }
            const { result } = detail.value;
            if (result.thread?.id !== id) { failures.push(`Could not read ${id === motherId ? "Mother’s" : "an agent’s"} current status.`); continue; }
            merged.set(id, { ...merged.get(id), ...result.thread });
            const observedReport = report(result.data ?? []);
            if (!observedReport) continue;
            const { text } = observedReport, at = observedReport.at || (result.thread.updatedAt ?? 0) * 1000;
            const labelled = `${id === motherId ? "Mother" : result.thread.name || result.thread.workflowTaskTitle || "Agent"}: ${text.length > 650 ? `${text.slice(0, 650)}…` : text}`;
            if (id === motherId) motherReport = labelled;
            else if (at >= latestAt) { latestAt = at; latest = labelled; }
          }
        }
        if (!disposed) {
          setObserved([...merged.values()]); if (motherReport || latest) setLastUpdate(motherReport || latest);
          setError(failures.length ? failures[0] : "");
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { pending = false; if (!disposed) setLoading(false); }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    const changed = () => void read();
    document.addEventListener("visibilitychange", changed); window.addEventListener("online", changed);
    return () => { disposed = true; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", changed); window.removeEventListener("online", changed); };
  }, [run?.id, run?.rootThreadId, motherId, seedKey, ready, revision]);

  const agents = useMemo(() => run ? members(run, observed) : [], [run, observed]);
  const mother = observed.find(thread => thread.id === motherId);
  return { agents, mother, motherId, lastUpdate, loading, error, refresh };
}

type Team = ReturnType<typeof useWorkflowTeam>;
function status(thread?: Thread) {
  return workflowThreadActive(thread) ? "Working" : thread?.status?.type === "idle" ? "Idle" : thread?.status?.type || "Status unavailable";
}

export function WorkflowProgress({ run, team, onOpenChat, onRefresh, compact = false }: { run: RecordedWorkflow; team: Team; onOpenChat: (id: string) => void; onRefresh?: () => void; compact?: boolean }) {
  const active = team.agents.filter(workflowThreadActive).length;
  const complete = (run.tasks ?? []).filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length;
  const byId = new Map(team.agents.map(thread => [thread.id, thread]));
  const depth = (thread: Thread) => {
    let level = 0, parent = agentParentId(thread); const seen = new Set([thread.id]);
    while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); level++; parent = agentParentId(byId.get(parent)!); }
    return level;
  };
  return <section className={`workflow-progress ${compact ? "space-y-1" : "space-y-3"}`} data-compact={compact || undefined} aria-label="Live workflow progress">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <AgentIdentity id={team.motherId || run.rootThreadId} name="Mother" model={team.mother?.model} provider={team.mother?.modelProvider} />
      <span role="status">{status(team.mother)}</span>
      <Button variant="ghost" size="sm" disabled={team.loading} onClick={onRefresh ?? team.refresh} aria-label="Refresh live progress">Refresh progress</Button>
      {team.motherId && <Button variant="ghost" size="sm" onClick={() => onOpenChat(team.motherId!)}>Open Mother chat</Button>}
    </div>
    {!run.mother && !compact && <p className="text-xs text-muted-foreground">Mother is the run’s parent chat. No separate supervisor was recorded.</p>}
    <p role="status">Live: {active} working · {team.agents.length} agents observed.{!compact && <> Saved run: {run.status} · {complete}/{run.tasks?.length ?? 0} tasks complete.</>}</p>
    {team.lastUpdate && <p className="workflow-progress-report"><span className="text-muted-foreground">Latest observed report · </span>{team.lastUpdate}</p>}
    {!team.lastUpdate && <p className="text-muted-foreground">{team.loading ? "Reading live progress…" : "No agent report observed yet."}</p>}
    {team.error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-destructive">{team.error}</p></div>}
    {!!team.agents.length && <details open={!compact && active > 0}><DisclosureSummary>Live team · {team.agents.length}</DisclosureSummary><ol className="space-y-2 pt-2">{team.agents.map(thread => <li key={thread.id} className="workflow-progress-agent flex flex-wrap items-center justify-between gap-2" style={{ paddingInlineStart: `${depth(thread) * 16}px` }}>
      <AgentIdentity compact id={thread.id} name={thread.name || thread.workflowTaskTitle || "Agent"} model={thread.model} provider={thread.modelProvider} />
      <span>{status(thread)}</span><Button variant="ghost" size="sm" onClick={() => onOpenChat(thread.id)}>Open chat</Button>
    </li>)}</ol></details>}
  </section>;
}

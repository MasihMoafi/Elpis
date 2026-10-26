"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, unreadable } from "@/lib/api";
import { WorkflowMark } from "@/components/workflow-identity";
import type { WorkflowCatalog } from "@/lib/workflow-identity";

type WorkflowRun = { id: string; rootThreadId: string; name?: string; status: string; tasks?: { status: string }[]; removable?: boolean; removalReason?: string };
export function WorkflowHistory({ revision, onOpenChat, catalog }: { revision?: string; onOpenChat: (id: string) => void; catalog?: WorkflowCatalog }) {
  const [open, setOpen] = useState(false), [runs, setRuns] = useState<WorkflowRun[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [canUndo, setCanUndo] = useState(false), [pending, setPending] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api<{ data: WorkflowRun[]; canUndo?: boolean }>("/workflows/history");
      if (!Array.isArray(result.data)) throw unreadable("saved workflows");
      setRuns(result.data); setCanUndo(result.canUndo === true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load workflows"); }
    finally { setLoading(false); }
  }, []);
  const change = async (id?: string) => {
    setPending(id ?? "undo"); setError("");
    try {
      const result = await api<{ canUndo: boolean }>(id ? `/workflows/history/${encodeURIComponent(id)}/remove` : "/workflows/history/undo", {});
      setCanUndo(result.canUndo);
      await refresh();
      window.dispatchEvent(new Event("elpis:workflow-history"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change workflow history"); }
    finally { setPending(null); }
  };
  useEffect(() => { if (open) void refresh(); }, [open, revision, refresh]);
  return <div className="workflow-history">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}><History size={15} />History</Button>
    {open && <section className="workflow-history-list hud-menu" aria-label="Workflow history">
      <div className="flex items-center justify-between gap-3"><strong>Workflow history</strong><Button variant="ghost" size="icon-xs" disabled={loading || pending !== null} aria-label="Refresh workflows" onClick={() => void refresh()}><RefreshCw size={14} /></Button></div>
      {loading && <p role="status">Loading workflows…</p>}
      {error && <p role="alert">{error}</p>}
      {canUndo && <Button variant="ghost" size="xs" disabled={pending !== null || loading} onClick={() => void change()} aria-label="Undo history removal">Undo removal</Button>}
      {!loading && !error && !runs.length && <p>No workflows in history.</p>}
      <ul>{runs.map(run => { const name = catalog?.identities[run.id]?.name || run.name || "Workflow"; return <li key={run.id}><div><strong>{catalog?.identities[run.id] && <WorkflowMark identity={catalog.identities[run.id]} />}{name}</strong><small>{run.status}{run.tasks ? ` · ${run.tasks.filter(task => task.status === "succeeded" || task.status === "completed").length}/${run.tasks.length} tasks complete` : ""}{run.removalReason && ` · ${run.removalReason}`}</small></div><Button variant="outline" size="xs" onClick={() => onOpenChat(run.rootThreadId)}>Open chat</Button><Button variant="ghost" size="xs" aria-label={`Remove ${name} from history`} disabled={run.removable !== true || pending !== null || loading} onClick={() => void change(run.id)}>{pending === run.id ? "Removing…" : "Remove"}</Button></li>; })}</ul>
    </section>}
  </div>;
}

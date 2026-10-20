"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, unreadable } from "@/lib/api";

type WorkflowRun = { id: string; rootThreadId: string; name?: string; status: string; tasks?: { status: string }[] };
export function WorkflowHistory({ revision, onOpenChat }: { revision?: string; onOpenChat: (id: string) => void }) {
  const [open, setOpen] = useState(false), [runs, setRuns] = useState<WorkflowRun[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api<{ data: WorkflowRun[] }>("/workflows/history");
      if (!Array.isArray(result.data)) throw unreadable("saved workflows");
      setRuns(result.data);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load workflows"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, revision, refresh]);
  return <div className="workflow-history">
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}><History size={15} />Current workflows</Button>
    {open && <section className="workflow-history-list hud-menu" aria-label="Current workflows">
      <div className="flex items-center justify-between gap-3"><strong>Current workflows</strong><Button variant="ghost" size="icon-xs" disabled={loading} aria-label="Refresh workflows" onClick={() => void refresh()}><RefreshCw size={14} /></Button></div>
      {loading && <p role="status">Loading workflows…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !runs.length && <p>No workflows have run yet.</p>}
      <ul>{runs.map(run => <li key={run.id}><div><strong>{run.name || "Workflow"}</strong><small>{run.status}{run.tasks ? ` · ${run.tasks.filter(task => task.status === "succeeded" || task.status === "completed").length}/${run.tasks.length} tasks complete` : ""}</small></div><Button variant="outline" size="xs" onClick={() => onOpenChat(run.rootThreadId)}>Open chat</Button></li>)}</ul>
    </section>}
  </div>;
}

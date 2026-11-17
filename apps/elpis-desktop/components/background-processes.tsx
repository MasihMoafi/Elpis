"use client";

import { useEffect, useRef, useState } from "react";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Button } from "@/components/ui/button";
import { api, type Entry } from "@/lib/api";
import { BackgroundProcessesDisabled, listBackgroundProcesses, processView, type BackgroundProcess } from "@/lib/background-processes.mts";

/** The runtime, not the turn's transcript, decides whether a terminal is still running. */
export function BackgroundProcesses({ threadId, active, entries, showUnavailable = false }: { threadId: string; active: boolean; entries: Entry[]; showUnavailable?: boolean }) {
  const [state, setState] = useState<{ jobs: BackgroundProcess[]; unavailable: boolean }>({ jobs: [], unavailable: false });
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const hadJobs = useRef(false);
  // A recorded unfinished command is only a reason to check, never proof that a process runs.
  const pending = entries.some(entry => entry.item.type === "commandExecution" && entry.item.status === "inProgress");
  useEffect(() => {
    let disposed = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const schedule = (delay: number) => {
      if (document.visibilityState === "visible") timer = setTimeout(() => { void refresh(); }, delay);
    };
    const visible = () => {
      if (document.visibilityState === "visible") setRetry(value => value + 1);
    };
    document.addEventListener("visibilitychange", visible);
    async function refresh() {
      try {
        const jobs = await listBackgroundProcesses(cursor => api<unknown>(
          `/threads/${encodeURIComponent(threadId)}/background-processes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          undefined, abort.signal,
        ));
        if (disposed) return;
        failures = 0;
        hadJobs.current = jobs.length > 0;
        if (!jobs.length) setOpen(false);
        setState({ jobs, unavailable: false });
        if (active || jobs.length) schedule(5000);
      } catch (error) {
        if (disposed) return;
        const disabled = error instanceof BackgroundProcessesDisabled;
        setState(previous => ({ ...previous, unavailable: !disabled || previous.jobs.length > 0 }));
        if (disabled) schedule(60000);
        else if (active || hadJobs.current || pending || showUnavailable) schedule(Math.min(60000, 5000 * 2 ** failures++));
      }
    }
    void refresh();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [threadId, active, pending, showUnavailable, retry]);
  if (!state.jobs.length && !(state.unavailable && (pending || showUnavailable))) return null;
  const jobs = processView(state.jobs, entries);
  return (
    <Disclosure className="activity-group mx-auto w-full max-w-[var(--transcript-width,740px)] px-4"
      onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
      <DisclosureSummary>
        {state.unavailable ? "Background process status unavailable" : `${jobs.length} background ${jobs.length === 1 ? "process" : "processes"} running`}
      </DisclosureSummary>
      {open && <div className="activity-group-body max-h-48 overflow-auto">
        {!jobs.length && <p>Elpis could not check the background processes for this chat.</p>}
        {state.unavailable && <Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry</Button>}
        {jobs.map(job => (
          <div key={job.processId} className="mb-2">
            <pre className="whitespace-pre-wrap break-all"><code>{job.command}</code></pre>
            {job.output && <pre className="whitespace-pre-wrap break-all">{job.output}</pre>}
          </div>
        ))}
      </div>}
    </Disclosure>
  );
}

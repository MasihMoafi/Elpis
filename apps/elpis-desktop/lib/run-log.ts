/** The Workflows run log (components/agents-canvas.tsx): each poll of a run adds what changed since the last one. A task
 * that finished between polls still logs its start; a report is logged once, when the engine has its result, whatever the
 * task's status. `seen` and `reported` carry over between polls; `name` titles an agent. */
export type LogLine = { at?: number; agent?: string; text: string; tone: "start" | "done" | "fail" };
export type PolledTask = { id: string; status: string; failureReason?: string | null; result?: unknown };
export function taskLogLines(tasks: PolledTask[], seen: Record<string, string>, reported: Set<string>, name: (agent: string) => string, at = Date.now()): LogLine[] {
  return tasks.flatMap(task => {
    const previous = seen[task.id];
    seen[task.id] = task.status;
    const check = task.id.endsWith("-check"), agent = check ? task.id.slice(0, -"-check".length) : task.id;
    const who = name(agent);
    const lines: LogLine[] = [];
    if (previous !== task.status) {
      // A successful task necessarily started, even when it finished between snapshots. Times are observations.
      if (task.status === "succeeded" && previous !== "running") lines.push({ at, agent, text: `${check ? "CHECK STARTED" : "AGENT STARTED"} · ${who}`, tone: "start" });
      const label = task.status === "running" ? (check ? "CHECK STARTED" : "AGENT STARTED") : task.status === "succeeded" ? (check ? "CHECK PASSED" : "TASK DONE") : task.status === "blocked" ? "INPUT BLOCKED" : task.status === "failed" ? (check ? "CHECK FAILED" : "TASK FAILED") : task.status === "cancelled" ? "TASK CANCELLED" : "";
      if (label) lines.push({ at, agent, text: `${label} · ${who}${task.failureReason ? ` · ${task.failureReason}` : ""}`, tone: task.status === "running" ? "start" : task.status === "succeeded" ? "done" : "fail" });
    }
    // The engine's accepted result is the evidence of a report, independent of the task's status transition.
    if (task.result !== undefined && task.result !== null && !reported.has(task.id)) {
      reported.add(task.id);
      lines.push({ at, agent, text: `REPORT RECEIVED · DATASTORE CAPTURED · ${who}`, tone: "done" });
      // Elpis moved a new file the agent saved outside its folder into it (1 Nov); the log says so, never silently.
      const relocated = (task.result as { relocated?: { from: string; to: string }[] }).relocated ?? [];
      for (const move of relocated) lines.push({ at, agent, text: `FILE MOVED INTO ITS FOLDER · ${move.from} → ${move.to} · ${who}`, tone: "start" });
    }
    return lines;
  });
}

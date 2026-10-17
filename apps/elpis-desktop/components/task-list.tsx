"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The agent's plan for a turn, as turn/plan/updated reports it (codex-rs app-server-protocol v2 TurnPlanStep). */
export type TaskPlan = { turnId: string; explanation: string | null; steps: { step: string; status: "pending" | "inProgress" | "completed" }[] };
const STATUS = { pending: "to do", inProgress: "in progress", completed: "done" } as const;

/** The task list above the message box, as Claude Code shows its todo list: open while the turn works, folded to
 * "n of m done" once it ends, and openable or closable by hand. */
export function TaskList({ plan, running }: { plan: TaskPlan; running: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null), [turn, setTurn] = useState(plan.turnId);
  if (turn !== plan.turnId) { setTurn(plan.turnId); setOpen(null); }
  const shown = open ?? running, done = plan.steps.filter(step => step.status === "completed").length;
  return <section className="task-list" aria-label="Tasks">
    <div className="task-list-head">
      <span className="hud-menu-title">Tasks</span><span className="task-list-count">{done} of {plan.steps.length} done</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={shown ? "Hide tasks" : "Show tasks"} aria-expanded={shown} onClick={() => setOpen(!shown)}><ChevronDown size={14} className={shown ? "rotate-180" : undefined} /></Button>
    </div>
    {shown && plan.explanation && <p className="task-list-note">{plan.explanation}</p>}
    {shown && <ul>{plan.steps.map((step, index) => <li key={index} data-status={step.status} aria-label={`${step.step}, ${STATUS[step.status]}`}><i className="task-mark" aria-hidden="true" />{step.step}</li>)}</ul>}
  </section>;
}

"use client";
// Automations (6 Nov, Masih: "we need a schedule tab in Elpis ... mimic deepseek's"): prompts Elpis sends on a schedule,
// as DeepSeek Harness's "Automation tasks". The list filters by state; New and Edit open the same form; each task has
// Run now, Pause or Resume, Edit, Delete and its past runs, each opening the chat it ran in. bridge/schedule.mjs runs them.
import "@/components/automations-view.css";
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Choice, Segmented, SettingsEmpty, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { defaultTiming, rruleFromDraft, ScheduleFields, timingFromRule, timingValid, type TimingDraft } from "@/components/schedule-editor";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import type { Project } from "@/lib/projects";
import type { CanvasGraph } from "@/lib/canvas";

type Run = { at: number; scheduledFor: number | null; threadId: string | null; error: string | null };
/** `rule` is RFC 5545 text, one DTSTART and one RRULE (bridge/schedule-rules.mjs). */
/** A workflow scheduled from the Workflows board: its id and name, and on creation the board it replays. */
export type ScheduledWorkflow = { id: string; name: string; board?: CanvasGraph };
export type Automation = { id: string; title: string; prompt: string; cwd: string | null; rule: string; target: "reuse" | "new"; status: "active" | "paused" | "ended"; workflow?: ScheduledWorkflow | null;
  nextRunAt: number | null; lastRunAt: number | null; runs: Run[]; description: string };

type Draft = TimingDraft & { title: string; prompt: string; cwd: string; target: "reuse" | "new"; workflow: ScheduledWorkflow | null };
/** What the board hands over when he presses Schedule: the workflow, its request and its project. */
export type WorkflowPrefill = { id: string; name: string; board: CanvasGraph; request: string; cwd?: string };
const FILTERS = [{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "ended", label: "Ended" }, { value: "all", label: "All" }] as const;
type Filter = typeof FILTERS[number]["value"];
const TARGETS = [{ value: "reuse", label: "One chat, reused every run" }, { value: "new", label: "A new chat every run" }] as const;

const blank = (from?: WorkflowPrefill | null): Draft => ({ ...defaultTiming(), title: from?.name ?? "", prompt: from?.request ?? "", cwd: from?.cwd ?? "", target: "reuse", workflow: from ? { id: from.id, name: from.name, board: from.board } : null });
const draftOf = (task: Automation): Draft => ({ ...timingFromRule(task.rule), title: task.title, prompt: task.prompt, cwd: task.cwd ?? "", target: task.target, workflow: task.workflow ?? null });
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** New or Edit, as DeepSeek Harness's editor: name, instruction, where it runs, then its Run time. */
function AutomationForm({ initial, editing, projects, onSave, onCancel }: { initial: Draft; editing: boolean; projects: Project[]; onSave: (draft: Draft) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (patch: Partial<Draft>) => setDraft(previous => ({ ...previous, ...patch }));
  async function save() {
    setBusy(true); setError("");
    try { await onSave(draft); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  const heading = initial.workflow ? `Schedule the workflow “${initial.workflow.name}”` : editing ? "Edit automation" : "New automation";
  return <section className="automation-form" aria-label={heading}>
    <h3>{heading}</h3>
    <label className="automation-field">Name<Input aria-label="Automation name" maxLength={120} value={draft.title} onChange={event => set({ title: event.target.value })} placeholder="Morning build check" /></label>
    <label className="automation-field">{draft.workflow ? "Request" : "Instruction"}<Textarea aria-label="Automation instruction" rows={4} value={draft.prompt} onChange={event => set({ prompt: event.target.value })} placeholder="Check last night's CI runs and tell me what failed." /></label>
    <div className="schedule-rows">
      <div className="schedule-row"><span className="schedule-row-label">Run in</span><Choice label="Run in" value={draft.target} options={[...TARGETS]} onChange={target => set({ target })} /></div>
      <div className="schedule-row"><span className="schedule-row-label">Project</span><Choice label="Project" value={draft.cwd} onChange={cwd => set({ cwd })} options={[{ value: "", label: "No project" }, ...projects.map(project => ({ value: project.cwd, label: project.name }))]} /></div>
    </div>
    <ScheduleFields draft={draft} onChange={timing => set(timing)} />
    <div className="automation-form-actions">
      {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
      <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button disabled={busy || !draft.title.trim() || !draft.prompt.trim() || !timingValid(draft)} onClick={() => void save()}>{busy ? "Saving…" : editing ? "Save" : "Create"}</Button>
    </div>
  </section>;
}

/** `prefill` opens the form for a workflow the board handed over; `onPrefillUsed` clears it once taken. */
export function AutomationsView({ projects, onOpenChat, prefill, onPrefillUsed }: { projects: Project[]; onOpenChat: (threadId: string) => void; prefill?: WorkflowPrefill | null; onPrefillUsed?: () => void }) {
  const [tasks, setTasks] = useState<Automation[] | null>(null), [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("active"), [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null), [deleting, setDeleting] = useState<Automation | null>(null);
  const [fromBoard, setFromBoard] = useState<WorkflowPrefill | null>(null);
  // The board's Schedule button: open a new automation for that workflow, once.
  useEffect(() => { if (!prefill) return; setFromBoard(prefill); setEditing("new"); onPrefillUsed?.(); }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    try { const result = await api<{ data: Automation[] }>("/automations"); setTasks(result.data); setError(""); }
    catch (cause) { setError(errorText(cause)); }
  }, []);
  // A run changes a task (its next time, its runs); while the page is open it is read again every 20 seconds.
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 20_000); return () => clearInterval(timer); }, [load]);
  const replace = (task: Automation) => setTasks(previous => previous?.some(item => item.id === task.id) ? previous.map(item => item.id === task.id ? task : item) : [task, ...previous ?? []]);
  async function act(task: Automation, body: Record<string, unknown>) {
    setBusy(task.id); setError("");
    try { replace(await api<Automation>(`/automations/${task.id}`, body)); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  }
  async function save(draft: Draft) {
    const fields = { title: draft.title, prompt: draft.prompt, cwd: draft.cwd || null, target: draft.target, rule: rruleFromDraft(draft, editing === "new"), ...(draft.workflow ? { workflow: draft.workflow } : {}) };
    const saved = editing === "new" ? await api<Automation>("/automations", fields) : await api<Automation>(`/automations/${(editing as Automation).id}`, { action: "update", ...fields });
    replace(saved); setEditing(null); setFromBoard(null); setOpen(saved.id);
    if (filter !== "all" && saved.status !== filter) setFilter("all");
  }
  const shown = (tasks ?? []).filter(task => filter === "all" || task.status === filter);
  return <div className="automations settings-page" aria-label="Scheduled">
    <SettingsHeader title="Scheduled" description="Prompts Elpis sends on a schedule. They run while Elpis is open or in the tray; runs missed while it was closed happen once when it starts."
      action={editing ? undefined : <Button onClick={() => setEditing("new")}><Plus />New automation</Button>} />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {editing && <AutomationForm key={editing === "new" ? `new-${fromBoard?.id ?? ""}` : editing.id} initial={editing === "new" ? blank(fromBoard) : draftOf(editing)} editing={editing !== "new"} projects={projects} onSave={save} onCancel={() => { setEditing(null); setFromBoard(null); }} />}
    {!editing && <>
      <div className="automation-filter"><Segmented label="Show" value={filter} onChange={setFilter} options={[...FILTERS]} /></div>
      {tasks && !shown.length && <SettingsEmpty title={filter === "all" || filter === "active" ? "No automations yet" : `No ${filter} automations`}>
        {(filter === "all" || filter === "active") && <p>Create one here, or ask in any chat, for example “every weekday at 9, check the CI and tell me what failed”.</p>}
      </SettingsEmpty>}
      {shown.length > 0 && <div className="settings-rows automation-list">{shown.map(task => {
        const expanded = open === task.id, working = busy === task.id;
        return <div key={task.id} className="automation" data-automation-id={task.id} data-status={task.status}>
          <Button type="button" variant="ghost" className="automation-summary" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : task.id)}>
            <CalendarClock size={16} aria-hidden="true" />
            <span className="automation-title">{task.title}</span>
            {task.workflow && <span className="settings-badge">Workflow</span>}
            {task.status !== "active" && <span className="settings-badge">{task.status === "paused" ? "Paused" : "Ended"}</span>}
            <span className="automation-when">{task.description}{task.nextRunAt ? ` · next ${when(task.nextRunAt)}` : ""}</span>
          </Button>
          {expanded && <div className="automation-detail">
            <p className="automation-prompt">{task.prompt}</p>
            <p className="automation-meta">{task.target === "reuse" ? "Runs in one chat" : "A new chat each run"}{task.cwd ? ` · ${projects.find(project => project.cwd === task.cwd)?.name ?? task.cwd}` : ""}</p>
            <div className="automation-actions">
              <Button size="sm" variant="outline" disabled={working} onClick={() => void act(task, { action: "run" })}><Zap />Run now</Button>
              {task.status !== "ended" && <Button size="sm" variant="ghost" disabled={working} onClick={() => void act(task, { action: "update", status: task.status === "active" ? "paused" : "active" })}>{task.status === "active" ? <><Pause />Pause</> : <><Play />Resume</>}</Button>}
              <Button size="sm" variant="ghost" disabled={working} onClick={() => setEditing(task)}><Pencil />Edit</Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={() => setDeleting(task)}><Trash2 />Delete</Button>
            </div>
            <h4 className="automation-runs-title">Runs</h4>
            {task.runs.length ? <ul className="automation-runs">{task.runs.map(run => <li key={run.at}>
              <span>{when(run.at)}{run.scheduledFor === null ? " · run now" : ""}</span>
              {run.error ? <span className="automation-run-error">{run.error}</span> : run.threadId && <Button size="xs" variant="ghost" onClick={() => onOpenChat(run.threadId!)}>Open chat</Button>}
            </li>)}</ul> : <p className="automation-meta">Not run yet.</p>}
          </div>}
        </div>;
      })}</div>}
    </>}
    <ConfirmDelete request={deleting} names={deleting ? [deleting.title] : []} noun="automation" alwaysConfirm description="Its schedule and run list go; the chats it ran in stay."
      onDelete={async task => { await api(`/automations/${task.id}`, { action: "delete" }); setTasks(previous => previous?.filter(item => item.id !== task.id) ?? previous); }} onClose={() => setDeleting(null)} />
  </div>;
}

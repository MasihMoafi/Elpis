"use client";
// Automations (7 Nov, Masih: "we need a schedule tab in Elpis ... mimic deepseek's"): prompts Elpis sends on a schedule,
// as DeepSeek Harness's "Automation tasks". The list filters by state; New and Edit open the same form; each task has
// Run now, Pause or Resume, Edit, Delete and its past runs, each opening the chat it ran in. bridge/schedule.mjs runs them.
import "@/components/automations-view.css";
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDelete } from "@/components/confirm-delete";
import { Choice, Segmented, SettingRow, SettingsEmpty, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import type { Project } from "@/lib/projects";

type Rule = { kind: "once"; at: string } | { kind: "daily" | "weekdays"; time: string } | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; day: number; time: string } | { kind: "every"; minutes: number };
type Run = { at: number; scheduledFor: number | null; threadId: string | null; error: string | null };
export type Automation = { id: string; title: string; prompt: string; cwd: string | null; rule: Rule; target: "reuse" | "new"; status: "active" | "paused" | "ended";
  nextRunAt: number | null; lastRunAt: number | null; runs: Run[]; description: string };

/** The form's choice of repeat; "hours" and "minutes" are one `every` rule. */
type Repeat = "once" | "daily" | "weekdays" | "weekly" | "monthly" | "hours" | "minutes";
type Draft = { title: string; prompt: string; cwd: string; target: "reuse" | "new"; repeat: Repeat; date: string; time: string; days: number[]; day: number; interval: number };
const REPEATS: { value: Repeat; label: string }[] = [
  { value: "once", label: "Once" }, { value: "daily", label: "Every day" }, { value: "weekdays", label: "Monday to Friday" }, { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Every month" }, { value: "hours", label: "Every few hours" }, { value: "minutes", label: "Every few minutes" },
];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FILTERS = [{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "ended", label: "Ended" }, { value: "all", label: "All" }] as const;
type Filter = typeof FILTERS[number]["value"];

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const inAnHour = () => { const d = new Date(Date.now() + 60 * 60 * 1000); return `${pad(d.getHours())}:00`; };
const blank = (): Draft => ({ title: "", prompt: "", cwd: "", target: "reuse", repeat: "daily", date: today(), time: inAnHour(), days: [new Date().getDay() || 7], day: new Date().getDate(), interval: 1 });

function draftOf(task: Automation): Draft {
  const draft = { ...blank(), title: task.title, prompt: task.prompt, cwd: task.cwd ?? "", target: task.target };
  const rule = task.rule;
  if (rule.kind === "once") return { ...draft, repeat: "once", date: rule.at.slice(0, 10), time: rule.at.slice(11) };
  if (rule.kind === "every") return rule.minutes % 60 === 0 ? { ...draft, repeat: "hours", interval: rule.minutes / 60 } : { ...draft, repeat: "minutes", interval: rule.minutes };
  if (rule.kind === "weekly") return { ...draft, repeat: "weekly", days: rule.days, time: rule.time };
  if (rule.kind === "monthly") return { ...draft, repeat: "monthly", day: rule.day, time: rule.time };
  return { ...draft, repeat: rule.kind, time: rule.time };
}
function ruleOf(draft: Draft): Rule {
  if (draft.repeat === "once") return { kind: "once", at: `${draft.date}T${draft.time}` };
  if (draft.repeat === "hours") return { kind: "every", minutes: draft.interval * 60 };
  if (draft.repeat === "minutes") return { kind: "every", minutes: draft.interval };
  if (draft.repeat === "weekly") return { kind: "weekly", days: draft.days, time: draft.time };
  if (draft.repeat === "monthly") return { kind: "monthly", day: draft.day, time: draft.time };
  return { kind: draft.repeat, time: draft.time };
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** New or Edit: one form for both. */
function AutomationForm({ initial, projects, onSave, onCancel }: { initial: Draft; projects: Project[]; onSave: (draft: Draft) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const clock = draft.repeat !== "hours" && draft.repeat !== "minutes";
  async function save() {
    setBusy(true); setError("");
    try { await onSave(draft); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <SettingsGroup title={initial.title ? "Edit automation" : "New automation"}>
    <SettingRow title="Name"><Input aria-label="Automation name" maxLength={120} value={draft.title} onChange={event => set("title", event.target.value)} placeholder="Morning build check" /></SettingRow>
    <SettingRow title="Instruction" description="What Elpis is asked each time it runs." stacked>
      <Textarea aria-label="Automation instruction" rows={4} value={draft.prompt} onChange={event => set("prompt", event.target.value)} placeholder="Check last night's CI runs and tell me what failed." />
    </SettingRow>
    <SettingRow title="Project"><Choice label="Project" value={draft.cwd} onChange={value => set("cwd", value)} options={[{ value: "", label: "No project" }, ...projects.map(project => ({ value: project.cwd, label: project.name }))]} /></SettingRow>
    <SettingRow title="Run in" description={draft.target === "reuse" ? "One chat, made on the first run and used every time." : "A new chat for every run."}>
      <Segmented label="Run in" value={draft.target} onChange={value => set("target", value)} options={[{ value: "reuse", label: "One chat" }, { value: "new", label: "New chat each run" }]} />
    </SettingRow>
    <SettingRow title="Repeat"><Choice label="Repeat" value={draft.repeat} onChange={value => set("repeat", value)} options={REPEATS} /></SettingRow>
    {draft.repeat === "once" && <SettingRow title="Date"><Input aria-label="Date" type="date" value={draft.date} onChange={event => set("date", event.target.value)} /></SettingRow>}
    {draft.repeat === "weekly" && <SettingRow title="Days">
      <div className="automation-days" role="group" aria-label="Days">{WEEKDAYS.map((name, index) => { const day = index + 1, on = draft.days.includes(day);
        return <Button key={name} type="button" size="sm" variant={on ? "secondary" : "ghost"} aria-pressed={on} onClick={() => set("days", on ? draft.days.filter(value => value !== day) : [...draft.days, day])}>{name}</Button>; })}</div>
    </SettingRow>}
    {draft.repeat === "monthly" && <SettingRow title="Day of the month" description="A shorter month runs on its last day."><Input aria-label="Day of the month" type="number" min={1} max={31} value={draft.day} onChange={event => set("day", Number(event.target.value))} /></SettingRow>}
    {!clock && <SettingRow title={draft.repeat === "hours" ? "Every how many hours" : "Every how many minutes"}><Input aria-label="Interval" type="number" min={1} max={draft.repeat === "hours" ? 168 : 59} value={draft.interval} onChange={event => set("interval", Number(event.target.value))} /></SettingRow>}
    {clock && <SettingRow title="Time"><Input aria-label="Time" type="time" value={draft.time} onChange={event => set("time", event.target.value)} /></SettingRow>}
    <div className="automation-form-actions">
      {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
      <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button disabled={busy || !draft.title.trim() || !draft.prompt.trim()} onClick={() => void save()}>{busy ? "Saving…" : initial.title ? "Save" : "Create"}</Button>
    </div>
  </SettingsGroup>;
}

export function AutomationsView({ projects, onOpenChat }: { projects: Project[]; onOpenChat: (threadId: string) => void }) {
  const [tasks, setTasks] = useState<Automation[] | null>(null), [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("active"), [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null), [deleting, setDeleting] = useState<Automation | null>(null);
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
    const fields = { title: draft.title, prompt: draft.prompt, cwd: draft.cwd || null, target: draft.target, rule: ruleOf(draft) };
    const saved = editing === "new" ? await api<Automation>("/automations", fields) : await api<Automation>(`/automations/${(editing as Automation).id}`, { action: "update", ...fields });
    replace(saved); setEditing(null); setOpen(saved.id);
    if (filter !== "all" && saved.status !== filter) setFilter("all");
  }
  const shown = (tasks ?? []).filter(task => filter === "all" || task.status === filter);
  return <div className="automations settings-page" aria-label="Automations">
    <SettingsHeader title="Automations" description="Prompts Elpis sends on a schedule. They run while Elpis is open or in the tray; runs missed while it was closed happen once when it starts."
      action={editing ? undefined : <Button onClick={() => setEditing("new")}><Plus />New automation</Button>} />
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {editing && <AutomationForm initial={editing === "new" ? blank() : draftOf(editing)} projects={projects} onSave={save} onCancel={() => setEditing(null)} />}
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

"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Plus, Download, Save, RotateCcw, Trash2, LayoutGrid, Maximize, Minus, X, Search, Code, CircleCheck, CircleX, CircleDot, Loader, Wrench, Zap } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { appStorage } from "@/lib/projects";
import { MarkdownText } from "@/components/markdown-text";
import { ModelPicker } from "@/components/model-picker";
import { api, title, subscriptionOf, providerLabel, providerChoices, modelLabel, type Thread, type Model, type ProviderSettings, type ProviderChoice } from "@/lib/api";

type Kind = "explore" | "implement" | "verify" | "fix";
type Task = { id: string; title: string; instruction: string; kind: Kind; depends_on: string[]; write_scopes: string[]; acceptance_criteria: string[]; environment_id?: string; provider?: string; model?: string };
type Draft = { name: string; max_concurrency: number; max_runtime_seconds?: number; tasks: Task[] };
type Point = { x: number; y: number };
const STORAGE = "elpis-workflow-draft-v1";
// n8n-style square nodes, labelled underneath; ORIGIN_X leaves room for the Start trigger.
const NODE_WIDTH = 96, NODE_HEIGHT = 96, NODE_GAP = 230, ROW_GAP = 180, ORIGIN_X = 170;
const ROLE_ICON = { explore: Search, implement: Code, verify: CircleCheck, fix: Wrench } as const;
const STATUS_ICON: Record<string, React.ReactNode> = { succeeded: <CircleCheck size={14} />, failed: <CircleX size={14} />, cancelled: <CircleX size={14} />, blocked: <CircleX size={14} />, running: <Loader size={14} className="animate-spin" /> };
const kinds: Kind[] = ["explore", "implement", "verify", "fix"];
const writing = (kind: Kind) => kind === "implement" || kind === "fix";
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function workflowProviderChoices(models: Model[], settings: ProviderSettings | null): ProviderChoice[] {
  return providerChoices(models, settings)
    .filter(choice => !subscriptionOf(choice.id) && !/^(claude|agy|antigravity)$/i.test(choice.provider || settings?.main.provider || ""))
    .map(choice => ({ ...choice, id: choice.provider || settings?.main.provider || "" }));
}

export function workflowModelChoice(choices: readonly ProviderChoice[], provider: string, providers: ProviderSettings["providers"] = []): ProviderChoice {
  return choices.find(choice => choice.id === provider) ?? { id: provider, label: providerLabel(null, provider, providers) || "Conversation provider", ...(provider ? { provider } : {}), models: [] };
}

/** The catalog belongs to this route; inherited and saved unlisted values remain unchanged. */
export function WorkflowModelChoice({ choice, model, defaultModel, defaultLabel, disabled, onChange, onConfigure }: {
  choice: ProviderChoice; model: string; defaultModel?: string | null; defaultLabel?: string; disabled: boolean; onChange: (model: string) => void; onConfigure?: () => void;
}) {
  return <div className="space-y-2"><ModelPicker key={choice.id} choices={[choice]} models={choice.models} model={model} choiceId={choice.id}
    defaultModel={defaultModel} disabled={disabled} onConfigure={onConfigure} onChange={next => { if (next.choiceId === choice.id) onChange(next.model); }} />
    {model && defaultLabel && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange("")}>{defaultLabel}</Button>}
  </div>;
}

export function validateWorkflow(value: unknown): string[] {
  if (!object(value)) return ["Import a workflow object."];
  const errors: string[] = [];
  if (!text(value.name)) errors.push("Give the workflow a name.");
  if (!Number.isInteger(value.max_concurrency) || Number(value.max_concurrency) < 1 || Number(value.max_concurrency) > 32) errors.push("Concurrency must be between 1 and 32.");
  if (value.max_runtime_seconds !== undefined && (!Number.isInteger(value.max_runtime_seconds) || Number(value.max_runtime_seconds) < 1)) errors.push("Runtime must be a positive number of seconds.");
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 256) return [...errors, "Add between 1 and 256 tasks."];
  const ids = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (!object(task)) { errors.push(`Task ${index + 1} must be an object.`); continue; }
    const name = text(task.id) ? task.id : `Task ${index + 1}`;
    if (!text(task.id) || !/^[a-zA-Z0-9_-]+$/.test(task.id)) errors.push(`${name}: use a task ID with letters, numbers, underscores or hyphens.`);
    else { if (ids.has(task.id)) errors.push(`${name}: duplicate task ID.`); ids.add(task.id); }
    if (!text(task.title) || !text(task.instruction)) errors.push(`${name}: add a title and instructions.`);
    if (!kinds.includes(task.kind as Kind)) errors.push(`${name}: choose a valid role.`);
    for (const key of ["depends_on", "write_scopes", "acceptance_criteria"]) {
      if (!Array.isArray(task[key]) || !(task[key] as unknown[]).every(text)) errors.push(`${name}: ${key} must contain text entries.`);
    }
    if (Array.isArray(task.acceptance_criteria) && !task.acceptance_criteria.length) errors.push(`${name}: add an acceptance criterion.`);
    if (Array.isArray(task.write_scopes)) {
      if (writing(task.kind as Kind) !== (task.write_scopes.length > 0)) errors.push(`${name}: only implement/fix tasks require write scopes; explore/verify tasks must have none.`);
      if (task.write_scopes.some(scope => typeof scope === "string" && (scope.startsWith("/") || scope.split("/").includes("..")))) errors.push(`${name}: use repository-relative write scopes.`);
    }
    if (task.provider !== undefined && (!text(task.provider) || !/^[A-Za-z0-9_.-]+$/.test(String(task.provider)))) errors.push(`${name}: provider must be a configured native provider ID.`);
    if (task.model !== undefined && (!text(task.model) || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(String(task.model)))) errors.push(`${name}: model must be a valid model ID.`);
    if (task.provider !== undefined && !text(task.model)) errors.push(`${name}: choosing a provider requires an explicit model.`);
    if ((typeof task.provider === "string" && /^(claude|agy|antigravity)$/i.test(task.provider)) || (typeof task.model === "string" && /^(claude|agy|antigravity)\//i.test(task.model))) errors.push(`${name}: choose a native provider and model.`);
    if (task.environment_id !== undefined && !text(task.environment_id)) errors.push(`${name}: environment must be nonempty if supplied.`);
  }
  if (errors.length) return errors;
  const tasks = value.tasks as Task[];
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    if (new Set(task.depends_on).size !== task.depends_on.length) errors.push(`${task.id}: duplicate dependencies.`);
    if (task.depends_on.some(id => !ids.has(id))) errors.push(`${task.id}: a dependency is missing.`);
    if (writing(task.kind) && !tasks.some(next => next.kind === "verify" && next.environment_id === task.environment_id && next.depends_on.includes(task.id))) errors.push(`${task.id}: add a directly dependent verify task in the same environment.`);
  }
  const seen = new Set<string>(), visiting = new Set<string>();
  function cycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (seen.has(id) || !byId.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)!.depends_on.some(cycle)) return true;
    visiting.delete(id); seen.add(id); return false;
  }
  if (tasks.some(task => cycle(task.id))) errors.push("Dependencies contain a cycle.");
  return errors;
}

function cleanDraft(draft: Draft): Draft {
  return { name: draft.name, max_concurrency: draft.max_concurrency,
    ...(draft.max_runtime_seconds !== undefined ? { max_runtime_seconds: draft.max_runtime_seconds } : {}),
    tasks: draft.tasks.map(task => ({ id: task.id, title: task.title, instruction: task.instruction, kind: task.kind,
      depends_on: [...task.depends_on], write_scopes: [...task.write_scopes], acceptance_criteria: [...task.acceptance_criteria],
      ...(task.environment_id ? { environment_id: task.environment_id } : {}), ...(task.provider ? { provider: task.provider } : {}), ...(task.model ? { model: task.model } : {}) })) };
}

type WorkflowAck = { graphId: string; threadId: string; turnId: string };
type SubmittedRun = { graphId: string; threadId: string; snapshot: string };
type NewTarget = { cwd?: string; provider?: string; model?: string };
type WorkflowRuntime = {
  visible: boolean; connected: boolean; target: Thread | null; targetIsChild: boolean; activeTurnId?: string;
  models: Model[]; providerSettings: ProviderSettings | null; defaultCwd: string; defaultModel: string; defaultProvider: string;
  onCreateTarget: (options: NewTarget) => Promise<Thread>;
  onResumeTarget: () => Promise<void>;
  onStarted: (ack: WorkflowAck) => void;
  onStop: (ack: WorkflowAck) => Promise<void>;
  onOpenThread: (id: string) => void; onConfigure?: () => void;
};

export function WorkflowEditor({runtime}:{runtime?:WorkflowRuntime}) {
  const [draft, setDraft] = useState<Draft>({ name: "", max_concurrency: 2, tasks: [] });
  const [revision, setRevision] = useState(0);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [selected, select] = useState<string | null>(null);
  const [feedback, report] = useState("");
  const [saving, setSaving] = useState(false);
  const [importText, setImport] = useState("");
  const [drag, setDrag] = useState<{ id: string; start: Point; position: Point } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [runToolbar, setRunToolbar] = useState<HTMLDivElement | null>(null);
  const [latestRun, setLatestRun] = useState<RecordedRun | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedRun | null>(null);
  // A name and matching task IDs identify history, not the instructions that ran.
  const ownRun = submitted !== null && latestRun !== null && submitted.graphId === latestRun.id && submitted.threadId === runtime?.target?.id;
  const comparison = !ownRun ? "unknown" : submitted.snapshot === JSON.stringify(cleanDraft(draft)) ? "matched" : "changed";
  const statuses = Object.fromEntries(comparison === "matched" ? latestRun?.tasks.map(task => [task.id, task.status]) ?? [] : []);
  const canvas = useRef<HTMLDivElement>(null);
  const task = draft.tasks.find(item => item.id === selected);
  const errors = validateWorkflow(draft);
  const nativeChoices = workflowProviderChoices(runtime?.models || [], runtime?.providerSettings || null);
  const inheritedProvider = runtime?.target?.modelProvider || runtime?.defaultProvider || runtime?.providerSettings?.main.provider || "";
  const inheritedModel = runtime?.target?.model || runtime?.defaultModel || runtime?.providerSettings?.main.model;
  const taskChoice = task ? workflowModelChoice(nativeChoices, task.provider || inheritedProvider, runtime?.providerSettings?.providers) : null;
  const position = (id: string): Point => positions[id] || { x: 60 + (Math.max(0, draft.tasks.findIndex(t => t.id === id)) % 3) * NODE_GAP, y: 60 + Math.floor(Math.max(0, draft.tasks.findIndex(t => t.id === id)) / 3) * ROW_GAP };
  const at = (id: string): Point => { const p = position(id); return { x: p.x + ORIGIN_X, y: p.y }; };
  function update(patch: Partial<Task>) {
    setDraft(value => ({ ...value, tasks: value.tasks.map(item => item.id === selected ? { ...item, ...patch } : item) }));
  }
  function addTask() {
    let number = draft.tasks.length + 1;
    while (draft.tasks.some(item => item.id === `task_${number}`)) number++;
    const id = `task_${number}`;
    setDraft(value => ({ ...value, tasks: [...value.tasks, { id, title: "", instruction: "", kind: "explore", depends_on: [], write_scopes: [], acceptance_criteria: [] }] }));
    select(id); report("");
  }
  function load(value: unknown) {
    const problems = validateWorkflow(value);
    if (problems.length) throw new Error(problems.join(" "));
    const next = cleanDraft(value as Draft);
    setConnectFrom(null); setDraft(next); select(next.tasks[0]?.id || null); setPositions({}); setRevision(value => value + 1);
  }
  function savedDraft() {
    // Preserve a draft from the current web origin when upgrading to native storage.
    return appStorage().getItem(STORAGE) ?? (window.elpisDesktop ? window.localStorage.getItem(STORAGE) : null);
  }
  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const value = JSON.stringify({ version: 1, draft, positions });
      if (window.elpisDesktop?.storage?.saveItem) await window.elpisDesktop.storage.saveItem(STORAGE, value);
      else appStorage().setItem(STORAGE, value);
      report(`Saved in this ${window.elpisDesktop ? "desktop" : "browser"}. Export a copy to use it elsewhere.`);
    } catch (error) { report(`Could not save: ${String(error)}`); }
    finally { setSaving(false); }
  }
  useEffect(() => {
    try { if (savedDraft()) reload(); }
    catch { report("Saved drafts are unavailable."); }
  }, []);
  function reload() {
    try {
      const raw = savedDraft();
      if (!raw) throw new Error("No saved draft.");
      const saved = JSON.parse(raw);
      // Incomplete drafts are intentionally saveable; imports/exports require full validation.
      if (!object(saved) || saved.version !== 1 || !object(saved.draft) || !Array.isArray(saved.draft.tasks)) throw new Error("The saved draft is invalid.");
      const candidate = saved.draft as unknown as Draft;
      if (typeof candidate.name !== "string" || !Number.isInteger(candidate.max_concurrency) || candidate.tasks.some(item => !object(item) || !text(item.id) || !kinds.includes(item.kind) || ![item.depends_on, item.write_scopes, item.acceptance_criteria].every(a => Array.isArray(a) && a.every(v => typeof v === "string")) || typeof item.title !== "string" || typeof item.instruction !== "string" || (item.provider !== undefined && typeof item.provider !== "string") || (item.model !== undefined && typeof item.model !== "string"))) throw new Error("The saved tasks are invalid.");
      const safe: Record<string, Point> = {};
      if (object(saved.positions)) for (const item of candidate.tasks) {
        const p = saved.positions[item.id];
        if (object(p) && typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) safe[item.id] = { x: Math.max(0, Math.min(4000, p.x)), y: Math.max(0, Math.min(4000, p.y)) };
      }
      setConnectFrom(null); setDraft(cleanDraft(candidate)); setRevision(value => value + 1); setPositions(safe); select(candidate.tasks[0]?.id || null); report("Saved draft restored.");
    } catch (error) { report(`Could not restore: ${String(error)}`); }
  }
  function exportDraft() {
    if (errors.length) { report(errors.join(" ")); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(cleanDraft(draft), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "elpis-workflow.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); report("Workflow exported. No agents were started.");
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!drag || drag.id !== event.currentTarget.dataset.task) return;
    setPositions(value => ({ ...value, [drag.id]: { x: Math.max(0, Math.min(4000, drag.position.x + (event.clientX - drag.start.x) / zoom)), y: Math.max(0, Math.min(4000, drag.position.y + (event.clientY - drag.start.y) / zoom)) } }));
  }
  function connect(to: string) {
    if (!connectFrom || connectFrom === to) return;
    const next = { ...draft, tasks: draft.tasks.map(item => item.id === to ? { ...item, depends_on: item.depends_on.includes(connectFrom) ? item.depends_on.filter(id => id !== connectFrom) : [...item.depends_on, connectFrom] } : item) };
    if (validateWorkflow(next).includes("Dependencies contain a cycle.")) { report("This connection would create a cycle. Choose a different task."); return; }
    setDraft(next); setConnectFrom(null); report("Dependency updated. Save the draft to keep this connection.");
  }
  function disconnect(from: string, to: string) {
    setDraft(prev => ({ ...prev, tasks: prev.tasks.map(task => task.id === to ? { ...task, depends_on: task.depends_on.filter(id => id !== from) } : task) }));
    report("Connection removed. Save the draft to keep the change.");
  }
  function arrange() {
    const levels = new Map<string, number>();
    function level(id: string, visiting = new Set<string>()): number {
      if (levels.has(id)) return levels.get(id)!;
      if (visiting.has(id)) return 0;
      const deps = draft.tasks.find(item => item.id === id)?.depends_on ?? [];
      const result = deps.length ? 1 + Math.max(...deps.map(dep => level(dep, new Set(visiting).add(id)))) : 0;
      levels.set(id, result); return result;
    }
    const rows = new Map<number, number>();
    setPositions(Object.fromEntries(draft.tasks.map(item => { const column = level(item.id), row = rows.get(column) ?? 0; rows.set(column, row + 1); return [item.id, { x: 60 + column * NODE_GAP, y: 60 + row * ROW_GAP }]; })));
  }
  function addTaskAfter(from: string) {
    let number = draft.tasks.length + 1;
    while (draft.tasks.some(item => item.id === `task_${number}`)) number++;
    const id = `task_${number}`, origin = position(from);
    setDraft(value => ({ ...value, tasks: [...value.tasks, { id, title: "", instruction: "", kind: "explore", depends_on: [from], write_scopes: [], acceptance_criteria: [] }] }));
    setPositions(value => ({ ...value, [id]: { x: Math.min(4000, origin.x + NODE_GAP), y: origin.y } }));
    select(id); report("");
  }
  // Ctrl+wheel zooms like n8n; a plain wheel scrolls; dragging empty canvas pans.
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const onWheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(value => Math.max(.5, Math.min(1.5, Math.round((value - Math.sign(event.deltaY) * .1) * 10) / 10))); };
    element.addEventListener("wheel", onWheel, { passive: false }); return () => element.removeEventListener("wheel", onWheel);
  }, []);
  const [pan, setPan] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const width = Math.max(1100, ...draft.tasks.map(t => at(t.id).x + NODE_WIDTH + 160));
  const height = Math.max(560, ...draft.tasks.map(t => at(t.id).y + NODE_HEIGHT + 140));
  const starters = draft.tasks.filter(item => !item.depends_on.some(id => draft.tasks.some(t => t.id === id)));
  const startY = starters.length ? Math.round(starters.reduce((sum, item) => sum + at(item.id).y, 0) / starters.length) : 60;
  const curve = (ax: number, ay: number, bx: number, by: number) => { const bend = Math.max(50, Math.abs(bx - ax) / 2); return `M${ax + 8},${ay} C${ax + bend},${ay} ${bx - bend},${by} ${bx - 9},${by}`; };
  const followed = new Set(draft.tasks.flatMap(item => item.depends_on));
  return <section className="workflow-studio" aria-label="Workflow editor">
    {runtime&&<p className="workflow-note" role="status">{runtime.target&&subscriptionOf(runtime.target.model)?"Workflows currently run on native-provider conversations. Choose or create one to run this graph.":"Workflow tasks use configured native providers. Claude and Gemini subscriptions are available in regular chats."}</p>}
    <header className="workflow-topbar">
      <Input aria-label="Workflow name" className="workflow-name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Untitled workflow" />
      <div className="workflow-topbar-actions"><Button variant="ghost" size="sm" disabled={saving} onClick={save}><Save />{saving ? "Saving…" : "Save draft"}</Button><Button variant="ghost" size="sm" disabled={saving} onClick={reload}><RotateCcw />Restore</Button><Button variant="ghost" size="sm" onClick={exportDraft}><Download />Export</Button></div>
      <div ref={setRunToolbar} className="workflow-run-toolbar-slot"/>
    </header>
    <div className="workflow-stage">
      <div ref={canvas} className={`workflow-canvas${pan ? " panning" : ""}`} style={{ backgroundSize: `${20 * zoom}px ${20 * zoom}px` }}
        onPointerDown={e => { if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.canvasBackground) return; setPan({ x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { if (!pan) return; e.currentTarget.scrollLeft = pan.left - (e.clientX - pan.x); e.currentTarget.scrollTop = pan.top - (e.clientY - pan.y); }}
        onPointerUp={() => setPan(null)} onPointerCancel={() => setPan(null)}>
        <div data-canvas-background="1" style={{ width: width * zoom, height: height * zoom }}>
        <div data-canvas-background="1" className="relative origin-top-left" style={{ width, height, transform: `scale(${zoom})` }} aria-label="Task dependency canvas">
          <svg className="workflow-edges pointer-events-none absolute inset-0" width={width} height={height} aria-label="Workflow dependencies"><defs><marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="currentColor" /></marker></defs>{starters.map(item => { const b = at(item.id); return <path key={`start:${item.id}`} className="workflow-start-edge" d={curve(40 + NODE_WIDTH, startY + NODE_HEIGHT / 2, b.x, b.y + NODE_HEIGHT / 2)} stroke="currentColor" strokeWidth="2" fill="none" markerEnd="url(#workflow-arrow)" />; })}{draft.tasks.flatMap(next => next.depends_on.filter(id => draft.tasks.some(t => t.id === id)).map(id => { const a = at(id), b = at(next.id); const ax = a.x + NODE_WIDTH, ay = a.y + NODE_HEIGHT / 2, by = b.y + NODE_HEIGHT / 2; const path = curve(ax, ay, b.x, by);
            const label = `Remove connection from ${draft.tasks.find(task => task.id === id)?.title || id} to ${next.title || next.id}`;
            return <g key={`${id}:${next.id}`} className={`workflow-edge${statuses[id] === "succeeded" ? " done" : ""}`}><path data-from={id} data-to={next.id} d={path} stroke="currentColor" strokeWidth="2" fill="none" markerEnd="url(#workflow-arrow)" /><path className="workflow-edge-hit" d={path} stroke="transparent" strokeWidth="18" fill="none" style={{ pointerEvents: "stroke" }} /><foreignObject x={(ax + b.x) / 2 - 12} y={(ay + by) / 2 - 12} width="24" height="24"><button type="button" className="workflow-edge-delete" aria-label={label} title={label} onClick={() => disconnect(id,next.id)}><X size={12}/></button></foreignObject></g>; }))}</svg>
          {draft.tasks.length > 0 && <div className="workflow-trigger" style={{ left: 40, top: startY, width: NODE_WIDTH, height: NODE_HEIGHT }} title="Starts every task without a dependency when you run the workflow"><Zap size={30} /><span className="workflow-node-label"><span className="workflow-node-title">Run workflow</span><span className="workflow-node-meta">Starts {starters.length} {starters.length === 1 ? "task" : "tasks"}</span></span></div>}
          {draft.tasks.map(item => { const m = position(item.id), p = at(item.id), Icon = ROLE_ICON[item.kind], status = statuses[item.id]; return <div key={item.id}>
            <button data-task={item.id} aria-label={`Edit ${item.title || item.id}`} aria-pressed={selected === item.id} className={`workflow-node role-${item.kind}${selected === item.id ? " selected" : ""}${status ? ` status-${status}` : ""}`} style={{ left: p.x, top: p.y, width: NODE_WIDTH, height: NODE_HEIGHT }} onClick={() => select(item.id)} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); select(item.id); setDrag({ id: item.id, start: { x: e.clientX, y: e.clientY }, position: m }); }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onKeyDown={e => { if (e.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); setPositions({ ...positions, [item.id]: { x: Math.max(0, Math.min(4000, m.x + (e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0))), y: Math.max(0, Math.min(4000, m.y + (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0))) } }); } }}>
              <span className="workflow-node-icon"><Icon size={30} strokeWidth={1.75} /></span>
              <span className="workflow-node-label"><span className="workflow-node-title">{item.title || item.id}</span><span className="workflow-node-meta">{item.kind} · {item.depends_on.length ? `${item.depends_on.length} ${item.depends_on.length === 1 ? "dependency" : "dependencies"}` : "Starts when run"}</span>{(item.provider || item.model) && <span className="workflow-node-meta" title={`${item.provider ? providerLabel(null,item.provider,runtime?.providerSettings?.providers) : "Conversation provider"} · ${item.model || "Conversation model"}`}>{item.provider ? providerLabel(null,item.provider,runtime?.providerSettings?.providers) : "Conversation provider"} · {item.model || "Conversation model"}</span>}</span>
              {status && <span className="workflow-node-status" title={`Last recorded run: ${status}`}>{STATUS_ICON[status] ?? <CircleDot size={14} />}</span>}
            </button>
            <button className={`workflow-handle input${connectFrom && connectFrom !== item.id ? " armed" : ""}`} style={{ left: p.x - 6, top: p.y + NODE_HEIGHT / 2 - 10 }} aria-label={`Connect input: ${item.title || item.id}`} title="Connect a preceding task" disabled={!connectFrom || connectFrom === item.id} onClick={() => connect(item.id)} />
            <button className={`workflow-handle output${connectFrom === item.id ? " active" : ""}`} style={{ left: p.x + NODE_WIDTH - 7, top: p.y + NODE_HEIGHT / 2 - 7 }} aria-label={`Connect output: ${item.title || item.id}`} aria-pressed={connectFrom === item.id} title="Choose the next task" onClick={() => setConnectFrom(connectFrom === item.id ? null : item.id)} />
            {!followed.has(item.id) && !connectFrom && <button className="workflow-add-next" style={{ left: p.x + NODE_WIDTH + 44, top: p.y + NODE_HEIGHT / 2 - 13 }} aria-label={`Add task after ${item.title || item.id}`} title="Add the next task" onClick={() => addTaskAfter(item.id)}><Plus size={16} /></button>}
          </div>; })}
          {!draft.tasks.length && <button data-canvas-background="0" className="workflow-first-task" onClick={addTask}><span><Plus size={28} /></span>Add your first task to start a workflow.</button>}
        </div></div>
      </div>
      <div className="workflow-float top-right"><Button onClick={addTask}><Plus />Add task</Button></div>
      <div className="workflow-float bottom-left" aria-label="Canvas controls">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, Math.round((value - .1) * 10) / 10))}><Minus /></Button>
        <span className="w-10 text-center text-xs tabular-nums" aria-label="Canvas zoom">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, Math.round((value + .1) * 10) / 10))}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Fit workflow" disabled={!draft.tasks.length} onClick={() => { setZoom(Math.max(.5, Math.min(1, (canvas.current?.clientWidth ?? width) / width))); if (canvas.current) { canvas.current.scrollLeft = 0; canvas.current.scrollTop = 0; } }}><Maximize /></Button>
        <Button variant="ghost" size="sm" disabled={!draft.tasks.length} onClick={arrange}><LayoutGrid />Arrange</Button>
      </div>
      {connectFrom && <div role="status" className="workflow-float top-center workflow-connecting"><span>Connect {draft.tasks.find(item => item.id === connectFrom)?.title || connectFrom} to another task's input. Repeat a connection to remove it.</span><Button size="sm" variant="ghost" onClick={() => setConnectFrom(null)}>Cancel connection</Button></div>}
      {feedback && <p role="status" className="workflow-float bottom-center workflow-toast">{feedback}</p>}
      {task && <aside className="workflow-settings" aria-label="Task settings">
        <div className="flex items-center justify-between"><h2 className="font-medium">Task settings</h2><div className="flex items-center gap-1"><Button variant="ghost" size="icon-sm" aria-label="Delete task" onClick={() => { setConnectFrom(null); setDraft({ ...draft, tasks: draft.tasks.filter(t => t.id !== task.id).map(t => ({ ...t, depends_on: t.depends_on.filter(id => id !== task.id) })) }); select(null); }}><Trash2 /></Button><Button variant="ghost" size="icon-sm" aria-label="Close task settings" onClick={() => select(null)}><X /></Button></div></div>
        <details className="text-xs text-muted-foreground"><summary>Task details</summary><p className="mt-2">{task.id}</p></details>
        {runtime && latestRun?.tasks.find(record => record.id === task.id) && <WorkflowTaskOutput run={latestRun} task={latestRun.tasks.find(record => record.id === task.id)!} comparison={comparison} onOpenThread={runtime.onOpenThread} />}
        <label className="block space-y-2 text-sm">Title<Input aria-label="Task title" value={task.title} onChange={e => update({ title: e.target.value })} /></label>
        <label className="block space-y-2 text-sm">Role<OptionSelect aria-label="Task role" className="h-9 w-full rounded-lg border bg-background px-3" value={task.kind} onChange={e => update({ kind: e.target.value as Kind, ...(!writing(e.target.value as Kind) ? { write_scopes: [] } : {}) })}>{kinds.map(kind => <option key={kind}>{kind}</option>)}</OptionSelect></label>
        <label className="block space-y-2 text-sm">Provider<OptionSelect aria-label="Task provider" className="h-9 w-full rounded-lg border bg-background px-3" value={task.provider || ""} onChange={e => update({ provider: e.target.value || undefined, model: undefined })}><option value="">Inherit conversation provider</option>{nativeChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}{task.provider && !nativeChoices.some(choice => choice.id === task.provider) && <option value={task.provider}>{providerLabel(null,task.provider,runtime?.providerSettings?.providers)} (not configured)</option>}</OptionSelect></label>
        {taskChoice && <div className="block space-y-2 text-sm" role="group" aria-label="Task model"><span>Model</span><WorkflowModelChoice choice={taskChoice} model={task.model || ""}
          defaultModel={!task.provider && !subscriptionOf(inheritedModel) ? inheritedModel : null} defaultLabel={!task.provider ? "Use conversation model" : undefined}
          disabled={!runtime?.connected} onConfigure={runtime?.onConfigure} onChange={model => update({ model: model || undefined })} />
          <p className="text-xs text-muted-foreground">{task.provider ? "Choose a model from this connection." : task.model ? "Overrides the conversation model for this task." : "Uses the conversation model."}</p></div>}
        <label className="block space-y-2 text-sm">Instructions<Textarea aria-label="Task instructions" value={task.instruction} onChange={e => update({ instruction: e.target.value })} rows={4} /></label>
        <label className="block space-y-2 text-sm">Acceptance criteria<Textarea aria-label="Acceptance criteria" key={`${task.id}-${revision}-criteria`} defaultValue={task.acceptance_criteria.join("\n")} onChange={e => update({ acceptance_criteria: lines(e.target.value) })} rows={3} placeholder="One criterion per line" /></label>
        {writing(task.kind) && <label className="block space-y-2 text-sm">Write scopes<Textarea aria-label="Write scopes" key={`${task.id}-${revision}-scopes`} defaultValue={task.write_scopes.join("\n")} onChange={e => update({ write_scopes: lines(e.target.value) })} placeholder="Repository directories, one per line" /></label>}
        <label className="block space-y-2 text-sm">Environment<Input aria-label="Task environment" value={task.environment_id || ""} onChange={e => update({ environment_id: e.target.value || undefined })} placeholder="Primary workspace" /></label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Depends on</legend>{draft.tasks.filter(t => t.id !== task.id).map(t => <label key={t.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={task.depends_on.includes(t.id)} onChange={e => update({ depends_on: e.target.checked ? [...task.depends_on, t.id] : task.depends_on.filter(id => id !== t.id) })} />{t.title || t.id}</label>)}{draft.tasks.length < 2 && <p className="text-xs text-muted-foreground">Add another task to connect dependencies.</p>}</fieldset>
      </aside>}
    </div>
    <div className="workflow-lower">
      <div className="workflow-limits"><label className="space-y-2 text-sm">Parallel tasks<Input aria-label="Parallel tasks" type="number" min={1} max={32} value={draft.max_concurrency} onChange={e => setDraft({ ...draft, max_concurrency: Number(e.target.value) })} /></label><label className="space-y-2 text-sm">Task timeout (seconds)<Input aria-label="Task timeout (seconds)" type="number" min={1} placeholder="Runtime default" value={draft.max_runtime_seconds ?? ""} onChange={e => setDraft({ ...draft, max_runtime_seconds: e.target.value ? Number(e.target.value) : undefined })} /></label></div>
      {draft.tasks.length > 0 && errors.length > 0 && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{errors.length} things to complete before export or run</summary><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{errors.map(error => <li key={error}>{error}</li>)}</ul></details>}
      {runtime&&<WorkflowExecution draft={draft} runtime={runtime} toolbar={runToolbar} onRun={setLatestRun} onSubmitted={setSubmitted}/>}
      <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Import a workflow</summary><div className="mt-4 space-y-3"><Textarea aria-label="Workflow JSON" value={importText} onChange={e => setImport(e.target.value)} rows={5} placeholder="Paste exported workflow JSON" /><Button variant="outline" onClick={() => { try { load(JSON.parse(importText)); report("Workflow imported. No agents were started."); } catch (error) { report(`Import rejected: ${String(error)}`); } }}>Import</Button></div></details>
      <p className="text-xs text-muted-foreground">Drafts stay on this device. Export for a portable copy. Recorded runs are stored by Elpis separately from this draft.</p>
    </div>
  </section>;
}

type RecordedTask = { id: string; title: string; kind: string; status: string; assignedThreadId?: string | null; provider?: string | null; model?: string | null; failureReason?: string | null; result?: unknown; evidence?: string[] };
type RecordedRun = { id: string; name: string; status: string; maxConcurrency: number; error?: string | null; eventCount: number; tasks: RecordedTask[] };
function WorkflowTaskOutput({ run, task, comparison, onOpenThread }: { run: RecordedRun; task: RecordedTask; comparison: "matched" | "changed" | "unknown"; onOpenThread: (id: string) => void }) {
  const summary = typeof task.result === "string" ? task.result : object(task.result) && typeof task.result.summary === "string" ? task.result.summary : null;
  return <section className="workflow-task-output" aria-label="Recorded task output">
    <h3 className="text-sm font-medium">Last recorded output</h3>
    {comparison !== "matched" && <p role="status" className="text-xs text-muted-foreground">{comparison === "changed" ? "Draft changed since this run. The recorded output does not include these edits." : "Recorded output; the current draft has not been checked against this run."}</p>}
    <p className="text-xs text-muted-foreground">{run.name} · {task.status}</p>
    {(task.provider || task.model) && <p className="text-xs text-muted-foreground break-words">{[task.provider, task.model].filter(Boolean).join(" · ")}</p>}
    {task.failureReason && <p className="text-sm text-destructive">{task.failureReason}</p>}
    {summary ? <MarkdownText text={summary} /> : task.result == null ? <p className="text-xs text-muted-foreground">No result recorded yet.</p> : null}
    {task.result != null && typeof task.result !== "string" && <details><summary className="text-xs cursor-pointer">Full result</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(task.result, null, 2)}</pre></details>}
    {!!task.evidence?.length && <div><h4 className="text-xs font-medium">Evidence</h4><ul className="list-disc pl-4 text-xs space-y-1">{task.evidence.map((item, index) => <li className="break-words" key={index}>{item}</li>)}</ul></div>}
    {task.assignedThreadId && <Button size="sm" variant="outline" onClick={() => onOpenThread(task.assignedThreadId!)}>Open worker chat</Button>}
    <p className="text-xs text-muted-foreground">Recorded separately from this draft. Editing a task does not run it.</p>
  </section>;
}
function WorkflowExecution({draft,runtime,toolbar,onRun,onSubmitted}:{draft:Draft;runtime:WorkflowRuntime;toolbar:HTMLDivElement|null;onRun:(run:RecordedRun|null)=>void;onSubmitted:(run:SubmittedRun)=>void}) {
  const {target}=runtime;
  const [records,setRecords]=useState<{threadId:string;data:RecordedRun[];error:string}>({threadId:'',data:[],error:''});
  const [refresh,setRefresh]=useState(0);
  const [pending,setPending]=useState<'run'|'create'|'resume'|'stop'|null>(null);
  const [notice,setNotice]=useState<{threadId:string;message:string;error:boolean}|null>(null);
  const [ack,setAck]=useState<WorkflowAck|null>(null);
  const [showCreate,setShowCreate]=useState(false);
  const [newCwd,setNewCwd]=useState(runtime.defaultCwd);
  const [newProvider,setNewProvider]=useState(runtime.providerSettings?.managed?.modelProvider||runtime.defaultProvider||runtime.providerSettings?.main.provider||'');
  const [newModel,setNewModel]=useState(subscriptionOf(runtime.defaultModel) ? "" : runtime.defaultModel);
  const inFlight=useRef(false),alive=useRef(true),targetId=useRef(target?.id);
  targetId.current=target?.id;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!runtime.visible||!target?.id)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;const id=target.id;
    async function poll(){
      if(document.visibilityState!=='visible'){timer=setTimeout(poll,3000);return;}
      try{const result=await api<{data:RecordedRun[]}>(`/workflows?threadId=${encodeURIComponent(id)}`);if(!disposed)setRecords({threadId:id,data:result.data,error:''});}
      catch(error){if(!disposed)setRecords(old=>({threadId:id,data:old.threadId===id?old.data:[],error:String(error)}));}
      finally{if(!disposed)timer=setTimeout(poll,3000);}
    }
    void poll();return()=>{disposed=true;clearTimeout(timer);};
  },[runtime.visible,target?.id,refresh]);
  const currentRecords=records.threadId===target?.id?records:null;
  const currentNotice=notice?.threadId===(target?.id??'')?notice:null;
  // Nodes show the latest recorded run of this same set of tasks.
  const draftIds=draft.tasks.map(task=>task.id).sort().join(',');
  const latest=currentRecords?.data.find(run=>run.name===draft.name&&run.tasks.map(task=>task.id).sort().join(',')===draftIds);
  useEffect(()=>{onRun(latest??null);},[latest,onRun]);
  const targetSupported = !subscriptionOf(target?.model);
  const nativeChoices = workflowProviderChoices(runtime.models, runtime.providerSettings);
  const targetActive=!!runtime.activeTurnId||target?.status?.type==='active';
  const valid=validateWorkflow(draft).length===0;
  const currentProvider=newProvider||runtime.providerSettings?.main.provider||'';
  const nativeDefault = !subscriptionOf(runtime.providerSettings?.main.model);
  const mainProvider=currentProvider===(runtime.providerSettings?.main.provider??'');
  const modelChoice=workflowModelChoice(nativeChoices,currentProvider,runtime.providerSettings?.providers);
  const canCreate=runtime.connected&&pending===null&&!subscriptionOf(newModel)&&((mainProvider&&nativeDefault)||!!newModel.trim());
  async function action(kind:'run'|'create'|'resume'|'stop') {
    if(inFlight.current)return;
    if(kind==='run'&&(!target||runtime.targetIsChild||!target.desktopAccess?.writable||!targetSupported||targetActive||!valid||!runtime.connected))return;
    inFlight.current=true;setPending(kind);const id=target?.id??'';setNotice(null);
    try{
      if(kind==='create'){
        const created=await runtime.onCreateTarget({...newCwd.trim()?{cwd:newCwd.trim()}:{},...currentProvider?{provider:currentProvider}:{},...newModel.trim()?{model:newModel.trim()}:{}});
        if(alive.current){setShowCreate(false);setNotice({threadId:created.id,message:'Conversation created. Review the target, then run the draft.',error:false});}
      }else if(kind==='resume'){
        await runtime.onResumeTarget();
      }else if(kind==='stop'){
        if(!ack||ack.threadId!==id||runtime.activeTurnId!==ack.turnId)return;
        await runtime.onStop(ack);
        if(alive.current&&targetId.current===id)setNotice({threadId:id,message:'Stop requested. Recorded task status will update from Elpis.',error:false});
      }else{
        const graph=cleanDraft(draft);
        const result=await api<WorkflowAck>('/workflows/run',{rootThreadId:id,name:graph.name,maxConcurrency:graph.max_concurrency,...graph.max_runtime_seconds!==undefined?{maxRuntimeSeconds:graph.max_runtime_seconds}:{},tasks:graph.tasks.map(task=>({id:task.id,title:task.title,instruction:task.instruction,kind:task.kind,dependsOn:task.depends_on,writeScopes:task.write_scopes,acceptanceCriteria:task.acceptance_criteria,...task.environment_id?{environmentId:task.environment_id}:{},...task.provider?{provider:task.provider}:{},...task.model?{model:task.model}:{}}))});
        runtime.onStarted(result);
        if(alive.current){onSubmitted({graphId:result.graphId,threadId:id,snapshot:JSON.stringify(graph)});setAck(result);setRefresh(value=>value+1);if(targetId.current===id)setNotice({threadId:id,message:'Run acknowledged by Elpis. The draft remains editable.',error:false});}
      }
    }catch(error){if(alive.current&&targetId.current===id)setNotice({threadId:id,message:`${String(error)}${kind==='run'&&String(error).includes('unknown native work graph provider')?' Check the provider ID. If it was added or changed after this conversation started, create a new workflow conversation.':''}${kind==='run'?' Refresh recorded runs before trying again.':''}`,error:true});}
    finally{inFlight.current=false;if(alive.current)setPending(null);}
  }
  const controls = <div className="workflow-run-toolbar"><div className="workflow-route-summary"><span>Run in</span><strong>{target ? title(target) : "Choose a conversation"}</strong><small>{target ? [providerLabel(target.model,target.modelProvider,runtime.providerSettings?.providers),modelLabel(target.model,runtime.models)].filter(Boolean).join(" · ") : "Native provider required"}</small></div><div className="workflow-run-actions"><Button data-workflow-run disabled={pending!==null||!runtime.connected||!target?.desktopAccess?.writable||runtime.targetIsChild||!targetSupported||targetActive||!valid} onClick={()=>void action('run')}>{pending==='run'?'Starting…':'Run workflow'}</Button>{ack&&ack.threadId===target?.id&&ack.turnId===runtime.activeTurnId&&<Button variant="outline" disabled={pending!==null||!runtime.connected} onClick={()=>void action('stop')}>Stop workflow</Button>}<Button variant="ghost" size="icon-sm" aria-label="Refresh runs" title="Refresh runs" disabled={!target||pending!==null} onClick={()=>setRefresh(value=>value+1)}><RotateCcw/></Button><Button variant="outline" size="sm" aria-label="Create workflow conversation" title="Create workflow conversation" onClick={()=>setShowCreate(value=>!value)} disabled={pending!==null}><Plus/>Conversation</Button></div></div>;
  return <>{toolbar ? createPortal(controls,toolbar) : controls}<section className="workflow-runtime feature-section" aria-label="Workflow execution">
    <details className="workflow-target-details" open={showCreate}><summary>Conversation and run settings</summary>
    {target?<><p className="mt-3 font-medium">{title(target)}</p><dl className="feature-values mt-3"><dt>Workspace</dt><dd>{target.cwd||'Not reported'}</dd><dt>Model</dt><dd>{[providerLabel(target.model,target.modelProvider,runtime.providerSettings?.providers),modelLabel(target.model,runtime.models)].filter(Boolean).join(' · ')||'Not reported'}</dd></dl>
      {runtime.targetIsChild?<p className="mt-3">This is a parent-controlled agent. Select a root conversation or create a dedicated workflow conversation.</p>:!targetSupported?null:!target.desktopAccess?.writable?<p className="mt-3">{target.desktopAccess?.reason||'Elpis does not let this app write to this conversation. Choose or create another one.'}</p>:targetActive?<p className="mt-3">This conversation has an active turn. Wait for it to finish or choose another target.</p>:<p className="mt-3 text-sm text-muted-foreground">The reviewed graph will run in this conversation&apos;s workspace. Tasks inherit its provider and model unless you choose task overrides.</p>}
    </>:<p className="mt-3">Select a conversation in the sidebar or create a dedicated conversation for this workflow.</p>}
    <p className="mt-3 text-sm text-muted-foreground">Existing workflow conversations keep their provider configuration and credentials. Create a new workflow conversation to use providers or keys added or changed later.</p>
    {showCreate&&<div className="workflow-target-form feature-form my-4 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-2 sm:col-span-2">Workflow workspace<Input value={newCwd} placeholder="Configured default workspace" onChange={event=>setNewCwd(event.target.value)} disabled={pending!==null}/></label>
      <label className="grid gap-2">Workflow provider<OptionSelect aria-label="Workflow provider" value={currentProvider} disabled={pending!==null||!!runtime.providerSettings?.managed?.modelProvider} onChange={event=>{setNewProvider(event.target.value);setNewModel('');}}>{nativeChoices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}{currentProvider&&!nativeChoices.some(choice=>choice.id===currentProvider)&&<option value={currentProvider}>{providerLabel(null,currentProvider,runtime.providerSettings?.providers)} (not configured)</option>}</OptionSelect></label>
      <div className="grid gap-2" role="group" aria-label="Workflow model"><span>Workflow model</span><WorkflowModelChoice choice={modelChoice} model={newModel}
        defaultModel={mainProvider&&nativeDefault?runtime.providerSettings?.main.model:null} defaultLabel={mainProvider&&nativeDefault?"Use default model":undefined}
        disabled={pending!==null||!runtime.connected} onConfigure={runtime.onConfigure} onChange={setNewModel}/></div>
      <div className="flex flex-wrap gap-2 sm:col-span-2"><Button disabled={!canCreate} onClick={()=>void action('create')}>{pending==='create'?'Creating…':'Create conversation'}</Button><Button variant="ghost" disabled={pending!==null} onClick={()=>setShowCreate(false)}>Cancel</Button></div>
    </div>}

    </details>
    {currentNotice&&<p role={currentNotice.error?'alert':'status'}>{currentNotice.message}</p>}
    <h3 className="mt-6 font-medium">Recorded runs</h3>
    {currentRecords?.error&&<p role="alert" className="mt-3">Could not refresh recorded runs: {currentRecords.error}</p>}
    {target&&!currentRecords&&<p role="status" className="mt-3">Loading recorded runs…</p>}
    {currentRecords&&!currentRecords.data.length&&!currentRecords.error&&<p className="mt-3 text-sm text-muted-foreground">No recorded runs for this conversation.</p>}
    {currentRecords?.data.map(run=><section key={run.id} className="workflow-run-record mt-4 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{run.name}</h4><span>{run.status}</span></div>{run.error&&<p role="alert">{run.error}</p>}<ul className="mt-3 grid gap-3">{run.tasks.map(task=><li key={task.id} className="flex flex-wrap items-center justify-between gap-2"><div><p>{task.title}</p><p className="text-xs text-muted-foreground">{task.kind} · {task.id}{task.provider ? ` · ${task.provider}` : ""}{task.model ? ` · ${task.model}` : ""}</p>{task.failureReason&&<p>{task.failureReason}</p>}</div><span>{task.status}</span>{task.assignedThreadId&&<Button variant="outline" size="sm" onClick={()=>runtime.onOpenThread(task.assignedThreadId!)}>Open chat</Button>}</li>)}</ul></section>)}
  </section></>;
}

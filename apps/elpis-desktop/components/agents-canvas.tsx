"use client";

import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, getBezierPath, useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type FinalConnectionState, type Node, type NodeChange, type NodeProps, type XYPosition } from "@xyflow/react";
import { Check, ChevronRight, ExternalLink, ListOrdered, Play, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { summarize, workedFor } from "@/components/transcript";
import { api, providerChoices, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { KINDS, MOTHER, TEMPLATES, arrange, commandParts, makesLoop, maxAgents, newAgents, newId, parseCommand, readGraph, runTasks, saveGraph, waves, withMother, type AgentData, type AgentKind, type CanvasEdge, type CanvasGraph, type CanvasNode, type CatalogModel, type Command, type NoteData, type TaskStatus } from "@/lib/canvas";

type Run = { rootThreadId: string; graphId: string; status: string };
type Listed = { data: { id: string; status: string; tasks: { id: string; status: TaskStatus; assignedThreadId: string | null }[] }[] };
type HandleEnd = "source" | "target";
type AgentNodeData = AgentData & { status?: TaskStatus; modelLabel?: string; wave?: number; onHandle?: (id: string, end: HandleEnd, event: ReactMouseEvent) => void };
type MotherData = { run: "idle" | "running" | "finished"; children: number; limit: number; onHandle?: AgentNodeData["onHandle"] };
const STATUS_LABEL: Record<TaskStatus | "idle", string> = { idle: "not run", pending: "waiting", running: "running", succeeded: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
const AGENT_KINDS = Object.keys(KINDS) as AgentKind[];
/** Fitting shows the whole graph, at most at full size. */
const FIT = { padding: 0.12, maxZoom: 1 };

/** An agent on the canvas: its role, run-order wave, name and state, with an input on the left (what it waits for) and
 * an output on the right (what waits for it), as Deus Ex's hacking screen links its nodes. Clicking a dot opens the
 * command bar to add agents on that side. */
function AgentNode({ id, data }: NodeProps<Node<AgentNodeData>>) {
  const status = data.status ?? "idle";
  return <div className="agent-node" data-kind={data.kind} data-status={status}>
    <Handle type="target" position={Position.Left} title="Add agents this one waits for" onClick={event => data.onHandle?.(id, "target", event)} />
    <span className="agent-node-kind">{KINDS[data.kind].label}{data.wave ? ` · wave ${data.wave}` : ""}</span>
    <strong className="agent-node-title">{data.title || "Untitled"}</strong>
    <small className="agent-node-meta">{data.modelLabel ?? "Default model"} · {STATUS_LABEL[status]}</small>
    <span className="agent-node-mark" aria-hidden="true">{status === "succeeded" ? <Check size={12} /> : status === "failed" || status === "blocked" ? <X size={12} /> : null}</span>
    <Handle type="source" position={Position.Right} title="Add agents that wait for this one" onClick={event => data.onHandle?.(id, "source", event)} />
  </div>;
}

/** The Mother: the run's chat. She starts the agents that wait for no one (her wires) and receives every report. */
function MotherNode({ id, data }: NodeProps<Node<MotherData>>) {
  return <div className="agent-node mother-node" data-kind="mother" data-status={data.run === "running" ? "running" : undefined}
    title="The Mother is the run's chat: every agent is her child, she starts the ones that wait for no one, and every report comes back to her.">
    <span className="agent-node-kind">Mother</span>
    <strong className="agent-node-title">This run&rsquo;s chat</strong>
    <small className="agent-node-meta">{data.children} of {data.limit} agents · {data.run === "idle" ? "not run" : data.run}</small>
    <Handle type="source" position={Position.Right} title="Add agents she starts" onClick={event => data.onHandle?.(id, "source", event)} />
  </div>;
}

/** A FigJam-style sticky note: free text on the canvas, never sent to Elpis. */
function NoteNode({ id, data }: NodeProps<Node<NoteData & { onText?: (id: string, text: string) => void }>>) {
  return <div className="canvas-note"><textarea aria-label="Note" className="nodrag" value={data.text} placeholder="Write a note" onChange={event => data.onText?.(id, event.target.value)} /></div>;
}
const NODE_TYPES = { agent: AgentNode, mother: MotherNode, note: NoteNode };

/** A wire with three chevrons pointing the way the work flows, as on Deus Ex: Mankind Divided's hacking screen. They
 * sit still until the agent at the end is running, then stream along the wire. Re-keyed on the path so they follow a
 * dragged node. */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<{ live?: boolean }>>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <>
    <BaseEdge id={id} path={path} />
    {[0.25, 0.5, 0.75].map((at, index) => <path key={`${at}${path}${data?.live}`} className="canvas-chevron" data-live={data?.live || undefined} d="M -3 -4.5 L 2 0 L -3 4.5">
      {data?.live
        ? <animateMotion path={path} rotate="auto" dur="1.8s" begin={`${-index * 0.6}s`} repeatCount="indefinite" />
        : <animateMotion path={path} rotate="auto" dur="0.001s" fill="freeze" keyPoints={`${at};${at}`} keyTimes="0;1" calcMode="linear" />}
    </path>)}
  </>;
}
const EDGE_TYPES = { flow: FlowEdge };

/** Where the command bar drops its agents, and the agent it was opened from (`as` is the end the new agents take) or
 * the wire they are inserted on. */
type Adding = { at: XYPosition; left: number; top: number; height: number; from?: { id: string; as: HandleEnd }; between?: CanvasEdge };
type WireMenuAt = { edge: CanvasEdge; client: XYPosition; left: number; top: number };
type Provider = { id: string | null; label: string; state: "ready" | "loading" | "key" | "error"; error?: string };
type Level = { name: "kinds" } | { name: "providers" } | { name: "models"; provider: string | null } | { name: "efforts"; model: CatalogModel };
type Row = { key: string; label: string; hint?: string; kind?: AgentKind | "note"; more?: boolean; take: () => void; open?: () => void };
const providerToken = (model: CatalogModel) => `${model.provider ? `@${model.provider} ` : ""}${model.model}`;

/** The command bar, AutoCAD-style and keyboard first, as Houdini's and Nuke's Tab menu, Blender's Shift+A and
 * ComfyUI's search box. Type `3 implement sol high: fix the parser; fix the lexer` and Enter, or browse: the list offers
 * what the command still lacks (kind, then provider → model, then thinking level); ↑↓ choose, → opens a provider or a
 * model's thinking levels, ← goes back, Tab or Enter takes the choice. Without typed tasks, Enter asks for them. */
function CommandBar({ adding, room, limit, catalog, providers, onAgents, onNote, onClose }: { adding: Adding; room: number; limit: number; catalog: CatalogModel[]; providers: Provider[]; onAgents: (command: Command & { kind: AgentKind }) => void; onNote: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState(""), [active, setActive] = useState(0), [level, setLevel] = useState<Level | null>(null);
  const [asking, setAsking] = useState<(Command & { kind: AgentKind }) | null>(null), [tasks, setTasks] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const command = parseCommand(text, catalog), { head, rest } = commandParts(text);
  const lastWord = head.split(/\s+/).at(-1) ?? "";
  // A choice goes into the command's first part, replacing a half-typed word it couldn't place; typed tasks stay.
  const put = (token: string) => {
    const words = head.trimEnd().split(/\s+/).filter(Boolean);
    if (words.length && command.unknown.includes(words.at(-1)!.toLowerCase())) words.pop();
    const next = [...words, token].join(" ");
    setText(rest ? `${next}${rest}` : `${next} `); setLevel(null); setActive(0); field.current?.focus();
  };
  const submit = (current: Command) => {
    if (current.kind === "note") { onNote(current.tasks.join("\n")); return; }
    const kind = current.kind;
    if (!kind) return;
    // As in the tasks step, more tasks than agents adds agents.
    if (current.tasks.length) onAgents({ ...current, kind, count: Math.max(current.count ?? 1, current.tasks.length) }); else { setAsking({ ...current, kind }); setTasks(""); }
  };
  const shown: Level = level ?? (!command.kind ? { name: "kinds" } : !command.model ? (providers.length === 1 ? { name: "models", provider: providers[0].id } : { name: "providers" }) : { name: "efforts", model: command.model });
  const modelRow = (model: CatalogModel): Row => ({ key: `${model.provider}:${model.model}`, label: model.label, hint: model.efforts.length ? `${model.model} · → thinking` : model.model, more: model.efforts.length > 0,
    take: () => put(providerToken(model)), open: model.efforts.length ? () => { put(providerToken(model)); setLevel({ name: "efforts", model }); } : undefined });
  const rows: Row[] = shown.name === "kinds"
    ? [...(room ? AGENT_KINDS : []).map(kind => ({ key: kind, label: KINDS[kind].label, hint: KINDS[kind].hint, kind, take: () => put(kind) })), { key: "note", label: "Note", hint: "A sticky note, never sent to Elpis", kind: "note" as const, take: () => put("note") }]
    : shown.name === "providers"
      ? [{ key: "default", label: "Default model", hint: "Whatever the run's chat uses", take: () => submit(command) },
        ...providers.map(provider => ({ key: provider.id ?? "main", label: provider.label, more: true, hint: provider.state === "key" ? "Needs an API key: add it in Settings" : provider.state === "loading" ? "Loading models…" : provider.state === "error" ? provider.error : `${catalog.filter(model => model.provider === provider.id).length} models · →`,
          take: () => setLevel({ name: "models", provider: provider.id }), open: () => setLevel({ name: "models", provider: provider.id }) }))]
      : shown.name === "models"
        ? [...(providers.length === 1 ? [{ key: "default", label: "Default model", hint: "Whatever the run's chat uses", take: () => submit(command) }] : []), ...catalog.filter(model => model.provider === shown.provider).map(modelRow)]
        : shown.model.efforts.map(effort => ({ key: effort, label: `${effort[0].toUpperCase()}${effort.slice(1)} thinking`, hint: effort === shown.model.defaultEffort ? "The model's default" : undefined, take: () => put(effort) }));
  const current = rows[Math.min(active, rows.length - 1)];
  const ready = Boolean(command.kind) && (!command.model || !command.model.efforts.length || Boolean(command.effort)) && !level;
  const back = () => { if (shown.name === "efforts") setLevel({ name: "models", provider: shown.model.provider }); else if (shown.name === "models" && providers.length > 1) setLevel({ name: "providers" }); else setLevel(null); setActive(0); };
  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const atEnd = event.currentTarget.selectionStart === text.length;
    // Shift+Enter starts the next task line, as in the tasks step.
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!level) setLevel(shown); setActive(index => (Math.min(index, rows.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length)); }
    else if (event.key === "ArrowRight" && atEnd && current?.open) { event.preventDefault(); setActive(0); current.open(); }
    else if (event.key === "ArrowLeft" && atEnd && level) { event.preventDefault(); back(); }
    else if (event.key === "Tab") { event.preventDefault(); current?.take(); }
    else if (event.key === "Enter") { event.preventDefault(); if (level || !ready) current?.take(); else submit(command); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  const close = (event: React.FocusEvent) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); };
  const count = Math.max(1, command.count ?? 1, command.tasks.length);

  if (asking) {
    // The tasks: line n is agent n's; lines past the count add agents, up to the limit.
    const typed = lines(tasks), total = Math.min(room, Math.max(asking.count ?? 1, typed.length)), given = Math.min(typed.length, total);
    return <div className="quick-add hud-menu nodrag nowheel" role="dialog" aria-label="Add agents" style={{ left: adding.left, top: adding.top, maxHeight: adding.height }} onBlur={close}>
      <p className="hud-menu-title quick-add-title"><span>Tasks for {total === 1 ? "the new agent" : `the ${total} new ${KINDS[asking.kind].label} agents`}</span><span>{asking.model?.label ?? "Default model"}</span></p>
      <textarea autoFocus className="quick-add-field quick-add-tasks" aria-label="Tasks, one per line" rows={Math.min(8, Math.max(3, total))} value={tasks}
        placeholder={Array.from({ length: Math.min(3, total) }, (_, index) => `Task for agent ${index + 1}`).join("\n")} onChange={event => setTasks(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onAgents({ ...asking, count: total, tasks: typed.slice(0, total) }); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          else if (event.key === "Backspace" && !tasks) { event.preventDefault(); setAsking(null); }
        }} />
      <p className="quick-add-note" role="status">{total} {total === 1 ? "agent" : "agents"}: {given === total ? "each with its task" : given ? `${given} with a task, ${total - given} still to write` : "tasks can be written later, before the run"}{typed.length > room ? `. Only ${room} fit under the limit of ${limit}.` : ""}</p>
      <p className="quick-add-help">One task per line · Shift+Enter new line · Enter add · Esc close · Backspace back</p>
    </div>;
  }
  return <div className="quick-add hud-menu nodrag nowheel" role="dialog" aria-label="Add agents" style={{ left: adding.left, top: adding.top, maxHeight: adding.height }} onBlur={close}>
    <p className="hud-menu-title quick-add-title"><span>{room ? "Add agents" : "No room for more agents"}</span><span>{room} of {limit} left</span></p>
    <textarea ref={field} autoFocus className="quick-add-field quick-add-command" aria-label="Command" value={text} spellCheck={false} placeholder="3 implement sol high: task; task"
      rows={Math.min(6, text.split("\n").length)} onChange={event => { setText(event.target.value); setActive(0); setLevel(null); }} onKeyDown={keys} />
    <p className="quick-add-plan" aria-label="Will add">
      {command.kind ? <><b>{command.kind === "note" ? "Note" : `${Math.min(count, room) || count} × ${KINDS[command.kind].label}`}</b>
        {command.kind !== "note" && <span>{command.model ? `${command.model.label} · ${command.model.providerLabel}` : "Default model"}</span>}
        {command.effort && <span>{command.effort} thinking</span>}
        {command.tasks.length > 0 && <span>{command.tasks.length} {command.tasks.length === 1 ? "task" : "tasks"}</span>}</> : <span>Type how many and the kind, or choose below</span>}
      {command.unknown.length > 0 && <em>Not understood: {command.unknown.join(", ")}</em>}
      {count > room && room > 0 && <em>Only {room} fit under the limit of {limit}</em>}
    </p>
    {shown.name !== "kinds" && <p className="quick-add-crumb">{shown.name === "providers" ? "Providers" : shown.name === "models" ? `Models · ${providers.find(provider => provider.id === shown.provider)?.label ?? ""}` : `Thinking · ${shown.model.label}`}{level && <span>← back</span>}</p>}
    <div role="listbox" aria-label={shown.name === "kinds" ? "Kinds" : shown.name === "providers" ? "Providers" : shown.name === "models" ? "Models" : "Thinking levels"} className="quick-add-list">
      {rows.map((row, index) => <button key={row.key} type="button" role="option" aria-selected={row === current} className="quick-add-option" data-kind={row.kind}
        onMouseEnter={() => setActive(index)} onClick={() => { setActive(index); (row.open ?? row.take)(); }}>
        {row.kind === "note" ? <StickyNote size={13} /> : row.kind ? <i className="canvas-kind" /> : null}
        <span className="select-option">{row.label}{row.hint && <small>{row.hint}</small>}</span>{row.more && <ChevronRight size={14} className="quick-add-more" />}
      </button>)}
      {!rows.length && <p className="quick-add-note">Nothing to choose here.</p>}
    </div>
    <p className="quick-add-help">{lastWord && command.unknown.includes(lastWord.toLowerCase()) ? "Tab takes the highlighted choice · " : ""}↑↓ · → open · ← back · Tab take · Shift+Enter task line · Enter {ready ? "add" : "take"} · Esc</p>
  </div>;
}

/** A wire's menu (a click on the wire), as ComfyUI's link menu: insert agents on it, where they take its place, or
 * remove it. The Mother's wires are implied by the graph, so they only take agents. */
function WireMenu({ menu, from, to, onInsert, onRemove, onClose }: { menu: WireMenuAt; from: string | null; to: string; onInsert: () => void; onRemove?: () => void; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const items = [{ label: "Insert agents here", hint: from ? `Between ${from} and ${to}` : `Before ${to}, started by the Mother`, take: onInsert },
    ...(onRemove ? [{ label: "Remove wire", hint: `${to} stops waiting for ${from}`, take: onRemove, key: "Delete" }] : [])];
  const move = (step: number) => {
    const buttons = [...(list.current?.querySelectorAll("button") ?? [])], at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  return <div className="quick-add hud-menu nodrag nowheel" role="menu" aria-label="Wire" style={{ left: menu.left, top: menu.top }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); }}
    onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if ((event.key === "Delete" || event.key === "Backspace") && onRemove) { event.preventDefault(); event.stopPropagation(); onRemove(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <p className="hud-menu-title quick-add-title"><span>Wire</span><span>{from ?? "Mother"} → {to}</span></p>
    <div ref={list} className="quick-add-list">{items.map((item, index) => <button key={item.label} type="button" role="menuitem" autoFocus={index === 0} className="quick-add-option" onClick={item.take}>
      <span className="select-option">{item.label}<small>{item.hint}</small></span>{"key" in item && <kbd>{item.key}</kbd>}</button>)}</div>
    <p className="quick-add-help">↑↓ · Enter take{onRemove ? " · Delete remove" : ""} · Esc</p>
  </div>;
}

/** A count the user types, kept within what Elpis allows: a valid number applies as it is typed; one out of range is
 * refused, saying why, and leaving the field puts the last good number back. */
function CountField({ label, value, min, max, why, onChange }: { label: string; value: number; min: number; max: number; why: (typed: number) => string; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value)), [error, setError] = useState("");
  useEffect(() => { setText(String(value)); }, [value]);
  const type = (next: string) => {
    setText(next);
    const typed = Number(next);
    if (next === "" || !Number.isInteger(typed) || typed < min || typed > max) { setError(next === "" ? "" : why(typed)); return; }
    setError(""); if (typed !== value) onChange(typed);
  };
  return <label className="canvas-chip canvas-count">{label}
    <input type="text" inputMode="numeric" aria-label={label} aria-invalid={Boolean(error)} value={text} size={3}
      onChange={event => type(event.target.value.replace(/\D/g, ""))} onBlur={() => { setText(String(value)); setError(""); }}
      onKeyDown={event => { if (event.key === "Escape") { setText(String(value)); setError(""); } }} />
    {error && <span className="canvas-count-error" role="alert">{error}</span>}
  </label>;
}

/** One agent's dashboard (Enter or double-click): what it is, what it waits for and feeds, and, once it runs, what it
 * has done so far from its own chat, refreshed while it works. */
function AgentDashboard({ node, wave, status, chat, waitsFor, feeds, modelLabel, onOpenChat, onClose }: { node: Extract<CanvasNode, { type: "agent" }>; wave?: number; status: TaskStatus | "idle"; chat: string | null; waitsFor: string[]; feeds: string[]; modelLabel: string; onOpenChat: (id: string) => void; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!chat) return;
    let live = true;
    const read = () => api<{ data: Entry[] }>(`/threads/${encodeURIComponent(chat)}?limit=100`).then(result => { if (live) { setEntries(result.data); setError(""); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    void read();
    const timer = status === "running" ? setInterval(() => void read(), 2000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [chat, status]);
  const items = entries?.map(entry => entry.item) ?? [];
  const said = [...items].reverse().find(item => item.type === "agentMessage" && typeof item.text === "string")?.text;
  const data = node.data;
  return <div className="agent-dashboard hud-menu" role="dialog" aria-label={`${data.title} dashboard`} data-kind={data.kind} data-status={status}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><span className="agent-node-kind">{KINDS[data.kind].label}{wave ? ` · wave ${wave}` : ""} · {STATUS_LABEL[status]}</span><strong>{data.title || "Untitled"}</strong>
      <button type="button" aria-label="Close dashboard" autoFocus onClick={onClose}><X size={14} /></button></header>
    <dl>
      <div><dt>Model</dt><dd>{modelLabel}{data.effort ? ` · ${data.effort} thinking (not applied yet)` : ""}</dd></div>
      <div><dt>Waits for</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "Nobody: the Mother starts it"}</dd></div>
      <div><dt>Feeds</dt><dd>{feeds.length ? feeds.join(", ") : "The Mother's report"}</dd></div>
      <div><dt>May write</dt><dd>{data.writeScopes.length ? data.writeScopes.join(", ") : "Nothing: read-only"}</dd></div>
      <div><dt>Task</dt><dd>{data.instruction || "No task yet: write one before the run"}</dd></div>
      {data.acceptanceCriteria.length > 0 && <div><dt>Done when</dt><dd>{data.acceptanceCriteria.join("; ")}</dd></div>}
    </dl>
    <section className="agent-dashboard-live" aria-label="Live">
      <p className="hud-menu-title">Live</p>
      {!chat ? <p>Not started. What it does shows here once the graph runs.</p>
        : error ? <p role="alert">{error}</p>
        : !entries ? <p>Reading its chat…</p>
        : <><p>{workedFor(entries)} · {summarize(items) || "nothing yet"}</p>{said && <blockquote>{said}</blockquote>}</>}
    </section>
    {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
  </div>;
}

/** The agents canvas: the Mother, ready-made architectures, agents wired by what they wait for and laid out in Kahn's
 * waves, and a run that follows each agent live. The graph is kept on this device (lib/canvas.ts). */
type Props = { models: Model[]; cwd?: string; dark: boolean; onOpenChat: (id: string) => void };
export function AgentsCanvas(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

/** Models listed by a provider other than the engine's own, fetched once per provider and settings version. */
const catalogs = new Map<string, { version: string; models?: Model[]; error?: string }>();

function Canvas({ models, cwd, dark, onOpenChat }: Props) {
  const flow = useReactFlow(), board = useRef<HTMLDivElement>(null), pointer = useRef<XYPosition | null>(null), connectFrom = useRef<XYPosition | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>(() => readGraph() ?? withMother(TEMPLATES[0].build()));
  // What is selected is kept apart from the saved graph: a click picks one, Shift+click or Shift+drag several.
  const [selection, setSelection] = useState<string[]>([]), [dashboardId, setDashboardId] = useState<string | null>(null);
  const [wireMenu, setWireMenu] = useState<WireMenuAt | null>(null);
  const [notice, setNotice] = useState("");
  const [maxAtOnce, setMaxAtOnce] = useState(3);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [run, setRun] = useState<Run | null>(null), [starting, setStarting] = useState(false);
  const [states, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null }>>({});
  const [, setFetched] = useState(0);
  const settings = useElpisSettings().data;
  // What Elpis allows: agents in one graph, and at once (bridge/elpis-features.mjs `agentLimits`).
  const allowed = settings?.agents ?? { graph: 256, atOnce: 6, source: "Elpis default" };
  useEffect(() => { const timer = setTimeout(() => { if (!saveGraph(graph)) setNotice("Could not keep the graph on this device."); }, 300); return () => clearTimeout(timer); }, [graph]);

  // Where agents can run: the engine's provider and every other configured native one (work graphs refuse the
  // Anthropic and Antigravity subscriptions), each with its models; other providers' lists load when the bar opens.
  const choices = useMemo(() => providerChoices(models, (settings ?? null) as ProviderSettings | null).filter(choice => !choice.id.endsWith("/")), [models, settings]);
  const version = settings?.version ?? "";
  useEffect(() => {
    if (!adding) return;
    for (const choice of choices) {
      if (!choice.provider || choice.needsKey || catalogs.get(choice.provider)?.version === version) continue;
      const provider = choice.provider;
      catalogs.set(provider, { version });
      api<{ data: Model[] }>(`/models?provider=${encodeURIComponent(provider)}`)
        .then(result => catalogs.set(provider, { version, models: result.data }))
        .catch(cause => catalogs.set(provider, { version, error: cause instanceof Error ? cause.message : String(cause) }))
        .finally(() => setFetched(count => count + 1));
    }
  }, [adding, choices, version]);
  const listed = (choice: (typeof choices)[number]) => choice.provider ? catalogs.get(choice.provider)?.models ?? [] : choice.models;
  const catalog: CatalogModel[] = choices.flatMap(choice => listed(choice).map(model => ({ provider: choice.provider ?? null, providerLabel: choice.label, model: model.model, label: model.displayName || model.model,
    efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [], defaultEffort: model.defaultReasoningEffort ?? null })));
  const providers = choices.map(choice => {
    const fetched = choice.provider ? catalogs.get(choice.provider) : undefined;
    return { id: choice.provider ?? null, label: choice.label, state: choice.needsKey ? "key" : fetched?.error ? "error" : choice.provider && !fetched?.models ? "loading" : "ready", error: fetched?.error } satisfies Provider;
  });

  // Follow a run: Elpis reports each task's state; stop once the graph has finished.
  useEffect(() => {
    if (!run || FINISHED.has(run.status)) return;
    let live = true;
    const poll = async () => {
      try {
        const listed = await api<Listed>(`/workflows?threadId=${encodeURIComponent(run.rootThreadId)}`);
        const found = listed.data.find(item => item.id === run.graphId);
        if (!live || !found) return;
        setStates(Object.fromEntries(found.tasks.map(task => [task.id, { status: task.status, chat: task.assignedThreadId }])));
        if (found.status !== run.status) setRun({ ...run, status: found.status });
      } catch (error) { if (live) setNotice(error instanceof Error ? error.message : String(error)); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [run]);

  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  const chosen = agents.filter(node => selection.includes(node.id)), selected = chosen.length === 1 ? chosen[0] : undefined;
  const limit = maxAgents(graph), room = Math.max(0, limit - agents.length), order = useMemo(() => waves(graph), [graph]);
  const done = agents.filter(node => states[node.id]?.status === "succeeded").length;
  const runState: MotherData["run"] = run ? (FINISHED.has(run.status) ? "finished" : "running") : "idle";
  const modelLabel = (data: AgentData) => {
    if (!data.model) return "Default model";
    const found = catalog.find(item => item.model === data.model && item.provider === (data.provider ?? null)) ?? (data.provider ? undefined : models.map(model => ({ label: model.displayName || model.model, model: model.model })).find(item => item.model === data.model));
    return found?.label ?? data.model;
  };
  const setText = (id: string, text: string) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id && node.type === "note" ? { ...node, data: { text } } : node) }));
  // A click on a dot (no drag) opens the command bar there; the new agents take that side of it.
  const onHandle = (id: string, end: HandleEnd, event: ReactMouseEvent) => { event.stopPropagation(); openAdder({ x: event.clientX, y: event.clientY }, { id, as: end === "source" ? "target" : "source" }); };
  const nodes = useMemo<Node[]>(() => graph.nodes.map(node => node.type === "mother"
    ? { ...node, deletable: false, selectable: false, data: { run: runState, children: agents.length, limit, onHandle } satisfies MotherData }
    : { ...node, selected: selection.includes(node.id), data: node.type === "agent" ? { ...node.data, status: states[node.id]?.status, modelLabel: modelLabel(node.data), wave: order.get(node.id), onHandle } : { ...node.data, onText: setText } }),
  [graph.nodes, selection, states, models, order, runState, limit, catalog.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo<Edge[]>(() => [
    // The Mother's wires: she starts every agent of the first wave.
    ...agents.filter(node => order.get(node.id) === 1).map(node => ({ id: `${MOTHER}->${node.id}`, source: MOTHER, target: node.id, type: "flow", className: "canvas-edge-mother", selectable: false, deletable: false, focusable: false, selected: wireMenu?.edge.id === `${MOTHER}->${node.id}`, data: { live: states[node.id]?.status === "running" } })),
    ...graph.edges.map(edge => {
      const from = states[edge.source]?.status, to = states[edge.target]?.status, live = from === "succeeded" && to === "running";
      return { ...edge, type: "flow", selected: wireMenu?.edge.id === edge.id, data: { live }, className: from === "failed" || to === "blocked" ? "canvas-edge-cut" : live ? "canvas-edge-live" : from === "succeeded" ? "canvas-edge-done" : undefined };
    }),
  ], [graph.edges, states, order, wireMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set(changes.flatMap(change => change.type === "remove" && change.id !== MOTHER ? [change.id] : []));
    const picks = changes.flatMap(change => change.type === "select" && change.id !== MOTHER ? [change] : []);
    if (picks.length || removed.size) setSelection(current => {
      const next = new Set(current);
      for (const pick of picks) { if (pick.selected) next.add(pick.id); else next.delete(pick.id); }
      for (const id of removed) next.delete(id);
      return [...next];
    });
    setGraph(current => ({ ...current, nodes: applyNodeChanges(changes.filter(change => change.type !== "select" && !(change.type === "remove" && change.id === MOTHER)), current.nodes as Node[]) as CanvasNode[],
      edges: removed.size ? current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) : current.edges }));
  };
  const onEdgesChange = (changes: EdgeChange[]) => setGraph(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges as Edge[]).map(({ id, source, target }) => ({ id, source, target })) }));
  const onConnect = ({ source, target }: Connection) => {
    if (!source || !target || source === MOTHER || target === MOTHER) return;
    if (makesLoop(graph.edges, source, target)) { setNotice("That wire would make a loop: an agent can't wait for itself."); return; }
    setNotice("");
    setGraph(current => current.edges.some(edge => edge.source === source && edge.target === target) ? current : { ...current, edges: [...current.edges, { id: `${source}->${target}`, source, target } satisfies CanvasEdge] });
  };
  // A new node lands in the first free spot near where it was asked for (else the middle of the view), never on top
  // of another.
  const place = (near?: XYPosition) => {
    const box = board.current?.getBoundingClientRect();
    const middle = near ?? (box ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 100, y: box.top + box.height / 2 - 40 }) : { x: 0, y: 0 });
    const taken = graph.nodes.map(node => ({ x: node.position.x, y: node.position.y, w: (node as { measured?: { width?: number } }).measured?.width ?? 210, h: (node as { measured?: { height?: number } }).measured?.height ?? 90 }));
    const free = (x: number, y: number) => taken.every(item => x + 210 < item.x || x > item.x + item.w + 10 || y + 90 < item.y || y > item.y + item.h + 10);
    for (let ring = 0; ring < 12; ring++) for (let step = 0; step <= ring * 4; step++) {
      const angle = ring ? (step / (ring * 4)) * 2 * Math.PI : 0, x = middle.x + Math.cos(angle) * ring * 110, y = middle.y + Math.sin(angle) * ring * 70;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    return { x: middle.x, y: middle.y + 400 };
  };
  const addAgents = (kind: AgentKind, count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, where: Partial<Pick<Adding, "at" | "from" | "between">> = {}, tasks: string[] = []) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    const { from, between } = where, made = newAgents(kind, Math.min(count, room), choice, place(where.at), tasks);
    const wire = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
    // On a wire, the new agents take its place: each waits for its first agent and feeds its second. From a dot or a
    // dropped wire, they join that agent. The Mother's wires are implied, never drawn.
    const wires = between ? made.flatMap(node => [...(between.source === MOTHER ? [] : [wire(between.source, node.id)]), wire(node.id, between.target)])
      : from && from.id !== MOTHER ? made.map(node => from.as === "target" ? wire(from.id, node.id) : wire(node.id, from.id)) : [];
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...made], edges: [...current.edges.filter(edge => edge.id !== between?.id), ...wires] }));
    setSelection(made.map(node => node.id));
    setNotice(count > room ? `Added ${room}: the limit is ${limit} agents.` : "");
  };
  const addNote = (at?: XYPosition, text = "") => { const { x, y } = place(at); setGraph(current => ({ ...current, nodes: [...current.nodes, { id: newId("note"), type: "note", position: { x, y }, data: { text } }] })); };
  // The command bar opens where the pointer is (Tab, Ctrl+A), where the board was double-clicked, at a clicked dot or
  // where a wire was let go, kept inside the board.
  const openAdder = (client?: XYPosition, from?: Adding["from"], between?: CanvasEdge) => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return;
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 }, wanted = client ?? pointer.current ?? middle;
    const point = wanted.x >= box.left && wanted.x <= box.right && wanted.y >= box.top && wanted.y <= box.bottom ? wanted : middle;
    // From a dot, the agents go beside it, on the side they connect to.
    const spot = flow.screenToFlowPosition(point), at = from ? { x: spot.x + (from.as === "target" ? 80 : -300), y: spot.y - 40 } : { x: spot.x - (between ? 95 : 0), y: spot.y - 40 };
    // Kept inside the board: as low as the pointer allows, never past the bottom edge (the list scrolls instead).
    const top = Math.max(8, Math.min(point.y - box.top, box.height - 440));
    setAdding({ at, left: Math.max(8, Math.min(point.x - box.left, box.width - 348)), top, height: box.height - top - 8, ...(from ? { from } : {}), ...(between ? { between } : {}) }); setWireMenu(null);
  };
  // A wire let go over empty board opens the command bar there, as Blender and Unreal do; a click without a drag is
  // the dot's own click (onHandle).
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const spot = "changedTouches" in event ? event.changedTouches[0] : event, start = connectFrom.current;
    if (state.isValid || state.toNode || !state.fromNode || !state.fromHandle || !start || Math.hypot(spot.clientX - start.x, spot.clientY - start.y) < 8) return;
    openAdder({ x: spot.clientX, y: spot.clientY }, { id: state.fromNode.id, as: state.fromHandle.type === "source" ? "target" : "source" });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null, typing = target?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox']");
      const onBoard = !target || target === document.body || Boolean(target.closest?.(".react-flow"));
      // event.code, so it works in any keyboard layout; never inside a field, where Ctrl+A selects the text.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyA" && !typing) { event.preventDefault(); openAdder(); }
      else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.shiftKey && onBoard && !typing) { event.preventDefault(); openAdder(); }
      else if (event.key === "Enter" && selected && onBoard && !typing && !adding) { event.preventDefault(); setDashboardId(selected.id); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const loadTemplate = (build: () => CanvasGraph) => { setGraph(current => ({ ...withMother(build()), maxAgents: current.maxAgents })); setSelection([]); setWireMenu(null); setDashboardId(null); setRun(null); setStates({}); setNotice("");
    // Keys go to the board again (Tab opens the command bar), not to the template just clicked.
    (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  const tidy = () => { setGraph(current => arrange(current)); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  const dashboard = agents.find(node => node.id === dashboardId);
  // Edits apply to every selected agent: one in the inspector, several together.
  const edit = (patch: Partial<AgentData>) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.type === "agent" && chosen.some(item => item.id === node.id) ? { ...node, data: { ...node.data, ...patch } } : node) }));
  const remove = (ids: string[]) => { setGraph(current => ({ ...current, nodes: current.nodes.filter(node => !ids.includes(node.id)), edges: current.edges.filter(edge => !ids.includes(edge.source) && !ids.includes(edge.target)) })); setSelection([]); };
  const removeWire = (id: string) => { setGraph(current => ({ ...current, edges: current.edges.filter(edge => edge.id !== id) })); setWireMenu(null); };
  // A plain click picks that one node even inside a selection, as in Figma and Blender; Shift or Ctrl adds or removes
  // it (React Flow), and dragging moves the whole selection.
  const dragged = useRef(false);
  const onNodeClick = (event: ReactMouseEvent, node: Node) => {
    if (dragged.current || event.shiftKey || event.ctrlKey || event.metaKey || node.id === MOTHER) return;
    setSelection([node.id]);
  };
  const onEdgeClick = (event: ReactMouseEvent, edge: Edge) => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return;
    setAdding(null);
    setWireMenu({ edge: { id: edge.id, source: edge.source, target: edge.target }, client: { x: event.clientX, y: event.clientY },
      left: Math.max(8, Math.min(event.clientX - box.left, box.width - 348)), top: Math.max(8, Math.min(event.clientY - box.top + 10, box.height - 170)) });
  };
  const titleOf = (id: string) => agents.find(node => node.id === id)?.data.title || "Untitled";
  // Kahn's waves, for the run-order list: what starts together, and how each wave is doing.
  const columns = [...new Set(order.values())].sort((a, b) => a - b).map(level => ({ level, members: agents.filter(node => order.get(node.id) === level) }));
  const waveState = (members: typeof agents) => members.some(node => states[node.id]?.status === "running") ? "running" : members.length && members.every(node => states[node.id]?.status === "succeeded") ? "succeeded" : members.some(node => ["failed", "blocked"].includes(states[node.id]?.status ?? "")) ? "failed" : undefined;
  const choiceKey = (data: AgentData) => data.model ? `${data.provider ?? ""}|${data.model}` : "";
  const shared = (key: (data: AgentData) => string) => new Set(chosen.map(node => key(node.data))).size === 1 ? key(chosen[0].data) : "mixed";
  const modelPatch = (value: string): Partial<AgentData> => { const [provider, ...rest] = value.split("|"); return value ? { provider: provider || null, model: rest.join("|"), effort: null } : { provider: null, model: null, effort: null }; };
  const modelOptions = [<option key="" value="">Default model</option>, ...catalog.map(item => <option key={`${item.provider}|${item.model}`} value={`${item.provider ?? ""}|${item.model}`} data-hint={item.providerLabel}>{item.label}</option>)];
  const mixed = <option value="mixed" disabled>Mixed</option>;
  const selectedModel = selected ? catalog.find(item => item.model === selected.data.model && item.provider === (selected.data.provider ?? null)) : undefined;

  async function start() {
    const built = runTasks(graph);
    if ("error" in built) { setNotice(built.error); return; }
    setStarting(true); setNotice(""); setStates({});
    try {
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: graph.name.slice(0, 120) || "Agents canvas" });
      const result = await api<{ graphId: string }>("/workflows/run", { rootThreadId: created.thread.id, name: graph.name || "Agents canvas", tasks: built.tasks, maxConcurrency: Math.max(1, Math.min(maxAtOnce, allowed.atOnce)) });
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running" });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  }

  const chat = selected ? states[selected.id]?.chat : null;
  return <section className="agents-canvas" aria-label="Agents canvas">
    <header className="canvas-header">
      <Input aria-label="Graph name" className="canvas-name" value={graph.name} maxLength={120} onChange={event => setGraph(current => ({ ...current, name: event.target.value }))} />
      {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={FINISHED.has(run.status) ? run.status : "running"} />{FINISHED.has(run.status) ? "Finished" : "Running"} · {done} of {agents.length} done</span>}
      <span className="canvas-spacer" />
      {run && <Button variant="ghost" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open run chat</Button>}
      <Button variant="ghost" size="sm" onClick={tidy} title="Lay the agents out in Kahn's waves: each column starts once the columns before it are done"><ListOrdered size={14} />Arrange by run order</Button>
      <CountField label="Max agents" value={limit} min={Math.max(1, agents.length)} max={allowed.graph} onChange={count => setGraph(current => ({ ...current, maxAgents: count }))}
        why={typed => typed > allowed.graph ? `Elpis runs at most ${allowed.graph} agents in one graph.` : typed < agents.length ? `The graph already has ${agents.length} agents; remove some first.` : "Type a whole number from 1."} />
      <CountField label="At once" value={Math.min(maxAtOnce, allowed.atOnce)} min={1} max={allowed.atOnce} onChange={setMaxAtOnce}
        why={typed => typed > allowed.atOnce ? `Elpis allows ${allowed.atOnce} at once here (${allowed.source}).` : "At least 1 has to run."} />
      <Button size="sm" onClick={() => void start()} disabled={starting || Boolean(run && !FINISHED.has(run.status))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
    </header>
    <div className="canvas-board" ref={board} onPointerMove={event => { pointer.current = { x: event.clientX, y: event.clientY }; }}
      onDoubleClick={event => { if ((event.target as Element).classList.contains("react-flow__pane")) openAdder({ x: event.clientX, y: event.clientY }); }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onConnectEnd={onConnectEnd}
        onConnectStart={event => { const spot = "touches" in event ? event.touches[0] : event; connectFrom.current = { x: spot.clientX, y: spot.clientY }; }} connectOnClick={false}
        onNodeDoubleClick={(_, node) => { if (node.type === "agent") setDashboardId(node.id); }}
        onEdgeClick={onEdgeClick} multiSelectionKeyCode={["Shift", "Control", "Meta"]} onNodeClick={onNodeClick}
        onNodeDragStart={() => { dragged.current = true; }} onNodeDragStop={() => setTimeout(() => { dragged.current = false; })}
        onPaneClick={() => { setSelection([]); setWireMenu(null); }} deleteKeyCode={["Backspace", "Delete"]} zoomOnDoubleClick={false} colorMode={dark ? "dark" : "light"} fitView fitViewOptions={FIT} minZoom={0.3} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="canvas-minimap" />
      </ReactFlow>
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <div className="canvas-toolbar" role="toolbar" aria-label="Add to the canvas">
        <span className="canvas-toolbar-label">Add</span>
        {AGENT_KINDS.map(kind => <Button key={kind} variant="ghost" size="sm" aria-label={`Add ${KINDS[kind].label} agent`} title={KINDS[kind].hint} onClick={() => addAgents(kind, 1, { model: null })}><i className="canvas-kind" data-kind={kind} />{KINDS[kind].label}</Button>)}
        <Button variant="ghost" size="sm" onClick={() => addNote()}><StickyNote size={14} />Note</Button>
        <Button variant="ghost" size="sm" className="canvas-toolbar-more" onClick={() => openAdder()} title="Type a command: how many, the kind, the model and thinking, the tasks">Command <kbd>Tab</kbd></Button>
      </div>
      {adding && <CommandBar adding={adding} room={room} limit={limit} catalog={catalog} providers={providers} onClose={() => setAdding(null)}
        onAgents={command => { addAgents(command.kind, Math.max(1, command.count ?? 1), { model: command.model?.model ?? null, provider: command.model?.provider ?? null, effort: command.effort }, adding, command.tasks); setAdding(null); }}
        onNote={text => { addNote(adding.at, text); setAdding(null); }} />}
      {wireMenu && <WireMenu menu={wireMenu} from={wireMenu.edge.source === MOTHER ? null : titleOf(wireMenu.edge.source)} to={titleOf(wireMenu.edge.target)} onClose={() => setWireMenu(null)}
        onInsert={() => openAdder(wireMenu.client, undefined, wireMenu.edge)} onRemove={wireMenu.edge.source === MOTHER ? undefined : () => removeWire(wireMenu.edge.id)} />}
      {dashboard && <AgentDashboard node={dashboard} wave={order.get(dashboard.id)} status={states[dashboard.id]?.status ?? "idle"} chat={states[dashboard.id]?.chat ?? null} modelLabel={modelLabel(dashboard.data)}
        waitsFor={graph.edges.filter(edge => edge.target === dashboard.id).map(edge => titleOf(edge.source))} feeds={graph.edges.filter(edge => edge.source === dashboard.id).map(edge => titleOf(edge.target))}
        onOpenChat={onOpenChat} onClose={() => setDashboardId(null)} />}
      {notice && <p className="canvas-notice" role="alert">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></button></p>}
    </div>
    {selected ? <aside className="canvas-side" aria-label="Selected agent">
      <p className="hud-menu-title">{KINDS[selected.data.kind].label} agent{order.get(selected.id) ? ` · wave ${order.get(selected.id)}` : ""}{states[selected.id] ? ` · ${STATUS_LABEL[states[selected.id].status]}` : ""}</p>
      <label>Name<Input aria-label="Name" value={selected.data.title} maxLength={256} onChange={event => edit({ title: event.target.value })} /></label>
      <label>Role<OptionSelect aria-label="Role" value={selected.data.kind} onChange={event => edit({ kind: event.target.value as AgentKind })}>{AGENT_KINDS.map(kind => <option key={kind} value={kind} data-hint={KINDS[kind].hint}>{KINDS[kind].label}</option>)}</OptionSelect></label>
      <label>Instruction<Textarea aria-label="Instruction" rows={5} value={selected.data.instruction} placeholder="What this agent should do" onChange={event => edit({ instruction: event.target.value })} /></label>
      <label>Model<OptionSelect aria-label="Model" value={choiceKey(selected.data)} onChange={event => edit(modelPatch(event.target.value))}>
        {modelOptions}
        {selected.data.model && !selectedModel && <option value={choiceKey(selected.data)}>{selected.data.model}</option>}</OptionSelect></label>
      {selectedModel && selectedModel.efforts.length > 0 && <label>Thinking (kept; Elpis applies it per agent in a later engine build)<OptionSelect aria-label="Thinking" value={selected.data.effort ?? ""} onChange={event => edit({ effort: event.target.value || null })}>
        <option value="">Model default{selectedModel.defaultEffort ? ` (${selectedModel.defaultEffort})` : ""}</option>{selectedModel.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</OptionSelect></label>}
      <label>May write (one folder or file per line)<Textarea aria-label="May write" rows={2} value={selected.data.writeScopes.join("\n")} onChange={event => edit({ writeScopes: lines(event.target.value) })} /></label>
      <label>Done when (one check per line)<Textarea aria-label="Done when" rows={3} value={selected.data.acceptanceCriteria.join("\n")} onChange={event => edit({ acceptanceCriteria: lines(event.target.value) })} /></label>
      <div className="canvas-inspector-actions">
        <Button variant="outline" size="sm" onClick={() => setDashboardId(selected.id)}>Dashboard <kbd>Enter</kbd></Button>
        {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove([selected.id])}><Trash2 size={14} />Delete agent</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : chosen.length > 1 ? <aside className="canvas-side" aria-label="Selected agents">
      <p className="hud-menu-title">{chosen.length} agents selected</p>
      <p className="canvas-help">{chosen.map(node => node.data.title || "Untitled").join(", ")}</p>
      <label>Role<OptionSelect aria-label="Role" value={shared(data => data.kind)} onChange={event => edit({ kind: event.target.value as AgentKind })}>
        {mixed}{AGENT_KINDS.map(kind => <option key={kind} value={kind} data-hint={KINDS[kind].hint}>{KINDS[kind].label}</option>)}</OptionSelect></label>
      <label>Model<OptionSelect aria-label="Model" value={shared(choiceKey)} onChange={event => edit(modelPatch(event.target.value))}>{mixed}{modelOptions}</OptionSelect></label>
      <div className="canvas-inspector-actions">
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(chosen.map(node => node.id))}><Trash2 size={14} />Delete {chosen.length} agents <kbd>Delete</kbd></Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : <aside className="canvas-side" aria-label="Architectures">
      {columns.length > 0 && <section className="canvas-order" aria-label="Run order">
        <p className="hud-menu-title">Run order</p>
        <ol>{columns.map(({ level, members }) => <li key={level} data-status={waveState(members)}><span>Wave {level}</span>{members.map(node => node.data.title || "Untitled").join(", ")}</li>)}</ol>
      </section>}
      {(["Patterns", "Research", "Start"] as const).map(group => <section key={group} className="canvas-templates" aria-label={group}>
        <p className="hud-menu-title">{group === "Start" ? "Start fresh" : group}</p>
        {TEMPLATES.filter(template => template.group === group).map(template => <button key={template.id} type="button" className="canvas-template" onClick={() => loadTemplate(template.build)}>
          <strong>{template.name}</strong><small>{template.description}</small>{template.source && <small className="canvas-template-source">{template.source}</small>}</button>)}
      </section>)}
      <p className="canvas-help">Tab, Ctrl+A, a double-click, or a click on an agent&rsquo;s dot opens the command bar: type <kbd>3 implement sol high: task; task</kbd> and Enter. Enter or a double-click on an agent opens its dashboard. Drag dot to dot to wire: the second waits for the first. Click a wire to insert agents on it or remove it. Shift+click or Shift+drag selects several.</p>
    </aside>}
  </section>;
}

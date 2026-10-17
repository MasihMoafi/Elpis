"use client";

import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, getBezierPath, useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type FinalConnectionState, type Node, type NodeChange, type NodeProps, type XYPosition } from "@xyflow/react";
import { Check, ChevronRight, ExternalLink, ListOrdered, PanelRight, PanelRightClose, Play, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { summarize, workedFor } from "@/components/transcript";
import { IsoBoard, ViewToggle } from "@/components/agents-iso";
import { api, providerChoices, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { appStorage } from "@/lib/projects";
import { DONE, FATHER, MOTHER, TASKS_PER_AGENT, TEMPLATES, applyPlan, arrange, boardForPlan, checkOf, criticalPath, commandParts, shapeOf, makesLoop, maxAgents, newAgents, newId, parseCommand, parents, readGraph, runParts, saveGraph, waves, withMother, type AgentData, type CanvasEdge, type CanvasGraph, type CanvasNode, type CatalogModel, type Command, type MotherSettings, type NoteData, type Plan, type RunTask, type TaskStatus } from "@/lib/canvas";

/** A run: the Mother's part, and the Father's when the graph has more agents than she runs (lib/canvas.ts `parents`):
 * his tasks wait in `father` until her part has succeeded, then run in his own chat. */
type Run = { rootThreadId: string; graphId: string; status: string; startedAt: number; endedAt?: number; father?: { tasks: RunTask[]; threadId?: string; graphId?: string; status: string } };
/** Whether the whole run is over: her part, and his if he has one. */
const over = (run: Run) => FINISHED.has(run.status) && (!run.father || FINISHED.has(run.father.status));
type Listed = { data: { id: string; status: string; tasks: { id: string; status: TaskStatus; assignedThreadId: string | null }[] }[] };
type HandleEnd = "source" | "target";
type AgentNodeData = AgentData & { status?: TaskStatus; check?: TaskStatus; modelLabel?: string; wave?: number; onHandle?: (id: string, end: HandleEnd, event: ReactMouseEvent) => void };
type MotherData = { run: "idle" | "running" | "finished"; children: number; limit: number; onHandle?: AgentNodeData["onHandle"] };
const STATUS_LABEL: Record<TaskStatus | "idle", string> = { idle: "not run", pending: "waiting", running: "running", succeeded: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
/** An agent's check: the read-only verify task Elpis runs after every agent that writes (lib/canvas.ts `runTasks`). */
const CHECK_LABEL: Record<TaskStatus | "idle", string> = { idle: "Checked after it runs", pending: "Check waits for it", running: "Being checked", succeeded: "Check passed", failed: "Check failed", blocked: "Check blocked", cancelled: "Check cancelled" };
const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
/** What Elpis is asked when the user ran a team without writing a goal: keep what is drawn and set, and fill the rest. */
const DRAWN = "Run this team as drawn: keep every agent, its wiring and whatever is already set; give each agent the prompt and folders it lacks, from its name and its place in the team.";
/** How to manage agents, from the people who build them: read before designing a team. */
const GUIDE = [
  { title: "Building effective agents", note: "Anthropic: the patterns, and when a simple workflow beats an agent", href: "https://www.anthropic.com/engineering/building-effective-agents" },
  { title: "When to use several agents", note: "Anthropic: split by context, not by role; they cost 3–10× the tokens", href: "https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them" },
  { title: "How Anthropic's research agents work", note: "A lead plans; subagents research in parallel and report back", href: "https://www.anthropic.com/engineering/multi-agent-research-system" },
  { title: "Subagents in Claude Code", note: "Read-only helpers and writers, and how to brief them", href: "https://code.claude.com/docs/en/sub-agents" },
  { title: "Open Deep Research", note: "LangGraph: scope the question, research in parallel, write once", href: "https://blog.langchain.com/open-deep-research/" },
];
/** Fitting shows the whole graph, at most at full size. */
const FIT = { padding: 0.08, maxZoom: 1 };

/** An agent on the canvas: it writes. Its run-order wave, name, model and state, with an input on the left (what it
 * waits for) and an output on the right (what waits for it), as Deus Ex's hacking screen links its nodes. The ring at
 * its corner is its check: empty until it runs, turning while it runs, then a tick or a cross. Clicking a dot opens
 * the command bar to add agents on that side. */
function AgentNode({ id, data }: NodeProps<Node<AgentNodeData>>) {
  const status = data.status ?? "idle", check = data.check ?? "idle";
  return <div className="agent-node" data-kind="agent" data-status={status}>
    <Handle type="target" position={Position.Left} title="Add agents this one waits for" onClick={event => data.onHandle?.(id, "target", event)} />
    <span className="agent-node-kind">Agent{data.wave ? ` · wave ${data.wave}` : ""}</span>
    <strong className="agent-node-title">{data.title || "Untitled"}</strong>
    <small className="agent-node-meta">{data.modelLabel ?? "Default model"} · {STATUS_LABEL[status]}</small>
    <span className="agent-node-mark" role="img" data-check={check} aria-label={CHECK_LABEL[check]} title={CHECK_LABEL[check]}>{check === "succeeded" ? <Check size={12} /> : check === "failed" || check === "blocked" ? <X size={12} /> : null}</span>
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
  // The strip is the handle: dragging it moves the note, while the text below takes the keys.
  return <div className="canvas-note"><span className="canvas-note-grip" title="A note for you, never sent to an agent; drag here to move it">Note · for you</span>
    <textarea aria-label="Note" className="nodrag" value={data.text} placeholder="Write a note" onChange={event => data.onText?.(id, event.target.value)} /></div>;
}
/** The Father: he runs the agents past the Mother's ten, in his own chat, once her part has succeeded, and reports to
 * her. Drawn only when the graph needs him. */
function FatherNode({ data }: NodeProps<Node<MotherData>>) {
  return <div className="agent-node mother-node" data-kind="mother" data-status={data.run === "running" ? "running" : undefined}
    title="The Father runs the agents past the Mother's ten, in his own chat, after her part has succeeded, and reports to her.">
    <span className="agent-node-kind">Father</span>
    <strong className="agent-node-title">Reports to the Mother</strong>
    <small className="agent-node-meta">{data.children} agents · {data.run === "idle" ? "after her part" : data.run}</small>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const NODE_TYPES = { agent: AgentNode, mother: MotherNode, father: FatherNode, note: NoteNode };

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
type Adding = { at: XYPosition; left: number; top: number; height: number; from?: { id: string; as: HandleEnd }; between?: CanvasEdge; seed?: string };
/** A menu's place: where it was asked for, and its corner inside the board. */
type MenuAt = { client: XYPosition; left: number; top: number };
type BoardMenu = (MenuAt & { kind: "wire"; edge: CanvasEdge }) | (MenuAt & { kind: "nodes"; ids: string[] }) | (MenuAt & { kind: "mother" }) | (MenuAt & { kind: "board" });
type Provider = { id: string | null; label: string; state: "ready" | "loading" | "key" | "error"; error?: string };
type Level = { name: "providers" } | { name: "models"; provider: string | null } | { name: "efforts"; model: CatalogModel };
type Row = { key: string; label: string; hint?: string; more?: boolean; take: () => void; open?: () => void };
const providerToken = (model: CatalogModel) => `${model.provider ? `@${model.provider} ` : ""}${model.model}`;

/** The command bar, AutoCAD-style and keyboard first, as Houdini's and Nuke's Tab menu, Blender's Shift+A and
 * ComfyUI's search box. Type a prompt and Enter to add an agent with it (Shift+Enter starts the next agent's prompt),
 * or `3 sol high: prompt; prompt`. The list offers a model: ↑↓ choose, → opens a provider or a model's thinking
 * levels, ← goes back, Tab or Enter takes the choice. Without a prompt, Enter asks for one per agent. */
function CommandBar({ adding, room, limit, catalog, providers, onAgents, onNote, onAsk, onClose }: { adding: Adding; room: number; limit: number; catalog: CatalogModel[]; providers: Provider[]; onAgents: (command: Command) => void; onNote: (text: string) => void; onAsk: (text: string) => void; onClose: () => void }) {
  // A command line opened by typing on the board starts with what was typed (`seed`), the caret after it.
  const [text, setText] = useState(adding.seed ?? ""), [active, setActive] = useState(0), [level, setLevel] = useState<Level | null>(null);
  const [asking, setAsking] = useState<Command | null>(null), [tasks, setTasks] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const end = field.current?.value.length ?? 0; field.current?.setSelectionRange(end, end); }, []);
  const command = parseCommand(text, catalog), { head, rest } = commandParts(text);
  const lastWord = head.split(/\s+/).at(-1) ?? "";
  // A choice goes into the command's first part, replacing a half-typed word it couldn't place; prompts stay.
  const put = (token: string) => {
    if (command.prompted) setText(`${token}: ${text}`);
    else {
      const words = head.trimEnd().split(/\s+/).filter(Boolean);
      if (words.length && command.unknown.includes(words.at(-1)!.toLowerCase())) words.pop();
      const next = [...words, token].join(" ");
      setText(rest ? `${next}${rest}` : `${next} `);
    }
    setLevel(null); setActive(0); field.current?.focus();
  };
  // Free text that is no command goes to Elpis, which acts on the board ("let Elpis handle it"); opened from a dot or a
  // wire, it is the new agent's prompt instead.
  const asks = command.prompted && !adding.from && !adding.between;
  const submit = (current: Command) => {
    if (current.note) { onNote(current.tasks.join("\n")); return; }
    if (current === command && asks) { onAsk(text.trim()); return; }
    // As in the prompts step, more prompts than agents adds agents.
    if (current.tasks.length) onAgents({ ...current, count: Math.max(current.count ?? 1, current.tasks.length) }); else { setAsking(current); setTasks(""); }
  };
  const shown: Level = level ?? (command.model?.efforts.length && !command.effort ? { name: "efforts", model: command.model } : providers.length === 1 ? { name: "models", provider: providers[0].id } : { name: "providers" });
  const defaultRow: Row = { key: "default", label: "Default model", hint: "Whatever the run's chat uses", take: () => submit(command) };
  const modelRow = (model: CatalogModel): Row => ({ key: `${model.provider}:${model.model}`, label: model.label, hint: model.efforts.length ? `${model.model} · → thinking` : model.model, more: model.efforts.length > 0,
    take: () => put(providerToken(model)), open: model.efforts.length ? () => { put(providerToken(model)); setLevel({ name: "efforts", model }); } : undefined });
  const rows: Row[] = shown.name === "providers"
    ? [defaultRow, ...providers.map(provider => ({ key: provider.id ?? "main", label: provider.label, more: true, hint: provider.state === "key" ? "Needs an API key: add it in Settings" : provider.state === "loading" ? "Loading models…" : provider.state === "error" ? provider.error : `${catalog.filter(model => model.provider === provider.id).length} models · →`,
        take: () => setLevel({ name: "models", provider: provider.id }), open: () => setLevel({ name: "models", provider: provider.id }) }))]
    : shown.name === "models"
      ? [...(providers.length === 1 ? [defaultRow] : []), ...catalog.filter(model => model.provider === shown.provider).map(modelRow)]
      : shown.model.efforts.map(effort => ({ key: effort, label: `${effort[0].toUpperCase()}${effort.slice(1)} thinking`, hint: effort === shown.model.defaultEffort ? "The model's default" : undefined, take: () => put(effort) }));
  const current = rows[Math.min(active, rows.length - 1)];
  const back = () => { if (shown.name === "efforts") setLevel({ name: "models", provider: shown.model.provider }); else if (shown.name === "models" && providers.length > 1) setLevel({ name: "providers" }); else setLevel(null); setActive(0); };
  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const atEnd = event.currentTarget.selectionStart === text.length;
    // Shift+Enter starts the next agent's prompt, as in the prompts step.
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!level) setLevel(shown); setActive(index => (Math.min(index, rows.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(1, rows.length)); }
    else if (event.key === "ArrowRight" && atEnd && current?.open) { event.preventDefault(); setActive(0); current.open(); }
    else if (event.key === "ArrowLeft" && atEnd && level) { event.preventDefault(); back(); }
    else if (event.key === "Tab") { event.preventDefault(); current?.take(); }
    else if (event.key === "Enter") { event.preventDefault(); if (level) current?.take(); else submit(command); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  const close = (event: React.FocusEvent) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); };
  const count = Math.max(1, command.count ?? 1, command.tasks.length);

  if (asking) {
    // The prompts: line n is agent n's; lines past the count add agents, up to the limit.
    const typed = lines(tasks), total = Math.min(room, Math.max(asking.count ?? 1, typed.length)), given = Math.min(typed.length, total);
    return <div className="quick-add hud-menu nodrag nowheel" role="dialog" aria-label="Add agents" style={{ left: adding.left, top: adding.top, maxHeight: adding.height }} onBlur={close}>
      <p className="hud-menu-title quick-add-title"><span>{total === 1 ? "Prompt for the new agent" : `Prompts for the ${total} new agents`}</span><span>{asking.model?.label ?? "Default model"}</span></p>
      <textarea autoFocus className="quick-add-field quick-add-tasks" aria-label="Prompts, one per line" rows={Math.min(8, Math.max(3, total))} value={tasks}
        placeholder={Array.from({ length: Math.min(3, total) }, (_, index) => `Prompt for agent ${index + 1}`).join("\n")} onChange={event => setTasks(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onAgents({ ...asking, count: total, tasks: typed.slice(0, total) }); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          else if (event.key === "Backspace" && !tasks) { event.preventDefault(); setAsking(null); }
        }} />
      <p className="quick-add-note" role="status">{total} {total === 1 ? "agent" : "agents"}: {given === total ? "each with its prompt" : given ? `${given} with a prompt, ${total - given} still to write` : "prompts can be written later, before the run"}{typed.length > room ? `. Only ${room} fit under the limit of ${limit}.` : ""}</p>
      <p className="quick-add-help">One prompt per line · Shift+Enter new line · Enter add · Esc close · Backspace back</p>
    </div>;
  }
  return <div className="quick-add hud-menu nodrag nowheel" role="dialog" aria-label="Add agents" style={{ left: adding.left, top: adding.top, maxHeight: adding.height }} onBlur={close}>
    <p className="hud-menu-title quick-add-title"><span>{room ? "Add agents" : "No room for more agents"}</span><span>{room} of {limit} left</span></p>
    <textarea ref={field} autoFocus className="quick-add-field quick-add-command" aria-label="Command" value={text} spellCheck={false} placeholder="Tell Elpis what to do, or 3 sol high: prompt; prompt"
      rows={Math.min(6, text.split("\n").length)} onChange={event => { setText(event.target.value); setActive(0); setLevel(null); }} onKeyDown={keys} />
    <p className="quick-add-plan" aria-label="Will add">
      {command.note ? <b>Note</b> : asks ? <><b>Elpis</b><span>will do it: design or change the team from what you wrote</span></> : text.trim() ? <><b>{`${Math.min(count, room) || count} × Agent`}</b>
        <span>{command.model ? `${command.model.label} · ${command.model.providerLabel}` : "Default model"}</span>
        {command.effort && <span>{command.effort} thinking</span>}
        {command.tasks.length > 0 && <span>{command.tasks.length} {command.tasks.length === 1 ? "prompt" : "prompts"}</span>}</> : <span>Type a prompt, or choose a model below</span>}
      {command.unknown.length > 0 && <em>Not understood: {command.unknown.join(", ")}</em>}
      {count > room && room > 0 && <em>Only {room} fit under the limit of {limit}</em>}
    </p>
    <p className="quick-add-crumb">{shown.name === "providers" ? "Providers" : shown.name === "models" ? `Models · ${providers.find(provider => provider.id === shown.provider)?.label ?? ""}` : `Thinking · ${shown.model.label}`}{level && <span>← back</span>}</p>
    <div role="listbox" aria-label={shown.name === "providers" ? "Providers" : shown.name === "models" ? "Models" : "Thinking levels"} className="quick-add-list">
      {rows.map((row, index) => <button key={row.key} type="button" role="option" aria-selected={row === current} className="quick-add-option"
        onMouseEnter={() => setActive(index)} onClick={() => { setActive(index); (row.open ?? row.take)(); }}>
        <span className="select-option">{row.label}{row.hint && <small>{row.hint}</small>}</span>{row.more && <ChevronRight size={14} className="quick-add-more" />}
      </button>)}
      {!rows.length && <p className="quick-add-note">Nothing to choose here.</p>}
    </div>
    <p className="quick-add-help">{lastWord && command.unknown.includes(lastWord.toLowerCase()) ? "Tab takes the highlighted choice · " : ""}↑↓ · → open · ← back · Tab take · Shift+Enter next prompt · Enter {level ? "take" : asks ? "ask Elpis" : "add"} · Esc</p>
  </div>;
}

type MenuItem = { label: string; hint?: string; keys?: string; take: () => void };
/** A menu where the board was clicked, as ComfyUI's, Slate's and Grasshopper's: on a wire (insert agents or remove
 * it), an agent, the Mother or the empty board. ↑↓ move, Enter takes, Esc closes; Delete answers `onDelete`. */
function CanvasMenu({ at, name, title, detail, items, onDelete, onClose }: { at: MenuAt; name: string; title: string; detail?: string; items: MenuItem[]; onDelete?: () => void; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const move = (step: number) => {
    const buttons = [...(list.current?.querySelectorAll("button") ?? [])], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  return <div className="quick-add hud-menu nodrag nowheel" role="menu" aria-label={name} style={{ left: at.left, top: at.top }} onContextMenu={event => event.preventDefault()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); }}
    onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if ((event.key === "Delete" || event.key === "Backspace") && onDelete) { event.preventDefault(); event.stopPropagation(); onClose(); onDelete(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <p className="hud-menu-title quick-add-title"><span>{title}</span>{detail && <span>{detail}</span>}</p>
    <div ref={list} className="quick-add-list">{items.map((item, index) => <button key={item.label} type="button" role="menuitem" autoFocus={index === 0} className="quick-add-option" onClick={() => { onClose(); item.take(); }}>
      <span className="select-option">{item.label}{item.hint && <small>{item.hint}</small>}</span>{item.keys && <kbd>{item.keys}</kbd>}</button>)}</div>
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
/** What a chat has done so far, read from it, and again every 2 s while it works: an agent's, or the Mother's. */
function LiveFeed({ chat, working, idle }: { chat: string | null; working: boolean; idle: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!chat) return;
    let live = true;
    const read = () => api<{ data: Entry[] }>(`/threads/${encodeURIComponent(chat)}?limit=100`).then(result => { if (live) { setEntries(result.data); setError(""); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    void read();
    const timer = working ? setInterval(() => void read(), 2000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [chat, working]);
  const items = entries?.map(entry => entry.item) ?? [];
  const said = [...items].reverse().find(item => item.type === "agentMessage" && typeof item.text === "string")?.text;
  return <section className="agent-dashboard-live" aria-label="Live">
    <p className="hud-menu-title">Live</p>
    {!chat ? <p>{idle}</p>
      : error ? <p role="alert">{error}</p>
      : !entries ? <p>Reading its chat…</p>
      : <><p>{workedFor(entries)} · {summarize(items) || "nothing yet"}</p>{said && <blockquote>{said}</blockquote>}</>}
  </section>;
}

/** A pattern's shape: the Mother, then a column of agents per wave, in run order. */
function Shape({ shape }: { shape: number[] }) {
  return <span className="canvas-shape" aria-hidden="true"><span><i className="canvas-kind" data-kind="mother" /></span>
    {shape.map((count, index) => <span key={index}>{Array.from({ length: count }, (_, row) => <i key={row} className="canvas-kind" data-kind="agent" />)}</span>)}</span>;
}

/** The folders an agent may write, chosen from the project's own (GET /api/folders): Elpis takes only existing
 * folders inside the project, never the whole project (codex-rs state/src/model/work_graph.rs `validate_write_scopes`). */
/** The project's folders (GET /api/folders), which agents may write: read once per project, shared by the pickers
 * and by Elpis when it fills in the team. */
function useProjectFolders(cwd?: string) {
  const [folders, setFolders] = useState<string[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!cwd) return;
    let live = true;
    api<{ data: string[] }>(`/folders?cwd=${encodeURIComponent(cwd)}`).then(result => { if (live) { setFolders(result.data); setError(""); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [cwd]);
  return { folders, error };
}

function FolderPicker({ cwd, folders, error, value, onChange }: { cwd?: string; folders: string[] | null; error: string; value: string[]; onChange: (folders: string[]) => void }) {
  const left = (folders ?? []).filter(folder => !value.includes(folder));
  return <div className="canvas-folders" role="group" aria-label="May write">
    <span>May write</span>
    {value.length > 0 && <span className="canvas-folders-chosen">{value.map(folder => <span key={folder} className="canvas-chip">{folder}<button type="button" aria-label={`Remove ${folder}`} onClick={() => onChange(value.filter(item => item !== folder))}><X size={12} /></button></span>)}</span>}
    {!cwd ? <small>Agents write inside a project: choose one at the top.</small>
      : error ? <small role="alert">{error}</small>
      : <OptionSelect aria-label="Add a folder" value="" onChange={event => { if (event.target.value) onChange([...value, event.target.value]); }}>
        <option value="" disabled>{folders === null ? "Loading the project's folders…" : !value.length ? "Elpis decides, or add a folder…" : left.length ? "Add a folder it may write…" : "No more folders"}</option>
        {left.map(folder => <option key={folder} value={folder}>{folder}</option>)}</OptionSelect>}
  </div>;
}

/** The run's clock, as Deus Ex's tracing timer: minutes and seconds since the run started, stopping when it ends. */
function RunClock({ since, until }: { since: number; until?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (until) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [until]);
  return <strong>{clock((until ?? now) - since)}</strong>;
}
/** A span of time as mm:ss. */
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; };

function AgentDashboard({ node, wave, status, check, chat, waitsFor, feeds, modelLabel, onOpenChat, onClose }: { node: Extract<CanvasNode, { type: "agent" }>; wave?: number; status: TaskStatus | "idle"; check: TaskStatus | "idle"; chat: string | null; waitsFor: string[]; feeds: string[]; modelLabel: string; onOpenChat: (id: string) => void; onClose: () => void }) {
  const data = node.data;
  return <div className="agent-dashboard hud-menu" role="dialog" aria-label={`${data.title} dashboard`} data-kind="agent" data-status={status}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><span className="agent-node-kind">Agent{wave ? ` · wave ${wave}` : ""} · {STATUS_LABEL[status]}</span><strong>{data.title || "Untitled"}</strong>
      <button type="button" aria-label="Close dashboard" autoFocus onClick={onClose}><X size={14} /></button></header>
    <dl>
      <div><dt>Model</dt><dd>{modelLabel}{data.effort ? ` · ${data.effort} thinking (not applied yet)` : ""}</dd></div>
      <div><dt>Waits for</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "Nobody: the Mother starts it"}</dd></div>
      <div><dt>Feeds</dt><dd>{feeds.length ? feeds.join(", ") : "The Mother's report"}</dd></div>
      <div><dt>May write</dt><dd>{data.writeScopes.length ? data.writeScopes.join(", ") : "No folder yet: choose one before the run"}</dd></div>
      <div><dt>Prompt</dt><dd>{data.instruction || "No prompt yet: write one before the run"}</dd></div>
      <div><dt>Done when</dt><dd>{(data.acceptanceCriteria.length ? data.acceptanceCriteria : [DONE]).join("; ")}</dd></div>
      <div><dt>Its check</dt><dd>{CHECK_LABEL[check]}</dd></div>
    </dl>
    <LiveFeed chat={chat} working={status === "running"} idle="Not started. What it does shows here once the graph runs." />
    {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
  </div>;
}

/** The agents canvas: the Mother, ready-made architectures, agents wired by what they wait for and laid out in Kahn's
 * waves, and a run that follows each agent live. The graph is kept on this device (lib/canvas.ts). */
/** `projectMenu` is the app's project chooser (components/project-picker.tsx), shown in the header: agents write inside the project. */
type Props = { models: Model[]; cwd?: string; dark: boolean; onOpenChat: (id: string) => void; projectMenu?: React.ReactNode };
export function AgentsCanvas(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

/** Models listed by a provider other than the engine's own, fetched once per provider and settings version. */
const catalogs = new Map<string, { version: string; models?: Model[]; error?: string }>();

function Canvas({ models, cwd, dark, onOpenChat, projectMenu }: Props) {
  const flow = useReactFlow(), board = useRef<HTMLDivElement>(null), pointer = useRef<XYPosition | null>(null), connectFrom = useRef<XYPosition | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>(() => readGraph() ?? { ...withMother(TEMPLATES[0].build()), template: TEMPLATES[0].id });
  // What is selected is kept apart from the saved graph: a click picks one, Shift+click or Shift+drag several.
  const [selection, setSelection] = useState<string[]>([]), [dashboardId, setDashboardId] = useState<string | null>(null);
  const [menu, setMenu] = useState<BoardMenu | null>(null), wireMenu = menu?.kind === "wire" ? menu : null;
  // The side panel folds away to give the board the whole width, remembered on this device; choosing an agent or the
  // Mother brings it back.
  const [panelOpen, setPanelOpen] = useState(() => { try { return appStorage().getItem("elpis-canvas-panel") !== "closed"; } catch { return true; } });
  const showPanel = (open: boolean) => { setPanelOpen(open); try { appStorage().setItem("elpis-canvas-panel", open ? "open" : "closed"); } catch { /* kept for this session only */ } setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  useEffect(() => { if (selection.length && !panelOpen) showPanel(true); }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = useProjectFolders(cwd);
  const [notice, setNotice] = useState("");
  const [maxAtOnce, setMaxAtOnce] = useState(3);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [run, setRun] = useState<Run | null>(null), [starting, setStarting] = useState(false);
  const [states, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null }>>({});
  // The run log, as Deus Ex's event cards: what started, finished, passed its check or failed, newest last.
  type LogLine = { at: number; text: string; tone: "start" | "done" | "fail" };
  const [log, setLog] = useState<LogLine[]>([]);
  const said = useRef<Record<string, TaskStatus>>({});
  const [, setFetched] = useState(0);
  const settings = useElpisSettings().data;
  // What Elpis allows: agents in one graph, and at once (bridge/elpis-features.mjs `agentLimits`).
  const allowed = settings?.agents ?? { graph: 256, atOnce: 6, source: "Elpis default" };
  useEffect(() => { const timer = setTimeout(() => { if (!saveGraph(graph)) setNotice("Could not keep the graph on this device."); }, 300); return () => clearTimeout(timer); }, [graph]);
  // A change made just before the window closes or reloads is kept too: the page saves the latest board on its way out.
  const latest = useRef(graph); latest.current = graph;
  useEffect(() => { const flush = () => saveGraph(latest.current); window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush); return () => { flush(); window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); }; }, []);

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
    if (!run || over(run)) return;
    let live = true;
    const read = async (threadId: string, graphId: string) => {
      const listed = await api<Listed>(`/workflows?threadId=${encodeURIComponent(threadId)}`), found = listed.data.find(item => item.id === graphId);
      if (found && live) {
        setStates(current => ({ ...current, ...Object.fromEntries(found.tasks.map(task => [task.id, { status: task.status, chat: task.assignedThreadId }])) }));
        const lines = found.tasks.flatMap(task => {
          if (said.current[task.id] === task.status) return [];
          said.current[task.id] = task.status;
          const check = task.id.endsWith("-check"), who = titleOf(check ? task.id.slice(0, -"-check".length) : task.id);
          const text = task.status === "running" ? (check ? `Checking ${who}` : `${who} started`) : task.status === "succeeded" ? (check ? `${who}: check passed` : `${who} finished`) : task.status === "failed" || task.status === "blocked" ? (check ? `${who}: check failed` : `${who} failed`) : "";
          return text ? [{ at: Date.now(), text, tone: task.status === "running" ? "start" as const : task.status === "succeeded" ? "done" as const : "fail" as const }] : [];
        });
        if (lines.length) setLog(current => [...current, ...lines].slice(-3));
      }
      return found?.status;
    };
    const poll = async () => {
      try {
        let next = run;
        if (!FINISHED.has(run.status)) { const status = await read(run.rootThreadId, run.graphId); if (status && status !== run.status) next = { ...next, status }; }
        const father = next.father;
        if (father?.threadId && father.graphId && !FINISHED.has(father.status)) { const status = await read(father.threadId, father.graphId); if (status && status !== father.status) next = { ...next, father: { ...father, status } }; }
        // Her part done: the Father starts his, in his own chat; if hers failed, his never starts.
        if (father && !father.threadId && FINISHED.has(next.status)) next = { ...next, father: next.status === "succeeded" || next.status === "completed" ? await startFather(father.tasks) : { ...father, status: "cancelled" } };
        if (live && next !== run) setRun(over(next) ? { ...next, endedAt: Date.now() } : next);
      } catch (error) { if (live) setNotice(error instanceof Error ? error.message : String(error)); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [run]);

  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  const chosen = agents.filter(node => selection.includes(node.id)), selected = chosen.length === 1 ? chosen[0] : undefined;
  const motherOpen = selection.length === 1 && selection[0] === MOTHER, mother = graph.mother ?? { brief: "", model: null, provider: null };
  const setMother = (patch: Partial<MotherSettings>) => setGraph(current => ({ ...current, mother: { ...(current.mother ?? { brief: "", model: null, provider: null }), ...patch } }));
  // Loading an architecture replaces the board; Undo, offered for a while, puts the old one back.
  const [undoLoad, setUndoLoad] = useState<{ loaded: string; previous: CanvasGraph } | null>(null);
  useEffect(() => { if (!undoLoad) return; const timer = setTimeout(() => setUndoLoad(null), 12000); return () => clearTimeout(timer); }, [undoLoad]);
  const shapes = useMemo(() => new Map(TEMPLATES.map(template => [template.id, shapeOf(template.build())])), []);
  const limit = maxAgents(graph), room = Math.max(0, limit - agents.length), order = useMemo(() => waves(graph), [graph]);
  // An agent is done once its check passes.
  const done = agents.filter(node => states[checkOf(node.id)]?.status === "succeeded").length;
  const runState: MotherData["run"] = run ? (FINISHED.has(run.status) ? "finished" : "running") : "idle";
  const fatherState: MotherData["run"] = run?.father?.threadId ? (FINISHED.has(run.father.status) ? "finished" : "running") : "idle";
  const modelLabel = (data: AgentData) => {
    if (!data.model) return "Default model";
    const found = catalog.find(item => item.model === data.model && item.provider === (data.provider ?? null)) ?? (data.provider ? undefined : models.map(model => ({ label: model.displayName || model.model, model: model.model })).find(item => item.model === data.model));
    return found?.label ?? data.model;
  };
  const setText = (id: string, text: string) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id && node.type === "note" ? { ...node, data: { text } } : node) }));
  // A click on a dot (no drag) opens the command bar there; the new agents take that side of it.
  const onHandle = (id: string, end: HandleEnd, event: ReactMouseEvent) => { event.stopPropagation(); openAdder({ x: event.clientX, y: event.clientY }, { id, as: end === "source" ? "target" : "source" }); };
  // The Father, when the graph has more agents than the Mother runs: drawn left of the first agents he starts.
  // The critical path, highlighted on the board while the pointer is on it in the run order.
  const critical = useMemo(() => criticalPath(graph), [graph]), [showCritical, setShowCritical] = useState(false);
  const split = useMemo(() => parents(graph), [graph]), his = new Set(split.father);
  // React Flow shows a node once its size is known; the Father is not in the saved board, so his size is kept here.
  const [fatherSize, setFatherSize] = useState<{ width: number; height: number } | null>(null);
  const fatherRoots = agents.filter(node => his.has(node.id) && !graph.edges.some(edge => edge.target === node.id && his.has(edge.source)));
  const fatherNode: Node | null = fatherRoots.length ? { id: FATHER, type: "father", deletable: false, selectable: false, draggable: false,
    position: { x: Math.min(...fatherRoots.map(node => node.position.x)) - 260, y: Math.round(fatherRoots.reduce((sum, node) => sum + node.position.y, 0) / fatherRoots.length) },
    ...(fatherSize ? { measured: fatherSize } : {}), data: { run: fatherState, children: split.father.length, limit } satisfies MotherData } : null;
  const nodesWithFather = (list: Node[]) => fatherNode ? [...list, fatherNode] : list;
  const nodes = useMemo<Node[]>(() => nodesWithFather(graph.nodes.map(node => node.type === "mother"
    ? { ...node, deletable: false, selected: selection.includes(MOTHER), data: { run: runState, children: agents.length, limit, onHandle } satisfies MotherData }
    : { ...node, selected: selection.includes(node.id), data: node.type === "agent" ? { ...node.data, status: states[node.id]?.status, check: states[checkOf(node.id)]?.status, modelLabel: modelLabel(node.data), wave: order.get(node.id), onHandle } : { ...node.data, onText: setText } }),
  ), [graph.nodes, selection, states, models, order, runState, fatherState, limit, catalog.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo<Edge[]>(() => [
    // The Mother's wires: she starts every agent of the first wave.
    ...agents.filter(node => order.get(node.id) === 1 && !his.has(node.id)).map(node => ({ id: `${MOTHER}->${node.id}`, source: MOTHER, target: node.id, type: "flow", className: "canvas-edge-mother", selectable: false, deletable: false, focusable: false, selected: wireMenu?.edge.id === `${MOTHER}->${node.id}`, data: { live: states[node.id]?.status === "running" } })),
    // The Father's wires: he starts his agents that wait for none of his others.
    ...fatherRoots.map(node => ({ id: `${FATHER}->${node.id}`, source: FATHER, target: node.id, type: "flow", className: "canvas-edge-mother", selectable: false, deletable: false, focusable: false, interactionWidth: 0, data: { live: states[node.id]?.status === "running" } })),
    ...graph.edges.map(edge => {
      // A wire goes live once its first agent's check passed and the second agent is running.
      const from = states[checkOf(edge.source)]?.status, to = states[edge.target]?.status, live = from === "succeeded" && to === "running";
      const onPath = showCritical && critical.includes(edge.source) && critical[critical.indexOf(edge.source) + 1] === edge.target;
      return { ...edge, type: "flow", selected: wireMenu?.edge.id === edge.id || onPath, data: { live }, className: from === "failed" || to === "blocked" ? "canvas-edge-cut" : live ? "canvas-edge-live" : from === "succeeded" ? "canvas-edge-done" : undefined };
    }),
  ], [graph.edges, graph.nodes, states, order, wireMenu, showCritical]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set(changes.flatMap(change => change.type === "remove" && change.id !== MOTHER ? [change.id] : []));
    for (const change of changes) if (change.type === "dimensions" && change.id === FATHER && change.dimensions) setFatherSize(change.dimensions);
    const picks = changes.flatMap(change => change.type === "select" ? [change] : []);
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
  const addAgents = (count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, where: Partial<Pick<Adding, "at" | "from" | "between">> = {}, tasks: string[] = []) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    const { from, between } = where, made = newAgents(Math.min(count, room), choice, place(where.at), tasks);
    const wire = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
    // On a wire, the new agents take its place: each waits for its first agent and feeds its second. From a dot or a
    // dropped wire, they join that agent. The Mother's wires are implied, never drawn.
    const wires = between ? made.flatMap(node => [...(between.source === MOTHER ? [] : [wire(between.source, node.id)]), wire(node.id, between.target)])
      : from && from.id !== MOTHER ? made.map(node => from.as === "target" ? wire(from.id, node.id) : wire(node.id, from.id)) : [];
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...made], edges: [...current.edges.filter(edge => edge.id !== between?.id), ...wires] }));
    setSelection(made.map(node => node.id));
    // New agents that landed outside the view are brought into it, at the same zoom.
    setTimeout(() => {
      const box = board.current?.querySelector(".react-flow")?.getBoundingClientRect();
      if (!box) return;
      const outside = made.some(node => { const start = flow.flowToScreenPosition(node.position), end = flow.flowToScreenPosition({ x: node.position.x + 190, y: node.position.y + 80 }); return start.x < box.left || start.y < box.top || end.x > box.right || end.y > box.bottom; });
      if (outside) void flow.fitView({ nodes: made.map(node => ({ id: node.id })), padding: 0.4, maxZoom: flow.getZoom(), minZoom: Math.min(flow.getZoom(), 0.6), duration: 250 });
    }, 60);
    setNotice(count > room ? `Added ${room}: the limit is ${limit} agents.` : "");
  };
  const addNote = (at?: XYPosition, text = "") => { const { x, y } = place(at); setGraph(current => ({ ...current, nodes: [...current.nodes, { id: newId("note"), type: "note", position: { x, y }, data: { text } }] })); };
  // The command bar opens where the pointer is (Tab), where the board was double-clicked, at a clicked dot or
  // where a wire was let go, kept inside the board.
  const openAdder = (client?: XYPosition, from?: Adding["from"], between?: CanvasEdge, seed?: string) => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return;
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 }, wanted = client ?? pointer.current ?? middle;
    const point = wanted.x >= box.left && wanted.x <= box.right && wanted.y >= box.top && wanted.y <= box.bottom ? wanted : middle;
    // From a dot, the agents go beside it, on the side they connect to.
    const spot = flow.screenToFlowPosition(point), at = from ? { x: spot.x + (from.as === "target" ? 80 : -300), y: spot.y - 40 } : { x: spot.x - (between ? 95 : 0), y: spot.y - 40 };
    // Kept inside the board: as low as the pointer allows, never past the bottom edge (the list scrolls instead).
    const top = Math.max(8, Math.min(point.y - box.top, box.height - 440));
    setAdding({ at, left: Math.max(8, Math.min(point.x - box.left, box.width - 348)), top, height: box.height - top - 8, ...(from ? { from } : {}), ...(between ? { between } : {}), ...(seed ? { seed } : {}) }); setMenu(null);
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
      const onBoard = !target || target === document.body || Boolean(target.closest?.(".react-flow")), ctrl = event.ctrlKey || event.metaKey;
      // event.code, so it works in any keyboard layout; never inside a field, where Ctrl+A selects the text. On the board
      // Ctrl+A selects every agent and note, as in every editor.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyA" && !typing) { event.preventDefault(); setSelection(graph.nodes.filter(node => node.type !== "mother").map(node => node.id)); }
      else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.shiftKey && onBoard && !typing) { event.preventDefault(); openAdder(); }
      // As AutoCAD's command line: Space opens it, and typing on the board starts a command with that key.
      else if (event.key === " " && !ctrl && !event.altKey && onBoard && !typing) { event.preventDefault(); openAdder(); }
      else if (event.key.length === 1 && !ctrl && !event.altKey && onBoard && !typing && !adding) { event.preventDefault(); openAdder(undefined, undefined, undefined, event.key); }
      else if (event.key === "Enter" && selected && onBoard && !typing && !adding) { event.preventDefault(); setDashboardId(selected.id); }
      else if (typing || event.altKey) return;
      // The board's own keys, by event.code so any keyboard layout works; in a field they stay the field's.
      else if (ctrl && event.code === "KeyZ") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyY") { event.preventDefault(); redo(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyC" && selection.length) { event.preventDefault(); copy(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyV" && clipboard.current) { event.preventDefault(); paste(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyD" && selection.length) { event.preventDefault(); duplicate(); }
      // Before React Flow's own Delete, which would drop the wires.
      else if (ctrl && event.key === "Delete" && selection.length) { event.preventDefault(); event.stopPropagation(); removeKeepingFlow(selection); }
      else if (!ctrl && event.key === "Home") { event.preventDefault(); fitAll(); }
      else if (!ctrl && event.key === "F2" && selected) { event.preventDefault(); rename(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });
  const loadTemplate = (template: (typeof TEMPLATES)[number]) => { setUndoLoad({ loaded: template.name, previous: graph }); setGraph(current => ({ ...withMother(template.build()), maxAgents: current.maxAgents, mother: current.mother, template: template.id })); setSelection([]); setMenu(null); setDashboardId(null); setRun(null); setStates({}); setNotice("");
    // Keys go to the board again (Tab opens the command bar), not to the template just clicked.
    (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  const tidy = () => { setGraph(current => arrange(current)); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  const dashboard = agents.find(node => node.id === dashboardId);
  // Edits apply to every selected agent: one in the inspector, several together.
  const editEach = (change: (data: AgentData) => Partial<AgentData>) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.type === "agent" && chosen.some(item => item.id === node.id) ? { ...node, data: { ...node.data, ...change(node.data) } } : node) }));
  const edit = (patch: Partial<AgentData>) => editEach(() => patch);
  // Several agents share the folders they all may write; adding or removing one changes it for each.
  const commonFolders = chosen.reduce<string[]>((common, node, index) => index ? common.filter(folder => node.data.writeScopes.includes(folder)) : node.data.writeScopes, []);
  const setCommonFolders = (next: string[]) => editEach(data => ({ writeScopes: [...data.writeScopes.filter(folder => !commonFolders.includes(folder) || next.includes(folder)), ...next.filter(folder => !data.writeScopes.includes(folder))] }));
  const remove = (ids: string[]) => { setGraph(current => ({ ...current, nodes: current.nodes.filter(node => !ids.includes(node.id)), edges: current.edges.filter(edge => !ids.includes(edge.source) && !ids.includes(edge.target)) })); setSelection([]); };
  const removeWire = (id: string) => { setGraph(current => ({ ...current, edges: current.edges.filter(edge => edge.id !== id) })); setMenu(null); };
  // The mouse as in DaVinci's Fusion and 3ds Max's Slate: left-drag on empty board draws a selection box, middle-drag
  // pans, the wheel zooms at the pointer, and agents snap to a 20 px grid. A plain click picks that one node even
  // inside a selection; Shift or Ctrl adds or removes it; a press moves nodes only past 5 px, so a hand's wobble is a
  // click. React Flow's Shift-to-box key is off: it turned every Shift+click into an empty box that dropped the selection.
  const dragged = useRef(false);
  const onNodeClick = (event: ReactMouseEvent, node: Node) => {
    if (dragged.current || event.shiftKey || event.ctrlKey || event.metaKey) return;
    setSelection([node.id]);
  };
  // Menus open where the board was clicked, kept inside it.
  const menuAt = (event: { clientX: number; clientY: number }, rows: number): MenuAt | null => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return null;
    setAdding(null);
    return { client: { x: event.clientX, y: event.clientY }, left: Math.max(8, Math.min(event.clientX - box.left, box.width - 348)), top: Math.max(8, Math.min(event.clientY - box.top + 10, box.height - 60 - rows * 46)) };
  };
  const onEdgeClick = (event: ReactMouseEvent, edge: Edge) => { if (edge.source === FATHER) return; const at = menuAt(event, 2); if (at) setMenu({ ...at, kind: "wire", edge: { id: edge.id, source: edge.source, target: edge.target } }); };
  // A right-click on a node acts on the selection it belongs to, else on that node alone.
  const onNodeContextMenu = (event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    if (node.id === FATHER) return;
    if (node.id === MOTHER) { const at = menuAt(event, 2); if (at) setMenu({ ...at, kind: "mother" }); return; }
    const ids = selection.includes(node.id) ? selection.filter(id => id !== MOTHER) : [node.id];
    if (!selection.includes(node.id)) setSelection([node.id]);
    const at = menuAt(event, ids.length > 1 ? 4 : 7); if (at) setMenu({ ...at, kind: "nodes", ids });
  };
  const onPaneContextMenu = (event: ReactMouseEvent | MouseEvent) => { event.preventDefault(); const at = menuAt(event, 5); if (at) setMenu({ ...at, kind: "board" }); };

  // Undo and redo (Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y): a burst of changes (typing a name, dragging an agent) is one step
  // once it settles.
  const history = useRef({ past: [] as CanvasGraph[], future: [] as CanvasGraph[], settled: graph, restoring: false });
  useEffect(() => {
    const steps = history.current;
    if (steps.restoring) { steps.restoring = false; steps.settled = graph; return; }
    if (graph === steps.settled) return;
    const timer = setTimeout(() => { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; steps.settled = graph; }, 350);
    return () => clearTimeout(timer);
  }, [graph]);
  const restore = (next: CanvasGraph) => { history.current.restoring = true; setGraph(next); setSelection(current => current.filter(id => next.nodes.some(node => node.id === id))); setMenu(null); };
  const undo = () => {
    const steps = history.current;
    // Changes not yet settled are the step undone.
    if (graph !== steps.settled) { steps.future = [graph]; restore(steps.settled); return; }
    const previous = steps.past.pop();
    if (previous) { steps.future.push(graph); restore(previous); }
  };
  const redo = () => { const steps = history.current, next = steps.future.pop(); if (next) { steps.past.push(graph); restore(next); } };

  // The clipboard (Ctrl+C, Ctrl+V): agents and notes with the wires among them, pasted as new ones; Ctrl+D duplicates
  // without touching it. As in Blender and Node-RED, no wire joins a copy to an original.
  const clipboard = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[] } | null>(null);
  const takeOut = (ids: string[]) => {
    const nodes = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)), kept = new Set(nodes.map(node => node.id));
    return { nodes, edges: graph.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target)) };
  };
  // Pasted where asked (the pointer, or where the menu opened); a duplicate takes the nearest free spot, never on top
  // of its original.
  const putIn = (clip: { nodes: CanvasNode[]; edges: CanvasEdge[] }, at?: XYPosition) => {
    if (!clip.nodes.length) return;
    const count = clip.nodes.filter(node => node.type === "agent").length;
    if (count > room) { setNotice(`Only ${room} more ${room === 1 ? "agent fits" : "agents fit"} under the limit of ${limit}. Raise Max agents to add more.`); return; }
    const left = Math.min(...clip.nodes.map(node => node.position.x)), top = Math.min(...clip.nodes.map(node => node.position.y)), origin = at ?? place({ x: left, y: top + 100 });
    const ids = new Map(clip.nodes.map(node => [node.id, newId(node.type)]));
    const nodes = clip.nodes.map(node => ({ ...node, id: ids.get(node.id)!, position: { x: Math.round(node.position.x - left + origin.x), y: Math.round(node.position.y - top + origin.y) } }) as CanvasNode);
    const edges = clip.edges.map(edge => ({ id: `${ids.get(edge.source)}->${ids.get(edge.target)}`, source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges] }));
    setSelection(nodes.map(node => node.id));
  };
  const copy = (ids = selection) => { const clip = takeOut(ids); if (clip.nodes.length) clipboard.current = clip; };
  const paste = (at?: XYPosition) => { if (clipboard.current) putIn(clipboard.current, at ?? (pointer.current ? flow.screenToFlowPosition(pointer.current) : undefined)); };
  const duplicate = (ids = selection) => putIn(takeOut(ids));
  // Delete keeping the flow (Ctrl+Delete), as in Blender and Node-RED: what waited for a deleted agent now waits for
  // what that one waited for.
  const removeKeepingFlow = (ids: string[]) => {
    const gone = new Set(ids.filter(id => id !== MOTHER));
    setGraph(current => {
      const kept = current.edges.filter(edge => !gone.has(edge.source) && !gone.has(edge.target));
      const before = (id: string): string[] => current.edges.filter(edge => edge.target === id).flatMap(edge => gone.has(edge.source) ? before(edge.source) : [edge.source]);
      const bridged = current.edges.filter(edge => gone.has(edge.source) && !gone.has(edge.target)).flatMap(edge => before(edge.source).map(source => ({ id: `${source}->${edge.target}`, source, target: edge.target })));
      const fresh = bridged.filter((edge, index) => !kept.some(item => item.source === edge.source && item.target === edge.target) && bridged.findIndex(item => item.id === edge.id) === index);
      return { ...current, nodes: current.nodes.filter(node => !gone.has(node.id)), edges: [...kept, ...fresh] };
    });
    setSelection([]);
  };
  const fitAll = () => void flow.fitView({ ...FIT, duration: 250 });
  // F2 renames: the inspector's name field takes the keys, the name selected.
  const nameField = useRef<HTMLInputElement>(null);
  const rename = () => { const take = () => { nameField.current?.focus(); nameField.current?.select(); }; if (nameField.current) take(); else setTimeout(take, 0); };
  const describe = (count: number, notes: number) => [count && `${count} ${count === 1 ? "agent" : "agents"}`, notes && `${notes} ${notes === 1 ? "note" : "notes"}`].filter(Boolean).join(" and ");
  const menuView = (current: BoardMenu): { name: string; title: string; detail?: string; items: MenuItem[]; onDelete?: () => void } => {
    if (current.kind === "wire") {
      const from = current.edge.source === MOTHER ? null : titleOf(current.edge.source), to = titleOf(current.edge.target);
      const removeIt = from ? () => removeWire(current.edge.id) : undefined;
      return { name: "Wire", title: "Wire", detail: `${from ?? "Mother"} → ${to}`, onDelete: removeIt, items: [
        { label: "Insert agents here", hint: from ? `Between ${from} and ${to}` : `Before ${to}, started by the Mother`, take: () => openAdder(current.client, undefined, current.edge) },
        ...(removeIt ? [{ label: "Remove wire", hint: `${to} stops waiting for ${from}`, keys: "Delete", take: removeIt }] : [])] };
    }
    if (current.kind === "mother") return { name: "Mother", title: "Mother", detail: "the run's chat", items: [
      { label: "Run settings", hint: "The brief, her model, how many agents", take: () => setSelection([MOTHER]) },
      { label: "Add agents she starts", take: () => openAdder(current.client, { id: MOTHER, as: "target" }) }] };
    if (current.kind === "board") {
      const clip = clipboard.current, inClip = clip?.nodes.filter(node => node.type === "agent").length ?? 0;
      return { name: "Board", title: "Board", items: [
        { label: "Add agents", keys: "Tab", take: () => openAdder(current.client) },
        { label: "Add a note", take: () => addNote(flow.screenToFlowPosition(current.client)) },
        ...(clip ? [{ label: `Paste ${describe(inClip, clip.nodes.length - inClip)}`, keys: "Ctrl+V", take: () => paste(flow.screenToFlowPosition(current.client)) }] : []),
        { label: "Arrange by run order", take: tidy },
        { label: "Fit the view", keys: "Home", take: fitAll }] };
    }
    const ids = current.ids, picked = graph.nodes.filter(node => ids.includes(node.id)), count = picked.filter(node => node.type === "agent").length;
    const removeThem = () => remove(ids);
    if (picked.length === 1 && picked[0].type === "agent") {
      const only = picked[0];
      return { name: `Agent ${only.data.title || "Untitled"}`, title: "Agent", detail: only.data.title || "Untitled", onDelete: removeThem, items: [
        { label: "Dashboard", keys: "Enter", take: () => setDashboardId(only.id) },
        { label: "Rename", keys: "F2", take: rename },
        { label: "Add agents after it", hint: "They wait for it", take: () => openAdder(current.client, { id: only.id, as: "target" }) },
        { label: "Duplicate", keys: "Ctrl+D", take: () => duplicate(ids) },
        { label: "Copy", keys: "Ctrl+C", take: () => copy(ids) },
        { label: "Delete, keep the flow", hint: "What waited for it waits for what it waited for", keys: "Ctrl+Del", take: () => removeKeepingFlow(ids) },
        { label: "Delete", keys: "Delete", take: removeThem }] };
    }
    const what = describe(count, picked.length - count);
    return { name: what, title: what, onDelete: removeThem, items: [
      { label: `Duplicate ${what}`, keys: "Ctrl+D", take: () => duplicate(ids) },
      { label: `Copy ${what}`, keys: "Ctrl+C", take: () => copy(ids) },
      ...(count ? [{ label: "Delete, keep the flow", keys: "Ctrl+Del", take: () => removeKeepingFlow(ids) }] : []),
      { label: `Delete ${what}`, keys: "Delete", take: removeThem }] };
  };
  const titleOf = (id: string) => agents.find(node => node.id === id)?.data.title || "Untitled";
  // Kahn's waves, for the run-order list: what starts together, and how each wave is doing.
  const columns = [...new Set(order.values())].sort((a, b) => a - b).map(level => ({ level, members: agents.filter(node => order.get(node.id) === level) }));
  const waveState = (members: typeof agents) => { const of = (node: (typeof agents)[number]) => [states[node.id]?.status, states[checkOf(node.id)]?.status];
    return members.some(node => of(node).includes("running")) ? "running" : members.length && members.every(node => of(node)[1] === "succeeded") ? "succeeded" : members.some(node => of(node).some(status => status === "failed" || status === "blocked")) ? "failed" : undefined; };
  const choiceKey = (data: AgentData) => data.model ? `${data.provider ?? ""}|${data.model}` : "";
  const shared = (key: (data: AgentData) => string) => new Set(chosen.map(node => key(node.data))).size === 1 ? key(chosen[0].data) : "mixed";
  const modelPatch = (value: string): Partial<AgentData> => { const [provider, ...rest] = value.split("|"); return value ? { provider: provider || null, model: rest.join("|"), effort: null } : { provider: null, model: null, effort: null }; };
  const modelOptions = [<option key="" value="">Default model</option>, ...catalog.map(item => <option key={`${item.provider}|${item.model}`} value={`${item.provider ?? ""}|${item.model}`} data-hint={item.providerLabel}>{item.label}</option>)];
  const mixed = <option value="mixed" disabled>Mixed</option>;
  const selectedModel = selected ? catalog.find(item => item.model === selected.data.model && item.provider === (selected.data.provider ?? null)) : undefined;

  // "Let Elpis handle it": a fast model designs the team from a goal, or does what was typed (POST /api/canvas/plan,
  // bridge/canvas-plan.mjs). The board it returns replaces this one in one step, so Ctrl+Z undoes it.
  const [planning, setPlanning] = useState("");
  const [needProject, setNeedProject] = useState(false);
  useEffect(() => { if (cwd) setNeedProject(false); }, [cwd]);
  async function letElpis(goal: string): Promise<CanvasGraph | null> {
    if (!cwd) { setNeedProject(true); setNotice("Choose the project the agents work in, then try again."); return null; }
    setPlanning(goal); setNotice(""); setMenu(null);
    try {
      const plan = await api<Plan>("/canvas/plan", { goal, cwd, folders: project.folders ?? [], agents: boardForPlan(graph), maxAgents: limit });
      const next = applyPlan(graph, plan);
      setGraph(next); setSelection([]);
      setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
      return next;
    } catch (error) { setNotice(`Elpis could not fill in the team: ${error instanceof Error ? error.message : String(error)}`); return null; }
    finally { setPlanning(""); }
  }

  // The Father's part: his own chat, on her model, told who he is; it starts once hers has succeeded.
  async function startFather(tasks: RunTask[]): Promise<NonNullable<Run["father"]>> {
    const goal = mother.brief.trim();
    const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: `Father · ${graph.name || "Agents canvas"}`.slice(0, 120),
      ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}),
      instructions: [goal && `Goal of the whole run: ${goal}`, "You are the Father: you run the agents past the Mother's ten, after her part has succeeded, and you report to her."].filter(Boolean).join("\n\n") });
    const result = await api<{ graphId: string }>("/workflows/run", { rootThreadId: created.thread.id, name: `Father · ${graph.name || "Agents canvas"}`, tasks, maxConcurrency: Math.max(1, Math.min(maxAtOnce, allowed.atOnce)) });
    return { tasks, threadId: created.thread.id, graphId: result.graphId, status: "running" };
  }

  async function start() {
    // Agents work inside a project: without one, the notice offers the project menu right there.
    if (!cwd) { setNeedProject(true); setNotice("Choose the project the agents work in, then run again."); return; }
    // Prompts and folders left empty are Elpis's to fill: from the run's goal, or, with none written, from the team as
    // drawn. A run never stops for a missing goal.
    const empty = agents.some(node => !node.data.instruction.trim() || !node.data.writeScopes.length);
    const ready = empty ? await letElpis(mother.brief.trim() || DRAWN) : graph;
    if (!ready) return;
    const built = runParts(ready);
    if ("error" in built) { setNotice(built.error); return; }
    setStarting(true); setNotice(""); setStates({}); setLog([]); said.current = {};
    try {
      // The Mother is the run's chat: her model, and the goal as her instructions.
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: ready.name.slice(0, 120) || "Agents canvas",
        ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}), ...(mother.brief.trim() ? { instructions: mother.brief.trim() } : {}) });
      const result = await api<{ graphId: string }>("/workflows/run", { rootThreadId: created.thread.id, name: ready.name || "Agents canvas", tasks: built.mother, maxConcurrency: Math.max(1, Math.min(maxAtOnce, allowed.atOnce)) });
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running", startedAt: Date.now(), ...(built.father.length ? { father: { tasks: built.father, status: "pending" } } : {}) });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  }

  const chat = selected ? states[selected.id]?.chat : null;
  // The isometric view (components/agents-iso.tsx) takes the board's place for watching a run; editing stays flat.
  const [iso, setIso] = useState(false);
  return <section className="agents-canvas" aria-label="Agents canvas" data-panel={panelOpen ? "open" : "closed"}>
    <header className="canvas-header">
      <Input aria-label="Graph name" className="canvas-name" value={graph.name} maxLength={120} onChange={event => setGraph(current => ({ ...current, name: event.target.value }))} />
      {projectMenu}
      {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={over(run) ? run.father?.status ?? run.status : "running"} />{over(run) ? "Finished" : run.father?.threadId ? "Running · the Father's part" : "Running"} · {done} of {agents.length} done</span>}
      <span className="canvas-spacer" />
      <ViewToggle iso={iso} onChange={setIso} />
      {run && <Button variant="ghost" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open run chat</Button>}
      <Button variant="ghost" size="sm" aria-pressed={motherOpen} onClick={() => setSelection([MOTHER])} title="The run's settings: the brief every agent gets, her model, how many agents"><i className="canvas-kind" data-kind="mother" />Mother</Button>
      <Button variant="ghost" size="sm" onClick={tidy} title="Arrange by run order: Kahn's waves, each column starting once the columns before it are done"><ListOrdered size={14} />Arrange</Button>
      <Button variant="ghost" size="sm" aria-label="Side panel" aria-pressed={panelOpen} title={panelOpen ? "Hide the side panel: the board takes the whole width" : "Show the side panel: patterns, run order, the selected agent"} onClick={() => showPanel(!panelOpen)}>{panelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}</Button>
      <Button size="sm" onClick={() => void start()} disabled={starting || Boolean(run && !over(run))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
    </header>
    <div className="canvas-board" ref={board} onPointerMove={event => { pointer.current = { x: event.clientX, y: event.clientY }; }}
      // A double-click on empty board, whichever layer React Flow put under the pointer, opens the command line there.
      onDoubleClick={event => { const target = event.target as Element; if (target.closest(".react-flow") && !target.closest(".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap")) openAdder({ x: event.clientX, y: event.clientY }); }}>
      {iso ? <IsoBoard graph={graph} states={states} selected={selection} onSelect={setSelection} onOpen={setDashboardId} dark={dark} /> : <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onConnectEnd={onConnectEnd}
        onConnectStart={event => { const spot = "touches" in event ? event.touches[0] : event; connectFrom.current = { x: spot.clientX, y: spot.clientY }; }} connectOnClick={false}
        onNodeDoubleClick={(_, node) => { if (node.type === "agent") setDashboardId(node.id); }}
        onEdgeClick={onEdgeClick} onEdgeContextMenu={(event, edge) => { event.preventDefault(); onEdgeClick(event, edge); }} onNodeContextMenu={onNodeContextMenu} onPaneContextMenu={onPaneContextMenu} multiSelectionKeyCode={["Shift", "Control", "Meta"]} nodeDragThreshold={5} nodeClickDistance={5} paneClickDistance={5} selectionKeyCode={null} selectionOnDrag panOnDrag={[1]} panActivationKeyCode={null} snapToGrid snapGrid={[20, 20]} connectionRadius={32} onNodeClick={onNodeClick}
        onNodeDragStart={() => { dragged.current = true; }} onNodeDragStop={() => setTimeout(() => { dragged.current = false; })}
        onPaneClick={() => { setSelection([]); setMenu(null); }} deleteKeyCode={["Backspace", "Delete"]} zoomOnDoubleClick={false} colorMode={dark ? "dark" : "light"} fitView fitViewOptions={FIT} minZoom={0.3} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="canvas-minimap" style={{ width: 150, height: 100 }} />
        {run && <Panel position="top-right" className="canvas-hud" aria-label="Run clock"><span>{over(run) ? (run.status === "succeeded" || run.status === "completed" ? "Run done" : "Run ended") : "Running"}</span><RunClock since={run.startedAt} until={run.endedAt} /></Panel>}
        {run && log.length > 0 && <Panel position="bottom-left" className="canvas-log-panel"><ol className="canvas-log" aria-label="Run log">{log.map((line, index) => <li key={`${line.at}-${index}`} data-tone={line.tone}><time>+{clock(line.at - run.startedAt)}</time>{line.text}</li>)}</ol></Panel>}
      </ReactFlow>}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <div className="canvas-toolbar" role="toolbar" aria-label="Add to the canvas">
        <span className="canvas-toolbar-label">Add</span>
        <Button variant="ghost" size="sm" aria-label="Add agent" title="An agent that writes: give it a prompt and the folders it may write; Elpis checks its work after it" onClick={() => addAgents(1, { model: null })}><i className="canvas-kind" data-kind="agent" />Agent</Button>
        <Button variant="ghost" size="sm" onClick={() => addNote()}><StickyNote size={14} />Note</Button>
        <Button variant="ghost" size="sm" className="canvas-toolbar-more" onClick={() => openAdder()} title="Type a prompt, or how many, the model and thinking, then the prompts; a double-click or an agent's dot opens it too">Command <kbd>Tab</kbd></Button>
        {/* The keys, as Deus Ex's control strip shows them: a few, short; the rest are in each control's tooltip. */}
        <span className="canvas-toolbar-keys"><span><kbd>Enter</kbd>Dashboard</span><span><kbd>Shift</kbd>Select several</span><span><kbd>Ctrl+A</kbd>All</span></span>
      </div>
      {adding && <CommandBar adding={adding} room={room} limit={limit} catalog={catalog} providers={providers} onClose={() => setAdding(null)}
        onAgents={command => { addAgents(Math.max(1, command.count ?? 1), { model: command.model?.model ?? null, provider: command.model?.provider ?? null, effort: command.effort }, adding, command.tasks); setAdding(null); }}
        onNote={text => { addNote(adding.at, text); setAdding(null); }} onAsk={text => { setAdding(null); void letElpis(text); }} />}
      {menu && (view => <CanvasMenu at={menu} {...view} onClose={() => setMenu(null)} />)(menuView(menu))}
      {dashboard && <AgentDashboard node={dashboard} wave={order.get(dashboard.id)} status={states[dashboard.id]?.status ?? "idle"} check={states[checkOf(dashboard.id)]?.status ?? "idle"} chat={states[dashboard.id]?.chat ?? null} modelLabel={modelLabel(dashboard.data)}
        waitsFor={graph.edges.filter(edge => edge.target === dashboard.id).map(edge => titleOf(edge.source))} feeds={graph.edges.filter(edge => edge.source === dashboard.id).map(edge => titleOf(edge.target))}
        onOpenChat={onOpenChat} onClose={() => setDashboardId(null)} />}
      {planning && <p className="canvas-notice" data-tone="info" role="status">Elpis is on it: {planning.length > 60 ? `${planning.slice(0, 60)}…` : planning}</p>}
      {undoLoad && !notice && !planning && <p className="canvas-notice" data-tone="info" role="status">Loaded {undoLoad.loaded}.
        <Button variant="outline" size="sm" onClick={() => { setGraph(undoLoad.previous); setUndoLoad(null); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); }}>Undo</Button>
        <button type="button" aria-label="Dismiss" onClick={() => setUndoLoad(null)}><X size={13} /></button></p>}
      {notice && <p className="canvas-notice" role="alert">{notice}{needProject && !cwd && projectMenu}<button type="button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></button></p>}
    </div>
    {!panelOpen ? null : selected ? <aside className="canvas-side" aria-label="Selected agent">
      <p className="hud-menu-title">Agent{order.get(selected.id) ? ` · wave ${order.get(selected.id)}` : ""}{states[selected.id] ? ` · ${STATUS_LABEL[states[selected.id].status]}` : ""} · {CHECK_LABEL[states[checkOf(selected.id)]?.status ?? "idle"]}</p>
      <label>Name<Input ref={nameField} aria-label="Name" value={selected.data.title} maxLength={256} onChange={event => edit({ title: event.target.value })} /></label>
      <label>Prompt<Textarea aria-label="Prompt" rows={5} value={selected.data.instruction} placeholder="What this agent should do; left empty, Elpis fills it from the goal" onChange={event => edit({ instruction: event.target.value })} /></label>
      <label>Model<OptionSelect aria-label="Model" value={choiceKey(selected.data)} onChange={event => edit(modelPatch(event.target.value))}>
        {modelOptions}
        {selected.data.model && !selectedModel && <option value={choiceKey(selected.data)}>{selected.data.model}</option>}</OptionSelect></label>
      {selectedModel && selectedModel.efforts.length > 0 && <label>Thinking (kept; Elpis applies it per agent in a later engine build)<OptionSelect aria-label="Thinking" value={selected.data.effort ?? ""} onChange={event => edit({ effort: event.target.value || null })}>
        <option value="">Model default{selectedModel.defaultEffort ? ` (${selectedModel.defaultEffort})` : ""}</option>{selectedModel.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</OptionSelect></label>}
      <FolderPicker cwd={cwd} {...project} value={selected.data.writeScopes} onChange={writeScopes => edit({ writeScopes })} />
      <label>Done when (one per line; its check holds it to these)<Textarea aria-label="Done when" rows={3} value={selected.data.acceptanceCriteria.join("\n")} placeholder={DONE} onChange={event => edit({ acceptanceCriteria: lines(event.target.value) })} /></label>
      <div className="canvas-inspector-actions">
        <Button variant="outline" size="sm" onClick={() => setDashboardId(selected.id)}>Dashboard <kbd>Enter</kbd></Button>
        {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove([selected.id])}><Trash2 size={14} />Delete agent</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : chosen.length > 1 ? <aside className="canvas-side" aria-label="Selected agents">
      <p className="hud-menu-title">{chosen.length} agents selected</p>
      <p className="canvas-help">{chosen.map(node => node.data.title || "Untitled").join(", ")}</p>
      <label>Model<OptionSelect aria-label="Model" value={shared(choiceKey)} onChange={event => edit(modelPatch(event.target.value))}>{mixed}{modelOptions}</OptionSelect></label>
      <FolderPicker cwd={cwd} {...project} value={commonFolders} onChange={setCommonFolders} />
      <div className="canvas-inspector-actions">
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(chosen.map(node => node.id))}><Trash2 size={14} />Delete {chosen.length} agents <kbd>Delete</kbd></Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : motherOpen ? <aside className="canvas-side" aria-label="Mother">
      <p className="hud-menu-title">Mother · the run&rsquo;s chat</p>
      <p className="canvas-help">Every agent is her child: she starts the ones that wait for no one, and every report comes back to her. These settings apply to the whole run.</p>
      <label>Goal (every agent gets it)<Textarea aria-label="Goal" rows={4} value={mother.brief} placeholder="What should this run achieve? Elpis can design the team from it." onChange={event => setMother({ brief: event.target.value })} /></label>
      <Button size="sm" onClick={() => void letElpis(mother.brief)} disabled={!mother.brief.trim() || Boolean(planning)} title="Elpis designs the team from the goal: how many agents, their prompts, folders and wiring; Ctrl+Z undoes it">{planning ? "Elpis is designing…" : "Let Elpis design the team"}</Button>
      <label>Her model<OptionSelect aria-label="Her model" value={mother.model ? `${mother.provider ?? ""}|${mother.model}` : ""} onChange={event => { const patch = modelPatch(event.target.value); setMother({ model: patch.model ?? null, provider: patch.provider ?? null }); }}>{modelOptions}</OptionSelect></label>
      <div className="canvas-mother-counts">
        <CountField label="Max agents" value={limit} min={Math.max(1, agents.length)} max={Math.floor(allowed.graph / TASKS_PER_AGENT)} onChange={count => setGraph(current => ({ ...current, maxAgents: count }))}
          why={typed => typed > allowed.graph / TASKS_PER_AGENT ? `Elpis runs at most ${allowed.graph} tasks in a graph: ${Math.floor(allowed.graph / TASKS_PER_AGENT)} agents, each with its check.` : typed < agents.length ? `The graph already has ${agents.length} agents; remove some first.` : "Type a whole number from 1."} />
        <CountField label="At once" value={Math.min(maxAtOnce, allowed.atOnce)} min={1} max={allowed.atOnce} onChange={setMaxAtOnce}
          why={typed => typed > allowed.atOnce ? `Elpis allows ${allowed.atOnce} at once here (${allowed.source}).` : "At least 1 has to run."} />
      </div>
      {run && <p className="canvas-help" role="status">{(["running", "succeeded", "pending", "failed", "blocked"] as const).map(status => [status, agents.filter(node => states[node.id]?.status === status).length] as const).filter(([, count]) => count).map(([status, count]) => `${count} ${STATUS_LABEL[status]}`).join(" · ") || "Starting…"}</p>}
      {split.father.length > 0 && <p className="canvas-help" role="note">The Father runs {split.father.length} more {split.father.length === 1 ? "agent" : "agents"} in his own chat once her part has succeeded, and reports to her{run?.father ? `: ${run.father.threadId ? STATUS_LABEL[(run.father.status as TaskStatus)] ?? run.father.status : run.father.status === "cancelled" ? "not started, her part failed" : "waiting for her part"}` : "."}</p>}
      <LiveFeed chat={run?.rootThreadId ?? null} working={runState === "running"} idle="Not started. Every agent's report arrives here once the graph runs." />
      <div className="canvas-inspector-actions">
        {run && <Button variant="outline" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open her chat</Button>}
        {run?.father?.threadId && <Button variant="outline" size="sm" onClick={() => onOpenChat(run.father!.threadId!)}><ExternalLink size={14} />Open the Father&rsquo;s chat</Button>}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : <aside className="canvas-side" aria-label="Architectures">
      {columns.length > 0 && <section className="canvas-order" aria-label="Run order">
        <p className="hud-menu-title">Run order</p>
        <ol>{columns.map(({ level, members }) => <li key={level} data-status={waveState(members)}><span>Wave {level}</span>{members.map(node => node.data.title || "Untitled").join(", ")}</li>)}</ol>
        {critical.length > 1 && <p className="canvas-critical" onMouseEnter={() => setShowCritical(true)} onMouseLeave={() => setShowCritical(false)} title="The longest chain: the run takes at least this many rounds, however many agents run at once">
          <span>Critical path · {critical.length} rounds</span>{critical.map(titleOf).join(" → ")}</p>}
      </section>}
      {(["Patterns", "Research", "Start"] as const).map(group => <section key={group} className="canvas-templates" aria-label={group}>
        <p className="hud-menu-title">{group === "Start" ? "Start fresh" : group}</p>
        {TEMPLATES.filter(template => template.group === group).map(template => <button key={template.id} type="button" className="canvas-template" aria-current={graph.template === template.id || undefined} onClick={() => loadTemplate(template)}>
          <strong>{template.name}{graph.template === template.id && <span className="canvas-template-loaded">On the board</span>}</strong>
          <Shape shape={shapes.get(template.id) ?? []} /><small>{template.description}</small>
          {template.caution && <small className="canvas-template-caution">{template.caution}</small>}
          {template.source && <small className="canvas-template-source">{template.source}</small>}</button>)}
      </section>)}
      <section className="canvas-guide" aria-label="Guide">
        <p className="hud-menu-title">Guide</p>
        <ul>{GUIDE.map(item => <li key={item.href}><a href={item.href} target="_blank" rel="noreferrer">{item.title}</a><small>{item.note}</small></li>)}</ul>
      </section>
    </aside>}
  </section>;
}

"use client";

import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, getBezierPath, useReactFlow, type Edge, type EdgeProps, type EdgeChange, type FinalConnectionState, type Node, type NodeChange, type NodeProps, type XYPosition } from "@xyflow/react";
import { Check, ChevronRight, ExternalLink, ListOrdered, PanelRight, PanelRightClose, Play, Plus, StickyNote, Trash2, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowSources } from "@/components/workflow-sources";
import { summarize, workedFor } from "@/components/transcript";
import { isoLayout } from "@/lib/iso";
import { IsoBoard, ViewToggle, type IsoController } from "@/components/agents-iso";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { deleteKeepingFlow } from "@/lib/canvas-delete-flow";
import { api, providerChoices, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { appStorage } from "@/lib/projects";
import { filesText, mergeStops, runPayload, stopText, wantsIsolation } from "@/lib/canvas-isolation";
import { characters, type Character } from "@/lib/agent-characters";
import { portraits } from "@/lib/love-characters";
import { PATTERNS, WHOLE_PROJECT, applyPattern, agent, ownFolders, agentColor, CHECK_LABEL, COLUMN, DONE, FATHER, MOTHER, STATUS_LABEL, TASKS_PER_AGENT, waits, TEMPLATES, agentName, promptName, applyPlan, arrange, boardForPlan, checkOf, criticalPath, commandParts, shapeOf, makesLoop, maxAgents, newAgents, newId, parseCommand, parents, initialGraph, runParts, saveGraph, waves, withMother, type AgentData, type CanvasEdge, type CanvasGraph, type CanvasNode, type CatalogModel, type Command, type MotherSettings, type NoteData, type Plan, type RunTask, type TaskStatus } from "@/lib/canvas";

/** A run: the Mother's part, and the Father's when the graph has more agents than she runs (lib/canvas.ts `parents`):
 * his tasks wait in `father` until her part has succeeded, then run in his own chat. */
type Run = { rootThreadId: string; graphId: string; status: string; startedAt: number; endedAt?: number; father?: { tasks: RunTask[]; threadId?: string; graphId?: string; status: string; reported?: boolean } };
/** Whether the whole run is over: her part, and his if he has one. */
const over = (run: Run) => FINISHED.has(run.status) && (!run.father || (FINISHED.has(run.father.status) && (!run.father.threadId || run.father.reported)));
type Listed = { data: { id: string; status: string; error?: string | null; tasks: { id: string; status: TaskStatus; assignedThreadId: string | null; failureReason?: string | null; result?: unknown }[] }[] };
type HandleEnd = "source" | "target";
/** `clash` is the files of a merge clash that stopped the run on this agent (lib/canvas-isolation.ts). */
type AgentNodeData = AgentData & { status?: TaskStatus; check?: TaskStatus; clash?: string[]; modelLabel?: string; wave?: number; onHandle?: (id: string, end: HandleEnd, event: ReactMouseEvent) => void; onQuick?: (id: string) => void };
type MotherData = { run: "idle" | "running" | "finished"; children: number; limit: number; onHandle?: AgentNodeData["onHandle"] };
const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
/** What Elpis is asked when the user ran a team without writing a goal: keep what is drawn and set, and fill the rest. */
const DRAWN = "Run this team as drawn: keep every agent, its wiring and whatever is already set; give each agent the prompt and folders it lacks, from its name and its place in the team.";
/** A board's structure, without positions: its agents and wires. */
const shapeKey = (graph: CanvasGraph) => `${graph.nodes.filter(node => node.type === "agent").map(node => node.id).join(",")}|${graph.edges.map(edge => `${edge.id}${edge.kind ?? ""}`).join(",")}`;
/** How to manage agents, from the people who build them: read before designing a team. */
const GUIDE = [
  { title: "Building effective agents", note: "Anthropic: the patterns, and when a simple workflow beats an agent", href: "https://www.anthropic.com/engineering/building-effective-agents" },
  { title: "When to use several agents", note: "Anthropic: split by context, not by role; they cost 3–10× the tokens", href: "https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them" },
  { title: "How Anthropic's research agents work", note: "A lead plans; subagents research in parallel and report back", href: "https://www.anthropic.com/engineering/multi-agent-research-system" },
  { title: "Subagents in Claude Code", note: "Read-only helpers and writers, and how to brief them", href: "https://code.claude.com/docs/en/sub-agents" },
  { title: "Open Deep Research", note: "LangGraph: scope the question, research in parallel, write once", href: "https://blog.langchain.com/open-deep-research/" },
];
/** Fit the graph inside the available board, on opening and after layout changes. */
const FIT = { padding: 0.06, maxZoom: 1, minZoom: 0.3 };
const OVERVIEW = { padding: 0.08, maxZoom: 1 };

/** An agent on the canvas: it writes. Its run-order wave, name, model and state, with an input on the left (what it
 * waits for) and an output on the right (what waits for it), as Deus Ex's hacking screen links its nodes. The ring at
 * its corner is its check: empty until it runs, turning while it runs, then a tick or a cross. Clicking a dot opens
 * the command bar to add agents on that side. */
function AgentNode({ id, data }: NodeProps<Node<AgentNodeData>>) {
  const status = data.status ?? "idle", check = data.check ?? "idle";
  return <div className="agent-node" data-kind="agent" data-status={status} style={{ "--agent-color": agentColor(id, data) } as CSSProperties}>
    {data.character && <span className="avatar agent-portrait"><div><img src={portraits[data.character as keyof typeof portraits]} alt="" /></div></span>}
    <Handle type="target" position={Position.Left} title="Add agents this one waits for" onClick={event => data.onHandle?.(id, "target", event)} />
    <span className="agent-node-kind">Agent{data.wave ? ` · wave ${data.wave}` : ""}</span>
    <strong className="agent-node-title" title={data.title || "Untitled"}>{data.title || "Untitled"}</strong>
    <small className="agent-node-meta" title={`${data.modelLabel ?? "Default model"} · ${data.clash ? "clash" : STATUS_LABEL[status]}`}>{data.modelLabel ?? "Default model"} · {data.clash ? "clash" : STATUS_LABEL[status]}</small>
    <span className="agent-node-mark" role="img" data-check={check} aria-label={CHECK_LABEL[check]} title={CHECK_LABEL[check]}>{check === "succeeded" ? <Check size={12} /> : check === "failed" || check === "blocked" ? <X size={12} /> : null}</span>
    <Handle type="source" position={Position.Right} title="Add agents that wait for this one" onClick={event => data.onHandle?.(id, "source", event)} />
    {/* Both quick-create buttons add one successor linked only from this agent. */}
    <button data-slot="agent-plus" type="button" className="agent-node-plus nodrag" data-side="right" aria-label={`Add the next agent after ${data.title || "this one"}`} title="Add the next agent: it waits for this one" onClick={event => { event.stopPropagation(); data.onQuick?.(id); }}><Plus size={13} /></button>
    <button data-slot="agent-plus" type="button" className="agent-node-plus nodrag" data-side="bottom" aria-label={`Add an agent after ${data.title || "this one"}`} title="Add an agent after this one, connected only from this one" onClick={event => { event.stopPropagation(); data.onQuick?.(id); }}><Plus size={13} /></button>
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

/** The Mother's first segment is shared; one label names what every first-wave agent receives. */
function MotherEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps) {
  const split = sourceX + 32;
  return <>
    {data?.trunk === true && <g className="canvas-mother-trunk">
      {typeof data.label === "string" && data.label && <path className="canvas-flow-leader" d={`M ${sourceX + 16},${sourceY} L ${sourceX - 95},${sourceY - 60}`} />}
      <BaseEdge id={`${id}-trunk`} path={`M ${sourceX},${sourceY} H ${split}`} label={typeof data.label === "string" ? data.label : undefined} labelX={sourceX - 95} labelY={sourceY - 60} />
    </g>}
    <BaseEdge id={id} path={`M ${split},${sourceY} V ${targetY} H ${targetX}`} markerEnd={markerEnd} />
  </>;
}
function FlowEdge({ id, label, data, markerEnd, ...ends }: EdgeProps) {
  const [path, x, y] = getBezierPath(ends);
  const labelX = typeof data?.labelX === "number" ? data.labelX : x, labelY = typeof data?.labelY === "number" ? data.labelY : y;
  return <>
    {label && Math.hypot(labelX - x, labelY - y) > 12 && <path className="canvas-flow-leader" d={`M ${x},${y} L ${labelX},${labelY}`} />}
    <BaseEdge id={id} path={path} markerEnd={markerEnd} label={label} labelX={labelX} labelY={labelY} labelStyle={{ fontSize: 12 }} />
  </>;
}
const EDGE_TYPES = { mother: MotherEdge, default: FlowEdge };

/** Keep flat flow labels off cards and each other, nearest their wire. Positions use graph units, like the edges. */
function flowLabelPositions(nodes: Node[], edges: CanvasEdge[]) {
  const result = new Map<string, { labelX: number; labelY: number }>();
  if (!nodes.length) return result;
  const boxes = nodes.map(node => ({ id: node.id, x: node.position.x, y: node.position.y, w: node.measured?.width ?? 195, h: node.measured?.height ?? 96 }));
  const left = Math.min(...boxes.map(box => box.x)), right = Math.max(...boxes.map(box => box.x + box.w));
  const top = Math.min(...boxes.map(box => box.y)) - 32, bottom = Math.max(...boxes.map(box => box.y + box.h)) + 32;
  const taken = boxes.map(box => ({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 }));
  for (const edge of edges) {
    const from = boxes.find(box => box.id === edge.source), to = boxes.find(box => box.id === edge.target);
    if (!edge.label || !from || !to) continue;
    const [, x, y] = getBezierPath({ sourceX: from.x + from.w, sourceY: from.y + from.h / 2, targetX: to.x, targetY: to.y + to.h / 2, sourcePosition: Position.Right, targetPosition: Position.Left });
    const w = edge.label.length * 7 + 16, h = 24, slots = [{ x, y }];
    for (let sy = top + h / 2; sy <= bottom - h / 2; sy += 24) for (let sx = left + w / 2; sx <= right - w / 2; sx += 24) slots.push({ x: sx, y: sy });
    slots.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    const at = slots.find(slot => slot.x - w / 2 >= left && slot.x + w / 2 <= right && !taken.some(box => slot.x - w / 2 < box.x + box.w && box.x < slot.x + w / 2 && slot.y - h / 2 < box.y + box.h && box.y < slot.y + h / 2)) ?? { x, y };
    taken.push({ x: at.x - w / 2, y: at.y - h / 2, w, h }); result.set(edge.id, { labelX: at.x, labelY: at.y });
  }
  return result;
}

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
      {rows.map((row, index) => <button data-slot="quick-add-option" key={row.key} type="button" role="option" aria-selected={row === current} className="quick-add-option"
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
    <div ref={list} className="quick-add-list">{items.map((item, index) => <button data-slot="quick-add-option" key={item.label} type="button" role="menuitem" autoFocus={index === 0} className="quick-add-option" onClick={() => { onClose(); item.take(); }}>
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

/** One agent's info panel (Enter or double-click): what it is, what it waits for and feeds, and, once it runs, what it
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

/** The folders an agent may write, chosen from the project's own (GET /api/folders) or the whole project, besides the
 * agent's own folder (`ownFolders`), which the run makes and which `own` shows. */
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

const folderLabel = (folder: string) => folder === WHOLE_PROJECT ? "Whole project" : folder;

function FolderPicker({ cwd, folders, error, value, own, onChange }: { cwd?: string; folders: string[] | null; error: string; value: string[]; own?: string; onChange: (folders: string[]) => void }) {
  const left = (folders ? [WHOLE_PROJECT, ...folders] : []).filter(folder => !value.includes(folder));
  return <div className="canvas-folders" role="group" aria-label="May write">
    <span>May write</span>
    <span className="canvas-folders-chosen">{own && <span className="canvas-chip" title={`${own}: its own folder. The run makes it, and the agent and its check write their reports there.`}><span className="canvas-chip-label">{own}</span></span>}
      {value.map(folder => <span key={folder} className="canvas-chip" title={folderLabel(folder)}><span className="canvas-chip-label">{folderLabel(folder)}</span><button data-slot="chip-remove" type="button" aria-label={`Remove ${folderLabel(folder)}`} onClick={() => onChange(value.filter(item => item !== folder))}><X size={12} /></button></span>)}</span>
    {!cwd ? <small>Agents write inside a project: choose one at the top.</small>
      : error ? <small role="alert">{error}</small>
      : <OptionSelect aria-label="Add a folder" value="" onChange={event => { if (event.target.value) onChange([...value, event.target.value]); }}>
        <option value="" disabled>{folders === null ? "Loading the project's folders…" : !value.length && folders.length ? "Elpis decides, or add a folder…" : left.length ? "Add a folder it may write…" : "No more folders"}</option>
        {left.map(folder => <option key={folder} value={folder}>{folderLabel(folder)}</option>)}</OptionSelect>}
  </div>;
}

/** The run's clock, as Deus Ex's tracing timer: minutes and seconds since the run started, stopping when it ends. */
function RunClock({ since, until }: { since: number; until?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); if (until !== undefined) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [since, until]);
  return <strong>{clock((until ?? now) - since)}</strong>;
}
/** A span of time as mm:ss. */
const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; };

function AgentDashboard({ node, own, wave, status, check, clash, chat, waitsFor, feeds, modelLabel, onOpenChat, onSettings, onClose }: { node: Extract<CanvasNode, { type: "agent" }>; own: string; wave?: number; status: TaskStatus | "idle"; check: TaskStatus | "idle"; clash?: string[]; chat: string | null; waitsFor: string[]; feeds: string[]; modelLabel: string; onOpenChat: (id: string) => void; onSettings: () => void; onClose: () => void }) {
  const data = node.data, panel = useRef<HTMLDivElement>(null);
  // A click anywhere else on the page closes it, as Escape does.
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Element)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  return <div ref={panel} className="agent-dashboard hud-menu" role="dialog" aria-label={`${data.title} info`} data-kind="agent" data-status={status}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><span className="agent-node-kind">Agent{wave ? ` · wave ${wave}` : ""} · {STATUS_LABEL[status]}</span><strong>{data.title || "Untitled"}</strong>
      <Button variant="ghost" size="icon-xs" aria-label="Close info" autoFocus onClick={onClose}><X size={14} /></Button></header>
    <dl>
      <div><dt>Model</dt><dd>{modelLabel}{data.effort ? ` · ${data.effort} thinking` : ""}</dd></div>
      <div><dt>Inputs needed</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "All inputs captured"}</dd></div>
      <div><dt>Feeds</dt><dd>{feeds.length ? feeds.join(", ") : "The Mother's report"}</dd></div>
      <div><dt>May write</dt><dd>{[own, ...data.writeScopes.map(folderLabel)].join(", ")}</dd></div>
      <div><dt>Prompt</dt><dd>{data.instruction || "No prompt yet: write one before the run"}</dd></div>
      <div><dt>Done when</dt><dd>{(data.acceptanceCriteria.length ? data.acceptanceCriteria : [DONE]).join("; ")}</dd></div>
      <div><dt>Its check</dt><dd>{CHECK_LABEL[check]}</dd></div>
      {clash && <div><dt>Merge clash</dt><dd>{clash.join("\n")}</dd></div>}
    </dl>
    <Button variant="outline" size="sm" onClick={onSettings}>Settings</Button>
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
  const isoController = useRef<IsoController>(null);
  const flow = useReactFlow(), board = useRef<HTMLDivElement>(null), pointer = useRef<XYPosition | null>(null), connectFrom = useRef<XYPosition | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>(initialGraph);
  const [sourceId, setSourceId] = useState<string | null>(null);
  // What is selected is kept apart from the saved graph: a click picks one, Shift+click or Shift+drag several.
  const [selection, setSelection] = useState<string[]>([]), [dashboardId, setDashboardId] = useState<string | null>(null);
  const pendingProviderDefaults = useRef(new Map<string, { provider: string | null; model: string | null; effort: string | null }>());
  const boxDrag = useRef<{ x: number; y: number; base: string[]; moved: boolean } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>(null);
  useEffect(() => { if (selection.length) setSourceId(null); }, [selection]);
  const [menu, setMenu] = useState<BoardMenu | null>(null), wireMenu = menu?.kind === "wire" ? menu : null;
  // The side panel folds away to give the board the whole width, remembered on this device; choosing an agent or the
  // Mother brings it back.
  const [panelOpen, setPanelOpen] = useState(() => { try { return appStorage().getItem("elpis-canvas-panel") !== "closed"; } catch { return true; } });
  const showPanel = (open: boolean) => { setPanelOpen(open); try { appStorage().setItem("elpis-canvas-panel", open ? "open" : "closed"); } catch { /* kept for this session only */ } setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  useEffect(() => { if (selection.length && !panelOpen && !boxDrag.current) showPanel(true); }, [selection, selectionBox]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = useProjectFolders(cwd);
  const own = useMemo(() => ownFolders(graph), [graph]);
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<string | null>(null);
  useEffect(() => { if (!deleted) return; const timer = setTimeout(() => setDeleted(null), 4000); return () => clearTimeout(timer); }, [deleted]);
  const [flowEdit, setFlowEdit] = useState<{ edge: CanvasEdge; left: number; top: number } | null>(null);
  const [maxAtOnce, setMaxAtOnce] = useState(3);
  const [patternCommand, setPatternCommand] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [run, setRun] = useState<Run | null>(null), [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => { if (isoController.current) isoController.current.fit(); else void flow.fitView(FIT); }, 60);
    return () => clearTimeout(timer);
  }, [run?.graphId, flow]); // eslint-disable-line react-hooks/exhaustive-deps
  const [states, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null }>>({});
  // Where the engine's merge clash stopped the run: the clashing files, by the agent whose work clashed.
  const [clashes, setClashes] = useState<Record<string, string[]>>({});
  // The run log, as Deus Ex's event cards: what started, finished, passed its check or failed, newest last.
  type LogLine = { at: number; agent?: string; text: string; tone: "start" | "done" | "fail" };
  const [log, setLog] = useState<LogLine[]>([]);
  const said = useRef<Record<string, TaskStatus>>({});
  const reports = useRef(new Set<string>()), logList = useRef<HTMLOListElement>(null);
  const followLog = useRef(true);
  useEffect(() => { if (followLog.current && logList.current) logList.current.scrollTop = logList.current.scrollHeight; }, [log]);
  const [, setFetched] = useState(0);
  const settings = useElpisSettings().data;
  // What Elpis allows: agents in one graph, and at once (bridge/elpis-features.mjs `agentLimits`).
  const allowed = settings?.agents ?? { graph: 256, atOnce: 6, source: "Elpis default" };
  useEffect(() => { const timer = setTimeout(() => { if (!saveGraph(graph)) setNotice("Could not keep the graph on this device."); }, 300); return () => clearTimeout(timer); }, [graph]);
  // A change made just before the window closes or reloads is kept too: the page saves the latest board on its way out.
  const latest = useRef(graph); latest.current = graph;
  useEffect(() => { const flush = () => saveGraph(latest.current); window.__elpisFlushWorkflow = flush; window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush); return () => { flush(); if (window.__elpisFlushWorkflow === flush) delete window.__elpisFlushWorkflow; window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); }; }, []);

  // The existing provider catalog, shared by Add and the inspector; execution uses ACP.
  const choices = useMemo(() => providerChoices(models, (settings ?? null) as ProviderSettings | null).filter(choice => !choice.id.endsWith("/")), [models, settings]);
  const version = settings?.version ?? "";
  useEffect(() => {
    for (const choice of choices) {
      if (!choice.provider || choice.needsKey || catalogs.get(choice.provider)?.version === version) continue;
      const provider = choice.provider;
      catalogs.set(provider, { version });
      api<{ data: Model[] }>(`/models?provider=${encodeURIComponent(provider)}`)
        .then(result => catalogs.set(provider, { version, models: result.data }))
        .catch(cause => catalogs.set(provider, { version, error: cause instanceof Error ? cause.message : String(cause) }))
        .finally(() => setFetched(count => count + 1));
    }
  }, [choices, version]);
  const listed = (choice: (typeof choices)[number]) => choice.provider ? catalogs.get(choice.provider)?.models ?? [] : choice.models;
  const catalog: CatalogModel[] = choices.flatMap(choice => listed(choice).map(model => ({ provider: choice.provider ?? null, providerLabel: choice.label, model: model.model, label: model.displayName || model.model,
    efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [], defaultEffort: model.defaultReasoningEffort ?? null })));
  const providers = choices.map(choice => {
    const fetched = choice.provider ? catalogs.get(choice.provider) : undefined;
    return { id: choice.provider ?? null, label: choice.label, state: choice.needsKey ? "key" : fetched?.error ? "error" : choice.provider && !fetched?.models ? "loading" : "ready", error: fetched?.error } satisfies Provider;
  });
  const primaryProvider = choices[0]?.provider ?? null;
  const canonicalProvider = (provider?: string | null) => !provider || provider === settings?.main.provider ? primaryProvider : provider;
  const providerDefault = (provider: string | null) => catalog.find(item => item.provider === provider && provider === primaryProvider && item.model === settings?.main.model) ?? catalog.find(item => item.provider === provider);
  useEffect(() => {
    if (!pendingProviderDefaults.current.size) return;
    const patches = new Map<string, { provider: string | null; model: string; effort: string | null }>();
    for (const [id, pending] of pendingProviderDefaults.current) {
      const keep = catalog.find(item => item.provider === pending.provider && item.model === pending.model);
      const model = keep ?? providerDefault(pending.provider);
      if (!model) continue;
      pendingProviderDefaults.current.delete(id); patches.set(id, { provider: pending.provider, model: model.model, effort: keep?.efforts.includes(pending.effort ?? "") ? pending.effort : null });
    }
    if (patches.size) setGraph(current => ({ ...current, nodes: current.nodes.map(node => {
      const patch = patches.get(node.id);
      return node.type === "agent" && patch && canonicalProvider(node.data.provider) === patch.provider && !node.data.model ? { ...node, data: { ...node.data, model: patch.model, effort: patch.effort } } : node;
    }) }));
  });

  // Follow a run: Elpis reports each task's state; stop once the graph has finished.
  useEffect(() => {
    if (!run || over(run)) return;
    let live = true, polling = false;
    const read = async (threadId: string, graphId: string) => {
      const listed = await api<Listed>(`/workflows?threadId=${encodeURIComponent(threadId)}`), found = listed.data.find(item => item.id === graphId);
      if (found && live) {
        // A merge clash (lib/canvas-isolation.ts) stops the run on an agent: it shows as failed, though its own task may have succeeded.
        const stops = mergeStops(found), listedStates = Object.fromEntries(found.tasks.map(task => [task.id, { status: task.status, chat: task.assignedThreadId }]));
        for (const stop of stops) if (stop.agent && listedStates[stop.agent]) listedStates[stop.agent] = { ...listedStates[stop.agent], status: "failed" };
        setStates(current => ({ ...current, ...listedStates }));
        if (stops.some(stop => stop.agent)) setClashes(current => ({ ...current, ...Object.fromEntries(stops.flatMap(stop => stop.agent ? [[stop.agent, stop.files]] : [])) }));
        // Each stop is told once, in the log and in a notice that stays until dismissed.
        const fresh: typeof stops = [];
        for (const stop of stops) { const key = `merge ${stop.agent ?? "project"}`; if (!said.current[key]) { said.current[key] = "failed"; fresh.push(stop); } }
        if (fresh.length) setNotice(fresh.map(stop => stopText(stop, stop.agent ? titleOf(stop.agent) : "")).join(" "));
        const failed = found.tasks.find(task => task.status === "failed" && task.failureReason);
        if (!fresh.length && !failed && found.error) setNotice(found.error);
        if (!fresh.length && failed) setNotice(`${titleOf(failed.id.replace(/-check$/, ""))}: ${failed.failureReason}`);
        const stopLines = fresh.map(stop => ({ at: Date.now(), agent: stop.agent ?? undefined, text: stop.agent ? `${titleOf(stop.agent)}: merge clash in ${filesText(stop.files, 3)}` : `Merge blocked: uncommitted changes in ${filesText(stop.files, 3)}`, tone: "fail" as const }));
        const lines = found.tasks.flatMap(task => {
          const previous = said.current[task.id];
          said.current[task.id] = task.status;
          const check = task.id.endsWith("-check"), agent = check ? task.id.slice(0, -"-check".length) : task.id, who = titleOf(agent);
          const lines: LogLine[] = [];
          if (previous !== task.status) {
            // A successful task necessarily started, even when it finished between snapshots. Times are observations.
            if (task.status === "succeeded" && previous !== "running") lines.push({ at: Date.now(), agent, text: `${check ? "CHECK STARTED" : "AGENT STARTED"} · ${who}`, tone: "start" });
            const label = task.status === "running" ? (check ? "CHECK STARTED" : "AGENT STARTED") : task.status === "succeeded" ? (check ? "CHECK PASSED" : "TASK DONE") : task.status === "blocked" ? "INPUT BLOCKED" : task.status === "failed" ? (check ? "CHECK FAILED" : "TASK FAILED") : task.status === "cancelled" ? "TASK CANCELLED" : "";
            if (label) lines.push({ at: Date.now(), agent, text: `${label} · ${who}${task.failureReason ? ` · ${task.failureReason}` : ""}`, tone: task.status === "running" ? "start" : task.status === "succeeded" ? "done" : "fail" });
          }
          // The engine's accepted result is the evidence of a report, independent of the task's status transition.
          if (task.result !== undefined && task.result !== null && !reports.current.has(task.id)) {
            reports.current.add(task.id);
            lines.push({ at: Date.now(), agent, text: `REPORT RECEIVED · DATASTORE CAPTURED · ${who}`, tone: "done" });
          }
          return lines;
        });
        if (lines.length || stopLines.length) setLog(current => [...current, ...lines, ...stopLines]);
      }
      return found;
    };
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        let next = run;
        if (!FINISHED.has(run.status)) { const found = await read(run.rootThreadId, run.graphId); if (found && found.status !== run.status) next = { ...next, status: found.status }; }
        const father = next.father;
        if (father?.threadId && father.graphId && !father.reported) {
          const found = await read(father.threadId, father.graphId);
          if (found) {
            if (found.status !== father.status) next = { ...next, father: { ...father, status: found.status } };
            if (FINISHED.has(found.status)) {
              // Deliver the engine's accepted results, with their origin, to the Mother's actual chat.
              // Keep following the run if delivery fails; no second Father is started (docs/specs/canvas-father-report.md).
              const text = [`Report from the Father · ${father.threadId}`, `Work graph: ${father.graphId}`, `Status: ${found.status}`,
                found.error, ...found.tasks.map(task => `${titleOf(task.id.replace(/-check$/, ""))}${task.id.endsWith("-check") ? " (check)" : ""}: ${task.status}\n${JSON.stringify(task.result ?? { failure: task.failureReason ?? null })}`),
                "This is the Father's completed run report. Acknowledge it briefly without tools, edits, or another run."].filter(Boolean).join("\n\n");
              try { await api(`/threads/${encodeURIComponent(run.rootThreadId)}/turns`, { text }); }
              catch (error) { if (live) setNotice(`Father report not delivered: ${error instanceof Error ? error.message : String(error)}`); return; }
              setNotice(current => current.startsWith("Father report not delivered:") ? "" : current);
              next = { ...next, father: { ...father, status: found.status, reported: true } };
              setLog(current => [...current, { at: Date.now(), text: "FATHER REPORT RECEIVED · DATASTORE CAPTURED · Mother", tone: "done" }]);
            }
          }
        }
        // Her part done: the Father starts his, in his own chat; if hers failed, his never starts.
        if (father && !father.threadId && FINISHED.has(next.status)) next = { ...next, father: next.status === "succeeded" || next.status === "completed" ? await startFather(father.tasks) : { ...father, status: "cancelled" } };
        if (live && next !== run) setRun(over(next) ? { ...next, endedAt: Date.now() } : next);
      } catch (error) { if (live) setNotice(error instanceof Error ? error.message : String(error)); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [run]);

  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  const chosen = agents.filter(node => selection.includes(node.id)), selected = chosen.length === 1 ? chosen[0] : undefined;
  // The Father is her twin: a click on him opens her panel, which tells his part.
  const motherOpen = selection.length === 1 && (selection[0] === MOTHER || selection[0] === FATHER), mother = graph.mother ?? { brief: "", model: null, provider: null };
  const setMother = (patch: Partial<MotherSettings>) => setGraph(current => ({ ...current, mother: { ...(current.mother ?? { brief: "", model: null, provider: null }), ...patch } }));
  // Loading an architecture replaces the board; Undo, offered for a while, puts the old one back.
  const [undoLoad, setUndoLoad] = useState<{ loaded: string; previous: CanvasGraph } | null>(null);
  useEffect(() => { if (!undoLoad) return; const timer = setTimeout(() => setUndoLoad(null), 12000); return () => clearTimeout(timer); }, [undoLoad]);
  const shapes = useMemo(() => new Map(TEMPLATES.map(template => [template.id, shapeOf(template.build())])), []);
  const limit = maxAgents(graph), room = Math.max(0, limit - agents.length), order = useMemo(() => waves(graph), [graph]);
  // An agent is done once its check passes, unless its work clashed in the merge.
  const done = agents.filter(node => states[checkOf(node.id)]?.status === "succeeded" && !clashes[node.id]).length;
  const runState: MotherData["run"] = run ? (FINISHED.has(run.status) ? "finished" : "running") : "idle";
  const fatherState: MotherData["run"] = run?.father?.threadId ? (FINISHED.has(run.father.status) ? "finished" : "running") : "idle";
  const modelLabel = (data: AgentData) => {
    if (!data.model) return "Default model";
    const found = catalog.find(item => item.model === data.model && item.provider === canonicalProvider(data.provider));
    return found?.label ?? data.model;
  };
  const setText = (id: string, text: string) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id && node.type === "note" ? { ...node, data: { text } } : node) }));
  // Quick create adds one successor in the next column's nearest free slot, selected with its prompt focused.
  const promptField = useRef<HTMLTextAreaElement>(null);
  const onQuick = (id: string) => {
    const source = graph.nodes.find(node => node.id === id);
    if (!source) return;
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    const [made] = newAgents(1, { model: null }, { x: 0, y: 0 }, [], agents.map(node => node.data.title));
    const at = place({ x: source.position.x + COLUMN, y: source.position.y });
    const wire = { id: `${id}->${made.id}`, source: id, target: made.id };
    checkpoint(); restored.current = true;
    setGraph(current => ({ ...current, nodes: [...current.nodes, { ...made, position: at }], edges: [...current.edges, wire] }));
    setSelection([made.id]); setMenu(null); setAdding(null); reveal([made.id]);
    setTimeout(() => promptField.current?.focus(), 60);
  };
  // A click on a dot (no drag) opens the command bar there; the new agents take that side of it.
  const onHandle = (id: string, end: HandleEnd, event: ReactMouseEvent) => { event.stopPropagation(); openAdder({ x: event.clientX, y: event.clientY }, { id, as: end === "source" ? "target" : "source" }); };
  // The Father, when the graph has more agents than the Mother runs: drawn left of the first agents he starts.
  // The critical path, highlighted on the board while the pointer is on it in the run order.
  const critical = useMemo(() => criticalPath(graph), [graph]), [showCritical, setShowCritical] = useState(false);
  const split = useMemo(() => parents(graph), [graph]), his = new Set(split.father);
  // React Flow shows a node once its size is known; the Father is not in the saved board, so his size is kept here.
  const [fatherSize, setFatherSize] = useState<{ width: number; height: number } | null>(null);
  const fatherRoots = agents.filter(node => his.has(node.id) && !graph.edges.some(edge => waits(edge) && edge.target === node.id && his.has(edge.source)));
  const fatherNode: Node | null = fatherRoots.length ? { id: FATHER, type: "father", deletable: false, selectable: false, draggable: false,
    // Under the Mother: like her, he starts his agents, so he sits in her column.
    position: (({ x, y }) => ({ x, y: y + 140 }))(graph.nodes.find(node => node.type === "mother")?.position ?? { x: 0, y: 0 }),
    ...(fatherSize ? { measured: fatherSize } : {}), data: { run: fatherState, children: split.father.length, limit } satisfies MotherData } : null;
  const nodesWithFather = (list: Node[]) => fatherNode ? [...list, fatherNode] : list;
  const nodes = useMemo<Node[]>(() => nodesWithFather(graph.nodes.map(node => node.type === "mother"
    ? { ...node, deletable: false, selected: selection.includes(MOTHER), data: { run: runState, children: agents.length, limit, onHandle } satisfies MotherData }
    : { ...node, selected: selection.includes(node.id), data: node.type === "agent" ? { ...node.data, status: states[node.id]?.status, check: states[checkOf(node.id)]?.status, clash: clashes[node.id], modelLabel: modelLabel(node.data), wave: order.get(node.id), onHandle, onQuick } : { ...node.data, onText: setText } }),
  ), [graph.nodes, selection, states, clashes, models, order, runState, fatherState, limit, catalog.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const flowLabels = useMemo(() => flowLabelPositions(nodes, graph.edges), [nodes, graph.edges]);
  const edges = useMemo<Edge[]>(() => [
    // The Mother's wires: she starts every agent of the first wave.
    ...agents.filter(node => order.get(node.id) === 1 && !his.has(node.id)).map((node, index) => ({ id: `${MOTHER}->${node.id}`, source: MOTHER, target: node.id, type: "mother", markerEnd: { type: MarkerType.ArrowClosed }, className: "canvas-edge-mother", selectable: false, deletable: false, focusable: false, selected: wireMenu?.edge.id === `${MOTHER}->${node.id}`, data: { trunk: index === 0, label: graph.motherFlow, live: states[node.id]?.status === "running" } })),
    // The Father's wires: he starts his agents that wait for none of his others.
    ...fatherRoots.map(node => ({ id: `${FATHER}->${node.id}`, source: FATHER, target: node.id, type: "default", markerEnd: { type: MarkerType.ArrowClosed }, className: "canvas-edge-mother", selectable: false, deletable: false, focusable: false, interactionWidth: 0, data: { live: states[node.id]?.status === "running" } })),
    ...graph.edges.map(edge => {
      // A wire goes live once its first agent's check passed and the second agent is running.
      const from = states[checkOf(edge.source)]?.status, to = states[edge.target]?.status, live = waits(edge) && from === "succeeded" && to === "running";
      const onPath = showCritical && critical.includes(edge.source) && critical[critical.indexOf(edge.source) + 1] === edge.target;
      if (edge.kind === "alongside") return { ...edge, type: "default", selected: wireMenu?.edge.id === edge.id, data: { alongside: true, ...flowLabels.get(edge.id) }, className: "canvas-edge-alongside" };
      return { ...edge, type: "default", markerEnd: { type: MarkerType.ArrowClosed }, selected: wireMenu?.edge.id === edge.id || onPath, data: { live, ...flowLabels.get(edge.id) }, className: from === "failed" || to === "blocked" ? "canvas-edge-cut" : live ? "canvas-edge-live" : from === "succeeded" ? "canvas-edge-done" : undefined };
    }),
  ], [graph.edges, graph.nodes, graph.motherFlow, states, order, wireMenu, showCritical, flowLabels]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set(changes.flatMap(change => change.type === "remove" && change.id !== MOTHER ? [change.id] : []));
    if (removed.size) checkpoint();
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
  const onEdgesChange = (changes: EdgeChange[]) => setGraph(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges as Edge[]).map(({ id, source, target }) => ({ ...current.edges.find(edge => edge.id === id), id, source, target })) }));
  // Wiring: a wire orders its agents (the target waits for the source), or, `alongside`, joins two agents working at the
  // same time. The Mother and Father start their agents themselves, so they take no wires.
  const connect = (source: string, target: string, kind?: CanvasEdge["kind"]) => {
    if ([source, target].some(id => id === MOTHER || id === FATHER)) { setNotice("The Mother starts every agent that waits for no one, so she takes no wires: wire agents to each other."); return; }
    if (![source, target].every(id => agents.some(node => node.id === id))) return;
    if (graph.edges.some(edge => (edge.source === source && edge.target === target) || (edge.source === target && edge.target === source))) { setNotice("Those two are already wired: click the wire to change or remove it."); return; }
    const feedback = !kind && makesLoop(graph.edges, source, target);
    if (feedback && graph.template !== "recursive") { setNotice("That wire would make a loop: an agent can't wait for itself."); return; }
    setNotice(""); checkpoint();
    setGraph(current => ({ ...current, edges: [...current.edges, { id: `${source}${kind ? "~" : "->"}${target}`, source, target, ...(kind ? { kind } : {}), ...(feedback ? { feedback: true, label: "Next round" } : {}) } satisfies CanvasEdge] }));
    // Auto-arrange may move them: the two just wired stay in view.
    reveal([source, target]);
  };
  // A new node lands in the first free spot near where it was asked for (else the middle of the view), never on top
  // of another.
  // Where new things go, as FigJam places them: never on an agent or a note. `place` takes the first free slot at or
  // below a spot, in steps of the grid; with no spot, new agents join the first wave's column, below what is there.
  const NODE_W = 210, NODE_H = 96, GAP = 28;
  const ISO_NODE = { w: NODE_W, h: 180, top: 130 }; // Includes the pedestal and its upright name label.
  const boxes = () => graph.nodes.map(node => ({ x: node.position.x, y: node.position.y, w: (node as { measured?: { width?: number } }).measured?.width ?? NODE_W, h: (node as { measured?: { height?: number } }).measured?.height ?? NODE_H }));
  const isoBoxes = (scene = isoLayout(graph, order, split.father.length ? FATHER : undefined)) => scene.map(item => ({ x: item.at.x - ISO_NODE.w / 2, y: item.at.y - ISO_NODE.top, w: ISO_NODE.w, h: ISO_NODE.h }));
  const freeAt = (x: number, y: number, taken = boxes(), size = { w: NODE_W, h: NODE_H }) => taken.every(item => x + size.w + GAP <= item.x || x >= item.x + item.w + GAP || y + size.h + GAP <= item.y || y >= item.y + item.h + GAP);
  const place = (near?: XYPosition, taken = boxes(), size = { w: NODE_W, h: NODE_H }) => {
    const start = near ?? firstColumn(), x = Math.round(start.x / 20) * 20;
    for (let y = Math.round(start.y / 20) * 20; ; y += 20) if (freeAt(x, y, taken, size)) return { x, y };
  };
  const firstColumn = (): XYPosition => {
    const first = agents.filter(node => order.get(node.id) === 1), motherAt = graph.nodes.find(node => node.type === "mother")?.position ?? { x: 0, y: 0 };
    return first.length ? { x: Math.min(...first.map(node => node.position.x)), y: Math.min(...first.map(node => node.position.y)) } : { x: motherAt.x + COLUMN, y: motherAt.y };
  };
  const addAgents = (count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, where: Partial<Pick<Adding, "at" | "from" | "between">> = {}, tasks: string[] = []) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    // Beside the agent they came from (right if they wait for it, left if it waits for them), else where asked, else in
    // the first wave's column; each in the next free slot below the last.
    const { from, between } = where, source = from && graph.nodes.find(node => node.id === from.id);
    const spot = source ? { x: source.position.x + (from!.as === "target" ? COLUMN : -COLUMN), y: source.position.y } : where.at;
    const taken = boxes();
    const made = newAgents(Math.min(count, room), choice, { x: 0, y: 0 }, tasks, agents.map(node => node.data.title)).map(node => { const at = place(spot, taken); taken.push({ ...at, w: NODE_W, h: NODE_H }); return { ...node, position: at }; });
    const wire = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
    // On a wire, the new agents take its place: each waits for its first agent and feeds its second. From a dot or a
    // dropped wire, they join that agent. The Mother's wires are implied, never drawn.
    const wires = between ? made.flatMap(node => [...(between.source === MOTHER ? [] : [wire(between.source, node.id)]), wire(node.id, between.target)])
      : from && from.id !== MOTHER ? made.map(node => from.as === "target" ? wire(from.id, node.id) : wire(node.id, from.id)) : [];
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...made], edges: [...current.edges.filter(edge => edge.id !== between?.id), ...wires] }));
    setSelection(made.map(node => node.id));
    reveal(made.map(node => node.id));
    setNotice(count > room ? `Added ${room}: the limit is ${limit} agents.` : "");
  };
  // Direct creation keeps the requested position even when automatic run-order layout is enabled.
  const addAgent = (client?: XYPosition, from?: Adding["from"]) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    checkpoint(); restored.current = true;
    const source = graph.nodes.find(node => node.id === from?.id);
    const at = client && !iso ? flow.screenToFlowPosition(client) : undefined;
    const near = at ? { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 }
      : source ? { x: source.position.x + (from?.as === "source" ? -COLUMN : COLUMN), y: source.position.y } : viewMiddle();
    const [made] = newAgents(1, { model: null }, place(near), [], agents.map(node => node.data.title));
    let nodes = graph.nodes;
    if (iso) {
      const scene = isoLayout(graph, order, split.father.length ? FATHER : undefined);
      const origin = scene.find(item => item.id === from?.id)?.at;
      const wanted = client ? isoController.current!.position(client)
        : origin ? { x: origin.x + (from?.as === "source" ? -COLUMN : COLUMN), y: origin.y } : { x: 300, y: 0 };
      const position = place({ x: wanted.x - ISO_NODE.w / 2, y: wanted.y - ISO_NODE.top }, isoBoxes(scene), ISO_NODE);
      made.isoPosition = { x: position.x + ISO_NODE.w / 2, y: position.y + ISO_NODE.top };
      // Freeze the existing scene so adding a wave does not recenter its neighbours or move the camera.
      nodes = graph.nodes.map(node => { const at = scene.find(item => item.id === node.id)?.at; return at ? { ...node, isoPosition: at } : node; });
      isoController.current?.keepView();
    }
    const sourceId = from?.as === "source" ? made.id : from?.id, targetId = from?.as === "source" ? from.id : made.id;
    const wires = from && from.id !== MOTHER && from.id !== FATHER ? [{ id: `${sourceId}->${targetId}`, source: sourceId!, target: targetId }] : [];
    setGraph({ ...graph, nodes: [...nodes, made], edges: [...graph.edges, ...wires] });
    setSelection([made.id]); setNameFocus(made.id); setMenu(null); setAdding(null); setNotice("");
    if (iso) setTimeout(() => isoController.current?.reveal([made.id]), 140); else reveal([made.id]);
  };
  const viewMiddle = () => { const box = board.current?.getBoundingClientRect(); return box ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 100, y: box.top + box.height / 3 }) : undefined; };
  const addNote = (at?: XYPosition, text = "") => { const { x, y } = place(at ?? viewMiddle()); setGraph(current => ({ ...current, nodes: [...current.nodes, { id: newId("note"), type: "note", position: { x, y }, data: { text } }] })); };
  // Tab, Command, a clicked dot or a context menu opens the command bar, kept inside the board.
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
  // Drop on an agent to connect, or on empty board to create a connected agent there.
  // A click without a drag keeps the dot's command menu.
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid) return;
    const spot = "changedTouches" in event ? event.changedTouches[0] : event, start = connectFrom.current;
    if (!state.fromNode || !state.fromHandle || !start) return;
    const from = state.fromNode.id, over = state.toNode?.id ?? (document.elementFromPoint(spot.clientX, spot.clientY)?.closest(".react-flow__node") as HTMLElement | null)?.dataset.id;
    if (over && over !== from) { const [source, target] = state.fromHandle.type === "source" ? [from, over] : [over, from]; connect(source, target, "altKey" in event && event.altKey ? "alongside" : undefined); return; }
    const hit = document.elementFromPoint(spot.clientX, spot.clientY);
    if (over || !hit?.closest(".react-flow") || hit.closest(".react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap") || Math.hypot(spot.clientX - start.x, spot.clientY - start.y) < 8) return;
    addAgent({ x: spot.clientX, y: spot.clientY }, { id: from, as: state.fromHandle.type === "source" ? "target" : "source" });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const take = () => { event.preventDefault(); event.stopPropagation(); };
      const target = event.target as HTMLElement | null, typing = target?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox']");
      const onBoard = !target || target === document.body || Boolean(target.closest?.(".react-flow, .iso-board")), ctrl = event.ctrlKey || event.metaKey;
      if (target && target !== document.body && !target.closest(".agents-canvas")) return;
      // event.code, so it works in any keyboard layout; never inside a field, where Ctrl+A selects the text. On the board
      // Ctrl+A selects every agent and note, as in every editor.
      if (event.key === "Escape" && boxDrag.current) { take(); setSelection(boxDrag.current.base); boxDrag.current = null; setSelectionBox(null); }
      else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === "KeyA" && !typing) { take(); setSelection(graph.nodes.filter(node => node.type !== "mother").map(node => node.id)); }
      else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.shiftKey && onBoard && !typing) { take(); openAdder(); }
      else if (!ctrl && !event.altKey && event.code === "KeyA" && onBoard && !typing && !adding) { take(); addAgent(undefined, selected ? { id: selected.id, as: "target" } : undefined); }
      // Space opens workflow patterns; middle drag and scroll pan. F frames selection.
      else if (!ctrl && event.code === "KeyF" && onBoard && !typing) { take(); if (iso) isoController.current?.frame(); else if (selection.length) void flow.fitView({ nodes: selection.map(id => ({ id })), padding: 0.3, maxZoom: 1.5, duration: 250 }); }
      else if (event.code === "Space" && onBoard && !typing) { take(); setAdding(null); setMenu(null); setPatternCommand(""); }
      else if (event.key.length === 1 && !ctrl && !event.altKey && onBoard && !typing && !adding) { take(); openAdder(undefined, undefined, undefined, event.key); }
      else if (event.key === "Enter" && !iso && selected && onBoard && !typing && !adding) { take(); setDashboardId(selected.id); }
      else if (typing || event.altKey) return;
      // The board's own keys, by event.code so any keyboard layout works; in a field they stay the field's.
      else if (ctrl && event.code === "KeyZ") { take(); if (event.shiftKey) redo(); else undo(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyY") { take(); redo(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyC" && selection.length) { take(); copy(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyV" && clipboard.current) { take(); paste(); }
      else if (ctrl && !event.shiftKey && event.code === "KeyD" && selection.length) { take(); duplicate(); }
      // Before React Flow's own Delete, which would drop the wires.
      else if (ctrl && event.key === "Delete" && selection.length) { take(); event.stopPropagation(); removeKeepingFlow(selection); }
      else if (!ctrl && ["Delete", "Backspace"].includes(event.key) && selection.length) { take(); remove(selection.filter(id => id !== MOTHER && id !== FATHER)); }
      else if (!ctrl && event.key === "Home") { take(); fitAll(); }
      else if (!ctrl && event.key === "F2" && selected) { take(); rename(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });
  const addCharacter = (character: Character) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents.`); return; }
    checkpoint();
    const made = agent(character.name, character.prompt, { character: character.id, model: "gpt-6-luna", provider: "openai" });
    setGraph(current => ({ ...current, nodes: [...current.nodes, { ...made, position: place() }] }));
    setSelection([]); reveal([made.id]);
    board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
  };
  const loadTemplate = (template: (typeof TEMPLATES)[number]) => { setUndoLoad({ loaded: template.name, previous: graph }); setGraph(current => ({ ...withMother(template.build()), maxAgents: current.maxAgents, mother: current.mother, template: template.id })); setSelection([]); setMenu(null); setDashboardId(null); setRun(null); setStates({}); setNotice("");
    // Keys go to the board again (Tab opens the command bar), not to the template just clicked.
    (document.activeElement as HTMLElement | null)?.blur(); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  const tidy = () => { checkpoint(); setGraph(current => arrange(current)); setTimeout(() => { if (iso) isoController.current?.fit(); else void flow.fitView({ ...FIT, duration: 250 }); }, 60); };
  // Agents just made are brought into view if they landed outside it (after auto-arrange has placed them), at the same zoom.
  const reveal = (ids: string[]) => setTimeout(() => {
    const box = board.current?.querySelector(".react-flow")?.getBoundingClientRect(), made = ids.flatMap(id => { const node = flow.getNode(id); return node ? [node] : []; });
    if (!box || !made.length) return;
    const outside = made.some(node => { const start = flow.flowToScreenPosition(node.position), end = flow.flowToScreenPosition({ x: node.position.x + NODE_W, y: node.position.y + NODE_H }); return start.x < box.left || start.y < box.top || end.x > box.right || end.y > box.bottom; });
    if (outside) void flow.fitView({ nodes: made.map(node => ({ id: node.id })), padding: 0.4, maxZoom: flow.getZoom(), minZoom: Math.min(flow.getZoom(), 0.85), duration: 250 });
  }, 140);
  // Auto-arrange (on unless turned off, remembered): after any change to the agents or their wires, the board re-forms its
  // run-order columns, so it never turns into a tangle. Moving an agent by hand still works; within a column the
  // order follows its height.
  const [autoLayout, setAutoLayout] = useState(() => { try { return appStorage().getItem("elpis-canvas-auto") !== "off"; } catch { return true; } });
  const shape = shapeKey(graph), lastShape = useRef(shape);
  useEffect(() => {
    if (shape === lastShape.current) return;
    lastShape.current = shape;
    // Undo, redo and direct creation retain their chosen positions.
    if (restored.current) { restored.current = false; return; }
    if (autoLayout) setGraph(current => { const next = arrange(current); return next.nodes.every((node, index) => node.position.x === current.nodes[index].position.x && node.position.y === current.nodes[index].position.y) ? current : next; });
  }, [shape, autoLayout]);
  const toggleAuto = () => { const next = !autoLayout; setAutoLayout(next); try { appStorage().setItem("elpis-canvas-auto", next ? "on" : "off"); } catch { /* this session only */ } if (next) tidy(); };
  const dashboard = agents.find(node => node.id === dashboardId);
  // Edits apply to every selected agent: one in the inspector, several together.
  const editEach = (change: (data: AgentData) => Partial<AgentData>) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.type === "agent" && chosen.some(item => item.id === node.id) ? { ...node, data: { ...node.data, ...change(node.data) } } : node) }));
  const edit = (patch: Partial<AgentData>) => editEach(() => patch);
  // Several agents share the folders they all may write; adding or removing one changes it for each.
  const commonFolders = chosen.reduce<string[]>((common, node, index) => index ? common.filter(folder => node.data.writeScopes.includes(folder)) : node.data.writeScopes, []);
  const setCommonFolders = (next: string[]) => editEach(data => ({ writeScopes: [...data.writeScopes.filter(folder => !commonFolders.includes(folder) || next.includes(folder)), ...next.filter(folder => !data.writeScopes.includes(folder))] }));
  const remove = (ids: string[]) => {
    const gone = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id));
    if (!gone.length) return;
    checkpoint(); setNotice(""); setDeleted(gone.map(node => node.type === "agent" ? node.data.title : "note").join(", "));
    setGraph(current => ({ ...current, nodes: current.nodes.filter(node => !gone.some(item => item.id === node.id)), edges: current.edges.filter(edge => !ids.includes(edge.source) && !ids.includes(edge.target)) })); setSelection([]);
  };
  const renameAgent = (id: string, title: string) => {
    if (!title) return;
    checkpoint(); setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id && node.type === "agent" ? { ...node, data: { ...node.data, title } } : node) }));
  };
  // Turning a wire one-way or two-way: one-way must not close a loop.
  const setKind = (edge: CanvasEdge, kind: CanvasEdge["kind"]) => {
    if (!kind && makesLoop(graph.edges.filter(item => item.id !== edge.id), edge.source, edge.target)) { setNotice("One-way, that wire would make a loop: an agent can't wait for itself."); return; }
    setGraph(current => ({ ...current, edges: current.edges.map(item => item.id === edge.id ? { ...item, id: `${item.source}${kind ? "~" : "->"}${item.target}`, kind } : item) }));
  };
  const removeWire = (id: string) => { checkpoint(); setGraph(current => ({ ...current, edges: current.edges.filter(edge => edge.id !== id) })); setMenu(null); };
  // The mouse as in DaVinci's Fusion and 3ds Max's Slate: left-drag on empty board draws a selection box, middle-drag
  // pans, scroll pans and Ctrl/Cmd+scroll zooms at the pointer, and agents snap to a 20 px grid. A plain click picks that one node even
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
  const onEdgeClick = (event: ReactMouseEvent, edge: Edge) => { if (edge.source === FATHER) return; const at = menuAt(event, 2); if (at) setMenu({ ...at, kind: "wire", edge: { id: edge.id, source: edge.source, target: edge.target, ...((edge as CanvasEdge).kind ? { kind: (edge as CanvasEdge).kind } : {}) } }); };
  const editFlow = (event: ReactMouseEvent, edge: CanvasEdge) => {
    if (edge.source === FATHER) return;
    event.stopPropagation(); const at = menuAt(event, 1); if (!at) return;
    setMenu(null); setFlowEdit({ edge, left: at.left, top: at.top });
  };
  const saveFlow = (label: string) => {
    if (!flowEdit) return;
    checkpoint(); const { edge } = flowEdit;
    setGraph(current => edge.source === MOTHER ? { ...current, motherFlow: label } : { ...current, edges: current.edges.map(item => item.id === edge.id ? { ...item, label } : item) });
    setFlowEdit(null); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
  };
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
  // A structural action begins a new undo step, even when the preceding edit is still in its typing burst.
  const checkpoint = () => {
    const steps = history.current;
    if (graph !== steps.settled) { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; steps.settled = graph; }
  };
  const restored = useRef(false);
  const restore = (next: CanvasGraph) => { history.current.restoring = true; restored.current = shapeKey(next) !== shapeKey(graph); setGraph(next); setSelection(current => current.filter(id => next.nodes.some(node => node.id === id))); setMenu(null); };
  const undo = () => {
    setDeleted(null);
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
    const taken = agents.map(node => node.data.title);
    const isoTaken = isoBoxes();
    const nodes = clip.nodes.map(node => {
      const title = node.type === "agent" ? agentName(taken, node.data.title.split(" · ").slice(1).join(" · ") || node.data.title) : "";
      if (title) taken.push(title);
      const slot = node.isoPosition ? place({ x: node.isoPosition.x - ISO_NODE.w / 2, y: node.isoPosition.y }, isoTaken, ISO_NODE) : undefined;
      if (slot) isoTaken.push({ ...slot, w: ISO_NODE.w, h: ISO_NODE.h });
      return { ...node, isoPosition: slot ? { x: slot.x + ISO_NODE.w / 2, y: slot.y + ISO_NODE.top } : undefined, id: ids.get(node.id)!, ...(node.type === "agent" ? { data: { ...node.data, title } } : {}), position: { x: Math.round(node.position.x - left + origin.x), y: Math.round(node.position.y - top + origin.y) } } as CanvasNode;
    });
    const edges = clip.edges.map(edge => ({ ...edge, id: `${ids.get(edge.source)}->${ids.get(edge.target)}`, source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
    checkpoint();
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges] }));
    setSelection(nodes.map(node => node.id));
  };
  const copy = (ids = selection) => { const clip = takeOut(ids); if (clip.nodes.length) clipboard.current = clip; };
  const paste = (at?: XYPosition) => { if (clipboard.current) putIn(clipboard.current, at ?? (pointer.current ? flow.screenToFlowPosition(pointer.current) : undefined)); };
  const duplicate = (ids = selection) => putIn(takeOut(ids));
  // Contract every link kind across removed agents; Mother links remain derived from the surviving roots.
  const removeKeepingFlow = (ids: string[]) => {
    const gone = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id));
    if (!gone.length) return;
    checkpoint();
    const next = deleteKeepingFlow(graph, ids);
    setNotice(""); setDeleted(`${gone.map(node => node.type === "agent" ? node.data.title : "note").join(", ")} · kept ${next.keptLinks} ${next.keptLinks === 1 ? "link" : "links"}`);
    setGraph(next.graph);
    setSelection([]);
  };
  const fitAll = () => { if (iso) isoController.current?.fit(); else void flow.fitView({ ...OVERVIEW, duration: 250 }); };
  // F2 renames: the inspector's name field takes the keys, the name selected.
  const nameField = useRef<HTMLInputElement>(null), [nameFocus, setNameFocus] = useState<string | null>(null);
  useEffect(() => {
    if (nameFocus && selected?.id === nameFocus && panelOpen && nameField.current) {
      nameField.current.focus(); nameField.current.select(); setNameFocus(null);
    }
  }, [nameFocus, selected?.id, panelOpen]);
  const rename = () => { const take = () => { nameField.current?.focus(); nameField.current?.select(); }; if (nameField.current) take(); else setTimeout(take, 0); };
  const describe = (count: number, notes: number) => [count && `${count} ${count === 1 ? "agent" : "agents"}`, notes && `${notes} ${notes === 1 ? "note" : "notes"}`].filter(Boolean).join(" and ");
  const menuView = (current: BoardMenu): { name: string; title: string; detail?: string; items: MenuItem[]; onDelete?: () => void } => {
    if (current.kind === "wire") {
      const from = current.edge.source === MOTHER ? null : titleOf(current.edge.source), to = titleOf(current.edge.target);
      const removeIt = from ? () => removeWire(current.edge.id) : undefined;
      const sideBySide = current.edge.kind === "alongside";
      return { name: "Wire", title: "Wire", detail: `${from ?? "Mother"} ${sideBySide ? "↔" : "→"} ${to}`, onDelete: removeIt, items: [
        { label: "Describe the flow", hint: "Name what the receiving agent gets", take: () => { const at = menuAt({ clientX: current.client.x, clientY: current.client.y }, 1); if (at) setFlowEdit({ edge: current.edge, left: at.left, top: at.top }); } },
        ...(sideBySide ? [] : [{ label: "Insert agents here", hint: from ? `Between ${from} and ${to}` : `Before ${to}, started by the Mother`, take: () => openAdder(current.client, undefined, current.edge) }]),
        ...(from ? [sideBySide
          ? { label: "Make it one-way", hint: `${to} waits for ${from}`, take: () => setKind(current.edge, undefined) }
          : { label: "Make it two-way", hint: `${from} and ${to} work at the same time, each told about the other`, take: () => setKind(current.edge, "alongside") }] : []),
        ...(removeIt ? [{ label: "Remove wire", hint: sideBySide ? `${from} and ${to} stop working alongside` : `${to} stops waiting for ${from}`, keys: "Delete", take: removeIt }] : [])] };
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
        { label: "Info", keys: "Enter", take: () => setDashboardId(only.id) },
        { label: "Rename", keys: "F2", take: rename },
        { label: "Add agents after it", hint: "They wait for it", take: () => openAdder(current.client, { id: only.id, as: "target" }) },
        { label: "Duplicate", keys: "Ctrl+D", take: () => duplicate(ids) },
        { label: "Copy", keys: "Ctrl+C", take: () => copy(ids) },
        { label: "Delete, keep the flow", hint: "Reconnect its inputs and outputs across every link kind", keys: "Ctrl+Del", take: () => removeKeepingFlow(ids) },
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
  const inputsNeeded = (id: string) => graph.edges.filter(edge => waits(edge) && edge.target === id && agents.some(node => node.id === edge.source))
    .filter(edge => states[edge.source]?.status !== "succeeded" || states[checkOf(edge.source)]?.status !== "succeeded" || clashes[edge.source])
    .map(edge => `${titleOf(edge.source)} (${clashes[edge.source] ? "merge clash" : states[edge.source]?.status === "succeeded" ? CHECK_LABEL[states[checkOf(edge.source)]?.status ?? "idle"] : STATUS_LABEL[states[edge.source]?.status ?? "idle"]})`);
  const selectedInputs = selected ? inputsNeeded(selected.id) : [];
  const selectedInputText = selectedInputs.length ? `Needs ${selectedInputs.join(", ")}` : selected && graph.edges.some(edge => waits(edge) && edge.target === selected.id) ? "All inputs captured" : "Zero inputs · starts first";
  // Kahn's waves, for the run-order list: what starts together, and how each wave is doing.
  const columns = [...new Set(order.values())].sort((a, b) => a - b).map(level => ({ level, members: agents.filter(node => order.get(node.id) === level) }));
  const waveState = (members: typeof agents) => { const of = (node: (typeof agents)[number]) => [states[node.id]?.status, states[checkOf(node.id)]?.status];
    return members.some(node => of(node).includes("running")) ? "running" : members.length && members.every(node => of(node)[1] === "succeeded") ? "succeeded" : members.some(node => of(node).some(status => status === "failed" || status === "blocked")) ? "failed" : undefined; };
  const choiceKey = (data: AgentData) => data.model ? `${canonicalProvider(data.provider) ?? ""}|${data.model}` : "";
  const shared = (key: (data: AgentData) => string) => new Set(chosen.map(node => key(node.data))).size === 1 ? key(chosen[0].data) : "mixed";
  const modelPatch = (value: string): Partial<AgentData> => { const [provider, ...rest] = value.split("|"); return value ? { provider: provider || null, model: rest.join("|"), effort: null } : { provider: null, model: null, effort: null }; };
  const modelOptions = (provider?: string | null) => [<option key="" value="">Default model</option>, ...catalog.filter(item => provider === undefined || item.provider === provider).map(item => <option key={`${item.provider}|${item.model}`} value={`${item.provider ?? ""}|${item.model}`} data-hint={provider === undefined ? item.providerLabel : undefined}>{item.label}</option>)];
  const mixed = <option value="mixed" disabled>Mixed</option>;
  const selectedModel = selected ? catalog.find(item => item.model === selected.data.model && item.provider === canonicalProvider(selected.data.provider)) : undefined;

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
    const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), agents: true, name: `Father · ${graph.name || "Workflows"}`.slice(0, 120),
      ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}),
      instructions: [goal && `Goal of the whole run: ${goal}`, "You are the Father: you run the agents past the Mother's ten, after her part has succeeded, and you report to her."].filter(Boolean).join("\n\n") });
    const result = await runPart(created.thread.id, `Father · ${graph.name || "Workflows"}`, tasks);
    return { tasks, threadId: created.thread.id, graphId: result.graphId, status: "running" };
  }

  // Sends one part of the run. With several writing agents in a git repository, each works in its own worktree and
  // Elpis merges them into the project's branch after the run; without a repository Elpis refuses that, so it isn't asked.
  async function runPart(rootThreadId: string, name: string, tasks: RunTask[]) {
    const repository = Boolean(cwd) && wantsIsolation(tasks) && await api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(cwd!)}`).then(result => result.repository === true, () => false);
    return api<{ graphId: string }>("/workflows/run", { ...(graph.template === "recursive" ? { roundLimit: graph.roundLimit } : {}), ...runPayload(rootThreadId, name, tasks, Math.max(1, Math.min(maxAtOnce, allowed.atOnce)), repository) });
  }

  async function start() {
    // Agents work inside a project: without one, the notice offers the project menu right there.
    if (!cwd) { setNeedProject(true); setNotice("Choose the project the agents work in, then run again."); return; }
    // Prompts and folders left empty are Elpis's to fill: from the run's goal, or, with none written, from the team as
    // drawn. A run never stops for a missing goal.
    // An agent without folders in a project that has none writes only its own folder: nothing for Elpis to choose.
    const empty = agents.some(node => !node.data.instruction.trim() || !node.data.writeScopes.length && Boolean(project.folders?.length));
    const ready = empty ? await letElpis(mother.brief.trim() || DRAWN) : graph;
    if (!ready) return;
    const built = runParts(ready);
    if ("error" in built) { setNotice(built.error); return; }
    setStarting(true); setNotice(""); setUndoLoad(null); setStates({}); setClashes({}); setLog([]); said.current = {}; reports.current.clear(); followLog.current = true;
    try {
      // The Mother is the run's chat: her model, and the goal as her instructions. `agents` turns the multi-agent runtime
      // on for this chat alone; the Ledger's SUBAGENTS switch still governs every other chat.
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), agents: true, name: ready.name.slice(0, 120) || "Workflows",
        ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}), ...(mother.brief.trim() ? { instructions: mother.brief.trim() } : {}) });
      const result = await runPart(created.thread.id, ready.name || "Workflows", built.mother);
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running", startedAt: Date.now(), ...(built.father.length ? { father: { tasks: built.father, status: "pending" } } : {}) });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  }

  const chat = selected ? states[selected.id]?.chat : null;
  // Both views share the graph, selection, settings and connection callbacks.
  const [iso, setIso] = useState(false);
  return <section className="agents-canvas" aria-label="Workflows" data-panel={panelOpen ? "open" : "closed"}>
    <header className="canvas-header">
      <Input aria-label="Graph name" className="canvas-name" value={graph.name} maxLength={120} onChange={event => setGraph(current => ({ ...current, name: event.target.value }))} />
      {projectMenu}
      {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={over(run) ? run.father?.status ?? run.status : "running"} />{over(run) ? "Finished" : run.father?.threadId ? "Running · the Father's part" : "Running"} · {done} of {agents.length} done</span>}
      <span className="canvas-spacer" />
      <ViewToggle iso={iso} onChange={setIso} />
      {run && <Button variant="ghost" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open run chat</Button>}
      <Button variant="ghost" size="sm" aria-pressed={motherOpen} onClick={() => setSelection([MOTHER])} title="The run's settings: the brief every agent gets, her model, how many agents"><i className="canvas-kind" data-kind="mother" />Mother</Button>
      <Button variant="ghost" size="sm" aria-pressed={autoLayout} onClick={toggleAuto} title={autoLayout ? "Auto-arrange is on: the board keeps run-order columns (Kahn's waves) after every change. Click to place agents freely." : "Auto-arrange is off. Click to arrange by run order and keep it so."}><ListOrdered size={14} />Auto-arrange</Button>
      <Button variant="ghost" size="sm" aria-label="Side panel" aria-pressed={panelOpen} title={panelOpen ? "Hide the side panel: the board takes the whole width" : "Show the side panel: patterns, run order, the selected agent"} onClick={() => showPanel(!panelOpen)}>{panelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}</Button>
      <Button size="sm" onClick={() => void start()} disabled={starting || Boolean(run && !over(run))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
    </header>
    <div className="canvas-board" ref={board}
      onPointerDownCapture={event => {
        if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element) || !event.target.matches(".react-flow__pane")) return;
        boxDrag.current = { x: event.clientX, y: event.clientY, base: event.shiftKey || event.ctrlKey || event.metaKey ? [...selection] : [], moved: false };
        event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      onPointerMove={event => {
        pointer.current = { x: event.clientX, y: event.clientY };
        const start = boxDrag.current;
        if (!start || (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)) return;
        start.moved = true;
        const bounds = event.currentTarget.getBoundingClientRect(), left = Math.min(start.x, event.clientX), top = Math.min(start.y, event.clientY), right = Math.max(start.x, event.clientX), bottom = Math.max(start.y, event.clientY), crossing = event.clientX < start.x;
        setSelectionBox({ x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top, crossing });
        const picked = [...event.currentTarget.querySelectorAll<HTMLElement>(".react-flow__node:not(.react-flow__node-father)")].filter(node => {
          const box = node.getBoundingClientRect();
          return crossing ? box.left <= right && box.right >= left && box.top <= bottom && box.bottom >= top : box.left >= left && box.right <= right && box.top >= top && box.bottom <= bottom;
        }).map(node => node.dataset.id!);
        setSelection([...new Set([...start.base, ...picked])]);
      }}
      onPointerUp={event => {
        const start = boxDrag.current; if (!start) return;
        boxDrag.current = null; setSelectionBox(null);
        if (!start.moved) { setSelection(start.base); setMenu(null); }
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { if (boxDrag.current) setSelection(boxDrag.current.base); boxDrag.current = null; setSelectionBox(null); }}
      onLostPointerCapture={() => { boxDrag.current = null; setSelectionBox(null); }}
      // A double-click on empty board, whichever layer React Flow put under the pointer, creates an agent there.
      onDoubleClick={event => { const target = event.target as Element; if ((target === event.currentTarget || target.closest(".react-flow")) && !target.closest(".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap")) addAgent({ x: event.clientX, y: event.clientY }); }}>
      <div className="canvas-telemetry">
        {run && <section className="canvas-hud" aria-label="Run clock"><span>{over(run) ? (["succeeded", "completed"].includes(run.father?.status ?? run.status) ? "Run done" : "Run ended") : "Running"}</span><RunClock key={run.graphId} since={run.startedAt} until={run.endedAt} /></section>}
        {columns.length > 0 && <section className="canvas-order" aria-label="Run order">
          <p className="hud-menu-title" title="In-degree zero starts first; later waves need earlier agents and their checks">Kahn&rsquo;s order</p>
          <ol>{columns.map(({ level, members }) => { const names = members.map(node => node.data.title || "Untitled").join(", "); return <li key={level} data-status={waveState(members)}><span>Wave {level}</span><strong title={names}>{names}</strong></li>; })}</ol>
        </section>}
        <p className="canvas-inputs" aria-label="Inputs needed" title={selected ? `${selected.data.title}: ${selectedInputText}` : "Select an agent to inspect its inputs"}>{selected ? <><b>{selected.data.title}: </b>{selectedInputText}</> : "Select an agent to inspect its inputs"}</p>
      </div>
      {iso ? <IsoBoard graph={graph} father={split.father} states={states} selected={selection} onSelect={setSelection} onOpen={setDashboardId} onRename={renameAgent} onWireClick={editFlow} dark={dark} controller={isoController} modelLabel={modelLabel}
        onConnect={connect} onAdd={(at, id, end) => addAgent(at, id ? { id, as: end === "source" ? "target" : "source" } : undefined)}
        onCommand={(at, id, end) => openAdder(at, { id, as: end === "source" ? "target" : "source" })}
        onNodeMenu={(event, id) => { const node = nodes.find(node => node.id === id); if (node) onNodeContextMenu(event, node); }}
        onBoardMenu={onPaneContextMenu} onWireMenu={onEdgeClick} /> : <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={({ source, target }) => connect(source, target)} onConnectEnd={onConnectEnd}
        onConnectStart={event => { const spot = "touches" in event ? event.touches[0] : event; connectFrom.current = { x: spot.clientX, y: spot.clientY }; }} connectOnClick={false}
        onNodeDoubleClick={(_, node) => { if (node.type === "agent") setDashboardId(node.id); }}
        onEdgeClick={(event, edge) => editFlow(event, { id: edge.id, source: edge.source, target: edge.target })} onEdgeContextMenu={(event, edge) => { event.preventDefault(); onEdgeClick(event, edge); }} onNodeContextMenu={onNodeContextMenu} onPaneContextMenu={onPaneContextMenu} multiSelectionKeyCode={["Shift", "Control", "Meta"]} nodeDragThreshold={5} nodeClickDistance={5} paneClickDistance={5} selectionKeyCode={null} panOnDrag={[1]} panActivationKeyCode={null} panOnScroll zoomOnScroll={false} zoomActivationKeyCode={["Control", "Meta"]} snapToGrid snapGrid={[20, 20]} connectionRadius={32} onNodeClick={onNodeClick}
        onNodeDragStart={() => { dragged.current = true; }} onNodeDragStop={() => setTimeout(() => { dragged.current = false; })}
        onPaneClick={() => { setSelection([]); setMenu(null); }} deleteKeyCode={null} zoomOnDoubleClick={false} colorMode={dark ? "dark" : "light"} fitView fitViewOptions={FIT} minZoom={0.3} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} fitViewOptions={OVERVIEW} />
        <MiniMap pannable zoomable className="canvas-minimap" style={{ width: 150, height: 100 }} />
      </ReactFlow>}
      {selectionBox && <div aria-hidden="true" className={`canvas-selection absolute pointer-events-none z-10 border ${selectionBox.crossing ? "border-dashed border-success bg-success/12" : "border-solid border-primary bg-primary/10"}`} style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.width, height: selectionBox.height }} />}
      {run && <section className="canvas-log-panel" aria-label="Run capture">
        <p className="hud-menu-title">Run log · {log.length} events</p>
        <ol ref={logList} className="canvas-log" role="log" aria-label="Run log" aria-live="polite" aria-relevant="additions" onScroll={event => { const el = event.currentTarget; followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12; }}>
          {log.map((line, index) => <li key={`${line.at}-${index}`} data-tone={line.tone}><button data-slot="log-line" type="button" title={`Observed +${clock(line.at - run.startedAt)} · ${line.text}`} onClick={() => { if (line.agent) { setSelection([line.agent]); setDashboardId(line.agent); } else setSelection([MOTHER]); }}><time>+{clock(line.at - run.startedAt)}</time><span title={line.text}>{line.text}</span></button></li>)}
        </ol>
      </section>}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <div className="canvas-toolbar" role="toolbar" aria-label="Add to Workflows">
        <span className="canvas-toolbar-label">Add</span>
        <Button variant="ghost" size="sm" aria-label="Add agent" title="An agent that writes: give it a prompt and the folders it may write; Elpis checks its work after it" onClick={() => addAgent()}><i className="canvas-kind" data-kind="agent" />Agent</Button>
        <details className="dropdown dropdown-top canvas-characters">
          <summary className={buttonVariants({ variant: "ghost", size: "sm", className: "btn btn-ghost btn-sm" })}>Characters</summary>
          <div className="dropdown-content bg-base-100 text-base-content rounded-box shadow p-2 z-20 grid gap-1" role="group" aria-label="Character agents">
            {characters.map(character => <Button key={character.id} variant="ghost" size="sm" className="btn btn-ghost btn-sm justify-start" aria-label={`Add ${character.name}`} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); addCharacter(character); }}>
              <span className="avatar"><div className="w-7 h-7"><img src={portraits[character.id]} alt="" /></div></span>{character.name}
            </Button>)}
          </div>
        </details>
        <Button variant="ghost" size="sm" onClick={() => addNote()}><StickyNote size={14} />Note</Button>
        <Button variant="ghost" size="sm" className="canvas-toolbar-more" onClick={() => openAdder()} title="Type a prompt, or how many, the model and thinking, then the prompts; Tab opens it too">Command <kbd>Tab</kbd></Button>
        <Button variant="ghost" size="sm" aria-label="Arrange by run order" title="Arrange by run order and fit the view" onClick={tidy}><ListOrdered size={14} />Arrange</Button>
        {/* The keys, as Deus Ex's control strip shows them: a few, short; the rest are in each control's tooltip. */}
        <span className="canvas-toolbar-keys" title={iso ? "Click an agent to select it. Shift adds to the selection. Drag the empty board to pan." : "AutoCAD selection: drag left to right for a solid window (fully inside); right to left for a dashed crossing (touching). Shift adds to the selection."}><span><kbd>Space</kbd>Patterns</span><span><kbd>A</kbd>Add next</span><span><kbd>Enter</kbd>Info</span><span><kbd>Shift</kbd>{iso ? "Select several" : "AutoCAD selection"}</span><span><kbd>Ctrl+A</kbd>All</span></span>
      </div>
      {graph.template === "recursive" && <label className="canvas-round-limit">Round limit <Input className="input input-sm w-20" type="number" aria-label="Round limit" min={1} max={100} value={graph.roundLimit ?? ""} onChange={event => setGraph(current => ({ ...current, roundLimit: event.target.value ? Number(event.target.value) : undefined }))} /></label>}
      {patternCommand !== null && <form className="canvas-pattern-command bg-base-100 text-base-content" aria-label="Workflow command" onSubmit={event => {
        event.preventDefault(); const number = Number(patternCommand);
        if (!Number.isInteger(number) || number < 1 || number > PATTERNS.length) { setNotice("Choose a pattern number from 1 to 5."); return; }
        if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return; }
        checkpoint(); setGraph(current => applyPattern(current, number)); setPatternCommand(null); setSelection([]); setRun(null); setStates({}); setNotice("");
        setTimeout(() => fitAll(), 60); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
      }}>
        <span className="text-xs">{PATTERNS.map((name, index) => `${index + 1} ${name}`).join(" · ")}</span>
        <Input className="input input-sm w-full" aria-label="Workflow pattern" autoFocus inputMode="numeric" value={patternCommand} placeholder="Pattern number · Enter applies · Esc cancels" onChange={event => setPatternCommand(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPatternCommand(null); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus(); } }} />
      </form>}
      {adding && <CommandBar adding={adding} room={room} limit={limit} catalog={catalog} providers={providers} onClose={() => setAdding(null)}
        onAgents={command => { addAgents(Math.max(1, command.count ?? 1), { model: command.model?.model ?? null, provider: command.model?.provider ?? null, effort: command.effort }, adding, command.tasks); setAdding(null); }}
        onNote={text => { addNote(adding.at, text); setAdding(null); }} onAsk={text => { setAdding(null); void letElpis(text); }} />}
      {menu && (view => <CanvasMenu at={menu} {...view} onClose={() => setMenu(null)} />)(menuView(menu))}
      {dashboard && <AgentDashboard node={dashboard} own={own.get(dashboard.id) ?? ""} wave={order.get(dashboard.id)} status={states[dashboard.id]?.status ?? "idle"} check={states[checkOf(dashboard.id)]?.status ?? "idle"} clash={clashes[dashboard.id]} chat={states[dashboard.id]?.chat ?? null} modelLabel={modelLabel(dashboard.data)}
        waitsFor={inputsNeeded(dashboard.id)} feeds={graph.edges.filter(edge => waits(edge) && edge.source === dashboard.id).map(edge => titleOf(edge.target))}
        onOpenChat={onOpenChat} onSettings={() => { setSelection([dashboard.id]); showPanel(true); setDashboardId(null); }} onClose={() => setDashboardId(null)} />}
      {flowEdit && <div className="canvas-flow-edit" style={{ left: flowEdit.left, top: flowEdit.top }}><CanvasTextEdit key={flowEdit.edge.id} label="Flow label" maxLength={60} value={flowEdit.edge.source === MOTHER ? graph.motherFlow ?? "" : graph.edges.find(edge => edge.id === flowEdit.edge.id)?.label ?? ""} onSave={saveFlow} onCancel={() => setFlowEdit(null)} /></div>}
      {deleted && <p className="canvas-notice" data-tone="info" role="status"><span title={`Deleted ${deleted}`}>Deleted {deleted} ·</span><Button variant="outline" size="sm" onClick={() => { undo(); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus(); }}>Undo</Button></p>}
      {planning && !deleted && <p className="canvas-notice" data-tone="info" role="status">Elpis is on it: {planning.length > 60 ? `${planning.slice(0, 60)}…` : planning}</p>}
      {undoLoad && !notice && !planning && !deleted && <p className="canvas-notice" data-tone="info" role="status">Loaded {undoLoad.loaded}.
        <Button variant="outline" size="sm" onClick={() => { setGraph(undoLoad.previous); setUndoLoad(null); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); }}>Undo</Button>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setUndoLoad(null)}><X size={13} /></Button></p>}
      {notice && <p className="canvas-notice" role="alert">{notice}{needProject && !cwd && projectMenu}<Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></Button></p>}
    </div>
    {!panelOpen ? null : sourceId ? <WorkflowSources id={sourceId} onBack={() => setSourceId(null)} /> : selected ? <aside className="canvas-side" aria-label="Selected agent">
      <p className="hud-menu-title">Agent{order.get(selected.id) ? ` · wave ${order.get(selected.id)}` : ""}{states[selected.id] ? ` · ${STATUS_LABEL[states[selected.id].status]}` : ""} · {CHECK_LABEL[states[checkOf(selected.id)]?.status ?? "idle"]}</p>
      <label>Name<Input ref={nameField} aria-label="Name" title={selected.data.title} value={selected.data.title} maxLength={256} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); promptField.current?.focus(); } }} onChange={event => edit({ title: event.target.value })} /></label>
      <label>Prompt<Textarea ref={promptField} aria-label="Prompt" rows={5} value={selected.data.instruction} placeholder="What this agent should do; left empty, Elpis fills it from the goal" onChange={event => edit({ instruction: event.target.value, title: promptName(selected.data, event.target.value) })} /></label>
      <label>Provider<OptionSelect aria-label="Provider" value={canonicalProvider(selected.data.provider) ?? ""} onChange={event => {
        const provider = event.target.value || null, offered = catalog.filter(item => item.provider === provider);
        const keep = offered.find(item => item.model === selected.data.model);
        const preferred = providerDefault(provider);
        if (!offered.length) pendingProviderDefaults.current.set(selected.id, { provider, model: selected.data.model, effort: selected.data.effort ?? null }); else pendingProviderDefaults.current.delete(selected.id);
        edit({ provider, model: keep?.model ?? preferred?.model ?? null, effort: keep?.efforts.includes(selected.data.effort ?? "") ? selected.data.effort : null });
      }}>{choices.map(choice => <option key={choice.id} value={choice.provider ?? ""}>{choice.label}</option>)}</OptionSelect></label>
      <label>Model<OptionSelect aria-label="Model" title={modelLabel(selected.data)} value={choiceKey(selected.data)} onChange={event => {
        if (event.target.value) { pendingProviderDefaults.current.delete(selected.id); edit(modelPatch(event.target.value)); return; }
        const provider = canonicalProvider(selected.data.provider), fallback = provider ? providerDefault(provider) : undefined;
        if (provider && !fallback) pendingProviderDefaults.current.set(selected.id, { provider, model: null, effort: null }); else pendingProviderDefaults.current.delete(selected.id);
        edit({ provider, model: fallback?.model ?? null, effort: null });
      }}>
        {modelOptions(canonicalProvider(selected.data.provider))}
        {selected.data.model && !selectedModel && <option value={choiceKey(selected.data)}>{selected.data.model}</option>}</OptionSelect></label>
      {selectedModel && selectedModel.efforts.length > 0 && <label>Thinking<OptionSelect aria-label="Thinking" value={selected.data.effort ?? ""} onChange={event => edit({ effort: event.target.value || null })}>
        <option value="">Model default{selectedModel.defaultEffort ? ` (${selectedModel.defaultEffort})` : ""}</option>{selectedModel.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</OptionSelect></label>}
      <FolderPicker cwd={cwd} {...project} value={selected.data.writeScopes} own={own.get(selected.id)} onChange={writeScopes => edit({ writeScopes })} />
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
      <label>Model<OptionSelect aria-label="Model" value={shared(choiceKey)} onChange={event => edit(modelPatch(event.target.value))}>{mixed}{modelOptions()}</OptionSelect></label>
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
      <label>Her model<OptionSelect aria-label="Her model" value={mother.model ? `${mother.provider ?? ""}|${mother.model}` : ""} onChange={event => { const patch = modelPatch(event.target.value); setMother({ model: patch.model ?? null, provider: patch.provider ?? null }); }}>{modelOptions()}</OptionSelect></label>
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
      {critical.length > 1 && <p className="canvas-critical" onMouseEnter={() => setShowCritical(true)} onMouseLeave={() => setShowCritical(false)} title="The longest chain: the run takes at least this many rounds, however many agents run at once">
          <span>Critical path · {critical.length} rounds</span>{critical.map(titleOf).join(" → ")}</p>}
      {(["Patterns", "Research", "Start"] as const).map(group => <section key={group} className="canvas-templates" aria-label={group}>
        <p className="hud-menu-title">{group === "Start" ? "Start fresh" : group}</p>
        {TEMPLATES.filter(template => template.group === group).map(template => <div key={template.id}><button data-slot="pattern-card" type="button" className="canvas-template w-full" aria-current={graph.template === template.id || undefined} onClick={() => loadTemplate(template)}>
          <strong>{template.name}{graph.template === template.id && <span className="canvas-template-loaded">On the board</span>}</strong>
          <Shape shape={shapes.get(template.id) ?? []} /><small>{template.description}</small>
          {template.caution && <small className="canvas-template-caution">{template.caution}</small>}
          {template.source && <small className="canvas-template-source">{template.source}</small>}</button>
          <a className={buttonVariants({ variant: "link", size: "xs" })} href={`#workflow-sources-${template.id}`} aria-label={`Sources for ${template.name}`} onClick={event => { event.preventDefault(); setSelection([]); setSourceId(template.id); }}>Sources</a></div>)}
      </section>)}
      <section className="canvas-guide" aria-label="Guide">
        <p className="hud-menu-title">Guide</p>
        <ul>{GUIDE.map(item => <li key={item.href}><a href={item.href} target="_blank" rel="noreferrer">{item.title}</a><small>{item.note}</small></li>)}</ul>
      </section>
    </aside>}
  </section>;
}

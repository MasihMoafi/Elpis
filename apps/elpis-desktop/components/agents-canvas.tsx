"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import "@xyflow/react/dist/style.css";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ResizeEdge } from "@/components/resize-edge";
import { Background, BackgroundVariant, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, getBezierPath, useReactFlow, useStoreApi, type Edge, type EdgeProps, type EdgeChange, type FinalConnectionState, type Node, type NodeChange, type NodeProps, type XYPosition } from "@xyflow/react";
import { Check, ChevronRight, Copy, ExternalLink, FileText, FolderOpen, ListOrdered, Pencil, Play, Plus, Square, StickyNote, Trash2, X } from "lucide-react";
import { AgentsIcon } from "@/components/elpis-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MenuRow } from "@/components/ui/menu-row";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { WorkflowProgress, useWorkflowTeam, workflowThreadActive } from "@/components/workflow-progress";
import { agentParentId } from "@/lib/agent-runs.mjs";
import { WorkflowHistory } from "@/components/workflow-history";
import { graphForWorkflow, readWorkflowRun, taskState, type WorkflowRunRef, type RecordedWorkflow } from "@/components/workflow-chat";
import { WorkflowColourMenu, WorkflowIdentityEditor, WorkflowMark } from "@/components/workflow-identity";
import type { WorkflowCatalog, WorkflowIdentity } from "@/lib/workflow-identity";
import { WorkflowSources } from "@/components/workflow-sources";
import { summarize, workedFor } from "@/components/transcript";
import { isoLayout } from "@/lib/iso";
import { IsoBoard, NoteText, ViewToggle, type IsoController } from "@/components/agents-iso";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { deleteKeepingFlow } from "@/lib/canvas-delete-flow";
import { extractAgent, frameBounds, insidePolygon, insertAgent, segmentsCross } from "@/lib/canvas-editing";
import { executionGraph, linkedIds } from "@/lib/canvas";
import { api, providerChoices, subscriptionOf, type Entry, type Model, type ProviderSettings, type Thread } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { appStorage } from "@/lib/projects";
import { filesText, mergeStops, runPayload, stopText, wantsIsolation } from "@/lib/canvas-isolation";
import { PATTERNS, WORKFLOWS, LANGUAGES, languageOf, type Language, type ReadyMade, agentCount, WHOLE_PROJECT, applyPattern, agent, ownFolders, agentColor, CHECK_LABEL, COLUMN, DONE, FATHER, MOTHER, STATUS_LABEL, TASKS_PER_AGENT, waits, TEMPLATES, agentName, promptName, applyPlan, arrange, boardForPlan, checkOf, commandParts, shapeOf, makesLoop, maxAgents, newAgents, newId, parseCommand, parents, initialGraph, runParts, saveGraph, waves, withMother, type AgentData, type CanvasEdge, type CanvasGraph, type CanvasNode, type CatalogModel, type Command, type MotherSettings, type NoteData, type Plan, type RunTask, type TaskStatus } from "@/lib/canvas";

/** The workflow side panel: 290 px by default, dragged wider or narrower by its left edge. */
const CANVAS_SIDE = { min: 240, initial: 290, max: 640 };

/** A run: the Mother's part, and the Father's when the graph has more agents than she runs (lib/canvas.ts `parents`):
 * his tasks wait in `father` until her part has succeeded, then run in his own chat. */
type Run = { rootThreadId: string; graphId: string; status: string; startedAt: number; endedAt?: number; error?: string; father?: { tasks: RunTask[]; threadId?: string; graphId?: string; status: string; reported?: boolean } };
/** Whether the whole run is over: her part, and his if he has one. */
const over = (run: Run) => FINISHED.has(run.status) && (!run.father || (FINISHED.has(run.father.status) && (!run.father.threadId || run.father.reported)));
/** `next`: the stage the bridge runs after this one (the Father's part): his chat and run, and whether his report reached her. */
type Listed = { data: { id: string; status: string; error?: string | null; next?: { threadId?: string; graphId?: string; status: string; reported?: boolean; error?: string | null }; tasks: { id: string; status: TaskStatus; assignedThreadId: string | null; failureReason?: string | null; result?: unknown }[] }[] };
type HandleEnd = "source" | "target";
/** `clash` is the files of a merge clash that stopped the run on this agent (lib/canvas-isolation.ts). */
type AgentNodeData = AgentData & { status?: TaskStatus; check?: TaskStatus; clash?: string[]; modelLabel?: string; wave?: number; onHandle?: (id: string, end: HandleEnd, event: ReactMouseEvent) => void; onQuick?: (id: string) => void };
type MotherData = { run: "idle" | "running" | "finished" | "cancelled" | "failed"; children: number; limit: number; identity?: WorkflowIdentity; onHandle?: AgentNodeData["onHandle"] };
const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);
/** Her or his card in words, the same as the status chip: finished only when the run succeeded. */
const ended = (status: string): "running" | "finished" | "cancelled" | "failed" => !FINISHED.has(status) ? "running" : status === "failed" || status === "cancelled" ? status : "finished";
/** An ended run in words: Finished only when it succeeded (28 Oct: "Finished · 0 of 2 done" over a cancelled run). */
const ENDED: Record<string, string> = { succeeded: "Finished", completed: "Finished", failed: "Failed", cancelled: "Cancelled" };
/** `at`: when it was seen; a saved run reopened later has no time to show, like its other lines. */
const stoppedLine = (status: string, error?: string | null, at?: number): { at?: number; text: string; tone: "fail" }[] => status === "failed" || status === "cancelled" ? [{ ...(at === undefined ? {} : { at }), text: `RUN ${ENDED[status].toUpperCase()} · ${error || "no reason was recorded"}`, tone: "fail" }] : [];
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);
/** What Elpis is asked when the user ran a team without writing a goal: keep what is drawn and set, and fill the rest. */
const DRAWN = "Run this team as drawn: keep every agent, its wiring and whatever is already set; give each agent the prompt and folders it lacks, from its name and its place in the team.";
/** A board's structure, without positions: its agents and wires. */
const shapeKey = (graph: CanvasGraph) => `${graph.nodes.filter(node => node.type === "agent").map(node => node.id).join(",")}|${graph.edges.map(edge => `${edge.id}${edge.kind ?? ""}`).join(",")}`;
/** Measurements belong to the renderer, not to an undoable user edit. */
const editKey = (graph: CanvasGraph) => JSON.stringify({ ...graph, nodes: graph.nodes.map(({ id, type, position, isoPosition, data }) => ({ id, type, position, isoPosition, data })) });
/** Fit the graph inside the available board, on opening and after layout changes. */
const FIT = { padding: 0.06, maxZoom: 1, minZoom: 0.05 };
const OVERVIEW = { padding: 0.08, maxZoom: 1 };
// The ready-made workflow comes first (28 Oct, Masih: "move it on top").
const ENTRY_PATTERNS = [...WORKFLOWS.map(workflow => ({ id: workflow.id, label: workflow.name })), { id: "auto", label: "Auto · Elpis chooses" }, { id: "split-parts", label: "Parallel" }, { id: "sequential", label: "Sequential" }, { id: "research", label: "Research" }];
// Mother takes the strongest model this person has (28 Oct, Masih: "Depends on which model the user has available; for me, opus").
const MOTHER_FIRST = [/^claude\/opus$/, /^agy\/gemini-4-argon-high$/, /^gpt-6\.1-sol$/, /^claude\/sonnet$/, /opus/i, /gemini-4-argon/i, /sonnet/i];

/** An agent on the canvas: it writes. Its run-order wave, name, model and state, with an input on the left (what it
 * waits for) and an output on the right (what waits for it), as Deus Ex's hacking screen links its nodes. The ring at
 * its corner is its check: empty until it runs, turning while it runs, then a tick or a cross. Clicking a dot opens
 * the command bar to add agents on that side. */
function AgentNode({ id, data }: NodeProps<Node<AgentNodeData>>) {
  const status = data.status ?? "idle", check = data.check ?? "idle";
  const summary = data.muted ? "muted · skipped in runs" : data.clash ? "clash" : STATUS_LABEL[status];
  return <div className="agent-node" data-kind="agent" data-status={status} data-muted={data.muted || undefined} style={{ "--agent-color": agentColor(id, data) } as CSSProperties}>
    <Handle type="target" position={Position.Left} title="Add agents this one waits for" onClick={event => data.onHandle?.(id, "target", event)} />
    <span className="agent-node-kind">Agent</span>
    <strong className="agent-node-title" title={data.title || "Untitled"}>{data.title || "Untitled"}</strong>
    <small className="agent-node-meta" title={`${data.modelLabel ?? "Default model"} · ${summary}`}>{data.modelLabel ?? "Default model"} · {summary}</small>
    <span className="agent-node-mark" role="img" data-check={check} aria-label={CHECK_LABEL[check]} title={CHECK_LABEL[check]}>{check === "succeeded" ? <Check size={12} /> : check === "failed" || check === "blocked" ? <X size={12} /> : null}</span>
    <Handle type="source" position={Position.Right} title="Add agents that wait for this one" onClick={event => data.onHandle?.(id, "source", event)} />
    {/* Both quick-create buttons add one successor linked only from this agent. */}
    <Button variant="outline" size="icon-xs" className="agent-node-plus nodrag" data-side="right" aria-label={`Add the next agent after ${data.title || "this one"}`} title="Add the next agent: it waits for this one" onClick={event => { event.stopPropagation(); data.onQuick?.(id); }}><Plus /></Button>
    <Button variant="outline" size="icon-xs" className="agent-node-plus nodrag" data-side="bottom" aria-label={`Add an agent after ${data.title || "this one"}`} title="Add an agent after this one, connected only from this one" onClick={event => { event.stopPropagation(); data.onQuick?.(id); }}><Plus /></Button>
  </div>;
}

/** The Mother: the run's chat. She starts the agents that wait for no one (her wires) and receives every report. */
function MotherNode({ id, data }: NodeProps<Node<MotherData>>) {
  return <div className="agent-node mother-node" data-kind="mother" data-status={data.run === "running" ? "running" : undefined}
    title="The Mother is the run's chat: every agent is her child, she starts the ones that wait for no one, and every report comes back to her.">
    <span className="agent-node-kind">{data.identity && <WorkflowMark identity={data.identity} />}Mother</span>
    <strong className="agent-node-title">This run&rsquo;s chat</strong>
    <small className="agent-node-meta">{agentCount(data.children)} · {data.run === "idle" ? "not run" : data.run}</small>
    <Handle type="source" position={Position.Right} title="Add agents she starts" onClick={event => data.onHandle?.(id, "source", event)} />
  </div>;
}

/** A FigJam-style sticky note: free text on the canvas, never sent to Elpis. */
function NoteNode({ id, data }: NodeProps<Node<NoteData & { onText?: (id: string, text: string) => void }>>) {
  // The strip is the handle: dragging it moves the note, while the text below takes the keys.
  return <div className="canvas-note"><span className="canvas-note-grip" title="A note for you, never sent to an agent; drag here to move it">Note · for you</span>
    <NoteText text={data.text} onText={text => data.onText?.(id, text)} /></div>;
}
/** The Father: he runs the agents past the Mother's ten, in his own chat, once her part has succeeded, and reports to
 * her. Drawn only when the graph needs him. */
function FatherNode({ data }: NodeProps<Node<MotherData>>) {
  return <div className="agent-node mother-node" data-kind="mother" data-status={data.run === "running" ? "running" : undefined}
    title="The Father runs the agents past the Mother's ten, in his own chat, after her part has succeeded, and reports to her.">
    <span className="agent-node-kind">Father</span>
    <strong className="agent-node-title">Reports to the Mother</strong>
    <small className="agent-node-meta">{agentCount(data.children)} · {data.run === "idle" ? "after her part" : data.run}</small>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
type FrameData = { title: string; renaming: boolean; onPick: () => void; onName: (title: string | null) => void };
function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  return <div className="canvas-frame"><div className="canvas-frame-title" onClick={data.onPick}>
    {data.renaming ? <CanvasTextEdit label="Frame name" value={data.title} maxLength={120} onSave={data.onName} onCancel={() => data.onName(null)} /> : <strong>{data.title}</strong>}
  </div></div>;
}
const NODE_TYPES = { agent: AgentNode, mother: MotherNode, father: FatherNode, note: NoteNode, frame: FrameNode };

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
type Adding = { at: XYPosition; isoAt?: XYPosition; left: number; top: number; height: number; from?: { id: string; as: HandleEnd }; between?: CanvasEdge; seed?: string };
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
    if (event.ctrlKey || event.metaKey || event.altKey) return;
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
      <Textarea autoFocus className="min-h-0" aria-label="Prompts, one per line" rows={Math.min(8, Math.max(3, total))} value={tasks}
        placeholder={Array.from({ length: Math.min(3, total) }, (_, index) => `Prompt for agent ${index + 1}`).join("\n")} onChange={event => setTasks(event.target.value)}
        onKeyDown={event => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
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
    <Textarea ref={field} autoFocus className="min-h-0 resize-none" aria-label="Command" value={text} spellCheck={false} placeholder="Tell Elpis what to do, or 3 sol high: prompt; prompt"
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
      {rows.map((row, index) => <MenuRow key={row.key} role="option" aria-selected={row === current}
        onMouseEnter={() => setActive(index)} onClick={() => { setActive(index); (row.open ?? row.take)(); }}>
        <span className="select-option">{row.label}{row.hint && <small>{row.hint}</small>}</span>{row.more && <ChevronRight size={14} className="quick-add-more" />}
      </MenuRow>)}
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
  return <div className="quick-add hud-menu nodrag nowheel" role="menu" tabIndex={-1} aria-label={name} style={{ left: at.left, top: at.top, maxHeight: `calc(100% - ${at.top + 8}px)` }} onContextMenu={event => event.preventDefault()}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) onClose(); }}
    onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      else if ((event.key === "Delete" || event.key === "Backspace") && onDelete) { event.preventDefault(); event.stopPropagation(); onClose(); onDelete(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <p className="hud-menu-title quick-add-title"><span>{title}</span>{detail && <span>{detail}</span>}</p>
    <div ref={list} className="quick-add-list">{items.map((item, index) => <MenuRow key={item.label} role="menuitem" autoFocus={index === 0} onClick={() => { onClose(); item.take(); }}>
      <span className="select-option">{item.label}{item.hint && <small>{item.hint}</small>}</span>{item.keys && <kbd className="kbd-hint" aria-hidden="true">{item.keys}</kbd>}</MenuRow>)}</div>
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
    <Input className="hud-cut-sm h-6 w-12 px-1.5 text-center tabular-nums md:text-xs" inputMode="numeric" aria-label={label} aria-invalid={Boolean(error)} value={text}
      onChange={event => type(event.target.value.replace(/\D/g, ""))} onBlur={() => { setText(String(value)); setError(""); }}
      onKeyDown={event => { if (event.key === "Escape") { setText(String(value)); setError(""); } }} />
    {error && <span className="canvas-count-error" role="alert">{error}</span>}
  </label>;
}

/** One agent's info panel (Enter or double-click): what it is, what it waits for and feeds, and, once it runs, what it
 * has done so far from its own chat, refreshed while it works. */
/** What a chat has done so far, read from it, and again every 2 s while it works: an agent's, or the Mother's. */
function LiveFeed({ chat, working, idle, ready }: { chat: string | null; working: boolean; idle: string; ready: boolean }) {
  const [entries, setEntries] = useState<Entry[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!ready || !chat) return;
    let live = true;
    const read = () => api<{ data: Entry[] }>(`/threads/${encodeURIComponent(chat)}?limit=100`).then(result => { if (live) { setEntries(result.data); setError(""); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    void read();
    const timer = working ? setInterval(() => void read(), 2000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [chat, working, ready]);
  const items = entries?.map(entry => entry.item) ?? [];
  const said = [...items].reverse().find(item => item.type === "agentMessage" && typeof item.text === "string")?.text;
  return <section className="agent-dashboard-live" aria-label="Live">
    <p className="hud-menu-title">Live</p>
    {!chat ? <p>{idle}</p>
      : !ready && !entries ? <p>Reconnect to read its chat.</p>
      : ready && error ? <p role="alert">{error}</p>
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
      {value.map(folder => <span key={folder} className="canvas-chip" title={folderLabel(folder)}><span className="canvas-chip-label">{folderLabel(folder)}</span><Button variant="ghost" size="icon-xs" aria-label={`Remove ${folderLabel(folder)}`} onClick={() => onChange(value.filter(item => item !== folder))}><X className="size-3" /></Button></span>)}</span>
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

function AgentDashboard({ node, own, wave, status, check, clash, chat, waitsFor, feeds, modelLabel, ready, onOpenChat, onSettings, onClose }: { node: Extract<CanvasNode, { type: "agent" }>; own: string; wave?: number; status: TaskStatus | "idle"; check: TaskStatus | "idle"; clash?: string[]; chat: string | null; waitsFor: string[]; feeds: string[]; modelLabel: string; ready: boolean; onOpenChat: (id: string) => void; onSettings: () => void; onClose: () => void }) {
  const data = node.data, panel = useRef<HTMLDivElement>(null);
  // A click anywhere else on the page closes it, as Escape does.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !panel.current?.contains(target) && !target.closest("[data-agent-info]")) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  return <div ref={panel} className="agent-dashboard hud-menu" role="dialog" tabIndex={-1} aria-label={`${data.title} info`} data-kind="agent" data-status={status}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><span className="agent-node-kind">Agent · {STATUS_LABEL[status]}</span><strong>{data.title || "Untitled"}</strong>
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
    <LiveFeed chat={chat} working={status === "running"} ready={ready} idle="Not started. What it does shows here once the graph runs." />
    {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
  </div>;
}

/** The agents canvas: the Mother, ready-made architectures, agents wired by what they wait for and laid out in Kahn's
 * waves, and a run that follows each agent live. The graph is kept on this device (lib/canvas.ts). */
/** `projectMenu` is the app's project chooser (components/project-picker.tsx), shown in the header: agents write inside the project. */
type Props = { threads?: readonly Thread[]; workflowCatalog: WorkflowCatalog; models: Model[]; cwd?: string; dark: boolean; ready: boolean; onOpenChat: (id: string) => void; projectMenu?: React.ReactNode; recordedRun?: WorkflowRunRef; onLeaveRecordedRun?: () => void; onOpenRecordedRun?: (run: WorkflowRunRef) => void;
  /** Makes `folder` the workflows' project (an existing project with it, or a new one named after it). */
  onUseFolder?: (folder: string) => Promise<void> };
export function AgentsCanvas(props: Props) {
  return <ReactFlowProvider><Canvas key={props.recordedRun?.id ?? "draft"} {...props} /></ReactFlowProvider>;
}

/** Models listed by a provider other than the engine's own, fetched once per provider and settings version. */
const catalogs = new Map<string, { version: string; models?: Model[]; error?: string }>();
const OFFLINE_WORKFLOW = "Reconnect to design or run workflows. Your draft stays editable.";

function runFailure(detail: string) {
  if (/EACCES|EPERM|permission|write.*(?:refused|denied)|not writable/i.test(detail)) return `Elpis could not write the run's files. Choose a project you can write to or allow the requested write, then run again. ${detail}`;
  return `${detail} Review this message and the agents' Info, then try Run graph again.`;
}

function Canvas({ models, cwd, dark, ready, threads = [], onOpenChat, projectMenu, workflowCatalog, recordedRun, onLeaveRecordedRun, onOpenRecordedRun, onUseFolder }: Props) {
  const isoController = useRef<IsoController>(null);
  const flow = useReactFlow(), flowStore = useStoreApi(), board = useRef<HTMLDivElement>(null), pointer = useRef<XYPosition | null>(null), connectFrom = useRef<XYPosition | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>(() => recordedRun ? { name: "Workflow", workflowId: recordedRun.id, nodes: [], edges: [] } : initialGraph());
  const connection = useRef({ ready, generation: 0 });
  if (connection.current.ready !== ready) connection.current = { ready, generation: connection.current.generation + 1 };
  const runtimeAttempt = () => {
    const generation = connection.current.generation;
    return () => connection.current.ready && connection.current.generation === generation;
  };
  const [renamingPreset, setRenamingPreset] = useState(false), [morePatterns, setMorePatterns] = useState(false);
  const presetName = TEMPLATES.some(template => template.id === graph.template && template.name === graph.name.replace(/ \d+$/, ""));
  const requestText = typeof graph.request === "string" ? graph.request : "";
  const identity = graph.workflowId ? workflowCatalog.identities[graph.workflowId] : undefined;
  const previousIdentity = useRef<WorkflowIdentity | undefined>(undefined);
  useEffect(() => {
    const before = previousIdentity.current; previousIdentity.current = identity;
    if (identity && before?.id === identity.id && before.name !== identity.name && graph.name === before.name) setIdentity({ name: identity.name });
  }, [identity, graph.name]);
  useEffect(() => {
    if (recordedRun || !workflowCatalog.hydrated) return;
    try {
      const item = workflowCatalog.ensure(graph.workflowId || crypto.randomUUID(), graph.name);
      if (graph.workflowId !== item.id || !identity) setGraph(current => ({ ...current, workflowId: item.id, name: item.name }));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  }, [workflowCatalog.hydrated, workflowCatalog.ensure, graph.workflowId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sourceId, setSourceId] = useState<string | null>(null);
  // What is selected is kept apart from the saved graph: a click picks one, Shift+click or Shift+drag several.
  const [selection, setSelection] = useState<string[]>([]), [dashboardId, setDashboardId] = useState<string | null>(null);
  const pendingProviderDefaults = useRef(new Map<string, { provider: string | null; model: string | null; effort: string | null }>());
  const boxDrag = useRef<{ x: number; y: number; base: string[]; previous: string[]; subtract: boolean; moved: boolean; lasso: boolean; points: XYPosition[] } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>(null);
  const [lasso, setLasso] = useState(false), [stroke, setStroke] = useState<XYPosition[] | null>(null);
  const cutter = useRef<{ points: XYPosition[]; ids: Set<string>; cancelled?: boolean } | null>(null), suppressContext = useRef(false);
  const nodeDrag = useRef<{ before: CanvasGraph; id: string; ids: string[]; extract: boolean; cancelled: boolean } | null>(null);
  const [insertWire, setInsertWire] = useState<string | null>(null), [renamingFrame, setRenamingFrame] = useState<string | null>(null);
  const connectionCancelled = useRef(false);
  const reconnecting = useRef<string | null>(null), alongsideDrag = useRef(false);
  const [finding, setFinding] = useState<string | null>(null), [findIndex, setFindIndex] = useState(0);
  const [runTargets, setRunTargets] = useState<string[] | null>(null);
  const minimap = graph.minimap === true;
  const toggleMinimap = () => { checkpoint(); setGraph(current => ({ ...current, minimap: current.minimap !== true })); };
  useEffect(() => { if (selection.length) setSourceId(null); }, [selection]);
  const [menu, setMenu] = useState<BoardMenu | null>(null), wireMenu = menu?.kind === "wire" ? menu : null;
  // The side panel folds away to give the board the whole width, remembered on this device; choosing an agent or the
  // Mother brings it back.
  const [panelOpen, setPanelOpen] = useState(() => { try { return appStorage().getItem("elpis-canvas-panel") !== "closed"; } catch { return true; } });
  // The side panel's width: dragged by the same edge as the chat side panel, kept across visits (Masih, 28 Oct).
  const [sideWidth, setSideWidth] = useState<number | null>(() => { try { return Number(appStorage().getItem("elpis-canvas-panel-width")) || null; } catch { return null; } });
  const resizeSide = (width: number) => { setSideWidth(width); try { appStorage().setItem("elpis-canvas-panel-width", String(width)); } catch { /* kept for this session only */ } };
  const showPanel = (open: boolean) => { setPanelOpen(open); try { appStorage().setItem("elpis-canvas-panel", open ? "open" : "closed"); } catch { /* kept for this session only */ } setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); };
  useEffect(() => { if (selection.length && !panelOpen && !boxDrag.current) showPanel(true); }, [selection, selectionBox, stroke]); // eslint-disable-line react-hooks/exhaustive-deps
  const project = useProjectFolders(cwd);
  const own = useMemo(() => ownFolders(graph), [graph]);
  const [notice, setNotice] = useState("");
  const runReasonId = useId(), offlineReasonId = useId();
  const [deleted, setDeleted] = useState<string | null>(null);
  useEffect(() => { if (!deleted) return; const timer = setTimeout(() => setDeleted(null), 4000); return () => clearTimeout(timer); }, [deleted]);
  const [flowEdit, setFlowEdit] = useState<{ edge: CanvasEdge; left: number; top: number } | null>(null);
  const [maxAtOnce, setMaxAtOnce] = useState(3);
  const [patternCommand, setPatternCommand] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [run, setRun] = useState<Run | null>(null), [starting, setStarting] = useState(false);
  useEffect(() => { if (run) void workflowCatalog.refresh(); }, [run?.graphId, run?.status, workflowCatalog.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const startingRun = useRef(false);
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => { if (isoController.current) isoController.current.fit(); else void flow.fitView(FIT); }, 60);
    return () => clearTimeout(timer);
  }, [run?.graphId, flow]); // eslint-disable-line react-hooks/exhaustive-deps
  const [savedStates, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null }>>({});
  const [savedRecord, setSavedRecord] = useState<RecordedWorkflow>();
  const liveTeam = useWorkflowTeam(savedRecord, ready, threads);
  const states = useMemo(() => {
    const next = { ...savedStates };
    const assigned = new Map((savedRecord?.tasks ?? []).flatMap(task => task.assignedThreadId ? [[task.assignedThreadId, task.id] as const] : []));
    for (const thread of liveTeam.agents) {
      const id = assigned.get(thread.id) ?? `live:${thread.id}`;
      if (workflowThreadActive(thread)) next[id] = { status: "running", chat: thread.id };
      else if (!next[id]) next[id] = { status: "pending", chat: thread.id };
    }
    return next;
  }, [savedStates, savedRecord, liveTeam.agents]);
  const liveTopology = JSON.stringify(liveTeam.agents.map(thread => [thread.id, agentParentId(thread)]).sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")));
  useEffect(() => {
    if (!recordedRun || !savedRecord) return;
    setGraph(graphForWorkflow(savedRecord, liveTeam.agents));
    const timer = setTimeout(() => { if (isoController.current) isoController.current.fit(); else void flow.fitView(FIT); }, 60);
    return () => clearTimeout(timer);
  }, [recordedRun?.id, savedRecord?.id, liveTopology, flow]);
  // Where the engine's merge clash stopped the run: the clashing files, by the agent whose work clashed.
  const [clashes, setClashes] = useState<Record<string, string[]>>({});
  // The run log, as Deus Ex's event cards: what started, finished, passed its check or failed, newest last.
  type LogLine = { at?: number; agent?: string; text: string; tone: "start" | "done" | "fail" };
  const [log, setLog] = useState<LogLine[]>([]);
  const said = useRef<Record<string, TaskStatus>>({});
  const reports = useRef(new Set<string>()), logList = useRef<HTMLOListElement>(null);
  const followLog = useRef(true);
  useEffect(() => { if (followLog.current && logList.current) logList.current.scrollTop = logList.current.scrollHeight; }, [log]);
  // A retained run is a separate presentation, never the unfinished draft in local storage.
  const retainedRun = recordedRun ?? workflowCatalog.runs.find(item => item.id === graph.workflowId);
  useEffect(() => {
    if (!retainedRun || !ready) return;
    let live = true;
    void readWorkflowRun(retainedRun).then(record => {
      if (!live) return;
      setSavedRecord(record);
      if (recordedRun) setGraph(graphForWorkflow(record));
      const tasks = [...(record.tasks ?? []), ...(record.next?.tasks ?? [])];
      setStates(Object.fromEntries(tasks.map(task => [task.id, { status: taskState(task.status), chat: task.assignedThreadId ?? null }])));
      setRun({ rootThreadId: record.rootThreadId, graphId: record.id, status: record.status, startedAt: record.startedAt ?? record.createdAt ?? Date.now(),
        ...(record.endedAt ? { endedAt: record.endedAt } : {}), ...(record.error ? { error: record.error } : {}), ...(record.next ? { father: { tasks: [], threadId: record.next.threadId, graphId: record.next.graphId, status: record.next.status, reported: record.next.reported } } : {}) });
      setLog([...tasks.map(task => ({ agent: task.id, text: `${task.title || task.id} · ${task.status || "not recorded"}${task.failureReason ? ` · ${task.failureReason}` : ""}`, tone: task.status === "failed" || task.status === "blocked" ? "fail" : task.status === "succeeded" || task.status === "completed" ? "done" : "start" } as LogLine)), ...stoppedLine(record.status, record.error)]);
      setNotice(recordedRun ? "" : record.error || tasks.find(task => task.failureReason)?.failureReason || "");
    }).catch(cause => { if (live) setNotice(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [retainedRun?.id, retainedRun?.rootThreadId, ready]);
  const [, setFetched] = useState(0);
  const settings = useElpisSettings().data;
  // What Elpis allows: agents in one graph, and at once (bridge/elpis-features.mjs `agentLimits`).
  const allowed = settings?.agents ?? { graph: 256, atOnce: 6, source: "Elpis default" };
  useEffect(() => { if (recordedRun) return; const timer = setTimeout(() => { if (!saveGraph(graph)) setNotice("Could not keep the graph on this device."); }, 300); return () => clearTimeout(timer); }, [graph, recordedRun]);
  // A change made just before the window closes or reloads is kept too: the page saves the latest board on its way out.
  const latest = useRef(graph); latest.current = graph;
  useEffect(() => { if (recordedRun) return; const flush = () => saveGraph(latest.current); window.__elpisFlushWorkflow = flush; window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", flush); return () => { flush(); if (window.__elpisFlushWorkflow === flush) delete window.__elpisFlushWorkflow; window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); }; }, [recordedRun]);

  // The existing provider catalog, shared by Add and the inspector; execution uses ACP.
  const allChoices = useMemo(() => providerChoices(models, (settings ?? null) as ProviderSettings | null), [models, settings]);
  const choices = useMemo(() => allChoices.filter(choice => !choice.id.endsWith("/")), [allChoices]);
  // Antigravity and Claude: the model carries the route (agy/, claude/), so an agent on one keeps no provider (lib/api.ts).
  const subscriptions = allChoices.filter(choice => choice.id.endsWith("/"));
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
    if (!ready || !run || over(run)) return;
    let live = true, polling = false;
    const read = async (threadId: string, graphId: string) => {
      if (!live) return;
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
        if (!fresh.length && !failed && found.error) setNotice(runFailure(found.error));
        if (!fresh.length && failed) setNotice(runFailure(`${titleOf(failed.id.replace(/-check$/, ""))}: ${failed.failureReason}`));
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
        // Her record says how his stage goes: the bridge starts the Father after her part and delivers his report
        // (bridge/client.mjs #workflowEnded), so the run goes on when this screen is closed.
        const hers = await read(run.rootThreadId, run.graphId);
        if (hers && hers.status !== run.status) {
          next = { ...next, status: hers.status, ...(hers.error ? { error: hers.error } : {}) };
          if (live) setLog(current => [...current, ...stoppedLine(hers.status, hers.error, Date.now())]);
        }
        const father = next.father, stage = hers?.next;
        if (father && stage && (stage.threadId !== father.threadId || stage.status !== father.status || !!stage.reported !== !!father.reported)) {
          next = { ...next, father: { ...father, threadId: stage.threadId, graphId: stage.graphId, status: stage.status, reported: stage.reported } };
          if (stage.reported && !father.reported) setLog(current => [...current, { at: Date.now(), text: "FATHER REPORT RECEIVED · DATASTORE CAPTURED · Mother", tone: "done" }]);
        }
        if (stage?.error && live) setNotice(runFailure(stage.error));
        // His own run is read in a poll that did not just change him: the change restarts this effect, which reads at once.
        if (next.father === father && father?.threadId && father.graphId && !father.reported) await read(father.threadId, father.graphId);
        if (live && next !== run) setRun(over(next) ? { ...next, endedAt: Date.now() } : next);
      } catch (error) { if (live) setNotice(runFailure(error instanceof Error ? error.message : String(error))); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [run, ready]);

  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  const chosen = agents.filter(node => selection.includes(node.id)), selected = chosen.length === 1 ? chosen[0] : undefined;
  // The Father is her twin: a click on him opens her panel, which tells his part.
  const motherOpen = selection.length === 1 && (selection[0] === MOTHER || selection[0] === FATHER), mother = graph.mother ?? { brief: "", model: null, provider: null };
  const setMother = (patch: Partial<MotherSettings>) => setGraph(current => ({ ...current, mother: { ...(current.mother ?? { brief: "", model: null, provider: null }), ...patch } }));
  // Loading an architecture replaces the board; Undo, offered for a while, puts the old one back.
  const [undoLoad, setUndoLoad] = useState<{ loaded: string; previous: CanvasGraph } | null>(null);
  useEffect(() => { if (!undoLoad) return; const timer = setTimeout(() => setUndoLoad(null), 12000); return () => clearTimeout(timer); }, [undoLoad]);
  const shapes = useMemo(() => new Map([...TEMPLATES.map(template => [template.id, shapeOf(template.build())] as const), ...WORKFLOWS.map(workflow => [workflow.id, shapeOf(workflow.shape())] as const)]), []);
  const limit = maxAgents(graph), room = Math.max(0, limit - agents.length), order = useMemo(() => waves(graph), [graph]);
  // An agent is done once its check passes, unless its work clashed in the merge.
  // A join is done by Elpis and has no check: it is done when it is.
  const done = agents.filter(node => states[node.data.join ? node.id : checkOf(node.id)]?.status === "succeeded" && !clashes[node.id]).length;
  const runState: MotherData["run"] = recordedRun ? workflowThreadActive(liveTeam.mother) ? "running" : "idle" : run ? (ended(run.status)) : "idle";
  const fatherState: MotherData["run"] = run?.father?.threadId ? ended(run.father.status) : "idle";
  const modelLabel = (data: AgentData) => {
    if (data.join) return "Elpis";
    if (!data.model) return "Default model";
    const found = catalog.find(item => item.model === data.model && item.provider === canonicalProvider(data.provider));
    // A subscription's model (agy/…, claude/…) is named by the engine's own list (28 Oct: a card read "agy/gemini-3.8-flash-high").
    return found?.label ?? models.find(item => item.model === data.model)?.displayName ?? data.model;
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
  const split = useMemo(() => recordedRun ? { mother: graph.nodes.filter(node => node.type === "agent").map(node => node.id), father: [] } : parents(graph), [graph, recordedRun]), his = new Set(split.father);
  // React Flow shows a node once its size is known; the Father is not in the saved board, so his size is kept here.
  const [fatherSize, setFatherSize] = useState<{ width: number; height: number } | null>(null);
  const fatherRoots = agents.filter(node => his.has(node.id) && !graph.edges.some(edge => waits(edge) && edge.target === node.id && his.has(edge.source)));
  const fatherNode: Node | null = fatherRoots.length ? { id: FATHER, type: "father", deletable: false, selectable: false, draggable: false,
    // Under the Mother: like her, he starts his agents, so he sits in her column.
    position: (({ x, y }) => ({ x, y: y + 140 }))(graph.nodes.find(node => node.type === "mother")?.position ?? { x: 0, y: 0 }),
    ...(fatherSize ? { measured: fatherSize } : {}), data: { run: fatherState, children: split.father.length, limit } satisfies MotherData } : null;
  const nodesWithFather = (list: Node[]) => fatherNode ? [...list, fatherNode] : list;
  const frames: Node[] = (graph.frames ?? []).flatMap(frame => {
    const members = graph.nodes.filter(node => frame.nodeIds.includes(node.id));
    if (!members.length) return [];
    const bounds = frameBounds(members);
    return [{ id: frame.id, type: "frame", position: { x: bounds.x, y: bounds.y }, style: { width: bounds.width, height: bounds.height }, zIndex: -1, selectable: false, dragHandle: ".canvas-frame-title",
      data: { title: frame.title, renaming: renamingFrame === frame.id, onPick: () => setSelection([...frame.nodeIds, frame.id]), onName: title => {
        if (title) { checkpoint(); setGraph(current => ({ ...current, frames: current.frames?.map(item => item.id === frame.id ? { ...item, title } : item) })); }
        setRenamingFrame(null); focusBoard();
      } } satisfies FrameData }];
  });
  const nodes = useMemo<Node[]>(() => [...frames, ...nodesWithFather(graph.nodes.map(node => node.type === "mother"
    ? { ...node, deletable: false, selected: selection.includes(MOTHER), data: { run: runState, children: agents.length, limit, onHandle, identity } satisfies MotherData }
    : { ...node, selected: selection.includes(node.id), data: node.type === "agent" ? { ...node.data, status: states[node.id]?.status, check: states[node.data.join ? node.id : checkOf(node.id)]?.status, clash: clashes[node.id], modelLabel: modelLabel(node.data), wave: order.get(node.id), onHandle, onQuick } : { ...node.data, onText: setText } }),
  )], [graph, identity, renamingFrame, selection, states, clashes, models, order, runState, fatherState, limit, catalog.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const flowLabels = useMemo(() => flowLabelPositions(nodes.filter(node => node.type !== "frame"), graph.edges), [nodes, graph.edges]);
  const edges = useMemo<Edge[]>(() => [
    // The Mother's wires: she starts every agent of the first wave.
    ...agents.filter(node => order.get(node.id) === 1 && !his.has(node.id)).map((node, index) => ({ id: `${MOTHER}->${node.id}`, source: MOTHER, target: node.id, type: "mother", markerEnd: { type: MarkerType.ArrowClosed }, className: "canvas-edge-mother", selectable: false, deletable: false, reconnectable: false, focusable: false, selected: wireMenu?.edge.id === `${MOTHER}->${node.id}`, data: { trunk: index === 0, label: graph.motherFlow, live: states[node.id]?.status === "running" } })),
    // The Father's wires: he starts his agents that wait for none of his others.
    ...fatherRoots.map(node => ({ id: `${FATHER}->${node.id}`, source: FATHER, target: node.id, type: "default", markerEnd: { type: MarkerType.ArrowClosed }, className: "canvas-edge-mother", selectable: false, deletable: false, reconnectable: false, focusable: false, interactionWidth: 0, data: { live: states[node.id]?.status === "running" } })),
    ...graph.edges.map(edge => {
      // A wire goes live once its first agent's check passed and the second agent is running.
      const from = states[checkOf(edge.source)]?.status, to = states[edge.target]?.status, live = waits(edge) && from === "succeeded" && to === "running";
      if (edge.kind === "alongside") return { ...edge, type: "default", selected: wireMenu?.edge.id === edge.id || selection.includes(edge.id), data: { alongside: true, ...flowLabels.get(edge.id) }, className: "canvas-edge-alongside" };
      return { ...edge, type: "default", markerEnd: { type: MarkerType.ArrowClosed }, selected: wireMenu?.edge.id === edge.id || insertWire === edge.id || selection.includes(edge.id), data: { live, ...flowLabels.get(edge.id) }, className: from === "failed" || to === "blocked" ? "canvas-edge-cut" : live ? "canvas-edge-live" : from === "succeeded" ? "canvas-edge-done" : undefined };
    }),
  ], [graph.edges, graph.nodes, graph.motherFlow, states, order, wireMenu, flowLabels, insertWire, selection]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (nodeDrag.current?.cancelled) return;
    const savedChanges = changes.filter(change => change.type !== "select" && !("id" in change && frames.some(frame => frame.id === change.id)) && !(change.type === "remove" && change.id === MOTHER));
    if (!savedChanges.length && !changes.some(change => change.type === "position" && frames.some(frame => frame.id === change.id))) return;
    setGraph(current => {
      let next = applyNodeChanges(savedChanges, current.nodes as Node[]) as CanvasNode[];
      for (const change of changes) if (change.type === "position" && change.position) {
        const frame = current.frames?.find(frame => frame.id === change.id), members = frame && current.nodes.filter(node => frame.nodeIds.includes(node.id));
        if (!frame || !members?.length) continue;
        const before = frameBounds(members), dx = Math.round((change.position.x - before.x) / 20) * 20, dy = Math.round((change.position.y - before.y) / 20) * 20;
        next = next.map(node => frame.nodeIds.includes(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);
      }
      return { ...current, nodes: next, edges: removed.size ? current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) : current.edges };
    });
  };
  const onEdgesChange = (changes: EdgeChange[]) => setGraph(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges as Edge[]).map(({ id, source, target }) => ({ ...current.edges.find(edge => edge.id === id), id, source, target })) }));
  const validConnection = (source: string, target: string, ignored = reconnecting.current, alongside = false) => source !== target && [source, target].every(id => agents.some(node => node.id === id))
    && !graph.edges.some(edge => edge.id !== ignored && (edge.source === source && edge.target === target || edge.source === target && edge.target === source))
    && (alongside || graph.template === "recursive" || !makesLoop(graph.edges.filter(edge => edge.id !== ignored), source, target));
  const reconnect = (edge: CanvasEdge, source: string, target: string) => {
    if (connectionCancelled.current || !validConnection(source, target, edge.id, edge.kind === "alongside") || edge.source === source && edge.target === target) return;
    checkpoint(); restored.current = true;
    setGraph(current => ({ ...current, edges: current.edges.map(item => item.id === edge.id ? { ...item, id: `${source}${item.kind ? "~" : "->"}${target}`, source, target,
      feedback: !item.kind && makesLoop(current.edges.filter(wire => wire.id !== edge.id), source, target) || undefined } : item) }));
  };
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
  const place = (near?: XYPosition, taken = boxes(), size = { w: NODE_W, h: NODE_H }, closest = false) => {
    const start = near ?? firstColumn(), x = closest ? start.x : Math.round(start.x / 20) * 20;
    // A point gesture stays where requested, or at the nearest clear vertical boundary. Scanning only down can
    // jump past a whole row even when there is room just above the pointer.
    if (closest) {
      const ys = [start.y, ...taken.flatMap(item => [item.y - size.h - GAP, item.y + item.h + GAP])];
      ys.sort((a, b) => Math.abs(a - start.y) - Math.abs(b - start.y));
      const y = ys.find(y => freeAt(x, y, taken, size));
      if (y !== undefined) return { x, y };
    }
    for (let y = Math.round(start.y / 20) * 20; ; y += 20) if (freeAt(x, y, taken, size)) return { x, y };
  };
  const firstColumn = (): XYPosition => {
    const first = agents.filter(node => order.get(node.id) === 1), motherAt = graph.nodes.find(node => node.type === "mother")?.position ?? { x: 0, y: 0 };
    return first.length ? { x: Math.min(...first.map(node => node.position.x)), y: Math.min(...first.map(node => node.position.y)) } : { x: motherAt.x + COLUMN, y: motherAt.y };
  };
  const addAgents = (count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, where: Partial<Pick<Adding, "at" | "isoAt" | "from" | "between">> = {}, tasks: string[] = []) => {
    if (!room) { setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`); return; }
    // Beside the agent they came from (right if they wait for it, left if it waits for them), else where asked, else in
    // the first wave's column; each in the next free slot below the last.
    const { from, between } = where, source = from && graph.nodes.find(node => node.id === from.id);
    const spot = source ? { x: source.position.x + (from!.as === "target" ? COLUMN : -COLUMN), y: source.position.y } : where.at;
    const taken = boxes();
    const made = newAgents(Math.min(count, room), choice, { x: 0, y: 0 }, tasks, agents.map(node => node.data.title)).map(node => { const at = place(spot, taken); taken.push({ ...at, w: NODE_W, h: NODE_H }); return { ...node, position: at }; });
    // In the isometric view every agent keeps the spot it is drawn at, applied to the latest board.
    let pinned: Map<string, XYPosition> | null = null;
    if (iso) {
      const scene = isoLayout(graph, order, split.father.length ? FATHER : undefined), occupied = isoBoxes(scene);
      const origin = scene.find(item => item.id === from?.id)?.at;
      const at = where.isoAt ?? (origin ? { x: origin.x + (from?.as === "source" ? -COLUMN : COLUMN), y: origin.y } : { x: 300, y: 0 });
      for (const node of made) { const slot = place({ x: at.x - ISO_NODE.w / 2, y: at.y - ISO_NODE.top }, occupied, ISO_NODE, Boolean(where.isoAt)); node.isoPosition = { x: slot.x + ISO_NODE.w / 2, y: slot.y + ISO_NODE.top }; occupied.push({ ...slot, w: ISO_NODE.w, h: ISO_NODE.h }); }
      pinned = new Map(scene.map(item => [item.id, item.at])); isoController.current?.keepView();
    }
    const wire = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
    // On a wire, the new agents take its place: each waits for its first agent and feeds its second. From a dot or a
    // dropped wire, they join that agent. The Mother's wires are implied, never drawn.
    const wires = between ? made.flatMap(node => [...(between.source === MOTHER ? [] : [wire(between.source, node.id)]), wire(node.id, between.target)])
      : from && from.id !== MOTHER ? made.map(node => from.as === "target" ? wire(from.id, node.id) : wire(node.id, from.id)) : [];
    setGraph(current => ({ ...current, nodes: [...(pinned ? current.nodes.map(node => pinned!.has(node.id) ? { ...node, isoPosition: pinned!.get(node.id)! } : node) : current.nodes), ...made], edges: [...current.edges.filter(edge => edge.id !== between?.id), ...wires] }));
    setSelection(made.map(node => node.id));
    if (iso) setTimeout(() => isoController.current?.reveal(made.map(node => node.id)), 140); else reveal(made.map(node => node.id));
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
      const position = place({ x: wanted.x - ISO_NODE.w / 2, y: wanted.y - ISO_NODE.top }, isoBoxes(scene), ISO_NODE, Boolean(client));
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
  // A note from the toolbar lands in the free spot nearest the middle of the visible board; with none free, it goes
  // below and is brought into view, as new agents are.
  const visibleSpot = (taken = boxes()) => {
    const box = board.current?.querySelector(".react-flow")?.getBoundingClientRect(); if (!box) return undefined;
    const from = flow.screenToFlowPosition({ x: box.left, y: box.top }), to = flow.screenToFlowPosition({ x: box.right, y: box.bottom });
    const mid = { x: (from.x + to.x - NODE_W) / 2, y: (from.y + to.y - NODE_H) / 2 }, step = Math.max(20, Math.ceil((to.x - from.x) / 1200) * 20);
    let best: XYPosition | undefined;
    for (let x = Math.ceil((from.x + GAP) / step) * step; x + NODE_W + GAP <= to.x; x += step) for (let y = Math.ceil((from.y + GAP) / step) * step; y + NODE_H + GAP <= to.y; y += step)
      if (freeAt(x, y, taken) && (!best || Math.hypot(x - mid.x, y - mid.y) < Math.hypot(best.x - mid.x, best.y - mid.y))) best = { x, y };
    return best;
  };
  const addNote = (at?: XYPosition, text = "") => {
    checkpoint(); const spot = at || iso ? undefined : visibleSpot(), position = spot ?? place(at ?? viewMiddle()), id = newId("note");
    if (iso) isoController.current?.keepView();
    setGraph(current => ({ ...current, nodes: [...current.nodes, { id, type: "note", position, ...(iso ? { isoPosition: at ?? { x: 300, y: 0 } } : {}), data: { text } }] }));
    if (!at && !spot && !iso) reveal([id]);
  };
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
    setAdding({ at, ...(iso ? { isoAt: isoController.current?.position(point) } : {}), left: Math.max(8, Math.min(point.x - box.left, box.width - 348)), top, height: box.height - top - 8, ...(from ? { from } : {}), ...(between ? { between } : {}), ...(seed ? { seed } : {}) }); setMenu(null);
  };
  // Drop on an agent to connect, or on empty board to create a connected agent there.
  // A click without a drag keeps the dot's command menu.
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (reconnecting.current) { connectFrom.current = null; return; }
    if (connectionCancelled.current) { connectFrom.current = null; return; }
    if (state.isValid) { connectFrom.current = null; return; }
    const spot = "changedTouches" in event ? event.changedTouches[0] : event, start = connectFrom.current;
    if (!state.fromNode || !state.fromHandle || !start) return;
    connectFrom.current = null;
    const from = state.fromNode.id, over = state.toNode?.id ?? (document.elementFromPoint(spot.clientX, spot.clientY)?.closest(".react-flow__node") as HTMLElement | null)?.dataset.id;
    if (over && over !== from) { const [source, target] = state.fromHandle.type === "source" ? [from, over] : [over, from]; connect(source, target, "altKey" in event && event.altKey ? "alongside" : undefined); return; }
    const hit = document.elementFromPoint(spot.clientX, spot.clientY);
    if (over || !hit?.closest(".react-flow") || hit.closest(".react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap") || Math.hypot(spot.clientX - start.x, spot.clientY - start.y) < 8) return;
    addAgent({ x: spot.clientX, y: spot.clientY }, { id: from, as: state.fromHandle.type === "source" ? "target" : "source" });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!board.current?.getClientRects().length || target && target !== document.body && !target.closest(".agents-canvas")) return;
      // Fields, readable errors and popup owners consume their own keys, including navigation and copying.
      if (target?.closest("input, textarea, select, .canvas-error-details, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='menu'], [role='listbox']")) return;
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyA" && !target?.closest(".react-flow, .iso-board")) return;
      const onBoard = !target || target === document.body || Boolean(target.closest(".react-flow, .iso-board"));
      const editingKey = (event.ctrlKey || event.metaKey) && ["KeyA", "KeyZ", "KeyY", "KeyC", "KeyX", "KeyV", "KeyD"].includes(event.code) || ["Delete", "Backspace", "Home", "F2"].includes(event.key);
      if (!onBoard && !editingKey) return;
      if (event.key !== "Escape" && (boxDrag.current || cutter.current || nodeDrag.current || connectFrom.current)) return;
      const ctrl = event.ctrlKey || event.metaKey, plain = !ctrl && !event.altKey && !event.shiftKey;
      const take = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "Escape") {
        take();
        if (boxDrag.current) { setSelection(boxDrag.current.previous); boxDrag.current = null; setSelectionBox(null); setStroke(null); setLasso(false); }
        else if (cutter.current) { cutter.current.cancelled = true; setStroke(null); }
        else if (nodeDrag.current) { nodeDrag.current.cancelled = true; setGraph(nodeDrag.current.before); setInsertWire(null); }
        else if (flowStore.getState().connection.inProgress || connectFrom.current) { connectionCancelled.current = true; connectFrom.current = null; flowStore.getState().cancelConnection(); }
        else if (iso && isoController.current?.cancelGesture()) { /* the wire's original stays */ }
        else if (lasso) setLasso(false);
        else setSelection([]);
      }
      else if (ctrl && !event.altKey && event.key === "Enter") { take(); if (event.shiftKey) previewRun(); else void start(); }
      else if (ctrl && !event.altKey && event.code === "KeyG") { take(); if (event.shiftKey) ungroup(); else frameSelection(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyI") { take(); setSelection(graph.nodes.filter(node => node.type !== "mother" && !selection.includes(node.id)).map(node => node.id)); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyF") { take(); setFinding(""); setFindIndex(0); setMenu(null); setAdding(null); }
      else if (event.altKey && event.shiftKey && !ctrl && event.code === "KeyT") { take(); tidySelection(); }
      else if (event.altKey && event.shiftKey && !ctrl && event.code === "KeyM") { take(); toggleMinimap(); }
      else if (event.altKey && !ctrl && event.key.startsWith("Arrow")) { take(); nudge(event.key, event.shiftKey ? 200 : 20); }
      else if (event.shiftKey && !event.altKey && !ctrl && ["ArrowLeft", "ArrowRight"].includes(event.key)) { take(); setSelection(linkedIds(graph, selection, event.key === "ArrowLeft" ? "upstream" : "downstream")); }
      else if (event.shiftKey && !event.altKey && !ctrl && event.code === "KeyA") { take(); openAdder(); }
      else if (event.shiftKey && !event.altKey && !ctrl && event.code === "KeyS") { take(); checkpoint(); addNote(pointerPosition()); }
      else if (!ctrl && !event.altKey && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) { take(); keyboardMenu(); }
      else if (plain && event.code === "KeyL") { take(); setLasso(true); setMenu(null); setAdding(null); }
      else if (plain && event.code === "KeyM") { take(); mute(); }
      // A focused isometric agent walks the run order itself (components/agents-iso.tsx).
      else if (plain && event.key.startsWith("Arrow") && !target?.closest(".iso-node")) { take(); focusNearest(event.key); }
      else if (!ctrl && !event.altKey && (event.key === "+" || event.code === "NumpadAdd" || event.code === "Equal")) { take(); zoom(1.25); }
      else if (!ctrl && !event.altKey && (event.key === "-" || event.code === "NumpadSubtract")) { take(); zoom(1 / 1.25); }
      else if (plain && ["Digit0", "Numpad0"].includes(event.code)) { take(); zoom(0); }
      else if (plain && ["Period", "NumpadDecimal"].includes(event.code)) { take(); frameView(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyA") { take(); setSelection(graph.nodes.filter(node => node.type !== "mother").map(node => node.id)); }
      else if (plain && event.key === "Tab") { take(); openAdder(); }
      else if (!ctrl && !event.altKey && event.shiftKey && event.key === "Tab") { take(); focusPrevious(); }
      else if (plain && event.code === "KeyA") { take(); addAgent(undefined, selected ? { id: selected.id, as: "target" } : undefined); }
      else if (plain && event.code === "KeyF") { take(); frameView(); }
      else if (plain && event.code === "Space") { take(); setAdding(null); setMenu(null); setPatternCommand(""); }
      else if (plain && event.key === "Enter" && selected) { take(); setDashboardId(selected.id); }
      else if (ctrl && !event.altKey && event.code === "KeyZ") { take(); if (event.shiftKey) redo(); else undo(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyY") { take(); redo(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyC" && selection.length) { take(); copy(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyX" && selection.length) { take(); copy(); remove(selection); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyV" && clipboard.current) { take(); paste(); }
      else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyD" && selection.length) { take(); duplicate(); }
      else if (ctrl && !event.altKey && !event.shiftKey && event.key === "Delete" && selection.length) { take(); removeKeepingFlow(selection); }
      else if (plain && ["Delete", "Backspace"].includes(event.key) && selection.length) { take(); remove(selection.filter(id => id !== MOTHER && id !== FATHER)); }
      else if (plain && event.key === "Home") { take(); fitAll(); }
      else if (plain && event.key === "F2") { take(); const frame = graph.frames?.find(frame => selection.includes(frame.id)); if (frame) setRenamingFrame(frame.id); else if (selected) rename(); }
      else if (event.key.length === 1 && !ctrl && !event.altKey) { take(); openAdder(undefined, undefined, undefined, event.key); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });
  const loadTemplate = (template: (typeof TEMPLATES)[number]) => { setRenamingPreset(false); setUndoLoad({ loaded: template.name, previous: graph }); setGraph(current => ({ ...withMother(template.build()), maxAgents: current.maxAgents, mother: current.mother, request: current.request, template: template.id, planningPattern: template.id })); setSelection([]); setMenu(null); setDashboardId(null); setRun(null); setStates({}); setNotice("");
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
    const wires = graph.edges.filter(edge => ids.includes(edge.id));
    if (!gone.length && !wires.length && !graph.frames?.some(frame => ids.includes(frame.id))) return;
    checkpoint(); setNotice(""); setDeleted(gone.map(node => node.type === "agent" ? node.data.title : "note").join(", "));
    setGraph(current => ({ ...current, nodes: current.nodes.filter(node => !gone.some(item => item.id === node.id)), edges: current.edges.filter(edge => !ids.includes(edge.id) && !ids.includes(edge.source) && !ids.includes(edge.target)),
      frames: current.frames?.filter(frame => !ids.includes(frame.id)).map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !ids.includes(id)) })).filter(frame => frame.nodeIds.length) })); setSelection([]);
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
    const frame = graph.frames?.find(frame => frame.id === node.id);
    setSelection(frame ? [...frame.nodeIds, frame.id] : [node.id]);
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
    const frame = graph.frames?.find(frame => frame.id === node.id);
    if (frame) { const ids = [...frame.nodeIds, frame.id]; setSelection(ids); const at = menuAt(event, 8); if (at) setMenu({ ...at, kind: "nodes", ids }); return; }
    const ids = selection.includes(node.id) ? selection.filter(id => id !== MOTHER) : [node.id];
    if (!selection.includes(node.id)) setSelection([node.id]);
    const at = menuAt(event, ids.length > 1 ? 4 : 7); if (at) setMenu({ ...at, kind: "nodes", ids });
  };
  const onPaneContextMenu = (event: ReactMouseEvent | MouseEvent) => { event.preventDefault(); if (suppressContext.current) return; const at = menuAt(event, 5); if (at) setMenu({ ...at, kind: "board" }); };

  // Undo and redo (Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y): a burst of changes (typing a name, dragging an agent) is one step
  // once it settles.
  const history = useRef({ past: [] as CanvasGraph[], future: [] as CanvasGraph[], settled: graph, restoring: false });
  useEffect(() => {
    const steps = history.current;
    if (nodeDrag.current && !nodeDrag.current.cancelled) return;
    if (steps.restoring) { steps.restoring = false; steps.settled = graph; return; }
    if (editKey(graph) === editKey(steps.settled)) { steps.settled = graph; return; }
    const timer = setTimeout(() => { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; steps.settled = graph; }, 350);
    return () => clearTimeout(timer);
  }, [graph]);
  // A structural action begins a new undo step, even when the preceding edit is still in its typing burst.
  const checkpoint = () => {
    const steps = history.current;
    if (editKey(graph) !== editKey(steps.settled)) { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; }
    steps.settled = graph;
  };
  // Which workflow the board is (its id and saved name) changes with a run or a rename elsewhere, never by an edit on the
  // board: it goes into every undo step instead of becoming one, so Ctrl+Z undoes his last edit and keeps the workflow.
  const setIdentity = (patch: Partial<Pick<CanvasGraph, "workflowId" | "name">>) => {
    const steps = history.current, from = graph.workflowId, apply = (item: CanvasGraph) => item.workflowId === from ? { ...item, ...patch } : item;
    steps.past = steps.past.map(apply); steps.future = steps.future.map(apply); steps.settled = apply(steps.settled); setGraph(apply);
  };
  const restored = useRef(false);
  const restore = (next: CanvasGraph) => { history.current.restoring = true; restored.current = shapeKey(next) !== shapeKey(graph); setGraph(next); setSelection(current => current.filter(id => next.nodes.some(node => node.id === id) || next.edges.some(edge => edge.id === id) || next.frames?.some(frame => frame.id === id))); setMenu(null); };
  const undo = () => {
    setDeleted(null);
    const steps = history.current;
    // Changes not yet settled are the step undone.
    if (editKey(graph) !== editKey(steps.settled)) { steps.future = [graph]; restore(steps.settled); return; }
    const previous = steps.past.pop();
    if (previous) { steps.future.push(graph); restore(previous); }
  };
  const redo = () => { const steps = history.current, next = steps.future.pop(); if (next) { steps.past.push(graph); restore(next); } };

  // The clipboard (Ctrl+C, Ctrl+V): agents and notes with the wires among them, pasted as new ones; Ctrl+D duplicates
  // without touching it. As in Blender and Node-RED, no wire joins a copy to an original.
  const clipboard = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] } | null>(null);
  const takeOut = (ids: string[]) => {
    const nodes = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)), kept = new Set(nodes.map(node => node.id));
    return { nodes, edges: graph.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target)), frames: graph.frames?.filter(frame => frame.nodeIds.every(id => kept.has(id))) };
  };
  // Pasted where asked (the pointer, or where the menu opened); a duplicate takes the nearest free spot, never on top
  // of its original.
  const putIn = (clip: { nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] }, at?: XYPosition) => {
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
    setGraph(current => ({ ...current, nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges],
      ...(clip.frames?.length ? { frames: [...(current.frames ?? []), ...clip.frames.map(frame => ({ ...frame, id: newId("frame"), nodeIds: frame.nodeIds.map(id => ids.get(id)!) }))] } : {}) }));
    setSelection(nodes.map(node => node.id));
  };
  const copy = (ids = selection) => { const clip = takeOut(ids); if (clip.nodes.length) clipboard.current = clip; };
  const paste = (at?: XYPosition) => { if (clipboard.current) putIn(clipboard.current, at ?? (pointer.current ? flow.screenToFlowPosition(pointer.current) : undefined)); };
  const duplicate = (ids = selection) => putIn(takeOut(ids));
  const focusBoard = () => board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus({ preventScroll: true });
  const pointerPosition = () => pointer.current ? (iso ? isoController.current?.position(pointer.current) : flow.screenToFlowPosition(pointer.current)) : viewMiddle();
  const frameView = () => { if (!selection.length) fitAll(); else if (iso) isoController.current?.frame(); else void flow.fitView({ nodes: selection.filter(id => graph.nodes.some(node => node.id === id)).map(id => ({ id })), padding: 0.3, maxZoom: 1.5, duration: 250 }); };
  const zoom = (factor: number) => { if (iso) isoController.current?.zoom(factor); else void flow.zoomTo(factor ? flow.getZoom() * factor : 1, { duration: 150 }); };
  const focusAgent = (id: string) => {
    const element = [...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node-agent, .iso-node[data-kind='agent']") ?? [])].find(node => node.dataset.id === id);
    if (!element) return;
    setSelection([id]); element.focus({ preventScroll: true }); if (iso) isoController.current?.reveal([id]); else reveal([id]);
  };
  const focusPrevious = () => { if (agents.length) { const index = agents.findIndex(node => node.id === selection.at(-1)); focusAgent(agents[((index < 0 ? agents.length : index) - 1 + agents.length) % agents.length].id); } };
  const focusNearest = (direction: string) => {
    const candidates = [...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node-agent, .iso-node[data-kind='agent']") ?? [])];
    const active = candidates.find(node => node.dataset.id === selection.at(-1)), origin = active?.getBoundingClientRect();
    const center = (box: DOMRect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const at = origin ? center(origin) : null;
    const next = !at ? candidates[0] : candidates.filter(node => {
      const point = center(node.getBoundingClientRect());
      return direction === "ArrowRight" ? point.x > at.x + 1 : direction === "ArrowLeft" ? point.x < at.x - 1 : direction === "ArrowDown" ? point.y > at.y + 1 : point.y < at.y - 1;
    }).sort((a, b) => { const p = center(a.getBoundingClientRect()), q = center(b.getBoundingClientRect()); return Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y); })[0];
    if (next?.dataset.id) focusAgent(next.dataset.id);
  };
  const nudge = (direction: string, amount: number) => {
    if (!selection.some(id => graph.nodes.some(node => node.id === id && node.type !== "mother"))) return;
    const dx = direction === "ArrowRight" ? amount : direction === "ArrowLeft" ? -amount : 0, dy = direction === "ArrowDown" ? amount : direction === "ArrowUp" ? -amount : 0;
    const scene = iso ? isoLayout(graph, order) : [];
    checkpoint(); if (iso) isoController.current?.keepView();
    setGraph(current => ({ ...current, nodes: current.nodes.map(node => {
      if (!selection.includes(node.id) || node.type === "mother") return node;
      const at = scene.find(item => item.id === node.id)?.at;
      return { ...node, position: { x: node.position.x + dx, y: node.position.y + dy }, ...(iso && at ? { isoPosition: { x: at.x + dx, y: at.y + dy } } : {}) };
    }) }));
  };
  const tidySelection = () => {
    if (!selection.length) { tidy(); return; }
    checkpoint(); const arranged = arrange(graph);
    const taken = boxes().filter((_, index) => !selection.includes(graph.nodes[index].id));
    const nodes = graph.nodes.map(node => {
      if (!selection.includes(node.id) || node.type !== "agent") return node;
      const desired = arranged.nodes.find(item => item.id === node.id)!, position = place(desired.position, taken); taken.push({ ...position, w: NODE_W, h: NODE_H });
      return { ...desired, position };
    });
    setGraph(current => ({ ...current, nodes }));
  };
  const mute = (ids = selection) => {
    const picked = agents.filter(node => ids.includes(node.id)); if (!picked.length) return;
    const muted = picked.some(node => !node.data.muted); checkpoint();
    setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.type === "agent" && ids.includes(node.id) ? { ...node, data: { ...node.data, muted } } : node) }));
  };
  const frameSelection = (ids = selection) => {
    const nodeIds = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)).map(node => node.id); if (!nodeIds.length) return;
    const id = newId("frame"); checkpoint();
    setGraph(current => ({ ...current, frames: [...(current.frames ?? []).map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !nodeIds.includes(id)) })).filter(frame => frame.nodeIds.length), { id, title: "Frame", nodeIds }] })); setSelection([...nodeIds, id]);
    // The title extends above its members; keep the new frame's drag handle inside the board.
    reveal([id]);
  };
  const ungroup = () => {
    const frames = graph.frames?.filter(frame => !selection.includes(frame.id) && !frame.nodeIds.some(id => selection.includes(id)));
    if (frames?.length === graph.frames?.length) return;
    checkpoint(); setGraph(current => ({ ...current, frames })); setSelection(current => current.filter(id => graph.nodes.some(node => node.id === id)));
  };
  const previewRun = () => {
    if (starting || planning || run && !over(run)) { setNotice("Wait for this run to finish before starting another."); return; }
    const targets = chosen.filter(node => !node.data.muted).map(node => node.id);
    if (!targets.length) { setNotice("Select an enabled agent to run with its required ancestors."); return; }
    setRunTargets(targets); setMenu(null); setAdding(null); setNotice("");
  };
  const keyboardMenu = () => {
    const id = selection.find(id => graph.nodes.some(node => node.id === id));
    const target = [...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node, .iso-node") ?? [])].find(node => node.dataset.id === id)?.getBoundingClientRect();
    const bounds = board.current!.getBoundingClientRect(), point = target ? { clientX: target.x + target.width / 2, clientY: target.y + target.height / 2 } : { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
    const at = menuAt(point, 8); if (!at) return;
    setMenu(id === MOTHER ? { ...at, kind: "mother" } : id ? { ...at, kind: "nodes", ids: selection } : { ...at, kind: "board" });
  };
  // Hit testing follows the paths actually rendered by either view, in screen pixels.
  const wirePaths = () => [...(board.current?.querySelectorAll<SVGPathElement>(".react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path, .iso-link:not([data-mother='true']):not([data-father='true']) .iso-wire") ?? [])];
  const pathPoints = (path: SVGPathElement) => {
    const matrix = path.getScreenCTM(); if (!matrix) return [];
    const length = path.getTotalLength(), count = Math.max(1, Math.ceil(length / 8));
    return Array.from({ length: count + 1 }, (_, index) => { const at = path.getPointAtLength(length * index / count), point = new DOMPoint(at.x, at.y).matrixTransform(matrix); return { x: point.x, y: point.y }; });
  };
  const pathId = (path: SVGPathElement) => path.closest<SVGGElement>(".react-flow__edge, .iso-link")?.dataset.id;
  const cutCrossed = (from: XYPosition, to: XYPosition) => {
    for (const path of wirePaths()) {
      const points = pathPoints(path), id = pathId(path);
      if (id && points.some((point, index) => index > 0 && segmentsCross(from, to, points[index - 1], point))) cutter.current?.ids.add(id);
    }
  };
  const insertionAt = (id: string, current = graph) => {
    if (nodeDrag.current && nodeDrag.current.ids.filter(id => current.nodes.some(node => node.id === id && node.type === "agent")).length !== 1) return null;
    const element = [...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node-agent, .iso-node[data-kind='agent']") ?? [])].find(node => node.dataset.id === id);
    const box = element?.getBoundingClientRect(); if (!box) return null;
    for (const path of wirePaths()) {
      const edge = current.edges.find(edge => edge.id === pathId(path));
      if (!edge || !insertAgent(current, id, edge)) continue;
      if (pathPoints(path).some(at => at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom)) return edge;
    }
    return null;
  };
  const beginDrag = (id: string, extract: boolean) => {
    const frame = graph.frames?.find(frame => frame.id === id), ids = frame ? [...frame.nodeIds, id] : selection.includes(id) ? selection : [id];
    checkpoint(); dragged.current = true; nodeDrag.current = { before: graph, id, ids, extract: extract && agents.some(node => node.id === id), cancelled: false }; setSelection(ids);
  };
  const finishDrag = (shift: boolean, moved: Node[] = []) => {
    const start = nodeDrag.current; if (!start) return;
    let next = start.cancelled ? start.before : { ...latest.current, nodes: latest.current.nodes.map(node => {
      const position = moved.find(item => item.id === node.id)?.position; return position ? { ...node, position } : node;
    }) };
    if (!start.cancelled && start.extract) {
      const extracted = start.ids.filter(id => agents.some(node => node.id === id)).length === 1 ? extractAgent(next, start.id) : null;
      if (extracted) next = extracted; else setNotice("Extract needs one ordinary input and output at most. The wiring was kept.");
    } else if (!start.cancelled && shift) { const edge = insertionAt(start.id, next); if (edge) next = insertAgent(next, start.id, edge) ?? next; }
    nodeDrag.current = null; setInsertWire(null); restored.current = shapeKey(next) !== shapeKey(start.before);
    const steps = history.current;
    if (!start.cancelled && JSON.stringify(next) !== JSON.stringify(start.before)) { steps.past = [...steps.past, start.before].slice(-100); steps.future = []; }
    steps.settled = next; steps.restoring = true; setGraph(next);
    setTimeout(() => { dragged.current = false; });
  };
  const moveIso = (id: string, dx: number, dy: number) => {
    const start = nodeDrag.current; if (!start || start.cancelled) return;
    const ids = start.before.frames?.find(frame => frame.id === id)?.nodeIds ?? start.ids;
    const scene = isoLayout(start.before, waves(start.before)); isoController.current?.keepView();
    setGraph({ ...start.before, nodes: start.before.nodes.map(node => {
      const at = scene.find(item => item.id === node.id)?.at ?? node.isoPosition ?? node.position;
      return { ...node, isoPosition: ids.includes(node.id) ? { x: at.x + dx, y: at.y + dy } : at,
        position: ids.includes(node.id) ? { x: node.position.x + dx, y: node.position.y + dy } : node.position };
    }) });
  };
  // Contract every link kind across removed agents; Mother links remain derived from the surviving roots.
  const removeKeepingFlow = (ids: string[]) => {
    const gone = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id));
    if (!gone.length) return;
    checkpoint();
    const next = deleteKeepingFlow(graph, ids);
    setNotice(""); setDeleted(`${gone.map(node => node.type === "agent" ? node.data.title : "note").join(", ")} · kept ${next.keptLinks} ${next.keptLinks === 1 ? "link" : "links"}`);
    setGraph({ ...next.graph, frames: next.graph.frames?.map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !ids.includes(id)) })).filter(frame => frame.nodeIds.length) });
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
        { label: "Add agents", keys: "Shift+A / Tab", take: () => openAdder(current.client) },
        { label: "Add a note", keys: "Shift+S", take: () => { checkpoint(); addNote(iso ? isoController.current?.position(current.client) : flow.screenToFlowPosition(current.client)); } },
        ...(clip ? [{ label: `Paste ${describe(inClip, clip.nodes.length - inClip)}`, keys: "Ctrl+V", take: () => paste(flow.screenToFlowPosition(current.client)) }] : []),
        { label: "Arrange by run order", keys: "Shift+Alt+T", take: tidySelection },
        { label: "Fit the view", keys: "Home", take: fitAll }] };
    }
    const ids = current.ids, picked = graph.nodes.filter(node => ids.includes(node.id)), count = picked.filter(node => node.type === "agent").length;
    const removeThem = () => remove(ids);
    const editingItems: MenuItem[] = [
      ...(count ? [{ label: picked.some(node => node.type === "agent" && !node.data.muted) ? "Mute" : "Unmute", keys: "M", hint: "Muted agents are skipped in runs; the drawing stays", take: () => mute(ids) },
        { label: "Run selected", keys: "Ctrl+Shift+Enter", take: previewRun }] : []),
      { label: "Frame selection", keys: "Ctrl+G", take: () => frameSelection(ids) },
      ...(graph.frames?.some(frame => frame.nodeIds.some(id => ids.includes(id))) ? [{ label: "Ungroup", keys: "Ctrl+Shift+G", take: ungroup }] : []),
      { label: "Cut", keys: "Ctrl+X", take: () => { copy(ids); remove(ids); } },
    ];
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
      ...editingItems,
      ...(count ? [{ label: "Delete, keep the flow", keys: "Ctrl+Del", take: () => removeKeepingFlow(ids) }] : []),
      { label: `Delete ${what}`, keys: "Delete", take: removeThem }] };
  };
  const titleOf = (id: string) => agents.find(node => node.id === id)?.data.title || "Untitled";
  const inputsNeeded = (id: string) => graph.edges.filter(edge => waits(edge) && edge.target === id && agents.some(node => node.id === edge.source))
    .filter(edge => states[edge.source]?.status !== "succeeded" || states[checkOf(edge.source)]?.status !== "succeeded" || clashes[edge.source])
    .map(edge => `${titleOf(edge.source)} (${clashes[edge.source] ? "merge clash" : states[edge.source]?.status === "succeeded" ? CHECK_LABEL[states[checkOf(edge.source)]?.status ?? "idle"] : STATUS_LABEL[states[edge.source]?.status ?? "idle"]})`);
  const choiceKey = (data: AgentData) => data.model ? `${subscriptionOf(data.model) ? "" : canonicalProvider(data.provider) ?? ""}|${data.model}` : "";
  const shared = (key: (data: AgentData) => string) => new Set(chosen.map(node => key(node.data))).size === 1 ? key(chosen[0].data) : "mixed";
  const modelPatch = (value: string): Partial<AgentData> => { const [provider, ...rest] = value.split("|"); return value ? { provider: provider || null, model: rest.join("|"), effort: null } : { provider: null, model: null, effort: null }; };
  // The subscriptions' models (Claude, Antigravity's Gemini) come from the engine's own list (28 Oct: Mother's menu had no Opus).
  const subscribed = models.filter(item => subscriptionOf(item.model) && !catalog.some(entry => entry.model === item.model));
  const modelOptions = (provider?: string | null) => [<option key="" value="">Default model</option>, ...catalog.filter(item => provider === undefined || item.provider === provider).map(item => <option key={`${item.provider}|${item.model}`} value={`${item.provider ?? ""}|${item.model}`} data-hint={provider === undefined ? item.providerLabel : undefined}>{item.label}</option>), ...(provider === undefined ? subscribed.map(item => <option key={`|${item.model}`} value={`|${item.model}`} data-hint={subscriptionOf(item.model)?.label}>{item.displayName || item.model}</option>) : [])];
  const subscriptionOptions = (prefix: string) => subscriptions.find(choice => choice.id === prefix)?.models.map(item => <option key={item.model} value={`|${item.model}`}>{item.displayName || item.model}</option>) ?? [];
  const mixed = <option value="mixed" disabled>Mixed</option>;
  const selectedModel = selected ? catalog.find(item => item.model === selected.data.model && item.provider === canonicalProvider(selected.data.provider)) : undefined;

  // "Let Elpis handle it": a fast model designs the team from a goal, or does what was typed (POST /api/canvas/plan,
  // bridge/canvas-plan.mjs). The board it returns replaces this one in one step, so Ctrl+Z undoes it.
  const [planning, setPlanning] = useState("");
  // `forRun`: Run graph's own fill of what agents lack, made while that run is starting.
  /** A ready-made workflow (Transcribe images, Translate to Farsi) works on a folder named in the request (one of the
   * project's), or else the one chosen. A chosen folder becomes the project, so everything the team writes stays inside it. */
  const readyMade = (id?: string) => WORKFLOWS.find(workflow => workflow.id === id);
  const chosenWorkflow = readyMade(graph.planningPattern);
  async function buildReadyMade(workflow: ReadyMade, goal: string): Promise<CanvasGraph | null> {
    const named = [...(project.folders ?? [])].sort((a, b) => b.length - a.length).find(name => goal.includes(name));
    return named && cwd ? readyMadeAt(workflow, cwd, named, goal) : chooseFolderFor(workflow, goal);
  }
  // `goal`: what was typed with New workflow. Chosen from the menu, its button or the library, the goal is the job itself:
  // old request text never rides along (28 Oct: a leftover "Create elpis-check.txt" became every reader's goal).
  async function chooseFolderFor(workflow: ReadyMade, goal?: string, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return null; }
    const choose = window.elpisDesktop?.chooseFolder;
    if (!choose) { setNotice(`Choose the folder of ${workflow.what} in the desktop app.`); return null; }
    let picked: string | null = null;
    try { picked = (await choose())?.replace(/\/+$/, "") || null; } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return null; }
    if (!picked) return null;
    if (picked !== cwd?.replace(/\/+$/, "")) await onUseFolder?.(picked);
    return readyMadeAt(workflow, picked, ".", goal || workflow.goal(picked.split("/").at(-1) ?? picked, language), language);
  }
  /** Picked from the menu or the library: the open project, when it plainly holds the job's files, or else the folder chosen. */
  async function pickReadyMade(workflow: ReadyMade, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return null; }
    const base = cwd?.replace(/\/+$/, "");
    const files = base ? await listFolder(base, ".").catch(() => [] as string[]) : [];
    return base && workflow.here(files) ? readyMadeAt(workflow, base, ".", workflow.goal(base.split("/").at(-1) ?? base, language), language) : chooseFolderFor(workflow, undefined, language);
  }
  const listFolder = async (base: string, folder: string) => (await api<{ data: { name: string; dir: boolean }[] }>(`/files/dir?cwd=${encodeURIComponent(base)}&dir=${encodeURIComponent(folder)}&hidden=0`)).data.filter(entry => !entry.dir).map(entry => entry.name);
  async function readyMadeAt(workflow: ReadyMade, base: string, folder: string, goal: string, language = languageOf(graph.language)): Promise<CanvasGraph | null> {
    const at = (name: string) => folder === "." ? name : `${folder}/${name}`;
    let sources: { name: string; text: string }[] = [];
    try {
      const files = await listFolder(base, folder);
      sources = await Promise.all(workflow.sources(files).map(async name => {
        if (!workflow.reads) return { name, text: "" };
        const file = await api<{ content?: string; tooLarge?: boolean }>(`/file?cwd=${encodeURIComponent(base)}&path=${encodeURIComponent(at(name))}`);
        if (typeof file.content !== "string") throw new Error(file.tooLarge ? `${name} is too large to read here.` : `${name} is not text.`);
        return { name, text: file.content };
      }));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); return null; }
    const where = folder === "." ? base.split("/").at(-1) : folder;
    if (!sources.some(source => !workflow.reads || source.text.trim())) { setNotice(`No ${workflow.what} in ${where}.`); return null; }
    // The subscriptions (Antigravity's Gemini, Claude) are in the engine's own list; a run routes them by their prefix.
    const listed = models.length ? models : (await api<{ data: Model[] }>("/models").catch(() => ({ data: [] as Model[] }))).data;
    const offered = [...listed.map(item => ({ model: item.model, provider: null as string | null })), ...catalog];
    const pick = (test: RegExp) => offered.find(item => test.test(item.model));
    const byLanguage = typeof workflow.worker === "function", worker = (byLanguage ? (workflow.worker as (language: Language) => RegExp[])(language) : workflow.worker as RegExp[]).map(pick).find(Boolean), boss = MOTHER_FIRST.map(pick).find(Boolean);
    const team = workflow.team(folder, sources, worker ? { model: worker.model, provider: worker.provider } : {}, language);
    const agents = team.nodes.filter(node => node.type === "agent").length;
    checkpoint(); setSelection([]); setRun(null); setStates({});
    setGraph(current => ({ ...team, request: goal, maxAgents: Math.max(current.maxAgents ?? 10, agents), mother: { brief: goal, model: boss?.model ?? null, provider: boss?.provider ?? null } }));
    // A model chosen by the language is named, so the person sees what writes it (28 Oct: "the agent ... says which").
    const named = worker && (catalog.find(item => item.model === worker.model && item.provider === worker.provider)?.label ?? listed.find(item => item.model === worker.model)?.displayName ?? worker.model);
    setNotice(!worker ? `${workflow.workerName} is not available here, so the ${workflow.workers} use the default model.`
      : byLanguage ? `The ${workflow.workers} use ${named}${worker.provider === "openrouter" ? " on OpenRouter" : ""}, the best writer of ${language.name} among your models.` : "");
    setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
    return team;
  }
  /** The document a ready-made workflow writes, opened in the system's own app for it. */
  const openResult = () => { if (cwd && graph.result) window.elpisDesktop?.openFile?.(`${cwd.replace(/\/+$/, "")}/${graph.result}`).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause))); };
  async function letElpis(goal: string, scope?: CanvasGraph, newWorkflow = false, forRun = false): Promise<CanvasGraph | null> {
    const current = runtimeAttempt();
    if (!current()) return null;
    if (recordedRun) return null;
    if (planning || startingRun.current && !forRun) { setNotice("Wait for the current design to finish."); return null; }
    if (!cwd) { setNotice("Choose the project the agents work in, then try again."); return null; }
    const readyWorkflow = newWorkflow && readyMade(graph.planningPattern);
    if (readyWorkflow) return buildReadyMade(readyWorkflow, goal);
    const chosenPattern = newWorkflow ? TEMPLATES.find(item => item.id === graph.planningPattern) : undefined;
    const starter = chosenPattern?.build();
    const base = newWorkflow ? withMother({ ...starter, name: "Workflow", request: goal,
      nodes: starter?.nodes.map(node => node.type === "agent" ? { ...node, data: { ...node.data, instruction: "", writeScopes: [], acceptanceCriteria: [] } } : node) ?? [],
      edges: starter?.edges ?? [], template: chosenPattern?.id, planningPattern: graph.planningPattern ?? "auto", maxAgents: graph.maxAgents, mother: { ...mother, brief: goal } }) : graph;
    const planningGoal = chosenPattern ? `${goal}\n\nUse the selected ${chosenPattern.name} pattern exactly: keep these agents and their dependencies, without adding or removing agents. Tailor their prompts, folders and completion checks to this goal.` : goal;
    setPlanning(goal); setNotice(""); setMenu(null);
    try {
      const plan = await api<Plan>("/canvas/plan", { goal: planningGoal, cwd, folders: project.folders ?? [], agents: boardForPlan(scope ?? base), maxAgents: limit });
      if (!current()) return null;
      if (editKey(latest.current) !== editKey(graph)) throw Error("The current workflow changed while Elpis was designing. Your changes are kept; try again.");
      if (chosenPattern) {
        const selected = boardForPlan(base);
        if (plan.agents.length !== selected.length || selected.some(agent => {
          const planned = plan.agents.find(item => item.key === agent.key);
          return !planned || JSON.stringify([...planned.waitsFor].sort()) !== JSON.stringify([...agent.waitsFor].sort());
        })) throw Error("Elpis changed the selected pattern. Your current workflow is kept; try again.");
      }
      // A scoped run may fill its missing instructions, but cannot redesign the board behind its scope preview.
      const next = scope ? { ...graph, nodes: graph.nodes.map(node => {
        const item = scope.nodes.some(item => item.id === node.id) && plan.agents.find(item => item.key === node.id);
        return node.type === "agent" && item ? { ...node, data: { ...node.data, instruction: node.data.instruction.trim() ? node.data.instruction : item.prompt, writeScopes: node.data.writeScopes.length ? node.data.writeScopes : item.folders, acceptanceCriteria: node.data.acceptanceCriteria.length ? node.data.acceptanceCriteria : item.doneWhen } } : node;
      }) } : applyPlan(base, plan);
      if (newWorkflow) { checkpoint(); void workflowCatalog.refresh(); setRun(null); setStates({}); setDashboardId(null); setUndoLoad(null); }
      setGraph(next); setSelection([]);
      setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
      return next;
    } catch (error) { if (current()) setNotice(`Elpis could not fill in the team: ${error instanceof Error ? error.message : String(error)}`); return null; }
    finally { setPlanning(""); }
  }

  // The Father's part: his own chat, on her model, told who he is; it starts once hers has succeeded.
  /** The Father's part as the bridge starts it after hers: his chat (her model, the goal and his role as instructions)
   * and his tasks, in worktrees when he has several writers in a git repository. */
  async function fatherPart(tasks: RunTask[], current: () => boolean) {
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const goal = mother.brief.trim(), name = `Father · ${graph.name || "Workflows"}`.slice(0, 120);
    const repository = Boolean(cwd) && wantsIsolation(tasks) && await api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(cwd!)}`).then(result => result.repository === true, () => false);
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const { rootThreadId: _root, name: _name, ...stage } = runPayload("", name, tasks, Math.max(1, Math.min(maxAtOnce, allowed.atOnce)), repository);
    return { ...stage, name, thread: { name, instructions: [goal && `Goal of the whole run: ${goal}`, "You are the Father: you run the agents past the Mother's ten, after her part has succeeded, and you report to her."].filter(Boolean).join("\n\n"),
      ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}) } };
  }

  // Sends one part of the run. With several writing agents in a git repository, each works in its own worktree and
  // Elpis merges them into the project's branch after the run; without a repository Elpis refuses that, so it isn't asked.
  async function runPart(rootThreadId: string, name: string, tasks: RunTask[], current: () => boolean, next?: Awaited<ReturnType<typeof fatherPart>>) {
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    const repository = Boolean(cwd) && wantsIsolation(tasks) && await api<{ repository?: boolean }>(`/repository?cwd=${encodeURIComponent(cwd!)}`).then(result => result.repository === true, () => false);
    if (!current()) throw Error(OFFLINE_WORKFLOW);
    return api<{ graphId: string }>("/workflows/run", { ...(graph.template === "recursive" ? { roundLimit: graph.roundLimit } : {}), ...runPayload(rootThreadId, name, tasks, Math.max(1, Math.min(maxAtOnce, allowed.atOnce)), repository), ...(next ? { next } : {}) });
  }

  async function start(targets?: string[]) {
    if (recordedRun) return;
    const current = runtimeAttempt();
    if (!current()) return;
    if (startingRun.current || planning || run && !over(run)) { setNotice("Wait for this run to finish before starting another."); return; }
    if (!cwd) { setNotice("Choose the project the agents work in, then run again."); return; }
    startingRun.current = true; setStarting(true);
    try {
      // Fill only when work in this execution scope needs it; muted and unrelated agents never start it.
      const scope = executionGraph(graph, targets);
      const empty = scope.nodes.some(node => node.type === "agent" && (!node.data.instruction.trim() || !node.data.writeScopes.length && Boolean(project.folders?.length)));
      const planned = empty ? await letElpis(mother.brief.trim() || DRAWN, targets || agents.some(node => node.data.muted) ? scope : undefined, false, true) : graph;
      if (!planned || !current()) return;
      const ready = executionGraph(planned, targets), built = runParts(ready);
      if ("error" in built) { setNotice(built.error); return; }
      setNotice(""); setUndoLoad(null); setStates({}); setClashes({}); setLog([]); said.current = {}; reports.current.clear(); followLog.current = true;
      const runIdentity = workflowCatalog.ensure(identity?.rootThreadId ? crypto.randomUUID() : graph.workflowId || crypto.randomUUID(), ready.name);
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), agents: true, name: runIdentity.name,
        ...(mother.model ? { model: mother.model, ...(mother.provider ? { provider: mother.provider } : {}) } : {}), ...(mother.brief.trim() ? { instructions: mother.brief.trim() } : {}) });
      const result = await runPart(created.thread.id, runIdentity.name, built.mother, current, built.father.length ? await fatherPart(built.father, current) : undefined);
      workflowCatalog.attach(runIdentity.id, result.graphId, created.thread.id);
      setIdentity({ workflowId: result.graphId, name: runIdentity.name });
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running", startedAt: Date.now(), ...(built.father.length ? { father: { tasks: built.father, status: "pending" } } : {}) });
    } catch (error) { if (current()) setNotice(runFailure(error instanceof Error ? error.message : String(error))); }
    finally { startingRun.current = false; setStarting(false); }
  }

  const chat = selected ? states[selected.id]?.chat : null;
  // Both views share the graph, selection, settings and connection callbacks.
  const [iso, setIso] = useState(false);
  const found = finding === null ? [] : agents.filter(node => `${node.data.title} ${node.data.instruction}`.toLowerCase().includes(finding.toLowerCase()));
  const findAgent = (id: string) => { setSelection([id]); setFinding(null); focusBoard(); if (iso) isoController.current?.reveal([id]); else reveal([id]); };
  const scope = runTargets ? executionGraph(graph, runTargets).nodes.filter(node => node.type === "agent") : [];
  const historicalNotice = Boolean(recordedRun && savedRecord && notice && (notice === savedRecord.error || savedRecord.tasks?.some(task => task.failureReason === notice)));
  const runClock = run && <section className="canvas-hud" aria-label="Run clock"><span>{over(run) ? (["succeeded", "completed"].includes(run.father?.status ?? run.status) ? "Run done" : "Run ended") : "Running"}</span><>{over(run) && !run.endedAt ? <span>Duration not recorded</span> : <RunClock key={run.graphId} since={run.startedAt} until={run.endedAt} />}</></section>;
  const telemetry = <div className="canvas-telemetry">{runClock}</div>;
  const capturedLog = run && <ol ref={logList} className="canvas-log" role="log" aria-label="Run log" aria-live="polite" aria-relevant="additions" onScroll={event => { const el = event.currentTarget; followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12; }}>
    {log.map((line, index) => <li key={`${line.at}-${index}`} data-tone={line.tone}><Button variant="ghost" size="xs" className="w-full justify-start" title={line.at === undefined ? line.text : `Observed +${clock(line.at - run.startedAt)} · ${line.text}`} onClick={() => { if (line.agent) { setSelection([line.agent]); setDashboardId(line.agent); } else setSelection([MOTHER]); }}>{line.at !== undefined && <time>+{clock(line.at - run.startedAt)}</time>}<span title={line.text}>{line.text}</span></Button></li>)}
  </ol>;
  const sideEdge = <ResizeEdge className="side-resize" label="Resize workflow panel" width={sideWidth} min={CANVAS_SIDE.min} max={CANVAS_SIDE.max} initial={CANVAS_SIDE.initial} grows="left" onResize={resizeSide} onClose={() => showPanel(false)} />;
  return <section className="agents-canvas" aria-label="Workflows" style={sideWidth ? { "--canvas-side-width": `${sideWidth}px` } as CSSProperties : undefined} data-recorded={recordedRun ? true : undefined} data-panel={panelOpen ? "open" : "closed"}>
    <header className="canvas-header">
      {recordedRun ? <div className="flex w-full flex-wrap items-center justify-between gap-2"><span className="text-sm text-muted-foreground">Saved workflow{!run && " · Loading…"}</span><Button size="sm" onClick={onLeaveRecordedRun} disabled={!onLeaveRecordedRun}>New workflow</Button></div> : <form className="flex w-full min-w-0 flex-wrap items-end gap-2" aria-label="New workflow" onSubmit={event => { event.preventDefault(); void letElpis(requestText, undefined, true); }}>
        <label className="field canvas-request">What should the workflow do?<Input aria-label="Workflow request" value={requestText} maxLength={8000} placeholder="Describe what you want to achieve" onChange={event => setGraph(current => ({ ...current, request: event.target.value }))} /></label>
        <OptionSelect aria-label="Workflow pattern" value={graph.planningPattern ?? "auto"} disabled={Boolean(planning || starting)} onChange={event => {
          const value = event.target.value;
          // The catalogue stays open to read during a run; loading a pattern waits for the run.
          if (value === "more") { setSelection([]); setMorePatterns(true); showPanel(true); return; }
          if (value === "auto") { setGraph(current => ({ ...current, planningPattern: "auto" })); return; }
          const workflow = readyMade(value);
          if (workflow) { setGraph(current => ({ ...current, planningPattern: workflow.id })); void pickReadyMade(workflow); return; }
          if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return; }
          const template = TEMPLATES.find(item => item.id === value); if (template) loadTemplate(template);
        }}>{ENTRY_PATTERNS.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
          {graph.planningPattern && graph.planningPattern !== "auto" && !ENTRY_PATTERNS.some(pattern => pattern.id === graph.planningPattern) && <option value={graph.planningPattern}>{TEMPLATES.find(pattern => pattern.id === graph.planningPattern)?.name ?? "Custom pattern"}</option>}
          <option value="more">More patterns…</option></OptionSelect>
        {chosenWorkflow && <Button type="button" variant="outline" size="sm" disabled={!ready || Boolean(planning || starting)} title={cwd ? `The folder of ${chosenWorkflow.what}: ${cwd}` : undefined} onClick={() => void chooseFolderFor(chosenWorkflow)}><FolderOpen size={14} />Choose folder</Button>}
        {chosenWorkflow?.id === "translate" && <OptionSelect aria-label="Language" value={languageOf(graph.language).id} disabled={Boolean(planning || starting)} onChange={event => {
          // The language stays with the board; a translation team already built is rebuilt for the new one.
          const language = languageOf(event.target.value); setGraph(current => ({ ...current, language: language.id }));
          if (graph.planningPattern === "translate" && graph.result) void pickReadyMade(chosenWorkflow, language);
        }}>{LANGUAGES.map(language => <option key={language.id} value={language.id}>{language.name}</option>)}</OptionSelect>}
        <Button type="submit" size="sm" aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready || !cwd || !requestText.trim() && !chosenWorkflow || Boolean(planning || starting)}>{planning ? "Designing…" : "New workflow"}</Button>
        <Button type="button" variant="outline" size="sm" aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready || !cwd || !requestText.trim() || Boolean(planning || starting || run && !over(run))} onClick={() => void letElpis(requestText)}>Update current</Button>
        {/* The run's status sits beside the request, which gives up the room, so the controls below stay on one row
            while it runs (28 Oct: a running board wrapped them onto a second row). */}
        {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={over(run) ? run.father?.status ?? run.status : "running"} />{over(run) ? ENDED[run.status === "succeeded" ? run.father?.status ?? run.status : run.status] ?? "Finished" : run.father?.threadId ? "Running · the Father's part" : "Running"} · {done} of {agents.length} done</span>}
        {run && runClock}
        {/* Stop cancels the whole run: the engine treats an interrupt of the run's own chat as cancelling it (28 Oct:
            "a running workflow has no cancel control anywhere"). */}
        {run && !over(run) && <Button type="button" variant="outline" size="sm" aria-label="Stop run" title="Stop this run: every agent stops, finished work is kept" onClick={() => void api(`/threads/${encodeURIComponent(run.rootThreadId)}/interrupt`, {}).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))}><Square size={14} />Stop</Button>}
        {run && over(run) && graph.result && <Button type="button" variant="outline" size="sm" onClick={openResult}><FileText size={14} />Open {graph.result.split("/").at(-1)}</Button>}
        {!ready && <p id={offlineReasonId} role="status" className="w-full text-xs text-muted-foreground">{OFFLINE_WORKFLOW}</p>}
      </form>}
      {recordedRun && savedRecord && <div className="w-full"><WorkflowProgress compact run={savedRecord} team={liveTeam} onOpenChat={onOpenChat} /></div>}
      <WorkflowHistory catalog={workflowCatalog} revision={`${run?.graphId ?? ""}:${run?.status ?? ""}`} onOpenChat={onOpenChat} onOpenCanvas={onOpenRecordedRun} />
      <div className="canvas-name-group relative flex min-w-0 max-w-full items-center gap-2">
        {identity && presetName && !renamingPreset && !recordedRun && <WorkflowColourMenu identity={identity} catalog={workflowCatalog} onError={setNotice} />}
        {presetName && !renamingPreset && !recordedRun ? <Button variant="ghost" size="icon-sm" aria-label="Rename workflow" title="Rename workflow" onClick={() => setRenamingPreset(true)}><Pencil size={14} /></Button>
          : identity ? <WorkflowIdentityEditor key={identity.id} identity={identity} catalog={workflowCatalog} name={graph.name} onName={name => setGraph(current => ({ ...current, name }))} /> : <Input aria-label="Graph name" className="canvas-name" value={graph.name} readOnly />}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Duplicate workflow" title="Duplicate workflow" onClick={() => { setGraph(current => ({ ...current, workflowId: undefined, name: identity?.name ?? current.name })); setRun(null); setStates({}); setSelection([]); }}><Copy size={14} /></Button>
      {projectMenu}
      <span className="canvas-spacer" />
      <ViewToggle iso={iso} onChange={setIso} />
      {run && <Button variant="ghost" size="icon-sm" aria-label="Open run chat" title="Open run chat" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} /></Button>}
      <Button variant="ghost" size="sm" aria-pressed={motherOpen} onClick={() => setSelection([MOTHER])} title="The run's settings: the brief every agent gets, her model, how many agents"><i className="canvas-kind" data-kind="mother" />Mother</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Auto-arrange" aria-pressed={autoLayout} onClick={toggleAuto} title={autoLayout ? "Auto-arrange is on: the board keeps run-order columns (Kahn's waves) after every change. Click to place agents freely." : "Auto-arrange is off. Click to arrange by run order and keep it so."}><ListOrdered size={14} /></Button>
      <Button variant="ghost" size="sm" aria-label="Side panel" aria-pressed={panelOpen} title={panelOpen ? "Hide the side panel: the board takes the whole width" : "Show the side panel: patterns and the selected agent"} onClick={() => showPanel(!panelOpen)}><AgentsIcon size={16} /></Button>
      {!recordedRun && <div className="canvas-run-control">
        <Button variant="outline" size="sm" onClick={() => void start()} aria-describedby={!ready ? offlineReasonId : notice || starting || run && !over(run) ? runReasonId : undefined} disabled={!ready || starting || Boolean(planning || run && !over(run))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
        {!notice && (starting || run && !over(run)) && <span id={runReasonId} className="sr-only" role="status">{starting ? "Starting the team. Wait for the run to start." : "Wait for this run to finish before starting another."}</span>}
      </div>}
    </header>
    <div className="canvas-board" ref={board}
      data-tool={lasso ? "lasso" : undefined}
      onContextMenuCapture={event => { if (suppressContext.current || event.ctrlKey) { event.preventDefault(); event.stopPropagation(); } }}
      onPointerDownCapture={event => {
        const target = event.target;
        if (!event.isPrimary || !(target instanceof Element) || target.closest("input, textarea, button, [role='dialog'], [role='menu'], .react-flow__controls, .react-flow__minimap, .iso-hud, .canvas-telemetry, .canvas-log-panel, .canvas-toolbar")) return;
        if (event.button === 2 && (event.ctrlKey || event.metaKey)) {
          suppressContext.current = true; cutter.current = { points: [{ x: event.clientX, y: event.clientY }], ids: new Set() }; setStroke(cutter.current.points); setMenu(null);
          event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation(); return;
        }
        if (event.button !== 0) return;
        const empty = target.matches(".react-flow__pane") || target.closest(".iso-board") && !target.closest(".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .canvas-frame-title, .canvas-note");
        if (!empty) return;
        boxDrag.current = { x: event.clientX, y: event.clientY, previous: [...selection], base: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ? [...selection] : [], subtract: event.altKey, moved: false, lasso, points: [{ x: event.clientX, y: event.clientY }] };
        event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      onPointerMove={event => {
        pointer.current = { x: event.clientX, y: event.clientY };
        const cut = cutter.current;
        if (cut?.cancelled) return;
        if (cut) {
          const point = { x: event.clientX, y: event.clientY }; cutCrossed(cut.points.at(-1)!, point); cut.points = [...cut.points, point]; setStroke(cut.points); return;
        }
        const start = boxDrag.current;
        if (!start || (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)) return;
        start.moved = true;
        const bounds = event.currentTarget.getBoundingClientRect(), left = Math.min(start.x, event.clientX), top = Math.min(start.y, event.clientY), right = Math.max(start.x, event.clientX), bottom = Math.max(start.y, event.clientY), crossing = event.clientX < start.x;
        if (start.lasso) { start.points = [...start.points, { x: event.clientX, y: event.clientY }]; setStroke(start.points); }
        else setSelectionBox({ x: left - bounds.left, y: top - bounds.top, width: right - left, height: bottom - top, crossing });
        const picked = [...event.currentTarget.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node:not(.react-flow__node-father):not(.react-flow__node-frame), .iso-node:not([data-kind='father']), .iso-note")].filter(node => {
          const box = node.getBoundingClientRect();
          return start.lasso ? insidePolygon({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, start.points)
            : crossing ? box.left <= right && box.right >= left && box.top <= bottom && box.bottom >= top : box.left >= left && box.right <= right && box.top >= top && box.bottom <= bottom;
        }).map(node => node.dataset.id!);
        setSelection(start.subtract ? start.base.filter(id => !picked.includes(id)) : [...new Set([...start.base, ...picked])]);
      }}
      onPointerUp={event => {
        const cut = cutter.current;
        if (cut) {
          cutter.current = null; setStroke(null); if (!cut.cancelled && cut.ids.size) { checkpoint(); setGraph(current => ({ ...current, edges: current.edges.filter(edge => !cut.ids.has(edge.id)) })); }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setTimeout(() => { suppressContext.current = false; }, 300); return;
        }
        const start = boxDrag.current; if (!start) return;
        boxDrag.current = null; setSelectionBox(null); setStroke(null); setLasso(false);
        if (!start.moved) { setSelection(start.base); setMenu(null); }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { if (boxDrag.current) setSelection(boxDrag.current.previous); boxDrag.current = null; cutter.current = null; setSelectionBox(null); setStroke(null); setLasso(false); suppressContext.current = false; }}
      onLostPointerCapture={() => { boxDrag.current = null; cutter.current = null; setSelectionBox(null); setStroke(null); }}
      // A double-click on empty board, whichever layer React Flow put under the pointer, creates an agent there.
      onDoubleClick={event => { const target = event.target as Element; if ((target === event.currentTarget || target.closest(".react-flow")) && !target.closest(".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap")) addAgent({ x: event.clientX, y: event.clientY }); }}>
      {iso ? <IsoBoard workflowIdentity={identity} graph={graph} father={split.father} states={states} selected={selection} onSelect={setSelection} onOpen={setDashboardId} onRename={renameAgent} onWireClick={(event, edge) => { if (edge.source !== MOTHER && edge.source !== FATHER) setSelection([edge.id]); editFlow(event, edge); }} dark={dark} controller={isoController} modelLabel={modelLabel}
        canConnect={validConnection} inserting={insertWire}
        onReconnect={(edge, source, target) => { connectionCancelled.current = false; reconnect(edge, source, target); }}
        renamingFrame={renamingFrame} onFrameName={(id, title) => { if (title) { checkpoint(); setGraph(current => ({ ...current, frames: current.frames?.map(frame => frame.id === id ? { ...frame, title } : frame) })); } setRenamingFrame(null); focusBoard(); }} onNoteText={setText}
        onMoveStart={beginDrag} onMove={moveIso} onMoveEnd={(shift, cancel) => { if (cancel && nodeDrag.current) nodeDrag.current.cancelled = true; finishDrag(shift); }} onMovePreview={id => setInsertWire(nodeDrag.current?.extract ? null : insertionAt(id)?.id ?? null)}
        onConnect={connect} onAdd={(at, id, end) => addAgent(at, id ? { id, as: end === "source" ? "target" : "source" } : undefined)}
        onCommand={(at, id, end) => openAdder(at, { id, as: end === "source" ? "target" : "source" })}
        onNodeMenu={(event, id) => { const node = nodes.find(node => node.id === id); if (node) onNodeContextMenu(event, node); }}
        onBoardMenu={onPaneContextMenu} onWireMenu={onEdgeClick} /> : <ReactFlow tabIndex={0} aria-label="Workflow board" nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={({ source, target }) => { if (!connectionCancelled.current) connect(source, target, alongsideDrag.current ? "alongside" : undefined); }} onConnectEnd={onConnectEnd}
        onConnectStart={event => { connectionCancelled.current = false; alongsideDrag.current = "altKey" in event && event.altKey; const spot = "touches" in event ? event.touches[0] : event; connectFrom.current = { x: spot.clientX, y: spot.clientY }; }} connectOnClick={false}
        onNodeDoubleClick={(_, node) => { if (node.type === "agent") setDashboardId(node.id); }}
        onEdgeClick={(event, edge) => { if (edge.source !== MOTHER && edge.source !== FATHER) setSelection([edge.id]); editFlow(event, { id: edge.id, source: edge.source, target: edge.target }); }} onEdgeContextMenu={(event, edge) => { event.preventDefault(); onEdgeClick(event, edge); }} onNodeContextMenu={onNodeContextMenu} onPaneContextMenu={onPaneContextMenu} multiSelectionKeyCode={["Shift", "Control", "Meta"]} nodeDragThreshold={5} nodeClickDistance={5} paneClickDistance={5} selectionKeyCode={null} panOnDrag={[1]} panActivationKeyCode={null} panOnScroll zoomOnScroll={false} zoomActivationKeyCode={["Control", "Meta"]} snapToGrid snapGrid={[20, 20]} connectionRadius={32} onNodeClick={onNodeClick}
        onNodeDragStart={(event, node) => beginDrag(node.id, event.altKey)} onNodeDrag={(_, node) => setInsertWire(nodeDrag.current?.extract ? null : insertionAt(node.id)?.id ?? null)}
        onNodeDragStop={(event, _, moved) => finishDrag(event.shiftKey, moved)}
        onReconnectStart={(_, edge) => { connectionCancelled.current = false; reconnecting.current = edge.id; }}
        onReconnect={(edge, connection) => reconnect(edge as CanvasEdge, connection.source, connection.target)} onReconnectEnd={() => { reconnecting.current = null; }}
        isValidConnection={connection => validConnection(connection.source, connection.target, reconnecting.current, alongsideDrag.current || graph.edges.find(edge => edge.id === reconnecting.current)?.kind === "alongside")} disableKeyboardA11y
        onPaneClick={() => { setSelection([]); setMenu(null); }} elevateEdgesOnSelect deleteKeyCode={null} zoomOnDoubleClick={false} colorMode={dark ? "dark" : "light"} fitView fitViewOptions={FIT} minZoom={FIT.minZoom} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} fitViewOptions={OVERVIEW} />
        {minimap && <MiniMap pannable zoomable className="canvas-minimap" style={{ width: 150, height: 100 }} />}
      </ReactFlow>}
      {stroke && <svg className="canvas-stroke" aria-hidden="true"><polyline data-tool={cutter.current ? "cut" : "lasso"} points={stroke.map(point => { const box = board.current!.getBoundingClientRect(); return `${point.x - box.left},${point.y - box.top}`; }).join(" ")} /></svg>}
      {lasso && <span className="canvas-gesture-hint" role="status">Lasso · drag to select · Shift adds · Alt subtracts · Esc cancels</span>}
      {insertWire && <span className="canvas-gesture-hint" role="status">Shift-drop to insert on the highlighted wire · Esc cancels</span>}
      {selectionBox && <div aria-hidden="true" className={`canvas-selection absolute pointer-events-none z-10 border ${selectionBox.crossing ? "border-dashed border-success bg-success/12" : "border-solid border-primary bg-primary/10"}`} style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.width, height: selectionBox.height }} />}
      {run && (recordedRun ? <details className="canvas-log-panel" aria-label={over(run) ? "Previous attempt" : "Run record"}>
        <DisclosureSummary>{over(run) ? "Previous attempt" : "Run record"} · {run.status} · {savedRecord?.tasks?.filter(task => ["succeeded", "completed"].includes(task.status ?? "")).length ?? 0}/{savedRecord?.tasks?.length ?? 0} tasks complete</DisclosureSummary>
        {telemetry}
        {historicalNotice && <p className="text-destructive">{notice}</p>}
        {capturedLog}
      </details> : <section className="canvas-log-panel" aria-label="Run capture">
        <p className="hud-menu-title">Run log · {log.length} events</p>
        {capturedLog}
      </section>)}
      {/* Under the board, not floating on it, so it never covers the zoom buttons or the minimap. */}
      <div className="canvas-toolbar" role="toolbar" aria-label="Add to Workflows">
        <span className="canvas-toolbar-label">Add</span>
        <Button variant="ghost" size="sm" aria-label="Add agent" title="An agent that writes: give it a prompt and the folders it may write; Elpis checks its work after it" onClick={() => addAgent()}><i className="canvas-kind" data-kind="agent" />Agent <kbd aria-hidden="true">A</kbd></Button>
        <Button variant="ghost" size="sm" onClick={() => addNote()}><StickyNote size={14} />Note <kbd aria-hidden="true">Shift+S</kbd></Button>
        <Button variant="ghost" size="sm" className="canvas-toolbar-more" onClick={() => openAdder()} title="Type a prompt, or how many, the model and thinking, then the prompts; Tab opens it too">Command <kbd>Tab</kbd></Button>
        <Button variant="ghost" size="sm" aria-label="Arrange by run order" title="Arrange by run order and fit the view" onClick={tidy}><ListOrdered size={14} />Arrange <kbd aria-hidden="true">Shift+Alt+T</kbd></Button>
        {/* The guide to managing agents mounts here (components/canvas-guide-help.tsx), always one click away. */}
        <section className="canvas-guide" aria-label="Guide" />
      </div>
      {graph.template === "recursive" && <label className="canvas-round-limit">Round limit <Input className="w-20" type="number" aria-label="Round limit" min={1} max={100} value={graph.roundLimit ?? ""} onChange={event => setGraph(current => ({ ...current, roundLimit: event.target.value ? Number(event.target.value) : undefined }))} /></label>}
      {patternCommand !== null && <form className="canvas-pattern-command hud-menu" aria-label="Workflow command" onSubmit={event => {
        event.preventDefault(); const number = Number(patternCommand);
        if (!Number.isInteger(number) || number < 1 || number > PATTERNS.length) { setNotice("Choose a pattern number from 1 to 5."); return; }
        if (run && !over(run)) { setNotice("Wait for this run to finish before changing its pattern."); return; }
        checkpoint(); setGraph(current => applyPattern(current, number)); setPatternCommand(null); setSelection([]); setRun(null); setStates({}); setNotice("");
        setTimeout(() => fitAll(), 60); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
      }}>
        <span className="text-xs">{PATTERNS.map((name, index) => `${index + 1} ${name}`).join(" · ")}</span>
        <Input aria-label="Workflow pattern" autoFocus inputMode="numeric" value={patternCommand} placeholder="Pattern number · Enter applies · Esc cancels" onChange={event => setPatternCommand(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPatternCommand(null); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus(); } }} />
      </form>}
      {finding !== null && <div className="quick-add hud-menu canvas-search" role="dialog" aria-label="Find on board" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); setFinding(null); focusBoard(); }
        else if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setFindIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, found.length)) % Math.max(1, found.length)); }
        else if (event.key === "Enter" && found[findIndex]) { event.preventDefault(); findAgent(found[findIndex].id); }
      }}>
        <p className="hud-menu-title">Find agents <kbd>Ctrl+F</kbd></p>
        <Input autoFocus aria-label="Find agents" value={finding} onChange={event => { setFinding(event.target.value); setFindIndex(0); }} />
        <div className="quick-add-list" role="listbox" aria-label="Matching agents">{found.map((node, index) => <MenuRow role="option" aria-selected={index === findIndex} key={node.id} onClick={() => findAgent(node.id)}>{node.data.title}{node.data.muted ? " · muted" : ""}</MenuRow>)}</div>
        {!found.length && <p className="quick-add-note">No matching agents.</p>}
      </div>}
      {runTargets && <div className="quick-add hud-menu canvas-search" role="dialog" aria-label="Run selected" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setRunTargets(null); focusBoard(); } }}>
        <p className="hud-menu-title">Run selected <kbd>Ctrl+Shift+Enter</kbd></p>
        <p className="quick-add-note">Selected targets and their required ancestors, each with its check:</p>
        <ul className="quick-add-list">{scope.map(node => <li key={node.id}>{node.type === "agent" ? node.data.title : ""} · {runTargets.includes(node.id) ? "target" : "required ancestor"}</li>)}</ul>
        <Button autoFocus size="sm" aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready} onClick={() => { const targets = runTargets; setRunTargets(null); focusBoard(); void start(targets); }}>Run selected</Button>
        <Button variant="ghost" size="sm" onClick={() => { setRunTargets(null); focusBoard(); }}>Cancel <kbd>Esc</kbd></Button>
      </div>}
      {adding && <CommandBar adding={adding} room={room} limit={limit} catalog={catalog} providers={providers} onClose={() => setAdding(null)}
        onAgents={command => { checkpoint(); addAgents(Math.max(1, command.count ?? 1), { model: command.model?.model ?? null, provider: command.model?.provider ?? null, effort: command.effort }, adding, command.tasks); setAdding(null); }}
        onNote={text => { checkpoint(); addNote(adding.at, text); setAdding(null); }} onAsk={text => { setAdding(null); void letElpis(text); }} />}
      {menu && (view => <CanvasMenu at={menu} {...view} onClose={() => setMenu(null)} />)(menuView(menu))}
      {dashboard && <AgentDashboard node={dashboard} own={own.get(dashboard.id) ?? ""} wave={order.get(dashboard.id)} status={states[dashboard.id]?.status ?? "idle"} check={states[checkOf(dashboard.id)]?.status ?? "idle"} clash={clashes[dashboard.id]} chat={states[dashboard.id]?.chat ?? null} modelLabel={modelLabel(dashboard.data)} ready={ready}
        waitsFor={inputsNeeded(dashboard.id)} feeds={graph.edges.filter(edge => waits(edge) && edge.source === dashboard.id).map(edge => titleOf(edge.target))}
        onOpenChat={onOpenChat} onSettings={() => { setSelection([dashboard.id]); showPanel(true); setDashboardId(null); }} onClose={() => setDashboardId(null)} />}
      {flowEdit && <div className="canvas-flow-edit" style={{ left: flowEdit.left, top: flowEdit.top }}><CanvasTextEdit key={flowEdit.edge.id} label="Flow label" maxLength={60} value={flowEdit.edge.source === MOTHER ? graph.motherFlow ?? "" : graph.edges.find(edge => edge.id === flowEdit.edge.id)?.label ?? ""} onSave={saveFlow} onCancel={() => setFlowEdit(null)} /></div>}
      {deleted && <p className="canvas-notice" data-tone="info" role="status"><span title={`Deleted ${deleted}`}>Deleted {deleted} ·</span><Button variant="outline" size="sm" onClick={() => { undo(); board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus(); }}>Undo</Button></p>}
      {planning && !deleted && <p className="canvas-notice" data-tone="info" role="status">Elpis is on it: {planning.length > 60 ? `${planning.slice(0, 60)}…` : planning}</p>}
      {undoLoad && !notice && !planning && !deleted && <p className="canvas-notice" data-tone="info" role="status">Loaded {undoLoad.loaded}.
        <Button variant="outline" size="sm" onClick={() => { setGraph(undoLoad.previous); setUndoLoad(null); setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60); }}>Undo</Button>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setUndoLoad(null)}><X size={13} /></Button></p>}
    </div>
    {!panelOpen ? null : sourceId ? <WorkflowSources id={sourceId} onBack={() => setSourceId(null)} edge={sideEdge} /> : selected ? <aside className="canvas-side" aria-label="Selected agent">{sideEdge}
      <p className="hud-menu-title">Agent{states[selected.id] ? ` · ${STATUS_LABEL[states[selected.id].status]}` : ""} · {CHECK_LABEL[states[checkOf(selected.id)]?.status ?? "idle"]}</p>
      <label>Name<Input ref={nameField} aria-label="Name" title={selected.data.title} value={selected.data.title} maxLength={256} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); promptField.current?.focus(); } }} onChange={event => edit({ title: event.target.value })} /></label>
      <label>Prompt<Textarea ref={promptField} aria-label="Prompt" rows={5} value={selected.data.instruction} placeholder="What this agent should do; left empty, Elpis fills it from the goal" onChange={event => edit({ instruction: event.target.value, title: promptName(selected.data, event.target.value) })} /></label>
      <label>Provider<OptionSelect aria-label="Provider" value={subscriptionOf(selected.data.model)?.prefix ?? canonicalProvider(selected.data.provider) ?? ""} onChange={event => {
        const subscription = subscriptions.find(choice => choice.id === event.target.value);
        if (subscription) { pendingProviderDefaults.current.delete(selected.id); edit({ provider: null, model: subscription.models[0]?.model ?? null, effort: null }); return; }
        const provider = event.target.value || null, offered = catalog.filter(item => item.provider === provider);
        const keep = offered.find(item => item.model === selected.data.model);
        const preferred = providerDefault(provider);
        if (!offered.length) pendingProviderDefaults.current.set(selected.id, { provider, model: selected.data.model, effort: selected.data.effort ?? null }); else pendingProviderDefaults.current.delete(selected.id);
        edit({ provider, model: keep?.model ?? preferred?.model ?? null, effort: keep?.efforts.includes(selected.data.effort ?? "") ? selected.data.effort : null });
      }}>{choices.map(choice => <option key={choice.id} value={choice.provider ?? ""}>{choice.label}</option>)}
        {subscriptions.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</OptionSelect></label>
      <label>Model<OptionSelect aria-label="Model" title={modelLabel(selected.data)} value={choiceKey(selected.data)} onChange={event => {
        if (event.target.value) { pendingProviderDefaults.current.delete(selected.id); edit(modelPatch(event.target.value)); return; }
        const provider = canonicalProvider(selected.data.provider), fallback = provider ? providerDefault(provider) : undefined;
        if (provider && !fallback) pendingProviderDefaults.current.set(selected.id, { provider, model: null, effort: null }); else pendingProviderDefaults.current.delete(selected.id);
        edit({ provider, model: fallback?.model ?? null, effort: null });
      }}>
        {subscriptionOf(selected.data.model) ? subscriptionOptions(subscriptionOf(selected.data.model)!.prefix) : modelOptions(canonicalProvider(selected.data.provider))}
        {selected.data.model && !selectedModel && !subscriptionOf(selected.data.model) && <option value={choiceKey(selected.data)}>{selected.data.model}</option>}</OptionSelect></label>
      {selectedModel && selectedModel.efforts.length > 0 && <label>Thinking<OptionSelect aria-label="Thinking" value={selected.data.effort ?? ""} onChange={event => edit({ effort: event.target.value || null })}>
        <option value="">Model default{selectedModel.defaultEffort ? ` (${selectedModel.defaultEffort})` : ""}</option>{selectedModel.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</OptionSelect></label>}
      <FolderPicker cwd={cwd} {...project} value={selected.data.writeScopes} own={own.get(selected.id)} onChange={writeScopes => edit({ writeScopes })} />
      <label>Done when (one per line; its check holds it to these)<Textarea aria-label="Done when" rows={3} value={selected.data.acceptanceCriteria.join("\n")} placeholder={DONE} onChange={event => edit({ acceptanceCriteria: lines(event.target.value) })} /></label>
      <div className="canvas-inspector-actions">
        <Button variant="outline" size="sm" data-agent-info={selected.id} aria-expanded={dashboardId === selected.id} onClick={() => setDashboardId(current => current === selected.id ? null : selected.id)}>Info <kbd>Enter</kbd></Button>
        {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove([selected.id])}><Trash2 size={14} />Delete agent</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : chosen.length > 1 ? <aside className="canvas-side" aria-label="Selected agents">{sideEdge}
      <p className="hud-menu-title">{chosen.length} agents selected</p>
      <p className="canvas-help">{chosen.map(node => node.data.title || "Untitled").join(", ")}</p>
      <label>Model<OptionSelect aria-label="Model" value={shared(choiceKey)} onChange={event => edit(modelPatch(event.target.value))}>{mixed}{modelOptions()}</OptionSelect></label>
      <FolderPicker cwd={cwd} {...project} value={commonFolders} onChange={setCommonFolders} />
      <div className="canvas-inspector-actions">
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(chosen.map(node => node.id))}><Trash2 size={14} />Delete {chosen.length} agents <kbd>Delete</kbd></Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : motherOpen ? <aside className="canvas-side" aria-label="Mother">{sideEdge}
      <p className="hud-menu-title">Mother · the run&rsquo;s chat</p>
      <p className="canvas-help">Every agent is her child: she starts the ones that wait for no one, and every report comes back to her. These settings apply to the whole run.</p>
      <label>Goal (every agent gets it)<Textarea aria-label="Goal" rows={4} value={mother.brief} placeholder="What should this run achieve? Elpis can design the team from it." onChange={event => setMother({ brief: event.target.value })} /></label>
      <Button size="sm" onClick={() => void letElpis(mother.brief)} aria-describedby={!ready ? offlineReasonId : undefined} disabled={!ready || !mother.brief.trim() || Boolean(planning)} title="Elpis designs the team from the goal: how many agents, their prompts, folders and wiring; Ctrl+Z undoes it">{planning ? "Elpis is designing…" : "Let Elpis design the team"}</Button>
      <label>Her model<OptionSelect aria-label="Her model" value={mother.model ? `${mother.provider ?? ""}|${mother.model}` : ""} onChange={event => { const patch = modelPatch(event.target.value); setMother({ model: patch.model ?? null, provider: patch.provider ?? null }); }}>{modelOptions()}</OptionSelect></label>
      <div className="canvas-mother-counts">
        <CountField label="Max agents" value={limit} min={Math.max(1, agents.length)} max={Math.floor(allowed.graph / TASKS_PER_AGENT)} onChange={count => setGraph(current => ({ ...current, maxAgents: count }))}
          why={typed => typed > allowed.graph / TASKS_PER_AGENT ? `Elpis runs at most ${allowed.graph} tasks in a graph: ${Math.floor(allowed.graph / TASKS_PER_AGENT)} agents, each with its check.` : typed < agents.length ? `The graph already has ${agents.length} agents; remove some first.` : "Type a whole number from 1."} />
        <CountField label="At once" value={Math.min(maxAtOnce, allowed.atOnce)} min={1} max={allowed.atOnce} onChange={setMaxAtOnce}
          why={typed => typed > allowed.atOnce ? `Elpis allows ${allowed.atOnce} at once here (${allowed.source}).` : "At least 1 has to run."} />
      </div>
      {run && <p className="canvas-help" role="status">{(["running", "succeeded", "pending", "failed", "blocked"] as const).map(status => [status, agents.filter(node => states[node.id]?.status === status).length] as const).filter(([, count]) => count).map(([status, count]) => `${count} ${STATUS_LABEL[status]}`).join(" · ") || "Starting…"}</p>}
      {split.father.length > 0 && <p className="canvas-help" role="note">The Father runs {split.father.length} more {split.father.length === 1 ? "agent" : "agents"} in his own chat once her part has succeeded, and reports to her{run?.father ? `: ${run.father.threadId ? STATUS_LABEL[(run.father.status as TaskStatus)] ?? run.father.status : run.father.status === "cancelled" ? "not started, her part failed" : "waiting for her part"}` : "."}</p>}
      <LiveFeed chat={run?.rootThreadId ?? null} working={runState === "running"} ready={ready} idle="Not started. Every agent's report arrives here once the graph runs." />
      <div className="canvas-inspector-actions">
        {run && <Button variant="outline" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open her chat</Button>}
        {run?.father?.threadId && <Button variant="outline" size="sm" onClick={() => onOpenChat(run.father!.threadId!)}><ExternalLink size={14} />Open the Father&rsquo;s chat</Button>}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelection([])}>Done</Button>
      </div>
    </aside> : <aside className="canvas-side" aria-label="Architectures">{sideEdge}
      <details open={morePatterns} onToggle={event => { if (event.target === event.currentTarget) setMorePatterns(event.currentTarget.open); }}>
        <DisclosureSummary>More patterns</DisclosureSummary>
      <section className="canvas-templates" aria-label="Ready-made workflows"><p className="hud-menu-title">Ready-made workflows</p>
        {WORKFLOWS.map(workflow => <div key={workflow.id}><Button variant="ghost" size="content" className="canvas-template w-full" aria-current={graph.result && graph.planningPattern === workflow.id || undefined} disabled={!ready || Boolean(planning || starting)}
          onClick={() => { setGraph(current => ({ ...current, planningPattern: workflow.id })); void pickReadyMade(workflow); }}>
          <strong>{workflow.name}{graph.result && graph.planningPattern === workflow.id && <span className="canvas-template-loaded">On the board</span>}</strong>
          <Shape shape={shapes.get(workflow.id) ?? []} /><small>{workflow.description}</small></Button></div>)}
      </section>
      {(["Patterns", "Research", "Start"] as const).map(group => <section key={group} className="canvas-templates" aria-label={group}>
        <p className="hud-menu-title">{group === "Start" ? "Start fresh" : group}</p>
        {TEMPLATES.filter(template => template.group === group).map(template => <div key={template.id}><Button variant="ghost" size="content" className="canvas-template w-full" aria-current={graph.template === template.id || undefined} onClick={() => loadTemplate(template)}>
          <strong>{template.name}{graph.template === template.id && <span className="canvas-template-loaded">On the board</span>}</strong>
          <Shape shape={shapes.get(template.id) ?? []} /><small>{template.description}</small>
          {template.caution && <small className="canvas-template-caution">{template.caution}</small>}
          {template.source && <small className="canvas-template-source">{template.source}</small>}</Button>
          <a className={buttonVariants({ variant: "link", size: "xs" })} href={`#workflow-sources-${template.id}`} aria-label={`Sources for ${template.name}`} onClick={event => { event.preventDefault(); setSelection([]); setSourceId(template.id); }}>Sources</a></div>)}
      </section>)}
      </details>
    </aside>}
    {notice && !historicalNotice && <div id={runReasonId} className="canvas-notice canvas-error-notice" role="alert">
      <div className="canvas-error-details" role="region" aria-label="Workflow error details" tabIndex={0}>{notice}</div>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></Button>
    </div>}
  </section>;
}

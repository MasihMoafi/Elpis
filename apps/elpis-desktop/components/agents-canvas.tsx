"use client";

import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, useReactFlow, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { Check, ExternalLink, Play, StickyNote, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Textarea } from "@/components/ui/textarea";
import { api, type Model, type Thread } from "@/lib/api";
import { KINDS, TEMPLATES, agent, makesLoop, newId, readGraph, runTasks, saveGraph, type AgentData, type AgentKind, type CanvasEdge, type CanvasGraph, type CanvasNode, type NoteData, type TaskStatus } from "@/lib/canvas";

type Run = { rootThreadId: string; graphId: string; status: string };
type Listed = { data: { id: string; status: string; tasks: { id: string; status: TaskStatus; assignedThreadId: string | null }[] }[] };
const STATUS_LABEL: Record<TaskStatus | "idle", string> = { idle: "not run", pending: "waiting", running: "running", succeeded: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

/** An agent on the canvas: its role, name and state, with an input on the left (what it waits for) and an output on the
 * right (what waits for it), as Deus Ex's hacking screen links its nodes. */
function AgentNode({ data }: NodeProps<Node<AgentData & { status?: TaskStatus; modelLabel?: string }>>) {
  const status = data.status ?? "idle";
  return <div className="agent-node" data-kind={data.kind} data-status={status}>
    <Handle type="target" position={Position.Left} />
    <span className="agent-node-kind">{KINDS[data.kind].label}</span>
    <strong className="agent-node-title">{data.title || "Untitled"}</strong>
    <small className="agent-node-meta">{data.modelLabel ?? "Default model"} · {STATUS_LABEL[status]}</small>
    <span className="agent-node-mark" aria-hidden="true">{status === "succeeded" ? <Check size={12} /> : status === "failed" || status === "blocked" ? <X size={12} /> : null}</span>
    <Handle type="source" position={Position.Right} />
  </div>;
}

/** A FigJam-style sticky note: free text on the canvas, never sent to Elpis. */
function NoteNode({ id, data }: NodeProps<Node<NoteData & { onText?: (id: string, text: string) => void }>>) {
  return <div className="canvas-note"><textarea aria-label="Note" className="nodrag" value={data.text} placeholder="Write a note" onChange={event => data.onText?.(id, event.target.value)} /></div>;
}
const NODE_TYPES = { agent: AgentNode, note: NoteNode };

/** The agents canvas: ready-made architectures, agents wired by what they wait for, and a run that follows each agent
 * live. The graph is kept on this device (lib/canvas.ts). */
type Props = { models: Model[]; cwd?: string; dark: boolean; onOpenChat: (id: string) => void };
export function AgentsCanvas(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ models, cwd, dark, onOpenChat }: Props) {
  const flow = useReactFlow(), board = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<CanvasGraph>(() => readGraph() ?? TEMPLATES[0].build());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [maxAtOnce, setMaxAtOnce] = useState(3);
  const [run, setRun] = useState<Run | null>(null), [starting, setStarting] = useState(false);
  const [states, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null }>>({});
  useEffect(() => { const timer = setTimeout(() => { if (!saveGraph(graph)) setNotice("Could not keep the graph on this device."); }, 300); return () => clearTimeout(timer); }, [graph]);

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

  const modelLabel = (model: string | null) => model ? models.find(item => item.model === model)?.displayName ?? model : "Default model";
  const setText = (id: string, text: string) => setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id && node.type === "note" ? { ...node, data: { text } } : node) }));
  const nodes = useMemo<Node[]>(() => graph.nodes.map(node => ({ ...node, selected: node.id === selectedId,
    data: node.type === "agent" ? { ...node.data, status: states[node.id]?.status, modelLabel: modelLabel(node.data.model) } : { ...node.data, onText: setText } })), [graph.nodes, selectedId, states, models]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo<Edge[]>(() => graph.edges.map(edge => {
    const from = states[edge.source]?.status, to = states[edge.target]?.status;
    return { ...edge, animated: from === "succeeded" && to === "running", className: from === "failed" || to === "blocked" ? "canvas-edge-cut" : from === "succeeded" ? "canvas-edge-done" : undefined };
  }), [graph.edges, states]);

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set(changes.flatMap(change => change.type === "remove" ? [change.id] : []));
    for (const change of changes) if (change.type === "select" && change.selected) setSelectedId(change.id);
    setGraph(current => ({ ...current, nodes: applyNodeChanges(changes.filter(change => change.type !== "select"), current.nodes as Node[]) as CanvasNode[],
      edges: removed.size ? current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) : current.edges }));
    if (selectedId && removed.has(selectedId)) setSelectedId(null);
  };
  const onEdgesChange = (changes: EdgeChange[]) => setGraph(current => ({ ...current, edges: applyEdgeChanges(changes, current.edges as Edge[]).map(({ id, source, target }) => ({ id, source, target })) }));
  const onConnect = ({ source, target }: Connection) => {
    if (!source || !target) return;
    if (makesLoop(graph.edges, source, target)) { setNotice("That wire would make a loop: an agent can't wait for itself."); return; }
    setNotice("");
    setGraph(current => current.edges.some(edge => edge.source === source && edge.target === target) ? current : { ...current, edges: [...current.edges, { id: `${source}->${target}`, source, target } satisfies CanvasEdge] });
  };
  // A new node lands in view, in the first free spot near the middle, never on top of another.
  const place = () => {
    const box = board.current?.getBoundingClientRect();
    const middle = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 100, y: box.top + box.height / 2 - 40 }) : { x: 0, y: 0 };
    const taken = graph.nodes.map(node => ({ x: node.position.x, y: node.position.y, w: (node as { measured?: { width?: number } }).measured?.width ?? 210, h: (node as { measured?: { height?: number } }).measured?.height ?? 90 }));
    const free = (x: number, y: number) => taken.every(item => x + 210 < item.x || x > item.x + item.w + 10 || y + 90 < item.y || y > item.y + item.h + 10);
    for (let ring = 0; ring < 12; ring++) for (let step = 0; step <= ring * 4; step++) {
      const angle = ring ? (step / (ring * 4)) * 2 * Math.PI : 0, x = middle.x + Math.cos(angle) * ring * 110, y = middle.y + Math.sin(angle) * ring * 70;
      if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
    return { x: middle.x, y: middle.y + 400 };
  };
  const addAgent = (kind: AgentKind) => {
    const { x, y } = place(), node = agent(kind, `New ${KINDS[kind].label} agent`, "", x, y);
    setGraph(current => ({ ...current, nodes: [...current.nodes, node] })); setSelectedId(node.id);
  };
  const addNote = () => { const { x, y } = place(); setGraph(current => ({ ...current, nodes: [...current.nodes, { id: newId("note"), type: "note", position: { x, y }, data: { text: "" } }] })); };
  const loadTemplate = (build: () => CanvasGraph) => { setGraph(build()); setSelectedId(null); setRun(null); setStates({}); setNotice(""); };
  const selected = graph.nodes.find(node => node.id === selectedId && node.type === "agent") as Extract<CanvasNode, { type: "agent" }> | undefined;
  const edit = (patch: Partial<AgentData>) => selected && setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === selected.id && node.type === "agent" ? { ...node, data: { ...node.data, ...patch } } : node) }));
  const remove = (id: string) => { setGraph(current => ({ ...current, nodes: current.nodes.filter(node => node.id !== id), edges: current.edges.filter(edge => edge.source !== id && edge.target !== id) })); setSelectedId(null); };

  async function start() {
    const built = runTasks(graph);
    if ("error" in built) { setNotice(built.error); return; }
    setStarting(true); setNotice(""); setStates({});
    try {
      const created = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: graph.name.slice(0, 120) || "Agents canvas" });
      const result = await api<{ graphId: string }>("/workflows/run", { rootThreadId: created.thread.id, name: graph.name || "Agents canvas", tasks: built.tasks, maxConcurrency: maxAtOnce });
      setRun({ rootThreadId: created.thread.id, graphId: result.graphId, status: "running" });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setStarting(false); }
  }

  const agents = graph.nodes.filter(node => node.type === "agent"), done = agents.filter(node => states[node.id]?.status === "succeeded").length;
  const chat = selected ? states[selected.id]?.chat : null;
  return <section className="agents-canvas" aria-label="Agents canvas">
    <header className="canvas-header">
      <Input aria-label="Graph name" className="canvas-name" value={graph.name} maxLength={120} onChange={event => setGraph(current => ({ ...current, name: event.target.value }))} />
      {run && <span className="canvas-chip" role="status"><i className="canvas-dot" data-status={FINISHED.has(run.status) ? run.status : "running"} />{FINISHED.has(run.status) ? "Finished" : "Running"} · {done} of {agents.length} done</span>}
      <span className="canvas-spacer" />
      {run && <Button variant="ghost" size="sm" onClick={() => onOpenChat(run.rootThreadId)}><ExternalLink size={14} />Open run chat</Button>}
      <label className="canvas-chip">At once<OptionSelect aria-label="Agents at once" value={String(maxAtOnce)} onChange={event => setMaxAtOnce(Number(event.target.value))}>{[1, 2, 3, 4, 6, 8].map(count => <option key={count} value={count}>{count}</option>)}</OptionSelect></label>
      <Button size="sm" onClick={() => void start()} disabled={starting || Boolean(run && !FINISHED.has(run.status))}><Play size={14} />{starting ? "Starting…" : "Run graph"}</Button>
    </header>
    <div className="canvas-board" ref={board}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onPaneClick={() => setSelectedId(null)} deleteKeyCode={["Backspace", "Delete"]} colorMode={dark ? "dark" : "light"} fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }} minZoom={0.3} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="canvas-minimap" />
        <Panel position="bottom-center" className="canvas-toolbar" aria-label="Add to the canvas">
          {(Object.keys(KINDS) as AgentKind[]).map(kind => <Button key={kind} variant="ghost" size="sm" aria-label={`Add ${KINDS[kind].label} agent`} title={KINDS[kind].hint} onClick={() => addAgent(kind)}><i className="canvas-kind" data-kind={kind} />{KINDS[kind].label}</Button>)}
          <Button variant="ghost" size="sm" onClick={addNote}><StickyNote size={14} />Note</Button>
        </Panel>
      </ReactFlow>
      {notice && <p className="canvas-notice" role="alert">{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={13} /></button></p>}
    </div>
    {selected ? <aside className="canvas-side" aria-label="Selected agent">
      <p className="hud-menu-title">{KINDS[selected.data.kind].label} agent{states[selected.id] ? ` · ${STATUS_LABEL[states[selected.id].status]}` : ""}</p>
      <label>Name<Input aria-label="Name" value={selected.data.title} maxLength={256} onChange={event => edit({ title: event.target.value })} /></label>
      <label>Role<OptionSelect aria-label="Role" value={selected.data.kind} onChange={event => edit({ kind: event.target.value as AgentKind })}>{(Object.keys(KINDS) as AgentKind[]).map(kind => <option key={kind} value={kind} data-hint={KINDS[kind].hint}>{KINDS[kind].label}</option>)}</OptionSelect></label>
      <label>Instruction<Textarea aria-label="Instruction" rows={5} value={selected.data.instruction} placeholder="What this agent should do" onChange={event => edit({ instruction: event.target.value })} /></label>
      <label>Model<OptionSelect aria-label="Model" value={selected.data.model ?? ""} onChange={event => edit({ model: event.target.value || null })}><option value="">Default model</option>{models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</OptionSelect></label>
      <label>May write (one folder or file per line)<Textarea aria-label="May write" rows={2} value={selected.data.writeScopes.join("\n")} onChange={event => edit({ writeScopes: lines(event.target.value) })} /></label>
      <label>Done when (one check per line)<Textarea aria-label="Done when" rows={3} value={selected.data.acceptanceCriteria.join("\n")} onChange={event => edit({ acceptanceCriteria: lines(event.target.value) })} /></label>
      <div className="canvas-inspector-actions">
        {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(selected.id)}><Trash2 size={14} />Delete agent</Button>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelectedId(null)}>Done</Button>
      </div>
    </aside> : <aside className="canvas-side" aria-label="Architectures">
      <p className="hud-menu-title">Architectures</p>
      {TEMPLATES.map(template => <button key={template.id} type="button" className="canvas-template" onClick={() => loadTemplate(template.build)}><strong>{template.name}</strong><small>{template.description}</small></button>)}
      <p className="canvas-help">Drag from an agent&rsquo;s right dot to another&rsquo;s left dot: the second waits for the first. Click an agent to edit it; Delete removes the selection.</p>
    </aside>}
  </section>;
}

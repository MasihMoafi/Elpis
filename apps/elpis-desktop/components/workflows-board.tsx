"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ReactFlow, Handle, Position, MarkerType, applyNodeChanges, applyEdgeChanges, type Node, type NodeProps, type Edge, type ReactFlowInstance } from "@xyflow/react";
import { Check, CircleAlert, Clock, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModelPicker } from "@/components/model-picker";
import { api, providerChoices, type Model, type ProviderSettings } from "@/lib/api";
import { agentPortrait, characters } from "@/lib/agent-characters";
import { appStorage } from "@/lib/projects";
import { MarkdownText } from "@/components/markdown-text";
import { ended, graphToTasks, migrateTeam, WORKFLOWS_KEY, type Pet, type PetData, type Team, type TaskState } from "@/lib/workflows";

type Status = "working" | "needs you" | "done" | "failed" | undefined;
type PetNode = Node<PetData & { status?: Status }, "pet">;
type Controls = { models: Model[]; settings: ProviderSettings | null; busy: boolean; edit: (id: string, patch: Partial<PetData>) => void; chat: (id: string) => void };
const PetControls = createContext<Controls | null>(null);
const MARKS = { working: Clock, "needs you": CircleAlert, done: Check, failed: X };

function PetView({ id, data, selected }: NodeProps<PetNode>) {
  const controls = useContext(PetControls)!;
  const choices = providerChoices(controls.models, controls.settings);
  const choice = choices.find(item => item.provider === data.provider) ?? choices[0];
  const Mark = data.status ? MARKS[data.status] : null;
  return <div className="relative flex w-40 flex-col items-center gap-2 p-3">
    <Handle type="target" position={Position.Left} aria-label="Receives results" />
    <img src={agentPortrait(data) || agentPortrait({ character: "researcher" })} alt={data.character} width={96} height={96} draggable={false} className="h-24 w-24 object-contain" />
    <div className="flex max-w-full items-center justify-center gap-2"><span className="break-words text-center text-sm">{data.title}</span>{Mark && <Mark size={14} className={data.status === "failed" ? "shrink-0 text-destructive" : "shrink-0 text-primary"} aria-label={data.status} />}</div>
    <Handle type="source" position={Position.Right} aria-label="Hands results to" />
    {selected && <div className="nodrag nowheel absolute top-full flex gap-2 pt-1">
      <Popover><PopoverTrigger render={<Button size="xs" variant="outline" />}>Edit</PopoverTrigger>
        <PopoverContent side="right" align="start" role="dialog" aria-label="Edit pet" className="nodrag nowheel grid gap-4 p-4" onKeyDown={event => { if (["Delete", "Backspace"].includes(event.key)) event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key === "s") event.preventDefault(); }}>
          <label className="grid gap-2 text-sm">Name<Input aria-label="Name" value={data.title} maxLength={120} disabled={controls.busy} onChange={event => controls.edit(id, { title: event.target.value })} /></label>
          <label className="grid gap-2 text-sm">Role prompt<Textarea aria-label="Role prompt" rows={4} maxLength={12000} value={data.instruction} disabled={controls.busy} onChange={event => controls.edit(id, { instruction: event.target.value })} /></label>
          <ModelPicker choices={choices} models={controls.models} model={data.model || ""} defaultModel={controls.settings?.main.model} choiceId={choice?.id || ""} disabled={controls.busy || !choices.length}
            onChange={picked => controls.edit(id, { model: picked.model, provider: choices.find(item => item.id === picked.choiceId)?.provider || null })} />
          <div className="flex items-center justify-between gap-4 text-sm"><span aria-hidden="true">Edits files</span><Switch aria-label="Edits files" checked={data.editsFiles} disabled={controls.busy} onCheckedChange={editsFiles => controls.edit(id, { editsFiles })} /></div>
        </PopoverContent>
      </Popover>
      <Button size="xs" variant="outline" disabled={!data.lastThreadId} title={data.lastThreadId ? "Open last run" : "Run the team to start this pet's chat"} onClick={() => data.lastThreadId && controls.chat(data.lastThreadId)}>Chat</Button>
    </div>}
  </div>;
}
const nodeTypes = { pet: PetView };

export function WorkflowsBoard({ models, settings, cwd, dark, onOpenChat, projectMenu, waitingThreadIds = [] }: {
  models: Model[]; settings: ProviderSettings | null; cwd?: string; dark: boolean; onOpenChat: (id: string) => void; projectMenu?: ReactNode; waitingThreadIds?: string[];
}) {
  const [team, setTeam] = useState<Team | null>(null), [selected, setSelected] = useState<string | null>(null), [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [starting, setStarting] = useState(false), [error, setError] = useState(""), [resultsOpen, setResultsOpen] = useState(true);
  const inFlight = useRef(false), flow = useRef<ReactFlowInstance<PetNode> | null>(null);
  const running = !!team?.run && !ended(team.run.status), busy = starting || running;
  useEffect(() => {
    try { setTeam(migrateTeam(JSON.parse(appStorage().getItem(WORKFLOWS_KEY) || "null"))); }
    catch { setTeam(migrateTeam(null)); setError("The saved team could not be read."); }
  }, []);
  useEffect(() => {
    if (!team) return;
    try { appStorage().setItem(WORKFLOWS_KEY, JSON.stringify(team)); }
    catch { setError("The team could not be saved. Check available storage."); }
  }, [team]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.current?.fitView({ padding: 0.35, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [team?.nodes.length, team?.nodes.every(pet => pet.measured?.width), resultsOpen, team?.run?.rootThreadId]);
  useEffect(() => {
    if (!team?.run || !running) return;
    const { rootThreadId, graphId } = team.run;
    let active = true;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await api<{ data: { id: string; status: string; tasks: TaskState[] }[] }>(`/workflows?threadId=${encodeURIComponent(rootThreadId)}`, undefined, controller.signal);
        const found = response.data.find(item => item.id === graphId);
        if (active && found) {
          setError("");
          setTeam(previous => previous?.run?.graphId === graphId ? { ...previous, run: { rootThreadId, graphId, status: found.status, tasks: found.tasks },
            nodes: previous.nodes.map(pet => { const task = found.tasks.find(item => item.id === pet.id); return task?.assignedThreadId ? { ...pet, data: { ...pet.data, lastThreadId: task.assignedThreadId } } : pet; }) } : previous);
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void poll(); const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [team?.run?.rootThreadId, team?.run?.graphId, running]);
  const nodes = useMemo<PetNode[]>(() => (team?.nodes ?? []).map(pet => {
    const task = team?.run?.tasks.find(item => item.id === pet.id), check = team?.run?.tasks.find(item => item.id === `${pet.id}-check`);
    const steps = [task, check].filter((item): item is TaskState => !!item);
    const status: Status = steps.some(item => item.assignedThreadId && waitingThreadIds.includes(item.assignedThreadId)) ? "needs you"
      : steps.some(item => ["failed", "blocked", "cancelled"].includes(item.status)) ? "failed"
      : steps.some(item => item.status === "running") ? "working"
      : task?.status === "succeeded" && (!check || check.status === "succeeded") ? "done" : undefined;
    return { ...pet, selected: selected === pet.id, data: { ...pet.data, status } };
  }), [team, selected, waitingThreadIds]);
  let reason = "";
  try { if (team) graphToTasks(team, team.task || ""); } catch (cause) { reason = cause instanceof Error ? cause.message : String(cause); }
  if (busy) reason = starting ? "Starting the team…" : "The team is running.";
  async function run() {
    if (!team || reason || inFlight.current) return;
    inFlight.current = true; setStarting(true); setError("");
    try {
      const tasks = graphToTasks(team, team.task || ""), name = (team.task || "Team").trim().slice(0, 120);
      const { thread } = await api<{ thread: { id: string } }>("/threads", { cwd, agents: true, name });
      const { graphId } = await api<{ graphId: string }>("/workflows/run", { rootThreadId: thread.id, name, tasks, maxConcurrency: 4 });
      setTeam(previous => previous && { ...previous, nodes: previous.nodes.map(pet => ({ ...pet, data: { ...pet.data, lastThreadId: undefined } })), run: { rootThreadId: thread.id, graphId, status: "running", tasks: [] } });
      setResultsOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; setStarting(false); }
  }
  if (!team) return null;
  const controls: Controls = { models, settings, busy, chat: onOpenChat, edit: (id, patch) => setTeam(previous => previous && { ...previous, nodes: previous.nodes.map(pet => pet.id === id ? { ...pet, data: { ...pet.data, ...patch } } : pet) }) };
  const edges: Edge[] = team.edges.map(edge => ({ ...edge, selected: edge.id === selectedEdge, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "var(--muted-foreground)" } }));
  return <section aria-label="Workflows" className="relative flex min-h-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b p-3">
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={busy} />}><Plus size={14} />Add</DropdownMenuTrigger>
        <DropdownMenuContent align="start">{["researcher", "builder", "reviewer", "tester", "writer", "critic"].map(id => characters.find(character => character.id === id)!).map(character => <DropdownMenuItem key={character.id} onClick={() => {
          const pet: Pet = { id: `pet-${crypto.randomUUID()}`, type: "pet", position: { x: 100 + (team.nodes.length % 4) * 230, y: 100 + Math.floor(team.nodes.length / 4) * 220 },
            data: { character: character.id, title: character.name, instruction: character.prompt, model: settings?.main.model || models[0]?.model || null, provider: settings?.main.provider, editsFiles: false } };
          setTeam({ ...team, nodes: [...team.nodes, pet] }); setSelected(pet.id);
        }}>{character.name}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu>
      {projectMenu}
      {team.run && <div className="ml-auto flex items-center gap-2 text-sm"><span aria-hidden="true">Results</span><Switch aria-label="Results" checked={resultsOpen} onCheckedChange={setResultsOpen} /></div>}
    </div>
    <div className="relative flex min-h-0 flex-1">
      <div className="min-w-0 flex-1" style={{ minHeight: 200 }}>
        <PetControls.Provider value={controls}><ReactFlow<PetNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={dark ? "dark" : "light"} style={{ "--xy-background-color": "var(--background)", "--xy-handle-background-color": "var(--primary)", "--xy-handle-border-color": "var(--background)" } as CSSProperties} onInit={instance => { flow.current = instance; }} fitView fitViewOptions={{ padding: 0.35, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5}
          nodesDraggable={!busy} nodesConnectable={!busy} deleteKeyCode={busy ? null : ["Delete", "Backspace"]} proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => { setSelected(node.id); setSelectedEdge(null); }} onEdgeClick={(_, edge) => { setSelected(null); setSelectedEdge(edge.id); }} onPaneClick={() => { setSelected(null); setSelectedEdge(null); }}
          onNodesChange={changes => setTeam(previous => previous && { ...previous, nodes: applyNodeChanges(changes, previous.nodes as PetNode[]).map(({ id, type, position, data, measured }) => ({ id, type: type!, position, data, measured })),
            edges: previous.edges.filter(edge => !changes.some(change => change.type === "remove" && (change.id === edge.source || change.id === edge.target))) })}
          onEdgesChange={changes => setTeam(previous => previous && { ...previous, edges: applyEdgeChanges(changes, previous.edges) })}
          onConnect={connection => {
            if (team.edges.some(edge => edge.source === connection.source && edge.target === connection.target)) return;
            const next = { ...team, edges: [...team.edges, { id: crypto.randomUUID(), source: connection.source, target: connection.target }] };
            try { graphToTasks(next, team.task || "Check connection"); setTeam(next); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          }} /></PetControls.Provider>
      </div>
      {/* Each pet works in its own chat, so the run's results are gathered here, in run order (23 Oct live check: the run's own chat stays empty). */}
      {team.run && resultsOpen && <aside aria-label="Results" className="w-[40%] min-w-0 overflow-y-auto border-l p-4"><ol className="grid gap-4">
        {team.nodes.map(pet => ({ pet, task: team.run!.tasks.find(item => item.id === pet.id), status: nodes.find(node => node.id === pet.id)?.data.status })).filter(({ task }) => task).map(({ pet, task, status }) => <li key={pet.id} className="grid gap-2">
          <div className="flex items-center gap-2"><img src={agentPortrait(pet.data) || agentPortrait({ character: "researcher" })} alt="" width={28} height={28} className="h-7 w-7 object-contain" /><strong className="text-sm">{pet.data.title}</strong>
            <span className="text-xs text-muted-foreground">{status ?? "waiting"}</span>
            {task!.assignedThreadId && <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onOpenChat(task!.assignedThreadId!)}>Open chat</Button>}</div>
          {task!.result?.summary ? <div className="text-sm"><MarkdownText text={task!.result.summary} /></div> : task!.failureReason ? <p className="text-sm text-destructive">{task!.failureReason}</p> : null}
        </li>)}
      </ol></aside>}
    </div>
    <form className="grid gap-3 border-t p-4" onSubmit={event => { event.preventDefault(); void run(); }}>
      <Textarea aria-label="Give the team a task" placeholder="Give the team a task" rows={2} maxLength={16000} value={team.task || ""} onChange={event => setTeam({ ...team, task: event.target.value })}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(); } if ((event.ctrlKey || event.metaKey) && event.key === "s") event.preventDefault(); }} />
      <div className="flex items-center gap-3"><Button type="submit" size="sm" disabled={!!reason} aria-describedby="team-run-reason">Run</Button><span id="team-run-reason" className="text-sm text-muted-foreground">{reason}</span></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  </section>;
}

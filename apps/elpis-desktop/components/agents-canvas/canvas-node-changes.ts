import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import { frameBounds } from "@/lib/canvas-editing";
import { FATHER, MOTHER, makesLoop, type CanvasEdge, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";

export function canvasNodeChanges({ checkpoint, sizes, setFatherSize, setSelection, nodeDrag, frames, setGraph, reconnecting, agents, graph, connectionCancelled, restored, setNotice, reveal }: {
  checkpoint: () => void;
  sizes: React.RefObject<Map<string, { width: number; height: number; }>>;
  setFatherSize: React.Dispatch<React.SetStateAction<{ width: number; height: number; } | null>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  nodeDrag: React.RefObject<{ before: CanvasGraph; id: string; ids: string[]; extract: boolean; cancelled: boolean; } | null>;
  frames: Node[];
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  reconnecting: React.RefObject<string | null>;
  agents: Extract<CanvasNode, { type: "agent" }>[];
  graph: CanvasGraph;
  connectionCancelled: React.RefObject<boolean>;
  restored: React.RefObject<boolean>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  reveal: (ids: string[]) => NodeJS.Timeout
}) {

  const onNodesChange = (changes: NodeChange[]) => {
    const removed = new Set(changes.flatMap(change => change.type === "remove" && change.id !== MOTHER ? [change.id] : []));
    if (removed.size) checkpoint();
    for (const change of changes) if (change.type === "dimensions" && change.dimensions) { sizes.current.set(change.id, change.dimensions); if (change.id === FATHER) setFatherSize(change.dimensions); }
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
    if ([source, target].some(id => id === MOTHER || id === FATHER)) { setNotice("The Mother agent starts every agent that waits for no one, so she takes no wires: wire agents to each other."); return; }
    if (![source, target].every(id => agents.some(node => node.id === id))) return;
    if (graph.edges.some(edge => (edge.source === source && edge.target === target) || (edge.source === target && edge.target === source))) { setNotice("Those two are already wired: click the wire to change or remove it."); return; }
    const feedback = !kind && makesLoop(graph.edges, source, target);
    if (feedback && graph.template !== "recursive") { setNotice("That wire would make a loop: an agent can't wait for itself."); return; }
    setNotice(""); checkpoint();
    setGraph(current => ({ ...current, edges: [...current.edges, { id: `${source}${kind ? "~" : "->"}${target}`, source, target, ...(kind ? { kind } : {}), ...(feedback ? { feedback: true, label: "Next round" } : {}) } satisfies CanvasEdge] }));
    // Auto-arrange may move them: the two just wired stay in view.
    reveal([source, target]);
  };
  return { connect, validConnection, reconnect, onNodesChange, onEdgesChange };
}
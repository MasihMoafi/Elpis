import { makesLoop, type AgentData, type CanvasEdge, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";
import { BoardMenu } from "./types";

export function canvasAgentEdits({
  setGraph,
  chosen,
  graph,
  checkpoint,
  setNotice,
  setDeleted,
  setSelection,
  setMenu,
}: {
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  chosen: Extract<CanvasNode, { type: "agent" }>[];
  graph: CanvasGraph;
  checkpoint: () => void;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  setDeleted: React.Dispatch<React.SetStateAction<string | null>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
}) {
  // Edits apply to every selected agent: one in the inspector, several together.
  const editEach = (change: (data: AgentData) => Partial<AgentData>) =>
    setGraph(current => ({
      ...current,
      nodes: current.nodes.map(node =>
        node.type === "agent" && chosen.some(item => item.id === node.id)
          ? { ...node, data: { ...node.data, ...change(node.data) } }
          : node,
      ),
    }));
  const edit = (patch: Partial<AgentData>) => editEach(() => patch);
  // Several agents share the folders they all may write; adding or removing one changes it for each.
  const commonFolders = chosen.reduce<string[]>(
    (common, node, index) =>
      index ? common.filter(folder => node.data.writeScopes.includes(folder)) : node.data.writeScopes,
    [],
  );
  const setCommonFolders = (next: string[]) =>
    editEach(data => ({
      writeScopes: [
        ...data.writeScopes.filter(folder => !commonFolders.includes(folder) || next.includes(folder)),
        ...next.filter(folder => !data.writeScopes.includes(folder)),
      ],
    }));
  const remove = (ids: string[]) => {
    const gone = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id));
    const wires = graph.edges.filter(edge => ids.includes(edge.id));
    if (!gone.length && !wires.length && !graph.frames?.some(frame => ids.includes(frame.id))) return;
    checkpoint();
    setNotice("");
    setDeleted(gone.map(node => (node.type === "agent" ? node.data.title : "note")).join(", "));
    setGraph(current => ({
      ...current,
      nodes: current.nodes.filter(node => !gone.some(item => item.id === node.id)),
      edges: current.edges.filter(
        edge => !ids.includes(edge.id) && !ids.includes(edge.source) && !ids.includes(edge.target),
      ),
      frames: current.frames
        ?.filter(frame => !ids.includes(frame.id))
        .map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !ids.includes(id)) }))
        .filter(frame => frame.nodeIds.length),
    }));
    setSelection([]);
  };
  const renameAgent = (id: string, title: string) => {
    if (!title) return;
    checkpoint();
    setGraph(current => ({
      ...current,
      nodes: current.nodes.map(node =>
        node.id === id && node.type === "agent" ? { ...node, data: { ...node.data, title } } : node,
      ),
    }));
  };
  // Turning a wire one-way or two-way: one-way must not close a loop.
  const setKind = (edge: CanvasEdge, kind: CanvasEdge["kind"]) => {
    if (
      !kind &&
      makesLoop(
        graph.edges.filter(item => item.id !== edge.id),
        edge.source,
        edge.target,
      )
    ) {
      setNotice("One-way, that wire would make a loop: an agent can't wait for itself.");
      return;
    }
    setGraph(current => ({
      ...current,
      edges: current.edges.map(item =>
        item.id === edge.id ? { ...item, id: `${item.source}${kind ? "~" : "->"}${item.target}`, kind } : item,
      ),
    }));
  };
  const removeWire = (id: string) => {
    checkpoint();
    setGraph(current => ({ ...current, edges: current.edges.filter(edge => edge.id !== id) }));
    setMenu(null);
  };
  return { remove, removeWire, setKind, renameAgent, edit, commonFolders, setCommonFolders };
}

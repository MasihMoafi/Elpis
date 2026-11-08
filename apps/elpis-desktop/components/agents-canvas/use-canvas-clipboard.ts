import type { IsoPlace } from "@/lib/iso";
import { useRef } from "react";
import { useReactFlow, type XYPosition } from "@xyflow/react";
import { agentName, newId, type CanvasEdge, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";

export function useCanvasClipboard({
  graph,
  room,
  setNotice,
  limit,
  place,
  agents,
  isoBoxes,
  ISO_NODE,
  checkpoint,
  setGraph,
  setSelection,
  selection,
  pointer,
  flow,
}: {
  graph: CanvasGraph;
  room: number;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  limit: number;
  place: (
    near?: XYPosition,
    taken?: { x: number; y: number; w: number; h: number }[],
    size?: { w: number; h: number },
    closest?: boolean,
  ) => { x: number; y: number };
  agents: Extract<CanvasNode, { type: "agent" }>[];
  isoBoxes: (scene?: IsoPlace[]) => { x: number; y: number; w: number; h: number }[];
  ISO_NODE: { w: number; h: number; top: number };
  checkpoint: () => void;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  selection: string[];
  pointer: React.RefObject<XYPosition | null>;
  flow: ReturnType<typeof useReactFlow>;
}) {
  // The clipboard (Ctrl+C, Ctrl+V): agents and notes with the wires among them, pasted as new ones; Ctrl+D duplicates
  // without touching it. As in Blender and Node-RED, no wire joins a copy to an original.
  const clipboard = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] } | null>(null);
  const takeOut = (ids: string[]) => {
    const nodes = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)),
      kept = new Set(nodes.map(node => node.id));
    return {
      nodes,
      edges: graph.edges.filter(edge => kept.has(edge.source) && kept.has(edge.target)),
      frames: graph.frames?.filter(frame => frame.nodeIds.every(id => kept.has(id))),
    };
  };
  // Pasted where asked (the pointer, or where the menu opened); a duplicate takes the nearest free spot, never on top
  // of its original.
  const putIn = (
    clip: { nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] },
    at?: XYPosition,
  ) => {
    if (!clip.nodes.length) return;
    const count = clip.nodes.filter(node => node.type === "agent").length;
    if (count > room) {
      setNotice(
        `Only ${room} more ${room === 1 ? "agent fits" : "agents fit"} under the limit of ${limit}. Raise Max agents to add more.`,
      );
      return;
    }
    const left = Math.min(...clip.nodes.map(node => node.position.x)),
      top = Math.min(...clip.nodes.map(node => node.position.y)),
      origin = at ?? place({ x: left, y: top + 100 });
    const ids = new Map(clip.nodes.map(node => [node.id, newId(node.type)]));
    const taken = agents.map(node => node.data.title);
    const isoTaken = isoBoxes();
    const nodes = clip.nodes.map(node => {
      const title =
        node.type === "agent"
          ? agentName(taken, node.data.title.split(" · ").slice(1).join(" · ") || node.data.title)
          : "";
      if (title) taken.push(title);
      const slot = node.isoPosition
        ? place({ x: node.isoPosition.x - ISO_NODE.w / 2, y: node.isoPosition.y }, isoTaken, ISO_NODE)
        : undefined;
      if (slot) isoTaken.push({ ...slot, w: ISO_NODE.w, h: ISO_NODE.h });
      return {
        ...node,
        isoPosition: slot ? { x: slot.x + ISO_NODE.w / 2, y: slot.y + ISO_NODE.top } : undefined,
        id: ids.get(node.id)!,
        ...(node.type === "agent" ? { data: { ...node.data, title } } : {}),
        position: { x: Math.round(node.position.x - left + origin.x), y: Math.round(node.position.y - top + origin.y) },
      } as CanvasNode;
    });
    const edges = clip.edges.map(edge => ({
      ...edge,
      id: `${ids.get(edge.source)}->${ids.get(edge.target)}`,
      source: ids.get(edge.source)!,
      target: ids.get(edge.target)!,
    }));
    checkpoint();
    setGraph(current => ({
      ...current,
      nodes: [...current.nodes, ...nodes],
      edges: [...current.edges, ...edges],
      ...(clip.frames?.length
        ? {
            frames: [
              ...(current.frames ?? []),
              ...clip.frames.map(frame => ({
                ...frame,
                id: newId("frame"),
                nodeIds: frame.nodeIds.map(id => ids.get(id)!),
              })),
            ],
          }
        : {}),
    }));
    setSelection(nodes.map(node => node.id));
  };
  const copy = (ids = selection) => {
    const clip = takeOut(ids);
    if (clip.nodes.length) clipboard.current = clip;
  };
  const paste = (at?: XYPosition) => {
    if (clipboard.current)
      putIn(clipboard.current, at ?? (pointer.current ? flow.screenToFlowPosition(pointer.current) : undefined));
  };
  const duplicate = (ids = selection) => putIn(takeOut(ids));
  return { copy, clipboard, paste, duplicate };
}

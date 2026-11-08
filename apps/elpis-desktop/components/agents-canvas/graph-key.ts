import { type CanvasGraph } from "@/lib/canvas";

/** A board's structure, without positions: its agents and wires. */
export const shapeKey = (graph: CanvasGraph) =>
  `${graph.nodes
    .filter(node => node.type === "agent")
    .map(node => node.id)
    .join(",")}|${graph.edges.map(edge => `${edge.id}${edge.kind ?? ""}`).join(",")}`;

/** Measurements belong to the renderer, not to an undoable user edit. */
export const editKey = (graph: CanvasGraph) =>
  JSON.stringify({
    ...graph,
    nodes: graph.nodes.map(({ id, type, position, isoPosition, data }) => ({ id, type, position, isoPosition, data })),
  });

import { type XYPosition } from "@xyflow/react";
import { isoLayout } from "@/lib/iso";
import { COLUMN, FATHER, type CanvasGraph, type CanvasNode } from "@/lib/canvas";

export function canvasPlacement({ graph, order, split, agents }: {
  graph: CanvasGraph;
  order: Map<string, number>;
  split: { mother: string[]; father: string[]; };
  agents: Extract<CanvasNode, { type: "agent" }>[]
}) {
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
  return { place, boxes, NODE_W, NODE_H, isoBoxes, ISO_NODE, GAP, freeAt };
}
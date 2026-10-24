import type { CanvasEdge, CanvasGraph, CanvasNode } from "./canvas";

type Point = { x: number; y: number };
export type CanvasFrame = { id: string; title: string; nodeIds: string[] };

/** Walk a whole dependency branch once, including previous-round links, never alongside links. */
export function linkedIds(graph: CanvasGraph, ids: string[], direction: "upstream" | "downstream") {
  const found = new Set(ids), pending = [...ids];
  while (pending.length) {
    const id = pending.pop()!;
    for (const edge of graph.edges) {
      if (edge.kind === "alongside") continue;
      const next = direction === "upstream" ? edge.target === id && edge.source : edge.source === id && edge.target;
      if (next && !found.has(next)) { found.add(next); pending.push(next); }
    }
  }
  return [...found];
}

/** Extract only a single, unambiguous gap; the caller keeps the node and its new position. */
export function extractAgent(graph: CanvasGraph, id: string): CanvasGraph | null {
  const incident = graph.edges.filter(edge => edge.source === id || edge.target === id);
  const before = incident.filter(edge => edge.target === id), after = incident.filter(edge => edge.source === id);
  if (!incident.length || incident.some(edge => edge.kind || edge.feedback) || before.length > 1 || after.length > 1) return null;
  const edges = graph.edges.filter(edge => !incident.includes(edge));
  if (before[0] && after[0]) {
    const source = before[0].source, target = after[0].target;
    if (source === target || linkedIds({ ...graph, edges }, [target], "downstream").includes(source)) return null;
    if (!edges.some(edge => edge.source === source && edge.target === target)) edges.push({ ...after[0], id: `${source}->${target}`, source, target });
  }
  return { ...graph, edges };
}

/** Blender's eligible-node rule: one disconnected agent on one ordinary wire. */
export function insertAgent(graph: CanvasGraph, id: string, edge: CanvasEdge): CanvasGraph | null {
  if (!graph.nodes.some(node => node.id === id && node.type === "agent") || edge.kind || edge.feedback || edge.source === id || edge.target === id || graph.edges.some(wire => wire.source === id || wire.target === id)) return null;
  if (!graph.edges.some(wire => wire.id === edge.id)) return null;
  return { ...graph, edges: [...graph.edges.filter(wire => wire.id !== edge.id),
    { id: `${edge.source}->${id}`, source: edge.source, target: id }, { ...edge, id: `${id}->${edge.target}`, source: id }] };
}

export function frameBounds(nodes: CanvasNode[]) {
  const left = Math.min(...nodes.map(node => node.position.x)) - 24, top = Math.min(...nodes.map(node => node.position.y)) - 48;
  const right = Math.max(...nodes.map(node => node.position.x + ((node as { measured?: { width?: number } }).measured?.width ?? 210))) + 24;
  const bottom = Math.max(...nodes.map(node => node.position.y + ((node as { measured?: { height?: number } }).measured?.height ?? 96))) + 24;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function insidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Inclusive segment intersection, including a cutter that lands exactly on a wire. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

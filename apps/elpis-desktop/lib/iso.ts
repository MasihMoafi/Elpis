import type { CanvasGraph } from "@/lib/canvas";

/** The isometric view of the agents canvas (components/agents-iso.tsx), as Deus Ex's hacking screen draws its nodes:
 * the run-order layout on a ground plane, projected. Pure, so tests/agents-iso.test.mjs runs it under node. */

/** Ground units between waves (columns) and between the agents of one wave (rows). */
export const ISO_STEP = { column: 260, row: 180 };
const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6);
export type Point = { x: number; y: number };
export type Ground = { u: number; v: number };
export type Box = { left: number; top: number; right: number; bottom: number };

/** A ground point (u along the waves, v across them) on screen: both axes 30° off the horizontal, the waves running
 * right and down, a wave's rows left and down. `height` lifts the point straight up. */
export const project = (u: number, v: number, height = 0): Point => ({ x: (u - v) * COS, y: (u + v) * SIN - height });

export type IsoPlace = { id: string; kind: "mother" | "father" | "agent"; column: number; row: number; ground: Ground; at: Point };
/** The Mother and the agents in run order: the Mother in column 0, each agent in its wave's column (`waves` from
 * lib/canvas.ts), a wave's agents top to bottom as the flat board has them and centred on row 0. An agent on a loop
 * has no wave and stands in a column after the last one. Notes are not drawn. With agents past the Mother's ten
 * (lib/canvas.ts `parents`), the Father (`father`, his id) stands one row under her, as on the flat board. */
export function isoLayout(graph: Pick<CanvasGraph, "nodes">, waves: ReadonlyMap<string, number>, father?: string): IsoPlace[] {
  const last = Math.max(0, ...waves.values()), columns = new Map<number, CanvasGraph["nodes"]>();
  for (const node of graph.nodes) {
    if (node.type === "note") continue;
    const column = node.type === "mother" ? 0 : waves.get(node.id) ?? last + 1;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const places = [...columns].sort(([a], [b]) => a - b).flatMap(([column, nodes]) => nodes
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((node, index) => {
      const row = index - (nodes.length - 1) / 2, ground = { u: column * ISO_STEP.column, v: row * ISO_STEP.row };
      return { id: node.id, kind: node.type === "mother" ? "mother" as const : "agent" as const, column, row, ground, at: project(ground.u, ground.v) };
    }));
  if (!father) return places;
  const ground = { u: 0, v: ISO_STEP.row }, after = places.filter(place => place.column === 0).length;
  return [...places.slice(0, after), { id: father, kind: "father", column: 0, row: 1, ground, at: project(ground.u, ground.v) }, ...places.slice(after)];
}

/** A wire's way on the ground, as Deus Ex's grid lines run: along the waves, across them halfway to the next column,
 * then on into its agent. */
export function isoRoute(from: Ground, to: Ground): Ground[] {
  if (from.v === to.v) return [from, to];
  const turn = from.u + Math.min(ISO_STEP.column / 2, (to.u - from.u) / 2);
  return [from, { u: turn, v: from.v }, { u: turn, v: to.v }, to];
}

/** The zoom and offset that show `content` (screen units at zoom 1) whole and centred inside the view less its
 * insets, within the zoom limits. A point p is drawn at (x + zoom·p.x, y + zoom·p.y). */
export function isoFit(content: Box, view: { width: number; height: number }, inset: Box, limits = { min: 0.3, max: 1.2 }) {
  const width = Math.max(1, view.width - inset.left - inset.right), height = Math.max(1, view.height - inset.top - inset.bottom);
  const across = Math.max(1, content.right - content.left), down = Math.max(1, content.bottom - content.top);
  const zoom = Math.min(limits.max, Math.max(limits.min, Math.min(width / across, height / down)));
  return { zoom, x: inset.left + (width - zoom * across) / 2 - zoom * content.left, y: inset.top + (height - zoom * down) / 2 - zoom * content.top };
}

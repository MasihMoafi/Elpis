"use client";

import { type TaskStatus } from "@/lib/canvas";
import { type Box, type IsoPlace } from "@/lib/iso";
import type { Shape } from "./agents-iso";
import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { type Ref, type MouseEvent as ReactMouseEvent } from "react";
import { type AgentData, type CanvasEdge, type CanvasGraph } from "@/lib/canvas";
import { type Point } from "@/lib/iso";
import type { States, IsoController } from "./agents-iso";
import { type CSSProperties } from "react";
import { Textarea } from "@/components/ui/textarea";
import { FATHER, MOTHER, checkOf } from "@/lib/canvas";
import { project, type Ground } from "@/lib/iso";

/** The agents canvas's second view (components/agents-canvas.tsx): the graph as Deus Ex's hacking screen, for
 * watching, selecting and connecting agents. Settings and graph mutations are shared with the flat board.
 * Pedestals, wires and the ground are one SVG, projected by lib/iso.ts; titles and controls are flat HTML on top, so
 * text stays upright and legible at any zoom. */

export type State = TaskStatus | "idle";

export const shapeOf = (place: IsoPlace) => (place.kind === "agent" ? AGENT : PILLAR);

export const height = (shape: Shape) => shape.baseHeight + shape.coreHeight;

/** Room the fit leaves for the titles above the pedestals, at the sides, and for the controls along the bottom. */
export const INSET: Box = { left: 64, top: 48, right: 64, bottom: 100 };

export const FIT_ZOOM = { min: 0.08, max: 1.1 },
  ZOOM = { min: 0.08, max: 2.5 };

export type View = { zoom: number; x: number; y: number };

/** The screen box of everything drawn, at zoom 1: each pedestal's top, its plate and its ring. */
export function bounds(places: IsoPlace[]): Box {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const place of places) {
    const shape = shapeOf(place),
      ring = ellipse(shape.ring),
      across = Math.max(ring.rx, shape.plate * Math.cos(Math.PI / 6)),
      down = Math.max(ring.ry, shape.plate / 2);
    box.left = Math.min(box.left, place.at.x - across);
    box.right = Math.max(box.right, place.at.x + across);
    box.top = Math.min(box.top, place.at.y - shape.core / 2 - height(shape));
    box.bottom = Math.max(box.bottom, place.at.y + down);
  }
  return places.length ? box : { left: 0, top: 0, right: 1, bottom: 1 };
}

export const meet = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function textWidth(text: string, family: string) {
  const key = `${family}|${text}`;
  if (!widths.has(key)) {
    pen ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (pen) pen.font = `600 13px ${family}`;
    widths.set(key, pen ? pen.measureText(text).width : text.length * 7.5);
  }
  return widths.get(key)!;
}

/** A label's box on screen: its padding, border and badge around the title, at most its 176px, standing 8px above
 * the point given. */
export const LABEL = { max: 176, height: 24, gap: 8, chrome: 13, badge: 24 };

export let pen: CanvasRenderingContext2D | null | undefined;

export type Props = {
  workflowIdentity?: WorkflowIdentity | undefined;
  inserting: string | null;
  canConnect: (source: string, target: string, ignored?: string | null, alongside?: boolean) => boolean;
  onReconnect: (edge: CanvasEdge, source: string, target: string) => void;
  renamingFrame: string | null;
  onFrameName: (id: string, title: string | null) => void;
  onNoteText: (id: string, text: string) => void;
  onMoveStart: (id: string, extract: boolean) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onMoveEnd: (shift: boolean, cancel?: boolean) => void;
  onMovePreview: (id: string) => void;
  modelLabel: (data: AgentData) => string;
  controller: Ref<IsoController>;
  onConnect: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
  onAdd: (at: Point, id?: string, end?: "source" | "target") => void;
  onCommand: (at: Point, id: string, end: "source" | "target") => void;
  onNodeMenu: (event: ReactMouseEvent, id: string) => void;
  onBoardMenu: (event: ReactMouseEvent) => void;
  onWireMenu: (event: ReactMouseEvent, edge: CanvasEdge) => void;
  onWireClick: (event: ReactMouseEvent, edge: CanvasEdge) => void;
  onRename: (id: string, title: string) => void;
  graph: CanvasGraph;
  father: string[];
  states: States;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onOpen: (id: string) => void;
  dark: boolean;
};

export const AGENT: Shape = { base: 64, baseHeight: 10, core: 36, coreHeight: 30, ring: 50, plate: 84 };

export const PILLAR: Shape = { base: 72, baseHeight: 12, core: 40, coreHeight: 86, ring: 56, plate: 94 };

/** A ground circle of radius r is this ellipse on screen. */
export const ellipse = (r: number) => ({ rx: r * Math.sqrt(1.5), ry: r * Math.SQRT1_2 });

/** A title's width in the label's font (13px semibold), measured once per text. */
export const widths = new Map<string, number>();

/** A note's text, the same field on both views. */
export function NoteText({ text, onText }: { text: string; onText: (text: string) => void }) {
  return (
    <Textarea
      aria-label="Note"
      className="nodrag"
      value={text}
      placeholder="Write a note"
      onChange={event => onText(event.target.value)}
    />
  );
}

export const xy = (point: Point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;

/** A square of `side` on the ground around `ground`, lifted to `z`: its back, right, front and left corners. */
export const square = (ground: Ground, side: number, z = 0): [Point, Point, Point, Point] => {
  const corner = (du: number, dv: number) => project(ground.u + (du * side) / 2, ground.v + (dv * side) / 2, z);
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
};

export const points = (list: Point[]) => list.map(xy).join(" ");

/** Routes always have at least two points. */
export function longestSpan(route: [Ground, Ground, ...Ground[]]): [Ground, Ground] {
  let from = route[0],
    to = route[1],
    previous = to,
    length = Math.hypot(to.u - from.u, to.v - from.v);
  for (let index = 2; index < route.length; index++) {
    const next = route[index];
    if (!next) continue;
    const span = Math.hypot(next.u - previous.u, next.v - previous.v);
    if (span > length) {
      from = previous;
      to = next;
      length = span;
    }
    previous = next;
  }
  return [from, to];
}

/** A block on the ground: its two lit sides and its top. */
export function Prism({
  ground,
  side,
  bottom,
  top,
  className,
}: {
  ground: Ground;
  side: number;
  bottom: number;
  top: number;
  className: string;
}) {
  const [back, right, front, left] = square(ground, side, top),
    [, rightLow, frontLow, leftLow] = square(ground, side, bottom);
  return (
    <g className={className}>
      <polygon className="iso-face-left" points={points([left, front, frontLow, leftLow])} />
      <polygon className="iso-face-right" points={points([front, right, rightLow, frontLow])} />
      <polygon className="iso-face-top" points={points([back, right, front, left])} />
    </g>
  );
}

/** A wire's state, as the flat board colours it: live once its first agent's check passed and the second runs (a
 * Mother's or the Father agent's wire once its agent runs), done once that check passed, cut when it failed or the second
 * is blocked. A two-way wire sets no order, so it carries none. */
export function wireState({ source, target, kind }: CanvasEdge, states: States) {
  const to = states[target]?.status;
  if (kind === "alongside") return undefined;
  if (source === MOTHER || source === FATHER) return to === "running" ? "live" : undefined;
  const from = states[checkOf(source)]?.status;
  return from === "failed" || to === "blocked"
    ? "cut"
    : from === "succeeded" && to === "running"
      ? "live"
      : from === "succeeded"
        ? "done"
        : undefined;
}

/** Three chevrons flat on the ground on a wire's longest stretch, pointing the way the work flows, as on Deus Ex's
 * hacking screen; they stream along it while the wire is live. */
export function Chevrons({ route, live }: { route: [Ground, Ground, ...Ground[]]; live: boolean }) {
  const [from, to] = longestSpan(route),
    length = Math.hypot(to.u - from.u, to.v - from.v) || 1;
  const way = { u: (to.u - from.u) / length, v: (to.v - from.v) / length };
  const local = (along: number, side: number) => project(way.u * along - way.v * side, way.v * along + way.u * side);
  const start = project(from.u, from.v),
    end = project(to.u, to.v),
    dx = end.x - start.x,
    dy = end.y - start.y;
  const px = (value: number) => `${value.toFixed(1)}px`;
  return (
    <g transform={`translate(${xy(start)})`}>
      {[0.38, 0.5, 0.62].map((at, index) => (
        <path
          key={at}
          className="iso-chevron"
          data-live={live || undefined}
          d={`M ${xy(local(-8, -11))} L ${xy(local(6, 0))} L ${xy(local(-8, 11))}`}
          style={
            {
              "--x": px(dx * at),
              "--y": px(dy * at),
              "--sx": px(dx * 0.2),
              "--sy": px(dy * 0.2),
              "--ex": px(dx * 0.8),
              "--ey": px(dy * 0.8),
              animationDelay: `${-index * 0.6}s`,
            } as CSSProperties
          }
        />
      ))}
    </g>
  );
}

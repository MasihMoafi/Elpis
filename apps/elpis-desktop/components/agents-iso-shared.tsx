"use client";

import { type TaskStatus } from "@/lib/canvas";
import { type Box, type IsoPlace } from "@/lib/iso";
import type { Shape } from "./agents-iso";
import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { type Ref, type MouseEvent as ReactMouseEvent } from "react";
import { type AgentData, type CanvasEdge, type CanvasGraph } from "@/lib/canvas";
import { type Point } from "@/lib/iso";
import type { States, IsoController } from "./agents-iso";

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

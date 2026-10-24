"use client";

import { Segmented } from "@/components/settings/rows";
import { useEffect, useId, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { agentColor, CHECK_LABEL as CHECK, FATHER, MOTHER, STATUS_LABEL as STATUS, checkOf, waits, waves, type AgentData, type CanvasEdge, type CanvasGraph, type TaskStatus } from "@/lib/canvas";
import { ISO_STEP, isoFit, isoLayout, isoRoute, project, type Box, type Ground, type IsoPlace, type Point } from "@/lib/iso";

/** The agents canvas's second view (components/agents-canvas.tsx): the graph as Deus Ex's hacking screen, for
 * watching, selecting and connecting agents. Settings and graph mutations are shared with the flat board.
 * Pedestals, wires and the ground are one SVG, projected by lib/iso.ts; titles and controls are flat HTML on top, so
 * text stays upright and legible at any zoom. */

type State = TaskStatus | "idle";

/** A pedestal in ground units: the slab, the block standing on it, the ring of its check and the plate a selection
 * or focus lights around it. The Mother and the Father are taller pillars. */
type Shape = { base: number; baseHeight: number; core: number; coreHeight: number; ring: number; plate: number };
const AGENT: Shape = { base: 64, baseHeight: 10, core: 36, coreHeight: 30, ring: 50, plate: 84 };
const PILLAR: Shape = { base: 72, baseHeight: 12, core: 40, coreHeight: 86, ring: 56, plate: 94 };
const shapeOf = (place: IsoPlace) => place.kind === "agent" ? AGENT : PILLAR;
const height = (shape: Shape) => shape.baseHeight + shape.coreHeight;
/** A ground circle of radius r is this ellipse on screen. */
const ellipse = (r: number) => ({ rx: r * Math.sqrt(1.5), ry: r * Math.SQRT1_2 });
/** Room the fit leaves for the titles above the pedestals, at the sides, and for the controls along the bottom. */
const INSET: Box = { left: 64, top: 48, right: 64, bottom: 100 };
const FIT_ZOOM = { min: 0.08, max: 1.1 }, ZOOM = { min: 0.08, max: 2.5 };
type View = { zoom: number; x: number; y: number };

const xy = (point: Point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
/** A square of `side` on the ground around `ground`, lifted to `z`: its back, right, front and left corners. */
const square = (ground: Ground, side: number, z = 0) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([du, dv]) => project(ground.u + du * side / 2, ground.v + dv * side / 2, z));
const points = (list: Point[]) => list.map(xy).join(" ");

/** The screen box of everything drawn, at zoom 1: each pedestal's top, its plate and its ring. */
function bounds(places: IsoPlace[]): Box {
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const place of places) {
    const shape = shapeOf(place), ring = ellipse(shape.ring), across = Math.max(ring.rx, shape.plate * Math.cos(Math.PI / 6)), down = Math.max(ring.ry, shape.plate / 2);
    box.left = Math.min(box.left, place.at.x - across); box.right = Math.max(box.right, place.at.x + across);
    box.top = Math.min(box.top, place.at.y - shape.core / 2 - height(shape)); box.bottom = Math.max(box.bottom, place.at.y + down);
  }
  return places.length ? box : { left: 0, top: 0, right: 1, bottom: 1 };
}

const meet = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** A title's width in the label's font (13px semibold), measured once per text. */
const widths = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, family: string) {
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
const LABEL = { max: 176, height: 24, gap: 8, chrome: 13, badge: 24 };

/** A block on the ground: its two lit sides and its top. */
function Prism({ ground, side, bottom, top, className }: { ground: Ground; side: number; bottom: number; top: number; className: string }) {
  const [back, right, front, left] = square(ground, side, top), [, rightLow, frontLow, leftLow] = square(ground, side, bottom);
  return <g className={className}>
    <polygon className="iso-face-left" points={points([left, front, frontLow, leftLow])} />
    <polygon className="iso-face-right" points={points([front, right, rightLow, frontLow])} />
    <polygon className="iso-face-top" points={points([back, right, front, left])} />
  </g>;
}

type States = Record<string, { status: TaskStatus }>;
/** A wire's state, as the flat board colours it: live once its first agent's check passed and the second runs (a
 * Mother's or the Father's wire once its agent runs), done once that check passed, cut when it failed or the second
 * is blocked. A two-way wire sets no order, so it carries none. */
function wireState({ source, target, kind }: CanvasEdge, states: States) {
  const to = states[target]?.status;
  if (kind === "alongside") return undefined;
  if (source === MOTHER || source === FATHER) return to === "running" ? "live" : undefined;
  const from = states[checkOf(source)]?.status;
  return from === "failed" || to === "blocked" ? "cut" : from === "succeeded" && to === "running" ? "live" : from === "succeeded" ? "done" : undefined;
}

/** Three chevrons flat on the ground on a wire's longest stretch, pointing the way the work flows, as on Deus Ex's
 * hacking screen; they stream along it while the wire is live. */
function Chevrons({ route, live }: { route: Ground[]; live: boolean }) {
  const span = (index: number) => Math.hypot(route[index].u - route[index - 1].u, route[index].v - route[index - 1].v);
  let longest = 1;
  for (let index = 2; index < route.length; index++) if (span(index) > span(longest)) longest = index;
  const from = route[longest - 1], to = route[longest], length = span(longest) || 1;
  const way = { u: (to.u - from.u) / length, v: (to.v - from.v) / length };
  const local = (along: number, side: number) => project(way.u * along - way.v * side, way.v * along + way.u * side);
  const start = project(from.u, from.v), end = project(to.u, to.v), dx = end.x - start.x, dy = end.y - start.y;
  const px = (value: number) => `${value.toFixed(1)}px`;
  return <g transform={`translate(${xy(start)})`}>
    {[0.38, 0.5, 0.62].map((at, index) => <path key={at} className="iso-chevron" data-live={live || undefined} d={`M ${xy(local(-8, -11))} L ${xy(local(6, 0))} L ${xy(local(-8, 11))}`}
      style={{ "--x": px(dx * at), "--y": px(dy * at), "--sx": px(dx * 0.2), "--sy": px(dy * 0.2), "--ex": px(dx * 0.8), "--ey": px(dy * 0.8), animationDelay: `${-index * 0.6}s` } as CSSProperties} />)}
  </g>;
}

/** The header's switch between the flat board and this isometric view. */
export function ViewToggle({ iso, onChange }: { iso: boolean; onChange: (iso: boolean) => void }) {
  return <Segmented label="Workflows view" className="canvas-view" value={iso ? "iso" : "flat"} onChange={value => onChange(value === "iso")} options={[
    { value: "flat", label: "Flat", title: "Edit the graph: drag, wire and add agents" },
    { value: "iso", label: "Isometric", title: "Select and connect agents on the isometric board; Enter opens the selected agent" }]} />;
}

/** `father`: the agents past the Mother's ten, which the Father runs (lib/canvas.ts `parents`). */
export type IsoController = { fit: () => void; frame: () => void; cancelGesture: () => boolean; zoom: (factor: number) => void; reveal: (ids: string[]) => void; position: (client: Point) => Point; keepView: () => void };
type Props = { inserting: string | null; canConnect: (source: string, target: string, ignored?: string | null, alongside?: boolean) => boolean; onReconnect: (edge: CanvasEdge, source: string, target: string) => void; minimap: boolean; renamingFrame: string | null; onFrameName: (id: string, title: string | null) => void; onNoteText: (id: string, text: string) => void; onMoveStart: (id: string, extract: boolean) => void; onMove: (id: string, dx: number, dy: number) => void; onMoveEnd: (shift: boolean, cancel?: boolean) => void; onMovePreview: (id: string) => void; modelLabel: (data: AgentData) => string; controller: Ref<IsoController>; onConnect: (source: string, target: string, kind?: CanvasEdge["kind"]) => void; onAdd: (at: Point, id?: string, end?: "source" | "target") => void; onCommand: (at: Point, id: string, end: "source" | "target") => void; onNodeMenu: (event: ReactMouseEvent, id: string) => void; onBoardMenu: (event: ReactMouseEvent) => void; onWireMenu: (event: ReactMouseEvent, edge: CanvasEdge) => void; onWireClick: (event: ReactMouseEvent, edge: CanvasEdge) => void; onRename: (id: string, title: string) => void; graph: CanvasGraph; father: string[]; states: States; selected: string[]; onSelect: (ids: string[]) => void; onOpen: (id: string) => void; dark: boolean };
/** The isometric board: the Mother (and the Father) and each agent on a pedestal in run order, wires on the ground. A click selects
 * (Shift adds), a double-click renames an agent and Enter opens Info, the arrows move between agents in run order.
 * The parent owns window/crossing selection in both views; middle-drag and scroll pan, Ctrl/Cmd+scroll zooms. */
export function IsoBoard({ inserting, canConnect, onReconnect, minimap, renamingFrame, onFrameName, onNoteText, onMoveStart, onMove, onMoveEnd, onMovePreview, graph, father, states, selected, onSelect, onOpen, dark, modelLabel, controller, onConnect, onAdd, onCommand, onNodeMenu, onBoardMenu, onWireMenu, onWireClick, onRename }: Props) {
  const root = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, SVGGElement>());
  const blur = `iso-blur-${useId().replace(/[^\w-]/g, "")}`;
  const wave = useMemo(() => waves(graph), [graph]);
  const fathered = father.length > 0, his = new Set(father);
  const places = useMemo(() => isoLayout(graph, wave, fathered ? FATHER : undefined), [graph, wave, fathered]);
  const content = useMemo(() => {
    const box = bounds(places);
    for (const node of graph.nodes) if (node.type === "note") { const at = node.isoPosition ?? node.position; box.left = Math.min(box.left, at.x); box.top = Math.min(box.top, at.y); box.right = Math.max(box.right, at.x + 200); box.bottom = Math.max(box.bottom, at.y + 110); }
    return box;
  }, [places, graph.nodes]);
  const byId = new Map(places.map(place => [place.id, place])), nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const order = places.map(place => place.id), agents = places.filter(place => place.kind === "agent");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null), [family, setFamily] = useState("sans-serif");
  // The user's own zoom and pan, kept for the layout it was made on: a new layout (an agent added, an architecture
  // loaded) is fitted again.
  const layout = places.map(place => `${place.id}@${place.at.x},${place.at.y}`).join(" ");
  const [moved, setMoved] = useState<{ layout: string; view: View } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null), [focused, setFocused] = useState<string | null>(null), [focusId, setFocusId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = (id: string) => { if (nodes.get(id)?.type === "agent") { onSelect([id]); setRenaming(id); } };
  const [wireDrag, setWireDrag] = useState<{ id: string; end: "source" | "target"; from: Point; to: Point; edge?: CanvasEdge; alongside?: boolean } | null>(null);
  const movingNode = useRef<{ id: string; x: number; y: number; moved: boolean; alt: boolean } | null>(null), suppressClick = useRef(false);
  const drag = useRef<{ x: number; y: number; from: View; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure(); setFamily(getComputedStyle(element).fontFamily);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const view: View = ((moved?.layout === layout || moved?.layout === "free") ? moved.view : null) ?? (size ? isoFit(content, size, INSET, FIT_ZOOM) : { zoom: 1, x: 0, y: 0 });
  useLayoutEffect(() => {
    if (moved?.layout === "free") setMoved({ layout, view: moved.view });
  }, [layout, moved]);
  const move = (next: View) => setMoved({ layout, view: next });
  useImperativeHandle(controller, () => ({ position: client => {
    const box = root.current!.getBoundingClientRect();
    return { x: (client.x - box.left - view.x) / view.zoom, y: (client.y - box.top - view.y) / view.zoom };
  }, reveal: ids => {
    const picked = places.filter(place => ids.includes(place.id));
    if (!size || !picked.length) return;
    const box = bounds(picked);
    if (view.x + view.zoom * box.left < INSET.left || view.x + view.zoom * box.right > size.width - INSET.right || view.y + view.zoom * box.top < INSET.top || view.y + view.zoom * box.bottom > size.height - INSET.bottom) move(isoFit(box, size, INSET, { min: ZOOM.min, max: view.zoom }));
  }, cancelGesture: () => { if (!wireDrag) return false; setWireDrag(null); return true; }, zoom: factor => zoomBy(factor ? factor : 1 / view.zoom), keepView: () => setMoved({ layout: "free", view }), fit: () => setMoved(null), frame: () => {
    const picked = places.filter(place => selected.includes(place.id));
    if (size && picked.length) move(isoFit(bounds(picked), size, INSET, { min: ZOOM.min, max: 1.5 }));
  } }));
  const zoomBy = (factor: number, at: Point = { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 }) => {
    const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, view.zoom * factor)), scale = zoom / view.zoom;
    move({ zoom, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale });
  };
  // The wheel zooms about the pointer; React's wheel listener is passive, so it can't keep the page from scrolling.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest(".iso-hud, input, textarea")) return;
      event.preventDefault(); const box = element.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
      if (event.ctrlKey || event.metaKey) zoomBy(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - box.left, y: event.clientY - box.top });
      else move({ ...view, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  });

  // Each parent runs while any of her (his) agents or their checks does.
  const hisTasks = new Set(father.flatMap(id => [id, checkOf(id)]));
  const partState = (mine: boolean): State => {
    const tasks = Object.entries(states).filter(([id]) => hisTasks.has(id) === !mine).map(([, task]) => task.status);
    return !tasks.length ? "idle" : tasks.some(status => status === "running" || status === "pending") ? "running" : tasks.some(status => status === "failed" || status === "blocked") ? "failed" : "succeeded";
  };
  const motherState = partState(true), fatherState = partState(false);
  const statusOf = (id: string): State => id === MOTHER ? motherState : id === FATHER ? fatherState : states[id]?.status ?? "idle";
  const titleOf = (id: string) => { const node = nodes.get(id); return id === MOTHER ? "Mother" : id === FATHER ? "Father" : node?.type === "agent" ? node.data.title || "Untitled" : id; };
  const count = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
  const parentLine = (id: string) => id === MOTHER ? ["This run's chat", count(agents.length), STATUS[motherState]] : ["His own chat", count(father.length), fatherState === "idle" ? "after her part" : STATUS[fatherState]];
  const describe = (id: string) => id === MOTHER || id === FATHER ? parentLine(id).join(", ").replace(/^./, letter => letter.toLowerCase())
    : `${wave.has(id) ? `wave ${wave.get(id)}` : "no wave"}, ${nodes.get(id)?.type === "agent" && (nodes.get(id)!.data as AgentData).muted ? "muted, skipped in runs" : STATUS[statusOf(id)]}, ${CHECK[statusOf(checkOf(id))].toLowerCase()}`;
  const wires: CanvasEdge[] = [
    // The parents' wires, as on the flat board: the Mother starts her agents of the first wave; the Father starts his
    // agents that wait for none of his others.
    ...agents.filter(place => wave.get(place.id) === 1 && !his.has(place.id)).map(place => ({ id: `${MOTHER}->${place.id}`, source: MOTHER, target: place.id })),
    ...agents.filter(place => his.has(place.id) && !graph.edges.some(edge => waits(edge) && edge.target === place.id && his.has(edge.source))).map(place => ({ id: `${FATHER}->${place.id}`, source: FATHER, target: place.id })),
    ...graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)),
  ];
  const motherWires = wires.filter(wire => wire.source === MOTHER), motherPlace = byId.get(MOTHER);
  const junction = motherPlace ? { u: motherPlace.ground.u + ISO_STEP.column / 2, v: motherPlace.ground.v } : null;
  const routeOf = (wire: CanvasEdge) => {
    const to = byId.get(wire.target)!.ground;
    return wire.source === MOTHER && junction ? [junction, { u: junction.u, v: to.v }, to] : isoRoute(byId.get(wire.source)!.ground, to);
  };

  // One agent is in the tab order (the last focused, else the selected, else the Mother); the arrows walk the rest.
  const tabbable = focusId && byId.has(focusId) ? focusId : selected.find(id => byId.has(id)) ?? order[0];
  const hot = hovered ?? focused;
  const subject = hot ?? (selected.length === 1 && byId.has(selected[0]) ? selected[0] : null);
  const pick = (id: string, add: boolean) => { setFocusId(id); onSelect(add && id !== FATHER ? (selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]) : [id]); };
  const open = (id: string) => { pick(id, false); if (byId.get(id)?.kind === "agent") onOpen(id); };
  const screen = (point: Point) => ({ x: view.x + view.zoom * point.x, y: view.y + view.zoom * point.y });
  // An agent reached by the keys is brought into view.
  const reveal = (id: string) => {
    const place = byId.get(id);
    if (!place || !size) return;
    const at = screen(place.at);
    if (at.x < INSET.left || at.x > size.width - INSET.right || at.y < INSET.top || at.y > size.height - INSET.bottom) move({ ...view, x: view.x + size.width / 2 - at.x, y: view.y + size.height / 2 - at.y });
  };
  const keys = (event: ReactKeyboardEvent, id: string) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); open(id); }
  };

  // The ground: a plate under the graph with a grid offset from the agents, so each stands in a cell.
  const us = places.map(place => place.ground.u), vs = places.map(place => place.ground.v);
  const u0 = Math.min(0, ...us) - ISO_STEP.column * 0.75, u1 = Math.max(0, ...us) + ISO_STEP.column * 0.75, v0 = Math.min(0, ...vs) - ISO_STEP.row * 0.75, v1 = Math.max(0, ...vs) + ISO_STEP.row * 0.75;
  const grid: [Point, Point][] = [];
  for (let u = u0 + ISO_STEP.column / 4; u < u1; u += ISO_STEP.column / 2) grid.push([project(u, v0), project(u, v1)]);
  for (let v = v0 + ISO_STEP.row / 4; v < v1; v += ISO_STEP.row / 2) grid.push([project(u0, v), project(u1, v)]);
  // Nearer pedestals are drawn over farther ones.
  const painted = [...places].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
  // Each title stands upright above its pedestal. Where the graph is dense, a title that would cover another title or
  // another agent's block shows only its wave badge, until it is pointed at, focused or selected, or zoomed into room;
  // the Mother's and those always show in full.
  const anchor = (place: IsoPlace) => { const shape = shapeOf(place); return screen({ x: place.at.x, y: place.at.y - shape.core / 2 - height(shape) }); };
  const block = (place: IsoPlace): Box => { const shape = shapeOf(place), top = anchor(place), half = shape.core * Math.cos(Math.PI / 6) * view.zoom; return { left: top.x - half, top: top.y, right: top.x + half, bottom: screen({ x: place.at.x, y: place.at.y - shape.baseHeight }).y }; };
  const kept = (place: IsoPlace) => place.kind !== "agent" || place.id === hot || selected.includes(place.id);
  const full = new Set<string>(), taken: Box[] = [], labelPositions = new Map<string, Point>();
  const labelBox = (at: Point, width: number, labelHeight = LABEL.height): Box => ({ left: at.x - width / 2, top: at.y - labelHeight, right: at.x + width / 2, bottom: at.y });
  const labelAt = (place: IsoPlace, width: number, labelHeight = LABEL.height) => {
    const at = anchor(place);
    return { x: Math.max(width / 2 + 6, Math.min((size?.width ?? Infinity) - width / 2 - 6, at.x)), y: Math.max(labelHeight + 6, Math.min((size?.height ?? Infinity) - INSET.bottom, at.y - LABEL.gap)) };
  };
  for (const place of [...places].sort((a, b) => Number(kept(b)) - Number(kept(a)))) {
    const width = renaming === place.id ? LABEL.max : Math.min(LABEL.max, textWidth(titleOf(place.id), family) + LABEL.chrome + (place.kind === "agent" ? LABEL.badge : 5));
    const labelHeight = renaming === place.id ? 36 : LABEL.height;
    let at = labelAt(place, width, labelHeight), box = labelBox(at, width, labelHeight);
    if (place.id === hot || (selected.length === 1 && selected.includes(place.id)) || (!taken.some(other => meet(other, box)) && !places.some(other => other !== place && meet(block(other), box)))) full.add(place.id);
    else if (place.kind === "agent") {
      at = labelAt(place, LABEL.badge, labelHeight); box = labelBox(at, LABEL.badge, labelHeight);
    } else full.add(place.id);
    const usedWidth = full.has(place.id) ? width : LABEL.badge;
    // A dense graph keeps wave badges; if even those meet, move a label to the nearest free row.
    const original = at;
    const collides = () => taken.some(other => meet(other, box)) || places.some(other => meet(block(other), box));
    for (let step = 0; collides() && step < 60; step++) {
      const offset = (Math.floor(step / 2) + 1) * (labelHeight + 4) * (step % 2 ? 1 : -1);
      const y = original.y + offset;
      if (y < labelHeight + 6 || y > (size?.height ?? Infinity) - INSET.bottom) continue;
      at = { ...original, y }; box = labelBox(at, usedWidth, labelHeight);
    }
    // A short board may have no free row above this pedestal. Use the nearest free slot to either side instead of
    // leaving a badge on its own block, where it would intercept the block's mouse and keyboard interactions.
    if (collides() && size) {
      const xs = [original.x], ys = [original.y];
      for (let x = usedWidth / 2 + 6; x <= size.width - usedWidth / 2 - 6; x += usedWidth + 8) xs.push(x);
      for (let y = labelHeight + 6; y <= size.height - INSET.bottom; y += labelHeight + 4) ys.push(y);
      const slots = ys.flatMap(y => xs.map(x => ({ x, y }))).sort((a, b) => Math.hypot(a.x - original.x, a.y - original.y) - Math.hypot(b.x - original.x, b.y - original.y));
      const free = slots.find(slot => { const box = labelBox(slot, usedWidth, labelHeight); return !taken.some(other => meet(other, box)) && !places.some(other => meet(block(other), box)); });
      if (free) { at = free; box = labelBox(at, usedWidth, labelHeight); }
    }
    taken.push(box); labelPositions.set(place.id, at);
  }
  const subjectPlace = subject ? byId.get(subject) : undefined;
  const subjectNode = subjectPlace ? nodes.get(subjectPlace.id) : undefined;
  const subjectModel = subjectNode?.type === "agent" ? `${modelLabel(subjectNode.data)}${subjectNode.data.effort ? ` · ${subjectNode.data.effort} thinking` : ""}` : null;

  return <div ref={root} className="iso-board" role="region" aria-label="Isometric board" tabIndex={-1} data-panning={panning || undefined}
    onDoubleClick={event => { if (!(event.target as Element).closest(".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame")) onAdd({ x: event.clientX, y: event.clientY }); }}
    onContextMenu={event => { if (!(event.target as Element).closest(".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame")) onBoardMenu(event); }}
    onPointerDown={event => {
      if (event.button !== 1 || (event.target as Element).closest(".iso-hud, .iso-port, .iso-label, .iso-link, .iso-flow-label, input, textarea")) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { x: event.clientX, y: event.clientY, from: view, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onKeyDown={event => { if (event.key === "Escape") { setWireDrag(null); if (movingNode.current?.moved) onMoveEnd(false, true); movingNode.current = null; } }}
    onPointerMove={event => {
      const moving = movingNode.current;
      if (moving) {
        const dx = (event.clientX - moving.x) / view.zoom, dy = (event.clientY - moving.y) / view.zoom;
        if (!moving.moved && Math.hypot(event.clientX - moving.x, event.clientY - moving.y) < 5) return;
        if (!moving.moved) { onMoveStart(moving.id, moving.alt); moving.moved = true; suppressClick.current = true; event.currentTarget.setPointerCapture(event.pointerId); }
        onMove(moving.id, Math.round(dx / 20) * 20, Math.round(dy / 20) * 20); onMovePreview(moving.id); return;
      }
      if (wireDrag) { const box = event.currentTarget.getBoundingClientRect(); setWireDrag({ ...wireDrag, to: { x: event.clientX - box.left, y: event.clientY - box.top } }); return; }
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true; setPanning(true); move({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
    }}
    onPointerUp={event => {
      if (movingNode.current) { if (movingNode.current.moved) onMoveEnd(event.shiftKey); movingNode.current = null; setTimeout(() => { suppressClick.current = false; }); }
      if (wireDrag) {
        const hit = document.elementFromPoint(event.clientX, event.clientY), port = hit?.closest<HTMLElement>(".iso-port"), node = hit?.closest<SVGGElement>(".iso-node");
        const over = port?.dataset.node ?? node?.dataset.id;
        const from = wireDrag; setWireDrag(null);
        const box = event.currentTarget.getBoundingClientRect(), distance = Math.hypot(event.clientX - box.left - from.from.x, event.clientY - box.top - from.from.y);
        if (from.edge) { if (over && over !== from.id && (!port || port.dataset.end !== from.end)) onReconnect(from.edge, ...(from.end === "source" ? [from.id, over] as const : [over, from.id] as const)); return; }
        if (over === from.id && distance < 8) { onCommand({ x: event.clientX, y: event.clientY }, from.id, from.end); return; }
        if (over && over !== from.id && (!port || port.dataset.end !== from.end)) onConnect(...(from.end === "source" ? [from.id, over] as const : [over, from.id] as const), event.altKey ? "alongside" : undefined);
        else if (!over && hit && root.current?.contains(hit) && !hit.closest(".iso-hud, .iso-label, .iso-link, .iso-flow-label")) {
          if (distance >= 8) onAdd({ x: event.clientX, y: event.clientY }, from.id, from.end);
        }
        return;
      }
      drag.current = null; setPanning(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { if (movingNode.current?.moved) onMoveEnd(false, true); movingNode.current = null; drag.current = null; setPanning(false); setWireDrag(null); }}
    onPointerCancel={() => { if (movingNode.current?.moved) onMoveEnd(false, true); movingNode.current = null; drag.current = null; setPanning(false); setWireDrag(null); }}>
    <svg role="group" aria-label="Agents in run order">
      <defs><filter id={blur} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation={dark ? 11 : 7} /></filter></defs>
      <g className="iso-world" transform={`translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.zoom.toFixed(4)})`}>
        <polygon className="iso-floor" points={points([project(u0, v0), project(u1, v0), project(u1, v1), project(u0, v1)])} />
        <g className="iso-grid">{grid.map(([a, b], index) => <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)}</g>
        {places.map(place => { const glow = ellipse(shapeOf(place).ring * 1.15); return <ellipse key={place.id} className="iso-glow" data-status={statusOf(place.id)} filter={`url(#${blur})`} cx={place.at.x} cy={place.at.y} rx={glow.rx} ry={glow.ry} />; })}
        {motherPlace && junction && motherWires[0] && <g className="iso-link iso-mother-trunk" data-mother="true" onClick={event => onWireClick(event, motherWires[0])} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onWireMenu(event, motherWires[0]); }}>
          <path className="iso-wire-hit" d={`M ${xy(motherPlace.at)} L ${xy(project(junction.u, junction.v))}`} />
          <path className="iso-wire" d={`M ${xy(motherPlace.at)} L ${xy(project(junction.u, junction.v))}`} />
          <Chevrons route={[motherPlace.ground, junction]} live={motherWires.some(wire => wireState(wire, states) === "live")} />
        </g>}
        {wires.map(wire => {
          const route = routeOf(wire), path = `M ${route.map(point => xy(project(point.u, point.v))).join(" L ")}`, state = wireState(wire, states);
          return <g key={wire.id} className="iso-link" data-inserting={inserting === wire.id || undefined} data-id={wire.id} onClick={event => onWireClick(event, wire)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onWireMenu(event, wire); }} data-state={state} data-kind={wire.kind} data-mother={wire.source === MOTHER || undefined} data-father={wire.source === FATHER || undefined} data-hot={(hot && (wire.source === hot || wire.target === hot)) || undefined}>
            <path className="iso-wire-hit" d={path} /><path className="iso-wire-bed" d={path} /><path className="iso-wire" d={path} />{waits(wire) && wire.source !== MOTHER && <Chevrons route={route} live={state === "live"} />}
          </g>;
        })}
        {painted.map(place => {
          const shape = shapeOf(place), ring = ellipse(shape.ring), pillar = place.kind !== "agent";
          return <g key={place.id} ref={element => { if (element) buttons.current.set(place.id, element); else buttons.current.delete(place.id); }}
            className="iso-node" style={place.kind === "agent" ? { "--agent-color": agentColor(place.id, nodes.get(place.id)!.data as AgentData) } as CSSProperties : undefined} data-id={place.id} data-kind={place.kind} data-muted={nodes.get(place.id)?.type === "agent" && (nodes.get(place.id)!.data as AgentData).muted || undefined} data-status={statusOf(place.id)} data-hot={hot === place.id || undefined}
            role="button" tabIndex={tabbable === place.id ? 0 : -1} aria-pressed={selected.includes(place.id)} aria-label={`${titleOf(place.id)}: ${describe(place.id)}`}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onNodeMenu(event, place.id); }} onClick={event => { if (!suppressClick.current) pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey); }} onDoubleClick={() => open(place.id)} onKeyDown={event => keys(event, place.id)}
            onPointerDown={event => { if (event.button !== 0 || place.kind !== "agent") return; movingNode.current = { id: place.id, x: event.clientX, y: event.clientY, moved: false, alt: event.altKey }; }}
            onPointerEnter={() => setHovered(place.id)} onPointerLeave={() => setHovered(current => current === place.id ? null : current)}
            onFocus={() => { setFocused(place.id); setFocusId(place.id); }} onBlur={() => setFocused(current => current === place.id ? null : current)}>
            <ellipse className="iso-hit" cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />
            <polygon className="iso-plate" points={points(square(place.ground, shape.plate * 0.9))} />
            <polygon className="iso-focus" points={points(square(place.ground, shape.plate))} />
            {!pillar && <ellipse className="iso-ring" data-check={statusOf(checkOf(place.id))} cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />}
            <g className="iso-lift">
              <Prism className="iso-base" ground={place.ground} side={shape.base} bottom={0} top={shape.baseHeight} />
              <Prism className="iso-core" ground={place.ground} side={shape.core} bottom={shape.baseHeight} top={height(shape)} />
              <polygon className="iso-inlay" points={points(square(place.ground, shape.core * 0.5, height(shape)))} />
            </g>
          </g>;
        })}
      </g>
      {wireDrag && <path className="iso-connection" d={`M ${xy(wireDrag.from)} L ${xy(wireDrag.to)}`} />}
    </svg>
    {places.filter(place => place.kind === "agent").flatMap(place => (["target", "source"] as const).map(end => {
      const point = screen(place.at), offset = ellipse(shapeOf(place).ring).rx * view.zoom;
      const at = { x: point.x + (end === "source" ? offset : -offset), y: point.y };
      const valid = !wireDrag ? undefined : end !== wireDrag.end && canConnect(...(wireDrag.end === "source" ? [wireDrag.id, place.id] as const : [place.id, wireDrag.id] as const), wireDrag.edge?.id ?? null, wireDrag.alongside || wireDrag.edge?.kind === "alongside");
      return <button data-valid={valid} data-slot="iso-port" key={`${place.id}-${end}`} type="button" className="iso-port" data-kind="agent" data-node={place.id} data-end={end} aria-label={`${end === "source" ? "Output" : "Input"} of ${titleOf(place.id)}`} title={end === "source" ? "Drag to another agent's input, or drop to add an agent" : "Drag from another agent's output"} style={{ left: at.x, top: at.y, "--kind": agentColor(place.id, nodes.get(place.id)!.data as AgentData) } as CSSProperties}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onNodeMenu(event, place.id); }}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); root.current?.focus({ preventScroll: true }); root.current?.setPointerCapture(event.pointerId); setWireDrag({ id: place.id, end, from: at, to: at, alongside: event.altKey }); }}
        onClick={event => { event.stopPropagation(); if (event.detail === 0) { const box = event.currentTarget.getBoundingClientRect(); onCommand({ x: box.left, y: box.bottom }, place.id, end); } }} />;
    }))}
    {graph.edges.filter(edge => selected.includes(edge.id)).flatMap(edge => (["source", "target"] as const).map(end => {
      const place = byId.get(edge[end]), fixed = byId.get(edge[end === "source" ? "target" : "source"]); if (!place || !fixed) return null;
      const at = screen(place.at), origin = screen(fixed.at);
      return <button type="button" className="iso-port iso-wire-end" key={`${edge.id}-${end}`} aria-label={`Reconnect ${end} of wire`} style={{ left: at.x, top: at.y - 18 }} onPointerDown={event => {
        if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); root.current?.focus({ preventScroll: true }); root.current?.setPointerCapture(event.pointerId);
        setWireDrag({ id: fixed.id, end: end === "source" ? "target" : "source", from: origin, to: at, edge });
      }} />;
    }))}
    {(graph.frames ?? []).map(frame => {
      const members = places.filter(place => frame.nodeIds.includes(place.id)).map(place => ({ left: place.at.x - 90, top: place.at.y - 150, right: place.at.x + 90, bottom: place.at.y + 60 }));
      for (const node of graph.nodes) if (node.type === "note" && frame.nodeIds.includes(node.id)) { const at = node.isoPosition ?? node.position; members.push({ left: at.x - 24, top: at.y - 40, right: at.x + 224, bottom: at.y + 134 }); }
      if (!members.length) return null;
      const first = screen({ x: Math.min(...members.map(box => box.left)), y: Math.min(...members.map(box => box.top)) });
      const last = screen({ x: Math.max(...members.map(box => box.right)), y: Math.max(...members.map(box => box.bottom)) });
      return <div key={frame.id} className="canvas-frame iso-frame" style={{ left: first.x, top: first.y, width: last.x - first.x, height: last.y - first.y }}>
        <div className="canvas-frame-title" onClick={() => onSelect([...frame.nodeIds, frame.id])} onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest("input")) return; event.stopPropagation(); movingNode.current = { id: frame.id, x: event.clientX, y: event.clientY, moved: false, alt: false }; }}>
          {renamingFrame === frame.id ? <CanvasTextEdit label="Frame name" maxLength={120} value={frame.title} onSave={title => onFrameName(frame.id, title)} onCancel={() => onFrameName(frame.id, null)} /> : <strong>{frame.title}</strong>}
        </div></div>;
    })}
    {graph.nodes.filter(node => node.type === "note").map(node => {
      const at = screen(node.isoPosition ?? node.position);
      return <div key={node.id} data-id={node.id} className="canvas-note iso-note" style={{ left: at.x, top: at.y }} onClick={event => { event.stopPropagation(); onSelect(event.shiftKey ? [...selected, node.id] : [node.id]); }}>
        <span className="canvas-note-grip" onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); movingNode.current = { id: node.id, x: event.clientX, y: event.clientY, moved: false, alt: false }; }}>Note · for you</span>
        <textarea aria-label="Note" value={node.data.text} onChange={event => onNoteText(node.id, event.target.value)} /></div>;
    })}
    <div className="iso-labels">
      {places.map(place => {
        const at = labelPositions.get(place.id)!;
        return <span key={place.id} className="iso-label" data-for={place.id} data-kind={place.kind} data-hot={hot === place.id || undefined} data-selected={selected.includes(place.id) || undefined} data-short={!full.has(place.id) || undefined} title={place.kind === "agent" ? titleOf(place.id) : `${titleOf(place.id)} is the run's chat and cannot be renamed`} style={{ left: at.x, top: at.y }}
          onClick={event => { pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey); buttons.current.get(place.id)?.focus({ preventScroll: true }); }} onDoubleClick={() => rename(place.id)}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onNodeMenu(event, place.id); }}
          onPointerEnter={() => setHovered(place.id)} onPointerLeave={() => setHovered(current => current === place.id ? null : current)}>
          {renaming === place.id ? <CanvasTextEdit value={titleOf(place.id)} label="Rename agent" maxLength={256} onSave={title => { onRename(place.id, title); setRenaming(null); root.current?.focus(); }} onCancel={() => { setRenaming(null); root.current?.focus(); }} /> : <>{place.kind === "agent" && <b className="iso-badge">{wave.get(place.id) ?? "–"}</b>}{full.has(place.id) && <span title={titleOf(place.id)}>{titleOf(place.id)}</span>}</>}
        </span>;
      })}
      {[
        ...graph.edges.filter(wire => wire.label && byId.has(wire.source) && byId.has(wire.target)),
        ...(graph.motherFlow && motherWires[0] ? [{ ...motherWires[0], label: graph.motherFlow }] : []),
      ].map(wire => {
        const route = wire.source === MOTHER && motherPlace && junction ? [motherPlace.ground, junction] : routeOf(wire);
        let longest = 1;
        const length = (i: number) => Math.hypot(route[i].u - route[i - 1].u, route[i].v - route[i - 1].v);
        for (let i = 2; i < route.length; i++) if (length(i) > length(longest)) longest = i;
        const from = route[longest - 1], to = route[longest], at = screen(project((from.u + to.u) / 2, (from.v + to.v) / 2));
        const width = Math.min(LABEL.max, textWidth(wire.label!, family) + 18);
        const preferred = { x: Math.max(width / 2 + 6, Math.min((size?.width ?? Infinity) - width / 2 - 6, at.x)), y: Math.max(LABEL.height + 6, Math.min((size?.height ?? Infinity) - INSET.bottom, at.y - 10)) };
        const xs = [preferred.x], ys = [preferred.y];
        for (let x = width / 2 + 6; x <= (size?.width ?? 0) - width / 2 - 6; x += width + 8) xs.push(x);
        for (let y = LABEL.height + 6; y <= (size?.height ?? 0) - INSET.bottom; y += LABEL.height + 4) ys.push(y);
        const slots = ys.flatMap(y => xs.map(x => ({ x, y }))).sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
        const occupied = places.map(place => {
          const box = bounds([place]), first = screen({ x: box.left, y: box.top }), last = screen({ x: box.right, y: box.bottom });
          return { left: first.x - 9, top: first.y - 4, right: last.x + 9, bottom: last.y + 9 };
        });
        const position = slots.find(slot => { const box = labelBox(slot, width); return !taken.some(other => meet(other, box)) && !occupied.some(other => meet(other, box)); }) ?? preferred;
        taken.push(labelBox(position, width));
        return <span key={wire.id}>
          <svg className="iso-flow-leader" aria-hidden="true"><line x1={at.x} y1={at.y} x2={position.x} y2={position.y} /></svg>
          <button data-slot="flow-label" className="iso-flow-label" title={wire.label} style={{ left: position.x, top: position.y }} onClick={event => onWireClick(event, wire)}>{wire.label}</button>
        </span>;
      })}
    </div>
    <div className="iso-hud iso-controls" role="toolbar" aria-label="Zoom">
      <button data-slot="iso-key" type="button" className="iso-key iso-chamfer" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.25)}><Minus size={14} /></button>
      <button data-slot="iso-key" type="button" className="iso-key iso-chamfer" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.25)}><Plus size={14} /></button>
      <button data-slot="iso-key" type="button" className="iso-key iso-chamfer" aria-label="Fit view" title="Show the whole graph (Home)" onClick={() => setMoved(null)}><Maximize2 size={13} />Fit</button>
      <span className="canvas-toolbar-keys iso-keys"><span><b>←→</b>Move</span><span><b>Scroll</b>Pan</span><span><b>Ctrl/Cmd+scroll</b>Zoom</span><span><b>Middle-drag</b>Pan</span></span>
    </div>
    {minimap && <svg className="iso-hud canvas-minimap iso-minimap" role="img" aria-label="Minimap" viewBox={`${content.left - 30} ${content.top - 30} ${content.right - content.left + 60} ${content.bottom - content.top + 60}`} onClick={event => {
      if (!size) return; const point = event.currentTarget.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const at = point.matrixTransform(matrix.inverse());
      move({ ...view, x: size.width / 2 - at.x * view.zoom, y: size.height / 2 - at.y * view.zoom });
    }}>{places.map(place => <circle key={place.id} cx={place.at.x} cy={place.at.y} r={18} />)}</svg>}
    {/* The status panel, as Deus Ex's: what the pointer, the keys or the selection is on. */}
    <section className="iso-hud iso-status iso-chamfer" aria-label="Agent status" data-kind={subjectPlace?.kind}>
      {subjectPlace ? <><strong title={titleOf(subjectPlace.id)}>{titleOf(subjectPlace.id)}</strong>
        <small title={subjectPlace.kind !== "agent" ? parentLine(subjectPlace.id).join(" · ") : `Wave ${wave.get(subjectPlace.id) ?? "–"} · ${STATUS[statusOf(subjectPlace.id)]} · ${CHECK[statusOf(checkOf(subjectPlace.id))]}`}>{subjectPlace.kind !== "agent" ? parentLine(subjectPlace.id).join(" · ") : `Wave ${wave.get(subjectPlace.id) ?? "–"} · ${STATUS[statusOf(subjectPlace.id)]} · ${CHECK[statusOf(checkOf(subjectPlace.id))]}`}</small>{subjectModel && <small title={subjectModel}>{subjectModel}</small>}</>
        : <><strong>{agents.length} {agents.length === 1 ? "agent" : "agents"} in {new Set(wave.values()).size} {new Set(wave.values()).size === 1 ? "wave" : "waves"}</strong><small title="Click an agent to select it · Enter opens it">Click an agent to select it · Enter opens it</small></>}
    </section>
  </div>;
}

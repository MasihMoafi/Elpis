"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MOTHER, checkOf, waves, type CanvasGraph, type TaskStatus } from "@/lib/canvas";
import { ISO_STEP, isoFit, isoLayout, isoRoute, project, type Box, type Ground, type IsoPlace, type Point } from "@/lib/iso";

/** The agents canvas's second view (components/agents-canvas.tsx): the graph as Deus Ex's hacking screen, for
 * watching a run and clicking agents. Editing stays on the flat board, whose drag and wiring a 3D tilt would break.
 * Pedestals, wires and the ground are one SVG, projected by lib/iso.ts; titles and controls are flat HTML on top, so
 * text stays upright and legible at any zoom. */

type State = TaskStatus | "idle";
/** The flat board's words for a state (agents-canvas.tsx STATUS_LABEL and CHECK_LABEL), so both views say the same. */
const STATUS: Record<State, string> = { idle: "not run", pending: "waiting", running: "running", succeeded: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
const CHECK: Record<State, string> = { idle: "Checked after it runs", pending: "Check waits for it", running: "Being checked", succeeded: "Check passed", failed: "Check failed", blocked: "Check blocked", cancelled: "Check cancelled" };

/** A pedestal in ground units: the slab, the block standing on it, the ring of its check and the plate a selection
 * or focus lights around it. The Mother is a taller pillar. */
type Shape = { base: number; baseHeight: number; core: number; coreHeight: number; ring: number; plate: number };
const AGENT: Shape = { base: 64, baseHeight: 10, core: 36, coreHeight: 30, ring: 50, plate: 84 };
const PILLAR: Shape = { base: 72, baseHeight: 12, core: 40, coreHeight: 86, ring: 56, plate: 94 };
const shapeOf = (place: IsoPlace) => place.kind === "mother" ? PILLAR : AGENT;
const height = (shape: Shape) => shape.baseHeight + shape.coreHeight;
/** A ground circle of radius r is this ellipse on screen. */
const ellipse = (r: number) => ({ rx: r * Math.sqrt(1.5), ry: r * Math.SQRT1_2 });
/** Room the fit leaves for the titles above the pedestals, at the sides, and for the controls along the bottom. */
const INSET: Box = { left: 64, top: 48, right: 64, bottom: 78 };
const FIT_ZOOM = { min: 0.3, max: 1.1 }, ZOOM = { min: 0.25, max: 2.5 };
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
 * Mother's wire once its agent runs), done once that check passed, cut when it failed or the second is blocked. */
function wireState(source: string, target: string, states: States) {
  const to = states[target]?.status;
  if (source === MOTHER) return to === "running" ? "live" : undefined;
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

/** The header's switch between the flat board (editing) and this view (watching and clicking). */
export function ViewToggle({ iso, onChange }: { iso: boolean; onChange: (iso: boolean) => void }) {
  return <div className="segmented canvas-view" role="group" aria-label="Canvas view">
    {([["Flat", false, "Edit the graph: drag, wire and add agents"], ["Isometric", true, "Watch the run as a Deus Ex hacking screen: click an agent to select it, Enter opens it"]] as const).map(([label, value, hint]) =>
      <Button key={label} variant={iso === value ? "secondary" : "ghost"} size="sm" aria-pressed={iso === value} title={hint} onClick={() => onChange(value)}>{label}</Button>)}
  </div>;
}

type Props = { graph: CanvasGraph; states: States; selected: string[]; onSelect: (ids: string[]) => void; onOpen: (id: string) => void; dark: boolean };
/** The isometric board: the Mother and each agent on a pedestal in run order, wires on the ground. A click selects
 * (Shift adds), a double-click or Enter opens an agent's dashboard, the arrows move between agents in run order, the
 * wheel zooms and a drag pans. */
export function IsoBoard({ graph, states, selected, onSelect, onOpen, dark }: Props) {
  const root = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, SVGGElement>());
  const blur = `iso-blur-${useId().replace(/[^\w-]/g, "")}`;
  const wave = useMemo(() => waves(graph), [graph]);
  const places = useMemo(() => isoLayout(graph, wave), [graph, wave]);
  const content = useMemo(() => bounds(places), [places]);
  const byId = new Map(places.map(place => [place.id, place])), nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const order = places.map(place => place.id), agents = places.filter(place => place.kind === "agent");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null), [family, setFamily] = useState("sans-serif");
  // The user's own zoom and pan, kept for the layout it was made on: a new layout (an agent added, an architecture
  // loaded) is fitted again.
  const layout = places.map(place => `${place.id}@${place.column},${place.row}`).join(" ");
  const [moved, setMoved] = useState<{ layout: string; view: View } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null), [focused, setFocused] = useState<string | null>(null), [focusId, setFocusId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
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
  const view: View = (moved?.layout === layout ? moved.view : null) ?? (size ? isoFit(content, size, INSET, FIT_ZOOM) : { zoom: 1, x: 0, y: 0 });
  const move = (next: View) => setMoved({ layout, view: next });
  const zoomBy = (factor: number, at: Point = { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 }) => {
    const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, view.zoom * factor)), scale = zoom / view.zoom;
    move({ zoom, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale });
  };
  // The wheel zooms about the pointer; React's wheel listener is passive, so it can't keep the page from scrolling.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const box = element.getBoundingClientRect(); zoomBy(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - box.left, y: event.clientY - box.top }); };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  });

  const statusOf = (id: string): State => states[id]?.status ?? "idle";
  const tasks = Object.values(states).map(task => task.status);
  // The Mother runs while any of her agents does.
  const motherState: State = !tasks.length ? "idle" : tasks.some(status => status === "running" || status === "pending") ? "running" : tasks.some(status => status === "failed" || status === "blocked") ? "failed" : "succeeded";
  const titleOf = (id: string) => { const node = nodes.get(id); return id === MOTHER ? "Mother" : node?.type === "agent" ? node.data.title || "Untitled" : id; };
  const describe = (id: string) => id === MOTHER
    ? `this run's chat, ${agents.length} ${agents.length === 1 ? "agent" : "agents"}, ${STATUS[motherState]}`
    : `${wave.has(id) ? `wave ${wave.get(id)}` : "no wave"}, ${STATUS[statusOf(id)]}, ${CHECK[statusOf(checkOf(id))].toLowerCase()}`;
  const wires = [
    // The Mother's wires: she starts every agent of the first wave.
    ...agents.filter(place => wave.get(place.id) === 1).map(place => ({ id: `${MOTHER}->${place.id}`, source: MOTHER, target: place.id })),
    ...graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)),
  ];

  // One agent is in the tab order (the last focused, else the selected, else the Mother); the arrows walk the rest.
  const tabbable = focusId && byId.has(focusId) ? focusId : selected.find(id => byId.has(id)) ?? order[0];
  const hot = hovered ?? focused;
  const subject = hot ?? (selected.length === 1 && byId.has(selected[0]) ? selected[0] : null);
  const pick = (id: string, add: boolean) => { setFocusId(id); onSelect(add ? (selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]) : [id]); };
  const open = (id: string) => { pick(id, false); if (id !== MOTHER) onOpen(id); };
  const screen = (point: Point) => ({ x: view.x + view.zoom * point.x, y: view.y + view.zoom * point.y });
  // An agent reached by the keys is brought into view.
  const reveal = (id: string) => {
    const place = byId.get(id);
    if (!place || !size) return;
    const at = screen(place.at);
    if (at.x < INSET.left || at.x > size.width - INSET.right || at.y < INSET.top || at.y > size.height - INSET.bottom) move({ ...view, x: view.x + size.width / 2 - at.x, y: view.y + size.height / 2 - at.y });
  };
  const keys = (event: ReactKeyboardEvent, id: string) => {
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (step) {
      event.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(id) + step))];
      setFocusId(next); buttons.current.get(next)?.focus({ preventScroll: true }); reveal(next);
    } else if (event.key === "Enter") { event.preventDefault(); open(id); }
    else if (event.key === " ") { event.preventDefault(); pick(id, event.shiftKey || event.ctrlKey || event.metaKey); }
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
  const block = (place: IsoPlace): Box => { const shape = shapeOf(place), top = anchor(place), half = shape.core * Math.cos(Math.PI / 6) * view.zoom; return { left: top.x - half, top: top.y, right: top.x + half, bottom: top.y + (shape.core / 2 + shape.coreHeight) * view.zoom }; };
  const kept = (place: IsoPlace) => place.kind === "mother" || place.id === hot || selected.includes(place.id);
  const full = new Set<string>(), taken: Box[] = [];
  for (const place of [...places].sort((a, b) => Number(kept(b)) - Number(kept(a)))) {
    const at = anchor(place), width = Math.min(LABEL.max, textWidth(titleOf(place.id), family) + LABEL.chrome + (place.kind === "agent" ? LABEL.badge : 0));
    const box = { left: at.x - width / 2, top: at.y - LABEL.gap - LABEL.height, right: at.x + width / 2, bottom: at.y - LABEL.gap };
    if (kept(place) || !(taken.some(other => meet(other, box)) || places.some(other => other !== place && meet(block(other), box)))) { full.add(place.id); taken.push(box); }
  }
  const subjectPlace = subject ? byId.get(subject) : undefined;

  return <div ref={root} className="iso-board" role="region" aria-label="Isometric board" tabIndex={-1} data-panning={panning || undefined}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest(".iso-node, .iso-hud")) return;
      drag.current = { x: event.clientX, y: event.clientY, from: view, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true; setPanning(true); move({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
    }}
    onPointerUp={() => { const start = drag.current; drag.current = null; setPanning(false); if (start && !start.moved) onSelect([]); }}
    onPointerCancel={() => { drag.current = null; setPanning(false); }}>
    <svg role="group" aria-label="Agents in run order">
      <defs><filter id={blur} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation={dark ? 11 : 7} /></filter></defs>
      <g className="iso-world" transform={`translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.zoom.toFixed(4)})`}>
        <polygon className="iso-floor" points={points([project(u0, v0), project(u1, v0), project(u1, v1), project(u0, v1)])} />
        <g className="iso-grid">{grid.map(([a, b], index) => <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)}</g>
        {places.map(place => { const glow = ellipse(shapeOf(place).ring * 1.15); return <ellipse key={place.id} className="iso-glow" data-status={place.id === MOTHER ? motherState : statusOf(place.id)} filter={`url(#${blur})`} cx={place.at.x} cy={place.at.y} rx={glow.rx} ry={glow.ry} />; })}
        {wires.map(wire => {
          const route = isoRoute(byId.get(wire.source)!.ground, byId.get(wire.target)!.ground), path = `M ${route.map(point => xy(project(point.u, point.v))).join(" L ")}`, state = wireState(wire.source, wire.target, states);
          return <g key={wire.id} className="iso-link" data-state={state} data-mother={wire.source === MOTHER || undefined} data-hot={(hot && (wire.source === hot || wire.target === hot)) || undefined}>
            <path className="iso-wire-bed" d={path} /><path className="iso-wire" d={path} /><Chevrons route={route} live={state === "live"} />
          </g>;
        })}
        {painted.map(place => {
          const shape = shapeOf(place), ring = ellipse(shape.ring), mother = place.kind === "mother";
          return <g key={place.id} ref={element => { if (element) buttons.current.set(place.id, element); else buttons.current.delete(place.id); }}
            className="iso-node" data-id={place.id} data-kind={place.kind} data-status={mother ? motherState : statusOf(place.id)} data-hot={hot === place.id || undefined}
            role="button" tabIndex={tabbable === place.id ? 0 : -1} aria-pressed={selected.includes(place.id)} aria-label={`${titleOf(place.id)}: ${describe(place.id)}`}
            onClick={event => pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey)} onDoubleClick={() => open(place.id)} onKeyDown={event => keys(event, place.id)}
            onPointerEnter={() => setHovered(place.id)} onPointerLeave={() => setHovered(current => current === place.id ? null : current)}
            onFocus={() => { setFocused(place.id); setFocusId(place.id); }} onBlur={() => setFocused(current => current === place.id ? null : current)}>
            <ellipse className="iso-hit" cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />
            <polygon className="iso-plate" points={points(square(place.ground, shape.plate * 0.9))} />
            <polygon className="iso-focus" points={points(square(place.ground, shape.plate))} />
            {!mother && <ellipse className="iso-ring" data-check={statusOf(checkOf(place.id))} cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />}
            <g className="iso-lift">
              <Prism className="iso-base" ground={place.ground} side={shape.base} bottom={0} top={shape.baseHeight} />
              <Prism className="iso-core" ground={place.ground} side={shape.core} bottom={shape.baseHeight} top={height(shape)} />
              <polygon className="iso-inlay" points={points(square(place.ground, shape.core * 0.5, height(shape)))} />
            </g>
          </g>;
        })}
      </g>
    </svg>
    <div className="iso-labels" aria-hidden="true">
      {places.map(place => {
        const at = anchor(place);
        return <span key={place.id} className="iso-label" data-for={place.id} data-kind={place.kind} data-hot={hot === place.id || undefined} data-selected={selected.includes(place.id) || undefined} data-short={!full.has(place.id) || undefined} style={{ left: at.x, top: at.y - LABEL.gap }}>
          {place.kind === "agent" && <b className="iso-badge">{wave.get(place.id) ?? "–"}</b>}{full.has(place.id) && <span>{titleOf(place.id)}</span>}
        </span>;
      })}
    </div>
    <div className="iso-hud iso-controls" role="toolbar" aria-label="Zoom">
      <button type="button" className="iso-key iso-chamfer" aria-label="Zoom out" title="Zoom out (wheel)" onClick={() => zoomBy(1 / 1.25)}><Minus size={14} /></button>
      <button type="button" className="iso-key iso-chamfer" aria-label="Zoom in" title="Zoom in (wheel)" onClick={() => zoomBy(1.25)}><Plus size={14} /></button>
      <button type="button" className="iso-key iso-chamfer" aria-label="Fit view" title="Show the whole graph" onClick={() => setMoved(null)}><Maximize2 size={13} />Fit</button>
      <span className="canvas-toolbar-keys iso-keys"><span><b>←→</b>Move</span><span><b>Wheel</b>Zoom</span><span><b>Drag</b>Pan</span></span>
    </div>
    {/* The status panel, as Deus Ex's: what the pointer, the keys or the selection is on. */}
    <section className="iso-hud iso-status iso-chamfer" aria-label="Agent status" data-kind={subjectPlace?.kind}>
      {subjectPlace ? <><strong>{titleOf(subjectPlace.id)}</strong>
        <small>{subjectPlace.kind === "mother" ? `This run's chat · ${agents.length} ${agents.length === 1 ? "agent" : "agents"} · ${STATUS[motherState]}` : `Wave ${wave.get(subjectPlace.id) ?? "–"} · ${STATUS[statusOf(subjectPlace.id)]} · ${CHECK[statusOf(checkOf(subjectPlace.id))]}`}</small></>
        : <><strong>{agents.length} {agents.length === 1 ? "agent" : "agents"} in {new Set(wave.values()).size} {new Set(wave.values()).size === 1 ? "wave" : "waves"}</strong><small>Click an agent to select it · Enter opens it</small></>}
    </section>
  </div>;
}

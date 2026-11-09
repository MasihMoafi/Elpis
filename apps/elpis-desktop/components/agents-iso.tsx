"use client";

export { pen } from "./agents-iso-shared";
import { ellipse } from "./agents-iso-shared";
export { AGENT, PILLAR, ellipse, widths } from "./agents-iso-shared";
import { shapeOf, height, INSET, bounds, meet, textWidth, LABEL } from "./agents-iso-shared";
import { useIsoBoardState } from "./use-iso-board-state";
import { useIsoScene } from "./use-iso-scene";
import { WorkflowMark } from "@/components/workflow-identity";

import { Segmented } from "@/components/settings/rows";
import { type CSSProperties } from "react";
import { Maximize2, Minus } from "lucide-react";
import { PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import {
  agentColor,
  FATHER,
  MOTHER,
  checkOf,
  waits,
  type AgentData,
  type CanvasEdge,
  type TaskStatus,
} from "@/lib/canvas";
import { project, type Ground, type Point } from "@/lib/iso";

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

/** A pedestal in ground units: the slab, the block standing on it, the ring of its check and the plate a selection
 * or focus lights around it. The Mother and the Father are taller pillars. */
export type Shape = { base: number; baseHeight: number; core: number; coreHeight: number; ring: number; plate: number };

const xy = (point: Point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
/** A square of `side` on the ground around `ground`, lifted to `z`: its back, right, front and left corners. */
const square = (ground: Ground, side: number, z = 0): [Point, Point, Point, Point] => {
  const corner = (du: number, dv: number) => project(ground.u + (du * side) / 2, ground.v + (dv * side) / 2, z);
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
};
const points = (list: Point[]) => list.map(xy).join(" ");

/** Routes always have at least two points. */
function longestSpan(route: [Ground, Ground, ...Ground[]]): [Ground, Ground] {
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
function Prism({
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

export type States = Record<string, { status: TaskStatus; activity?: string | undefined }>;
/** A wire's state, as the flat board colours it: live once its first agent's check passed and the second runs (a
 * Mother's or the Father agent's wire once its agent runs), done once that check passed, cut when it failed or the second
 * is blocked. A two-way wire sets no order, so it carries none. */
function wireState({ source, target, kind }: CanvasEdge, states: States) {
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
function Chevrons({ route, live }: { route: [Ground, Ground, ...Ground[]]; live: boolean }) {
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

/** The header's switch between the flat board and this isometric view. */
export function ViewToggle({ iso, onChange }: { iso: boolean; onChange: (iso: boolean) => void }) {
  return (
    <Segmented
      label="Workflows view"
      className="canvas-view"
      value={iso ? "iso" : "flat"}
      onChange={value => onChange(value === "iso")}
      options={[
        { value: "flat", label: "Flat", title: "Edit the graph: drag, wire and add agents" },
        {
          value: "iso",
          label: "Isometric",
          title: "Select and connect agents on the isometric board; Enter opens the selected agent",
        },
      ]}
    />
  );
}

/** `father`: the agents past the Mother's ten, which the Father runs (lib/canvas.ts `parents`). */
export type IsoController = {
  fit: () => void;
  frame: () => void;
  cancelGesture: () => boolean;
  zoom: (factor: number) => void;
  reveal: (ids: string[]) => void;
  position: (client: Point) => Point;
  keepView: () => void;
};
/** The isometric board: the Mother (and the Father) and each agent on a pedestal in run order, wires on the ground. A click selects
 * (Shift adds), a double-click renames an agent and Enter opens Info, the arrows move between agents in run order.
 * The parent owns window/crossing selection in both views; middle-drag and scroll pan, Ctrl/Cmd+scroll zooms. */
export function IsoBoard(props: Parameters<typeof useIsoBoardState>[0]) {
  const {
    root,
    panning,
    onAdd,
    onBoardMenu,
    drag,
    view,
    setWireDrag,
    movingNode,
    onMoveEnd,
    onMoveStart,
    suppressClick,
    onMove,
    onMovePreview,
    wireDrag,
    setPanning,
    move,
    onReconnect,
    onCommand,
    onConnect,
    blur,
    dark,
    u0,
    v0,
    u1,
    v1,
    grid,
    places,
    statusOf,
    motherPlace,
    junction,
    motherWire,
    onWireClick,
    onWireMenu,
    motherWires,
    states,
    wires,
    routeOf,
    inserting,
    hot,
    painted,
    buttons,
    nodes,
    tabbable,
    selected,
    titleOf,
    describe,
    onNodeMenu,
    pick,
    rename,
    keys,
    setHovered,
    setFocused,
    setFocusId,
    screen,
    canConnect,
    graph,
    byId,
    onSelect,
    renamingFrame,
    onFrameName,
    onNoteText,
    labelPositions,
    full,
    renaming,
    onRename,
    setRenaming,
    workflowIdentity,
    wave,
    family,
    size,
    labelBox,
    taken,
    zoomBy,
    setMoved,
    subjectPlace,
    subjectLine,
    subjectModel,
    overview,
  } = useIsoScene(useIsoBoardState(props));
  return (
    <div
      ref={root}
      className="iso-board"
      role="region"
      aria-label="Isometric board"
      tabIndex={-1}
      data-panning={panning || undefined}
      onDoubleClick={event => {
        if (
          !(event.target as Element).closest(
            ".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame",
          )
        )
          onAdd({ x: event.clientX, y: event.clientY });
      }}
      onContextMenu={event => {
        if (
          !(event.target as Element).closest(
            ".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame",
          )
        )
          onBoardMenu(event);
      }}
      onPointerDown={event => {
        if (
          event.button !== 1 ||
          (event.target as Element).closest(
            ".iso-hud, .iso-port, .iso-label, .iso-link, .iso-flow-label, input, textarea",
          )
        )
          return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { x: event.clientX, y: event.clientY, from: view, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          setWireDrag(null);
          if (movingNode.current?.moved) onMoveEnd(false, true);
          movingNode.current = null;
        }
      }}
      onPointerMove={event => {
        const moving = movingNode.current;
        if (moving) {
          const dx = (event.clientX - moving.x) / view.zoom,
            dy = (event.clientY - moving.y) / view.zoom;
          if (!moving.moved && Math.hypot(event.clientX - moving.x, event.clientY - moving.y) < 5) return;
          if (!moving.moved) {
            onMoveStart(moving.id, moving.alt);
            moving.moved = true;
            suppressClick.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          onMove(moving.id, Math.round(dx / 20) * 20, Math.round(dy / 20) * 20);
          onMovePreview(moving.id);
          return;
        }
        if (wireDrag) {
          const box = event.currentTarget.getBoundingClientRect();
          setWireDrag({ ...wireDrag, to: { x: event.clientX - box.left, y: event.clientY - box.top } });
          return;
        }
        const start = drag.current;
        if (!start) return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        start.moved = true;
        setPanning(true);
        move({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
      }}
      onPointerUp={event => {
        if (movingNode.current) {
          if (movingNode.current.moved) onMoveEnd(event.shiftKey);
          movingNode.current = null;
          setTimeout(() => {
            suppressClick.current = false;
          });
        }
        if (wireDrag) {
          const hit = document.elementFromPoint(event.clientX, event.clientY),
            port = hit?.closest<HTMLElement>(".iso-port"),
            node = hit?.closest<SVGGElement>(".iso-node");
          const over = port?.dataset.node ?? node?.dataset.id;
          const from = wireDrag;
          setWireDrag(null);
          const box = event.currentTarget.getBoundingClientRect(),
            distance = Math.hypot(event.clientX - box.left - from.from.x, event.clientY - box.top - from.from.y);
          if (from.edge) {
            if (over && over !== from.id && (!port || port.dataset.end !== from.end))
              onReconnect(
                from.edge,
                ...(from.end === "source" ? ([from.id, over] as const) : ([over, from.id] as const)),
              );
            return;
          }
          if (over === from.id && distance < 8) {
            onCommand({ x: event.clientX, y: event.clientY }, from.id, from.end);
            return;
          }
          if (over && over !== from.id && (!port || port.dataset.end !== from.end))
            onConnect(
              ...(from.end === "source" ? ([from.id, over] as const) : ([over, from.id] as const)),
              event.altKey ? "alongside" : undefined,
            );
          else if (
            !over &&
            hit &&
            root.current?.contains(hit) &&
            !hit.closest(".iso-hud, .iso-label, .iso-link, .iso-flow-label")
          ) {
            if (distance >= 8) onAdd({ x: event.clientX, y: event.clientY }, from.id, from.end);
          }
          return;
        }
        drag.current = null;
        setPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (movingNode.current?.moved) onMoveEnd(false, true);
        movingNode.current = null;
        drag.current = null;
        setPanning(false);
        setWireDrag(null);
      }}
      onPointerCancel={() => {
        if (movingNode.current?.moved) onMoveEnd(false, true);
        movingNode.current = null;
        drag.current = null;
        setPanning(false);
        setWireDrag(null);
      }}
    >
      <svg role="group" aria-label="Agents in run order">
        <defs>
          <filter id={blur} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={dark ? 11 : 7} />
          </filter>
        </defs>
        <g
          className="iso-world"
          transform={`translate(${view.x.toFixed(1)},${view.y.toFixed(1)}) scale(${view.zoom.toFixed(4)})`}
        >
          <polygon
            className="iso-floor"
            points={points([project(u0, v0), project(u1, v0), project(u1, v1), project(u0, v1)])}
          />
          <g className="iso-grid">
            {grid.map(([a, b], index) => (
              <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            ))}
          </g>
          {places.map(place => {
            const glow = ellipse(shapeOf(place).ring * 1.15);
            return (
              <ellipse
                key={place.id}
                className="iso-glow"
                data-status={statusOf(place.id)}
                filter={`url(#${blur})`}
                cx={place.at.x}
                cy={place.at.y}
                rx={glow.rx}
                ry={glow.ry}
              />
            );
          })}
          {motherPlace && junction && motherWire && (
            <g
              className="iso-link iso-mother-trunk"
              data-mother="true"
              onClick={event => onWireClick(event, motherWire)}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                onWireMenu(event, motherWire);
              }}
            >
              <path className="iso-wire-hit" d={`M ${xy(motherPlace.at)} L ${xy(project(junction.u, junction.v))}`} />
              <path className="iso-wire" d={`M ${xy(motherPlace.at)} L ${xy(project(junction.u, junction.v))}`} />
              <Chevrons
                route={[motherPlace.ground, junction]}
                live={motherWires.some(wire => wireState(wire, states) === "live")}
              />
            </g>
          )}
          {wires.map(wire => {
            const route = routeOf(wire),
              path = `M ${route.map(point => xy(project(point.u, point.v))).join(" L ")}`,
              state = wireState(wire, states);
            return (
              <g
                key={wire.id}
                className="iso-link"
                data-inserting={inserting === wire.id || undefined}
                data-id={wire.id}
                onClick={event => onWireClick(event, wire)}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  onWireMenu(event, wire);
                }}
                data-state={state}
                data-kind={wire.kind}
                data-mother={wire.source === MOTHER || undefined}
                data-father={wire.source === FATHER || undefined}
                data-hot={(hot && (wire.source === hot || wire.target === hot)) || undefined}
              >
                <path className="iso-wire-hit" d={path} />
                <path className="iso-wire-bed" d={path} />
                <path className="iso-wire" d={path} />
                {waits(wire) && wire.source !== MOTHER && <Chevrons route={route} live={state === "live"} />}
              </g>
            );
          })}
          {painted.map(place => {
            const shape = shapeOf(place),
              ring = ellipse(shape.ring),
              pillar = place.kind !== "agent";
            return (
              <g
                key={place.id}
                ref={element => {
                  if (element) buttons.current.set(place.id, element);
                  else buttons.current.delete(place.id);
                }}
                className="iso-node"
                style={
                  place.kind === "agent"
                    ? ({
                        "--agent-color": agentColor(place.id, nodes.get(place.id)!.data as AgentData),
                      } as CSSProperties)
                    : undefined
                }
                data-id={place.id}
                data-kind={place.kind}
                data-muted={
                  (nodes.get(place.id)?.type === "agent" && (nodes.get(place.id)!.data as AgentData).muted) || undefined
                }
                data-status={statusOf(place.id)}
                data-hot={hot === place.id || undefined}
                role="button"
                tabIndex={tabbable === place.id ? 0 : -1}
                aria-pressed={selected.includes(place.id)}
                aria-label={`${titleOf(place.id)}: ${describe(place.id)}`}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  onNodeMenu(event, place.id);
                }}
                onClick={event => {
                  if (!suppressClick.current) pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey);
                }}
                onDoubleClick={() => rename(place.id)}
                onKeyDown={event => keys(event, place.id)}
                onPointerDown={event => {
                  if (event.button !== 0 || place.kind !== "agent") return;
                  movingNode.current = {
                    id: place.id,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                    alt: event.altKey,
                  };
                }}
                onPointerEnter={() => setHovered(place.id)}
                onPointerLeave={() => setHovered(current => (current === place.id ? null : current))}
                onFocus={() => {
                  setFocused(place.id);
                  setFocusId(place.id);
                }}
                onBlur={() => setFocused(current => (current === place.id ? null : current))}
              >
                <ellipse className="iso-hit" cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />
                <polygon className="iso-plate" points={points(square(place.ground, shape.plate * 0.9))} />
                <polygon className="iso-focus" points={points(square(place.ground, shape.plate))} />
                {!pillar && (
                  <ellipse
                    className="iso-ring"
                    data-check={statusOf(checkOf(place.id))}
                    cx={place.at.x}
                    cy={place.at.y}
                    rx={ring.rx}
                    ry={ring.ry}
                  />
                )}
                <g className="iso-lift">
                  <Prism
                    className="iso-base"
                    ground={place.ground}
                    side={shape.base}
                    bottom={0}
                    top={shape.baseHeight}
                  />
                  <Prism
                    className="iso-core"
                    ground={place.ground}
                    side={shape.core}
                    bottom={shape.baseHeight}
                    top={height(shape)}
                  />
                  <polygon
                    className="iso-inlay"
                    points={points(square(place.ground, shape.core * 0.5, height(shape)))}
                  />
                </g>
              </g>
            );
          })}
        </g>
        {wireDrag && <path className="iso-connection" d={`M ${xy(wireDrag.from)} L ${xy(wireDrag.to)}`} />}
      </svg>
      {places
        .filter(place => place.kind === "agent")
        .flatMap(place =>
          (["target", "source"] as const).map(end => {
            const point = screen(place.at),
              offset = ellipse(shapeOf(place).ring).rx * view.zoom;
            const at = { x: point.x + (end === "source" ? offset : -offset), y: point.y };
            const valid = !wireDrag
              ? undefined
              : end !== wireDrag.end &&
                canConnect(
                  ...(wireDrag.end === "source"
                    ? ([wireDrag.id, place.id] as const)
                    : ([place.id, wireDrag.id] as const)),
                  wireDrag.edge?.id ?? null,
                  wireDrag.alongside || wireDrag.edge?.kind === "alongside",
                );
            return (
              <button
                data-valid={valid}
                data-slot="iso-port"
                key={`${place.id}-${end}`}
                type="button"
                className="iso-port"
                data-kind="agent"
                data-node={place.id}
                data-end={end}
                aria-label={`${end === "source" ? "Output" : "Input"} of ${titleOf(place.id)}`}
                title={
                  end === "source"
                    ? "Drag to another agent's input, or drop to add an agent"
                    : "Drag from another agent's output"
                }
                style={
                  {
                    left: at.x,
                    top: at.y,
                    "--kind": agentColor(place.id, nodes.get(place.id)!.data as AgentData),
                  } as CSSProperties
                }
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  onNodeMenu(event, place.id);
                }}
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  root.current?.focus({ preventScroll: true });
                  root.current?.setPointerCapture(event.pointerId);
                  setWireDrag({ id: place.id, end, from: at, to: at, alongside: event.altKey });
                }}
                onClick={event => {
                  event.stopPropagation();
                  if (event.detail === 0) {
                    const box = event.currentTarget.getBoundingClientRect();
                    onCommand({ x: box.left, y: box.bottom }, place.id, end);
                  }
                }}
              />
            );
          }),
        )}
      {graph.edges
        .filter(edge => selected.includes(edge.id))
        .flatMap(edge =>
          (["source", "target"] as const).map(end => {
            const place = byId.get(edge[end]),
              fixed = byId.get(edge[end === "source" ? "target" : "source"]);
            if (!place || !fixed) return null;
            const at = screen(place.at),
              origin = screen(fixed.at);
            return (
              <button
                type="button"
                className="iso-port iso-wire-end"
                key={`${edge.id}-${end}`}
                aria-label={`Reconnect ${end} of wire`}
                style={{ left: at.x, top: at.y - 18 }}
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  root.current?.focus({ preventScroll: true });
                  root.current?.setPointerCapture(event.pointerId);
                  setWireDrag({
                    id: fixed.id,
                    end: end === "source" ? "target" : "source",
                    from: origin,
                    to: at,
                    edge,
                  });
                }}
              />
            );
          }),
        )}
      {(graph.frames ?? []).map(frame => {
        const members = places
          .filter(place => frame.nodeIds.includes(place.id))
          .map(place => ({
            left: place.at.x - 90,
            top: place.at.y - 150,
            right: place.at.x + 90,
            bottom: place.at.y + 60,
          }));
        for (const node of graph.nodes)
          if (node.type === "note" && frame.nodeIds.includes(node.id)) {
            const at = node.isoPosition ?? node.position;
            members.push({ left: at.x - 24, top: at.y - 40, right: at.x + 224, bottom: at.y + 134 });
          }
        if (!members.length) return null;
        const first = screen({
          x: Math.min(...members.map(box => box.left)),
          y: Math.min(...members.map(box => box.top)),
        });
        const last = screen({
          x: Math.max(...members.map(box => box.right)),
          y: Math.max(...members.map(box => box.bottom)),
        });
        return (
          <div
            key={frame.id}
            className="canvas-frame iso-frame"
            style={{ left: first.x, top: first.y, width: last.x - first.x, height: last.y - first.y }}
          >
            <div
              className="canvas-frame-title"
              onClick={() => onSelect([...frame.nodeIds, frame.id])}
              onPointerDown={event => {
                if (event.button !== 0 || (event.target as Element).closest("input")) return;
                event.stopPropagation();
                movingNode.current = { id: frame.id, x: event.clientX, y: event.clientY, moved: false, alt: false };
              }}
            >
              {renamingFrame === frame.id ? (
                <CanvasTextEdit
                  label="Frame name"
                  maxLength={120}
                  value={frame.title}
                  onSave={title => onFrameName(frame.id, title)}
                  onCancel={() => onFrameName(frame.id, null)}
                />
              ) : (
                <strong>{frame.title}</strong>
              )}
            </div>
          </div>
        );
      })}
      {graph.nodes
        .filter(node => node.type === "note")
        .map(node => {
          const at = screen(node.isoPosition ?? node.position);
          return (
            <div
              key={node.id}
              data-id={node.id}
              className="canvas-note iso-note"
              style={{ left: at.x, top: at.y }}
              onClick={event => {
                event.stopPropagation();
                onSelect(event.shiftKey ? [...selected, node.id] : [node.id]);
              }}
            >
              <span
                className="canvas-note-grip"
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  movingNode.current = { id: node.id, x: event.clientX, y: event.clientY, moved: false, alt: false };
                }}
              >
                Note · for you
              </span>
              <NoteText text={node.data.text} onText={text => onNoteText(node.id, text)} />
            </div>
          );
        })}
      <div className="iso-labels">
        {places.map(place => {
          const at = labelPositions.get(place.id)!;
          return (
            <span
              key={place.id}
              className="iso-label"
              data-for={place.id}
              data-kind={place.kind}
              data-hot={hot === place.id || undefined}
              data-selected={selected.includes(place.id) || undefined}
              data-short={!full.has(place.id) || undefined}
              title={
                place.kind === "agent"
                  ? titleOf(place.id)
                  : `${titleOf(place.id)} is the run's chat and cannot be renamed`
              }
              style={{ left: at.x, top: at.y }}
              onClick={event => {
                pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey);
                buttons.current.get(place.id)?.focus({ preventScroll: true });
              }}
              onDoubleClick={() => rename(place.id)}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                onNodeMenu(event, place.id);
              }}
              onPointerEnter={() => setHovered(place.id)}
              onPointerLeave={() => setHovered(current => (current === place.id ? null : current))}
            >
              {renaming === place.id ? (
                <CanvasTextEdit
                  value={titleOf(place.id)}
                  label="Rename agent"
                  maxLength={256}
                  onSave={title => {
                    onRename(place.id, title);
                    setRenaming(null);
                    root.current?.focus();
                  }}
                  onCancel={() => {
                    setRenaming(null);
                    root.current?.focus();
                  }}
                />
              ) : (
                <>
                  {place.kind === "mother" && workflowIdentity && <WorkflowMark identity={workflowIdentity} />}
                  {place.kind === "agent" && <b className="iso-badge">{wave.get(place.id) ?? "–"}</b>}
                  {full.has(place.id) && <span title={titleOf(place.id)}>{titleOf(place.id)}</span>}
                </>
              )}
            </span>
          );
        })}
        {[
          ...graph.edges.filter(wire => wire.label && byId.has(wire.source) && byId.has(wire.target)),
          ...(graph.motherFlow && motherWire ? [{ ...motherWire, label: graph.motherFlow }] : []),
        ].map(wire => {
          const route: [Ground, Ground, ...Ground[]] =
            wire.source === MOTHER && motherPlace && junction ? [motherPlace.ground, junction] : routeOf(wire);
          const [from, to] = longestSpan(route),
            at = screen(project((from.u + to.u) / 2, (from.v + to.v) / 2));
          const width = Math.min(LABEL.max, textWidth(wire.label!, family) + 18);
          const preferred = {
            x: Math.max(width / 2 + 6, Math.min((size?.width ?? Infinity) - width / 2 - 6, at.x)),
            y: Math.max(LABEL.height + 6, Math.min((size?.height ?? Infinity) - INSET.bottom, at.y - 10)),
          };
          const xs = [preferred.x],
            ys = [preferred.y];
          for (let x = width / 2 + 6; x <= (size?.width ?? 0) - width / 2 - 6; x += width + 8) xs.push(x);
          for (let y = LABEL.height + 6; y <= (size?.height ?? 0) - INSET.bottom; y += LABEL.height + 4) ys.push(y);
          const slots = ys
            .flatMap(y => xs.map(x => ({ x, y })))
            .sort(
              (a, b) =>
                Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y),
            );
          const occupied = places.map(place => {
            const box = bounds([place]),
              first = screen({ x: box.left, y: box.top }),
              last = screen({ x: box.right, y: box.bottom });
            return { left: first.x - 9, top: first.y - 4, right: last.x + 9, bottom: last.y + 9 };
          });
          const position =
            slots.find(slot => {
              const box = labelBox(slot, width);
              return !taken.some(other => meet(other, box)) && !occupied.some(other => meet(other, box));
            }) ?? preferred;
          taken.push(labelBox(position, width));
          return (
            <span key={wire.id}>
              <svg className="iso-flow-leader" aria-hidden="true">
                <line x1={at.x} y1={at.y} x2={position.x} y2={position.y} />
              </svg>
              <button
                data-slot="flow-label"
                className="iso-flow-label"
                title={wire.label}
                style={{ left: position.x, top: position.y }}
                onClick={event => onWireClick(event, wire)}
              >
                {wire.label}
              </button>
            </span>
          );
        })}
      </div>
      <div className="iso-hud iso-controls" role="toolbar" aria-label="Zoom">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => zoomBy(1 / 1.25)}
        >
          <Minus />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.25)}>
          <PlusIcon />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Fit view"
          title="Show the whole graph (Home)"
          onClick={() => setMoved(null)}
        >
          <Maximize2 />
          Fit
        </Button>
      </div>
      {/* The status panel, as Deus Ex's: what the pointer, the keys or the selection is on. */}
      <section className="iso-hud iso-status iso-chamfer" aria-label="Agent status" data-kind={subjectPlace?.kind}>
        {subjectPlace ? (
          <>
            <strong title={titleOf(subjectPlace.id)}>{titleOf(subjectPlace.id)}</strong>
            <small title={subjectLine}>{subjectLine}</small>
            {subjectModel && <small title={subjectModel}>{subjectModel}</small>}
          </>
        ) : (
          <>
            <strong title={overview}>{overview}</strong>
            <small title="Click an agent to select it · Enter opens it">
              Click an agent to select it · Enter opens it
            </small>
          </>
        )}
      </section>
    </div>
  );
}

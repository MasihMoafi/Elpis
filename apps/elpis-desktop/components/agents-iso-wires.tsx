"use client";

import { type CSSProperties } from "react";
import { Maximize2, Minus } from "lucide-react";
import { PlusIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { agentColor, FATHER, MOTHER, checkOf, waits, type AgentData } from "@/lib/canvas";
import { project } from "@/lib/iso";
import type { IsoScene } from "./use-iso-scene";
import { Chevrons, Prism, ellipse, height, points, shapeOf, square, wireState, xy } from "./agents-iso-shared";

/** The board's drawing: its grid, wires and pieces. */
export function IsoWires({ scene }: { scene: IsoScene }) {
  const { motherWire } = scene;
  return (
    <>
      <svg role="group" aria-label="Agents in run order">
        <defs>
          <filter id={scene.blur} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={scene.dark ? 11 : 7} />
          </filter>
        </defs>
        <g
          className="iso-world"
          transform={`translate(${scene.view.x.toFixed(1)},${scene.view.y.toFixed(1)}) scale(${scene.view.zoom.toFixed(4)})`}
        >
          <polygon
            className="iso-floor"
            points={points([
              project(scene.u0, scene.v0),
              project(scene.u1, scene.v0),
              project(scene.u1, scene.v1),
              project(scene.u0, scene.v1),
            ])}
          />
          <g className="iso-grid">
            {scene.grid.map(([a, b], index) => (
              <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            ))}
          </g>
          {scene.places.map(place => {
            const glow = ellipse(shapeOf(place).ring * 1.15);
            return (
              <ellipse
                key={place.id}
                className="iso-glow"
                data-status={scene.statusOf(place.id)}
                filter={`url(#${scene.blur})`}
                cx={place.at.x}
                cy={place.at.y}
                rx={glow.rx}
                ry={glow.ry}
              />
            );
          })}
          {scene.motherPlace && scene.junction && motherWire && (
            <g
              className="iso-link iso-mother-trunk"
              data-mother="true"
              onClick={event => scene.onWireClick(event, motherWire)}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                scene.onWireMenu(event, motherWire);
              }}
            >
              <path
                className="iso-wire-hit"
                d={`M ${xy(scene.motherPlace.at)} L ${xy(project(scene.junction.u, scene.junction.v))}`}
              />
              <path
                className="iso-wire"
                d={`M ${xy(scene.motherPlace.at)} L ${xy(project(scene.junction.u, scene.junction.v))}`}
              />
              <Chevrons
                route={[scene.motherPlace.ground, scene.junction]}
                live={scene.motherWires.some(wire => wireState(wire, scene.states) === "live")}
              />
            </g>
          )}
          {scene.wires.map(wire => {
            const route = scene.routeOf(wire),
              path = `M ${route.map(point => xy(project(point.u, point.v))).join(" L ")}`,
              state = wireState(wire, scene.states);
            return (
              <g
                key={wire.id}
                className="iso-link"
                data-inserting={scene.inserting === wire.id || undefined}
                data-id={wire.id}
                onClick={event => scene.onWireClick(event, wire)}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  scene.onWireMenu(event, wire);
                }}
                data-state={state}
                data-kind={wire.kind}
                data-mother={wire.source === MOTHER || undefined}
                data-father={wire.source === FATHER || undefined}
                data-hot={(scene.hot && (wire.source === scene.hot || wire.target === scene.hot)) || undefined}
              >
                <path className="iso-wire-hit" d={path} />
                <path className="iso-wire-bed" d={path} />
                <path className="iso-wire" d={path} />
                {waits(wire) && wire.source !== MOTHER && <Chevrons route={route} live={state === "live"} />}
              </g>
            );
          })}
          {scene.painted.map(place => {
            const shape = shapeOf(place),
              ring = ellipse(shape.ring),
              pillar = place.kind !== "agent";
            return (
              <g
                key={place.id}
                ref={element => {
                  if (element) scene.buttons.current.set(place.id, element);
                  else scene.buttons.current.delete(place.id);
                }}
                className="iso-node"
                style={
                  place.kind === "agent"
                    ? ({
                        "--agent-color": agentColor(place.id, scene.nodes.get(place.id)!.data as AgentData),
                      } as CSSProperties)
                    : undefined
                }
                data-id={place.id}
                data-kind={place.kind}
                data-muted={
                  (scene.nodes.get(place.id)?.type === "agent" &&
                    (scene.nodes.get(place.id)!.data as AgentData).muted) ||
                  undefined
                }
                data-status={scene.statusOf(place.id)}
                data-hot={scene.hot === place.id || undefined}
                role="button"
                tabIndex={scene.tabbable === place.id ? 0 : -1}
                aria-pressed={scene.selected.includes(place.id)}
                aria-label={`${scene.titleOf(place.id)}: ${scene.describe(place.id)}`}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  scene.onNodeMenu(event, place.id);
                }}
                onClick={event => {
                  if (!scene.suppressClick.current)
                    scene.pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey);
                }}
                onDoubleClick={() => scene.rename(place.id)}
                onKeyDown={event => scene.keys(event, place.id)}
                onPointerDown={event => {
                  if (event.button !== 0 || place.kind !== "agent") return;
                  scene.movingNode.current = {
                    id: place.id,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                    alt: event.altKey,
                  };
                }}
                onPointerEnter={() => scene.setHovered(place.id)}
                onPointerLeave={() => scene.setHovered(current => (current === place.id ? null : current))}
                onFocus={() => {
                  scene.setFocused(place.id);
                  scene.setFocusId(place.id);
                }}
                onBlur={() => scene.setFocused(current => (current === place.id ? null : current))}
              >
                <ellipse className="iso-hit" cx={place.at.x} cy={place.at.y} rx={ring.rx} ry={ring.ry} />
                <polygon className="iso-plate" points={points(square(place.ground, shape.plate * 0.9))} />
                <polygon className="iso-focus" points={points(square(place.ground, shape.plate))} />
                {!pillar && (
                  <ellipse
                    className="iso-ring"
                    data-check={scene.statusOf(checkOf(place.id))}
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
        {scene.wireDrag && (
          <path className="iso-connection" d={`M ${xy(scene.wireDrag.from)} L ${xy(scene.wireDrag.to)}`} />
        )}
      </svg>
    </>
  );
}

/** The zoom controls and the status panel. */
export function IsoHud({ scene }: { scene: IsoScene }) {
  return (
    <>
      <div className="iso-hud iso-controls" role="toolbar" aria-label="Zoom">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => scene.zoomBy(1 / 1.25)}
        >
          <Minus />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => scene.zoomBy(1.25)}
        >
          <PlusIcon />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Fit view"
          title="Show the whole graph (Home)"
          onClick={() => scene.setMoved(null)}
        >
          <Maximize2 />
          Fit
        </Button>
      </div>
      {/* The status panel, as Deus Ex's: what the pointer, the keys or the selection is on. */}
      <section
        className="iso-hud iso-status iso-chamfer"
        aria-label="Agent status"
        data-kind={scene.subjectPlace?.kind}
      >
        {scene.subjectPlace ? (
          <>
            <strong title={scene.titleOf(scene.subjectPlace.id)}>{scene.titleOf(scene.subjectPlace.id)}</strong>
            <small title={scene.subjectLine}>{scene.subjectLine}</small>
            {scene.subjectModel && <small title={scene.subjectModel}>{scene.subjectModel}</small>}
          </>
        ) : (
          <>
            <strong title={scene.overview}>{scene.overview}</strong>
            <small title="Click an agent to select it · Enter opens it">
              Click an agent to select it · Enter opens it
            </small>
          </>
        )}
      </section>
    </>
  );
}

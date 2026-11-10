"use client";

import { WorkflowMark } from "@/components/workflow-identity";
import { type CSSProperties, type PointerEvent } from "react";
import { CanvasTextEdit } from "@/components/canvas-text-edit";
import { agentColor, MOTHER, type AgentData } from "@/lib/canvas";
import { project, type Ground } from "@/lib/iso";
import type { IsoScene } from "./use-iso-scene";
import {
  INSET,
  LABEL,
  NoteText,
  bounds,
  ellipse,
  longestSpan,
  meet,
  shapeOf,
  textWidth,
} from "./agents-iso-shared";

/** A left press on a port or wire end starts dragging a wire from it, keeping the pointer on the board. */
function startWireDrag(scene: IsoScene, event: PointerEvent, drag: NonNullable<Parameters<IsoScene["setWireDrag"]>[0]>) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  scene.root.current?.focus({ preventScroll: true });
  scene.root.current?.setPointerCapture(event.pointerId);
  scene.setWireDrag(drag);
}

/** The agents, wires' labels, frames and notes placed over the drawing. */
export function IsoPlaces({ scene }: { scene: IsoScene }) {
  const { motherWire } = scene;
  return (
    <>
      {scene.places
        .filter(place => place.kind === "agent")
        .flatMap(place =>
          (["target", "source"] as const).map(end => {
            const point = scene.screen(place.at),
              offset = ellipse(shapeOf(place).ring).rx * scene.view.zoom;
            const at = { x: point.x + (end === "source" ? offset : -offset), y: point.y };
            const valid = !scene.wireDrag
              ? undefined
              : end !== scene.wireDrag.end &&
                scene.canConnect(
                  ...(scene.wireDrag.end === "source"
                    ? ([scene.wireDrag.id, place.id] as const)
                    : ([place.id, scene.wireDrag.id] as const)),
                  scene.wireDrag.edge?.id ?? null,
                  scene.wireDrag.alongside || scene.wireDrag.edge?.kind === "alongside",
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
                aria-label={`${end === "source" ? "Output" : "Input"} of ${scene.titleOf(place.id)}`}
                title={
                  end === "source"
                    ? "Drag to another agent's input, or drop to add an agent"
                    : "Drag from another agent's output"
                }
                style={
                  {
                    left: at.x,
                    top: at.y,
                    "--kind": agentColor(place.id, scene.nodes.get(place.id)!.data as AgentData),
                  } as CSSProperties
                }
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  scene.onNodeMenu(event, place.id);
                }}
                onPointerDown={event => startWireDrag(scene, event, { id: place.id, end, from: at, to: at, alongside: event.altKey })}
                onClick={event => {
                  event.stopPropagation();
                  if (event.detail === 0) {
                    const box = event.currentTarget.getBoundingClientRect();
                    scene.onCommand({ x: box.left, y: box.bottom }, place.id, end);
                  }
                }}
              />
            );
          }),
        )}
      {scene.graph.edges
        .filter(edge => scene.selected.includes(edge.id))
        .flatMap(edge =>
          (["source", "target"] as const).map(end => {
            const place = scene.byId.get(edge[end]),
              fixed = scene.byId.get(edge[end === "source" ? "target" : "source"]);
            if (!place || !fixed) return null;
            const at = scene.screen(place.at),
              origin = scene.screen(fixed.at);
            return (
              <button
                type="button"
                className="iso-port iso-wire-end"
                key={`${edge.id}-${end}`}
                aria-label={`Reconnect ${end} of wire`}
                style={{ left: at.x, top: at.y - 18 }}
                onPointerDown={event =>
                  startWireDrag(scene, event, {
                    id: fixed.id,
                    end: end === "source" ? "target" : "source",
                    from: origin,
                    to: at,
                    edge,
                  })
                }
              />
            );
          }),
        )}
      {(scene.graph.frames ?? []).map(frame => {
        const members = scene.places
          .filter(place => frame.nodeIds.includes(place.id))
          .map(place => ({
            left: place.at.x - 90,
            top: place.at.y - 150,
            right: place.at.x + 90,
            bottom: place.at.y + 60,
          }));
        for (const node of scene.graph.nodes)
          if (node.type === "note" && frame.nodeIds.includes(node.id)) {
            const at = node.isoPosition ?? node.position;
            members.push({ left: at.x - 24, top: at.y - 40, right: at.x + 224, bottom: at.y + 134 });
          }
        if (!members.length) return null;
        const first = scene.screen({
          x: Math.min(...members.map(box => box.left)),
          y: Math.min(...members.map(box => box.top)),
        });
        const last = scene.screen({
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
              onClick={() => scene.onSelect([...frame.nodeIds, frame.id])}
              onPointerDown={event => {
                if (event.button !== 0 || (event.target as Element).closest("input")) return;
                event.stopPropagation();
                scene.movingNode.current = {
                  id: frame.id,
                  x: event.clientX,
                  y: event.clientY,
                  moved: false,
                  alt: false,
                };
              }}
            >
              {scene.renamingFrame === frame.id ? (
                <CanvasTextEdit
                  label="Frame name"
                  maxLength={120}
                  value={frame.title}
                  onSave={title => scene.onFrameName(frame.id, title)}
                  onCancel={() => scene.onFrameName(frame.id, null)}
                />
              ) : (
                <strong>{frame.title}</strong>
              )}
            </div>
          </div>
        );
      })}
      {scene.graph.nodes
        .filter(node => node.type === "note")
        .map(node => {
          const at = scene.screen(node.isoPosition ?? node.position);
          return (
            <div
              key={node.id}
              data-id={node.id}
              className="canvas-note iso-note"
              style={{ left: at.x, top: at.y }}
              onClick={event => {
                event.stopPropagation();
                scene.onSelect(event.shiftKey ? [...scene.selected, node.id] : [node.id]);
              }}
            >
              <span
                className="canvas-note-grip"
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  scene.movingNode.current = {
                    id: node.id,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                    alt: false,
                  };
                }}
              >
                Note · for you
              </span>
              <NoteText text={node.data.text} onText={text => scene.onNoteText(node.id, text)} />
            </div>
          );
        })}
      <div className="iso-labels">
        {scene.places.map(place => {
          const at = scene.labelPositions.get(place.id)!;
          return (
            <span
              key={place.id}
              className="iso-label"
              data-for={place.id}
              data-kind={place.kind}
              data-hot={scene.hot === place.id || undefined}
              data-selected={scene.selected.includes(place.id) || undefined}
              data-short={!scene.full.has(place.id) || undefined}
              title={
                place.kind === "agent"
                  ? scene.titleOf(place.id)
                  : `${scene.titleOf(place.id)} is the run's chat and cannot be renamed`
              }
              style={{ left: at.x, top: at.y }}
              onClick={event => {
                scene.pick(place.id, event.shiftKey || event.ctrlKey || event.metaKey);
                scene.buttons.current.get(place.id)?.focus({ preventScroll: true });
              }}
              onDoubleClick={() => scene.rename(place.id)}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                scene.onNodeMenu(event, place.id);
              }}
              onPointerEnter={() => scene.setHovered(place.id)}
              onPointerLeave={() => scene.setHovered(current => (current === place.id ? null : current))}
            >
              {scene.renaming === place.id ? (
                <CanvasTextEdit
                  value={scene.titleOf(place.id)}
                  label="Rename agent"
                  maxLength={256}
                  onSave={title => {
                    scene.onRename(place.id, title);
                    scene.setRenaming(null);
                    scene.root.current?.focus();
                  }}
                  onCancel={() => {
                    scene.setRenaming(null);
                    scene.root.current?.focus();
                  }}
                />
              ) : (
                <>
                  {place.kind === "mother" && scene.workflowIdentity && (
                    <WorkflowMark identity={scene.workflowIdentity} />
                  )}
                  {place.kind === "agent" && <b className="iso-badge">{scene.wave.get(place.id) ?? "–"}</b>}
                  {scene.full.has(place.id) && <span title={scene.titleOf(place.id)}>{scene.titleOf(place.id)}</span>}
                </>
              )}
            </span>
          );
        })}
        {[
          ...scene.graph.edges.filter(wire => wire.label && scene.byId.has(wire.source) && scene.byId.has(wire.target)),
          ...(scene.graph.motherFlow && motherWire ? [{ ...motherWire, label: scene.graph.motherFlow }] : []),
        ].map(wire => {
          const route: [Ground, Ground, ...Ground[]] =
            wire.source === MOTHER && scene.motherPlace && scene.junction
              ? [scene.motherPlace.ground, scene.junction]
              : scene.routeOf(wire);
          const [from, to] = longestSpan(route),
            at = scene.screen(project((from.u + to.u) / 2, (from.v + to.v) / 2));
          const width = Math.min(LABEL.max, textWidth(wire.label!, scene.family) + 18);
          const preferred = {
            x: Math.max(width / 2 + 6, Math.min((scene.size?.width ?? Infinity) - width / 2 - 6, at.x)),
            y: Math.max(LABEL.height + 6, Math.min((scene.size?.height ?? Infinity) - INSET.bottom, at.y - 10)),
          };
          const xs = [preferred.x],
            ys = [preferred.y];
          for (let x = width / 2 + 6; x <= (scene.size?.width ?? 0) - width / 2 - 6; x += width + 8) xs.push(x);
          for (let y = LABEL.height + 6; y <= (scene.size?.height ?? 0) - INSET.bottom; y += LABEL.height + 4)
            ys.push(y);
          const slots = ys
            .flatMap(y => xs.map(x => ({ x, y })))
            .sort(
              (a, b) =>
                Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y),
            );
          const occupied = scene.places.map(place => {
            const box = bounds([place]),
              first = scene.screen({ x: box.left, y: box.top }),
              last = scene.screen({ x: box.right, y: box.bottom });
            return { left: first.x - 9, top: first.y - 4, right: last.x + 9, bottom: last.y + 9 };
          });
          const position =
            slots.find(slot => {
              const box = scene.labelBox(slot, width);
              return !scene.taken.some(other => meet(other, box)) && !occupied.some(other => meet(other, box));
            }) ?? preferred;
          scene.taken.push(scene.labelBox(position, width));
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
                onClick={event => scene.onWireClick(event, wire)}
              >
                {wire.label}
              </button>
            </span>
          );
        })}
      </div>
    </>
  );
}

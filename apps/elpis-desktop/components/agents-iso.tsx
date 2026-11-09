"use client";

export { pen } from "./agents-iso-shared";
export { NoteText } from "./agents-iso-shared";
import { IsoWires, IsoHud } from "./agents-iso-wires";
import { IsoPlaces } from "./agents-iso-places";
export { AGENT, PILLAR, ellipse, widths } from "./agents-iso-shared";

import { useIsoBoardState } from "./use-iso-board-state";
import { useIsoScene } from "./use-iso-scene";

import { Segmented } from "@/components/settings/rows";

import { type TaskStatus } from "@/lib/canvas";
import { type Point } from "@/lib/iso";

/** A pedestal in ground units: the slab, the block standing on it, the ring of its check and the plate a selection
 * or focus lights around it. The Mother and the Father are taller pillars. */
export type Shape = { base: number; baseHeight: number; core: number; coreHeight: number; ring: number; plate: number };

export type States = Record<string, { status: TaskStatus; activity?: string | undefined }>;

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
  const scene = useIsoScene(useIsoBoardState(props));
  return (
    <div
      ref={scene.root}
      className="iso-board"
      role="region"
      aria-label="Isometric board"
      tabIndex={-1}
      data-panning={scene.panning || undefined}
      onDoubleClick={event => {
        if (
          !(event.target as Element).closest(
            ".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame",
          )
        )
          scene.onAdd({ x: event.clientX, y: event.clientY });
      }}
      onContextMenu={event => {
        if (
          !(event.target as Element).closest(
            ".iso-node, .iso-port, .iso-label, .iso-link, .iso-hud, .iso-flow-label, .iso-note, .iso-frame",
          )
        )
          scene.onBoardMenu(event);
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
        scene.drag.current = { x: event.clientX, y: event.clientY, from: scene.view, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          scene.setWireDrag(null);
          if (scene.movingNode.current?.moved) scene.onMoveEnd(false, true);
          scene.movingNode.current = null;
        }
      }}
      onPointerMove={event => {
        const moving = scene.movingNode.current;
        if (moving) {
          const dx = (event.clientX - moving.x) / scene.view.zoom,
            dy = (event.clientY - moving.y) / scene.view.zoom;
          if (!moving.moved && Math.hypot(event.clientX - moving.x, event.clientY - moving.y) < 5) return;
          if (!moving.moved) {
            scene.onMoveStart(moving.id, moving.alt);
            moving.moved = true;
            scene.suppressClick.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          scene.onMove(moving.id, Math.round(dx / 20) * 20, Math.round(dy / 20) * 20);
          scene.onMovePreview(moving.id);
          return;
        }
        if (scene.wireDrag) {
          const box = event.currentTarget.getBoundingClientRect();
          scene.setWireDrag({ ...scene.wireDrag, to: { x: event.clientX - box.left, y: event.clientY - box.top } });
          return;
        }
        const start = scene.drag.current;
        if (!start) return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        start.moved = true;
        scene.setPanning(true);
        scene.move({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
      }}
      onPointerUp={event => {
        if (scene.movingNode.current) {
          if (scene.movingNode.current.moved) scene.onMoveEnd(event.shiftKey);
          scene.movingNode.current = null;
          setTimeout(() => {
            scene.suppressClick.current = false;
          });
        }
        if (scene.wireDrag) {
          const hit = document.elementFromPoint(event.clientX, event.clientY),
            port = hit?.closest<HTMLElement>(".iso-port"),
            node = hit?.closest<SVGGElement>(".iso-node");
          const over = port?.dataset.node ?? node?.dataset.id;
          const from = scene.wireDrag;
          scene.setWireDrag(null);
          const box = event.currentTarget.getBoundingClientRect(),
            distance = Math.hypot(event.clientX - box.left - from.from.x, event.clientY - box.top - from.from.y);
          if (from.edge) {
            if (over && over !== from.id && (!port || port.dataset.end !== from.end))
              scene.onReconnect(
                from.edge,
                ...(from.end === "source" ? ([from.id, over] as const) : ([over, from.id] as const)),
              );
            return;
          }
          if (over === from.id && distance < 8) {
            scene.onCommand({ x: event.clientX, y: event.clientY }, from.id, from.end);
            return;
          }
          if (over && over !== from.id && (!port || port.dataset.end !== from.end))
            scene.onConnect(
              ...(from.end === "source" ? ([from.id, over] as const) : ([over, from.id] as const)),
              event.altKey ? "alongside" : undefined,
            );
          else if (
            !over &&
            hit &&
            scene.root.current?.contains(hit) &&
            !hit.closest(".iso-hud, .iso-label, .iso-link, .iso-flow-label")
          ) {
            if (distance >= 8) scene.onAdd({ x: event.clientX, y: event.clientY }, from.id, from.end);
          }
          return;
        }
        scene.drag.current = null;
        scene.setPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (scene.movingNode.current?.moved) scene.onMoveEnd(false, true);
        scene.movingNode.current = null;
        scene.drag.current = null;
        scene.setPanning(false);
        scene.setWireDrag(null);
      }}
      onPointerCancel={() => {
        if (scene.movingNode.current?.moved) scene.onMoveEnd(false, true);
        scene.movingNode.current = null;
        scene.drag.current = null;
        scene.setPanning(false);
        scene.setWireDrag(null);
      }}
    >
      <IsoWires scene={scene} />
      <IsoPlaces scene={scene} />
      <IsoHud scene={scene} />
    </div>
  );
}

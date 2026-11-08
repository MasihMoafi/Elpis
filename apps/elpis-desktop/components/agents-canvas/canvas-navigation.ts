import { useReactFlow, type XYPosition } from "@xyflow/react";
import { isoLayout } from "@/lib/iso";
import { type IsoController } from "@/components/agents-iso";
import { arrange, newId, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";

export function canvasNavigation({
  board,
  pointer,
  iso,
  isoController,
  flow,
  viewMiddle,
  selection,
  fitAll,
  graph,
  setSelection,
  reveal,
  agents,
  order,
  checkpoint,
  setGraph,
  tidy,
  boxes,
  place,
  NODE_W,
  NODE_H,
}: {
  board: React.RefObject<HTMLDivElement | null>;
  pointer: React.RefObject<XYPosition | null>;
  iso: boolean;
  isoController: React.RefObject<IsoController | null>;
  flow: ReturnType<typeof useReactFlow>;
  viewMiddle: () => XYPosition | undefined;
  selection: string[];
  fitAll: () => void;
  graph: CanvasGraph;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  reveal: (ids: string[]) => NodeJS.Timeout;
  agents: Extract<CanvasNode, { type: "agent" }>[];
  order: Map<string, number>;
  checkpoint: () => void;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  tidy: () => void;
  boxes: () => { x: number; y: number; w: number; h: number }[];
  place: (
    near?: XYPosition,
    taken?: { x: number; y: number; w: number; h: number }[],
    size?: { w: number; h: number },
    closest?: boolean,
  ) => { x: number; y: number };
  NODE_W: number;
  NODE_H: number;
}) {
  const focusBoard = () =>
    board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus({ preventScroll: true });
  const pointerPosition = () =>
    pointer.current
      ? iso
        ? isoController.current?.position(pointer.current)
        : flow.screenToFlowPosition(pointer.current)
      : viewMiddle();
  const frameView = () => {
    if (!selection.length) fitAll();
    else if (iso) isoController.current?.frame();
    else
      void flow.fitView({
        nodes: selection.filter(id => graph.nodes.some(node => node.id === id)).map(id => ({ id })),
        padding: 0.3,
        maxZoom: 1.5,
        duration: 250,
      });
  };
  const zoom = (factor: number) => {
    if (iso) isoController.current?.zoom(factor);
    else void flow.zoomTo(factor ? flow.getZoom() * factor : 1, { duration: 150 });
  };
  const focusAgent = (id: string) => {
    const element = [
      ...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(
        ".react-flow__node-agent, .iso-node[data-kind='agent']",
      ) ?? []),
    ].find(node => node.dataset.id === id);
    if (!element) return;
    setSelection([id]);
    element.focus({ preventScroll: true });
    if (iso) isoController.current?.reveal([id]);
    else reveal([id]);
  };
  const focusPrevious = () => {
    if (agents.length) {
      const index = agents.findIndex(node => node.id === selection.at(-1));
      const previous = agents[((index < 0 ? agents.length : index) - 1 + agents.length) % agents.length];
      if (previous) focusAgent(previous.id);
    }
  };
  const focusNearest = (direction: string) => {
    const candidates = [
      ...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(
        ".react-flow__node-agent, .iso-node[data-kind='agent']",
      ) ?? []),
    ];
    const active = candidates.find(node => node.dataset.id === selection.at(-1)),
      origin = active?.getBoundingClientRect();
    const center = (box: DOMRect) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const at = origin ? center(origin) : null;
    const next = !at
      ? candidates[0]
      : candidates
          .filter(node => {
            const point = center(node.getBoundingClientRect());
            return direction === "ArrowRight"
              ? point.x > at.x + 1
              : direction === "ArrowLeft"
                ? point.x < at.x - 1
                : direction === "ArrowDown"
                  ? point.y > at.y + 1
                  : point.y < at.y - 1;
          })
          .sort((a, b) => {
            const p = center(a.getBoundingClientRect()),
              q = center(b.getBoundingClientRect());
            return Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y);
          })[0];
    if (next?.dataset.id) focusAgent(next.dataset.id);
  };
  const nudge = (direction: string, amount: number) => {
    if (!selection.some(id => graph.nodes.some(node => node.id === id && node.type !== "mother"))) return;
    const dx = direction === "ArrowRight" ? amount : direction === "ArrowLeft" ? -amount : 0,
      dy = direction === "ArrowDown" ? amount : direction === "ArrowUp" ? -amount : 0;
    const scene = iso ? isoLayout(graph, order) : [];
    checkpoint();
    if (iso) isoController.current?.keepView();
    setGraph(current => ({
      ...current,
      nodes: current.nodes.map(node => {
        if (!selection.includes(node.id) || node.type === "mother") return node;
        const at = scene.find(item => item.id === node.id)?.at;
        return {
          ...node,
          position: { x: node.position.x + dx, y: node.position.y + dy },
          ...(iso && at ? { isoPosition: { x: at.x + dx, y: at.y + dy } } : {}),
        };
      }),
    }));
  };
  const tidySelection = () => {
    if (!selection.length) {
      tidy();
      return;
    }
    checkpoint();
    const arranged = arrange(graph);
    const taken = boxes().filter((_, index) => {
      const node = graph.nodes[index];
      return !node || !selection.includes(node.id);
    });
    const nodes = graph.nodes.map(node => {
      if (!selection.includes(node.id) || node.type !== "agent") return node;
      const desired = arranged.nodes.find(item => item.id === node.id)!,
        position = place(desired.position, taken);
      taken.push({ ...position, w: NODE_W, h: NODE_H });
      return { ...desired, position };
    });
    setGraph(current => ({ ...current, nodes }));
  };
  const mute = (ids = selection) => {
    const picked = agents.filter(node => ids.includes(node.id));
    if (!picked.length) return;
    const muted = picked.some(node => !node.data.muted);
    checkpoint();
    setGraph(current => ({
      ...current,
      nodes: current.nodes.map(node =>
        node.type === "agent" && ids.includes(node.id) ? { ...node, data: { ...node.data, muted } } : node,
      ),
    }));
  };
  const frameSelection = (ids = selection) => {
    const nodeIds = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id)).map(node => node.id);
    if (!nodeIds.length) return;
    const id = newId("frame");
    checkpoint();
    setGraph(current => ({
      ...current,
      frames: [
        ...(current.frames ?? [])
          .map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !nodeIds.includes(id)) }))
          .filter(frame => frame.nodeIds.length),
        { id, title: "Frame", nodeIds },
      ],
    }));
    setSelection([...nodeIds, id]);
    // The title extends above its members; keep the new frame's drag handle inside the board.
    reveal([id]);
  };
  const ungroup = () => {
    const frames = graph.frames?.filter(
      frame => !selection.includes(frame.id) && !frame.nodeIds.some(id => selection.includes(id)),
    );
    if (frames?.length === graph.frames?.length) return;
    checkpoint();
    setGraph(current => ({ ...current, frames }));
    setSelection(current => current.filter(id => graph.nodes.some(node => node.id === id)));
  };
  return {
    focusBoard,
    ungroup,
    frameSelection,
    tidySelection,
    nudge,
    pointerPosition,
    mute,
    focusNearest,
    zoom,
    frameView,
    focusPrevious,
  };
}

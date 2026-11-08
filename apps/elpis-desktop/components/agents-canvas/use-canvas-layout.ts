import { useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { type IsoController } from "@/components/agents-iso";
import { appStorage } from "@/lib/projects";
import { TEMPLATES, arrange, withMother, type CanvasGraph, type TaskStatus } from "@/lib/canvas";
import type * as React from "react";
import { Run, BoardMenu } from "./types";
import { shapeKey } from "./graph-key";
import { FIT } from "./constants";

export function useCanvasLayout({
  setRenamingPreset,
  setUndoLoad,
  graph,
  setGraph,
  setSelection,
  setMenu,
  setDashboardId,
  setRun,
  setStates,
  setNotice,
  flow,
  checkpoint,
  iso,
  isoController,
  board,
  NODE_W,
  NODE_H,
  restored,
}: {
  setRenamingPreset: React.Dispatch<React.SetStateAction<boolean>>;
  setUndoLoad: React.Dispatch<React.SetStateAction<{ loaded: string; previous: CanvasGraph } | null>>;
  graph: CanvasGraph;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  setDashboardId: React.Dispatch<React.SetStateAction<string | null>>;
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
  setStates: React.Dispatch<
    React.SetStateAction<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined }>>
  >;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  flow: ReturnType<typeof useReactFlow>;
  checkpoint: () => void;
  iso: boolean;
  isoController: React.RefObject<IsoController | null>;
  board: React.RefObject<HTMLDivElement | null>;
  NODE_W: number;
  NODE_H: number;
  restored: React.RefObject<boolean>;
}) {
  const loadTemplate = (template: (typeof TEMPLATES)[number]) => {
    setRenamingPreset(false);
    setUndoLoad({ loaded: template.name, previous: graph });
    setGraph(current => ({
      ...withMother(template.build()),
      maxAgents: current.maxAgents,
      mother: current.mother,
      request: current.request,
      template: template.id,
      planningPattern: template.id,
    }));
    setSelection([]);
    setMenu(null);
    setDashboardId(null);
    setRun(null);
    setStates({});
    setNotice("");
    // Keys go to the board again (Tab opens the command bar), not to the template just clicked.
    (document.activeElement as HTMLElement | null)?.blur();
    setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
  };
  const tidy = () => {
    checkpoint();
    setGraph(current => arrange(current));
    setTimeout(() => {
      if (iso) isoController.current?.fit();
      else void flow.fitView({ ...FIT, duration: 250 });
    }, 60);
  };
  // Agents just made are brought into view if they landed outside it (after auto-arrange has placed them), at the same zoom.
  const reveal = (ids: string[]) =>
    setTimeout(() => {
      const box = board.current?.querySelector(".react-flow")?.getBoundingClientRect(),
        made = ids.flatMap(id => {
          const node = flow.getNode(id);
          return node ? [node] : [];
        });
      if (!box || !made.length) return;
      const outside = made.some(node => {
        const start = flow.flowToScreenPosition(node.position),
          end = flow.flowToScreenPosition({ x: node.position.x + NODE_W, y: node.position.y + NODE_H });
        return start.x < box.left || start.y < box.top || end.x > box.right || end.y > box.bottom;
      });
      if (outside)
        void flow.fitView({
          nodes: made.map(node => ({ id: node.id })),
          padding: 0.4,
          maxZoom: flow.getZoom(),
          minZoom: Math.min(flow.getZoom(), 0.85),
          duration: 250,
        });
    }, 140);
  // Auto-arrange (on unless turned off, remembered): after any change to the agents or their wires, the board re-forms its
  // run-order columns, so it never turns into a tangle. Moving an agent by hand still works; within a column the
  // order follows its height.
  const [autoLayout, setAutoLayout] = useState(() => {
    try {
      return appStorage().getItem("elpis-canvas-auto") !== "off";
    } catch {
      return true;
    }
  });
  const shape = shapeKey(graph),
    lastShape = useRef(shape);
  useEffect(() => {
    if (shape === lastShape.current) return;
    lastShape.current = shape;
    // Undo, redo and direct creation retain their chosen positions.
    if (restored.current) {
      restored.current = false;
      return;
    }
    if (autoLayout)
      setGraph(current => {
        const next = arrange(current);
        return next.nodes.every(
          (node, index) =>
            node.position.x === current.nodes[index]?.position.x &&
            node.position.y === current.nodes[index]?.position.y,
        )
          ? current
          : next;
      });
  }, [shape, autoLayout]);
  const toggleAuto = () => {
    const next = !autoLayout;
    setAutoLayout(next);
    try {
      appStorage().setItem("elpis-canvas-auto", next ? "on" : "off");
    } catch {
      /* this session only */
    }
    if (next) tidy();
  };
  return { reveal, tidy, loadTemplate, autoLayout, toggleAuto };
}

import { type MouseEvent as ReactMouseEvent } from "react";
import { type Edge, type Node } from "@xyflow/react";
import { FATHER, MOTHER, type CanvasEdge, type CanvasGraph } from "@/lib/canvas";
import type * as React from "react";
import { Adding, MenuAt, BoardMenu } from "./types";

export function canvasMenus({
  board,
  setAdding,
  setMenu,
  setFlowEdit,
  flowEdit,
  checkpoint,
  setGraph,
  graph,
  setSelection,
  selection,
  suppressContext,
}: {
  board: React.RefObject<HTMLDivElement | null>;
  setAdding: React.Dispatch<React.SetStateAction<Adding | null>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  setFlowEdit: React.Dispatch<React.SetStateAction<{ edge: CanvasEdge; left: number; top: number } | null>>;
  flowEdit: { edge: CanvasEdge; left: number; top: number } | null;
  checkpoint: () => void;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  graph: CanvasGraph;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  selection: string[];
  suppressContext: React.RefObject<boolean>;
}) {
  // Menus open where the board was clicked, kept inside it.
  const menuAt = (event: { clientX: number; clientY: number }, rows: number): MenuAt | null => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return null;
    setAdding(null);
    return {
      client: { x: event.clientX, y: event.clientY },
      left: Math.max(8, Math.min(event.clientX - box.left, box.width - 348)),
      top: Math.max(8, Math.min(event.clientY - box.top + 10, box.height - 60 - rows * 46)),
    };
  };
  const onEdgeClick = (event: ReactMouseEvent, edge: Edge) => {
    if (edge.source === FATHER) return;
    const at = menuAt(event, 2);
    if (at)
      setMenu({
        ...at,
        kind: "wire",
        edge: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...((edge as CanvasEdge).kind ? { kind: (edge as CanvasEdge).kind } : {}),
        },
      });
  };
  const editFlow = (event: ReactMouseEvent, edge: CanvasEdge) => {
    if (edge.source === FATHER) return;
    event.stopPropagation();
    const at = menuAt(event, 1);
    if (!at) return;
    setMenu(null);
    setFlowEdit({ edge, left: at.left, top: at.top });
  };
  const saveFlow = (label: string) => {
    if (!flowEdit) return;
    checkpoint();
    const { edge } = flowEdit;
    setGraph(current =>
      edge.source === MOTHER
        ? { ...current, motherFlow: label }
        : { ...current, edges: current.edges.map(item => (item.id === edge.id ? { ...item, label } : item)) },
    );
    setFlowEdit(null);
    board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
  };
  // A right-click on a node acts on the selection it belongs to, else on that node alone.
  const onNodeContextMenu = (event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    if (node.id === FATHER) return;
    if (node.id === MOTHER) {
      const at = menuAt(event, 2);
      if (at) setMenu({ ...at, kind: "mother" });
      return;
    }
    const frame = graph.frames?.find(frame => frame.id === node.id);
    if (frame) {
      const ids = [...frame.nodeIds, frame.id];
      setSelection(ids);
      const at = menuAt(event, 8);
      if (at) setMenu({ ...at, kind: "nodes", ids });
      return;
    }
    const ids = selection.includes(node.id) ? selection.filter(id => id !== MOTHER) : [node.id];
    if (!selection.includes(node.id)) setSelection([node.id]);
    const at = menuAt(event, ids.length > 1 ? 4 : 7);
    if (at) setMenu({ ...at, kind: "nodes", ids });
  };
  const onPaneContextMenu = (event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    if (suppressContext.current) return;
    const at = menuAt(event, 5);
    if (at) setMenu({ ...at, kind: "board" });
  };
  return { menuAt, editFlow, onNodeContextMenu, onPaneContextMenu, onEdgeClick, saveFlow };
}

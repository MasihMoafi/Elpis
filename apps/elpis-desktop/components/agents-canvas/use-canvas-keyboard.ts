import { useEffect } from "react";
import { useStoreApi, type XYPosition } from "@xyflow/react";
import { type IsoController } from "@/components/agents-iso";
import { linkedIds } from "@/lib/canvas";
import { FATHER, MOTHER, type CanvasEdge, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";
import { Adding, BoardMenu } from "./types";

export function useCanvasKeyboard({
  board,
  boxDrag,
  cutter,
  nodeDrag,
  connectFrom,
  setSelection,
  setSelectionBox,
  setStroke,
  setLasso,
  setGraph,
  setInsertWire,
  flowStore,
  connectionCancelled,
  iso,
  isoController,
  lasso,
  previewRun,
  start,
  ungroup,
  frameSelection,
  graph,
  selection,
  setFinding,
  setFindIndex,
  setMenu,
  setAdding,
  tidySelection,
  toggleMinimap,
  nudge,
  openAdder,
  checkpoint,
  addNote,
  pointerPosition,
  keyboardMenu,
  mute,
  focusNearest,
  zoom,
  frameView,
  focusPrevious,
  addAgent,
  selected,
  setPatternCommand,
  setDashboardId,
  redo,
  undo,
  copy,
  remove,
  clipboard,
  paste,
  duplicate,
  removeKeepingFlow,
  fitAll,
  setRenamingFrame,
  rename,
}: {
  board: React.RefObject<HTMLDivElement | null>;
  boxDrag: React.RefObject<{
    x: number;
    y: number;
    base: string[];
    previous: string[];
    subtract: boolean;
    moved: boolean;
    lasso: boolean;
    points: XYPosition[];
  } | null>;
  cutter: React.RefObject<{ points: XYPosition[]; ids: Set<string>; cancelled?: boolean } | null>;
  nodeDrag: React.RefObject<{
    before: CanvasGraph;
    id: string;
    ids: string[];
    extract: boolean;
    cancelled: boolean;
  } | null>;
  connectFrom: React.RefObject<XYPosition | null>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectionBox: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; width: number; height: number; crossing: boolean } | null>
  >;
  setStroke: React.Dispatch<React.SetStateAction<XYPosition[] | null>>;
  setLasso: React.Dispatch<React.SetStateAction<boolean>>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setInsertWire: React.Dispatch<React.SetStateAction<string | null>>;
  flowStore: ReturnType<typeof useStoreApi>;
  connectionCancelled: React.RefObject<boolean>;
  iso: boolean;
  isoController: React.RefObject<IsoController | null>;
  lasso: boolean;
  previewRun: () => void;
  start: (targets?: string[]) => Promise<void>;
  ungroup: () => void;
  frameSelection: (ids?: string[]) => void;
  graph: CanvasGraph;
  selection: string[];
  setFinding: React.Dispatch<React.SetStateAction<string | null>>;
  setFindIndex: React.Dispatch<React.SetStateAction<number>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  setAdding: React.Dispatch<React.SetStateAction<Adding | null>>;
  tidySelection: () => void;
  toggleMinimap: () => void;
  nudge: (direction: string, amount: number) => void;
  openAdder: (client?: XYPosition, from?: Adding["from"], between?: CanvasEdge, seed?: string) => void;
  checkpoint: () => void;
  addNote: (at?: XYPosition, text?: string) => void;
  pointerPosition: () => XYPosition | undefined;
  keyboardMenu: () => void;
  mute: (ids?: string[]) => void;
  focusNearest: (direction: string) => void;
  zoom: (factor: number) => void;
  frameView: () => void;
  focusPrevious: () => void;
  addAgent: (client?: XYPosition, from?: Adding["from"]) => void;
  selected: Extract<CanvasNode, { type: "agent" }> | undefined;
  setPatternCommand: React.Dispatch<React.SetStateAction<string | null>>;
  setDashboardId: React.Dispatch<React.SetStateAction<string | null>>;
  redo: () => void;
  undo: () => void;
  copy: (ids?: string[]) => void;
  remove: (ids: string[]) => void;
  clipboard: React.RefObject<{ nodes: CanvasNode[]; edges: CanvasEdge[]; frames?: CanvasGraph["frames"] } | null>;
  paste: (at?: XYPosition) => void;
  duplicate: (ids?: string[]) => void;
  removeKeepingFlow: (ids: string[]) => void;
  fitAll: () => void;
  setRenamingFrame: React.Dispatch<React.SetStateAction<string | null>>;
  rename: () => void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !board.current?.getClientRects().length ||
        (target && target !== document.body && !target.closest(".agents-canvas"))
      )
        return;
      // Fields, readable errors and popup owners consume their own keys, including navigation and copying.
      if (
        target?.closest(
          "input, textarea, select, .canvas-error-details, [contenteditable]:not([contenteditable='false']), [role='dialog'], [role='menu'], [role='listbox']",
        )
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyA" && !target?.closest(".react-flow, .iso-board"))
        return;
      const onBoard = !target || target === document.body || Boolean(target.closest(".react-flow, .iso-board"));
      const editingKey =
        ((event.ctrlKey || event.metaKey) &&
          ["KeyA", "KeyZ", "KeyY", "KeyC", "KeyX", "KeyV", "KeyD"].includes(event.code)) ||
        ["Delete", "Backspace", "Home", "F2"].includes(event.key);
      if (!onBoard && !editingKey) return;
      if (event.key !== "Escape" && (boxDrag.current || cutter.current || nodeDrag.current || connectFrom.current))
        return;
      const ctrl = event.ctrlKey || event.metaKey,
        plain = !ctrl && !event.altKey && !event.shiftKey;
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        take();
        if (boxDrag.current) {
          setSelection(boxDrag.current.previous);
          boxDrag.current = null;
          setSelectionBox(null);
          setStroke(null);
          setLasso(false);
        } else if (cutter.current) {
          cutter.current.cancelled = true;
          setStroke(null);
        } else if (nodeDrag.current) {
          nodeDrag.current.cancelled = true;
          setGraph(nodeDrag.current.before);
          setInsertWire(null);
        } else if (flowStore.getState().connection.inProgress || connectFrom.current) {
          connectionCancelled.current = true;
          connectFrom.current = null;
          flowStore.getState().cancelConnection();
        } else if (iso && isoController.current?.cancelGesture()) {
          /* the wire's original stays */
        } else if (lasso) setLasso(false);
        else setSelection([]);
      } else if (ctrl && !event.altKey && event.key === "Enter") {
        take();
        if (event.shiftKey) previewRun();
        else void start();
      } else if (ctrl && !event.altKey && event.code === "KeyG") {
        take();
        if (event.shiftKey) ungroup();
        else frameSelection();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyI") {
        take();
        setSelection(
          graph.nodes.filter(node => node.type !== "mother" && !selection.includes(node.id)).map(node => node.id),
        );
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyF") {
        take();
        setFinding("");
        setFindIndex(0);
        setMenu(null);
        setAdding(null);
      } else if (event.altKey && event.shiftKey && !ctrl && event.code === "KeyT") {
        take();
        tidySelection();
      } else if (event.altKey && event.shiftKey && !ctrl && event.code === "KeyM") {
        take();
        toggleMinimap();
      } else if (event.altKey && !ctrl && event.key.startsWith("Arrow")) {
        take();
        nudge(event.key, event.shiftKey ? 200 : 20);
      } else if (event.shiftKey && !event.altKey && !ctrl && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        take();
        setSelection(linkedIds(graph, selection, event.key === "ArrowLeft" ? "upstream" : "downstream"));
      } else if (event.shiftKey && !event.altKey && !ctrl && event.code === "KeyA") {
        take();
        openAdder();
      } else if (event.shiftKey && !event.altKey && !ctrl && event.code === "KeyS") {
        take();
        checkpoint();
        addNote(pointerPosition());
      } else if (!ctrl && !event.altKey && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        take();
        keyboardMenu();
      } else if (plain && event.code === "KeyL") {
        take();
        setLasso(true);
        setMenu(null);
        setAdding(null);
      } else if (plain && event.code === "KeyM") {
        take();
        mute();
      }
      // A focused isometric agent walks the run order itself (components/agents-iso.tsx).
      else if (plain && event.key.startsWith("Arrow") && !target?.closest(".iso-node")) {
        take();
        focusNearest(event.key);
      } else if (
        !ctrl &&
        !event.altKey &&
        (event.key === "+" || event.code === "NumpadAdd" || event.code === "Equal")
      ) {
        take();
        zoom(1.25);
      } else if (!ctrl && !event.altKey && (event.key === "-" || event.code === "NumpadSubtract")) {
        take();
        zoom(1 / 1.25);
      } else if (plain && ["Digit0", "Numpad0"].includes(event.code)) {
        take();
        zoom(0);
      } else if (plain && ["Period", "NumpadDecimal"].includes(event.code)) {
        take();
        frameView();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyA") {
        take();
        setSelection(graph.nodes.filter(node => node.type !== "mother").map(node => node.id));
      } else if (plain && event.key === "Tab") {
        take();
        openAdder();
      } else if (!ctrl && !event.altKey && event.shiftKey && event.key === "Tab") {
        take();
        focusPrevious();
      } else if (plain && event.code === "KeyA") {
        take();
        addAgent(undefined, selected ? { id: selected.id, as: "target" } : undefined);
      } else if (plain && event.code === "KeyF") {
        take();
        frameView();
      } else if (plain && event.code === "Space") {
        take();
        setAdding(null);
        setMenu(null);
        setPatternCommand("");
      } else if (plain && event.key === "Enter" && selected) {
        take();
        setDashboardId(selected.id);
      } else if (ctrl && !event.altKey && event.code === "KeyZ") {
        take();
        if (event.shiftKey) redo();
        else undo();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyY") {
        take();
        redo();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyC" && selection.length) {
        take();
        copy();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyX" && selection.length) {
        take();
        copy();
        remove(selection);
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyV" && clipboard.current) {
        take();
        paste();
      } else if (ctrl && !event.shiftKey && !event.altKey && event.code === "KeyD" && selection.length) {
        take();
        duplicate();
      } else if (ctrl && !event.altKey && !event.shiftKey && event.key === "Delete" && selection.length) {
        take();
        removeKeepingFlow(selection);
      } else if (plain && ["Delete", "Backspace"].includes(event.key) && selection.length) {
        take();
        remove(selection.filter(id => id !== MOTHER && id !== FATHER));
      } else if (plain && event.key === "Home") {
        take();
        fitAll();
      } else if (plain && event.key === "F2") {
        take();
        const frame = graph.frames?.find(frame => selection.includes(frame.id));
        if (frame) setRenamingFrame(frame.id);
        else if (selected) rename();
      } else if (event.key.length === 1 && !ctrl && !event.altKey) {
        take();
        openAdder(undefined, undefined, undefined, event.key);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });
  return {};
}

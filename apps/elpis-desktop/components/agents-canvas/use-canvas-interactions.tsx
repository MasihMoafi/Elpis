"use client";

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { type Node } from "@xyflow/react";
import { deleteKeepingFlow } from "@/lib/canvas-delete-flow";
import { MOTHER } from "@/lib/canvas";
import { over } from "./run-state";
import { OVERVIEW } from "./constants";
import { useCanvasPolling } from "./use-canvas-polling";
import { useCanvasClipboard } from "./use-canvas-clipboard";
import { canvasNavigation } from "./canvas-navigation";
import { canvasMenus } from "./canvas-menus";
import { canvasDragging } from "./canvas-dragging";
import { canvasMenuItems } from "./canvas-menu-items";
import type { CanvasBoardModel } from "./use-canvas-board-model";

export function useCanvasInteractions(previous: CanvasBoardModel) {
  const {
    graph,
    setSelection,
    board,
    setAdding,
    setMenu,
    setFlowEdit,
    flowEdit,
    checkpoint,
    setGraph,
    selection,
    suppressContext,
    room,
    setNotice,
    limit,
    place,
    agents,
    isoBoxes,
    ISO_NODE,
    pointer,
    flow,
    iso,
    isoController,
    viewMiddle,
    reveal,
    order,
    tidy,
    boxes,
    NODE_W,
    NODE_H,
    starting,
    planning,
    run,
    chosen,
    setRunTargets,
    cutter,
    nodeDrag,
    latest,
    setInsertWire,
    restored,
    history,
    setDeleted,
    nameFocus,
    selected,
    panelOpen,
    nameField,
    setNameFocus,
    removeWire,
    openAdder,
    setKind,
    addNote,
    remove,
    setDashboardId,
    ready,
    setStates,
    setSavedRecord,
    setClashes,
    said,
    reports,
    decisionsSeen,
    setLog,
    setRun,
    forward,
  } = previous;
  // The mouse as in DaVinci's Fusion and 3ds Max's Slate: left-drag on empty board draws a selection box, middle-drag
  // pans, scroll pans and Ctrl/Cmd+scroll zooms at the pointer, and agents snap to a 20 px grid. A plain click picks that one node even
  // inside a selection; Shift or Ctrl adds or removes it; a press moves nodes only past 5 px, so a hand's wobble is a
  // click. React Flow's Shift-to-box key is off: it turned every Shift+click into an empty box that dropped the selection.
  const dragged = useRef(false);
  const onNodeClick = (event: ReactMouseEvent, node: Node) => {
    if (dragged.current || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const frame = graph.frames?.find(frame => frame.id === node.id);
    setSelection(frame ? [...frame.nodeIds, frame.id] : [node.id]);
  };
  const { menuAt, editFlow, onNodeContextMenu, onPaneContextMenu, onEdgeClick, saveFlow } = canvasMenus({
    board,
    setAdding,
    setMenu,
    setFlowEdit,
    flowEdit,
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    setGraph,
    graph,
    setSelection,
    selection,
    suppressContext,
  });
  const { copy, clipboard, paste, duplicate } = useCanvasClipboard({
    graph,
    room,
    setNotice,
    limit,
    place,
    agents,
    isoBoxes,
    ISO_NODE,
    checkpoint,
    setGraph,
    setSelection,
    selection,
    pointer,
    flow,
  });
  const {
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
  } = canvasNavigation({
    board,
    pointer,
    iso,
    isoController,
    flow,
    viewMiddle,
    selection,
    fitAll: (...args: Parameters<typeof fitAll>) => fitAll(...args),
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
  });
  const previewRun = () => {
    if (starting || planning || (run && !over(run))) {
      setNotice("Wait for this run to finish before starting another.");
      return;
    }
    const targets = chosen.filter(node => !node.data.muted).map(node => node.id);
    if (!targets.length) {
      setNotice("Select an enabled agent to run with its required ancestors.");
      return;
    }
    setRunTargets(targets);
    setMenu(null);
    setAdding(null);
    setNotice("");
  };
  const keyboardMenu = () => {
    const id = selection.find(id => graph.nodes.some(node => node.id === id));
    const target = [
      ...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node, .iso-node") ?? []),
    ]
      .find(node => node.dataset.id === id)
      ?.getBoundingClientRect();
    const bounds = board.current!.getBoundingClientRect(),
      point = target
        ? { clientX: target.x + target.width / 2, clientY: target.y + target.height / 2 }
        : { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
    const at = menuAt(point, 8);
    if (!at) return;
    setMenu(
      id === MOTHER
        ? { ...at, kind: "mother" }
        : id
          ? { ...at, kind: "nodes", ids: selection }
          : { ...at, kind: "board" },
    );
  };
  const { cutCrossed, beginDrag, moveIso, finishDrag, insertionAt } = canvasDragging({
    board,
    cutter,
    graph,
    nodeDrag,
    selection,
    checkpoint,
    dragged,
    agents,
    setSelection,
    latest,
    setNotice,
    setInsertWire,
    restored,
    history,
    setGraph,
    isoController,
  });
  // Contract every link kind across removed agents; Mother links remain derived from the surviving roots.
  const removeKeepingFlow = (ids: string[]) => {
    const gone = graph.nodes.filter(node => node.type !== "mother" && ids.includes(node.id));
    if (!gone.length) return;
    checkpoint();
    const next = deleteKeepingFlow(graph, ids);
    setNotice("");
    setDeleted(
      `${gone.map(node => (node.type === "agent" ? node.data.title : "note")).join(", ")} · kept ${next.keptLinks} ${next.keptLinks === 1 ? "link" : "links"}`,
    );
    setGraph({
      ...next.graph,
      frames: next.graph.frames
        ?.map(frame => ({ ...frame, nodeIds: frame.nodeIds.filter(id => !ids.includes(id)) }))
        .filter(frame => frame.nodeIds.length),
    });
    setSelection([]);
  };
  const fitAll = () => {
    if (iso) isoController.current?.fit();
    else void flow.fitView({ ...OVERVIEW, duration: 250 });
  };
  useEffect(() => {
    if (nameFocus && selected?.id === nameFocus && panelOpen && nameField.current) {
      nameField.current.focus();
      nameField.current.select();
      setNameFocus(null);
    }
  }, [nameFocus, selected?.id, panelOpen]);
  const rename = () => {
    const take = () => {
      nameField.current?.focus();
      nameField.current?.select();
    };
    if (nameField.current) take();
    else setTimeout(take, 0);
  };
  const { menuView } = canvasMenuItems({
    titleOf: (...args: Parameters<typeof titleOf>) => titleOf(...args),
    removeWire,
    menuAt,
    setFlowEdit,
    openAdder,
    setKind,
    setSelection,
    clipboard,
    checkpoint,
    addNote,
    iso,
    isoController,
    flow,
    paste,
    tidySelection,
    fitAll,
    graph,
    remove,
    mute,
    previewRun,
    frameSelection,
    ungroup,
    copy,
    setDashboardId,
    rename,
    duplicate,
    removeKeepingFlow,
  });
  const titleOf = (id: string) => agents.find(node => node.id === id)?.data.title || "Untitled";
  useCanvasPolling({
    ready,
    run,
    setStates,
    setSavedRecord,
    setClashes,
    said,
    setNotice,
    titleOf: (...args: Parameters<typeof titleOf>) => titleOf(...args),
    reports,
    agents,
    decisionsSeen,
    setGraph,
    setLog,
    setRun,
  });
  forward.focusBoard = focusBoard;
  forward.fitAll = fitAll;
  return {
    ...previous,
    onNodeClick,
    editFlow,
    onNodeContextMenu,
    onPaneContextMenu,
    onEdgeClick,
    saveFlow,
    copy,
    clipboard,
    paste,
    duplicate,
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
    previewRun,
    keyboardMenu,
    cutCrossed,
    beginDrag,
    moveIso,
    finishDrag,
    insertionAt,
    removeKeepingFlow,
    fitAll,
    rename,
    menuView,
    titleOf,
  };
}

export type CanvasInteractions = ReturnType<typeof useCanvasInteractions>;

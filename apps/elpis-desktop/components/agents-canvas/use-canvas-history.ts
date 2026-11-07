import { useEffect, useRef } from "react";
import { type CanvasGraph } from "@/lib/canvas";
import type * as React from "react";
import { BoardMenu } from "./types";
import { shapeKey, editKey } from "./graph-key";

export function useCanvasHistory({ graph, nodeDrag, setGraph, setSelection, setMenu, setDeleted }: {
  graph: CanvasGraph;
  nodeDrag: React.RefObject<{ before: CanvasGraph; id: string; ids: string[]; extract: boolean; cancelled: boolean; } | null>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  setDeleted: React.Dispatch<React.SetStateAction<string | null>>
}) {
  // Undo and redo (Ctrl+Z; Ctrl+Shift+Z or Ctrl+Y): a burst of changes (typing a name, dragging an agent) is one step
  // once it settles.
  const history = useRef({ past: [] as CanvasGraph[], future: [] as CanvasGraph[], settled: graph, restoring: false });
  useEffect(() => {
    const steps = history.current;
    if (nodeDrag.current && !nodeDrag.current.cancelled) return;
    if (steps.restoring) { steps.restoring = false; steps.settled = graph; return; }
    if (editKey(graph) === editKey(steps.settled)) { steps.settled = graph; return; }
    const timer = setTimeout(() => { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; steps.settled = graph; }, 350);
    return () => clearTimeout(timer);
  }, [graph]);
  // A structural action begins a new undo step, even when the preceding edit is still in its typing burst.
  const checkpoint = () => {
    const steps = history.current;
    if (editKey(graph) !== editKey(steps.settled)) { steps.past = [...steps.past, steps.settled].slice(-100); steps.future = []; }
    steps.settled = graph;
  };
  // Which workflow the board is (its id and saved name) changes with a run or a rename elsewhere, never by an edit on the
  // board: it goes into every undo step instead of becoming one, so Ctrl+Z undoes his last edit and keeps the workflow.
  const setIdentity = (patch: Partial<Pick<CanvasGraph, "workflowId" | "name">>) => {
    const steps = history.current, from = graph.workflowId, apply = (item: CanvasGraph) => item.workflowId === from ? { ...item, ...patch } : item;
    steps.past = steps.past.map(apply); steps.future = steps.future.map(apply); steps.settled = apply(steps.settled); setGraph(apply);
  };
  const restored = useRef(false);
  const restore = (next: CanvasGraph) => { history.current.restoring = true; restored.current = shapeKey(next) !== shapeKey(graph); setGraph(next); setSelection(current => current.filter(id => next.nodes.some(node => node.id === id) || next.edges.some(edge => edge.id === id) || next.frames?.some(frame => frame.id === id))); setMenu(null); };
  const undo = () => {
    setDeleted(null);
    const steps = history.current;
    // Changes not yet settled are the step undone.
    if (editKey(graph) !== editKey(steps.settled)) { steps.future = [graph]; restore(steps.settled); return; }
    const previous = steps.past.pop();
    if (previous) { steps.future.push(graph); restore(previous); }
  };
  const redo = () => { const steps = history.current, next = steps.future.pop(); if (next) { steps.past.push(graph); restore(next); } };
  return { setIdentity, checkpoint, restored, redo, undo, history };
}
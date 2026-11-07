import { type Node, type XYPosition } from "@xyflow/react";
import { isoLayout } from "@/lib/iso";
import { type IsoController } from "@/components/agents-iso";
import { extractAgent, insertAgent, segmentsCross } from "@/lib/canvas-editing";
import { waves, type CanvasGraph, type CanvasNode } from "@/lib/canvas";
import type * as React from "react";
import { shapeKey } from "./graph-key";

export function canvasDragging({ board, cutter, graph, nodeDrag, selection, checkpoint, dragged, agents, setSelection, latest, setNotice, setInsertWire, restored, history, setGraph, isoController }: {
  board: React.RefObject<HTMLDivElement | null>;
  cutter: React.RefObject<{ points: XYPosition[]; ids: Set<string>; cancelled?: boolean; } | null>;
  graph: CanvasGraph;
  nodeDrag: React.RefObject<{ before: CanvasGraph; id: string; ids: string[]; extract: boolean; cancelled: boolean; } | null>;
  selection: string[];
  checkpoint: () => void;
  dragged: React.RefObject<boolean>;
  agents: Extract<CanvasNode, { type: "agent" }>[];
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  latest: React.RefObject<CanvasGraph>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  setInsertWire: React.Dispatch<React.SetStateAction<string | null>>;
  restored: React.RefObject<boolean>;
  history: React.RefObject<{ past: CanvasGraph[]; future: CanvasGraph[]; settled: CanvasGraph; restoring: boolean; }>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  isoController: React.RefObject<IsoController | null>
}) {
  // Hit testing follows the paths actually rendered by either view, in screen pixels.
  const wirePaths = () => [...(board.current?.querySelectorAll<SVGPathElement>(".react-flow__edge:not(.canvas-edge-mother) .react-flow__edge-path, .iso-link:not([data-mother='true']):not([data-father='true']) .iso-wire") ?? [])];
  const pathPoints = (path: SVGPathElement) => {
    const matrix = path.getScreenCTM(); if (!matrix) return [];
    const length = path.getTotalLength(), count = Math.max(1, Math.ceil(length / 8));
    return Array.from({ length: count + 1 }, (_, index) => { const at = path.getPointAtLength(length * index / count), point = new DOMPoint(at.x, at.y).matrixTransform(matrix); return { x: point.x, y: point.y }; });
  };
  const pathId = (path: SVGPathElement) => path.closest<SVGGElement>(".react-flow__edge, .iso-link")?.dataset.id;
  const cutCrossed = (from: XYPosition, to: XYPosition) => {
    for (const path of wirePaths()) {
      const points = pathPoints(path), id = pathId(path);
      if (id && points.some((point, index) => { const previous = points[index - 1]; return previous && segmentsCross(from, to, previous, point); })) cutter.current?.ids.add(id);
    }
  };
  const insertionAt = (id: string, current = graph) => {
    if (nodeDrag.current && nodeDrag.current.ids.filter(id => current.nodes.some(node => node.id === id && node.type === "agent")).length !== 1) return null;
    const element = [...(board.current?.querySelectorAll<HTMLElement | SVGGElement>(".react-flow__node-agent, .iso-node[data-kind='agent']") ?? [])].find(node => node.dataset.id === id);
    const box = element?.getBoundingClientRect(); if (!box) return null;
    for (const path of wirePaths()) {
      const edge = current.edges.find(edge => edge.id === pathId(path));
      if (!edge || !insertAgent(current, id, edge)) continue;
      if (pathPoints(path).some(at => at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom)) return edge;
    }
    return null;
  };
  const beginDrag = (id: string, extract: boolean) => {
    const frame = graph.frames?.find(frame => frame.id === id), ids = frame ? [...frame.nodeIds, id] : selection.includes(id) ? selection : [id];
    checkpoint(); dragged.current = true; nodeDrag.current = { before: graph, id, ids, extract: extract && agents.some(node => node.id === id), cancelled: false }; setSelection(ids);
  };
  const finishDrag = (shift: boolean, moved: Node[] = []) => {
    const start = nodeDrag.current; if (!start) return;
    let next = start.cancelled ? start.before : { ...latest.current, nodes: latest.current.nodes.map(node => {
      const position = moved.find(item => item.id === node.id)?.position; return position ? { ...node, position } : node;
    }) };
    if (!start.cancelled && start.extract) {
      const extracted = start.ids.filter(id => agents.some(node => node.id === id)).length === 1 ? extractAgent(next, start.id) : null;
      if (extracted) next = extracted; else setNotice("Extract needs one ordinary input and output at most. The wiring was kept.");
    } else if (!start.cancelled && shift) { const edge = insertionAt(start.id, next); if (edge) next = insertAgent(next, start.id, edge) ?? next; }
    nodeDrag.current = null; setInsertWire(null); restored.current = shapeKey(next) !== shapeKey(start.before);
    const steps = history.current;
    if (!start.cancelled && JSON.stringify(next) !== JSON.stringify(start.before)) { steps.past = [...steps.past, start.before].slice(-100); steps.future = []; }
    steps.settled = next; steps.restoring = true; setGraph(next);
    setTimeout(() => { dragged.current = false; });
  };
  const moveIso = (id: string, dx: number, dy: number) => {
    const start = nodeDrag.current; if (!start || start.cancelled) return;
    const ids = start.before.frames?.find(frame => frame.id === id)?.nodeIds ?? start.ids;
    const scene = isoLayout(start.before, waves(start.before)); isoController.current?.keepView();
    setGraph({ ...start.before, nodes: start.before.nodes.map(node => {
      const at = scene.find(item => item.id === node.id)?.at ?? node.isoPosition ?? node.position;
      return { ...node, isoPosition: ids.includes(node.id) ? { x: at.x + dx, y: at.y + dy } : at,
        position: ids.includes(node.id) ? { x: node.position.x + dx, y: node.position.y + dy } : node.position };
    }) });
  };
  return { cutCrossed, beginDrag, moveIso, finishDrag, insertionAt };
}
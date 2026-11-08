import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { frameBounds } from "@/lib/canvas-editing";
import {
  FATHER,
  MOTHER,
  waits,
  checkOf,
  type AgentData,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type CatalogModel,
  type TaskStatus,
} from "@/lib/canvas";
import type * as React from "react";
import { HandleEnd, MotherData, MenuAt, Props } from "./types";
import { plainActivity } from "./run-state";
import { ABOVE_AGENTS } from "./constants";
import { FrameData } from "./nodes";
import { flowLabelPositions } from "./edges";

export function useCanvasElements({
  agents,
  his,
  graph,
  fatherState,
  split,
  limit,
  renamingFrame,
  setSelection,
  checkpoint,
  setGraph,
  setRenamingFrame,
  focusBoard,
  selection,
  runState,
  onHandle,
  identity,
  states,
  clashes,
  modelLabel,
  order,
  onQuick,
  setText,
  models,
  catalog,
  wireMenu,
  insertWire,
}: {
  agents: Extract<CanvasNode, { type: "agent" }>[];
  his: Set<string>;
  graph: CanvasGraph;
  fatherState: "running" | "failed" | "cancelled" | "idle" | "finished";
  split: { mother: string[]; father: string[] };
  limit: number;
  renamingFrame: string | null;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  checkpoint: () => void;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setRenamingFrame: React.Dispatch<React.SetStateAction<string | null>>;
  focusBoard: () => void | undefined;
  selection: string[];
  runState: "running" | "failed" | "cancelled" | "idle" | "finished";
  onHandle: (id: string, end: HandleEnd, event: ReactMouseEvent) => void;
  identity: WorkflowIdentity | undefined;
  states: { [x: string]: { status: TaskStatus; chat: string | null; activity?: string | undefined } };
  clashes: Record<string, string[]>;
  modelLabel: (data: AgentData) => string;
  order: Map<string, number>;
  onQuick: (id: string) => void;
  setText: (id: string, text: string) => void;
  models: Props["models"];
  catalog: CatalogModel[];
  wireMenu: (MenuAt & { kind: "wire"; edge: CanvasEdge }) | null;
  insertWire: string | null;
}) {
  // React Flow shows a node once its size is known; the Father is not in the saved board, so his size is kept here.
  const [fatherSize, setFatherSize] = useState<{ width: number; height: number } | null>(null);
  const fatherRoots = agents.filter(
    node =>
      his.has(node.id) && !graph.edges.some(edge => waits(edge) && edge.target === node.id && his.has(edge.source)),
  );
  const fatherNode: Node | null = fatherRoots.length
    ? {
        id: FATHER,
        type: "father",
        deletable: false,
        selectable: false,
        draggable: false,
        // Under the Mother: like her, he starts his agents, so he sits in her column.
        position: (({ x, y }) => ({ x, y: y + 140 }))(
          graph.nodes.find(node => node.type === "mother")?.position ?? { x: 0, y: 0 },
        ),
        ...(fatherSize ? { measured: fatherSize } : {}),
        data: { run: fatherState, children: split.father.length, limit } satisfies MotherData,
      }
    : null;
  // A reloaded saved run replaces the agents without their measured sizes; React Flow hides an unmeasured agent and,
  // its size unchanged, never measures it again (2 Nov: the steps vanished). Every agent keeps its last size.
  const sizes = useRef(new Map<string, { width: number; height: number }>());
  const nodesWithFather = (list: Node[]) => {
    const sized = list.map(node => {
      const measured = sizes.current.get(node.id);
      return node.measured || !measured ? node : { ...node, measured };
    });
    return fatherNode ? [...sized, fatherNode] : sized;
  };
  const frames: Node[] = (graph.frames ?? []).flatMap(frame => {
    const members = graph.nodes.filter(node => frame.nodeIds.includes(node.id));
    if (!members.length) return [];
    const bounds = frameBounds(members);
    return [
      {
        id: frame.id,
        type: "frame",
        position: { x: bounds.x, y: bounds.y },
        style: { width: bounds.width, height: bounds.height },
        zIndex: -1,
        selectable: false,
        dragHandle: ".canvas-frame-title",
        data: {
          title: frame.title,
          renaming: renamingFrame === frame.id,
          onPick: () => setSelection([...frame.nodeIds, frame.id]),
          onName: title => {
            if (title) {
              checkpoint();
              setGraph(current => ({
                ...current,
                frames: current.frames?.map(item => (item.id === frame.id ? { ...item, title } : item)),
              }));
            }
            setRenamingFrame(null);
            focusBoard();
          },
        } satisfies FrameData,
      },
    ];
  });
  const nodes = useMemo<Node[]>(
    () => [
      ...frames,
      ...nodesWithFather(
        graph.nodes.map(node =>
          node.type === "mother"
            ? {
                ...node,
                deletable: false,
                selected: selection.includes(MOTHER),
                data: { run: runState, children: agents.length, limit, onHandle, identity } satisfies MotherData,
              }
            : {
                ...node,
                selected: selection.includes(node.id),
                data:
                  node.type === "agent"
                    ? {
                        ...node.data,
                        status: states[node.id]?.status,
                        check: states[node.data.join ? node.id : checkOf(node.id)]?.status,
                        clash: clashes[node.id],
                        modelLabel: modelLabel(node.data),
                        activity: states[node.id]?.activity || plainActivity(node.data.instruction) || node.data.title,
                        wave: order.get(node.id),
                        onHandle,
                        onQuick,
                      }
                    : { ...node.data, onText: setText },
              },
        ),
      ),
    ],
    [
      graph,
      identity,
      renamingFrame,
      selection,
      states,
      clashes,
      models,
      order,
      runState,
      fatherState,
      limit,
      catalog.length,
    ],
  );
  const flowLabels = useMemo(
    () =>
      flowLabelPositions(
        nodes.filter(node => node.type !== "frame"),
        graph.edges,
      ),
    [nodes, graph.edges],
  );
  // A selected wire sits above the agents so its ends can be dragged to reconnect (af885eb49). Only the wire itself:
  // React Flow's elevateEdgesOnSelect also lifts every wire of a selected agent, and those then cover the dot of the
  // agent at their other end, so a new wire could not be drawn from it.
  const edges = useMemo<Edge[]>(
    () => [
      // The Mother's wires: she starts every agent of the first wave.
      ...agents
        .filter(node => order.get(node.id) === 1 && !his.has(node.id))
        .map((node, index) => ({
          id: `${MOTHER}->${node.id}`,
          source: MOTHER,
          target: node.id,
          type: "mother",
          markerEnd: { type: MarkerType.ArrowClosed },
          className: "canvas-edge-mother",
          selectable: false,
          deletable: false,
          reconnectable: false,
          focusable: false,
          selected: wireMenu?.edge.id === `${MOTHER}->${node.id}`,
          data: { trunk: index === 0, label: graph.motherFlow, live: states[node.id]?.status === "running" },
        })),
      // The Father's wires: he starts his agents that wait for none of his others.
      ...fatherRoots.map(node => ({
        id: `${FATHER}->${node.id}`,
        source: FATHER,
        target: node.id,
        type: "default",
        markerEnd: { type: MarkerType.ArrowClosed },
        className: "canvas-edge-mother",
        selectable: false,
        deletable: false,
        reconnectable: false,
        focusable: false,
        interactionWidth: 0,
        data: { live: states[node.id]?.status === "running" },
      })),
      ...graph.edges.map(edge => {
        // A wire goes live once its first agent's check passed and the second agent is running.
        const from = states[checkOf(edge.source)]?.status,
          to = states[edge.target]?.status,
          live = waits(edge) && from === "succeeded" && to === "running";
        if (edge.kind === "alongside") {
          const selected = wireMenu?.edge.id === edge.id || selection.includes(edge.id);
          return {
            ...edge,
            type: "default",
            selected,
            zIndex: selected ? ABOVE_AGENTS : 0,
            data: { alongside: true, ...flowLabels.get(edge.id) },
            className: "canvas-edge-alongside",
          };
        }
        const selected = wireMenu?.edge.id === edge.id || insertWire === edge.id || selection.includes(edge.id);
        const className =
          from === "failed" || to === "blocked"
            ? "canvas-edge-cut"
            : live
              ? "canvas-edge-live"
              : from === "succeeded"
                ? "canvas-edge-done"
                : undefined;
        return {
          ...edge,
          type: "default",
          markerEnd: { type: MarkerType.ArrowClosed },
          selected,
          zIndex: selected ? ABOVE_AGENTS : 0,
          data: { live, ...flowLabels.get(edge.id) },
          ...(className ? { className } : {}),
        };
      }),
    ],
    [graph.edges, graph.nodes, graph.motherFlow, states, order, wireMenu, flowLabels, insertWire, selection],
  );
  return { sizes, setFatherSize, frames, nodes, edges };
}

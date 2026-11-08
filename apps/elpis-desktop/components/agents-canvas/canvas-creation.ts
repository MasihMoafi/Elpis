import type { IsoPlace } from "@/lib/iso";
import { useReactFlow, type FinalConnectionState, type XYPosition } from "@xyflow/react";
import { isoLayout } from "@/lib/iso";
import { type IsoController } from "@/components/agents-iso";
import {
  COLUMN,
  FATHER,
  MOTHER,
  newAgents,
  newId,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
} from "@/lib/canvas";
import type * as React from "react";
import { Adding, BoardMenu } from "./types";

export function canvasCreation({
  room,
  setNotice,
  limit,
  graph,
  boxes,
  agents,
  place,
  NODE_W,
  NODE_H,
  iso,
  order,
  split,
  isoBoxes,
  ISO_NODE,
  isoController,
  setGraph,
  setSelection,
  reveal,
  checkpoint,
  restored,
  flow,
  setNameFocus,
  setMenu,
  setAdding,
  board,
  GAP,
  freeAt,
  pointer,
  reconnecting,
  connectFrom,
  connectionCancelled,
  connect,
}: {
  room: number;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  limit: number;
  graph: CanvasGraph;
  boxes: () => { x: number; y: number; w: number; h: number }[];
  agents: Extract<CanvasNode, { type: "agent" }>[];
  place: (
    near?: XYPosition,
    taken?: { x: number; y: number; w: number; h: number }[],
    size?: { w: number; h: number },
    closest?: boolean,
  ) => { x: number; y: number };
  NODE_W: number;
  NODE_H: number;
  iso: boolean;
  order: Map<string, number>;
  split: { mother: string[]; father: string[] };
  isoBoxes: (scene?: IsoPlace[]) => { x: number; y: number; w: number; h: number }[];
  ISO_NODE: { w: number; h: number; top: number };
  isoController: React.RefObject<IsoController | null>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  reveal: (ids: string[]) => NodeJS.Timeout;
  checkpoint: () => void;
  restored: React.RefObject<boolean>;
  flow: ReturnType<typeof useReactFlow>;
  setNameFocus: React.Dispatch<React.SetStateAction<string | null>>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  setAdding: React.Dispatch<React.SetStateAction<Adding | null>>;
  board: React.RefObject<HTMLDivElement | null>;
  GAP: number;
  freeAt: (
    x: number,
    y: number,
    taken?: { x: number; y: number; w: number; h: number }[],
    size?: { w: number; h: number },
  ) => boolean;
  pointer: React.RefObject<XYPosition | null>;
  reconnecting: React.RefObject<string | null>;
  connectFrom: React.RefObject<XYPosition | null>;
  connectionCancelled: React.RefObject<boolean>;
  connect: (source: string, target: string, kind?: CanvasEdge["kind"]) => void;
}) {
  const addAgents = (
    count: number,
    choice: { model: string | null; provider?: string | null; effort?: string | null },
    where: Partial<Pick<Adding, "at" | "isoAt" | "from" | "between">> = {},
    tasks: string[] = [],
  ) => {
    if (!room) {
      setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`);
      return;
    }
    // Beside the agent they came from (right if they wait for it, left if it waits for them), else where asked, else in
    // the first wave's column; each in the next free slot below the last.
    const { from, between } = where,
      source = from && graph.nodes.find(node => node.id === from.id);
    const spot = source
      ? { x: source.position.x + (from!.as === "target" ? COLUMN : -COLUMN), y: source.position.y }
      : where.at;
    const taken = boxes();
    const made = newAgents(
      Math.min(count, room),
      choice,
      { x: 0, y: 0 },
      tasks,
      agents.map(node => node.data.title),
    ).map(node => {
      const at = place(spot, taken);
      taken.push({ ...at, w: NODE_W, h: NODE_H });
      return { ...node, position: at };
    });
    // In the isometric view every agent keeps the spot it is drawn at, applied to the latest board.
    let pinned: Map<string, XYPosition> | null = null;
    if (iso) {
      const scene = isoLayout(graph, order, split.father.length ? FATHER : undefined),
        occupied = isoBoxes(scene);
      const origin = scene.find(item => item.id === from?.id)?.at;
      const at =
        where.isoAt ??
        (origin ? { x: origin.x + (from?.as === "source" ? -COLUMN : COLUMN), y: origin.y } : { x: 300, y: 0 });
      for (const node of made) {
        const slot = place(
          { x: at.x - ISO_NODE.w / 2, y: at.y - ISO_NODE.top },
          occupied,
          ISO_NODE,
          Boolean(where.isoAt),
        );
        node.isoPosition = { x: slot.x + ISO_NODE.w / 2, y: slot.y + ISO_NODE.top };
        occupied.push({ ...slot, w: ISO_NODE.w, h: ISO_NODE.h });
      }
      pinned = new Map(scene.map(item => [item.id, item.at]));
      isoController.current?.keepView();
    }
    const wire = (source: string, target: string) => ({ id: `${source}->${target}`, source, target });
    // On a wire, the new agents take its place: each waits for its first agent and feeds its second. From a dot or a
    // dropped wire, they join that agent. The Mother's wires are implied, never drawn.
    const wires = between
      ? made.flatMap(node => [
          ...(between.source === MOTHER ? [] : [wire(between.source, node.id)]),
          wire(node.id, between.target),
        ])
      : from && from.id !== MOTHER
        ? made.map(node => (from.as === "target" ? wire(from.id, node.id) : wire(node.id, from.id)))
        : [];
    setGraph(current => ({
      ...current,
      nodes: [
        ...(pinned
          ? current.nodes.map(node => (pinned!.has(node.id) ? { ...node, isoPosition: pinned!.get(node.id)! } : node))
          : current.nodes),
        ...made,
      ],
      edges: [...current.edges.filter(edge => edge.id !== between?.id), ...wires],
    }));
    setSelection(made.map(node => node.id));
    if (iso) setTimeout(() => isoController.current?.reveal(made.map(node => node.id)), 140);
    else reveal(made.map(node => node.id));
    setNotice(count > room ? `Added ${room}: the limit is ${limit} agents.` : "");
  };
  // Direct creation keeps the requested position even when automatic run-order layout is enabled.
  const addAgent = (client?: XYPosition, from?: Adding["from"]) => {
    if (!room) {
      setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`);
      return;
    }
    checkpoint();
    restored.current = true;
    const source = graph.nodes.find(node => node.id === from?.id);
    const at = client && !iso ? flow.screenToFlowPosition(client) : undefined;
    const near = at
      ? { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 }
      : source
        ? { x: source.position.x + (from?.as === "source" ? -COLUMN : COLUMN), y: source.position.y }
        : viewMiddle();
    const [made] = newAgents(
      1,
      { model: null },
      place(near),
      [],
      agents.map(node => node.data.title),
    );
    if (!made) return;
    let nodes = graph.nodes;
    if (iso) {
      const scene = isoLayout(graph, order, split.father.length ? FATHER : undefined);
      const origin = scene.find(item => item.id === from?.id)?.at;
      const wanted = client
        ? isoController.current!.position(client)
        : origin
          ? { x: origin.x + (from?.as === "source" ? -COLUMN : COLUMN), y: origin.y }
          : { x: 300, y: 0 };
      const position = place(
        { x: wanted.x - ISO_NODE.w / 2, y: wanted.y - ISO_NODE.top },
        isoBoxes(scene),
        ISO_NODE,
        Boolean(client),
      );
      made.isoPosition = { x: position.x + ISO_NODE.w / 2, y: position.y + ISO_NODE.top };
      // Freeze the existing scene so adding a wave does not recenter its neighbours or move the camera.
      nodes = graph.nodes.map(node => {
        const at = scene.find(item => item.id === node.id)?.at;
        return at ? { ...node, isoPosition: at } : node;
      });
      isoController.current?.keepView();
    }
    const sourceId = from?.as === "source" ? made.id : from?.id,
      targetId = from?.as === "source" ? from.id : made.id;
    const wires =
      from && from.id !== MOTHER && from.id !== FATHER
        ? [{ id: `${sourceId}->${targetId}`, source: sourceId!, target: targetId }]
        : [];
    setGraph({ ...graph, nodes: [...nodes, made], edges: [...graph.edges, ...wires] });
    setSelection([made.id]);
    setNameFocus(made.id);
    setMenu(null);
    setAdding(null);
    setNotice("");
    if (iso) setTimeout(() => isoController.current?.reveal([made.id]), 140);
    else reveal([made.id]);
  };
  const viewMiddle = () => {
    const box = board.current?.getBoundingClientRect();
    return box
      ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 100, y: box.top + box.height / 3 })
      : undefined;
  };
  // A note from the toolbar lands in the free spot nearest the middle of the visible board; with none free, it goes
  // below and is brought into view, as new agents are.
  const visibleSpot = (taken = boxes()) => {
    const box = board.current?.querySelector(".react-flow")?.getBoundingClientRect();
    if (!box) return undefined;
    const from = flow.screenToFlowPosition({ x: box.left, y: box.top }),
      to = flow.screenToFlowPosition({ x: box.right, y: box.bottom });
    const mid = { x: (from.x + to.x - NODE_W) / 2, y: (from.y + to.y - NODE_H) / 2 },
      step = Math.max(20, Math.ceil((to.x - from.x) / 1200) * 20);
    let best: XYPosition | undefined;
    for (let x = Math.ceil((from.x + GAP) / step) * step; x + NODE_W + GAP <= to.x; x += step)
      for (let y = Math.ceil((from.y + GAP) / step) * step; y + NODE_H + GAP <= to.y; y += step)
        if (
          freeAt(x, y, taken) &&
          (!best || Math.hypot(x - mid.x, y - mid.y) < Math.hypot(best.x - mid.x, best.y - mid.y))
        )
          best = { x, y };
    return best;
  };
  const addNote = (at?: XYPosition, text = "") => {
    checkpoint();
    const spot = at || iso ? undefined : visibleSpot(),
      position = spot ?? place(at ?? viewMiddle()),
      id = newId("note");
    if (iso) isoController.current?.keepView();
    setGraph(current => ({
      ...current,
      nodes: [
        ...current.nodes,
        { id, type: "note", position, ...(iso ? { isoPosition: at ?? { x: 300, y: 0 } } : {}), data: { text } },
      ],
    }));
    if (!at && !spot && !iso) reveal([id]);
  };
  // Tab, Command, a clicked dot or a context menu opens the command bar, kept inside the board.
  const openAdder = (client?: XYPosition, from?: Adding["from"], between?: CanvasEdge, seed?: string) => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return;
    const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      wanted = client ?? pointer.current ?? middle;
    const point =
      wanted.x >= box.left && wanted.x <= box.right && wanted.y >= box.top && wanted.y <= box.bottom ? wanted : middle;
    // From a dot, the agents go beside it, on the side they connect to.
    const spot = flow.screenToFlowPosition(point),
      at = from
        ? { x: spot.x + (from.as === "target" ? 80 : -300), y: spot.y - 40 }
        : { x: spot.x - (between ? 95 : 0), y: spot.y - 40 };
    // Kept inside the board: as low as the pointer allows, never past the bottom edge (the list scrolls instead).
    const top = Math.max(8, Math.min(point.y - box.top, box.height - 440));
    setAdding({
      at,
      ...(iso ? { isoAt: isoController.current?.position(point) } : {}),
      left: Math.max(8, Math.min(point.x - box.left, box.width - 348)),
      top,
      height: box.height - top - 8,
      ...(from ? { from } : {}),
      ...(between ? { between } : {}),
      ...(seed ? { seed } : {}),
    });
    setMenu(null);
  };
  // Drop on an agent to connect, or on empty board to create a connected agent there.
  // A click without a drag keeps the dot's command menu.
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (reconnecting.current) {
      connectFrom.current = null;
      return;
    }
    if (connectionCancelled.current) {
      connectFrom.current = null;
      return;
    }
    if (state.isValid) {
      connectFrom.current = null;
      return;
    }
    const spot = "changedTouches" in event ? event.changedTouches[0] : event,
      start = connectFrom.current;
    if (!state.fromNode || !state.fromHandle || !start || !spot) return;
    connectFrom.current = null;
    const from = state.fromNode.id,
      over =
        state.toNode?.id ??
        (document.elementFromPoint(spot.clientX, spot.clientY)?.closest(".react-flow__node") as HTMLElement | null)
          ?.dataset.id;
    if (over && over !== from) {
      const [source, target] = state.fromHandle.type === "source" ? [from, over] : [over, from];
      connect(source, target, "altKey" in event && event.altKey ? "alongside" : undefined);
      return;
    }
    const hit = document.elementFromPoint(spot.clientX, spot.clientY);
    if (
      over ||
      !hit?.closest(".react-flow") ||
      hit.closest(".react-flow__edge, .react-flow__panel, .react-flow__controls, .react-flow__minimap") ||
      Math.hypot(spot.clientX - start.x, spot.clientY - start.y) < 8
    )
      return;
    addAgent(
      { x: spot.clientX, y: spot.clientY },
      { id: from, as: state.fromHandle.type === "source" ? "target" : "source" },
    );
  };
  return { openAdder, addNote, addAgent, viewMiddle, onConnectEnd, addAgents };
}

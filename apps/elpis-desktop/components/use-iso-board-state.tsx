"use client";

import type { Props } from "./agents-iso-shared";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  agentCount,
  CHECK_LABEL as CHECK,
  FATHER,
  MOTHER,
  STATUS_LABEL as STATUS,
  checkOf,
  waits,
  waves,
  type AgentData,
  type CanvasEdge,
} from "@/lib/canvas";
import { ISO_STEP, isoFit, isoLayout, isoRoute, type Ground, type Point } from "@/lib/iso";
import { bounds, View, INSET, FIT_ZOOM, ZOOM, State } from "./agents-iso-shared";

export function useIsoBoardState({
  workflowIdentity,
  inserting,
  canConnect,
  onReconnect,
  renamingFrame,
  onFrameName,
  onNoteText,
  onMoveStart,
  onMove,
  onMoveEnd,
  onMovePreview,
  graph,
  father,
  states,
  selected,
  onSelect,
  onOpen,
  dark,
  modelLabel,
  controller,
  onConnect,
  onAdd,
  onCommand,
  onNodeMenu,
  onBoardMenu,
  onWireMenu,
  onWireClick,
  onRename,
}: Props) {
  const root = useRef<HTMLDivElement>(null),
    buttons = useRef(new Map<string, SVGGElement>());
  const blur = `iso-blur-${useId().replace(/[^\w-]/g, "")}`;
  const wave = useMemo(() => waves(graph), [graph]);
  const fathered = father.length > 0,
    his = new Set(father);
  const places = useMemo(() => isoLayout(graph, wave, fathered ? FATHER : undefined), [graph, wave, fathered]);
  const content = useMemo(() => {
    const box = bounds(places);
    for (const node of graph.nodes)
      if (node.type === "note") {
        const at = node.isoPosition ?? node.position;
        box.left = Math.min(box.left, at.x);
        box.top = Math.min(box.top, at.y);
        box.right = Math.max(box.right, at.x + 200);
        box.bottom = Math.max(box.bottom, at.y + 110);
      }
    return box;
  }, [places, graph.nodes]);
  const byId = new Map(places.map(place => [place.id, place])),
    nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const order = places.map(place => place.id),
    agents = places.filter(place => place.kind === "agent");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null),
    [family, setFamily] = useState("sans-serif");
  // The user's own zoom and pan, kept for the layout it was made on: a new layout (an agent added, an architecture
  // loaded) is fitted again.
  const layout = places.map(place => `${place.id}@${place.at.x},${place.at.y}`).join(" ");
  const [moved, setMoved] = useState<{ layout: string; view: View } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null),
    [focused, setFocused] = useState<string | null>(null),
    [focusId, setFocusId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = (id: string) => {
    if (nodes.get(id)?.type === "agent") {
      onSelect([id]);
      setRenaming(id);
    }
  };
  const [wireDrag, setWireDrag] = useState<{
    id: string;
    end: "source" | "target";
    from: Point;
    to: Point;
    edge?: CanvasEdge;
    alongside?: boolean;
  } | null>(null);
  const movingNode = useRef<{ id: string; x: number; y: number; moved: boolean; alt: boolean } | null>(null),
    suppressClick = useRef(false);
  const drag = useRef<{ x: number; y: number; from: View; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    setFamily(getComputedStyle(element).fontFamily);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const view: View =
    (moved?.layout === layout || moved?.layout === "free" ? moved.view : null) ??
    (size ? isoFit(content, size, INSET, FIT_ZOOM) : { zoom: 1, x: 0, y: 0 });
  useLayoutEffect(() => {
    if (moved?.layout === "free") setMoved({ layout, view: moved.view });
  }, [layout, moved]);
  const move = (next: View) => setMoved({ layout, view: next });
  useImperativeHandle(controller, () => ({
    position: client => {
      const box = root.current!.getBoundingClientRect();
      return { x: (client.x - box.left - view.x) / view.zoom, y: (client.y - box.top - view.y) / view.zoom };
    },
    reveal: ids => {
      const picked = places.filter(place => ids.includes(place.id));
      if (!size || !picked.length) return;
      const box = bounds(picked);
      if (
        view.x + view.zoom * box.left < INSET.left ||
        view.x + view.zoom * box.right > size.width - INSET.right ||
        view.y + view.zoom * box.top < INSET.top ||
        view.y + view.zoom * box.bottom > size.height - INSET.bottom
      )
        move(isoFit(box, size, INSET, { min: ZOOM.min, max: view.zoom }));
    },
    cancelGesture: () => {
      if (!wireDrag) return false;
      setWireDrag(null);
      return true;
    },
    zoom: factor => zoomBy(factor ? factor : 1 / view.zoom),
    keepView: () => setMoved({ layout: "free", view }),
    fit: () => setMoved(null),
    frame: () => {
      const picked = places.filter(place => selected.includes(place.id));
      if (size && picked.length) move(isoFit(bounds(picked), size, INSET, { min: ZOOM.min, max: 1.5 }));
    },
  }));
  const zoomBy = (factor: number, at: Point = { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 }) => {
    const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, view.zoom * factor)),
      scale = zoom / view.zoom;
    move({ zoom, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale });
  };
  // The wheel zooms about the pointer; React's wheel listener is passive, so it can't keep the page from scrolling.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest(".iso-hud, input, textarea")) return;
      event.preventDefault();
      const box = element.getBoundingClientRect(),
        unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
      if (event.ctrlKey || event.metaKey)
        zoomBy(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - box.left, y: event.clientY - box.top });
      else move({ ...view, x: view.x - event.deltaX * unit, y: view.y - event.deltaY * unit });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  });
  // Each parent runs while any of her (his) agents or their checks does.
  const hisTasks = new Set(father.flatMap(id => [id, checkOf(id)]));
  const partState = (mine: boolean): State => {
    const tasks = Object.entries(states)
      .filter(([id]) => hisTasks.has(id) === !mine)
      .map(([, task]) => task.status);
    return !tasks.length
      ? "idle"
      : tasks.some(status => status === "running" || status === "pending")
        ? "running"
        : tasks.some(status => status === "failed" || status === "blocked")
          ? "failed"
          : "succeeded";
  };
  const motherState = partState(true),
    fatherState = partState(false);
  const statusOf = (id: string): State =>
    id === MOTHER ? motherState : id === FATHER ? fatherState : (states[id]?.status ?? "idle");
  const titleOf = (id: string) => {
    const node = nodes.get(id);
    return id === MOTHER
      ? "Mother agent"
      : id === FATHER
        ? "Father agent"
        : node?.type === "agent"
          ? node.data.title || "Untitled"
          : id;
  };
  const parentLine = (id: string) =>
    id === MOTHER
      ? ["This run's chat", agentCount(agents.length), STATUS[motherState]]
      : ["His own chat", agentCount(father.length), fatherState === "idle" ? "after her part" : STATUS[fatherState]];
  const describe = (id: string) =>
    id === MOTHER || id === FATHER
      ? parentLine(id)
          .join(", ")
          .replace(/^./, letter => letter.toLowerCase())
      : `${wave.has(id) ? `wave ${wave.get(id)}` : "no wave"}, ${states[id]?.status === "running" && states[id]?.activity ? `now: ${states[id].activity}` : nodes.get(id)?.type === "agent" && (nodes.get(id)!.data as AgentData).muted ? "muted, skipped in runs" : STATUS[statusOf(id)]}, ${CHECK[statusOf(checkOf(id))].toLowerCase()}`;
  const wires: CanvasEdge[] = [
    // The parents' wires, as on the flat board: the Mother starts her agents of the first wave; the Father starts his
    // agents that wait for none of his others.
    ...agents
      .filter(place => wave.get(place.id) === 1 && !his.has(place.id))
      .map(place => ({ id: `${MOTHER}->${place.id}`, source: MOTHER, target: place.id })),
    ...agents
      .filter(
        place =>
          his.has(place.id) &&
          !graph.edges.some(edge => waits(edge) && edge.target === place.id && his.has(edge.source)),
      )
      .map(place => ({ id: `${FATHER}->${place.id}`, source: FATHER, target: place.id })),
    ...graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)),
  ];
  const motherWires = wires.filter(wire => wire.source === MOTHER),
    motherWire = motherWires[0],
    motherPlace = byId.get(MOTHER);
  const junction = motherPlace ? { u: motherPlace.ground.u + ISO_STEP.column / 2, v: motherPlace.ground.v } : null;
  const routeOf = (wire: CanvasEdge): [Ground, Ground, ...Ground[]] => {
    const to = byId.get(wire.target)!.ground;
    return wire.source === MOTHER && junction
      ? [junction, { u: junction.u, v: to.v }, to]
      : isoRoute(byId.get(wire.source)!.ground, to);
  };
  // One agent is in the tab order (the last focused, else the selected, else the Mother); the arrows walk the rest.
  const tabbable = focusId && byId.has(focusId) ? focusId : (selected.find(id => byId.has(id)) ?? order[0]);
  const hot = hovered ?? focused;
  const singleSelection = selected.length === 1 ? selected[0] : undefined;
  const subject = hot ?? (singleSelection && byId.has(singleSelection) ? singleSelection : null);
  const pick = (id: string, add: boolean) => {
    setFocusId(id);
    onSelect(
      add && id !== FATHER ? (selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]) : [id],
    );
  };
  const open = (id: string) => {
    pick(id, false);
    if (byId.get(id)?.kind === "agent") onOpen(id);
  };
  const screen = (point: Point) => ({ x: view.x + view.zoom * point.x, y: view.y + view.zoom * point.y });
  // An agent reached by the keys is brought into view.
  const reveal = (id: string) => {
    const place = byId.get(id);
    if (!place || !size) return;
    const at = screen(place.at);
    if (at.x < INSET.left || at.x > size.width - INSET.right || at.y < INSET.top || at.y > size.height - INSET.bottom)
      move({ ...view, x: view.x + size.width / 2 - at.x, y: view.y + size.height / 2 - at.y });
  };
  const keys = (event: ReactKeyboardEvent, id: string) => {
    // Plain arrows walk the agents in run order; with Shift or Alt they are the board's (select linked, nudge).
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (step && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, order.indexOf(id) + step))];
      if (next) {
        setFocusId(next);
        buttons.current.get(next)?.focus({ preventScroll: true });
        reveal(next);
      }
    } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      open(id);
    }
  };
  return {
    root,
    buttons,
    blur,
    wave,
    places,
    byId,
    nodes,
    agents,
    size,
    family,
    setMoved,
    setHovered,
    setFocused,
    setFocusId,
    panning,
    setPanning,
    renaming,
    setRenaming,
    rename,
    wireDrag,
    setWireDrag,
    movingNode,
    suppressClick,
    drag,
    view,
    move,
    zoomBy,
    statusOf,
    titleOf,
    parentLine,
    describe,
    wires,
    motherWires,
    motherWire,
    motherPlace,
    junction,
    routeOf,
    tabbable,
    hot,
    subject,
    pick,
    screen,
    keys,
    workflowIdentity,
    inserting,
    canConnect,
    onReconnect,
    renamingFrame,
    onFrameName,
    onNoteText,
    onMoveStart,
    onMove,
    onMoveEnd,
    onMovePreview,
    graph,
    states,
    selected,
    onSelect,
    dark,
    modelLabel,
    onConnect,
    onAdd,
    onCommand,
    onNodeMenu,
    onBoardMenu,
    onWireMenu,
    onWireClick,
    onRename,
  };
}

export type IsoBoardState = ReturnType<typeof useIsoBoardState>;

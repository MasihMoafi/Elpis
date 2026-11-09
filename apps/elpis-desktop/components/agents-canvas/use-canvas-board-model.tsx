"use client";

import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { workflowThreadActive } from "@/components/workflow-progress";
import {
  PATTERNS,
  PATTERN_TEAMS,
  applyPattern,
  COLUMN,
  TEMPLATES,
  checkOf,
  newAgents,
  parents,
  withMother,
  type AgentData,
} from "@/lib/canvas";
import { HandleEnd, MotherData } from "./types";
import { over, ended } from "./run-state";
import { useCanvasElements } from "./use-canvas-elements";
import { canvasNodeChanges } from "./canvas-node-changes";
import { canvasPlacement } from "./canvas-placement";
import { canvasCreation } from "./canvas-creation";
import { useCanvasLayout } from "./use-canvas-layout";
import { canvasAgentEdits } from "./canvas-agent-edits";
import type { CanvasState } from "./use-canvas-state";

export function useCanvasBoardModel(previous: CanvasState) {
  const {
    agents,
    states,
    clashes,
    recordedRun,
    liveTeam,
    run,
    catalog,
    canonicalProvider,
    models,
    setGraph,
    graph,
    room,
    setNotice,
    limit,
    checkpoint,
    restored,
    setSelection,
    setMenu,
    setAdding,
    renamingFrame,
    setRenamingFrame,
    selection,
    identity,
    order,
    wireMenu,
    insertWire,
    nodeDrag,
    reconnecting,
    connectionCancelled,
    iso,
    isoController,
    flow,
    board,
    pointer,
    connectFrom,
    setPatternCommand,
    setRun,
    setStates,
    setRenamingPreset,
    setUndoLoad,
    setDashboardId,
    dashboardId,
    chosen,
    setDeleted,
    forward,
  } = previous;
  // An agent is done once its check passes, unless its work clashed in the merge.
  // A join is done by Elpis and has no check: it is done when it is.
  // An agent run without a check (Logo, 1 Nov: "Finished · 0 of 1 done") is done when it is.
  const done = agents.filter(
    node =>
      states[node.data.join || node.data.check === false ? node.id : checkOf(node.id)]?.status === "succeeded" &&
      !clashes[node.id],
  ).length;
  const runState: MotherData["run"] = recordedRun
    ? workflowThreadActive(liveTeam.mother)
      ? "running"
      : "idle"
    : run
      ? ended(run.status)
      : "idle";
  const fatherState: MotherData["run"] = run?.father?.threadId ? ended(run.father.status) : "idle";
  const modelLabel = (data: AgentData) => {
    if (data.join) return "Elpis";
    if (!data.model) return "Default model";
    const found = catalog.find(item => item.model === data.model && item.provider === canonicalProvider(data.provider));
    // A subscription's model (agy/…, claude/…) is named by the engine's own list (28 Oct: a card read "agy/gemini-3.8-flash-high").
    return found?.label ?? models.find(item => item.model === data.model)?.displayName ?? data.model;
  };
  const setText = (id: string, text: string) =>
    setGraph(current => ({
      ...current,
      nodes: current.nodes.map(node => (node.id === id && node.type === "note" ? { ...node, data: { text } } : node)),
    }));
  // Quick create adds one successor in the next column's nearest free slot, selected with its prompt focused.
  const promptField = useRef<HTMLTextAreaElement>(null);
  const nameField = useRef<HTMLInputElement>(null),
    [nameFocus, setNameFocus] = useState<string | null>(null);
  const onQuick = (id: string) => {
    const source = graph.nodes.find(node => node.id === id);
    if (!source) return;
    if (!room) {
      setNotice(`The graph is at its limit of ${limit} agents. Raise Max agents to add more.`);
      return;
    }
    const [made] = newAgents(
      1,
      { model: null },
      { x: 0, y: 0 },
      [],
      agents.map(node => node.data.title),
    );
    if (!made) return;
    const at = place({ x: source.position.x + COLUMN, y: source.position.y });
    const wire = { id: `${id}->${made.id}`, source: id, target: made.id };
    checkpoint();
    restored.current = true;
    setGraph(current => ({
      ...current,
      nodes: [...current.nodes, { ...made, position: at }],
      edges: [...current.edges, wire],
    }));
    setSelection([made.id]);
    setMenu(null);
    setAdding(null);
    reveal([made.id]);
    setTimeout(() => promptField.current?.focus(), 60);
  };
  // A click on a dot (no drag) opens the command bar there; the new agents take that side of it.
  const onHandle = (id: string, end: HandleEnd, event: ReactMouseEvent) => {
    event.stopPropagation();
    openAdder({ x: event.clientX, y: event.clientY }, { id, as: end === "source" ? "target" : "source" });
  };
  // The Father, when the graph has more agents than the Mother runs: drawn left of the first agents he starts.
  const split = useMemo(
      () =>
        recordedRun
          ? { mother: graph.nodes.filter(node => node.type === "agent").map(node => node.id), father: [] }
          : parents(graph),
      [graph, recordedRun],
    ),
    his = new Set(split.father);
  const { sizes, setFatherSize, frames, nodes, edges } = useCanvasElements({
    agents,
    his,
    graph,
    fatherState,
    split,
    limit,
    renamingFrame,
    setSelection,
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    setGraph,
    setRenamingFrame,
    focusBoard: (...args: Parameters<typeof forward.focusBoard>) => forward.focusBoard(...args),
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
  });
  const { connect, validConnection, reconnect, onNodesChange, onEdgesChange } = canvasNodeChanges({
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    sizes,
    setFatherSize,
    setSelection,
    nodeDrag,
    frames,
    setGraph,
    reconnecting,
    agents,
    graph,
    connectionCancelled,
    restored,
    setNotice,
    reveal: (...args: Parameters<typeof reveal>) => reveal(...args),
  });
  const { place, boxes, NODE_W, NODE_H, isoBoxes, ISO_NODE, GAP, freeAt } = canvasPlacement({
    graph,
    order,
    split,
    agents,
  });
  const { openAdder, addNote, addAgent, viewMiddle, onConnectEnd, addAgents } = canvasCreation({
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
    reveal: (...args: Parameters<typeof reveal>) => reveal(...args),
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    restored,
    flow,
    setNameFocus: (...args: Parameters<typeof setNameFocus>) => setNameFocus(...args),
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
  });
  // 29 Oct, Masih: "similar to autocad design where I could press space and then pick a number and it would create my agents that
  // way - space again, pick another number". The number acts at once: an empty board gets that pattern's team, a team is rewired.
  const patternNumber = (value: string) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > PATTERNS.length) {
      setNotice("Choose a pattern number from 1 to 5.");
      setPatternCommand("");
      return;
    }
    if (run && !over(run)) {
      setNotice("Wait for this run to finish before changing its pattern.");
      return;
    }
    const team = PATTERN_TEAMS[number - 1],
      empty = !graph.nodes.some(node => node.type === "agent");
    checkpoint();
    setGraph(current =>
      applyPattern(
        empty
          ? {
              ...withMother(TEMPLATES.find(template => template.id === team)!.build()),
              maxAgents: current.maxAgents,
              mother: current.mother,
              request: current.request,
            }
          : current,
        number,
      ),
    );
    setPatternCommand(null);
    setSelection([]);
    setRun(null);
    setStates({});
    setNotice("");
    setTimeout(() => forward.fitAll(), 60);
    board.current?.querySelector<HTMLElement>(".iso-board, .react-flow")?.focus();
  };
  const { reveal, tidy, loadTemplate, autoLayout, toggleAuto } = useCanvasLayout({
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
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    iso,
    isoController,
    board,
    NODE_W,
    NODE_H,
    restored,
  });
  const dashboard = agents.find(node => node.id === dashboardId);
  const { remove, removeWire, setKind, renameAgent, edit, commonFolders, setCommonFolders } = canvasAgentEdits({
    setGraph,
    chosen,
    graph,
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    setNotice,
    setDeleted,
    setSelection,
    setMenu,
  });
  return {
    ...previous,
    done,
    runState,
    modelLabel,
    setText,
    promptField,
    nameField,
    nameFocus,
    setNameFocus,
    split,
    nodes,
    edges,
    connect,
    validConnection,
    reconnect,
    onNodesChange,
    onEdgesChange,
    place,
    boxes,
    NODE_W,
    NODE_H,
    isoBoxes,
    ISO_NODE,
    openAdder,
    addNote,
    addAgent,
    viewMiddle,
    onConnectEnd,
    addAgents,
    patternNumber,
    reveal,
    tidy,
    loadTemplate,
    autoLayout,
    toggleAuto,
    dashboard,
    remove,
    removeWire,
    setKind,
    renameAgent,
    edit,
    commonFolders,
    setCommonFolders,
  };
}

export type CanvasBoardModel = ReturnType<typeof useCanvasBoardModel>;

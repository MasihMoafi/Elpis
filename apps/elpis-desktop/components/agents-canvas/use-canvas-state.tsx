"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useReactFlow, useStoreApi, type XYPosition } from "@xyflow/react";
import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { type IsoController } from "@/components/agents-iso";
import { useElpisSettings } from "@/lib/settings-store";
import { appStorage } from "@/lib/projects";
import {
  WORKFLOWS,
  ownFolders,
  FATHER,
  MOTHER,
  TEMPLATES,
  shapeOf,
  maxAgents,
  initialGraph,
  saveGraph,
  waves,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type MotherSettings,
} from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { Run, Adding, BoardMenu, Props } from "./types";
import { FIT } from "./constants";
import { useProjectFolders } from "./folders";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasRunState } from "./use-canvas-run-state";
import { useCanvasModels } from "./use-canvas-models";
import type { CanvasForward } from "./canvas-forward";

export function useCanvasState({
  models,
  cwd,
  dark,
  ready,
  threads = [],
  onOpenChat,
  onRunStarted,
  projectMenu,
  workflowCatalog,
  recordedRun,
  onLeaveRecordedRun,
  onOpenRecordedRun,
  onUseFolder,
  onSchedule,
  scheduled,
}: Props) {
  // Closures here call things later layers declare; each layer fills in its own during render.
  const forward = {} as CanvasForward;
  const isoController = useRef<IsoController>(null);
  const flow = useReactFlow(),
    flowStore = useStoreApi(),
    board = useRef<HTMLDivElement>(null),
    pointer = useRef<XYPosition | null>(null),
    connectFrom = useRef<XYPosition | null>(null);
  const [graph, setGraph] = useState<CanvasGraph>(() =>
    recordedRun
      ? { name: "Workflow", workflowId: recordedRun.id, nodes: [], edges: [] }
      : scheduled
        ? scheduled.board
        : initialGraph(),
  );
  const [iso, setIso] = useState(false);
  const connection = useRef({ ready, generation: 0 });
  if (connection.current.ready !== ready) connection.current = { ready, generation: connection.current.generation + 1 };
  const runtimeAttempt = () => {
    const generation = connection.current.generation;
    return () => connection.current.ready && connection.current.generation === generation;
  };
  const [renamingPreset, setRenamingPreset] = useState(false),
    [morePatterns, setMorePatterns] = useState(false);
  const presetName = TEMPLATES.some(
    template => template.id === graph.template && template.name === graph.name.replace(/ \d+$/, ""),
  );
  const requestText = typeof graph.request === "string" ? graph.request : "";
  const identity = graph.workflowId ? workflowCatalog.identities[graph.workflowId] : undefined;
  const previousIdentity = useRef<WorkflowIdentity | undefined>(undefined);
  useEffect(() => {
    const before = previousIdentity.current;
    previousIdentity.current = identity;
    if (identity && before?.id === identity.id && before.name !== identity.name && graph.name === before.name)
      setIdentity({ name: identity.name });
  }, [identity, graph.name]);
  useEffect(() => {
    if (recordedRun || !workflowCatalog.hydrated) return;
    try {
      const item = workflowCatalog.ensure(graph.workflowId || crypto.randomUUID(), graph.name);
      if (graph.workflowId !== item.id || !identity)
        setGraph(current => ({ ...current, workflowId: item.id, name: item.name }));
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }, [workflowCatalog.hydrated, workflowCatalog.ensure, graph.workflowId]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  // What is selected is kept apart from the saved graph: a click picks one, Shift+click or Shift+drag several.
  const [selection, setSelection] = useState<string[]>([]),
    [dashboardId, setDashboardId] = useState<string | null>(null);
  const pendingProviderDefaults = useRef(
    new Map<string, { provider: string | null; model: string | null; effort: string | null }>(),
  );
  const boxDrag = useRef<{
    x: number;
    y: number;
    base: string[];
    previous: string[];
    subtract: boolean;
    moved: boolean;
    lasso: boolean;
    points: XYPosition[];
  } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    crossing: boolean;
  } | null>(null);
  const [lasso, setLasso] = useState(false),
    [stroke, setStroke] = useState<XYPosition[] | null>(null);
  const cutter = useRef<{ points: XYPosition[]; ids: Set<string>; cancelled?: boolean } | null>(null),
    suppressContext = useRef(false);
  const nodeDrag = useRef<{
    before: CanvasGraph;
    id: string;
    ids: string[];
    extract: boolean;
    cancelled: boolean;
  } | null>(null);
  const [insertWire, setInsertWire] = useState<string | null>(null),
    [renamingFrame, setRenamingFrame] = useState<string | null>(null);
  const connectionCancelled = useRef(false);
  const reconnecting = useRef<string | null>(null),
    alongsideDrag = useRef(false);
  const [finding, setFinding] = useState<string | null>(null),
    [findIndex, setFindIndex] = useState(0);
  const [runTargets, setRunTargets] = useState<string[] | null>(null);
  const minimap = graph.minimap === true;
  const toggleMinimap = () => {
    checkpoint();
    setGraph(current => ({ ...current, minimap: current.minimap !== true }));
  };
  useEffect(() => {
    if (selection.length) setSourceId(null);
  }, [selection]);
  const [menu, setMenu] = useState<BoardMenu | null>(null),
    wireMenu = menu?.kind === "wire" ? menu : null;
  // The side panel folds away to give the board the whole width, remembered on this device; choosing an agent or the
  // Mother brings it back.
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return appStorage().getItem("elpis-canvas-panel") !== "closed";
    } catch {
      return true;
    }
  });
  const showPanel = (open: boolean) => {
    setPanelOpen(open);
    try {
      appStorage().setItem("elpis-canvas-panel", open ? "open" : "closed");
    } catch {
      /* kept for this session only */
    }
    setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
  };
  useEffect(() => {
    if (selection.length && !panelOpen && !boxDrag.current) showPanel(true);
  }, [selection, selectionBox, stroke]);
  const project = useProjectFolders(cwd);
  const own = useMemo(() => ownFolders(graph), [graph]);
  const [notice, setNotice] = useState("");
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  /** The root chat of the run this board started, for a scheduled replay's report. */
  const startedThread = useRef<string | null>(null),
    replayed = useRef(false);
  const runReasonId = useId(),
    offlineReasonId = useId();
  const [deleted, setDeleted] = useState<string | null>(null);
  const { setIdentity, checkpoint, restored, redo, undo, history } = useCanvasHistory({
    graph,
    nodeDrag,
    setGraph,
    setSelection,
    setMenu,
    setDeleted,
  });
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), 4000);
    return () => clearTimeout(timer);
  }, [deleted]);
  const [flowEdit, setFlowEdit] = useState<{ edge: CanvasEdge; left: number; top: number } | null>(null);
  const [patternCommand, setPatternCommand] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [run, setRun] = useState<Run | null>(null),
    [starting, setStarting] = useState(false);
  useEffect(() => {
    if (run) void workflowCatalog.refresh();
  }, [run?.graphId, run?.status, workflowCatalog.refresh]);
  const startingRun = useRef(false);
  const [planning, setPlanning] = useState("");
  const planStop = useRef<AbortController | null>(null);
  const stopPlanning = () => planStop.current?.abort();
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => {
      if (isoController.current) isoController.current.fit();
      else void flow.fitView(FIT);
    }, 60);
    return () => clearTimeout(timer);
  }, [run?.graphId, flow]);
  const {
    setStates,
    setSavedRecord,
    setClashes,
    said,
    reports,
    decisionsSeen,
    setLog,
    states,
    clashes,
    liveTeam,
    followLog,
    savedRecord,
    logList,
    log,
  } = useCanvasRunState({
    ready,
    threads,
    recordedRun,
    setGraph,
    isoController,
    flow,
    workflowCatalog,
    graph,
    setRun,
    setNotice,
  });
  const [, setFetched] = useState(0);
  const settings = useElpisSettings().data;
  // What Elpis allows: agents in one graph, and at once (bridge/elpis-features.mjs `agentLimits`).
  const allowed = settings?.agents ?? { graph: 256, atOnce: 6, source: "Elpis default" };
  useEffect(() => {
    if (recordedRun || scheduled) return;
    const timer = setTimeout(() => {
      if (!saveGraph(graph)) setNotice("Could not keep the graph on this device.");
    }, 300);
    return () => clearTimeout(timer);
  }, [graph, recordedRun]);
  // A change made just before the window closes or reloads is kept too: the page saves the latest board on its way out.
  const latest = useRef(graph);
  latest.current = graph;
  useEffect(() => {
    if (recordedRun || scheduled) return;
    const flush = () => saveGraph(latest.current);
    window.__elpisFlushWorkflow = flush;
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      if (window.__elpisFlushWorkflow === flush) delete window.__elpisFlushWorkflow;
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [recordedRun]);
  const { catalog, canonicalProvider, subscriptions, providers, providerDefault, choices } = useCanvasModels({
    models,
    settings,
    setFetched,
    pendingProviderDefaults,
    setGraph,
  });
  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  const chosen = agents.filter(node => selection.includes(node.id)),
    selected = chosen.length === 1 ? chosen[0] : undefined;
  // The Father is her twin: a click on him opens her panel, which tells his part.
  const motherOpen = selection.length === 1 && (selection[0] === MOTHER || selection[0] === FATHER),
    mother = graph.mother ?? { brief: "", model: null, provider: null };
  const setMother = (patch: Partial<MotherSettings>) =>
    setGraph(current => ({
      ...current,
      mother: { ...(current.mother ?? { brief: "", model: null, provider: null }), ...patch },
    }));
  // Loading an architecture replaces the board; Undo, offered for a while, puts the old one back.
  const [undoLoad, setUndoLoad] = useState<{ loaded: string; previous: CanvasGraph } | null>(null);
  useEffect(() => {
    if (!undoLoad) return;
    const timer = setTimeout(() => setUndoLoad(null), 12000);
    return () => clearTimeout(timer);
  }, [undoLoad]);
  const shapes = useMemo(
    () =>
      new Map([
        ...TEMPLATES.map(template => [template.id, shapeOf(template.build())] as const),
        ...WORKFLOWS.map(workflow => [workflow.id, shapeOf(workflow.shape())] as const),
      ]),
    [],
  );
  const limit = maxAgents(graph),
    room = Math.max(0, limit - agents.length),
    order = useMemo(() => waves(graph), [graph]);
  return {
    forward,
    isoController,
    flow,
    flowStore,
    board,
    pointer,
    connectFrom,
    graph,
    setGraph,
    iso,
    setIso,
    runtimeAttempt,
    renamingPreset,
    setRenamingPreset,
    morePatterns,
    setMorePatterns,
    presetName,
    requestText,
    identity,
    sourceId,
    setSourceId,
    selection,
    setSelection,
    dashboardId,
    setDashboardId,
    pendingProviderDefaults,
    boxDrag,
    selectionBox,
    setSelectionBox,
    lasso,
    setLasso,
    stroke,
    setStroke,
    cutter,
    suppressContext,
    nodeDrag,
    insertWire,
    setInsertWire,
    renamingFrame,
    setRenamingFrame,
    connectionCancelled,
    reconnecting,
    alongsideDrag,
    finding,
    setFinding,
    findIndex,
    setFindIndex,
    runTargets,
    setRunTargets,
    minimap,
    toggleMinimap,
    menu,
    setMenu,
    wireMenu,
    panelOpen,
    showPanel,
    project,
    own,
    notice,
    setNotice,
    noticeRef,
    startedThread,
    replayed,
    runReasonId,
    offlineReasonId,
    deleted,
    setDeleted,
    setIdentity,
    checkpoint,
    restored,
    redo,
    undo,
    history,
    flowEdit,
    setFlowEdit,
    patternCommand,
    setPatternCommand,
    adding,
    setAdding,
    run,
    setRun,
    starting,
    setStarting,
    startingRun,
    planning,
    setPlanning,
    planStop,
    stopPlanning,
    setStates,
    setSavedRecord,
    setClashes,
    said,
    reports,
    decisionsSeen,
    setLog,
    states,
    clashes,
    liveTeam,
    followLog,
    savedRecord,
    logList,
    log,
    allowed,
    latest,
    catalog,
    canonicalProvider,
    subscriptions,
    providers,
    providerDefault,
    choices,
    agents,
    chosen,
    selected,
    motherOpen,
    mother,
    setMother,
    undoLoad,
    setUndoLoad,
    shapes,
    limit,
    room,
    order,
    models,
    cwd,
    dark,
    ready,
    onOpenChat,
    onRunStarted,
    projectMenu,
    workflowCatalog,
    recordedRun,
    onLeaveRecordedRun,
    onOpenRecordedRun,
    onUseFolder,
    onSchedule,
    scheduled,
  };
}

export type CanvasState = ReturnType<typeof useCanvasState>;

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useReactFlow, useStoreApi, type Node, type XYPosition } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { workflowThreadActive } from "@/components/workflow-progress";
import type { WorkflowIdentity } from "@/lib/workflow-identity";
import { type IsoController } from "@/components/agents-iso";
import { deleteKeepingFlow } from "@/lib/canvas-delete-flow";
import { executionGraph } from "@/lib/canvas";
import { subscriptionOf } from "@/lib/api";
import { useElpisSettings } from "@/lib/settings-store";
import { appStorage } from "@/lib/projects";
import {
  PATTERNS,
  PATTERN_TEAMS,
  WORKFLOWS,
  applyPattern,
  ownFolders,
  CHECK_LABEL,
  COLUMN,
  FATHER,
  MOTHER,
  STATUS_LABEL,
  waits,
  TEMPLATES,
  checkOf,
  shapeOf,
  maxAgents,
  newAgents,
  parents,
  initialGraph,
  saveGraph,
  waves,
  withMother,
  type AgentData,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type MotherSettings,
} from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { Run, HandleEnd, MotherData, Adding, BoardMenu, Props } from "./types";
import { over, ended } from "./run-state";
import { FIT, OVERVIEW } from "./constants";
import { useProjectFolders } from "./folders";
import { RunClock, clock } from "./clock";
import { useCanvasHistory } from "./use-canvas-history";
import { useCanvasRunState } from "./use-canvas-run-state";
import { useCanvasModels } from "./use-canvas-models";
import { useCanvasPolling } from "./use-canvas-polling";
import { useCanvasElements } from "./use-canvas-elements";
import { canvasNodeChanges } from "./canvas-node-changes";
import { canvasPlacement } from "./canvas-placement";
import { canvasCreation } from "./canvas-creation";
import { useCanvasLayout } from "./use-canvas-layout";
import { canvasAgentEdits } from "./canvas-agent-edits";
import { useCanvasClipboard } from "./use-canvas-clipboard";
import { canvasNavigation } from "./canvas-navigation";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { canvasMenus } from "./canvas-menus";
import { canvasDragging } from "./canvas-dragging";
import { canvasMenuItems } from "./canvas-menu-items";
import { canvasReadyMade } from "./canvas-ready-made";
import { canvasPlanning } from "./canvas-planning";
import { canvasRun } from "./canvas-run";

export function useCanvasController({
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
    focusBoard: (...args: Parameters<typeof focusBoard>) => focusBoard(...args),
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
    setTimeout(() => fitAll(), 60);
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
  const inputsNeeded = (id: string) =>
    graph.edges
      .filter(edge => waits(edge) && edge.target === id && agents.some(node => node.id === edge.source))
      .filter(
        edge =>
          states[edge.source]?.status !== "succeeded" ||
          states[checkOf(edge.source)]?.status !== "succeeded" ||
          clashes[edge.source],
      )
      .map(
        edge =>
          `${titleOf(edge.source)} (${clashes[edge.source] ? "merge clash" : states[edge.source]?.status === "succeeded" ? CHECK_LABEL[states[checkOf(edge.source)]?.status ?? "idle"] : STATUS_LABEL[states[edge.source]?.status ?? "idle"]})`,
      );
  const choiceKey = (data: AgentData) =>
    data.model ? `${subscriptionOf(data.model) ? "" : (canonicalProvider(data.provider) ?? "")}|${data.model}` : "";
  const shared = (key: (data: AgentData) => string) =>
    chosen[0] && new Set(chosen.map(node => key(node.data))).size === 1 ? key(chosen[0].data) : "mixed";
  const modelPatch = (value: string): Partial<AgentData> => {
    const [provider, ...rest] = value.split("|");
    return value
      ? { provider: provider || null, model: rest.join("|"), effort: null }
      : { provider: null, model: null, effort: null };
  };
  // The subscriptions' models (Claude, Antigravity's Gemini) come from the engine's own list (28 Oct: Mother agent's menu had no Opus).
  const subscribed = models.filter(
    item => subscriptionOf(item.model) && !catalog.some(entry => entry.model === item.model),
  );
  const modelOptions = (provider?: string | null) => [
    <option key="" value="">
      Default model
    </option>,
    ...catalog
      .filter(item => provider === undefined || item.provider === provider)
      .map(item => (
        <option
          key={`${item.provider}|${item.model}`}
          value={`${item.provider ?? ""}|${item.model}`}
          data-hint={provider === undefined ? item.providerLabel : undefined}
        >
          {item.label}
        </option>
      )),
    ...(provider === undefined
      ? subscribed.map(item => (
          <option key={`|${item.model}`} value={`|${item.model}`} data-hint={subscriptionOf(item.model)?.label}>
            {item.displayName || item.model}
          </option>
        ))
      : []),
  ];
  const subscriptionOptions = (prefix: string) =>
    subscriptions
      .find(choice => choice.id === prefix)
      ?.models.map(item => (
        <option key={item.model} value={`|${item.model}`}>
          {item.displayName || item.model}
        </option>
      )) ?? [];
  const mixed = (
    <option value="mixed" disabled>
      Mixed
    </option>
  );
  const selectedModel = selected
    ? catalog.find(
        item => item.model === selected.data.model && item.provider === canonicalProvider(selected.data.provider),
      )
    : undefined;
  const { readyMade, buildReadyMade, pickReadyMade, chosenWorkflow, chooseFolderFor, openResult } = canvasReadyMade({
    graph,
    project,
    cwd,
    run,
    setNotice,
    onUseFolder,
    requestText,
    models,
    catalog,
    checkpoint,
    setSelection,
    setRun,
    setStates,
    setGraph,
    flow,
  });
  const { letElpis } = canvasPlanning({
    planStop,
    runtimeAttempt,
    recordedRun,
    planning,
    startingRun,
    setNotice,
    cwd,
    readyMade,
    graph,
    buildReadyMade,
    mother,
    setPlanning,
    setMenu,
    project,
    limit,
    latest,
    checkpoint,
    workflowCatalog,
    setRun,
    setStates,
    setDashboardId,
    setUndoLoad,
    setGraph,
    setSelection,
    flow,
  });
  const { start } = canvasRun({
    allowed,
    mother,
    graph,
    cwd,
    readyMade,
    requestText,
    recordedRun,
    runtimeAttempt,
    startingRun,
    planning,
    run,
    setNotice,
    setStarting,
    project,
    letElpis,
    agents,
    setUndoLoad,
    setStates,
    setClashes,
    setLog,
    said,
    decisionsSeen,
    reports,
    followLog,
    workflowCatalog,
    identity,
    models,
    catalog,
    setIdentity,
    setRun,
    startedThread,
    onRunStarted,
  });

  // A scheduled replay starts once the connection and the workflow names are ready, then reports and is done.
  useEffect(() => {
    if (!scheduled || replayed.current || !ready || !workflowCatalog.hydrated) return;
    replayed.current = true;
    // The notice a failed start sets renders a moment later; read it after that render.
    void start()
      .then(() => new Promise(resolve => setTimeout(resolve, 50)))
      .then(() =>
        scheduled.onDone(
          startedThread.current
            ? { threadId: startedThread.current }
            : { error: noticeRef.current || "The workflow did not start" },
        ),
      );
  }, [scheduled, ready, workflowCatalog.hydrated]);
  const chat = selected ? states[selected.id]?.chat : null;
  const outputRunId =
    selected &&
    savedRecord &&
    [...(savedRecord.tasks ?? []), ...(savedRecord.next?.tasks ?? [])].some(task => task.id === selected.id)
      ? savedRecord.id
      : null;
  const found =
    finding === null
      ? []
      : agents.filter(node =>
          `${node.data.title} ${node.data.instruction}`.toLowerCase().includes(finding.toLowerCase()),
        );
  const findAgent = (id: string) => {
    setSelection([id]);
    setFinding(null);
    focusBoard();
    if (iso) isoController.current?.reveal([id]);
    else reveal([id]);
  };
  const scope = runTargets ? executionGraph(graph, runTargets).nodes.filter(node => node.type === "agent") : [];
  const historicalNotice = Boolean(
    recordedRun &&
    savedRecord &&
    notice &&
    (notice === savedRecord.error || savedRecord.tasks?.some(task => task.failureReason === notice)),
  );
  useCanvasKeyboard({
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
    previewRun: (...args: Parameters<typeof previewRun>) => previewRun(...args),
    start,
    ungroup: (...args: Parameters<typeof ungroup>) => ungroup(...args),
    frameSelection: (...args: Parameters<typeof frameSelection>) => frameSelection(...args),
    graph,
    selection,
    setFinding,
    setFindIndex,
    setMenu,
    setAdding,
    tidySelection: (...args: Parameters<typeof tidySelection>) => tidySelection(...args),
    toggleMinimap,
    nudge: (...args: Parameters<typeof nudge>) => nudge(...args),
    openAdder,
    checkpoint: (...args: Parameters<typeof checkpoint>) => checkpoint(...args),
    addNote,
    pointerPosition: (...args: Parameters<typeof pointerPosition>) => pointerPosition(...args),
    keyboardMenu: (...args: Parameters<typeof keyboardMenu>) => keyboardMenu(...args),
    mute: (...args: Parameters<typeof mute>) => mute(...args),
    focusNearest: (...args: Parameters<typeof focusNearest>) => focusNearest(...args),
    zoom: (...args: Parameters<typeof zoom>) => zoom(...args),
    frameView: (...args: Parameters<typeof frameView>) => frameView(...args),
    focusPrevious: (...args: Parameters<typeof focusPrevious>) => focusPrevious(...args),
    addAgent,
    selected,
    setPatternCommand,
    setDashboardId,
    redo: (...args: Parameters<typeof redo>) => redo(...args),
    undo: (...args: Parameters<typeof undo>) => undo(...args),
    copy: (...args: Parameters<typeof copy>) => copy(...args),
    remove: (...args: Parameters<typeof remove>) => remove(...args),
    clipboard,
    paste: (...args: Parameters<typeof paste>) => paste(...args),
    duplicate: (...args: Parameters<typeof duplicate>) => duplicate(...args),
    removeKeepingFlow: (...args: Parameters<typeof removeKeepingFlow>) => removeKeepingFlow(...args),
    fitAll: (...args: Parameters<typeof fitAll>) => fitAll(...args),
    setRenamingFrame,
    rename: (...args: Parameters<typeof rename>) => rename(...args),
  });
  const runClock = run && (
    <section className="canvas-hud" aria-label="Run clock">
      <span>
        {over(run)
          ? ["succeeded", "completed"].includes(run.father?.status ?? run.status)
            ? "Run done"
            : "Run ended"
          : "Running"}
      </span>
      <>
        {over(run) && !run.endedAt ? (
          <span>Duration not recorded</span>
        ) : (
          <RunClock key={run.graphId} since={run.startedAt} until={run.endedAt} />
        )}
      </>
    </section>
  );
  const telemetry = <div className="canvas-telemetry">{runClock}</div>;
  const capturedLog = run && (
    <ol
      ref={logList}
      className="canvas-log"
      role="log"
      aria-label="Run log"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={event => {
        const el = event.currentTarget;
        followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
      }}
    >
      {log.map((line, index) => (
        <li key={`${line.at}-${index}`} data-tone={line.tone}>
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            title={line.at === undefined ? line.text : `Observed +${clock(line.at - run.startedAt)} · ${line.text}`}
            onClick={() => {
              if (line.agent) {
                setSelection([line.agent]);
                setDashboardId(line.agent);
              } else setSelection([MOTHER]);
            }}
          >
            {line.at !== undefined && <time>+{clock(line.at - run.startedAt)}</time>}
            <span title={line.text}>{line.text}</span>
          </Button>
        </li>
      ))}
    </ol>
  );
  return {
    stopPlanning,
    recordedRun,
    panelOpen,
    run,
    onLeaveRecordedRun,
    letElpis,
    requestText,
    setGraph,
    graph,
    planning,
    starting,
    setSelection,
    setMorePatterns,
    showPanel,
    readyMade,
    pickReadyMade,
    setNotice,
    loadTemplate,
    chosenWorkflow,
    ready,
    cwd,
    chooseFolderFor,
    offlineReasonId,
    done,
    agents,
    runClock,
    openResult,
    savedRecord,
    liveTeam,
    onOpenChat,
    workflowCatalog,
    onOpenRecordedRun,
    identity,
    presetName,
    renamingPreset,
    setRenamingPreset,
    setRun,
    setStates,
    projectMenu,
    iso,
    setIso,
    motherOpen,
    autoLayout,
    toggleAuto,
    start,
    notice,
    runReasonId,
    onSchedule,
    board,
    lasso,
    suppressContext,
    cutter,
    setStroke,
    setMenu,
    boxDrag,
    selection,
    pointer,
    cutCrossed,
    setSelectionBox,
    checkpoint,
    setLasso,
    addAgent,
    split,
    states,
    setDashboardId,
    renameAgent,
    editFlow,
    dark,
    isoController,
    modelLabel,
    validConnection,
    insertWire,
    connectionCancelled,
    reconnect,
    renamingFrame,
    setRenamingFrame,
    focusBoard,
    setText,
    beginDrag,
    moveIso,
    nodeDrag,
    finishDrag,
    setInsertWire,
    insertionAt,
    connect,
    openAdder,
    nodes,
    onNodeContextMenu,
    onPaneContextMenu,
    onEdgeClick,
    edges,
    onNodesChange,
    onEdgesChange,
    alongsideDrag,
    onConnectEnd,
    connectFrom,
    onNodeClick,
    reconnecting,
    minimap,
    stroke,
    selectionBox,
    telemetry,
    historicalNotice,
    capturedLog,
    log,
    addNote,
    tidy,
    patternCommand,
    patternNumber,
    setPatternCommand,
    finding,
    setFinding,
    setFindIndex,
    found,
    findIndex,
    findAgent,
    runTargets,
    setRunTargets,
    scope,
    adding,
    room,
    limit,
    catalog,
    providers,
    setAdding,
    addAgents,
    menu,
    menuView,
    dashboard,
    own,
    clashes,
    inputsNeeded,
    titleOf,
    flowEdit,
    saveFlow,
    setFlowEdit,
    deleted,
    undo,
    undoLoad,
    setUndoLoad,
    flow,
    sourceId,
    setSourceId,
    selected,
    outputRunId,
    nameField,
    promptField,
    edit,
    canonicalProvider,
    subscriptions,
    pendingProviderDefaults,
    providerDefault,
    choices,
    choiceKey,
    modelPatch,
    subscriptionOptions,
    modelOptions,
    selectedModel,
    project,
    dashboardId,
    chat,
    remove,
    chosen,
    shared,
    mixed,
    commonFolders,
    setCommonFolders,
    mother,
    setMother,
    allowed,
    runState,
    morePatterns,
    shapes,
  };
}

export type CanvasController = ReturnType<typeof useCanvasController>;

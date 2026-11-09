"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { executionGraph } from "@/lib/canvas";
import { subscriptionOf } from "@/lib/api";
import { CHECK_LABEL, MOTHER, STATUS_LABEL, waits, checkOf, type AgentData } from "@/lib/canvas";
import { over } from "./run-state";
import { RunClock, clock } from "./clock";
import { useCanvasKeyboard } from "./use-canvas-keyboard";
import { canvasReadyMade } from "./canvas-ready-made";
import { canvasPlanning } from "./canvas-planning";
import { canvasRun } from "./canvas-run";
import type { CanvasInteractions } from "./use-canvas-interactions";

export function useCanvasRunPanel(previous: CanvasInteractions) {
  const {
    graph,
    agents,
    states,
    clashes,
    titleOf,
    canonicalProvider,
    chosen,
    models,
    catalog,
    subscriptions,
    selected,
    project,
    cwd,
    run,
    setNotice,
    onUseFolder,
    requestText,
    checkpoint,
    setSelection,
    setRun,
    setStates,
    setGraph,
    flow,
    planStop,
    runtimeAttempt,
    recordedRun,
    planning,
    startingRun,
    mother,
    setPlanning,
    setMenu,
    limit,
    latest,
    workflowCatalog,
    setDashboardId,
    setUndoLoad,
    allowed,
    setStarting,
    setClashes,
    setLog,
    said,
    decisionsSeen,
    reports,
    followLog,
    identity,
    setIdentity,
    startedThread,
    onRunStarted,
    scheduled,
    replayed,
    ready,
    noticeRef,
    savedRecord,
    finding,
    setFinding,
    focusBoard,
    iso,
    isoController,
    reveal,
    runTargets,
    notice,
    board,
    boxDrag,
    cutter,
    nodeDrag,
    connectFrom,
    setSelectionBox,
    setStroke,
    setLasso,
    setInsertWire,
    flowStore,
    connectionCancelled,
    lasso,
    previewRun,
    ungroup,
    frameSelection,
    selection,
    setFindIndex,
    setAdding,
    tidySelection,
    toggleMinimap,
    nudge,
    openAdder,
    addNote,
    pointerPosition,
    keyboardMenu,
    mute,
    focusNearest,
    zoom,
    frameView,
    focusPrevious,
    addAgent,
    setPatternCommand,
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
    logList,
    log,
  } = previous;
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
    ...previous,
    inputsNeeded,
    choiceKey,
    shared,
    modelPatch,
    modelOptions,
    subscriptionOptions,
    mixed,
    selectedModel,
    readyMade,
    pickReadyMade,
    chosenWorkflow,
    chooseFolderFor,
    openResult,
    letElpis,
    start,
    chat,
    outputRunId,
    found,
    findAgent,
    scope,
    historicalNotice,
    runClock,
    telemetry,
    capturedLog,
  };
}

export type CanvasRunPanel = ReturnType<typeof useCanvasRunPanel>;

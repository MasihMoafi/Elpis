import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useWorkflowTeam, workflowThreadActive } from "@/components/workflow-progress";
import { agentParentId } from "@/lib/agent-runs.mts";
import { graphForWorkflow, motherDecisionLines, readWorkflowRun, taskState, type RecordedWorkflow } from "@/components/workflow-chat";
import { type IsoController } from "@/components/agents-iso";
import { type CanvasGraph, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { type LogLine } from "@/lib/run-log";
import type * as React from "react";
import { Run, Props } from "./types";
import { stoppedLine, currentActivity } from "./run-state";
import { FIT } from "./constants";

export function useCanvasRunState({ ready, threads, recordedRun, setGraph, isoController, flow, workflowCatalog, graph, setRun, setNotice }: {
  ready: Props["ready"];
  threads: Props["threads"];
  recordedRun: Props["recordedRun"];
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  isoController: React.RefObject<IsoController | null>;
  flow: ReturnType<typeof useReactFlow>;
  workflowCatalog: Props["workflowCatalog"];
  graph: CanvasGraph;
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>
}) {

  const [savedStates, setStates] = useState<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined }>>({});
  const [savedRecord, setSavedRecord] = useState<RecordedWorkflow>();
  const liveTeam = useWorkflowTeam(savedRecord, ready, threads);
  const states = useMemo(() => {
    const next = { ...savedStates };
    const assigned = new Map((savedRecord?.tasks ?? []).flatMap(task => task.assignedThreadId ? [[task.assignedThreadId, task.id] as const] : []));
    for (const thread of liveTeam.agents) {
      const id = assigned.get(thread.id) ?? `live:${thread.id}`;
      if (workflowThreadActive(thread)) next[id] = { status: "running", chat: thread.id };
      else if (!next[id]) next[id] = { status: "pending", chat: thread.id };
    }
    return next;
  }, [savedStates, savedRecord, liveTeam.agents]);
  const liveTopology = JSON.stringify(liveTeam.agents.map(thread => [thread.id, agentParentId(thread)]).sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")));
  useEffect(() => {
    if (!recordedRun || !savedRecord) return;
    setGraph(graphForWorkflow(savedRecord, liveTeam.agents));
    const timer = setTimeout(() => { if (isoController.current) isoController.current.fit(); else void flow.fitView(FIT); }, 60);
    return () => clearTimeout(timer);
  }, [recordedRun?.id, savedRecord?.id, liveTopology, flow]);
  // Where the engine's merge clash stopped the run: the clashing files, by the agent whose work clashed.
  const [clashes, setClashes] = useState<Record<string, string[]>>({});
  // The run log, as Deus Ex's event cards: what started, finished, passed its check or failed, newest last.
  const [log, setLog] = useState<LogLine[]>([]);
  const said = useRef<Record<string, TaskStatus>>({}), decisionsSeen = useRef(0);
  const reports = useRef(new Set<string>()), logList = useRef<HTMLOListElement>(null);
  const followLog = useRef(true);
  useEffect(() => { if (followLog.current && logList.current) logList.current.scrollTop = logList.current.scrollHeight; }, [log]);
  // A retained run is a separate presentation, never the unfinished draft in local storage.
  const retainedRun = recordedRun ?? workflowCatalog.runs.find(item => item.id === graph.workflowId);
  useEffect(() => {
    if (!retainedRun || !ready) return;
    let live = true;
    void readWorkflowRun(retainedRun).then(record => {
      if (!live) return;
      setSavedRecord(record);
      if (recordedRun) setGraph(graphForWorkflow(record));
      const tasks = [...(record.tasks ?? []), ...(record.next?.tasks ?? [])];
      setStates(Object.fromEntries(tasks.map(task => [task.id, { status: taskState(task.status), chat: task.assignedThreadId ?? null, activity: currentActivity(task) || undefined }])));
      setRun({ rootThreadId: record.rootThreadId, graphId: record.id, status: record.status, startedAt: record.startedAt ?? record.createdAt ?? Date.now(),
        ...(record.endedAt ? { endedAt: record.endedAt } : {}), ...(record.error ? { error: record.error } : {}), ...(record.next ? { father: { tasks: [], threadId: record.next.threadId, graphId: record.next.graphId, status: record.next.status, reported: record.next.reported } } : {}) });
      setLog([...tasks.map(task => ({ agent: task.id, text: `${task.title || task.id} · ${task.status || "not recorded"}${task.failureReason ? ` · ${task.failureReason}` : ""}`, tone: task.status === "failed" || task.status === "blocked" ? "fail" : task.status === "succeeded" || task.status === "completed" ? "done" : "start" } as LogLine)), ...motherDecisionLines(record), ...stoppedLine(record.status, record.error)]);
      setNotice(recordedRun ? "" : record.error || tasks.find(task => task.failureReason)?.failureReason || "");
    }).catch(cause => { if (live) setNotice(errorText(cause)); });
    return () => { live = false; };
  }, [retainedRun?.id, retainedRun?.rootThreadId, ready]);
  return { setStates, setSavedRecord, setClashes, said, reports, decisionsSeen, setLog, states, clashes, liveTeam, followLog, savedRecord, logList, log };
}
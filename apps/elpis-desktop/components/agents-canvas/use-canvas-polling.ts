import { useEffect } from "react";
import { motherDecisionLines, withAddedAgents, type RecordedWorkflow } from "@/components/workflow-chat";
import { api } from "@/lib/api";
import { filesText, mergeStops, stopText } from "@/lib/canvas-isolation";
import { type CanvasGraph, type CanvasNode, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { taskLogLines, type LogLine } from "@/lib/run-log";
import type * as React from "react";
import { Run, Listed, Props } from "./types";
import { over, stoppedLine, currentActivity, sameData, runFailure } from "./run-state";

export function useCanvasPolling({
  ready,
  run,
  setStates,
  setSavedRecord,
  setClashes,
  said,
  setNotice,
  titleOf,
  reports,
  agents,
  decisionsSeen,
  setGraph,
  setLog,
  setRun,
}: {
  ready: Props["ready"];
  run: Run | null;
  setStates: React.Dispatch<
    React.SetStateAction<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined }>>
  >;
  setSavedRecord: React.Dispatch<React.SetStateAction<RecordedWorkflow | undefined>>;
  setClashes: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  said: React.RefObject<Record<string, TaskStatus>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  titleOf: (id: string) => string;
  reports: React.RefObject<Set<string>>;
  agents: Extract<CanvasNode, { type: "agent" }>[];
  decisionsSeen: React.RefObject<number>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setLog: React.Dispatch<React.SetStateAction<LogLine[]>>;
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
}) {
  // Follow a run: Elpis reports each task's state; stop once the graph has finished.
  useEffect(() => {
    if (!ready || !run || over(run)) return;
    let live = true,
      polling = false;
    const read = async (threadId: string, graphId: string) => {
      if (!live) return;
      const listed = await api<Listed>(`/workflows?threadId=${encodeURIComponent(threadId)}`),
        found = listed.data.find(item => item.id === graphId);
      if (found && live) {
        // A merge clash (lib/canvas-isolation.ts) stops the run on an agent: it shows as failed, though its own task may have succeeded.
        const stops = mergeStops(found),
          listedStates = Object.fromEntries(
            found.tasks.map(task => [
              task.id,
              { status: task.status, chat: task.assignedThreadId, activity: currentActivity(task) || undefined },
            ]),
          );
        for (const stop of stops) {
          const state = stop.agent && listedStates[stop.agent];
          if (stop.agent && state) listedStates[stop.agent] = { ...state, status: "failed" };
        }
        setStates(current => {
          const next = { ...current, ...listedStates };
          return sameData(current, next) ? current : next;
        });
        if (graphId === run.graphId)
          setSavedRecord(current => {
            const next = { ...found, rootThreadId: run.rootThreadId } as RecordedWorkflow;
            return sameData(current, next) ? current : next;
          });
        if (stops.some(stop => stop.agent))
          setClashes(current => ({
            ...current,
            ...Object.fromEntries(stops.flatMap(stop => (stop.agent ? [[stop.agent, stop.files]] : []))),
          }));
        // Each stop is told once, in the log and in a notice that stays until dismissed.
        const fresh: typeof stops = [];
        for (const stop of stops) {
          const key = `merge ${stop.agent ?? "project"}`;
          if (!said.current[key]) {
            said.current[key] = "failed";
            fresh.push(stop);
          }
        }
        if (fresh.length) setNotice(fresh.map(stop => stopText(stop, stop.agent ? titleOf(stop.agent) : "")).join(" "));
        const failed = found.tasks.find(task => task.status === "failed" && task.failureReason);
        if (!fresh.length && !failed && found.error) setNotice(runFailure(found.error));
        if (!fresh.length && failed)
          setNotice(runFailure(`${titleOf(failed.id.replace(/-check$/, ""))}: ${failed.failureReason}`));
        const stopLines = fresh.map(stop => ({
          at: Date.now(),
          agent: stop.agent ?? undefined,
          text: stop.agent
            ? `${titleOf(stop.agent)}: merge clash in ${filesText(stop.files, 3)}`
            : `Merge blocked: uncommitted changes in ${filesText(stop.files, 3)}`,
          tone: "fail" as const,
        }));
        // An agent the Mother just added is not on the board yet in this look: its own title names it.
        const lines = taskLogLines(found.tasks, said.current, reports.current, agent =>
          agents.some(node => node.id === agent)
            ? titleOf(agent)
            : found.tasks.find(item => item.id === agent)?.title || titleOf(agent),
        );
        // The Mother's re-plans (bridge/workflow-acp.mts `decide`): each decision once in the history, and the agents she
        // added on the board as they come; those she cancelled show as cancelled like any task.
        const decided = motherDecisionLines(found),
          seen = decisionsSeen.current;
        decisionsSeen.current = Math.max(seen, decided.length);
        if (graphId === run.graphId && found.tasks.some(task => task.addedBy === "mother"))
          setGraph(current => withAddedAgents(current, found.tasks));
        const motherLines = decided.slice(seen).map(line => ({ ...line, at: line.at ?? Date.now() }));
        if (lines.length || stopLines.length || motherLines.length)
          setLog(current => [...current, ...lines, ...motherLines, ...stopLines]);
      }
      return found;
    };
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        let next = run;
        // Her record says how his stage goes: the bridge starts the Father after her part and delivers his report
        // (bridge/client.mjs #workflowEnded), so the run goes on when this screen is closed.
        const hers = await read(run.rootThreadId, run.graphId);
        if (hers && hers.status !== run.status) {
          next = { ...next, status: hers.status, ...(hers.error ? { error: hers.error } : {}) };
          if (live) setLog(current => [...current, ...stoppedLine(hers.status, hers.error, Date.now())]);
        }
        const father = next.father,
          stage = hers?.next;
        if (
          father &&
          stage &&
          (stage.threadId !== father.threadId ||
            stage.status !== father.status ||
            !!stage.reported !== !!father.reported)
        ) {
          next = {
            ...next,
            father: {
              ...father,
              threadId: stage.threadId,
              graphId: stage.graphId,
              status: stage.status,
              reported: stage.reported,
            },
          };
          if (stage.reported && !father.reported)
            setLog(current => [
              ...current,
              { at: Date.now(), text: "FATHER REPORT RECEIVED · DATASTORE CAPTURED · Mother agent", tone: "done" },
            ]);
        }
        if (stage?.error && live) setNotice(runFailure(stage.error));
        // His own run is read in a poll that did not just change him: the change restarts this effect, which reads at once.
        if (next.father === father && father?.threadId && father.graphId && !father.reported)
          await read(father.threadId, father.graphId);
        if (live)
          setRun(current => {
            const value = over(next) ? { ...next, endedAt: Date.now() } : next;
            return sameData(current, value) ? current : value;
          });
      } catch (error) {
        if (live) setNotice(runFailure(errorText(error)));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [run, ready]);
  return {};
}

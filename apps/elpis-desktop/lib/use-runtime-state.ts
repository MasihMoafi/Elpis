import { useRef, useState } from "react";
import type { FailedTurn } from "@/components/failed-turn-card";
import type { TaskPlan } from "@/components/task-list";
import type { Approval } from "@/lib/api";
import type { WorkflowReplay } from "@/lib/workspace-types";

export function useRuntimeState() {
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("Connecting to Elpis…");
  const [ready, setReady] = useState(false);
  const [runtimeNotices, setRuntimeNotices] = useState<Record<string, string>>({});
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, TaskPlan>>({});
  // A fast turn can finish over SSE before its HTTP start response arrives.
  const completedTurns = useRef(new Set<string>());
  const markTurnStarted = (threadId: string, turnId: string) => {
    if (!completedTurns.current.has(turnId)) setActiveTurns(prev => ({ ...prev, [threadId]: turnId }));
  };
  // A resume snapshot must not overwrite a newer turn event or settings announcement.
  const turnRevisions = useRef<Record<string, number>>({});
  const modeRevisions = useRef<Record<string, number>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [liveError, setLiveError] = useState<Record<string, string>>({});
  const [historyOnly, setHistoryOnly] = useState<Record<string, boolean>>({});
  const [failedTurns, setFailedTurns] = useState<Record<string, FailedTurn>>({});
  const [stoppedTurns, setStoppedTurns] = useState<Record<string, string>>({});
  const [accountRefresh, setAccountRefresh] = useState(0);
  const [replays, setReplays] = useState<WorkflowReplay[]>([]);
  return {
    connected,
    setConnected,
    connectionStatus,
    setConnectionStatus,
    ready,
    setReady,
    runtimeNotices,
    setRuntimeNotices,
    activeTurns,
    setActiveTurns,
    plans,
    setPlans,
    completedTurns,
    markTurnStarted,
    turnRevisions,
    modeRevisions,
    approvals,
    setApprovals,
    activity,
    setActivity,
    liveError,
    setLiveError,
    historyOnly,
    setHistoryOnly,
    failedTurns,
    setFailedTurns,
    stoppedTurns,
    setStoppedTurns,
    accountRefresh,
    setAccountRefresh,
    replays,
    setReplays,
  };
}

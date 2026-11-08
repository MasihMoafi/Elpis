import { useReactFlow } from "@xyflow/react";
import { api } from "@/lib/api";
import { type ReadyMade, TEMPLATES, applyPlan, boardForPlan, withMother, type CanvasGraph, type MotherSettings, type Plan, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import type * as React from "react";
import { Run, BoardMenu, Props } from "./types";
import { editKey } from "./graph-key";
import { FIT } from "./constants";
import { useProjectFolders } from "./folders";

export function canvasPlanning({ runtimeAttempt, recordedRun, planning, startingRun, setNotice, cwd, readyMade, graph, buildReadyMade, mother, setPlanning, planStop, setMenu, project, limit, latest, checkpoint, workflowCatalog, setRun, setStates, setDashboardId, setUndoLoad, setGraph, setSelection, flow }: {
  runtimeAttempt: () => () => boolean;
  recordedRun: Props["recordedRun"];
  planning: string;
  startingRun: React.RefObject<boolean>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
  cwd: Props["cwd"];
  readyMade: (id?: string) => ReadyMade | undefined;
  graph: CanvasGraph;
  buildReadyMade: (workflow: ReadyMade, goal: string) => Promise<CanvasGraph | null>;
  mother: MotherSettings;
  setPlanning: React.Dispatch<React.SetStateAction<string>>;
  planStop: React.RefObject<AbortController | null>;
  setMenu: React.Dispatch<React.SetStateAction<BoardMenu | null>>;
  project: ReturnType<typeof useProjectFolders>;
  limit: number;
  latest: React.RefObject<CanvasGraph>;
  checkpoint: () => void;
  workflowCatalog: Props["workflowCatalog"];
  setRun: React.Dispatch<React.SetStateAction<Run | null>>;
  setStates: React.Dispatch<React.SetStateAction<Record<string, { status: TaskStatus; chat: string | null; activity?: string | undefined; }>>>;
  setDashboardId: React.Dispatch<React.SetStateAction<string | null>>;
  setUndoLoad: React.Dispatch<React.SetStateAction<{ loaded: string; previous: CanvasGraph; } | null>>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>;
  setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  flow: ReturnType<typeof useReactFlow>
}) {
  async function letElpis(goal: string, scope?: CanvasGraph, newWorkflow = false, forRun = false): Promise<CanvasGraph | null> {
    const current = runtimeAttempt();
    if (!current()) return null;
    if (recordedRun) return null;
    if (planning || startingRun.current && !forRun) { setNotice("Wait for the current design to finish."); return null; }
    if (!cwd) { setNotice("Choose the project the agents work in, then try again."); return null; }
    const readyWorkflow = newWorkflow && readyMade(graph.planningPattern);
    if (readyWorkflow) return buildReadyMade(readyWorkflow, goal);
    const chosenPattern = newWorkflow ? TEMPLATES.find(item => item.id === graph.planningPattern) : undefined;
    const starter = chosenPattern?.build();
    const base = newWorkflow ? withMother({ ...starter, name: "Workflow", request: goal,
      nodes: starter?.nodes.map(node => node.type === "agent" ? { ...node, data: { ...node.data, instruction: "", writeScopes: [], acceptanceCriteria: [] } } : node) ?? [],
      edges: starter?.edges ?? [], template: chosenPattern?.id, planningPattern: graph.planningPattern ?? "auto", maxAgents: graph.maxAgents, mother: { ...mother, brief: goal } }) : graph;
    const planningGoal = chosenPattern ? `${goal}\n\nUse the selected ${chosenPattern.name} pattern exactly: keep these agents and their dependencies, without adding or removing agents. Tailor their prompts, folders and completion checks to this goal.` : goal;
    setPlanning(goal); setNotice(""); setMenu(null);
    const stop = new AbortController(); planStop.current = stop;
    try {
      const plan = await api<Plan>("/canvas/plan", { goal: planningGoal, cwd, folders: project.folders ?? [], agents: boardForPlan(scope ?? base), maxAgents: limit }, stop.signal);
      if (!current()) return null;
      if (editKey(latest.current) !== editKey(graph)) throw Error("The current workflow changed while Elpis was designing. Your changes are kept; try again.");
      if (chosenPattern) {
        const selected = boardForPlan(base);
        if (plan.agents.length !== selected.length || selected.some(agent => {
          const planned = plan.agents.find(item => item.key === agent.key);
          return !planned || JSON.stringify([...planned.waitsFor].sort()) !== JSON.stringify([...agent.waitsFor].sort());
        })) throw Error("Elpis changed the selected pattern. Your current workflow is kept; try again.");
      }
      // A scoped run may fill its missing instructions, but cannot redesign the board behind its scope preview.
      const next = scope ? { ...graph, nodes: graph.nodes.map(node => {
        const item = scope.nodes.some(item => item.id === node.id) && plan.agents.find(item => item.key === node.id);
        return node.type === "agent" && item ? { ...node, data: { ...node.data, instruction: node.data.instruction.trim() ? node.data.instruction : item.prompt, writeScopes: node.data.writeScopes.length ? node.data.writeScopes : item.folders, acceptanceCriteria: node.data.acceptanceCriteria.length ? node.data.acceptanceCriteria : item.doneWhen } } : node;
      }) } : applyPlan(base, plan);
      if (newWorkflow) { checkpoint(); void workflowCatalog.refresh(); setRun(null); setStates({}); setDashboardId(null); setUndoLoad(null); }
      setGraph(next); setSelection([]);
      // The planner says why it chose one agent or a team (28 Oct: Mother as a parent who does a simple task herself).
      if (newWorkflow && plan.why?.trim()) setNotice(`${plan.mode === "direct" ? "One agent does it" : `A team of ${plan.agents.length}`}: ${plan.why.trim()}`);
      setTimeout(() => void flow.fitView({ ...FIT, duration: 250 }), 60);
      return next;
    } catch (error) { if (current()) setNotice(stop.signal.aborted ? "Stopped. Your workflow is unchanged." : `Elpis could not fill in the team: ${errorText(error)}`); return null; }
    finally { planStop.current = null; setPlanning(""); }
  }
  return { letElpis };
}
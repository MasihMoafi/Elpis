import { checkOf, waits, type CanvasGraph } from "@/lib/canvas";

export type LabStage = { id: string; title: string; instruction: string; kind: "implement" | "verify"; dependsOn: string[] };
export type LabRequest = { pattern: string; task: string; expected: string; repetitions: number; stages: LabStage[] };
export type LabStep = { id: string; title: string; kind: string; prompt: string; startedAt: string; elapsedMs: number; threadId?: string; raw?: string; usage: { totalTokens: number; inputTokens?: number; outputTokens?: number } | null; output: { answer: string; report: string } | null; error: string | null };
export type LabTrial = { arm: "baseline" | "pattern"; repetition: number; elapsedMs: number; tokens: number | null; passed: boolean; answer: string; error: string | null; steps: LabStep[]; endedAt?: string };
export type LabRecord = { version: number; id: string; status: "running" | "completed" | "stopped" | "failed" | "interrupted"; startedAt: string; endedAt?: string; model: string; request: LabRequest; trials: LabTrial[]; error: string | null };

/** Same dependency graph and automatic checks as Canvas, adapted to text reports instead of project files. */
export function labStages(graph: CanvasGraph): LabStage[] {
  const agents = graph.nodes.filter(node => node.type === "agent");
  const stages: LabStage[] = agents.flatMap(node => [
    { id: node.id, title: node.data.title || "Agent", instruction: node.data.instruction || "Solve your part of the task.", kind: "implement" as const,
      dependsOn: graph.edges.filter(edge => waits(edge) && edge.target === node.id && agents.some(agent => agent.id === edge.source)).map(edge => checkOf(edge.source)) },
    { id: checkOf(node.id), title: `Check: ${node.data.title || "Agent"}`, instruction: "Critique the predecessor's answer against the task. Put actionable feedback in report; copy its answer unchanged into answer. This critique is not the experiment's pass/fail check.", kind: "verify" as const, dependsOn: [node.id] },
  ]);
  const sinks = stages.filter(stage => !stages.some(next => next.dependsOn.includes(stage.id)));
  if (sinks.length > 1) stages.push({ id: "lab-final-answer", title: "Combine the answers", kind: "implement", instruction: "Combine the predecessors' work into one final answer to the whole task.", dependsOn: sinks.map(stage => stage.id) });
  return stages;
}

export function labSummary(record: LabRecord, arm: LabTrial["arm"]) {
  const trials = record.trials.filter(trial => trial.arm === arm && trial.endedAt);
  const count = trials.length, known = trials.filter(trial => trial.tokens !== null);
  return { count, passed: trials.filter(trial => trial.passed).length, elapsedMs: count ? trials.reduce((sum, t) => sum + t.elapsedMs, 0) / count : null,
    tokens: count && known.length === count ? known.reduce((sum, t) => sum + t.tokens!, 0) / count : null };
}

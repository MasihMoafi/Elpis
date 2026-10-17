import { appStorage } from "@/lib/projects";

/** The agents canvas (components/agents-canvas.tsx): agents are nodes, a wire A → B means B waits for A, and a run
 * sends the graph to Elpis's work-graph engine (POST /api/workflows/run, bridge/client.mjs `runWorkflow`). */
export type AgentKind = "explore" | "implement" | "verify" | "fix";
export type AgentData = { kind: AgentKind; title: string; instruction: string; model: string | null; writeScopes: string[]; acceptanceCriteria: string[] };
export type NoteData = { text: string };
type Position = { x: number; y: number };
export type CanvasNode = { id: string; type: "agent"; position: Position; data: AgentData } | { id: string; type: "note"; position: Position; data: NoteData };
export type CanvasEdge = { id: string; source: string; target: string };
export type CanvasGraph = { name: string; nodes: CanvasNode[]; edges: CanvasEdge[] };
/** A task's state as workGraph/list reports it (codex-rs state/src/model/work_graph.rs). */
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type RunTask = { id: string; kind: AgentKind; title: string; instruction: string; dependsOn: string[]; writeScopes: string[]; acceptanceCriteria: string[]; model?: string };

export const KINDS: Record<AgentKind, { label: string; hint: string }> = {
  explore: { label: "Explore", hint: "Reads and maps; changes nothing" },
  implement: { label: "Implement", hint: "Changes files within what it may write" },
  verify: { label: "Verify", hint: "Checks the work and must show evidence" },
  fix: { label: "Fix", hint: "Repairs what a verifier found" },
};

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const agent = (kind: AgentKind, title: string, instruction: string, x: number, y: number, extra: Partial<AgentData> = {}): CanvasNode =>
  ({ id: newId(kind), type: "agent", position: { x, y }, data: { kind, title, instruction, model: null, writeScopes: [], acceptanceCriteria: [], ...extra } });
const wire = (source: CanvasNode, target: CanvasNode): CanvasEdge => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id });

/** The ready-made architectures, laid out left to right in the order they run. */
export const TEMPLATES: { id: string; name: string; description: string; build: () => CanvasGraph }[] = [
  { id: "plan-build-verify", name: "Plan → Build → Verify", description: "One explorer, two builders side by side, a verifier that must show evidence.", build: () => {
    const map = agent("explore", "Map the code", "Find the code involved and list what must change.", 0, 120);
    const a = agent("implement", "Build part one", "Make the first change the map calls for.", 300, 30);
    const b = agent("implement", "Build part two", "Make the second change, in different files.", 300, 210);
    const check = agent("verify", "Run the suite", "Run the tests and show their output.", 600, 120, { acceptanceCriteria: ["All tests pass"] });
    return { name: "Plan → Build → Verify", nodes: [map, a, b, check], edges: [wire(map, a), wire(map, b), wire(a, check), wire(b, check)] };
  } },
  { id: "fan-out", name: "Fan-out research", description: "Three explorers on separate questions; one writer merges what they found.", build: () => {
    const questions = ["How it works now", "What others do", "What could break"].map((title, index) => agent("explore", title, `Answer: ${title.toLowerCase()}. Cite files and sources.`, 0, index * 150));
    const merge = agent("implement", "Write it up", "Merge the three findings into one short report.", 320, 150);
    return { name: "Fan-out research", nodes: [...questions, merge], edges: questions.map(question => wire(question, merge)) };
  } },
  { id: "debate", name: "Debate + judge", description: "Two agents argue opposite designs; a judge picks one, with reasons.", build: () => {
    const pro = agent("explore", "Argue for A", "Make the strongest case for design A.", 0, 30), con = agent("explore", "Argue for B", "Make the strongest case for design B.", 0, 210);
    const judge = agent("verify", "Judge", "Weigh both cases and pick one, with reasons.", 320, 120);
    return { name: "Debate + judge", nodes: [pro, con, judge], edges: [wire(pro, judge), wire(con, judge)] };
  } },
  { id: "fix-loop", name: "Fix loop", description: "Build, verify, fix, verify again.", build: () => {
    const build = agent("implement", "Build it", "Make the change.", 0, 120), first = agent("verify", "Check it", "Run the tests and show their output.", 280, 120);
    const fix = agent("fix", "Fix what failed", "Repair whatever the check found.", 560, 120), again = agent("verify", "Check again", "Run the tests again and show their output.", 840, 120);
    return { name: "Fix loop", nodes: [build, first, fix, again], edges: [wire(build, first), wire(first, fix), wire(fix, again)] };
  } },
  { id: "blank", name: "Blank playground", description: "Start empty: drop agents and notes anywhere and wire them yourself.", build: () => ({ name: "Untitled graph", nodes: [], edges: [] }) },
];

/** Whether wiring source → target (target waits for source) closes a loop: it does if target already leads to source. */
export function makesLoop(edges: CanvasEdge[], source: string, target: string) {
  const seen = new Set<string>(), queue = [target];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) queue.push(edge.target);
  }
  return false;
}

/** The graph as the tasks Elpis runs, or what is missing first. Notes are not sent. */
export function runTasks(graph: CanvasGraph): { tasks: RunTask[] } | { error: string } {
  const agents = graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");
  if (!agents.length) return { error: "Add an agent before running the graph." };
  const ids = new Set(agents.map(node => node.id));
  for (const node of agents) {
    if (!node.data.title.trim()) return { error: "Every agent needs a name." };
    if (!node.data.instruction.trim()) return { error: `“${node.data.title}” needs an instruction.` };
  }
  return { tasks: agents.map(node => ({
    id: node.id, kind: node.data.kind, title: node.data.title.trim(), instruction: node.data.instruction.trim(),
    dependsOn: graph.edges.filter(edge => edge.target === node.id && ids.has(edge.source)).map(edge => edge.source),
    writeScopes: node.data.writeScopes, acceptanceCriteria: node.data.acceptanceCriteria,
    ...(node.data.model ? { model: node.data.model } : {}),
  })) };
}

const KEY = "elpis-workflow-draft-v1";
/** The graph on this device, or null when none was saved (or it can't be read). */
export function readGraph(): CanvasGraph | null {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) ?? "null");
    return value && Array.isArray(value.nodes) && Array.isArray(value.edges) && typeof value.name === "string" ? value : null;
  } catch { return null; }
}
export function saveGraph(graph: CanvasGraph) {
  try { appStorage().setItem(KEY, JSON.stringify(graph)); return true; } catch { return false; }
}

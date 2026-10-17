import { appStorage } from "@/lib/projects";

/** The agents canvas (components/agents-canvas.tsx): agents are nodes, a wire A → B means B waits for A, and a run
 * sends the graph to Elpis's work-graph engine (POST /api/workflows/run, bridge/client.mjs `runWorkflow`). */
export type AgentKind = "plan" | "explore" | "implement" | "verify" | "fix";
/** The roles Elpis's work graph knows (codex-rs state/src/model/work_graph.rs `WorkGraphTaskKind`); Plan runs as Explore. */
type EngineKind = "explore" | "implement" | "verify" | "fix";
/** `provider` is null for the engine's own provider; `effort` (thinking level) is kept and shown, but Elpis's work graph
 * has no per-agent thinking level yet, so a run does not send it (lat.md/tasks.md). */
export type AgentData = { kind: AgentKind; title: string; instruction: string; model: string | null; provider?: string | null; effort?: string | null; writeScopes: string[]; acceptanceCriteria: string[] };
export type NoteData = { text: string };
type Position = { x: number; y: number };
export type CanvasNode = { id: string; type: "agent"; position: Position; data: AgentData } | { id: string; type: "note"; position: Position; data: NoteData }
  | { id: typeof MOTHER; type: "mother"; position: Position; data: Record<string, never> };
export type CanvasEdge = { id: string; source: string; target: string };
/** `maxAgents` is the most agents the graph may hold. */
export type CanvasGraph = { name: string; nodes: CanvasNode[]; edges: CanvasEdge[]; maxAgents?: number };
/** A task's state as workGraph/list reports it (codex-rs state/src/model/work_graph.rs). */
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type RunTask = { id: string; kind: EngineKind; title: string; instruction: string; dependsOn: string[]; writeScopes: string[]; acceptanceCriteria: string[]; provider?: string; model?: string };

export const KINDS: Record<AgentKind, { label: string; hint: string; engine: EngineKind }> = {
  plan: { label: "Plan", hint: "Writes the plan the next agents follow; changes nothing", engine: "explore" },
  explore: { label: "Explore", hint: "Reads and maps; changes nothing", engine: "explore" },
  implement: { label: "Implement", hint: "Changes files within what it may write", engine: "implement" },
  verify: { label: "Verify", hint: "Checks the work and must show evidence", engine: "verify" },
  fix: { label: "Fix", hint: "Repairs what a verifier found", engine: "fix" },
};
/** What a Plan agent is told before its own instruction, since the engine runs it as an explorer. */
const PLAN_BRIEF = "Plan only: write a numbered plan the agents after you will follow, naming the files to change and the checks that prove it works. Change nothing.";

/** The Mother node: the chat a run starts in. Every agent is her child; she starts the agents that wait for no one and
 * receives every report. She is drawn, never sent: Elpis's work graph takes her chat as its root thread. */
export const MOTHER = "mother";
/** The default most agents a graph holds; past 10 a Father agent is to share the work (lat.md/tasks.md). */
export const MAX_AGENTS = 10;
export const maxAgents = (graph: CanvasGraph) => graph.maxAgents ?? MAX_AGENTS;
const agentsOf = (graph: CanvasGraph) => graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const agent = (kind: AgentKind, title: string, instruction: string, x: number, y: number, extra: Partial<AgentData> = {}): CanvasNode =>
  ({ id: newId(kind), type: "agent", position: { x, y }, data: { kind, title, instruction, model: null, writeScopes: [], acceptanceCriteria: [], ...extra } });
const wire = (source: CanvasNode, target: CanvasNode): CanvasEdge => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id });

/** The ready-made architectures: the workflow patterns of Anthropic's "Building effective agents", its multi-agent
 * research system, LangGraph's hierarchical teams and Open Deep Research. Each is laid out in run order (`arrange`).
 * Routing is left out: the engine runs every branch of a graph, so it can't pick one. */
type Template = { id: string; name: string; group: "Patterns" | "Research" | "Start"; source: string; description: string; build: () => CanvasGraph };
const ANTHROPIC = "Anthropic, Building effective agents";
const graphOf = (name: string, nodes: CanvasNode[], edges: CanvasEdge[]) => arrange(withMother({ name, nodes, edges }));
const chain = (...steps: CanvasNode[]) => steps.slice(1).map((step, index) => wire(steps[index], step));
const fan = (from: CanvasNode[], to: CanvasNode[]) => from.flatMap(source => to.map(target => wire(source, target)));
const at = 0;
export const TEMPLATES: Template[] = [
  { id: "plan-build-verify", name: "Plan → Build → Verify", group: "Patterns", source: ANTHROPIC, description: "A planner, two builders side by side, a verifier that must show evidence.", build: () => {
    const plan = agent("plan", "Plan the change", "Find the code involved and list what must change.", at, at);
    const a = agent("implement", "Build part one", "Make the first change the plan calls for.", at, at), b = agent("implement", "Build part two", "Make the second change, in different files.", at, at);
    const check = agent("verify", "Run the suite", "Run the tests and show their output.", at, at, { acceptanceCriteria: ["All tests pass"] });
    return graphOf("Plan → Build → Verify", [plan, a, b, check], [...fan([plan], [a, b]), ...fan([a, b], [check])]);
  } },
  { id: "sequential", name: "Sequential (prompt chaining)", group: "Patterns", source: ANTHROPIC, description: "Each step works on the last one's result: plan, build, check.", build: () => {
    const steps = [agent("plan", "Plan it", "Write the steps for this change.", at, at), agent("implement", "Build it", "Carry out the plan.", at, at), agent("verify", "Check it", "Run the tests and show their output.", at, at)];
    return graphOf("Sequential", steps, chain(...steps));
  } },
  { id: "parallel", name: "Parallel (sectioning)", group: "Patterns", source: ANTHROPIC, description: "A plan splits the work into independent parts built at once, then one check.", build: () => {
    const plan = agent("plan", "Split the work", "Split the change into three parts that touch different files.", at, at);
    const parts = ["one", "two", "three"].map(part => agent("implement", `Build part ${part}`, `Build part ${part} of the plan.`, at, at)), check = agent("verify", "Check it all", "Run the tests and show their output.", at, at);
    return graphOf("Parallel", [plan, ...parts, check], [...fan([plan], parts), ...fan(parts, [check])]);
  } },
  { id: "voting", name: "Voting", group: "Patterns", source: ANTHROPIC, description: "Three agents answer the same question on their own; a judge takes the majority.", build: () => {
    const voters = [1, 2, 3].map(index => agent("explore", `Answer ${index}`, "Answer the question on your own, with evidence.", at, at)), judge = agent("verify", "Tally the answers", "Compare the three answers and give the majority, with reasons.", at, at);
    return graphOf("Voting", [...voters, judge], fan(voters, [judge]));
  } },
  { id: "hierarchical", name: "Hierarchical (orchestrator and teams)", group: "Patterns", source: "Anthropic's orchestrator-workers; LangGraph's hierarchical teams", description: "A lead splits the work between two team leads, each with two workers; one integration check.", build: () => {
    const lead = agent("plan", "Lead: split the work", "Split the work into two areas and brief a team lead on each.", at, at);
    const teams = ["A", "B"].map(team => ({ lead: agent("plan", `Team ${team} lead`, `Plan area ${team} for your two workers.`, at, at), workers: [1, 2].map(index => agent("implement", `Team ${team} worker ${index}`, `Do your part of area ${team}.`, at, at)) }));
    const check = agent("verify", "Integrate and check", "Check the two areas work together; show the test output.", at, at);
    return graphOf("Hierarchical", [lead, ...teams.flatMap(team => [team.lead, ...team.workers]), check], [...teams.flatMap(team => [wire(lead, team.lead), ...fan([team.lead], team.workers), ...fan(team.workers, [check])])]);
  } },
  { id: "evaluator-optimizer", name: "Evaluator–optimizer", group: "Patterns", source: ANTHROPIC, description: "Draft, review against the criteria, improve, review again.", build: () => {
    const steps = [agent("implement", "Draft it", "Make the change.", at, at), agent("verify", "Review it", "Review the change against the criteria and list what falls short.", at, at), agent("fix", "Improve it", "Fix what the review found.", at, at), agent("verify", "Review again", "Review again and show the evidence.", at, at)];
    return graphOf("Evaluator–optimizer", steps, chain(...steps));
  } },
  { id: "debate", name: "Debate + judge", group: "Patterns", source: "Multi-agent debate", description: "Two agents argue opposite designs; a judge picks one, with reasons.", build: () => {
    const pro = agent("explore", "Argue for A", "Make the strongest case for design A.", at, at), con = agent("explore", "Argue for B", "Make the strongest case for design B.", at, at);
    const judge = agent("verify", "Judge", "Weigh both cases and pick one, with reasons.", at, at);
    return graphOf("Debate + judge", [pro, con, judge], fan([pro, con], [judge]));
  } },
  { id: "research", name: "Multi-agent research", group: "Research", source: "Anthropic, How we built our multi-agent research system", description: "A lead researcher plans; four subagents search in parallel; a writer synthesizes; a citation check.", build: () => {
    const lead = agent("plan", "Lead researcher", "Plan the research: split the question into four parts, one per subagent.", at, at);
    const subagents = [1, 2, 3, 4].map(index => agent("explore", `Research part ${index}`, `Research part ${index} of the lead's plan. Cite every source.`, at, at));
    const write = agent("implement", "Write the report", "Synthesize the four findings into one report.", at, at), cite = agent("verify", "Check the citations", "Check every claim in the report against its cited source.", at, at);
    return graphOf("Multi-agent research", [lead, ...subagents, write, cite], [...fan([lead], subagents), ...fan(subagents, [write]), wire(write, cite)]);
  } },
  { id: "deep-research", name: "Deep research", group: "Research", source: "LangGraph, Open Deep Research", description: "Scope a brief, a supervisor splits it, researchers work in parallel, one final report.", build: () => {
    const scope = agent("plan", "Scope the brief", "Write the research brief: the question, what is in and out of scope.", at, at);
    const supervisor = agent("plan", "Supervisor", "Split the brief into three research topics.", at, at);
    const researchers = [1, 2, 3].map(index => agent("explore", `Researcher ${index}`, `Research topic ${index}; return compressed findings with sources.`, at, at));
    const report = agent("implement", "Final report", "Write the final report from the findings, with sources.", at, at);
    return graphOf("Deep research", [scope, supervisor, ...researchers, report], [wire(scope, supervisor), ...fan([supervisor], researchers), ...fan(researchers, [report])]);
  } },
  { id: "blank", name: "Blank playground", group: "Start", source: "", description: "Start empty: add agents with Tab or Ctrl+A and wire them yourself.", build: () => withMother({ name: "Untitled graph", nodes: [], edges: [] }) },
];

/** Kahn's algorithm, in waves: wave 1 waits for no one, and each later wave waits only for earlier ones. This is the
 * order the engine can start them in (codex-rs state/src/model/work_graph.rs checks the graph the same way). Agents
 * on a loop get no wave; loops are refused when wired. */
export function waves(graph: CanvasGraph): Map<string, number> {
  const ids = new Set(agentsOf(graph).map(node => node.id)), edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  const waiting = new Map([...ids].map(id => [id, edges.filter(edge => edge.target === id).length]));
  const wave = new Map<string, number>();
  for (let frontier = [...ids].filter(id => !waiting.get(id)), level = 1; frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      wave.set(id, level);
      for (const edge of edges) if (edge.source === id) { const left = waiting.get(edge.target)! - 1; waiting.set(edge.target, left); if (!left) next.push(edge.target); }
    }
    frontier = next;
  }
  return wave;
}

const COLUMN = 260, ROW = 120;
/** The graph with its Mother: a graph without one (a template, or one saved before she existed) gets her a column
 * left of the first wave, level with it. */
export function withMother(graph: CanvasGraph): CanvasGraph {
  if (graph.nodes.some(node => node.type === "mother")) return graph;
  const agents = agentsOf(graph), wave = waves(graph), first = agents.filter(node => wave.get(node.id) === 1), ys = (first.length ? first : agents).map(node => node.position.y);
  const position = agents.length ? { x: Math.min(...agents.map(node => node.position.x)) - COLUMN, y: Math.round(ys.reduce((sum, y) => sum + y, 0) / ys.length) } : { x: -COLUMN, y: 0 };
  return { ...graph, nodes: [{ id: MOTHER, type: "mother", position, data: {} }, ...graph.nodes] };
}

/** Lays the agents out in run order: the Mother, then one column per wave, each column centred and kept in the order
 * the user had it. Notes stay where they are. */
export function arrange(graph: CanvasGraph): CanvasGraph {
  const wave = waves(graph), columns = new Map<number, Extract<CanvasNode, { type: "agent" }>[]>();
  for (const node of agentsOf(graph)) { const level = wave.get(node.id) ?? 0; columns.set(level, [...(columns.get(level) ?? []), node]); }
  const position = new Map<string, Position>();
  for (const [level, column] of columns) column.sort((a, b) => a.position.y - b.position.y).forEach((node, index) => position.set(node.id, { x: level * COLUMN, y: Math.round((index - (column.length - 1) / 2) * ROW) }));
  position.set(MOTHER, { x: 0, y: 0 });
  return { ...graph, nodes: graph.nodes.map(node => position.has(node.id) ? { ...node, position: position.get(node.id)! } : node) };
}

/** An agent's name from its task: the task's start, cut at a word. */
export const nameFrom = (task: string) => task.length <= 48 ? task : `${task.slice(0, 48).replace(/\s+\S*$/, "")}…`;
/** `count` new agents of one kind and one model, stacked from `at`. Agent n takes task n as its instruction and named
 * after it; one without a task is numbered when there are several, and must get one before the graph runs. */
export function newAgents(kind: AgentKind, count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, at: Position, tasks: string[] = []): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => {
    const task = tasks[index]?.trim() ?? "";
    return agent(kind, task ? nameFrom(task) : `New ${KINDS[kind].label} agent${count > 1 ? ` ${index + 1}` : ""}`, task, at.x, at.y + index * ROW, { model: choice.model, provider: choice.provider ?? null, effort: choice.effort ?? null });
  });
}

/** A model an agent can run on: Elpis's work graph takes native providers only (bridge/client.mjs `runWorkflow`). */
export type CatalogModel = { provider: string | null; providerLabel: string; model: string; label: string; efforts: string[]; defaultEffort: string | null };
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/** A typed command, AutoCAD-style: `3 implement sol high: fix the parser; fix the lexer`. A number is how many, a word
 * the kind, the model (any words of its name, `@provider` to pick the provider) and the thinking level, in any order;
 * after a colon, the tasks, separated by `;`. Words it can't place are listed, never guessed. */
export type Command = { count: number | null; kind: AgentKind | "note" | null; model: CatalogModel | null; effort: string | null; tasks: string[]; unknown: string[] };
export function parseCommand(text: string, catalog: CatalogModel[]): Command {
  const colon = text.indexOf(":"), head = colon < 0 ? text : text.slice(0, colon);
  const tasks = colon < 0 ? [] : text.slice(colon + 1).split(/[;\n]/).map(task => task.trim()).filter(Boolean);
  const command: Command = { count: null, kind: null, model: null, effort: null, tasks, unknown: [] };
  const words: string[] = [];
  let provider: string | null = null;
  for (const raw of head.toLowerCase().split(/\s+/).filter(Boolean)) for (const word of raw.match(/^(\d+)([a-z].*)$/)?.slice(1) ?? [raw]) {
    const kind = word.length >= 2 ? (["note", ...Object.keys(KINDS)] as (AgentKind | "note")[]).find(item => item.startsWith(word)) : undefined;
    const effort = word.length >= 3 ? EFFORTS.find(item => item.startsWith(word)) : undefined;
    if (/^\d+$/.test(word) && command.count === null) command.count = Number(word);
    else if (word.startsWith("@") && word.length > 1) provider = word.slice(1);
    else if (kind && !command.kind) command.kind = kind;
    else if (effort && !command.effort) command.effort = effort;
    else words.push(word);
  }
  if (words.length || provider) {
    const pool = catalog.filter(item => !provider || (item.provider ?? "").toLowerCase().startsWith(provider) || item.providerLabel.toLowerCase().startsWith(provider));
    const named = (item: CatalogModel) => `${item.label} ${item.model} ${item.providerLabel}`.toLowerCase();
    // Each word narrows the models; a word that would leave none is not part of the name.
    let matches = pool, named_ = false;
    for (const word of words) {
      const narrower = matches.filter(item => named(item).includes(word));
      if (narrower.length) { matches = narrower; named_ = true; } else command.unknown.push(word);
    }
    command.model = named_ ? matches[0] : null;
    if (provider && !pool.length) command.unknown.push(`@${provider}`);
  }
  return command;
}

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
  const agents = agentsOf(graph);
  if (!agents.length) return { error: "Add an agent before running the graph." };
  if (agents.length > maxAgents(graph)) return { error: `The graph has ${agents.length} agents; its limit is ${maxAgents(graph)}. Remove some or raise Max agents.` };
  const ids = new Set(agents.map(node => node.id));
  for (const node of agents) {
    if (!node.data.title.trim()) return { error: "Every agent needs a name." };
    if (!node.data.instruction.trim()) return { error: `“${node.data.title}” needs an instruction.` };
    if (node.data.provider && !node.data.model) return { error: `“${node.data.title}” needs a model from its provider.` };
  }
  return { tasks: agents.map(node => ({
    id: node.id, kind: KINDS[node.data.kind].engine, title: node.data.title.trim(),
    instruction: node.data.kind === "plan" ? `${PLAN_BRIEF}\n\n${node.data.instruction.trim()}` : node.data.instruction.trim(),
    dependsOn: graph.edges.filter(edge => edge.target === node.id && ids.has(edge.source)).map(edge => edge.source),
    writeScopes: node.data.writeScopes, acceptanceCriteria: node.data.acceptanceCriteria,
    ...(node.data.provider ? { provider: node.data.provider } : {}), ...(node.data.model ? { model: node.data.model } : {}),
  })) };
}

const KEY = "elpis-workflow-draft-v1";
/** The graph on this device, or null when none was saved (or it can't be read). */
export function readGraph(): CanvasGraph | null {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) ?? "null");
    return value && Array.isArray(value.nodes) && Array.isArray(value.edges) && typeof value.name === "string" ? withMother(value) : null;
  } catch { return null; }
}
export function saveGraph(graph: CanvasGraph) {
  try { appStorage().setItem(KEY, JSON.stringify(graph)); return true; } catch { return false; }
}

import { appStorage } from "@/lib/projects";

/** The agents canvas (components/agents-canvas.tsx): agents are nodes, a wire A → B means B waits for A, and a run
 * sends the graph to Elpis's work-graph engine (POST /api/workflows/run, bridge/client.mjs `runWorkflow`).
 * Every agent on the board writes: Elpis checks each writer with a read-only verify task, which the run adds itself
 * (`runTasks`), and reading or planning happens inside the writers (lat.md/tasks.md, 17 October 2026). */
/** `provider` is null for the engine's own provider; `effort` is the thinking level (sent per task); `writeScopes` are the project's
 * folders the agent may write, which Elpis requires to exist (codex-rs work_graphs.rs `validate_scope_resolution`). */
export type AgentData = { title: string; instruction: string; model: string | null; provider?: string | null; effort?: string | null; writeScopes: string[]; acceptanceCriteria: string[] };
export type NoteData = { text: string };
type Position = { x: number; y: number };
export type CanvasNode = { id: string; type: "agent"; position: Position; data: AgentData } | { id: string; type: "note"; position: Position; data: NoteData }
  | { id: typeof MOTHER; type: "mother"; position: Position; data: Record<string, never> };
export type CanvasEdge = { id: string; source: string; target: string };
/** The Mother's settings, for the whole run: its goal (`brief`), which every agent gets and from which Elpis fills in
 * what the user left empty, and the model of her chat (the run's root). */
export type MotherSettings = { brief: string; model: string | null; provider: string | null };
/** `maxAgents` is the most agents the graph may hold; `template` is the architecture it was loaded from. */
export type CanvasGraph = { name: string; nodes: CanvasNode[]; edges: CanvasEdge[]; maxAgents?: number; template?: string; mother?: MotherSettings };
/** A task's state as workGraph/list reports it (codex-rs state/src/model/work_graph.rs). */
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
/** `reasoningEffort` is the agent's thinking level; Elpis refuses one its model lacks before any agent starts. */
export type RunTask = { id: string; kind: "implement" | "verify"; title: string; instruction: string; dependsOn: string[]; writeScopes: string[]; acceptanceCriteria: string[]; provider?: string; model?: string; reasoningEffort?: string };

/** The Mother node: the chat a run starts in. Every agent is her child; she starts the agents that wait for no one and
 * receives every report. She is drawn, never sent: Elpis's work graph takes her chat as its root thread. */
export const MOTHER = "mother";
/** The default most agents a graph holds; past 10 a Father agent is to share the work (lat.md/tasks.md). */
export const MAX_AGENTS = 10;
export const maxAgents = (graph: CanvasGraph) => graph.maxAgents ?? MAX_AGENTS;
/** Each agent's check is its own engine task, so a graph of n agents is 2n tasks. */
export const TASKS_PER_AGENT = 2;
/** The id of an agent's check task; Elpis task ids take letters, digits, `-` and `_`. */
export const checkOf = (id: string) => `${id}-check`;
/** What an agent is held to when its "Done when" is left empty. */
export const DONE = "The change builds and its tests pass.";
const agentsOf = (graph: CanvasGraph) => graph.nodes.filter((node): node is Extract<CanvasNode, { type: "agent" }> => node.type === "agent");

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const agent = (title: string, instruction: string, extra: Partial<AgentData> = {}): CanvasNode =>
  ({ id: newId("agent"), type: "agent", position: { x: 0, y: 0 }, data: { title, instruction, model: null, writeScopes: [], acceptanceCriteria: [], ...extra } });
const wire = (source: CanvasNode, target: CanvasNode): CanvasEdge => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id });

/** The ready-made architectures: the workflow patterns of Anthropic's "Building effective agents", its multi-agent
 * research system, LangGraph's hierarchical teams and Open Deep Research, all as writing agents. Where a pattern has
 * no code to write (voting, debate, research), each agent writes its findings as a file in its folder and the last
 * one writes the result from them. Each is laid out in run order (`arrange`). Routing is left out: the engine runs
 * every branch of a graph, so it can't pick one. */
type Template = { id: string; name: string; group: "Patterns" | "Research" | "Start"; source: string; description: string; caution?: string; build: () => CanvasGraph };
const ANTHROPIC = "Anthropic, Building effective agents";
/** Anthropic's caution about splitting work by role (claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them). */
const BY_ROLE = "Split by role: Anthropic finds each handoff loses context, so this often does worse than split by parts.";
const NOTE = "as a markdown file in your folder";
const graphOf = (name: string, nodes: CanvasNode[], edges: CanvasEdge[]) => arrange(withMother({ name, nodes, edges }));
const chain = (...steps: CanvasNode[]) => steps.slice(1).map((step, index) => wire(steps[index], step));
const fan = (from: CanvasNode[], to: CanvasNode[]) => from.flatMap(source => to.map(target => wire(source, target)));
export const TEMPLATES: Template[] = [
  // The default: split by parts, as Anthropic advises (context isolation and parallelism, not roles).
  { id: "split-parts", name: "Split by parts", group: "Patterns", source: "Anthropic, Building multi-agent systems", description: "Each agent owns one independent part end to end: plans, builds and tests it in its own context. A last agent joins the parts.", build: () => {
    const parts = [1, 2, 3].map(index => agent(`Part ${index}`, `Own part ${index} end to end: plan it, build it and run its tests.`));
    const join = agent("Join the parts", "Make the parts work together: run the whole suite and fix what fails.", { acceptanceCriteria: ["The whole suite passes"] });
    return graphOf("Split by parts", [...parts, join], fan(parts, [join]));
  } },
  { id: "sequential", name: "Sequential (prompt chaining)", group: "Patterns", source: ANTHROPIC, description: "Each agent builds on the last one's work: the base, then the next layer, then the finish.", build: () => {
    const steps = [agent("Step 1: the base", "Build the base the next steps stand on."), agent("Step 2: build on it", "Build the next layer on step 1's work."), agent("Step 3: finish", "Finish and polish: edge cases, errors, docs.")];
    return graphOf("Sequential", steps, chain(...steps));
  } },
  { id: "plan-build", name: "Plan → Build", group: "Patterns", source: ANTHROPIC, caution: BY_ROLE, description: "One agent writes the plan as a file; two agents build its two halves side by side.", build: () => {
    const plan = agent("Write the plan", `Find the code involved and write a numbered plan ${NOTE}: the files to change and the checks that prove it works.`, { acceptanceCriteria: ["The plan names the files and the checks"] });
    const builders = ["first", "second"].map(half => agent(`Build the ${half} half`, `Build the ${half} half of the plan.`));
    return graphOf("Plan → Build", [plan, ...builders], fan([plan], builders));
  } },
  { id: "evaluator-optimizer", name: "Evaluator–optimizer", group: "Patterns", source: ANTHROPIC, description: "Draft it; its check evaluates the draft; a second agent improves it where the check found it short.", build: () => {
    const steps = [agent("Draft it", "Make the change."), agent("Improve it", "Improve the draft wherever its check found it short.")];
    return graphOf("Evaluator–optimizer", steps, chain(...steps));
  } },
  { id: "voting", name: "Voting", group: "Patterns", source: ANTHROPIC, description: "Three agents answer the same question on their own, each in a file; a fourth writes the majority answer.", build: () => {
    const voters = [1, 2, 3].map(index => agent(`Answer ${index}`, `Answer the question on your own, with evidence, ${NOTE}.`, { acceptanceCriteria: ["The answer file exists, with evidence"] }));
    const tally = agent("Tally the answers", `Compare the three answers and write the majority answer, with reasons, ${NOTE}.`, { acceptanceCriteria: ["The result names the majority and why"] });
    return graphOf("Voting", [...voters, tally], fan(voters, [tally]));
  } },
  { id: "hierarchical", name: "Hierarchical (orchestrator and teams)", group: "Patterns", source: "Anthropic's orchestrator-workers; LangGraph's hierarchical teams", description: "A lead writes the split; two team leads write their area's plan; two workers each build; a last agent joins the areas.", build: () => {
    const lead = agent("Lead: split the work", `Split the work into areas A and B ${NOTE}, with a brief for each team lead.`, { acceptanceCriteria: ["Each area has a brief"] });
    const teams = ["A", "B"].map(team => ({ lead: agent(`Team ${team} lead`, `Plan area ${team} for your two workers ${NOTE}.`, { acceptanceCriteria: ["The plan gives each worker a part"] }), workers: [1, 2].map(index => agent(`Team ${team} worker ${index}`, `Build your part of area ${team}.`)) }));
    const join = agent("Join the areas", "Make the two areas work together: run the whole suite and fix what fails.", { acceptanceCriteria: ["The whole suite passes"] });
    return graphOf("Hierarchical", [lead, ...teams.flatMap(team => [team.lead, ...team.workers]), join], [...teams.flatMap(team => [wire(lead, team.lead), ...fan([team.lead], team.workers), ...fan(team.workers, [join])])]);
  } },
  { id: "debate", name: "Debate + judge", group: "Patterns", source: "Multi-agent debate", description: "Two agents each write the strongest case for one design; a judge writes the decision, with reasons.", build: () => {
    const sides = ["A", "B"].map(side => agent(`Case for ${side}`, `Write the strongest case for design ${side} ${NOTE}.`, { acceptanceCriteria: ["The case file exists, with evidence"] }));
    const judge = agent("Judge", `Weigh both cases and write the decision, with reasons, ${NOTE}.`, { acceptanceCriteria: ["The decision picks one design and says why"] });
    return graphOf("Debate + judge", [...sides, judge], fan(sides, [judge]));
  } },
  { id: "research", name: "Multi-agent research", group: "Research", source: "Anthropic, How we built our multi-agent research system", description: "A lead writes the research plan; four agents research in parallel, each writing findings; one writes the report; one checks its citations.", build: () => {
    const lead = agent("Lead researcher", `Split the question into four parts, one per researcher, ${NOTE}.`, { acceptanceCriteria: ["Four parts, each with its question"] });
    const parts = [1, 2, 3, 4].map(index => agent(`Research part ${index}`, `Research part ${index} of the lead's plan and write the findings, citing every source, ${NOTE}.`, { acceptanceCriteria: ["Every finding cites its source"] }));
    const report = agent("Write the report", `Synthesize the four findings into one report ${NOTE}.`, { acceptanceCriteria: ["The report covers all four parts"] });
    const cite = agent("Check the citations", "Check every claim in the report against its cited source and correct the report where they differ.", { acceptanceCriteria: ["Every claim matches its source"] });
    return graphOf("Multi-agent research", [lead, ...parts, report, cite], [...fan([lead], parts), ...fan(parts, [report]), wire(report, cite)]);
  } },
  { id: "deep-research", name: "Deep research", group: "Research", source: "LangGraph, Open Deep Research", description: "Scope a brief, a supervisor splits it, three researchers write findings in parallel, one writes the final report.", build: () => {
    const scope = agent("Scope the brief", `Write the research brief: the question, what is in and out of scope, ${NOTE}.`, { acceptanceCriteria: ["The brief states the question and the scope"] });
    const supervisor = agent("Supervisor", `Split the brief into three research topics ${NOTE}.`, { acceptanceCriteria: ["Three topics, each with its question"] });
    const researchers = [1, 2, 3].map(index => agent(`Researcher ${index}`, `Research topic ${index} and write compressed findings with sources ${NOTE}.`, { acceptanceCriteria: ["Every finding cites its source"] }));
    const report = agent("Final report", `Write the final report from the findings, with sources, ${NOTE}.`, { acceptanceCriteria: ["The report answers the brief, with sources"] });
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

/** A graph's shape for a thumbnail: how many agents start in each Kahn wave. */
export function shapeOf(graph: CanvasGraph): number[] {
  const order = waves(graph), columns: number[] = [];
  for (const node of agentsOf(graph)) { const level = (order.get(node.id) ?? 1) - 1; columns[level] = (columns[level] ?? 0) + 1; }
  return columns.filter(Boolean);
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

/** An agent's name from its prompt: the prompt's start, cut at a word. */
export const nameFrom = (task: string) => task.length <= 48 ? task : `${task.slice(0, 48).replace(/\s+\S*$/, "")}…`;
/** `count` new agents on one model, stacked from `at`. Agent n takes prompt n and is named after it; one without a
 * prompt is numbered when there are several, and must get one before the graph runs. */
export function newAgents(count: number, choice: { model: string | null; provider?: string | null; effort?: string | null }, at: Position, prompts: string[] = []): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => {
    const prompt = prompts[index]?.trim() ?? "";
    const made = agent(prompt ? nameFrom(prompt) : `New agent${count > 1 ? ` ${index + 1}` : ""}`, prompt, { model: choice.model, provider: choice.provider ?? null, effort: choice.effort ?? null });
    return { ...made, position: { x: at.x, y: at.y + index * ROW } };
  });
}

/** A model an agent can run on: Elpis's work graph takes native providers only (bridge/client.mjs `runWorkflow`). */
export type CatalogModel = { provider: string | null; providerLabel: string; model: string; label: string; efforts: string[]; defaultEffort: string | null };
export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
/** A typed command, AutoCAD-style. A prompt alone adds one agent with it; more lines (Shift+Enter) or `;` add one
 * agent per prompt. Before a colon come how many, the model (any words of its name, `@provider` to pick the provider)
 * and the thinking level: `3 sol high: fix the parser; fix the lexer`. `note: text` adds a sticky note. A first line
 * that isn't all count, model and thinking level is itself a prompt; after an explicit colon, words the command can't
 * place are listed, never guessed. `prompted` says the whole text was read as prompts. */
export type Command = { count: number | null; note: boolean; model: CatalogModel | null; effort: string | null; tasks: string[]; unknown: string[]; prompted: boolean };
/** A command's first part (count, model, thinking) and the rest, which starts at the first colon or new line. */
export function commandParts(text: string) {
  const cut = text.search(/[:\n]/);
  return cut < 0 ? { head: text, rest: "" } : { head: text.slice(0, cut), rest: text.slice(cut) };
}
const prompts = (text: string) => text.split(/[;\n]/).map(task => task.trim()).filter(Boolean);
export function parseCommand(text: string, catalog: CatalogModel[]): Command {
  const { head, rest } = commandParts(text);
  const command: Command = { count: null, note: false, model: null, effort: null, tasks: prompts(rest.slice(1)), unknown: [], prompted: false };
  const words: string[] = [];
  let provider: string | null = null;
  for (const raw of head.toLowerCase().split(/\s+/).filter(Boolean)) for (const word of raw.match(/^(\d+)([a-z].*)$/)?.slice(1) ?? [raw]) {
    const effort = word.length >= 3 ? EFFORTS.find(item => item.startsWith(word)) : undefined;
    if (/^\d+$/.test(word) && command.count === null) command.count = Number(word);
    else if (word.startsWith("@") && word.length > 1) provider = word.slice(1);
    else if (word === "note" && !command.note) command.note = true;
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
  // Without a colon, a first line that isn't all command words is a prompt: the whole text is prompts.
  if (!rest.startsWith(":") && command.unknown.length) return { count: null, note: false, model: null, effort: null, tasks: prompts(text), unknown: [], prompted: true };
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

/** The graph as the tasks Elpis runs, or what is missing first. Notes are not sent. Each agent is a writer followed by
 * its own check (a read-only verify task, which Elpis requires after every writer); an agent wired after it waits
 * for that check, so it builds on checked work. */
export function runTasks(graph: CanvasGraph): { tasks: RunTask[] } | { error: string } {
  const agents = agentsOf(graph);
  if (!agents.length) return { error: "Add an agent before running the graph." };
  if (agents.length > maxAgents(graph)) return { error: `The graph has ${agents.length} agents; its limit is ${maxAgents(graph)}. Remove some or raise Max agents.` };
  const ids = new Set(agents.map(node => node.id));
  for (const node of agents) {
    if (!node.data.title.trim()) return { error: "Every agent needs a name." };
    if (!node.data.instruction.trim()) return { error: `“${node.data.title}” has no prompt: write one, or give the run a goal (Mother) and Elpis fills it in.` };
    if (!node.data.writeScopes.length) return { error: `“${node.data.title}” has no folder it may write: choose one, or give the run a goal (Mother) and Elpis fills it in.` };
    if (node.data.provider && !node.data.model) return { error: `“${node.data.title}” needs a model from its provider.` };
  }
  const brief = graph.mother?.brief.trim();
  return { tasks: agents.flatMap(node => {
    const title = node.data.title.trim(), prompt = node.data.instruction.trim();
    const criteria = node.data.acceptanceCriteria.length ? node.data.acceptanceCriteria : [DONE];
    const model = { ...(node.data.provider ? { provider: node.data.provider } : {}), ...(node.data.model ? { model: node.data.model } : {}) };
    return [
      // Every agent gets the Mother's brief first, then its own prompt.
      { id: node.id, kind: "implement" as const, title, instruction: [brief && `Goal of the whole run: ${brief}`, prompt].filter(Boolean).join("\n\n"),
        dependsOn: graph.edges.filter(edge => edge.target === node.id && ids.has(edge.source)).map(edge => checkOf(edge.source)),
        writeScopes: node.data.writeScopes, acceptanceCriteria: criteria, ...model, ...(node.data.effort ? { reasoningEffort: node.data.effort } : {}) },
      { id: checkOf(node.id), kind: "verify" as const, title: `Check: ${title}`.slice(0, 256),
        instruction: `Check the work of “${title}”. Its prompt was:\n${prompt}\n\nRun what proves it (the build, the tests, or reading what it wrote) and show the output. Say plainly whether each of these holds: ${criteria.join("; ")}`,
        dependsOn: [node.id], writeScopes: [], acceptanceCriteria: [`Each of “${title}”'s criteria is shown to hold or not, with evidence`], ...model },
    ];
  }) };
}

/** What Elpis designs from a goal (POST /api/canvas/plan, bridge/canvas-plan.mjs): the whole team, each agent keyed
 * (an existing agent keeps its id as its key) and wired by `waitsFor`. */
export type Plan = { name: string; agents: { key: string; title: string; prompt: string; folders: string[]; doneWhen: string[]; waitsFor: string[] }[] };
/** The board as the planner reads it. */
export const boardForPlan = (graph: CanvasGraph) => agentsOf(graph).map(node => ({ key: node.id, title: node.data.title, prompt: node.data.instruction, folders: node.data.writeScopes, doneWhen: node.data.acceptanceCriteria,
  waitsFor: graph.edges.filter(edge => edge.target === node.id).map(edge => edge.source) }));
/** The board after a plan: agents the plan keeps are updated in place, new ones are added, ones it leaves out are
 * removed, and the wires are the plan's. Models and thinking levels stay; notes stay. New agents are laid out in run
 * order. */
export function applyPlan(graph: CanvasGraph, plan: Plan): CanvasGraph {
  const kept = new Map(agentsOf(graph).map(node => [node.id, node])), ids = new Map<string, string>();
  const agents = plan.agents.map(item => {
    const old = kept.get(item.key), made = old ?? agent(item.title, item.prompt);
    ids.set(item.key, made.id);
    // What the plan leaves empty keeps what the agent had.
    const data = made.data as AgentData;
    return { ...made, data: { ...data, title: item.title || data.title, instruction: item.prompt || data.instruction, writeScopes: item.folders.length ? item.folders : data.writeScopes, acceptanceCriteria: item.doneWhen.length ? item.doneWhen : data.acceptanceCriteria } } as CanvasNode;
  });
  const edges = plan.agents.flatMap(item => item.waitsFor.filter(source => ids.has(source)).map(source => ({ id: `${ids.get(source)}->${ids.get(item.key)}`, source: ids.get(source)!, target: ids.get(item.key)! })));
  // A fresh team is laid out in run order; on a board the user laid out, only new agents are placed: right of what
  // they wait for, else below the rest.
  const reused = agents.filter(node => kept.has(node.id));
  if (!reused.length) return arrange({ ...graph, name: plan.name || graph.name, nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...agents], edges });
  const placed = new Map(reused.map(node => [node.id, node.position]));
  const left = Math.min(...reused.map(node => node.position.x));
  let below = Math.max(...reused.map(node => node.position.y));
  const positioned = agents.map((node, index) => {
    if (placed.has(node.id)) return node;
    const from = plan.agents[index].waitsFor.flatMap(key => { const at = placed.get(ids.get(key) ?? ""); return at ? [at] : []; });
    const position = from.length ? { x: Math.max(...from.map(at => at.x)) + COLUMN, y: from[0].y + ROW / 2 } : { x: left, y: (below += ROW) };
    placed.set(node.id, position);
    return { ...node, position };
  });
  return { ...graph, name: plan.name || graph.name, nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...positioned], edges };
}

const KEY = "elpis-workflow-draft-v1";
/** The graph on this device, or null when none was saved (or it can't be read). Agents saved with a role from before
 * every agent wrote come back as writers. */
export function readGraph(): CanvasGraph | null {
  try {
    const value = JSON.parse(appStorage().getItem(KEY) ?? "null");
    if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || typeof value.name !== "string") return null;
    const nodes = value.nodes.map((node: CanvasNode) => node.type === "agent" ? { ...node, data: (({ kind: _kind, ...data }: AgentData & { kind?: string }) => data)(node.data) } : node);
    return withMother({ ...value, nodes });
  } catch { return null; }
}
export function saveGraph(graph: CanvasGraph) {
  try { appStorage().setItem(KEY, JSON.stringify(graph)); return true; } catch { return false; }
}

export { runParts, runTasks, linkedIds, executionGraph, boardForPlan, applyPlan, applyPattern } from "./canvas-plan-graph.ts";
import type { AgentData, Position, CanvasNode, CanvasEdge, CanvasGraph, TaskStatus } from "./canvas-types.ts";
import { characters } from "./agent-characters";
import { waits } from "./canvas-delete-flow";
/** The words both views of the board (flat and isometric) use for an agent's state, and for its check: the read-only
 * verify task Elpis runs after every agent that writes (`runTasks`). */
/** "1 agent", "4 agents": the same words on the flat and the isometric board. */
export const agentCount = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
export const STATUS_LABEL: Record<TaskStatus | "idle", string> = {
  idle: "not run",
  pending: "waiting",
  running: "running",
  succeeded: "done",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};
export const CHECK_LABEL: Record<TaskStatus | "idle", string> = {
  idle: "Checked after it runs",
  pending: "Check waits for it",
  running: "Being checked",
  succeeded: "Check passed",
  failed: "Check failed",
  blocked: "Check blocked",
  cancelled: "Check cancelled",
};
/** The Mother node: the chat a run starts in. Every agent is her child; she starts the agents that wait for no one and
 * owns the run's reports. She is drawn, never sent: the scheduler takes her chat as its root thread. */
export const MOTHER = "mother";
/** The default most agents a graph holds; past 10 a Father agent is to share the work (lat.md/tasks.md). */
export const MAX_AGENTS = 10;
export const maxAgents = (graph: CanvasGraph) => graph.maxAgents ?? MAX_AGENTS;
/** The Father: past this many agents, the rest run under him, in his own chat, after the Mother's part has finished,
 * and he reports to her (lat.md/tasks.md, 17 October 2026). Elpis runs one graph per chat, so he needs his own. */
export const FATHER = "father";
export const PER_PARENT = 10;
/** Which agents the Mother runs and which the Father runs: the first PER_PARENT in run order (Kahn's waves, then
 * board order) are hers. Everything an agent waits for comes earlier in run order, so hers never wait for his. */
export function parents(graph: CanvasGraph): {
  mother: string[];
  father: string[];
} {
  const order = waves(graph),
    agents = agentsOf(graph).map((node, index) => ({ id: node.id, wave: order.get(node.id) ?? Infinity, index }));
  const ranked = agents.sort((a, b) => a.wave - b.wave || a.index - b.index).map(item => item.id);
  return graph.template === "recursive"
    ? { mother: ranked, father: [] }
    : { mother: ranked.slice(0, PER_PARENT), father: ranked.slice(PER_PARENT) };
}
/** Each agent's check is its own engine task, so a graph of n agents is 2n tasks. */
export const TASKS_PER_AGENT = 2;
/** The id of an agent's check task; Elpis task ids take letters, digits, `-` and `_`. */
export const checkOf = (id: string) => `${id}-check`;
/** What an agent is held to when its "Done when" is left empty. */
export const DONE = "The change builds and its tests pass.";
export const agentsOf = (graph: CanvasGraph) =>
  graph.nodes.filter(
    (
      node,
    ): node is Extract<
      CanvasNode,
      {
        type: "agent";
      }
    > => node.type === "agent",
  );
/** The folder value that stands for the whole project. */
export const WHOLE_PROJECT = ".";
/** Each agent's own folder in the project, `agents/<its name>`, which the run creates: the agent writes its report and
 * anything else it makes there, and its check writes in `check` inside it. Names that repeat take -2, -3 in board order. */
export function ownFolders(graph: CanvasGraph): Map<string, string> {
  const taken = new Set<string>(),
    folders = new Map<string, string>();
  for (const node of agentsOf(graph)) {
    const base =
      node.data.title
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/, "") || node.id;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    folders.set(node.id, `agents/${name}`);
  }
  return folders;
}
/** What every agent and check is told to write, so reports read the same across a run. */
export const report = (folder: string, verdict: boolean) =>
  `Write your report to ${folder}/report.md in this form: a title line, then the sections ## ${verdict ? "Verdict (passed or failed, for each criterion)" : "Result"}, ## Evidence (commands you ran and what they showed, or your sources), ## Files (the paths you wrote) and ## Open (what is left or unsure).`;
export let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const agent = (title: string, instruction: string, extra: Partial<AgentData> = {}): CanvasNode => ({
  id: newId("agent"),
  type: "agent",
  position: { x: 0, y: 0 },
  data: { title, instruction, model: null, writeScopes: [], acceptanceCriteria: [], ...extra },
});
export const wire = (source: CanvasNode, target: CanvasNode): CanvasEdge => ({
  id: `${source.id}->${target.id}`,
  source: source.id,
  target: target.id,
});
/** Invented names, shared by starters and quick creation. Reserve the first word as well as the full title. */
export const AGENT_NAMES = [
  "Quillon",
  "Veyra",
  "Orilo",
  "Nuvani",
  "Zelko",
  "Tavri",
  "Lumaro",
  "Eshvi",
  "Pellun",
  "Arovi",
  "Veluno",
  "Ishara",
];
export function agentName(taken: string[], role = "") {
  const used = new Set(taken.map(title => title.split(" · ")[0]));
  let index = 0,
    name: string;
  do {
    name = `${AGENT_NAMES[index % AGENT_NAMES.length]}${index >= AGENT_NAMES.length ? ` ${Math.floor(index / AGENT_NAMES.length) + 1}` : ""}`;
    index++;
  } while (used.has(name));
  return role ? `${name} · ${role}` : name;
}
export const graphOf = (name: string, nodes: CanvasNode[], edges: CanvasEdge[]) => {
  const taken: string[] = [];
  return arrange(
    withMother({
      name,
      nodes: nodes.map(node => {
        if (node.type !== "agent") return node;
        const title = agentName(taken, node.data.title);
        taken.push(title);
        return { ...node, data: { ...node.data, title } };
      }),
      edges,
    }),
  );
};
export const chain = (...steps: CanvasNode[]) =>
  steps.slice(1).flatMap((step, index) => {
    const previous = steps[index];
    return previous ? [wire(previous, step)] : [];
  });
export const fan = (from: CanvasNode[], to: CanvasNode[]) =>
  from.flatMap(source => to.map(target => wire(source, target)));
/** Kahn's algorithm, in waves: wave 1 waits for no one, and each later wave waits only for earlier ones. This is the
 * order the engine can start them in (codex-rs state/src/model/work_graph.rs checks the graph the same way). Agents
 * on a loop get no wave; loops are refused when wired. */
export function waves(graph: CanvasGraph): Map<string, number> {
  const ids = new Set(agentsOf(graph).map(node => node.id)),
    edges = graph.edges.filter(edge => waits(edge) && ids.has(edge.source) && ids.has(edge.target));
  const waiting = new Map([...ids].map(id => [id, edges.filter(edge => edge.target === id).length]));
  const wave = new Map<string, number>();
  for (let frontier = [...ids].filter(id => !waiting.get(id)), level = 1; frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      wave.set(id, level);
      for (const edge of edges)
        if (edge.source === id) {
          const left = waiting.get(edge.target)! - 1;
          waiting.set(edge.target, left);
          if (!left) next.push(edge.target);
        }
    }
    frontier = next;
  }
  return wave;
}
/** A graph's shape for a thumbnail: how many agents start in each Kahn wave. */
export function shapeOf(graph: CanvasGraph): number[] {
  const order = waves(graph),
    columns: number[] = [];
  for (const node of agentsOf(graph)) {
    const level = (order.get(node.id) ?? 1) - 1;
    columns[level] = (columns[level] ?? 0) + 1;
  }
  return columns.filter(Boolean);
}
export const COLUMN = 260,
  ROW = 140;
/** The graph with its Mother: a graph without one (a template, or one saved before she existed) gets her a column
 * left of the first wave, level with it. */
export function withMother(graph: CanvasGraph): CanvasGraph {
  if (graph.nodes.some(node => node.type === "mother")) return graph;
  const agents = agentsOf(graph),
    wave = waves(graph),
    first = agents.filter(node => wave.get(node.id) === 1),
    ys = (first.length ? first : agents).map(node => node.position.y);
  const position = agents.length
    ? {
        x: Math.min(...agents.map(node => node.position.x)) - COLUMN,
        y: Math.round(ys.reduce((sum, y) => sum + y, 0) / ys.length),
      }
    : { x: -COLUMN, y: 0 };
  return { ...graph, nodes: [{ id: MOTHER, type: "mother", position, data: {} }, ...graph.nodes] };
}
/** Lays the agents out in run order: the Mother, then one column per wave, each column centred and kept in the order
 * the user had it. Notes stay where they are. */
export function arrange(graph: CanvasGraph): CanvasGraph {
  const wave = waves(graph),
    columns = new Map<
      number,
      Extract<
        CanvasNode,
        {
          type: "agent";
        }
      >[]
    >();
  for (const node of agentsOf(graph)) {
    const level = wave.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const position = new Map<string, Position>();
  // Columns left to right; the first keeps the user's top-to-bottom order, and each later one is ordered by the mean
  // height of what its agents wait for (the barycentre step of layered graph drawing), which uncrosses most wires.
  const ordered = [...columns.keys()].sort((a, b) => a - b),
    rank = new Map<string, number>();
  for (const level of ordered) {
    const column = columns.get(level)!;
    const mean = (node: (typeof column)[number]) => {
      const before = graph.edges
        .filter(edge => waits(edge) && edge.target === node.id && rank.has(edge.source))
        .map(edge => rank.get(edge.source)!);
      return before.length ? before.reduce((sum, at) => sum + at, 0) / before.length : node.position.y / ROW;
    };
    column.sort((a, b) =>
      level <= 1 ? a.position.y - b.position.y : mean(a) - mean(b) || a.position.y - b.position.y,
    );
    column.forEach((node, index) => {
      const y = Math.round((index - (column.length - 1) / 2) * ROW);
      position.set(node.id, { x: level * COLUMN, y });
      rank.set(node.id, y / ROW);
    });
  }
  // Room for her shared trunk and an exposed branch into each first-wave agent.
  position.set(MOTHER, { x: -80, y: 0 });
  return {
    ...graph,
    nodes: graph.nodes.map(node =>
      position.has(node.id) ? { ...node, position: position.get(node.id)!, isoPosition: undefined } : node,
    ),
  };
}
/** An agent's name from its prompt: the prompt's start, cut at a word. */
export const nameFrom = (task: string) => (task.length <= 48 ? task : `${task.slice(0, 48).replace(/\s+\S*$/, "")}…`);
/** A new agent keeps its invented name when its prompt supplies the descriptive part. Manual names stay manual. */
export function promptName(data: AgentData, instruction: string) {
  const [name = "", role] = data.title.split(" · ");
  return AGENT_NAMES.includes(name.replace(/ \d+$/, "")) && (!role || role === nameFrom(data.instruction))
    ? `${name}${instruction.trim() ? ` · ${nameFrom(instruction)}` : ""}`
    : data.title;
}
/** `count` new agents on one model, stacked from `at`. Agent n takes prompt n, keeping an invented name
 * with the prompt as its descriptive part; one without a prompt must get one before the graph runs. */
export function newAgents(
  count: number,
  choice: {
    model: string | null;
    provider?: string | null;
    effort?: string | null;
  },
  at: Position,
  prompts: string[] = [],
  titles: string[] = [],
): CanvasNode[] {
  const taken = [...titles];
  return Array.from({ length: count }, (_, index) => {
    const prompt = prompts[index]?.trim() ?? "";
    const title = agentName(taken, prompt ? nameFrom(prompt) : "");
    taken.push(title);
    const made = agent(title, prompt, {
      model: choice.model,
      provider: choice.provider ?? null,
      effort: choice.effort ?? null,
    });
    return { ...made, position: { x: at.x, y: at.y + index * ROW } };
  });
}
/** Whether wiring source → target (target waits for source) closes a loop: it does if target already leads to source. */
export function makesLoop(edges: CanvasEdge[], source: string, target: string) {
  const seen = new Set<string>(),
    queue = [target];
  while (queue.length) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (waits(edge) && edge.source === current) queue.push(edge.target);
  }
  return false;
}
/** Fixed identity color, shared by flat cards, isometric pedestals and ports. */
export function agentColor(id: string, data: AgentData): string {
  const character = characters.find(character => character.id === data.character);
  if (character) return character.color;
  let hash = 0;
  for (const c of id) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return `hsl(${(hash * 137.508) % 360} 58% 65%)`;
}

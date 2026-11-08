import type { AgentData, Position, CanvasNode, CanvasEdge, CanvasGraph, TaskStatus, RunTask, Plan } from './canvas-types.ts';
import { characters } from "./agent-characters";
import { deleteKeepingFlow, waits } from "./canvas-delete-flow";
/** The words both views of the board (flat and isometric) use for an agent's state, and for its check: the read-only
 * verify task Elpis runs after every agent that writes (`runTasks`). */
/** "1 agent", "4 agents": the same words on the flat and the isometric board. */
export const agentCount = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;
export const STATUS_LABEL: Record<TaskStatus | "idle", string> = { idle: "not run", pending: "waiting", running: "running", succeeded: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
export const CHECK_LABEL: Record<TaskStatus | "idle", string> = { idle: "Checked after it runs", pending: "Check waits for it", running: "Being checked", succeeded: "Check passed", failed: "Check failed", blocked: "Check blocked", cancelled: "Check cancelled" };
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
    const order = waves(graph), agents = agentsOf(graph).map((node, index) => ({ id: node.id, wave: order.get(node.id) ?? Infinity, index }));
    const ranked = agents.sort((a, b) => a.wave - b.wave || a.index - b.index).map(item => item.id);
    return graph.template === "recursive" ? { mother: ranked, father: [] } : { mother: ranked.slice(0, PER_PARENT), father: ranked.slice(PER_PARENT) };
}
/** Each agent's check is its own engine task, so a graph of n agents is 2n tasks. */
export const TASKS_PER_AGENT = 2;
/** The id of an agent's check task; Elpis task ids take letters, digits, `-` and `_`. */
export const checkOf = (id: string) => `${id}-check`;
/** What an agent is held to when its "Done when" is left empty. */
export const DONE = "The change builds and its tests pass.";
export const agentsOf = (graph: CanvasGraph) => graph.nodes.filter((node): node is Extract<CanvasNode, {
    type: "agent";
}> => node.type === "agent");
/** The folder value that stands for the whole project. */
export const WHOLE_PROJECT = ".";
/** Each agent's own folder in the project, `agents/<its name>`, which the run creates: the agent writes its report and
 * anything else it makes there, and its check writes in `check` inside it. Names that repeat take -2, -3 in board order. */
export function ownFolders(graph: CanvasGraph): Map<string, string> {
    const taken = new Set<string>(), folders = new Map<string, string>();
    for (const node of agentsOf(graph)) {
        const base = node.data.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || node.id;
        let name = base;
        for (let n = 2; taken.has(name); n++)
            name = `${base}-${n}`;
        taken.add(name);
        folders.set(node.id, `agents/${name}`);
    }
    return folders;
}
/** What every agent and check is told to write, so reports read the same across a run. */
export const report = (folder: string, verdict: boolean) => `Write your report to ${folder}/report.md in this form: a title line, then the sections ## ${verdict ? "Verdict (passed or failed, for each criterion)" : "Result"}, ## Evidence (commands you ran and what they showed, or your sources), ## Files (the paths you wrote) and ## Open (what is left or unsure).`;
export let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const agent = (title: string, instruction: string, extra: Partial<AgentData> = {}): CanvasNode => ({ id: newId("agent"), type: "agent", position: { x: 0, y: 0 }, data: { title, instruction, model: null, writeScopes: [], acceptanceCriteria: [], ...extra } });
export const wire = (source: CanvasNode, target: CanvasNode): CanvasEdge => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id });
/** Invented names, shared by starters and quick creation. Reserve the first word as well as the full title. */
export const AGENT_NAMES = ["Quillon", "Veyra", "Orilo", "Nuvani", "Zelko", "Tavri", "Lumaro", "Eshvi", "Pellun", "Arovi", "Veluno", "Ishara"];
export function agentName(taken: string[], role = "") {
    const used = new Set(taken.map(title => title.split(" · ")[0]));
    let index = 0, name: string;
    do {
        name = `${AGENT_NAMES[index % AGENT_NAMES.length]}${index >= AGENT_NAMES.length ? ` ${Math.floor(index / AGENT_NAMES.length) + 1}` : ""}`;
        index++;
    } while (used.has(name));
    return role ? `${name} · ${role}` : name;
}
export const graphOf = (name: string, nodes: CanvasNode[], edges: CanvasEdge[]) => {
    const taken: string[] = [];
    return arrange(withMother({ name, nodes: nodes.map(node => {
            if (node.type !== "agent")
                return node;
            const title = agentName(taken, node.data.title);
            taken.push(title);
            return { ...node, data: { ...node.data, title } };
        }), edges }));
};
export const chain = (...steps: CanvasNode[]) => steps.slice(1).flatMap((step, index) => { const previous = steps[index]; return previous ? [wire(previous, step)] : []; });
export const fan = (from: CanvasNode[], to: CanvasNode[]) => from.flatMap(source => to.map(target => wire(source, target)));
/** Kahn's algorithm, in waves: wave 1 waits for no one, and each later wave waits only for earlier ones. This is the
 * order the engine can start them in (codex-rs state/src/model/work_graph.rs checks the graph the same way). Agents
 * on a loop get no wave; loops are refused when wired. */
export function waves(graph: CanvasGraph): Map<string, number> {
    const ids = new Set(agentsOf(graph).map(node => node.id)), edges = graph.edges.filter(edge => waits(edge) && ids.has(edge.source) && ids.has(edge.target));
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
                    if (!left)
                        next.push(edge.target);
                }
        }
        frontier = next;
    }
    return wave;
}
/** A graph's shape for a thumbnail: how many agents start in each Kahn wave. */
export function shapeOf(graph: CanvasGraph): number[] {
    const order = waves(graph), columns: number[] = [];
    for (const node of agentsOf(graph)) {
        const level = (order.get(node.id) ?? 1) - 1;
        columns[level] = (columns[level] ?? 0) + 1;
    }
    return columns.filter(Boolean);
}
export const COLUMN = 260, ROW = 140;
/** The graph with its Mother: a graph without one (a template, or one saved before she existed) gets her a column
 * left of the first wave, level with it. */
export function withMother(graph: CanvasGraph): CanvasGraph {
    if (graph.nodes.some(node => node.type === "mother"))
        return graph;
    const agents = agentsOf(graph), wave = waves(graph), first = agents.filter(node => wave.get(node.id) === 1), ys = (first.length ? first : agents).map(node => node.position.y);
    const position = agents.length ? { x: Math.min(...agents.map(node => node.position.x)) - COLUMN, y: Math.round(ys.reduce((sum, y) => sum + y, 0) / ys.length) } : { x: -COLUMN, y: 0 };
    return { ...graph, nodes: [{ id: MOTHER, type: "mother", position, data: {} }, ...graph.nodes] };
}
/** Lays the agents out in run order: the Mother, then one column per wave, each column centred and kept in the order
 * the user had it. Notes stay where they are. */
export function arrange(graph: CanvasGraph): CanvasGraph {
    const wave = waves(graph), columns = new Map<number, Extract<CanvasNode, {
        type: "agent";
    }>[]>();
    for (const node of agentsOf(graph)) {
        const level = wave.get(node.id) ?? 0;
        columns.set(level, [...(columns.get(level) ?? []), node]);
    }
    const position = new Map<string, Position>();
    // Columns left to right; the first keeps the user's top-to-bottom order, and each later one is ordered by the mean
    // height of what its agents wait for (the barycentre step of layered graph drawing), which uncrosses most wires.
    const ordered = [...columns.keys()].sort((a, b) => a - b), rank = new Map<string, number>();
    for (const level of ordered) {
        const column = columns.get(level)!;
        const mean = (node: (typeof column)[number]) => { const before = graph.edges.filter(edge => waits(edge) && edge.target === node.id && rank.has(edge.source)).map(edge => rank.get(edge.source)!); return before.length ? before.reduce((sum, at) => sum + at, 0) / before.length : node.position.y / ROW; };
        column.sort((a, b) => level <= 1 ? a.position.y - b.position.y : mean(a) - mean(b) || a.position.y - b.position.y);
        column.forEach((node, index) => { const y = Math.round((index - (column.length - 1) / 2) * ROW); position.set(node.id, { x: level * COLUMN, y }); rank.set(node.id, y / ROW); });
    }
    // Room for her shared trunk and an exposed branch into each first-wave agent.
    position.set(MOTHER, { x: -80, y: 0 });
    return { ...graph, nodes: graph.nodes.map(node => position.has(node.id) ? { ...node, position: position.get(node.id)!, isoPosition: undefined } : node) };
}
/** An agent's name from its prompt: the prompt's start, cut at a word. */
export const nameFrom = (task: string) => task.length <= 48 ? task : `${task.slice(0, 48).replace(/\s+\S*$/, "")}…`;
/** A new agent keeps its invented name when its prompt supplies the descriptive part. Manual names stay manual. */
export function promptName(data: AgentData, instruction: string) {
    const [name = "", role] = data.title.split(" · ");
    return AGENT_NAMES.includes(name.replace(/ \d+$/, "")) && (!role || role === nameFrom(data.instruction))
        ? `${name}${instruction.trim() ? ` · ${nameFrom(instruction)}` : ""}` : data.title;
}
/** `count` new agents on one model, stacked from `at`. Agent n takes prompt n, keeping an invented name
 * with the prompt as its descriptive part; one without a prompt must get one before the graph runs. */
export function newAgents(count: number, choice: {
    model: string | null;
    provider?: string | null;
    effort?: string | null;
}, at: Position, prompts: string[] = [], titles: string[] = []): CanvasNode[] {
    const taken = [...titles];
    return Array.from({ length: count }, (_, index) => {
        const prompt = prompts[index]?.trim() ?? "";
        const title = agentName(taken, prompt ? nameFrom(prompt) : "");
        taken.push(title);
        const made = agent(title, prompt, { model: choice.model, provider: choice.provider ?? null, effort: choice.effort ?? null });
        return { ...made, position: { x: at.x, y: at.y + index * ROW } };
    });
}
/** Whether wiring source → target (target waits for source) closes a loop: it does if target already leads to source. */
export function makesLoop(edges: CanvasEdge[], source: string, target: string) {
    const seen = new Set<string>(), queue = [target];
    while (queue.length) {
        const current = queue.shift()!;
        if (current === source)
            return true;
        if (seen.has(current))
            continue;
        seen.add(current);
        for (const edge of edges)
            if (waits(edge) && edge.source === current)
                queue.push(edge.target);
    }
    return false;
}
/** The graph as the tasks Elpis runs, or what is missing first. Notes are not sent. Each agent is a writer followed by
 * its own check (a verify task, which Elpis requires after every writer, writing only its report); an agent wired after it waits
 * for that check and the original result, so it receives both the answer and its verification. */
/** The run in its parts: the Mother's tasks, and the Father agent's (empty within PER_PARENT agents). The Father's part
 * starts after hers has succeeded, so waiting on her agents is dropped from his tasks. */
export function runParts(graph: CanvasGraph): {
    mother: RunTask[];
    father: RunTask[];
} | {
    error: string;
} {
    graph = executionGraph(graph);
    const built = runTasks(graph);
    if ("error" in built)
        return built;
    const split = parents(graph), his = new Set(split.father.flatMap(id => [id, checkOf(id)]));
    return { mother: built.tasks.filter(task => !his.has(task.id)), father: built.tasks.filter(task => his.has(task.id)).map(task => ({ ...task, dependsOn: task.dependsOn.filter(id => his.has(id)) })) };
}
export function runTasks(graph: CanvasGraph): {
    tasks: RunTask[];
} | {
    error: string;
} {
    graph = executionGraph(graph);
    const agents = agentsOf(graph);
    if (graph.template === "recursive" && (!Number.isSafeInteger(graph.roundLimit) || graph.roundLimit! < 1 || graph.roundLimit! > 100))
        return { error: "Recursive workflows need a round limit from 1 to 100." };
    if (graph.template !== "recursive" && graph.edges.some(edge => edge.feedback))
        return { error: "Feedback links need the recursive pattern and a round limit." };
    if (waves(graph).size !== agents.length)
        return { error: "That workflow has a loop. Use the recursive pattern with a round limit." };
    if (!agents.length)
        return { error: "Add an agent before running the graph." };
    if (agents.length > maxAgents(graph))
        return { error: `The graph has ${agents.length} agents; its limit is ${maxAgents(graph)}. Remove some or raise Max agents.` };
    const ids = new Set(agents.map(node => node.id));
    for (const node of agents) {
        if (!node.data.title.trim())
            return { error: "Every agent needs a name." };
        if (!node.data.instruction.trim())
            return { error: `“${node.data.title}” has no prompt: write one, or give the run a goal (Mother agent) and Elpis fills it in.` };
        if (node.data.provider && !node.data.model)
            return { error: `“${node.data.title}” needs a model from its provider.` };
    }
    // Agents working alongside each other must not share a folder: they run at the same time.
    const byId = new Map(agents.map(node => [node.id, node])), beside = (id: string) => graph.edges.filter(edge => edge.kind === "alongside" && (edge.source === id || edge.target === id)).map(edge => byId.get(edge.source === id ? edge.target : edge.source)).filter((item): item is (typeof agents)[number] => Boolean(item));
    for (const edge of graph.edges.filter(edge => edge.kind === "alongside")) {
        const a = byId.get(edge.source), b = byId.get(edge.target), shared = a && b ? a.data.writeScopes.find(folder => b.data.writeScopes.includes(folder)) : undefined;
        if (a && b && shared)
            return { error: `“${a.data.title}” and “${b.data.title}” work alongside but both may write ${shared}: give each its own folder.` };
        const whole = [a, b].find(item => item?.data.writeScopes.includes(WHOLE_PROJECT));
        if (a && b && whole)
            return { error: `“${whole.data.title}” writes the whole project, so it cannot work alongside “${(whole === a ? b : a).data.title}”: wire them one after the other.` };
    }
    const own = ownFolders(graph);
    const brief = graph.mother?.brief.trim();
    return { tasks: agents.flatMap((node): RunTask[] => {
            const title = node.data.title.trim(), prompt = node.data.instruction.trim();
            const folder = own.get(node.id)!, scopes = [...node.data.writeScopes.filter(scope => scope !== folder), folder];
            const partners = beside(node.id).map(other => `“${other.data.title}” (writes ${[...other.data.writeScopes, own.get(other.id)].join(", ")}): ${other.data.instruction.trim().split("\n")[0]}`);
            const alongside = partners.length ? `Working alongside you, at the same time:\n${partners.map(line => `- ${line}`).join("\n")}\nDo not write in their folders; leave them what they need as files in yours.` : "";
            const incoming = graph.edges.filter(edge => edge.target === node.id && byId.has(edge.source));
            const receives = incoming.filter(edge => edge.label?.trim()).map(edge => `Receives “${edge.label!.trim()}” from ${byId.get(edge.source)!.data.title}.`);
            if (!incoming.some(waits) && graph.motherFlow?.trim())
                receives.unshift(`Receives “${graph.motherFlow.trim()}” from Mother agent.`);
            const criteria = node.data.acceptanceCriteria.length ? node.data.acceptanceCriteria : [DONE];
            const model = { ...(node.data.provider ? { provider: node.data.provider } : {}), ...(node.data.model ? { model: node.data.model } : {}) };
            // A join has no check, so what waits on it waits on the join alone.
            const dependsOn = graph.edges.filter(edge => waits(edge) && edge.target === node.id && ids.has(edge.source)).flatMap(edge => byId.get(edge.source)?.data.join || byId.get(edge.source)?.data.check === false ? [edge.source] : [edge.source, checkOf(edge.source)]);
            // Elpis does a join itself: no agent, no model, no check (28 Oct: an agent and its check spent three minutes pasting).
            if (node.data.join)
                return [{ id: node.id, kind: "join", title, instruction: prompt || title, dependsOn, writeScopes: scopes, acceptanceCriteria: criteria,
                        parts: node.data.join.parts, output: node.data.join.output, ...(node.data.join.flow ? { flow: true } : {}) } satisfies RunTask];
            const work = [
                // Every writer receives the shared brief and its own prompt. Its final ACP answer feeds its check and successors.
                { id: node.id, kind: "implement" as const, title, instruction: [brief && `Goal of the whole run: ${brief}`, receives.join("\n"), prompt, `Save your result as files inside your allowed folders. ${report(folder, false)} Include the answer and file paths in your final answer so the next agent can use them.`, graph.template === "voting" && node.id === agents.at(-1)?.id ? "Compare the connected agents’ independent answers. Give the majority conclusion and explain disagreements with evidence." : "", alongside].filter(Boolean).join("\n\n"),
                    dependsOn,
                    ...(graph.template === "recursive" ? { feedbackFrom: graph.edges.filter(edge => edge.feedback && edge.target === node.id).flatMap(edge => [edge.source, checkOf(edge.source)]) } : {}),
                    writeScopes: scopes, acceptanceCriteria: criteria, ...model, ...(node.data.effort ? { reasoningEffort: node.data.effort } : {}), ...(node.data.fast ? { serviceTier: "priority" } : {}), ...(node.data.check === false ? { unchecked: true as const } : {}) } satisfies RunTask,
            ];
            // `check: false`: the person judges the result, so no check agent follows (29 Oct, Logo: one agent and its image tool).
            if (node.data.check === false)
                return work;
            return [...work,
                { id: checkOf(node.id), kind: "verify" as const, title: `Check: ${title}`.slice(0, 256),
                    instruction: `Check the work of “${title}”. Its prompt was:\n${prompt}\n\n${node.data.check?.trim() || "Run what proves it (the build, the tests, or reading what it wrote) and show the output."} Say plainly whether each of these holds: ${criteria.join("; ")}\n\nChange nothing of its work. ${report(`${folder}/check`, true)}`,
                    dependsOn: [node.id], writeScopes: [`${folder}/check`], acceptanceCriteria: [`Each of “${title}”'s criteria is shown to hold or not, with evidence`], ...model },
            ];
        }) };
}
/** Walk a whole dependency branch once, including previous-round links, never alongside links. */
export function linkedIds(graph: CanvasGraph, ids: string[], direction: "upstream" | "downstream") {
    const found = new Set(ids), pending = [...ids];
    while (pending.length) {
        const id = pending.pop()!;
        for (const edge of graph.edges) {
            if (edge.kind === "alongside")
                continue;
            const next = direction === "upstream" ? edge.target === id && edge.source : edge.source === id && edge.target;
            if (next && !found.has(next)) {
                found.add(next);
                pending.push(next);
            }
        }
    }
    return [...found];
}
/** Mute changes execution only. The saved drawing and its settings remain available to unmute or undo. */
export function executionGraph(graph: CanvasGraph, targets?: string[]): CanvasGraph {
    const muted = agentsOf(graph).filter(node => node.data.muted).map(node => node.id);
    const enabled = muted.length ? deleteKeepingFlow(graph, muted).graph : graph;
    if (!targets)
        return enabled;
    const ids = new Set(linkedIds(enabled, targets.filter(id => enabled.nodes.some(node => node.id === id && node.type === "agent")), "upstream"));
    return { ...enabled, nodes: enabled.nodes.filter(node => node.type === "mother" || ids.has(node.id)), edges: enabled.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}
/** The board as the planner reads it. */
export const boardForPlan = (graph: CanvasGraph) => agentsOf(graph).map(node => ({ key: node.id, title: node.data.title, prompt: node.data.instruction, folders: node.data.writeScopes, doneWhen: node.data.acceptanceCriteria,
    waitsFor: graph.edges.filter(edge => waits(edge) && edge.target === node.id).map(edge => edge.source) }));
/** The board after a plan: agents the plan keeps are updated in place, new ones are added, ones it leaves out are
 * removed, and the wires are the plan's. An existing agent keeps its model and thinking level; a new one takes the
 * planner's (chosen by complexity, cost and the user's preferences), if any. Notes stay. New agents are laid out in run
 * order. */
export function applyPlan(graph: CanvasGraph, plan: Plan): CanvasGraph {
    const kept = new Map(agentsOf(graph).map(node => [node.id, node])), ids = new Map<string, string>();
    const agents = plan.agents.map(item => {
        const old = kept.get(item.key), made = old ?? agent(item.title, item.prompt, item.model ? { model: item.model, provider: item.provider ?? null, effort: item.effort ?? null } : undefined);
        ids.set(item.key, made.id);
        // What the plan leaves empty keeps what the agent had.
        const data = made.data as AgentData;
        return { ...made, data: { ...data, title: item.title || data.title, instruction: item.prompt || data.instruction, writeScopes: item.folders.length ? item.folders : data.writeScopes, acceptanceCriteria: item.doneWhen.length ? item.doneWhen : data.acceptanceCriteria } } as CanvasNode;
    });
    const edges: CanvasEdge[] = plan.agents.flatMap(item => item.waitsFor.filter(source => ids.has(source)).map(source => {
        const from = ids.get(source)!, to = ids.get(item.key)!;
        const old = graph.edges.find(edge => waits(edge) && edge.source === from && edge.target === to);
        return { ...old, id: `${from}->${to}`, source: from, target: to };
    }));
    // Alongside and explicit previous-round links stay between agents the plan keeps.
    const keptIds = new Set(ids.values());
    edges.push(...graph.edges.filter(edge => (edge.kind === "alongside" || graph.template === "recursive" && edge.feedback) && keptIds.has(edge.source) && keptIds.has(edge.target)));
    // A fresh team is laid out in run order; on a board the user laid out, only new agents are placed: right of what
    // they wait for, else below the rest.
    const reused = agents.filter(node => kept.has(node.id));
    if (!reused.length)
        return arrange({ ...graph, name: plan.name || graph.name, nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...agents], edges });
    const placed = new Map(reused.map(node => [node.id, node.position]));
    const left = Math.min(...reused.map(node => node.position.x));
    let below = Math.max(...reused.map(node => node.position.y));
    const positioned = agents.map((node, index) => {
        if (placed.has(node.id))
            return node;
        const from = (plan.agents[index]?.waitsFor ?? []).flatMap(key => { const at = placed.get(ids.get(key) ?? ""); return at ? [at] : []; });
        const first = from[0];
        const position = first ? { x: Math.max(...from.map(at => at.x)) + COLUMN, y: first.y + ROW / 2 } : { x: left, y: (below += ROW) };
        placed.set(node.id, position);
        return { ...node, position };
    });
    return { ...graph, name: plan.name || graph.name, nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...positioned], edges };
}
export function applyPattern(graph: CanvasGraph, number: number): CanvasGraph {
    const agents = agentsOf(graph);
    const sequential = () => chain(...agents);
    const edges = number === 3 ? graph.edges.filter(edge => !edge.feedback) : number === 2 ? []
        : number === 5 ? fan(agents.slice(0, -1), agents.slice(-1)) : sequential();
    const first = agents[0], last = agents.at(-1);
    if (number === 4 && first && last)
        edges.push({ ...wire(last, first), feedback: true, label: "Next round" });
    return arrange({ ...graph, edges, template: ["sequential", "parallel", "kahn", "recursive", "voting"][number - 1],
        roundLimit: number === 4 ? graph.roundLimit ?? 3 : undefined });
}
/** Fixed identity color, shared by flat cards, isometric pedestals and ports. */
export function agentColor(id: string, data: AgentData): string {
    const character = characters.find(character => character.id === data.character);
    if (character)
        return character.color;
    let hash = 0;
    for (const c of id)
        hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
    return `hsl(${(hash * 137.508) % 360} 58% 65%)`;
}

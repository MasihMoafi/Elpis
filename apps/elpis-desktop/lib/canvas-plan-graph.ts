import type { AgentData, CanvasNode, CanvasEdge, CanvasGraph, RunTask, Plan } from "./canvas-types.ts";
import { deleteKeepingFlow, waits } from "./canvas-delete-flow";
import {
  maxAgents,
  parents,
  checkOf,
  DONE,
  agentsOf,
  WHOLE_PROJECT,
  ownFolders,
  report,
  agent,
  wire,
  chain,
  fan,
  waves,
  COLUMN,
  ROW,
  arrange,
} from "./canvas-graph.ts";

/** The graph as the tasks Elpis runs, or what is missing first. Notes are not sent. Each agent is a writer followed by
 * its own check (a verify task, which Elpis requires after every writer, writing only its report); an agent wired after it waits
 * for that check and the original result, so it receives both the answer and its verification. */
/** The run in its parts: the Mother's tasks, and the Father agent's (empty within PER_PARENT agents). The Father's part
 * starts after hers has succeeded, so waiting on her agents is dropped from his tasks. */
export function runParts(graph: CanvasGraph):
  | {
      mother: RunTask[];
      father: RunTask[];
    }
  | {
      error: string;
    } {
  graph = executionGraph(graph);
  const built = runTasks(graph);
  if ("error" in built) return built;
  const split = parents(graph),
    his = new Set(split.father.flatMap(id => [id, checkOf(id)]));
  return {
    mother: built.tasks.filter(task => !his.has(task.id)),
    father: built.tasks
      .filter(task => his.has(task.id))
      .map(task => ({ ...task, dependsOn: task.dependsOn.filter(id => his.has(id)) })),
  };
}

export function runTasks(graph: CanvasGraph):
  | {
      tasks: RunTask[];
    }
  | {
      error: string;
    } {
  graph = executionGraph(graph);
  const agents = agentsOf(graph);
  if (
    graph.template === "recursive" &&
    (!Number.isSafeInteger(graph.roundLimit) || graph.roundLimit! < 1 || graph.roundLimit! > 100)
  )
    return { error: "Recursive workflows need a round limit from 1 to 100." };
  if (graph.template !== "recursive" && graph.edges.some(edge => edge.feedback))
    return { error: "Feedback links need the recursive pattern and a round limit." };
  if (waves(graph).size !== agents.length)
    return { error: "That workflow has a loop. Use the recursive pattern with a round limit." };
  if (!agents.length) return { error: "Add an agent before running the graph." };
  if (agents.length > maxAgents(graph))
    return {
      error: `The graph has ${agents.length} agents; its limit is ${maxAgents(graph)}. Remove some or raise Max agents.`,
    };
  const ids = new Set(agents.map(node => node.id));
  for (const node of agents) {
    if (!node.data.title.trim()) return { error: "Every agent needs a name." };
    if (!node.data.instruction.trim())
      return {
        error: `“${node.data.title}” has no prompt: write one, or give the run a goal (Mother agent) and Elpis fills it in.`,
      };
    if (node.data.provider && !node.data.model)
      return { error: `“${node.data.title}” needs a model from its provider.` };
  }
  // Agents working alongside each other must not share a folder: they run at the same time.
  const byId = new Map(agents.map(node => [node.id, node])),
    beside = (id: string) =>
      graph.edges
        .filter(edge => edge.kind === "alongside" && (edge.source === id || edge.target === id))
        .map(edge => byId.get(edge.source === id ? edge.target : edge.source))
        .filter((item): item is (typeof agents)[number] => Boolean(item));
  for (const edge of graph.edges.filter(edge => edge.kind === "alongside")) {
    const a = byId.get(edge.source),
      b = byId.get(edge.target),
      shared = a && b ? a.data.writeScopes.find(folder => b.data.writeScopes.includes(folder)) : undefined;
    if (a && b && shared)
      return {
        error: `“${a.data.title}” and “${b.data.title}” work alongside but both may write ${shared}: give each its own folder.`,
      };
    const whole = [a, b].find(item => item?.data.writeScopes.includes(WHOLE_PROJECT));
    if (a && b && whole)
      return {
        error: `“${whole.data.title}” writes the whole project, so it cannot work alongside “${(whole === a ? b : a).data.title}”: wire them one after the other.`,
      };
  }
  const own = ownFolders(graph);
  const brief = graph.mother?.brief.trim();
  return {
    tasks: agents.flatMap((node): RunTask[] => {
      const title = node.data.title.trim(),
        prompt = node.data.instruction.trim();
      const folder = own.get(node.id)!,
        scopes = [...node.data.writeScopes.filter(scope => scope !== folder), folder];
      const partners = beside(node.id).map(
        other =>
          `“${other.data.title}” (writes ${[...other.data.writeScopes, own.get(other.id)].join(", ")}): ${other.data.instruction.trim().split("\n")[0]}`,
      );
      const alongside = partners.length
        ? `Working alongside you, at the same time:\n${partners.map(line => `- ${line}`).join("\n")}\nDo not write in their folders; leave them what they need as files in yours.`
        : "";
      const incoming = graph.edges.filter(edge => edge.target === node.id && byId.has(edge.source));
      const receives = incoming
        .filter(edge => edge.label?.trim())
        .map(edge => `Receives “${edge.label!.trim()}” from ${byId.get(edge.source)!.data.title}.`);
      if (!incoming.some(waits) && graph.motherFlow?.trim())
        receives.unshift(`Receives “${graph.motherFlow.trim()}” from Mother agent.`);
      const criteria = node.data.acceptanceCriteria.length ? node.data.acceptanceCriteria : [DONE];
      const model = {
        ...(node.data.provider ? { provider: node.data.provider } : {}),
        ...(node.data.model ? { model: node.data.model } : {}),
      };
      // A join has no check, so what waits on it waits on the join alone.
      const dependsOn = graph.edges
        .filter(edge => waits(edge) && edge.target === node.id && ids.has(edge.source))
        .flatMap(edge =>
          byId.get(edge.source)?.data.join || byId.get(edge.source)?.data.check === false
            ? [edge.source]
            : [edge.source, checkOf(edge.source)],
        );
      // Elpis does a join itself: no agent, no model, no check (28 Oct: an agent and its check spent three minutes pasting).
      if (node.data.join)
        return [
          {
            id: node.id,
            kind: "join",
            title,
            instruction: prompt || title,
            dependsOn,
            writeScopes: scopes,
            acceptanceCriteria: criteria,
            parts: node.data.join.parts,
            output: node.data.join.output,
            ...(node.data.join.flow ? { flow: true } : {}),
          } satisfies RunTask,
        ];
      const work = [
        // Every writer receives the shared brief and its own prompt. Its final ACP answer feeds its check and successors.
        {
          id: node.id,
          kind: "implement" as const,
          title,
          instruction: [
            brief && `Goal of the whole run: ${brief}`,
            receives.join("\n"),
            prompt,
            `Save your result as files inside your allowed folders. ${report(folder, false)} Include the answer and file paths in your final answer so the next agent can use them.`,
            graph.template === "voting" && node.id === agents.at(-1)?.id
              ? "Compare the connected agents’ independent answers. Give the majority conclusion and explain disagreements with evidence."
              : "",
            alongside,
          ]
            .filter(Boolean)
            .join("\n\n"),
          dependsOn,
          ...(graph.template === "recursive"
            ? {
                feedbackFrom: graph.edges
                  .filter(edge => edge.feedback && edge.target === node.id)
                  .flatMap(edge => [edge.source, checkOf(edge.source)]),
              }
            : {}),
          writeScopes: scopes,
          acceptanceCriteria: criteria,
          ...model,
          ...(node.data.effort ? { reasoningEffort: node.data.effort } : {}),
          ...(node.data.fast ? { serviceTier: "priority" } : {}),
          ...(node.data.check === false ? { unchecked: true as const } : {}),
        } satisfies RunTask,
      ];
      // `check: false`: the person judges the result, so no check agent follows (29 Oct, Logo: one agent and its image tool).
      if (node.data.check === false) return work;
      return [
        ...work,
        {
          id: checkOf(node.id),
          kind: "verify" as const,
          title: `Check: ${title}`.slice(0, 256),
          instruction: `Check the work of “${title}”. Its prompt was:\n${prompt}\n\n${node.data.check?.trim() || "Run what proves it (the build, the tests, or reading what it wrote) and show the output."} Say plainly whether each of these holds: ${criteria.join("; ")}\n\nChange nothing of its work. ${report(`${folder}/check`, true)}`,
          dependsOn: [node.id],
          writeScopes: [`${folder}/check`],
          acceptanceCriteria: [`Each of “${title}”'s criteria is shown to hold or not, with evidence`],
          ...model,
        },
      ];
    }),
  };
}

/** Walk a whole dependency branch once, including previous-round links, never alongside links. */
export function linkedIds(graph: CanvasGraph, ids: string[], direction: "upstream" | "downstream") {
  const found = new Set(ids),
    pending = [...ids];
  while (pending.length) {
    const id = pending.pop()!;
    for (const edge of graph.edges) {
      if (edge.kind === "alongside") continue;
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
  const muted = agentsOf(graph)
    .filter(node => node.data.muted)
    .map(node => node.id);
  const enabled = muted.length ? deleteKeepingFlow(graph, muted).graph : graph;
  if (!targets) return enabled;
  const ids = new Set(
    linkedIds(
      enabled,
      targets.filter(id => enabled.nodes.some(node => node.id === id && node.type === "agent")),
      "upstream",
    ),
  );
  return {
    ...enabled,
    nodes: enabled.nodes.filter(node => node.type === "mother" || ids.has(node.id)),
    edges: enabled.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
  };
}

/** The board as the planner reads it. */
export const boardForPlan = (graph: CanvasGraph) =>
  agentsOf(graph).map(node => ({
    key: node.id,
    title: node.data.title,
    prompt: node.data.instruction,
    folders: node.data.writeScopes,
    doneWhen: node.data.acceptanceCriteria,
    waitsFor: graph.edges.filter(edge => waits(edge) && edge.target === node.id).map(edge => edge.source),
  }));

/** The board after a plan: agents the plan keeps are updated in place, new ones are added, ones it leaves out are
 * removed, and the wires are the plan's. An existing agent keeps its model and thinking level; a new one takes the
 * planner's (chosen by complexity, cost and the user's preferences), if any. Notes stay. New agents are laid out in run
 * order. */
export function applyPlan(graph: CanvasGraph, plan: Plan): CanvasGraph {
  const kept = new Map(agentsOf(graph).map(node => [node.id, node])),
    ids = new Map<string, string>();
  const agents = plan.agents.map(item => {
    const old = kept.get(item.key),
      made =
        old ??
        agent(
          item.title,
          item.prompt,
          item.model ? { model: item.model, provider: item.provider ?? null, effort: item.effort ?? null } : undefined,
        );
    ids.set(item.key, made.id);
    // What the plan leaves empty keeps what the agent had.
    const data = made.data as AgentData;
    return {
      ...made,
      data: {
        ...data,
        title: item.title || data.title,
        instruction: item.prompt || data.instruction,
        writeScopes: item.folders.length ? item.folders : data.writeScopes,
        acceptanceCriteria: item.doneWhen.length ? item.doneWhen : data.acceptanceCriteria,
      },
    } as CanvasNode;
  });
  const edges: CanvasEdge[] = plan.agents.flatMap(item =>
    item.waitsFor
      .filter(source => ids.has(source))
      .map(source => {
        const from = ids.get(source)!,
          to = ids.get(item.key)!;
        const old = graph.edges.find(edge => waits(edge) && edge.source === from && edge.target === to);
        return { ...old, id: `${from}->${to}`, source: from, target: to };
      }),
  );
  // Alongside and explicit previous-round links stay between agents the plan keeps.
  const keptIds = new Set(ids.values());
  edges.push(
    ...graph.edges.filter(
      edge =>
        (edge.kind === "alongside" || (graph.template === "recursive" && edge.feedback)) &&
        keptIds.has(edge.source) &&
        keptIds.has(edge.target),
    ),
  );
  // A fresh team is laid out in run order; on a board the user laid out, only new agents are placed: right of what
  // they wait for, else below the rest.
  const reused = agents.filter(node => kept.has(node.id));
  if (!reused.length)
    return arrange({
      ...graph,
      name: plan.name || graph.name,
      nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...agents],
      edges,
    });
  const placed = new Map(reused.map(node => [node.id, node.position]));
  const left = Math.min(...reused.map(node => node.position.x));
  let below = Math.max(...reused.map(node => node.position.y));
  const positioned = agents.map((node, index) => {
    if (placed.has(node.id)) return node;
    const from = (plan.agents[index]?.waitsFor ?? []).flatMap(key => {
      const at = placed.get(ids.get(key) ?? "");
      return at ? [at] : [];
    });
    const first = from[0];
    const position = first
      ? { x: Math.max(...from.map(at => at.x)) + COLUMN, y: first.y + ROW / 2 }
      : { x: left, y: (below += ROW) };
    placed.set(node.id, position);
    return { ...node, position };
  });
  return {
    ...graph,
    name: plan.name || graph.name,
    nodes: [...graph.nodes.filter(node => node.type !== "agent"), ...positioned],
    edges,
  };
}

export function applyPattern(graph: CanvasGraph, number: number): CanvasGraph {
  const agents = agentsOf(graph);
  const sequential = () => chain(...agents);
  const edges =
    number === 3
      ? graph.edges.filter(edge => !edge.feedback)
      : number === 2
        ? []
        : number === 5
          ? fan(agents.slice(0, -1), agents.slice(-1))
          : sequential();
  const first = agents[0],
    last = agents.at(-1);
  if (number === 4 && first && last) edges.push({ ...wire(last, first), feedback: true, label: "Next round" });
  return arrange({
    ...graph,
    edges,
    template: ["sequential", "parallel", "kahn", "recursive", "voting"][number - 1],
    roundLimit: number === 4 ? (graph.roundLimit ?? 3) : undefined,
  });
}

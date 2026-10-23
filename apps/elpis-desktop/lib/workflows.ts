export const WORKFLOWS_KEY = "elpis-workflow-draft-v1";
export type PetData = { character: string; characterImage?: string; title: string; instruction: string; model: string | null; provider?: string | null; editsFiles: boolean; acceptanceCriteria?: string[]; lastThreadId?: string };
export type Pet = { id: string; type: "pet"; position: { x: number; y: number }; data: PetData; measured?: { width?: number; height?: number } };
export type Wire = { id: string; source: string; target: string };
export type TaskState = { id: string; status: string; assignedThreadId?: string | null; failureReason?: string | null; result?: { summary?: string } | null };
export type TeamRun = { rootThreadId: string; graphId: string; status: string; tasks: TaskState[] };
export type Team = { name: string; nodes: Pet[]; edges: Wire[]; task?: string; run?: TeamRun };
export type TeamTask = { id: string; kind: "explore" | "implement" | "verify"; title: string; instruction: string; dependsOn: string[]; writeScopes: string[]; acceptanceCriteria: string[]; model?: string; provider?: string };
export const ended = (status: string) => ["succeeded", "completed", "failed", "cancelled"].includes(status);

/** The engine requires a directly dependent verifier for every task that writes. */
export function graphToTasks(graph: Pick<Team, "nodes" | "edges">, task: string): TeamTask[] {
  if (!graph.nodes.length) throw Error("Add a pet to start.");
  if (!task.trim()) throw Error("Give the team a task.");
  const ids = new Set<string>();
  for (const pet of graph.nodes) {
    if (!/^[a-zA-Z0-9_-]+$/.test(pet.id) || ids.has(pet.id)) throw Error("Every pet needs a unique task id.");
    ids.add(pet.id);
    if (!pet.data.title.trim()) throw Error("Every pet needs a name.");
    if (!pet.data.instruction.trim()) throw Error(`${pet.data.title} needs a role prompt.`);
    if (pet.data.provider && !pet.data.model) throw Error(`${pet.data.title} needs a model from its connection.`);
  }
  for (const pet of graph.nodes) if (pet.data.editsFiles) {
    if (ids.has(`${pet.id}-check`)) throw Error("A pet id conflicts with its check id.");
    ids.add(`${pet.id}-check`);
  }
  const byId = new Map(graph.nodes.map(pet => [pet.id, pet]));
  for (const edge of graph.edges) if (!byId.has(edge.source) || !byId.has(edge.target)) throw Error("An arrow points to a missing pet.");
  const visiting = new Set<string>(), seen = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error("That arrow makes a loop. Remove it before running.");
    if (seen.has(id)) return;
    visiting.add(id);
    for (const edge of graph.edges) if (edge.source === id) visit(edge.target);
    visiting.delete(id); seen.add(id);
  };
  graph.nodes.forEach(pet => visit(pet.id));
  const taken = new Set<string>();
  return graph.nodes.flatMap(pet => {
    const { data } = pet;
    const base = data.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || pet.id;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    const folder = `team/${slug}`, criteria = data.acceptanceCriteria?.filter(item => item.trim()) ?? [];
    const acceptanceCriteria = data.editsFiles ? (criteria.length ? criteria : ["The team's task is fulfilled and the changes pass focused checks."]) : [];
    const model = { ...(data.model ? { model: data.model } : {}), ...(data.provider ? { provider: data.provider } : {}) };
    // Each pet is told who it is, the whole task, and exactly whose results it receives, so a first pet never waits for input (23 Oct live run).
    const from = graph.edges.filter(edge => edge.target === pet.id).map(edge => byId.get(edge.source)!.data.title.trim());
    const instruction = [`You are ${data.title.trim()}, one agent of a team.`, data.instruction, `The team's task: ${task.trim()}`,
      from.length ? `You receive the results of ${from.join(" and ")}; they are given to you with this task. Build on them and do only your own part.` : "You go first: nobody hands you anything. Do only your own part of the task now.",
      "Reply with your result."].join("\n\n");
    const dependsOn = [...new Set(graph.edges.filter(edge => edge.target === pet.id).flatMap(edge => byId.get(edge.source)!.data.editsFiles ? [edge.source, `${edge.source}-check`] : [edge.source]))];
    const own: TeamTask = { id: pet.id, kind: data.editsFiles ? "implement" : "explore", title: data.title.trim(), instruction,
      dependsOn, writeScopes: data.editsFiles ? [folder] : [], acceptanceCriteria, ...model };
    return data.editsFiles ? [own, { id: `${pet.id}-check`, kind: "verify" as const, title: `Check: ${data.title}`,
      instruction: `Check ${data.title}'s result against: ${acceptanceCriteria.join("; ")}. Run focused checks and report the evidence. Change nothing of its work. Write your report to ${folder}/check/report.md and reply with your verdict.`,
      dependsOn: [pet.id], writeScopes: [`${folder}/check`], acceptanceCriteria: ["Each criterion is checked with evidence and a verdict."], ...model }] : [own];
  });
}

/** Only agents and their directional arrows survive the old canvas format. */
export function migrateTeam(value: unknown): Team {
  const empty: Team = { name: "Team", nodes: [], edges: [] };
  if (!value || typeof value !== "object" || !("nodes" in value) || !Array.isArray(value.nodes)) return empty;
  const saved = value as Partial<Team>;
  const nodes: Pet[] = value.nodes.flatMap((item: Record<string, unknown>) => {
    if (!item || !["agent", "pet"].includes(String(item.type)) || typeof item.id !== "string" || ["mother", "father"].includes(item.id.toLowerCase()) || !item.data || typeof item.data !== "object") return [];
    const data = item.data as Partial<PetData>, position = item.position as Pet["position"] | undefined;
    return [{ id: item.id, type: "pet", position: position && Number.isFinite(position.x) && Number.isFinite(position.y) ? position : { x: 100, y: 100 },
      data: { character: data.character || "researcher", ...(data.characterImage ? { characterImage: data.characterImage } : {}), title: data.title || "Pet", instruction: data.instruction || "", model: data.model || null,
        provider: data.provider || null, editsFiles: data.editsFiles === true, ...(data.acceptanceCriteria?.length ? { acceptanceCriteria: data.acceptanceCriteria } : {}), ...(data.lastThreadId ? { lastThreadId: data.lastThreadId } : {}) } }];
  });
  const ids = new Set(nodes.map(pet => pet.id));
  const edges = (saved.edges ?? []).filter(edge => ids.has(edge.source) && ids.has(edge.target) && !("kind" in edge) && !("feedback" in edge && edge.feedback)).map(({ id, source, target }) => ({ id, source, target }));
  return { name: saved.name || "Team", nodes, edges, task: saved.task || "", ...(saved.run ? { run: saved.run } : {}) };
}

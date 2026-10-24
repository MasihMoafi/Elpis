/** Worktree isolation on the agents canvas (components/agents-canvas.tsx). With `isolation: "worktree"` Elpis gives each
 * writing agent its own git worktree and merges the results into the checked-out branch once the whole graph has
 * succeeded; a clash stops the run and the engine lists the files (codex-rs core/src/tools/handlers/work_graph_worktrees.rs,
 * docs/WORK_GRAPHS.md). Elpis refuses the run outside a git repository that has a commit, so the canvas asks only inside one.
 * Plain functions with no imports, so node tests load them. */

/** The writing agents of a run part: its `implement` tasks (each is followed by its own check, which writes only its report). */
const writers = (tasks: { kind: string }[]) => tasks.filter(task => task.kind === "implement").length;

/** The body of POST /api/workflows/run. It asks for worktree isolation when the project is a git repository and the part
 * has more than one writing agent (one has no one to clash with); otherwise `isolation` is left out. */
export function runPayload<T extends { kind: string }>(rootThreadId: string, name: string, tasks: T[], maxConcurrency: number, repository: boolean) {
  return { rootThreadId, name, tasks, maxConcurrency, ...(repository && writers(tasks) > 1 ? { isolation: "worktree" as const } : {}) };
}
/** Whether a run part could use isolation, so the repository need only be asked about then. */
export const wantsIsolation = (tasks: { kind: string }[]) => writers(tasks) > 1;

/** A graph as workGraph/list reports it, as far as merge stops are read from it. */
export type ListedGraph = { id: string; error?: string | null; tasks: { id: string; failureReason?: string | null }[] };
/** What stopped the merge. `clash`: `agent`'s work clashed, with the checked-out branch (`into`, at the end of the run) or,
 * with `into` null, among the work it builds on. `blocked`: the project has uncommitted changes in files the merge
 * would change (no agent). `kept` is the engine's own line saying where the worktrees were kept. */
export type MergeStop = { kind: "clash" | "blocked"; agent: string | null; files: string[]; into: string | null; kept: string | null };

const names = (list: string) => list.split(", ").map(file => file.trim()).filter(Boolean);

/** The merge stops a graph reports, read from the engine's texts: a task that failed because the work it builds on
 * clashes (its `failureReason`), and the graph's `error` when the final merge clashed or was blocked. */
export function mergeStops(graph: ListedGraph): MergeStop[] {
  const error = graph.error ?? "", kept = error.match(/Kept (?:for inspection|worktrees with work): .+$/)?.[0] ?? null;
  const stops: MergeStop[] = [];
  for (const task of graph.tasks) {
    const files = task.failureReason?.match(/whose results clash in: (.+?); the conflicted worktree is kept at /)?.[1];
    if (files) stops.push({ kind: "clash", agent: task.id, files: names(files), into: null, kept });
  }
  // The branch is elpis/<graph id>/<task id>; the checked-out branch is named after "clashes with".
  const merged = error.match(/Not merged: elpis\/[^/\s]+\/(\S+) clashes with (\S+) in (.+?); \2 is untouched\./);
  if (merged) stops.push({ kind: "clash", agent: merged[1], files: names(merged[3]), into: merged[2], kept });
  const blocked = error.match(/Not merged: .+? has uncommitted changes in files the merge would change: (.+?); nothing was merged\./);
  if (blocked) stops.push({ kind: "blocked", agent: null, files: names(blocked[1]), into: null, kept });
  return stops;
}

/** The files, the first few and how many more. */
export function filesText(files: string[], most = 8) {
  return files.length > most ? `${files.slice(0, most).join(", ")} and ${files.length - most} more` : files.join(", ");
}

/** The notice for a merge stop, in the engine's facts: what clashed, in which files, what stayed untouched, where the
 * work was kept. `who` is the name of the agent. */
export function stopText(stop: MergeStop, who: string) {
  const files = filesText(stop.files);
  const sentence = stop.kind === "blocked"
    ? `Merge stopped: your project has uncommitted changes in ${files}, which the merge would change. Nothing was merged.`
    : stop.into
      ? `Merge stopped: “${who}” clashes with ${stop.into} in ${files}. ${stop.into} is untouched.`
      : `Merge stopped: the work “${who}” builds on clashes in ${files}. Your branch is untouched.`;
  return stop.kept ? `${sentence} ${stop.kept}` : sentence;
}

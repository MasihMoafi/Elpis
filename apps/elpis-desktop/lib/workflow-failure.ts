/** Why a workflow run ended badly and the one next step that fits, for History (W5: a failed run showed only "failed").
 * The reason comes from the run record: its error, else the failed agent's. The kinds are the ones his runs end with. */
export type FailedRun = {
  status: string;
  rootThreadId: string;
  error?: string | null;
  tasks?: { title?: string; status: string; failureReason?: string | null; assignedThreadId?: string | null }[];
};
export type FailureStep = { label: string; chat: string } | { label: string; folder: string };

const sentence = (text: string) => {
  const plain = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const end = plain.search(/\.\s/);
  const first = end > 0 ? plain.slice(0, end + 1) : plain;
  if (first.length > 220) return `${first.slice(0, 219).trimEnd()}…`;
  return /[.!?…]$/.test(first) ? first : `${first}.`;
};

export function runFailure(run: FailedRun, canOpenFolder: boolean): { reason: string; step: FailureStep } | null {
  // A run he stopped says so in its status; a run stopped by its time limit carries that as its error.
  if (run.status !== "failed" && !(run.status === "cancelled" && run.error)) return null;
  const task = run.tasks?.find(item => item.status === "failed" && item.failureReason);
  const error = (run.error || task?.failureReason || "").trim();
  const runChat: FailureStep = { label: "Open the run's chat", chat: run.rootThreadId };
  const agentChat: FailureStep = task?.assignedThreadId
    ? { label: "Open the agent's chat", chat: task.assignedThreadId }
    : runChat;
  const who = task?.title || "An agent";
  const outside = error.match(/^“?(.+?)”? changed files outside its write scopes: (.+?)\. Kept at (\/\S+)$/);
  if (outside)
    return {
      reason: `${outside[1]} changed files it was not given: ${outside[2]}. Its work is kept.`,
      step: canOpenFolder ? { label: "Open kept work", folder: outside[3]! } : agentChat,
    };
  const git = error.match(/^Workflow Git operation failed: (?:fatal: )?(.+)$/s);
  if (git)
    return {
      reason: `Elpis could not prepare the branch for ${who}: ${sentence(git[1]!)} The agent's work was not the cause.`,
      step: runChat,
    };
  // A subscription without quota stops its agent rather than moving it to another (E17); the run's chat resumes it, on
  // another model or after the reset. The line is bridge/workflow-models.mts quotaStopLine.
  const quota = error.match(
    /^(.+?) on .+? (did not run|stopped) because (the .+? usage limit (?:is|was) reached.*?); wait for the reset/,
  );
  if (quota)
    return {
      reason: `${who} ${quota[2] === "stopped" ? "stopped on" : "could not run"} ${quota[1]}: ${quota[3]}. Finished work is kept.`,
      step: { label: "Choose another model or wait, then resume", chat: run.rootThreadId },
    };
  if (/time limit/.test(error)) return { reason: sentence(error), step: runChat };
  if (!error) return { reason: "It ended without saying why.", step: runChat };
  // An agent's own error, often its provider's reply as JSON: "Quillon · Answer 1: {"error":{"message":"…"}}".
  const quoted = error.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const message = quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : error.replace(/^[^:{]{1,80}:\s*/, "");
  const name = task?.title ?? error.match(/^([^:{]{1,80}):/)?.[1]?.trim();
  return { reason: name ? `${name} stopped with an error: ${sentence(message)}` : sentence(message), step: agentChat };
}

import { Run } from "./types";

/** Whether the whole run is over: her part, and his if he has one. */
export const over = (run: Run) =>
  FINISHED.has(run.status) &&
  (!run.father || (FINISHED.has(run.father.status) && (!run.father.threadId || run.father.reported)));

export const FINISHED = new Set(["succeeded", "failed", "cancelled", "completed"]);

/** Her or his card in words, the same as the status chip: finished only when the run succeeded. */
export const ended = (status: string): "running" | "finished" | "cancelled" | "failed" =>
  !FINISHED.has(status) ? "running" : status === "failed" || status === "cancelled" ? status : "finished";

/** An ended run in words: Finished only when it succeeded (28 Oct: "Finished · 0 of 2 done" over a cancelled run). */
export const ENDED: Record<string, string> = {
  succeeded: "Finished",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** `at`: when it was seen; a saved run reopened later has no time to show, like its other lines. */
export const stoppedLine = (
  status: string,
  error?: string | null,
  at?: number,
): { at?: number; text: string; tone: "fail" }[] =>
  status === "failed" || status === "cancelled"
    ? [
        {
          ...(at === undefined ? {} : { at }),
          text: `RUN ${status.toUpperCase()} · ${error || "no reason was recorded"}`,
          tone: "fail",
        },
      ]
    : [];

export const plainActivity = (value: string) => {
  const clean = value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (clean.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? clean).slice(0, 120);
};

export const currentActivity = (task: { progress?: { text?: string; title?: string; at?: number }[] }) => {
  const recent = [...(task.progress ?? [])].reverse().find(item => item.text?.trim() || item.title?.trim());
  if (!recent) return "";
  const text = recent.text || recent.title || "",
    sentences = text
      .match(/.*?[.!?](?=\s|$)|.+$/g)
      ?.map(sentence => sentence.trim())
      .filter(Boolean) ?? [text];
  const active =
    sentences.find(sentence => /\b(?:I am|I['’]m|we are|we['’]re)\b/i.test(sentence)) ?? sentences[0] ?? "";
  const plain = plainActivity(active).replace(/^(?:I am|I['’]m|we are|we['’]re)\s+/i, "");
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "";
};

/** Polls can return the same run repeatedly. Keep React's state references when the visible data did not change. */
export const sameData = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export const OFFLINE_WORKFLOW = "Reconnect to design or run workflows. Your draft stays editable.";

export function runFailure(detail: string) {
  if (/EACCES|EPERM|permission|write.*(?:refused|denied)|not writable/i.test(detail))
    return `Elpis could not write the run's files. Choose a project you can write to or allow the requested write, then run again. ${detail}`;
  return `${detail} Review this message and the agents' Info, then try Run graph again.`;
}

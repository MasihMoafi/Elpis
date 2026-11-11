/** The one undo history for chat actions (shared system, requirement 4): rename, move into or out of a project, archive
 * and delete each record a step with its inverse, and Ctrl+Z / Ctrl+Shift+Z outside a text field
 * (lib/history-shortcut.ts through lib/shortcuts.ts) run the newest step back or forward. Text fields keep their own
 * undo. The history lives as long as the window; the bridge's trash keeps deletions across a reload. */
export type ChatStep = {
  kind: "rename" | "move" | "archive" | "delete";
  /** What was done, as the notice repeats it: "renamed “A” to “B”". */
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
};

const LIMIT = 50;
const done: ChatStep[] = [],
  undone: ChatStep[] = [];
let queue: Promise<unknown> = Promise.resolve();

/** A new action: it goes on top, and what was undone before it can no longer be redone. */
export function recordChatStep(step: ChatStep) {
  done.push(step);
  if (done.length > LIMIT) done.shift();
  undone.length = 0;
}

/** Runs one step back (undo) or forward again (redo), one at a time, in the order the keys were pressed. `pick` chooses
 * the newest matching step instead of the top one (the Deleted notice's Undo). Resolves to the step, or null when there
 * is none; a step that fails stays where it was and the error is passed on. */
export function stepChatHistory(direction: "undo" | "redo", pick?: (step: ChatStep) => boolean): Promise<ChatStep | null> {
  const run = queue.then(async () => {
    const from = direction === "undo" ? done : undone,
      to = direction === "undo" ? undone : done;
    const at = pick ? from.findLastIndex(pick) : from.length - 1;
    const step = from[at];
    if (!step) return null;
    await step[direction]();
    from.splice(at, 1);
    to.push(step);
    return step;
  });
  queue = run.catch(() => {});
  return run;
}

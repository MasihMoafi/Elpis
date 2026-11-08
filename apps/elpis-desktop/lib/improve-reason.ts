/** Why "Use this change" waits, in the Improve Elpis review (components/improve-elpis.tsx); "" when the change may be used:
 * its build and tests passed on the exact commit under review, with nothing uncommitted. */
export type ReviewedChange = {
  status?: string;
  dirty?: boolean;
  head?: string | null;
  error?: string | null;
  checks?: { passed: boolean; head?: string | null; commands: { command: string; code: number }[] } | null;
};
export function changeBlockedReason(change: ReviewedChange | null | undefined, busy: boolean): string {
  const failedCheck = change?.checks?.commands.find(command => command.code !== 0);
  return !change
    ? "Loading change…"
    : change.status === "checking"
      ? "Checking build and tests…"
      : busy
        ? "Wait for the current action to finish."
        : change.dirty
          ? "Commit this change, then run build and tests."
          : !change.checks
            ? "Run build and tests on this commit."
            : !change.checks.passed
              ? failedCheck
                ? `Check failed: ${failedCheck.command} (exit ${failedCheck.code}). See the output below.`
                : change.error || "Build or test checks failed. Run build and tests again."
              : !change.head || change.checks.head !== change.head
                ? "The commit changed after checks passed. Run build and tests again."
                : "";
}

# Deletion sprint — Elpis vs Codex

A single long session, one task, one number. Designed to isolate context management as the
only variable.

## Why this task

Every benchmark we considered hands the agent a fresh session per task, so nothing has to
survive anything and both harnesses score the same. This one is two unbroken hours on a
repository far larger than any context window: the agent cannot hold the codebase, must
decide what to carry forward, and is penalised precisely when it forgets what it already
established. That is the claim under test.

It also has no judgement in the scoring — the score is a count of lines — and it leaves the
repository smaller either way.

## Held constant

Same commit, same prompt (`PROMPT.md`, verbatim), same model, same machine, run back to
back. Each system gets its own worktree branched from the same commit. Only the harness
differs.

| | |
| --- | --- |
| Base commit | pinned in `MANIFEST.md` at run time |
| Model | Luna, max reasoning |
| Budget | 2 hours wall clock per system |
| Elpis worktree | `../Elpis-exp3-elpis`, branch `exp3/elpis` |
| Codex worktree | `../Elpis-exp3-codex`, branch `exp3/codex` |

## The score

**Primary — net source lines removed.** Counted over the run's commits, restricted to
non-test `.rs` files, and only across commits that compile with the test baseline
unchanged.

```
git diff --numstat <base>..HEAD -- '*.rs'
```

**Secondary — regressions.** Tests that pass at the base commit and fail at the end. This
is the continuity metric: it is what losing the thread looks like, expressed as an integer.

**Disqualified changes**, removed from the count before scoring:

- a deleted or weakened test whose subject still exists
- code moved rather than removed
- a commit that does not compile

## Baseline, captured before either run

1. Record the failing test set at the base commit. This is the reference for "no test that
   passed may fail".
2. Record cold-start time and clean-exit time, for context.
3. Record total source line count.

## Procedure

1. Create both worktrees from the same commit; confirm they are identical.
2. Run system A for two hours on `PROMPT.md`. Nothing is said to it beyond the prompt.
3. Run system B for two hours on the same prompt.
4. Score both worktrees against the base commit.
5. Publish both diffs, the failing-test baseline, and the two counts — including anything
   disqualified and why.

## Publication gate

No number is published without: the pinned manifest, both full diffs, the baseline failing
set, and the disqualification list. A run that broke the build is reported as such, not
dropped.

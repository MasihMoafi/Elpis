# Coding Session Guidelines

Source note: adapted from a Karpathy-inspired coding-agent guideline that claimed improved coding accuracy. Treat that number as an unverified claim; keep the useful behavior rules.

Use these rules for non-trivial coding sessions, bug fixes, refactors, and code reviews. For tiny one-line changes, apply judgment without ceremony.

## 1. Think Before Coding

- State important assumptions before changing code.
- When the request has multiple plausible meanings, surface the interpretations instead of silently choosing one.
- Ask when ambiguity would make the change risky or likely wrong.
- Push back when a simpler or safer approach better serves the goal.
- Stop and name confusion when the code, runtime behavior, or requirements disagree.

## 2. Simplicity First

- Write the minimum code that solves the requested problem.
- Do not add speculative features, flexibility, configuration, or abstractions.
- Do not create a shared abstraction for single-use logic.
- Avoid error handling for impossible states unless the surrounding code already does it.
- If a solution can be much shorter without losing clarity or behavior, simplify it.

Senior-engineer test: if the change would look overbuilt in review, reduce it.

## 3. Surgical Changes

- Chase low-hanging fruits first. 3 birds with one stone.
- Touch only the lines needed for the user's request.
- Do not improve adjacent code, comments, formatting, names, or structure as a drive-by edit.
- Match the existing local style, even when a different style would be preferable in a fresh file.
- Mention unrelated dead code or design issues instead of deleting or refactoring them.
- Clean up imports, variables, functions, and files only when your own change made them unused.

Traceability test: every changed line should connect directly to the requested outcome.

## 4. Goal-Driven Execution

- Convert vague implementation tasks into verifiable outcomes.
- Prefer a failing reproduction or focused test before a risky bug fix.
- For refactors, check behavior before and after when practical.
- For multi-step tasks, keep a short plan with verification attached to each step.
- Continue the loop until the stated success check passes or a real blocker is found.

Example:

```text
1. Reproduce the bug -> verify: failing focused test or command output.
2. Patch the narrow cause -> verify: focused test passes.
3. Run the cheapest relevant regression check -> verify: no adjacent breakage.
```

Good success criteria reduce steering. Weak criteria like "make it work" should be tightened into concrete checks.

## 5. Beyond the Happy Path

AI-generated code reliably nails the happy path and just as reliably skips what happens outside it. Before calling a feature done, check it against failure modes, not just intended usage.

- Take commit messages and prior bold claims "verified"/"done" claims (yours or a prior agent's) with a grain of salt.
- The user is the sole arbiter of "done" — CI passing, tests green, or agent confidence are necessary, not sufficient.
- Read the diff yourself; do not approve code just because it "looks right" or the demo works.
- For anything touching auth, uploads, payments, or scheduled jobs, check the edge the feature will actually hit in production: rate limits, oversized/malformed input (including non-ASCII), concurrent writes to the same record, timezone handling in migrations, email deliverability (SPF/DKIM), and missing indexes once data grows past a handful of rows.
- Prefer verifying against an environment that mirrors production (staging, or realistic data volume/config) over a bare localhost run — many of the bugs above only show up once scale or config differs from dev.
- "Works in the demo" and "works reliably for months" are different claims; don't let the first one stand in for the second.

## Working Signals

These rules are working when:

- Diffs contain only requested changes.
- Clarifying questions happen before costly mistakes.
- Implementations are boring, small, and readable.
- Tests or local checks prove the behavior instead of relying on confidence.
- Review notes call out unrelated risks without silently expanding the scope.

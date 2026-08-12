# Elpis Agent Map

## Start

- Read `docs/GUIDE.md`; it is the product, architecture, and requirements source of truth.
- Read `TASKS.md`; work only on its Current Action unless Masih changes priority.
- Read `docs/context.md` and `docs/sessions.md` before touching context, session, or pruning behavior.
- Read `docs/SHIPPING_RULES.md` before a release or any change that reads the filesystem, environment, or network.
- Read `docs/LOCAL_BUILD_RULES.md` before running `cargo` on Masih's workstation.
- Verify repository state before editing and preserve unrelated user changes.
- Challenge unclear or solution-first requirements with `$challenge-requirements` before planning implementation.

## Context Discipline

- Load only the guide sections and source files needed for the current task.
- Keep the active goal, changed files, verification, blocker, and next action visible.
- Summarize terminal output; do not carry raw logs once their result is known.
- After edits, retain the diff and verification result; reread file bodies on demand.
- Do not add slash commands unless Masih explicitly selects them.
- Worker agents must not edit `GUIDE.md` or `TASKS.md`; the coordinator owns those files.
- Do not delegate to Jules. The coordinator selects and manages workers and worktrees.

## Definition of Done

- **Masih is the sole arbiter of truth.** CI, compilation, tests, and agent claims are evidence, not functional acceptance.
- Before important or difficult implementation work, turn the request into an explicit acceptance harness and confirm it with Masih.
- Implement, run the required automated checks, build/install when applicable, and hand Masih a plain user test checklist.
- A task becomes verified only after Masih accepts the user-visible behavior and the evidence is recorded in `TASKS.md`.
- Behavior must be implemented, not merely documented.
- Rust changes pass the applicable Rust checks. This repository contains no Python.
- Known gaps and skipped checks are stated plainly.

## Evals First

Behavior that can silently do nothing needs an eval before it is changed. Every behavioral eval needs a positive case and a negative case, and the eval must be shown capable of failing before it is trusted.

Prefer behavioral evidence over plumbing-only tests: plant something only the feature could know or produce, run the real path, assert that it arrives, then disable or break the feature and assert that it does not.

## Durable Memory Status

The automated extraction, consolidation, and promotion pipeline was removed in commit
`0c105e3` after no real durable-memory promotion was demonstrated. Elpis can still admit a
user-maintained `MEMORY.md` into context, but it has no automatic promotion pipeline.

Do not restore an automated memory pipeline or change memory defaults without Masih's
explicit approval. Do not claim automatic durable memory works.

## Agent Dispatch

Use one coordinator and one worktree per implementation task. The coordinator owns `GUIDE.md`, `TASKS.md`, architecture decisions, task ordering, integration, and final acceptance. Workers implement bounded tasks; they do not redefine the product.

Do not run two agents against the same files or an unresolved shared interface. More agents increase speed only when tasks are genuinely independent.

For deterministic multi-agent work graphs, follow `docs/WORK_GRAPHS.md`.

### Difficulty Routing

| Difficulty | Characteristics | Preferred worker |
| --- | --- | --- |
| Easy | One localized behavior, known solution, low-risk change, narrow test | Fast low-cost worker |
| Medium | Several files, bounded design choice, adaptation of an existing pattern | Balanced worker |
| Hard | Architecture, runtime ownership, security, permissions, context/memory semantics, migration, cross-cutting interfaces | Main high-reasoning model |

Escalate when investigation reveals a broader interface or product decision. Do not let a worker quietly expand scope.

### Worktree Workflow

1. Start from the shared committed control baseline.
2. Select the Current Action from `TASKS.md` after verifying dependencies.
3. Create one branch and worktree for that task.
4. Give the worker exact scope, non-goals, dependencies, acceptance criteria, and required checks.
5. Require changed files, checks run, evidence, risks, and commit hash.
6. Review and integrate one branch at a time; rerun the acceptance check after integration.
7. The coordinator alone updates feature status to `verified` after Masih accepts it.

Remove a worktree only after its branch is integrated or intentionally abandoned.

### Worker Prompt Contract

Every delegated prompt must contain:

```text
Task ID:
Desired user-visible behavior:
Why it is needed:
Allowed files:
Forbidden scope:
Dependencies already verified:
Acceptance test:
Required checks:
Return: summary, changed files, verification, risks, commit hash.
```

If any field is missing or contradictory, challenge the requirement before coding.

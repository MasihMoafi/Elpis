# Elpis Agent Map

## Start

- Read `GUIDE.md`; it is the product, architecture, and requirements source of truth.
- Read `TASKS.md`; work only on its Current Action unless Masih changes priority.
- Read `docs/CONTEXT_AND_SESSIONS.md` before touching context, session, or pruning
  behavior; read `docs/BUILD_AND_REDUCTION_AUDIT.md` before build or dependency work.
- Read `docs/SHIPPING_RULES.md` before a release, and before any change that reads the
  filesystem, environment, or network. Nothing machine-specific ships in the binary.
- Verify the repository state before editing; preserve unrelated user changes.
- **Local incremental build & install command:** For fast local binary verification (~15s), run `CODEX_SKIP_BWRAP_BUILD=1 cargo build --manifest-path codex-rs/Cargo.toml --bin elpis && install -m 755 codex-rs/target/debug/elpis /home/masih/.local/bin/elpis`. Full workspace release compilations remain reserved for CI.
- Challenge unclear or solution-first requirements with `$challenge-requirements`
  before planning implementation.

## Context Discipline

- Load only the guide sections and upstream source files needed for the current task.
- Keep the active goal, changed files, verification, blocker, and next action visible.
- Summarize terminal output; do not carry raw logs once their result is known.
- After edits, retain the diff and verification result; reread file bodies on demand.
- Do not add slash commands unless Masih explicitly selects them.
- Worker agents must not edit `GUIDE.md` or `TASKS.md`; the coordinator owns those files.
- Do not delegate to Jules. The coordinator selects and manages any other worker model
  and its worktree; Masih does not need to manage them.

## Definition Of Done

- **Masih is the sole arbiter of truth.** No task is "done" because CI passed or
  cargo built — those are necessary, never sufficient. Agents seldom deliver what
  was requested precisely, so the flow is mandatory: (1) turn Masih's request into
  an explicit acceptance harness — an itemized criteria list stating exactly what
  must be true; (2) for important or difficult tasks, confirm that harness with
  Masih BEFORE implementing; (3) implement, verify compilation and automated
  checks, build + install; (4) hand Masih a plain test checklist (one bullet per
  behavior: what to do, what must happen); (5) the task reaches "done" only when
  Masih verifies it. Agents never claim functional verification themselves;
  unverified is unverified until Masih confirms.
- Behavior is implemented, not merely documented.
- A feature becomes complete only when its acceptance check passes and evidence is
  recorded in `TASKS.md`.
- Rust changes pass `cargo test`; Python changes pass the narrowest relevant test and
  `.venv/bin/python -m compileall -q src`.
- Known gaps and skipped checks are stated plainly.

## Agent Dispatch

Use one coordinator and one worktree per implementation task. The coordinator owns
`GUIDE.md`, `TASKS.md`, architecture decisions, task ordering, integration, and the
final acceptance decision. Worker agents implement bounded tasks; they do not redefine
the product.

Do not run two agents against the same files or an unresolved shared interface. More
agents increase speed only when tasks are genuinely independent.

### Difficulty routing

| Difficulty | Characteristics | Preferred worker |
| --- | --- | --- |
| Easy | One localized behavior, known solution, low-risk change, narrow test | Fast low-cost worker (Luna-class) |
| Medium | Several files, bounded design choice, adaptation of an existing pattern | Balanced worker (Terra/Flash-class) |
| Hard | Architecture, runtime ownership, security, permissions, context/memory semantics, migration, cross-cutting interfaces | Main high-reasoning model |

Escalate a task when investigation reveals a broader interface or product decision.
Do not let a worker quietly expand scope.

Do not use Jules. The coordinator chooses the worker model, creates and removes its
worktree, reviews its result, and integrates it. Masih only decides product behavior.

### Worktree workflow

1. Start only from the shared committed control baseline.
2. Select the Current Action from `TASKS.md` after verifying its dependencies.
3. Create one branch and worktree named for that task.
4. Give the worker the task fields, exact file scope, non-goals, and acceptance test.
5. Require the worker to return changed files, checks run, evidence, risks, and commit.
6. Review and integrate one branch at a time. Run the acceptance check after integration.
7. The coordinator alone updates feature status to `verified`.

Example after the control baseline is committed:

```bash
git worktree add ../Elpis-wt-terminal-selection -b agent/terminal-selection main
```

Remove a worktree only after its branch is integrated or intentionally abandoned.

### Worker prompt contract

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

### Current parallelism gate

The Codex-derived foundation establishes shared runtime, event, permission, and TUI
interfaces. Until that baseline is fully subtracted to Elpis's approved scope, do not
delegate changes that would target those same interfaces. Safe parallel work is limited
to isolated research, tests that do not assume an interface, and small corrections in
files explicitly excluded from the foundation migration.

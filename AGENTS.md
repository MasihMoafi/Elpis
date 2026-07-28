# Elpis Agent Map

## Start

- Read `docs/GUIDE.md`; it is the product, architecture, and requirements source of truth.
- Read `TASKS.md`; work only on its Current Action unless Masih changes priority.
- Read `docs/context.md` and `docs/sessions.md` before touching context, session, or
  pruning behavior; read `docs/BUILD_AND_REDUCTION_AUDIT.md` before build or dependency work.
- Read `docs/SHIPPING_RULES.md` before a release, and before any change that reads the
  filesystem, environment, or network. Nothing machine-specific ships in the binary.
- Verify the repository state before editing; preserve unrelated user changes.
- Read `docs/LOCAL_BUILD_RULES.md` before running `cargo` here. `target/` reached 246 GB
  on a 451 GB disk; every command needs `CODEX_SKIP_BWRAP_BUILD=1`; never `cargo fmt --all`.
- **Local incremental build & install command:** For fast local binary verification (~15s), run `CODEX_SKIP_BWRAP_BUILD=1 cargo build --manifest-path codex-rs/Cargo.toml --bin elpis && install -m 755 codex-rs/target/debug/elpis ~/.local/bin/elpis`. Full workspace release compilations remain reserved for CI.
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
- Rust changes pass `cargo test`. This repository contains no Python.
- Known gaps and skipped checks are stated plainly.

## Evals First

Behavior that can silently do nothing needs an eval before it is changed, and the eval
needs a negative case. Memory ran for days, completed every job, reported no error, and
promoted nothing; no test caught it because every test checked plumbing rather than
behavior. The pattern that does catch it: plant something only the feature could know, run
the real path, assert it arrives — then switch the feature off and assert it does not.

Existing evals: `docs/memory.md` section 6 (memory recall). Prove a new eval can fail
before trusting it.

## Known Gaps

### Durable memory never promotes (inherited, unfixed)

Stage 1 works: rollouts are extracted, stored, and marked as phase-2 candidates. Phase 2
runs, claims its job, and finishes without error — and has never once written to
`MEMORY.md` on a real machine. Measured on Masih's install: 104 extraction jobs done, 65
raw memories, 60 marked as candidates, and the memories git repository holding exactly one
commit — the initial baseline. `MEMORY.md` had not changed in the two days of use that
followed.

Root cause: promotion is gated on recall, and recall almost never happens. A raw memory
becomes eligible only at `recall_count >= 3` **and** `unique_query_count >= 2`
(`codex-rs/memories/write/src/storage.rs`), and the consolidation prompt refuses to promote
anything whose metadata says `promotion_eligible: false`. On that same install the whole
database held five recall queries total and no memory was ever recalled more than twice, so
the gate has never opened for a single item. Nothing is broken in the plumbing; the
threshold is simply out of reach at real usage rates.

Where the gate came from: it is Masih's design, adapted from openclaw's "dreaming" deep
phase, which promotes on `minScore` / `minRecallCount` / `minUniqueQueries`. Two properties
were not carried over — in openclaw dreaming is opt-in and the thresholds are configurable;
here they were hardcoded. The rule is sound for a system whose memory is searched often. In
Elpis memory is searched almost never, so the counter never moves.

Do not change the gate or the default without Masih's explicit approval. Both were altered
by agents once already and reverted. Memory ships **off**, matching upstream Codex. Anything
claiming memory works must show a promotion commit in `~/.elpis/memories/.git`, not a
passing test.

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

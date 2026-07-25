# Elpis Tasks

This is the current task source of truth. Keep it short. Completed release history is
archived in `docs/TASKS_V0_1_ARCHIVE.md`.

## How priority works

Every product task belongs to one of three importance levels:

- **Foundational:** Elpis would lose its purpose, reliability, or basic usability without it.
- **Important:** materially improves Elpis after the foundation is solid.
- **Nice-to-have:** useful optional work that must not delay foundational polish.

These levels describe importance, not difficulty, and they are not release numbers.
Easy, Medium, and Hard are separate task-difficulty labels proposed for `/auto`, where
Elpis would choose an appropriate model for a task. They do not replace the importance
levels above.

No new feature work starts while the Current Action is open unless Masih explicitly
changes priority.

## v0.1.1 — Context Ledger placement and file links (Masih-verified 2026-07-25)

`v0.1.1` was first tagged on 2026-07-24, but its tag CI run failed and no release was
published. It was retagged and published on 2026-07-25 and is now the latest download.

- **Ledger top alignment.** The ledger was bottom-anchored and sized to the whole chat
  region, so a tall panel started level with the last chat message and overhung the
  status line. It now top-aligns with the composer box and runs downward, and
  `desired_height` reserves the rows below that point so the panel is never trimmed.
  Three earlier attempts failed by keeping the bottom anchor and shrinking the panel,
  which ate its bottom instead of moving its top.
- **Ledger height is measured, not counted.** `context_ledger_desired_height` built the
  real lines and measures them with `Paragraph::line_count`. The previous hand-counted
  arithmetic had to mirror the renderer by hand and silently missed wrapped rows and the
  expanded WHY INCLUDED block.
- **Ledger rows are ctrl+clickable.** Each source row emits `file://<abs path>` through
  the existing `mark_buffer_hyperlinks` helper, so context files open for editing the
  way `/usage` paths do.
- **`/agent`, `/multi-agents`, `/ide` unhidden** for evaluation against I6. They are
  fully implemented inherited Codex features that Elpis's `is_visible` allow-list hid.
  `/ide` requires an IDE extension to serve its socket; decide to own or re-hide it.

## Current Action — context-pruning correctness hardening

**Importance:** Foundational · **Status:** implemented, awaiting Masih verification

Remove the unsafe fixed-length cleaner and make Ace safe enough to test as a post-turn
deletion layer. The active agent must finish using tool output and encrypted reasoning
before Elpis expires either one.

Acceptance:

1. A tool result larger than 400 characters but below Codex's native cap reaches the
   next model request unchanged by Elpis.
2. Encrypted reasoning remains available throughout the active turn's tool and hook
   follow-ups. After a successful final response, current-turn reasoning expires from
   working history but remains in the durable rollout; `all_turns` reasoning is retained.
3. Terra is attempted first and the active model second. A failed or malformed result
   changes no history and covers no IDs.
4. Ace receives the active user question plus each tool invocation paired with its output.
   Assistant answers are not part of the deletable batch.
5. Every non-empty model-output line must contain one known, unique ID and a non-empty
   conclusion. Any malformed, unknown, or duplicate line invalidates the whole pass.
6. A kept result becomes a compact conclusion plus `rollout://tool-call/<id>` pointer.
   An omitted dead end removes both the invocation and output from working history.
7. Codex's inherited output truncation remains active, and `/usage` does not count
   removed Layer-1 savings.
8. Masih runs one real tool-heavy turn and confirms the agent receives the decisive
   output before Ace prunes completed exploration.

Implementation evidence:

- Focused regression: `request_preparation_preserves_tool_output_above_old_elpis_limit`.
- Focused regression: `request_preparation_preserves_reasoning_for_active_turn_follow_up`.
- Focused tmux runs pass: 14 pruner tests, two request-preparation tests, and two
  current-turn reasoning-expiry tests.
- Strict manifest parsing, active-question context, invocation/output pairing,
  zero-trace dead-end deletion, and fail-open parsing are covered.
- Codex's inherited output-truncation suite passes 17 tests, and the focused TUI
  context-window test passes.
- The fast local build and install pass; the installed `elpis 0.1.1` binary is
  byte-identical to the build output and launches/exits cleanly in tmux.
- Core's test targets and the app-server test targets compile. Focused Guardian retry,
  pruner, request-preparation, and reasoning-expiry tests pass. The full Core suite was
  not run in this pass; the full TUI suite still has an inherited advanced-reasoning
  stack overflow. Neither full suite is counted as passing.

Non-goals:

- Do not add another arbitrary length threshold or let Ace run exploratory tools.
- Do not change RAG, RTK integration, pruning levels, `/goal`, or a future project
  `VISION.md`.

## Completed — make the existing UI solid (Context Ledger)

**Importance:** Foundational · **Status:** done, Masih-verified 2026-07-23

The current Elpis works well enough for daily use. The priority is now to perfect the
features already present before adding new ones.

Known Context Ledger problems:

- On 2026-07-23, pressing Tab with a draft in the composer submitted the message instead
  of opening the Context Ledger.
- The current ledger layout and interaction are not good enough.
- After the key-routing bug is fixed, review the ledger with Masih and choose whether to
  improve it or remove it. Do not assume that decision.

Acceptance:

1. Pressing Tab never submits the draft or behaves like Enter.
2. With text in the composer, opening and closing the ledger preserves the draft exactly.
3. The ledger can be navigated without accidental message submission.
4. Masih reviews the resulting ledger and either accepts the improved design or chooses
   its removal.
5. Focused Rust tests and the required Rust test suite pass.

Non-goals:

- Do not add `/auto`, agent controls, `/multi-task`, voice, LSP, or other new features.
- Do not redesign unrelated screens during the ledger fix.

## Foundational

### F1. Reliable current baseline — active

- Fix bugs in existing behavior before adding features.
- Polish confusing or weak UI one area at a time, starting with the Context Ledger.
- Preserve working context continuity, pruning, memory, RAG, provider, permission, and
  session behavior while polishing the product.

### F2. Ace, context, continuity, memory, and RAG — shipped

- Ace ("Masih's Ace in the Hole") is Elpis's meaning-aware second pruning layer.
- Portable context, exact resume, lean continuation, dual-layer pruning, durable memory,
  and local RAG are implemented.
- New defects in these systems are foundational regressions.

### F3. Provider and permission boundary — shipped

- OpenAI subscription auth is the default path.
- Anthropic, Gemini, and OpenRouter paths are available through their supported adapters.
- Runtime/provider identity and approval controls are visible.

### F4. Release and installation baseline — shipped

- `v0.1.1` is the current release; `v0.1.0` remains the first public launch.
- CI builds and verifies the Linux release artifact.
- The release installer verifies the downloaded artifact before replacing the binary.

## Important

### I1. `/auto` cost-saving model routing — deferred experiment

- Goal: avoid spending the strongest model on trivial work without increasing total
  cost through bad routing, retries, or damaged work.
- `/auto <task>` uses Terra at high reasoning to understand the task. Terra asks Masih
  to state an intent when none is clear; otherwise it cleans the request and chooses
  the working model.
- Easy routes to Luna at medium reasoning, Medium to Terra at high reasoning, and Hard
  to Sol at high reasoning.
- Routing happens once for each explicitly started `/auto` task. The selected model
  stays with that task, and Elpis shows the choice in the model bar.
- Do not implement this yet. First test its decisions against a small set of Masih's
  real tasks and compare total cost and successful completion with using Sol at high
  reasoning throughout. Proceed only if it clearly saves money without unacceptable
  routing mistakes.

### I2. Easier installation and distribution — pending

Improve installation and distribution after the current baseline is polished. Keep one
clear supported path and verify it in a clean environment.

- **macOS build (Apple Silicon) — target v0.2.** The single biggest adoption blocker:
  most of the potential audience cannot run Elpis today. Windows comes after macOS.

### I3. Careful Rust subtraction — ongoing maintenance

Continue deleting inherited Codex code only when reachability and behavior checks prove
Elpis does not need it. Small, measured removals are preferred over broad deletion.

### I4. Performance guardrails — monitor

Startup already feels fast in current daily use, so there is no active startup project.
Binary-size reduction is also not an active feature. Measure release builds in CI and
open focused work only if startup time or release size regresses.

### I5. Structured interactive clarification — planned

Elpis turns Masih's request into an explicit acceptance harness (criteria list) and
confirms it with him before implementation on important or difficult tasks. This is
the product form of the arbiter-of-truth rule in `AGENTS.md`: passing CI and cargo
builds is never "done"; only Masih's verification against the confirmed criteria is.

### I6. Multi-agent controls and `/multi-task` — planned

Run and inspect several agents, potentially as a visible task graph.

### I7. Voice input — planned

### I8. LSP-backed code intelligence — planned

## Nice-to-have

These are wanted ideas, but they are optional until the current product is polished:

- Remote messaging, scheduling, mobile control, and opt-in telemetry.

Old-data cleanup is not active work. It would mean previewing and then removing stale
caches, duplicate evidence, old checkpoints, and other data that is no longer needed,
without touching current sessions or authoritative memory. Add it only if storage growth
becomes a real problem and Masih approves the exact retention rules.

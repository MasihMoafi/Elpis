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

`v0.1.1` was tagged on 2026-07-24 but its tag CI run failed, so no release was ever
published and `v0.1.0` stayed the latest download. The version number is therefore
reused rather than burned; the release workflow already replaces a re-tagged release.

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

## Current Action — none open

The previous Current Action (Context Ledger, Foundational) is **done and
Masih-verified 2026-07-23**: Tab no longer submits the draft; Alt+C toggles the
ledger; panel bottom-anchored (commits `81d6000`, `018f965`); design accepted.
Masih sets the next Current Action; no new feature work starts until he does.

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

- `v0.1.0` is the release tag (re-tagged 2026-07-23 after history cleanup; hash deliberately not pinned here).
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

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

## Masih-verified — context-pruning correctness hardening

**Importance:** Foundational · **Status:** verified by Masih 2026-07-26

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
- Codex's inherited output-truncation suite passes 16 tests, and the focused TUI
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

## Masih-verified — RTK shell-output hook

**Importance:** Foundational · **Status:** verified by Masih 2026-07-26

Elpis accepts RTK's native `PreToolUse` rewrite response, so supported Bash commands
run through RTK before their compact output enters model context. Unsupported commands
and hook failures continue unchanged.

Acceptance:

1. `/hooks` shows one active `PreToolUse` hook after the user installs and trusts
   `rtk hook claude`.
2. A model-requested `git status` is visibly executed as `rtk git status`.
3. RTK's rewrite shape is accepted without weakening deny or malformed-output handling.
4. `RTK_DISABLED=1 <command>` bypasses filtering for exact raw output.
5. Supported commands use RTK's maintained filters, including searches and file
   discovery. Exact raw output remains available through `RTK_DISABLED=1` and RTK's
   failure-output recovery.

Evidence:

- All 121 `codex-hooks` tests pass.
- The fast local build and install pass.
- A tmux turn visibly ran `rtk git status` and returned compact output.
- In one real RAG investigation, RTK removed 72–97% of three broad `rg` outputs before
  the active agent saw them. Masih reviewed the tradeoff and selected RTK's maintained
  defaults based on its published tests and benchmarks.
- Masih completed the installed-binary acceptance test and confirmed the integration.

## Masih-verified — `elpis --update`

**Importance:** Important · **Difficulty:** Medium · **Status:** verified by Masih 2026-07-26

Add an update flag to the shipped Elpis binary. It must use Elpis's GitHub release and
checksum, replace only the supported user-local installation atomically, and leave the
existing binary unchanged on any failure.

Acceptance:

1. `elpis --help` lists `--update`.
2. `elpis --update` exits without launching the TUI.
3. A controlled fixture update verifies SHA-256 and atomically replaces a temporary
   user-local test binary.
4. Checksum mismatch, download failure, unsupported platform, or replacement failure
   returns a clear error and leaves the existing binary byte-for-byte unchanged.
5. An already-current version reports that clearly and performs no replacement.
6. Automated tests use a temporary install location and controlled fixture endpoint;
   they never overwrite the developer's installed binary or depend on a live release.

Evidence:

- All 13 shipped-binary tests pass, including successful replacement, checksum
  mismatch, download failure, replacement failure, unsupported platform, and
  already-current behavior.
- The fast local build and install pass; the installed binary is byte-identical to the
  build output.
- `elpis --update` checked GitHub's live latest release, reported `0.1.1` already
  current, exited without opening the TUI, and was confirmed by Masih.

## Masih-verified — Pruning evidence inspector

**Importance:** Foundational · **Difficulty:** Hard · **Status:** verified by Masih 2026-07-26

Preserve one immutable audit record per Ace pass showing the actual model-visible items
before pruning, Ace's exact input and raw response, the validated keep/delete decision
for every call ID, and the actual model-visible items after pruning. Exact IDs must
open the original tool invocation/output without loading the full rollout, system
prompt, or skills. RAG may help discovery, but it is not the source of truth for exact
evidence.

Acceptance:

1. Each applied pass creates a new directory under
   `~/.elpis/logs/pruning/passes/<pass-id>/`; earlier passes are not overwritten.
2. `ace.json` shows Ace's exact instructions, input, and raw response.
3. Each reviewed call has a focused JSON file showing its exact model-visible before
   and after items, decision, conclusion, and evidence pointer—without unrelated system
   prompts, skills, or transcript content.
4. If the immutable audit cannot be written, Elpis preserves working history and does
   not count the pass as applied.

Implementation evidence:

- All 17 focused pruning/audit tests pass, including kept and deleted calls, immutable
  pass directories, focused artifacts, and write-failure handling.
- The broad Core run passed 2,031 tests; one machine-proxy test passes with inherited
  proxy variables removed, and one feedback-ID test fails identically on untouched
  `main`.
- The fast local build and install pass; installed `elpis 0.1.1` is byte-identical to
  the build output.
- A real tmux turn produced a 1,996-character tool result. Ace retained its decisive
  finding, removed about 1,764 characters, wrote the exact before/after audit, and did
  not append the successful pass to the old multi-megabyte debug log.

## Current Action — Separate Elpis from Codex state

**Importance:** Foundational · **Difficulty:** Hard · **Status:** implemented, awaiting Masih

Give Elpis its own `ELPIS_HOME`/`~/.elpis` for configuration, sessions, history, logs,
hooks, skills, plugins, caches, and mutable runtime state. Elpis and Codex must not
silently alter each other. Existing users need an explicit one-time migration;
authentication must be handled as a separate, deliberate choice rather than silently
sharing every Codex file.

Acceptance approved by Masih:

1. `ELPIS_HOME` is Elpis's only global mutable-state root and defaults to `~/.elpis`.
   Elpis establishes it before argument dispatch and does not inherit `CODEX_HOME` or
   `CODEX_SQLITE_HOME`.
2. Elpis launches with `~/.codex` absent and can complete a provider-key turn, resume
   it, and run its hooks. ChatGPT subscription login is the explicit exception in item
   6. Exact rollouts and resume history live under `$ELPIS_HOME/sessions`.
3. User configuration, history, logs, databases, hooks, rules, skills, plugins, caches,
   shell snapshots, and temporary runtime files remain under `$ELPIS_HOME`. Changing
   one of these through Elpis cannot change Codex state, and the reverse is also true.
4. Project-local Elpis configuration, hooks, and rules use `.elpis/`; Elpis does not
   load the project's `.codex/`. Shared project instructions such as `AGENTS.md` and
   ecosystem-level `.agents/skills` remain shared because they are not Codex-owned
   mutable state.
5. `elpis --migrate-from-codex` first shows exactly which categories and paths would be
   copied. Applying a migration is a separate explicit action, copies only selected
   categories, never moves or deletes the source, never overwrites existing Elpis
   state, and rewrites migrated paths that still point inside the old Codex home.
   Mixed historical sessions are copied only when the user explicitly selects them.
6. ChatGPT subscription authentication is the sole Codex-owned exception: Elpis reuses
   the existing Codex login instead of requiring a second login. Other providers remain
   API-key based. General configuration and runtime state never come from `~/.codex`.
7. Tests use temporary homes and prove both directions of isolation. The installed
   binary is then handed to Masih with checks for subscription-login reuse, RTK hook
   discovery, one real turn, and resume.

Implementation evidence:

- The 17 shipped-binary tests pass. Focused tests also prove that project `.elpis`
  loads without project `.codex`, and tool subprocesses cannot inherit Elpis's private
  authentication routing.
- Core, TUI, app-server, and Linux-sandbox changes compile together. The fast local
  build and install pass; installed `elpis 0.1.1` is byte-identical to the build.
- A temporary-home tmux run reused the existing ChatGPT subscription login, discovered
  the migrated RTK hook, completed an exact-response turn, and loaded that turn through
  `/resume`.
- That live run wrote its rollout under the temporary `ELPIS_HOME`; Codex's real
  session count and history file were unchanged.
- Preview/apply migration was exercised against the existing RTK hook. It copied only
  the selected hook, left its source byte-identical, and skipped the existing
  destination on a second application.
- Masih confirmed on 2026-07-26 that ChatGPT subscription login was reused, the RTK
  hook was discovered, and the turn resumed correctly. One real-turn completion and
  bidirectional Elpis/Codex state isolation remain awaiting Masih's verification.

## Queued next — do not start until the Current Action is closed

1. **Corrected public release — Foundational · Medium.** After the evidence inspector,
   updater, and state separation are verified, publish the fixed build as the first
   recommended public preview. Masih selected a clean public release surface on
   2026-07-26: after the successor is live, delete the old `v0.1.0` and `v0.1.1`
   GitHub releases and tags so the corrected build is the first and only release new
   visitors see. Preserve all commits, source history, and local work; do not rewrite
   repository history. The destructive remote action remains explicitly deferred and
   requires fresh confirmation after the successor release is live, so
   `releases/latest` and the installer never lose their target.

   **Release-blocking bug found and fixed 2026-07-26.** The "Verify executable identity"
   step in `.github/workflows/embedded-elpis-linux.yml` pinned the literal string
   `elpis 0.1.1`, while `tui/Cargo.toml` is now `0.1.0`. The next tag build would have
   failed that assertion and — per the known trap — published nothing, silently. The step
   now reads the expected version out of the manifest, so a version bump can no longer
   turn the release build red. Verified locally: the extraction yields `0.1.0` and matches
   `elpis --version`.
2. **Cross-turn consolidation — Foundational · Hard.** Near 65% context use, reassess
   compact conclusions across completed turns, mark superseded findings explicitly,
   and exclude obsolete state from future requests. Prefer extending the validated
   Ace record pipeline over adding an unconstrained third agent. Native compaction
   remains the fail-safe; failure changes nothing.
3. ~~**Automatic project `VISION.md` — Foundational · Hard.**~~ **Done 2026-07-27.**
   Masih reclassified this as not hard and closed it at the prompt layer rather than as
   an Elpis feature: the behavior now lives as an always-on `## Vision` rule in the dev
   skill's `AGENTS.md`, alongside the existing `vision` skill. On arrival at a project
   the agent finds the orientation file (`VISION.md` → `AGENTS.md` → `CLAUDE.md` →
   `readme.md`), extracts identity, directory map, built-versus-aspirational state, and
   non-goals, drafts a `VISION.md` when none exists — shown before saving — and reports
   drift instead of silently reconciling it.

   The two open questions are answered by that placement: nothing refreshes on a timer,
   and a human-edited `VISION.md` is never overwritten without being shown first. Reopen
   only if the prompt-layer rule proves insufficient in real use.

## Ordering Masih set on 2026-07-26

`elpis --update` first, then the corrected public release once the current code is
near-perfect, branded as the first real version. Lowest priority, in no particular
order: `/remote`, UI tweaks, RAG, and condensing the documentation set.

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

Masih's rule, 2026-07-26: **if a whole drawer can be thrown out cheaply, throw out the
whole drawer. If it is tangled up with things that matter, leave it alone.** Prefer
removing an entire unreachable unit over picking dead statements out from between live
ones. A tangled removal must justify its cost with a result, not with tidiness. Nothing
is ever lost — the upstream Codex repository sits beside this one, so anything deleted
can be brought back instead of rewritten.

Reachability and behavior checks still gate every removal.

**Analytics subtraction is finished (2026-07-26).** The crate and its upload path went
earlier; the surviving knobs, flags, and generated schema entries are now gone too, and
with them a stale second gate that discarded OTEL metrics even when a user had explicitly
configured a metrics exporter — which contradicted the README's telemetry promise. Two
dead tests that waited on a deleted network endpoint were removed, and two write-only
telemetry fields the compiler exposed afterwards. No analytics debt remains. This pass
did not measurably change speed, build time, or package size, and was not expected to.

One defect it surfaced, still open and separate from analytics:

- `readme.md` ships two literal "Diagram placeholder" lines. **Not a defect — Masih's own
  work in progress**; the diagrams are being drawn. Leave them alone.

Corrected 2026-07-26. This entry previously claimed "the shipped binary links
`app-server-test-client` for one hidden debug subcommand, and that crate carries a command
that mutates the live account's installed plugins." Both halves are wrong:

- `codex-cli` is a **dev-dependency** of `tui` (`tui/Cargo.toml`, `[dev-dependencies]`), so
  it is not in the shipped binary's link graph. `cargo tree -p codex-tui -e normal` contains
  neither `codex-cli` nor `codex-app-server-test-client`. The crate reached only the `codex`
  multitool binary built from `cli/`, which Elpis does not ship.
- `plugin-remote-uninstall` was never reachable through `cli/`. The only call site was
  `codex_app_server_test_client::send_message_v2`; the clap subcommand tree carrying the
  plugin command lives in that crate's own separate `main.rs`.

The dependency and the `debug app-server` subcommand were removed from `cli/` anyway as
cheap subtraction under I3, not as a shipping fix.

Next candidate, cheap and compiler-proven: the dead TUI methods and constants rustc
already reports as never used. Rejected as not worth its cost: deleting `thread_source`,
a pure classification label spread over 205 sites with a persisted-store migration.

### I4. Startup time — open, unmeasured

Corrected 2026-07-26. This entry previously read "startup already feels fast in current
daily use, so there is no active startup project." Masih reports the opposite: Elpis starts
no faster than Codex, if at all. That claim was never backed by a measurement, and nothing
in the repository measures startup today.

The work, in order:

1. Profile where the milliseconds actually go — config load, skills injection, history/DB
   open, hook discovery, provider probe — before changing anything. No speculative trimming.
2. Only then open focused work against whatever dominates.

Binary-size reduction remains inactive.

### I5. Structured interactive clarification — closed 2026-07-26

Closed by Masih on 2026-07-26 after trying the unhidden inherited Plan mode: "it's not
what I wanted, but it's not a high priority at the moment; `/plan` works for now." Elpis
does not grow a second feature doing the same job. Reopen only if `/plan` proves
insufficient in real use, and scope it then to the actual gap rather than the whole idea.

Original goal, kept for reference:

Elpis turns Masih's request into an explicit acceptance harness (criteria list) and
confirms it with him before implementation on important or difficult tasks. This is
the product form of the arbiter-of-truth rule in `AGENTS.md`: passing CI and cargo
builds is never "done"; only Masih's verification against the confirmed criteria is.

What shipped instead: inherited Plan mode, unhidden. Masih pointed out it likely already
did most of this, and he was right. It is substantial — 196 references across 28 files in
`core/` and `tui/`, a 1,698-line test file at `tui/src/chatwidget/tests/plan_mode.rs`, a
`plan_mode_reasoning_effort` config knob, and a streaming state machine in
`core/src/session/turn.rs`. It was hidden only by `is_visible`; the second gate
(`collaboration_modes_enabled`) was already unconditionally `true` in
`tui/src/chatwidget/constructor.rs`, and `Feature::CollaborationModes` is
`Stage::Removed, default_enabled: true`. One line of visibility replaced a Medium feature.

### I6. Multi-agent controls and `/multi-task` — planned

Run and inspect several agents, potentially as a visible task graph.

### I7. Voice input — planned

### I8. LSP-backed code intelligence — planned

Structural, always-current answers from the same service an editor uses: where a symbol
is defined, what type it has, what breaks if it is renamed. This is not retrieval and
does not overlap RAG; it is exact where RAG is approximate.

## Nice-to-have

These are wanted ideas, but they are optional until the current product is polished:

- Remote messaging, scheduling, mobile control, and opt-in telemetry.
- `/remote`.
- UI tweaks.
- RAG. Two known defects gate it: it is unreachable from a binary install, and it
  hard-imports torch even when the provider is Ollama. The intended fix is openclaw's
  engine / store / embedding-provider split.
- Condense `docs/`. Eleven files plus a blog directory, several of which restate the
  readme or point at it. Merge or delete rather than adding more.
- **Endurance run — targeted at v0.3.** Run one uninterrupted Elpis session for a very
  long stretch (Masih's target: 48 hours) doing real work, and record what actually
  happens to context, memory, continuity, and evidence across it. This is a test, not a
  feature: the deliverable is measured evidence — free context over time, compaction
  events survived, memory growth, and any failure — that can be published in the readme.
  Do not claim a record before the run has been completed and reviewed by Masih.

Old-data cleanup is not active work. It would mean previewing and then removing stale
caches, duplicate evidence, old checkpoints, and other data that is no longer needed,
without touching current sessions or authoritative memory. Add it only if storage growth
becomes a real problem and Masih approves the exact retention rules.

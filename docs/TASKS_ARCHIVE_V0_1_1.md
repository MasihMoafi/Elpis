# Task archive — v0.1.0 (corrected build) and v0.1.1 line

Closed work moved out of `TASKS.md` on 2026-07-27 to keep the live list short.

Older history: `docs/TASKS_V0_1_ARCHIVE.md`.

---

## Context Ledger placement and file links — verified 2026-07-25

`v0.1.1` was first tagged on 2026-07-24, but its tag CI run failed and no release was
published. It was retagged and published on 2026-07-25.

- **Ledger top alignment.** The ledger was bottom-anchored and sized to the whole chat
  region, so a tall panel started level with the last chat message and overhung the
  status line. It now top-aligns with the composer box and runs downward, and
  `desired_height` reserves the rows below that point so the panel is never trimmed.
  Three earlier attempts failed by keeping the bottom anchor and shrinking the panel.
- **Ledger height is measured, not counted.** `context_ledger_desired_height` builds the
  real lines and measures them with `Paragraph::line_count`.
- **Ledger rows are ctrl+clickable.** Each source row emits `file://<abs path>` through
  `mark_buffer_hyperlinks`.
- **`/agent`, `/multi-agents`, `/ide` unhidden.** Fully implemented inherited Codex
  features that the `is_visible` allow-list hid. `/ide` requires an IDE extension to
  serve its socket.

## Context Ledger usability — verified 2026-07-23

Acceptance: Tab never submits the draft; opening and closing the ledger preserves the
draft exactly; the ledger can be navigated without accidental submission; Masih accepts
the design; focused Rust tests pass.

## Context-pruning correctness hardening — verified 2026-07-26

Removed the unsafe fixed-length cleaner and made Ace safe as a post-turn deletion layer.

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

Evidence: regressions `request_preparation_preserves_tool_output_above_old_elpis_limit`
and `request_preparation_preserves_reasoning_for_active_turn_follow_up`; 14 pruner tests,
two request-preparation tests, two reasoning-expiry tests; Codex's inherited
output-truncation suite (16 tests); focused TUI context-window test. The full Core suite
was not run; the full TUI suite still has an inherited advanced-reasoning stack overflow.

## RTK shell-output hook — verified 2026-07-26

Elpis accepts RTK's native `PreToolUse` rewrite response, so supported Bash commands run
through RTK before their compact output enters model context.

Acceptance: `/hooks` shows one active `PreToolUse` hook after installing and trusting
`rtk hook claude`; a model-requested `git status` visibly runs as `rtk git status`; RTK's
rewrite shape is accepted without weakening deny or malformed-output handling;
`RTK_DISABLED=1` bypasses filtering; supported commands use RTK's maintained filters.

Evidence: 121 `codex-hooks` tests pass; a tmux turn visibly ran `rtk git status`; in one
real RAG investigation RTK removed 72–97% of three broad `rg` outputs.

## `elpis --update` — verified 2026-07-26

An update flag on the shipped binary, using Elpis's GitHub release and checksum,
replacing only the supported user-local installation atomically.

Acceptance: `--update` is listed in `--help`; it exits without launching the TUI; a
controlled fixture update verifies SHA-256 and atomically replaces a temporary
user-local test binary; checksum mismatch, download failure, unsupported platform, or
replacement failure returns a clear error and leaves the binary byte-for-byte unchanged;
an already-current version reports that clearly and performs no replacement.

## Pruning evidence inspector — verified 2026-07-26

## Separate Elpis from Codex state — verified 2026-07-27

`ELPIS_HOME`/`~/.elpis` owns configuration, sessions, history, logs, hooks, skills,
plugins, caches, and mutable runtime state.

Acceptance:

1. `ELPIS_HOME` is the only global mutable-state root, defaults to `~/.elpis`, is
   established before argument dispatch, and does not inherit `CODEX_HOME` or
   `CODEX_SQLITE_HOME`.
2. Elpis launches with `~/.codex` absent and can complete a provider-key turn, resume it,
   and run its hooks. Exact rollouts and resume history live under `$ELPIS_HOME/sessions`.
3. Configuration, history, logs, databases, hooks, rules, skills, plugins, caches, shell
   snapshots, and temporary runtime files stay under `$ELPIS_HOME`, in both directions.
4. Project-local configuration, hooks, and rules use `.elpis/`; the project's `.codex/`
   is not loaded. `AGENTS.md` and `.agents/skills` remain shared.
5. `elpis --migrate-from-codex` previews before applying, copies only selected
   categories, never moves or deletes the source, never overwrites existing Elpis state,
   and rewrites migrated paths pointing inside the old Codex home.
6. ChatGPT subscription authentication is the sole Codex-owned exception.
7. Tests use temporary homes and prove both directions of isolation.

Evidence: 17 shipped-binary tests pass; focused tests prove project `.elpis` loads
without project `.codex` and that tool subprocesses cannot inherit Elpis's private
authentication routing; a temporary-home tmux run reused the ChatGPT login, discovered
the migrated RTK hook, completed a turn, and resumed it; preview/apply migration copied
only the selected hook and skipped an existing destination on reapplication. Isolation
measured mechanically on 2026-07-27: `~/.codex` snapshotted (11,805 files), Elpis
launched, file list and every top-level file including `auth.json` byte-identical after.

## Corrected public release — done 2026-07-26

`v0.1.0` is published and is the sole release; the old `v0.1.0`/`v0.1.1` releases and
tags are gone and no repository history was rewritten.

**Release-blocking bug found and fixed.** The "Verify executable identity" step in
`.github/workflows/embedded-elpis-linux.yml` pinned the literal string `elpis 0.1.1`
while `tui/Cargo.toml` was `0.1.0`. The next tag build would have failed that assertion
and published nothing, silently. The step now reads the expected version from the
manifest.

## Structured interactive clarification — closed 2026-07-26

Closed by Masih after trying the unhidden inherited Plan mode: "it's not what I wanted,
but it's not a high priority at the moment; `/plan` works for now." What shipped instead
was inherited Plan mode, unhidden — 196 references across 28 files in `core/` and `tui/`,
a 1,698-line test file at `tui/src/chatwidget/tests/plan_mode.rs`, a
`plan_mode_reasoning_effort` config knob, and a streaming state machine in
`core/src/session/turn.rs`. It was hidden only by `is_visible`.

## Automatic project `VISION.md` — done 2026-07-27

Closed at the prompt layer rather than as an Elpis feature: the behavior lives as an
always-on `## Vision` rule in the dev skill's `AGENTS.md`, alongside the `vision` skill.

## Analytics subtraction — finished 2026-07-26

The crate and its upload path went earlier; the surviving knobs, flags, and generated
schema entries followed, along with a stale second gate that discarded OTEL metrics even
when a user had explicitly configured a metrics exporter. No analytics debt remains. The
pass did not measurably change speed, build time, or package size.

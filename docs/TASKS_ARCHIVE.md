# Task archive — v0.1.0 and v0.1.1

Closed work, moved out of `TASKS.md`. Historical: priorities and "current action" lines here are not current.


Older history: `docs/TASKS_V0_1_ARCHIVE.md`.

---

## Docs condensed to one source per topic — Masih-verified 2026-07-27

`CONTEXT_AND_SESSIONS.md` and `visual-walkthrough.md` deleted, `GUIDE.md` and
`SECURITY.md` moved under `docs/`, GUIDE's stale provider tables folded into
`providers.md`, every reference repaired. `docs/` now holds one file per topic plus two
task archives and the build/shipping rules.

Evidence: `65bac2f`, `6058a0f`.

## Context Ledger placement and file links — verified 2026-07-25

`v0.1.1` was first tagged on 2026-07-24, but its tag CI run failed and no release was
published. It was retagged and published on 2026-07-25 — then, on Masih's instruction,
that history was collapsed and its content republished as `v0.1.0` instead, so only one
release/tag exists now. GitHub currently shows `v0.1.0` alone as the only tag and release.

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

## Update progress feedback — verified 2026-07-29

`elpis --update` now shows a progress bar while it downloads the release instead of
appearing stalled. Implemented in `61f4af9`; Masih verified the behavior locally.

---

only. See `../TASKS.md` for current work.

This is the project task source of truth. A feature is complete only after its stated
behavior is implemented and verified; vision documents describe intended behavior but must
not claim unfinished behavior is available.

Version map: **Foundational = v0.1** (publish gate), **Important = v0.2**,
**Nice-to-have = v0.3+**. An item ships in v0.1 only if it is listed under Foundational.

## Foundational — required for the first release (v0.1)

### F1. Clean canonical repository — complete

- Restored the required RAG proxy helper.
- Removed the obsolete `VectorIndex`, unused notebook splitting functions,
  `/test-approval`, `/exit`, and dead tooltip data.
- Proof: clean canonical `main`, focused Python checks, and remote Rust checks.

### F2. Internal RAG — complete

- `/rag <query>` and `/rag <path> -- <query>` exist.
- The MCP advertises one read-only RAG tool, allowing concurrent scheduling beside exact
  read-only exploration.
- Workspace and explicit-path queries return sourced chunks.
- Proof: visible workspace, explicit-path, and autonomous examples.

### F3. Context and session continuity — implemented; acceptance pending

- `GOAL.md` mirrors the active workspace goal and `ES.md` records the latest compact result,
  changed paths, command outcomes, and exact provider-transcript pointer.
- Fresh threads admit the portable goal/checkpoint; exact resume retains the native thread.
- Elpis syncs portable continuity before compaction and stops when that safety write fails.
- `/usage` reports admitted rules, goal, checkpoint, and memory summary with size, lifetime,
  and reason.
- Remote verification: the focused continuity tests and Linux build passed in run
  `29534784054`.
- Remaining acceptance: resume one real task exactly and one leanly without replaying
  irrelevant work; verify `/usage` against the actual next model request.
- The tool-output cleaner is lifecycle-aware (`core/src/context_cleaner.rs`): older outputs
  over 1,200 characters are reduced to bounded head/tail excerpts with a durable
  `rollout://tool-call/<id>` evidence pointer, the two newest outputs stay intact, evictions
  surface in `/usage`, and focused tests cover the behavior.
- Remaining cleaner gap: the retained excerpt is positional (head/tail), not a semantic
  conclusion of the output.
- Cleaner visibility gap (Masih, 2026-07-19: "I have not yet seen it work"): the cleaner
  is wired into the live request path (`client.rs` calls `clean_transient_tool_outputs`),
  but nothing in the TUI ever demonstrates it. Acceptance: a session with a long tool
  output must show the eviction in `/usage` and the user must be able to see the receipt
  replacing the raw output. Until a user can watch it happen, it does not count as done.
  Masih's concrete ask: a per-turn "context saved" metric — how many bytes/tokens the
  cleaner removed from the next request — visible as a number and bar in the header,
  ledger, or `/context`, so a user can watch context go *down*, not only up.

### F4. Durable memory — implemented; end-to-end acceptance pending

- Elpis-owned memory artifacts and database state live under `~/.elpis`.
- Implemented and remotely verified: recall-context tracking, promotion after three recalls
  across two contexts, age-aware diverse retrieval, semantic fallback, provenance, and hard
  30,000/10,000-character durable-memory/summary limits.
- Weak one-off memories remain searchable evidence instead of entering `MEMORY.md`.
- Review/delete remains file-based; reset-all clears Elpis memory without deleting Codex
  threads or state.
- Build-cycle branch: deleted/faded lines are archived before baseline reset, archive write
  failures stop the reset, and a focused archive regression is included.
- Remaining acceptance: teach a fact, recall it with provenance in a related new session,
  omit it from an unrelated session, review/delete it, and verify reset behavior locally.

### F5. First-release provider and authentication boundary — partial

- OpenAI subscription authentication remains the default Codex-backed path.
- OpenRouter is separately keyed through `OPENROUTER_API_KEY`.
- Launcher/configuration tests cover OpenAI, OpenRouter, Bedrock, Ollama, and LM Studio IDs.
- `--provider claude`, `gemini`, and `gemini-flash` select OpenRouter family aliases; the
  native adapters are the separate `anthropic` and `google-gemini` providers.
- Native Anthropic Messages and Google Gemini generateContent wire APIs are implemented
  (PR #46) with request translation, SSE streaming, and mock-server tests in
  `core/src/chat_completions.rs`; live vendor acceptance is pending.
- Remaining first-release acceptance: complete and resume one task through OpenAI and
  OpenRouter, proving Elpis-owned goal, context, memory, permissions, and evidence survive.
- The `/model` surface now uses the Elpis `Choose a mind` naming and shows provider,
  protocol, route, and credential labels.
- Mid-session provider switching is implemented at the protocol and TUI settings layers:
  `ThreadSettingsUpdateParams` carries `model_provider` alongside `model` (commit
  `5ffd4ca`). Live authenticated acceptance remains unrecorded.

### F6. Release readiness and build cycle — tagged; acceptance evidence incomplete

- The binary reports `0.1.0`.
- `v0.1.0` is tagged at `7dce07c`.
- Run `29534784054` passed and uploaded the verified Linux x86_64 artifact.
- Tagged builds publish a checksummed release asset; the installer verifies and atomically
  installs it.
- The pre-optimization verified run took about 21 minutes and produced a 102,988,260-byte
  artifact.
- Build-cycle branch removes CI source mutation and status-file commits, enables incremental
  cross-commit cache reuse, keeps focused checks on ordinary changes, moves exhaustive
  inherited regression to nightly/manual/tag runs, and uploads Cargo timing evidence.
- Remaining evidence: compare the optimized runtime to the baseline and record a clean-environment
  install, authentication, launch, and first-task acceptance for the tagged artifact.

### F7. Distinctive Elpis UI/UX — design complete; implementation partial

- Implemented: Elpis naming, the mature inherited Ratatui interaction model, a persistent
  cyan identity header (model, context-used percent, location — commit `49cd113`,
  superseding the earlier amber design), suppression of the conflicting inherited footer
  status line, the Context Ledger with per-file `skills/dev` rows, and the `Choose a mind`
  `/model` naming (commit `bae7108`).
- Not yet implemented: the signature continuity event (only a generic eviction notice
  exists, now naming what survived — commit `de4ed6f`, `"Survived: goal, checkpoint, and
  admitted rules (see /usage)."` — but not distinguishing resume/compaction/provider-change
  events), the evidence-first completion hierarchy, and a render-verified
  context-accounting consistency check. GUIDE.md's UI Identity section is a contract, not
  proof.
- Proof required: a new user watches a task cross compaction or provider change and can state
  what survived, what expired, which runtime acted, and where evidence lives.
- Known bug, fixed 2026-07-18: `continuity_sources()` built the dev-skills path from a
  directory name (`skills-i-use`) that no longer existed on disk, so `/skills` fell back to
  built-in skills instead of Masih's own, and the Context Ledger showed only global sources.
  Root cause was a stale path string, not a ledger rendering bug.
- Ledger dev-skills rows: `skills/dev/*.md` files are now enumerated dynamically as
  individual, independently toggleable rows admitted by default (commit `2f85ce3`, with a
  focused regression in `core/src/elpis_context.rs`). Remote verification is in progress;
  not accepted until the CI run passes and a terminal render check confirms the rows.
- Context Ledger prototype-parity slice is implemented in PR #55: real admitted sources are
  grouped as files/memory/instructions/evidence, row/section/total counts are explicitly
  estimated tokens, `g i`/`g e` toggle all selectable rows, and `w` shows the selected
  source's inclusion reason. CI run `29682921080` passed; installed terminal render
  acceptance remains pending.

### F8. Claude Code as a selectable runtime (R11) — removed 2026-07-20

- Confirmed by Masih 2026-07-18, reversed by Masih 2026-07-20: every turn spawned a fresh
  `claude` CLI subprocess (no persistent session by design), which is structurally slower
  than a native model call, with no available fix short of abandoning the
  subscription-based CLI approach entirely. Rather than ship or keep maintaining a
  feature with a known speed ceiling, it was removed rather than kept in a
  known-degraded state.
- Removed entirely: the `codex-rs/claude-bridge` crate (the `--print`/`stream-json`
  subprocess bridge), the `/claude-code` command, the takeover mode that suspended the
  Elpis TUI to run the real `claude` CLI in-terminal, the `ActiveRuntime`/`RuntimeSelection`
  enums and every switch/picker/status-line surface built around them, and the
  Claude-runtime-specific "ace" distillation path from PR #63 (fresh-per-turn `claude -p`
  calls + haiku outcome-record distillation), which lived entirely inside the deleted
  crate. The Codex-runtime "ace" (Layer 1 reasoning strip + Layer 2 `gpt-5.6-terra` prune
  pass, PR #93 — see gate item 1) is unaffected; it never depended on claude-bridge.
- The native Anthropic Messages API adapter (`--provider anthropic`, F5) is untouched and
  remains the supported way to run Claude models in Elpis — this removal is scoped to the
  CLI-subprocess runtime bridge only, not Claude model access in general.
- `external-agent-migration`/`/import` (reading a Claude Code installation's config,
  CLAUDE.md, and recent chats to bootstrap Elpis) is a separate, unrelated feature and was
  not touched.

## Reduction campaign

- Completed process subtraction: remove broad inherited regression from every ordinary push,
  remove CI auto-formatting, and remove the self-mutating build-status commit.
- Bounded code subtraction: the issue #32 removal of the inert `debug-m-drop` and
  `debug-m-update` placeholders was recovered from the unmerged `agent/product-integration`
  branch and cherry-picked onto `agent/context-ledger-ui` (PR #49 closed as superseded);
  lands with that branch after CI passes.
- Measured candidates are recorded in `docs/BUILD_AND_REDUCTION_AUDIT.md`.
- New 2026-07-19: the installed binary is 356,440,368 bytes versus the 102,988,260-byte
  stripped baseline artifact — a 3.5× size regression despite `file` reporting it
  stripped. Root cause found 2026-07-20 (PR #94, Jules): CI's "Build Elpis binary" step
  built and shipped `target/debug/elpis`, not `target/release/elpis` — the profile edits
  above (`lto`, `codegen-units`, `strip`) were never actually applied to the shipped
  artifact. PR #94 switches CI to `--release`, sets `opt-level = "z"`, `codegen-units = 1`,
  `lto = true`, `strip = "symbols"`, and removes the unreachable `v8-poc` Bazel-only POC
  crate (no in-tree references outside its own directory). Its first CI run failed on a
  duplicate `--release --release` flag in the build step (fixed 2026-07-20, commit
  `2b2b210` on the same branch); rerun pending before merge.
- Do not delete arbitrary workspace crates: first prove they are reachable from the Elpis
  binary and optional under the product requirements.

## Important — after the first-release foundation (v0.2)

- Interactive clarifying questions: before ambiguous or costly work, Elpis presents a
  structured selectable prompt (question, options, multi-select) instead of silently
  assuming, and records the chosen answer in the session evidence. Not the same as the
  Plan-mode nudge (`should_show_plan_mode_nudge`, `tui/src/chatwidget/settings.rs`) —
  that's a passive footer hint suggesting Plan mode when the draft contains a plan
  keyword; it has no options UI and records nothing. Confirmed 2026-07-23 this is
  genuinely unbuilt.
- Add providers: additional adapters via proven Pi/OpenClaw patterns, plus the full
  OpenRouter model catalog — (near-)all models it exposes — including current GPT, Claude
  (Sonnet/Opus/Fable-family), and Gemini IDs — via the OpenRouter models API rather than
  a hand-picked, hardcoded subset that goes stale as vendors update. Pi already implements
  this pattern (and also supports Gemini directly); fetch its repo for reference before
  building. OpenClaw noted as another reference/target. Deliberately deferred — backlog is
  already long.
- `/talk`: optional voice dictation (STT) command — free cloud Whisper if available, else
  document the local workaround (Masih's own `vc` terminal alias). Strictly opt-in, never
  a required step in any flow; Codex's own docs mention a speak/voice feature but it isn't
  actually present in the inherited codebase to build on.
- Further Codex subtraction, one measured capability at a time.
- LSP-backed code intelligence for the active runtime: real language-server queries
  (go-to-definition, precise references, live diagnostics) instead of grep/text search.
  No confirmed LSP client exists in any runtime currently bridged into Elpis; scope as its
  own investigation before committing.
- `/context` command (Masih, 2026-07-22; reference: another CLI's context screen): a
  dedicated slash command rendering context usage as a colored dot/square grid by category
  (user messages, agent responses, tool calls, system prompt, system tools, skills,
  subagents, free space) with per-category token counts and percentages, a Checkpoints
  section (`/rewind`, active checkpoint + step range, historical checkpoints summarized),
  an Artifact files section (`/artifact`, path + token count), and a System files
  (auto-loaded) section. Replaces the old Context Ledger unit-labeling/parity backlog
  (dropped 2026-07-22) as the concrete spec for surfacing context accounting.
- Startup speed: audit the elpis launch path (config, sqlite, auth, MCP host) for work
  that blocks the first frame, using the audit method in
  `docs/BUILD_AND_REDUCTION_AUDIT.md`; the binary must feel faster than a Node CLI or
  the Rust choice is being wasted. Related: the 3.5× size regression above.

## Nice-to-have (v0.3+)

- `/auto` routing with a visible choice, reason, and manual override. A proposed shape:
  classify by complexity and route easy edits/summaries to a low-cost fast model, medium
  work to a mid-tier model, and architectural/multi-file work to a frontier model.
- Scheduled memory review or dreaming-style reports.
- Rich themes and animation beyond the first coherent cyan identity.
- Elpis Family Tree: a hierarchical multi-agent framework where a coordinator runtime
  delegates scoped sub-tasks to worker runtimes in parallel worktrees/branches, with a
  code-level token/cost harness to bound runaway loops.
- Messaging adapters (Telegram/Discord) using OpenClaw/Pi connection patterns, so Elpis can
  run as a daemon connected to channels.
- ~~A `/elpis` poetry easter egg~~ — removed 2026-07-21 (Masih: "not what I ordered").
- Claude Code UX parity, phase 2: managing running agents from the keyboard (Claude
  Code's left-arrow agent panel), mid-turn message queuing, mobile remote control of a
  session, and opt-in telemetry. Large, multi-slice work; explicitly not v0.1/v0.2.

## Current Action — post-v0.1 reconciliation (updated 2026-07-23)

`v0.1.0` was tagged at `7dce07c`; the 2026-07-20 gate snapshot below predates that tag.
It remains a record of the then-unresolved live acceptance evidence, not the current
implementation priority. No post-v0.1 implementation action is assigned here; set one
explicitly before starting new feature work.

### Historical v0.1 gate snapshot (2026-07-20)

Done today: takeover mode merged and tmux-verified (PR #56, main `e01e2a3`); terra PR #54
and sol's grouped-ledger/picker branch merged; fresh binary from run `29689905487`
installed. Masih's live review of that build produced the list below. At that time, the
release was not to tag until every item passed his test.

**Gate status (2026-07-20 evening):** 1 IMPLEMENTED via the Codex-runtime path (PR #93,
see below) — the Claude-runtime path (PR #63) was removed along with the rest of the
Claude Code CLI-bridge runtime (F8, reversed 2026-07-20); CI-gated, not yet e2e-tested
live; 2 MERGED (#87); 3 MERGED (#88); 4 mostly present via the inherited Ratatui
approval-cycle keybinding (Shift+Tab/`BackTab` in `chatwidget/interaction.rs`), open
question on the 4th ("plan") preset — see below; 5 MERGED (#88). #89 (Claude Code
runtime findings) and #92 (TUI ledger-hint placement) merged since, both now partly
moot given the F8 removal. #90/#91 closed 2026-07-20 (redone cleanly against current
main as the F8 removal above, since #91 was built off a stale base missing #89).
#94 (Jules, build-profile + size regression) was open at the time. The next planned steps
were to merge it on green, confirm no other open PRs/stale branches remained, and then run
Masih's live test of 1–6 before tagging `v0.1.0`.

1. **The ace — per-turn context deletion, visible (Fable-owned).** The deterministic
   cleaner is wired but invisible and positional. Required for v1: the agent-authored
   per-turn prune of the next request, plus the "context saved" metric and bar so the
   user watches context go *down*. This is the flagship; nothing ships without it.
   **Claude-runtime path (PR #63) — removed 2026-07-20** along with the rest of the
   Claude Code CLI-bridge runtime (see F8): it lived entirely inside the deleted
   `codex-rs/claude-bridge` crate, so nothing else depended on it. The ace is now solely
   the Codex-runtime path below, which never depended on claude-bridge and is unaffected.
   **Codex-runtime path — IMPLEMENTED, PR #93** (`feat: context pruning — the ace, end
   to end`, merged 2026-07-20, main `4b57fa8`): Layer 1 now unconditionally strips
   `ResponseItem::Reasoning` before every request (`context_cleaner::strip_reasoning_items`,
   `client.rs`) — hidden reasoning was previously never stripped at all. Layer 2
   (`core/src/context_pruner.rs`) fires once per turn (`session/context_prune.rs`) when
   uncovered turn-lifetime tool output crosses 10% of the active context window; a
   `gpt-5.6-terra` pass (same model/effort as the existing memory-consolidation stage 2)
   classifies each covered item as a dead end (dropped, no trace) or a finding (kept as
   one evidence-pointer line). `/usage` shows combined Layer 1 + Layer 2 savings: chars,
   % of context window, pass counts. Any failure in the pass (model error, timeout,
   unparseable reply) is swallowed — Layer 1's deterministic receipts remain the fallback,
   nothing about a turn is ever blocked or delayed by it.
   **Bug found and fixed 2026-07-20** (same day as merge): `apply_prune_record` computed
   each item's conclusion line but then discarded it, writing an identical generic
   "covered" receipt for every item regardless of whether it earned a finding — the
   entire judgment the `gpt-5.6-terra` call paid for never reached the next request or
   disk. Fixed in `context_pruner.rs`: the receipt for a covered item now carries its
   actual conclusion line when one exists (`kept=...`), and a plain `dead end` marker
   when it doesn't; a regression test (`apply_prune_record_marks_dead_ends_without_a_conclusion_line`)
   covers the distinction. CI-gated; not yet e2e-tested against a real threshold crossing.
2. **Context Ledger tells the whole truth — MERGED, PR #87.** Real admitted sources
   grouped as files/memory/instructions/evidence, row/section/total counts as estimated
   tokens, `g i`/`g e` toggle-all, `w` shows inclusion reason. Also fixed in #87:
   `build_continuity_prompt` no longer double-sends rule files the server already sends
   natively. Installed terminal render acceptance (matching `design-prototype.png`
   pixel-for-pixel) still wants a live look, but the data/behavior gate is closed.
3. **`/add` accepts directories and drag-and-drop — MERGED, PR #88.** `/add <dir>` admits
   every contained file as its own row (`elpis_context::add_continuity_sources` walks the
   directory; `core/src/elpis_context.rs` tests cover empty-dir rejection and
   admit-every-file). Dropped/pasted paths are accepted the same way.
4. **Keybindings — mostly already present; one gap.** Tab opens the Context Ledger.
   Shift+Tab (`BackTab`) cycles approval presets via the inherited Ratatui
   `cycle_approval_preset` (`codex-utils-approval-presets`), but that cycle only has
   three built-in presets — Read Only, Default ("auto"), Full Access — not four; there is
   no "plan" preset in the cycle. Elpis does have a separate `plan_mode` nudge concept
   (`interaction.rs`: `should_show_plan_mode_nudge`/`dismiss_plan_mode_nudge`), but it is
   not wired into this cycle. Verify with Masih whether the original "four modes
   including plan" ask is satisfied by the 3-preset cycle as-is, or whether plan needs to
   join the Shift+Tab rotation before this item counts as closed.
5. **Welcome screen identity — MERGED, PR #88.** Version + "what's new" lines,
   Claude-Code-style, replacing the Codex-identical startup window.
6. Masih tests the rebuilt binary against 1–5; on his explicit okay, tag `v0.1.0` with
   checksummed release assets. **Status on 2026-07-20: not yet run** — Masih's Claude
   subscription hit its usage limit, deferring the live test a few days; code-level
   review and CI are the interim signal. Then v0.2: Elpis data janitor (`/clean-up` for
   compounded rollouts/archives/evidence), size regression (in flight, PR #94),
   startup speed, distribution (plugin/marketplaces), Claude-parity UX phase 1.

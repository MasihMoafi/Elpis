# Masih's Elpis Outcome Ledger

This file records what Masih asked Elpis to become. It is deliberately separate from
`TASKS.md`, implementation plans, review rounds, and agent-created engineering work.

- Agents may split these outcomes into implementation tasks in `TASKS.md`.
- Agent tasks do not replace, narrow, or silently close an outcome here.
- Only Masih's explicit acceptance changes an outcome to `Accepted`.
- New implementation ideas belong in `TASKS.md`, not here, unless Masih asks for the
  user-visible outcome itself.

## September 22 release-recovery direction

Masih requested continued work toward a stable release candidate, with current
Codex features retaining their quality, speed and functionality and all approved
Elpis features/deletions preserved. Tell Masih when the candidate is ready to test;
no automated check substitutes for that acceptance.

Requested order: fix/stabilize and clean source/documentation; then refreshed README
visuals/features and website posts; then version 3. After version 3, improve the
existing agent dashboard with measured API costs (OpenRouter and other providers),
then the already-documented agentic direction. Record features, changes and cleanup
in the existing task list. Remove unnecessary leftovers that confuse future agents,
without erasing unresolved outcomes or claiming unsupported cost/usage figures.

September 22 follow-up: typing and Enter-to-queue still feel slow; treat both as
open responsiveness defects. Restore browser capability from current Codex rather
than substituting web search. In parallel, compare the user-identified local book
with Elpis/Codex and extract practical lessons; the title/link is still missing.
Lowest priority: improve light mode and offer purple/gray and other palettes while
preserving the existing layout and readable contrast. These are requests, not accepted
or implemented outcomes.

## Requested outcomes

September 12 follow-up: record each newly requested change here; cross-project
requests are indexed in `../TASKS.md` from the repository root. Masih's later
clarification prefers existing TASKS.md files; do not create further request ledgers.

| ID | Masih-requested outcome | Current state | Acceptance belongs to Masih |
| --- | --- | --- | --- |
| U14 | **Working exact-resume command.** `elpis resume 01a0952c-0ff6-7232-9590-4e5c29656c9a` must reopen that existing conversation, not fail argument parsing or start a fresh prompt. Preserve `--resume` compatibility and session history. | Fix `f93c259d` installed in the combined UI build; exact UUID help check passes and installed/build hashes match. All 26 CLI tests pass; [evidence](evals/resume-command-20260912.md). No session history changed. | Masih restarts and resumes the exact conversation successfully. |
| U1 | **A dependable personalized Codex daily driver.** Elpis should first be at least as usable and reliable as current Codex while preserving the working OpenAI subscription model/reasoning picker, authentication, state, and session behavior. | Under acceptance | Use Elpis normally and find no important regression from Codex. |
| U2 | **Codex-equivalent compaction with optional Elpis pruning.** Native compaction should match Codex. Manual `/prune` remains available. Automatic pruning is clearly labelled Experimental, visible in settings, and does not silently become the trusted default. | Under acceptance | Compare long Elpis and Codex sessions; manually accept compaction, `/prune`, and the Experimental control. |
| U3 | **A deliberately tiny, user-chosen skill/context set.** `~/Desktop/p/skills/dev` is the default Elpis development-rule source. Unrelated bundled/installed skills must not flood the Context Ledger. The currently named hand-picked skill choices are `first-principles` and `experiment-workflow`; no additional skill becomes an Elpis default without Masih choosing it. Ledger provenance and token estimates must describe the actual source files. | Under acceptance | Inspect the Ledger and settings; approve the exact final allowlist and verify no unrelated skills are loaded by default. |
| U4 | **Useful in-product observability.** Turn latency/timing and available usage information should be visible inside Elpis and its dashboard without tmux or a second terminal. ChatGPT subscription price is shown as `unavailable`, never invented, and message content is not captured as telemetry. | Under acceptance | Run a real subscription turn and manually inspect Elpis/dashboard values and privacy behavior. |
| U5 | **A genuinely useful, visually strong dashboard.** `/dashboard` should prioritize actionable session/context/agent information, strong UX, and a next-level Elpis-specific visual design—not a cosmetic data dump. | Under visual acceptance | Manually review the rendered dashboard and accept both usefulness and appearance. |
| U6 | **An agent-handling interface and accountable work graph.** `/agent` should open quickly, allow safe ordinary-agent handling, and expose the existing work graph as clearly Experimental and read-only until mutation semantics are trustworthy. Generic swarm complexity is not a goal by itself. | Work graph under acceptance; human controls deferred | Exercise agent navigation/controls and work-graph inspection, including rejection and stale-result cases. |
| U7 | **Understandable manual memory.** Elpis should explain and expose the actual `MEMORY.md` admission model, show truthful status without leaking contents, and let Masih create/admit/withdraw it explicitly. Do not claim an automatic memory pipeline exists. | Under acceptance | Plant a fact, admit/withdraw it, and verify the next real request follows the visible state. |
| U8 | **Elpis's own visual identity.** Functional correctness comes first; then restore and improve the distinctive Elpis look rather than copying Codex. Preserve the liked reddish/black direction and Elpising animation, reconsider the older Ledger colors, and apply strong UI/UX design to the dashboard and core surfaces. | Under visual acceptance | Manually compare the finished TUI/dashboard and approve the Elpis identity. |
| U9 | **Fast, maintainable change and verification cycles.** Small feature changes should not take hours. Reuse upstream mechanisms, keep source slices narrow, and make verification proportional. Never run an all-core/max-frequency local build; use the documented two-job low-priority throttle, or hosted CI only when pushing is separately authorized. | In progress | Make a representative small change and review measured edit/check/build effort plus workstation impact. |
| U10 | **One integrated local candidate, not a premature release.** Audit Elpis worktrees, integrate distinct correct compatible work into local `main`, preserve unrelated/auth/context/memory changes, build and atomically install one optimized `elpis` only after functional issues close, and prove artifact/installed hashes match. Do not push, tag, publish, or call it a release. | Installed; under acceptance | Masih runs the installed candidate and performs the final checklist; only then may it be called verified. |
| U11 | **Side-by-side Codex regression check.** Compare Elpis with current Codex for startup, interaction, Ctrl+C/exit latency, compaction, model/reasoning selection, and other important daily-driver behavior before acceptance. | Planned | Review recorded comparison evidence and personally test the important differences. |
| U12 | **Durable, current documentation.** Keep product behavior, user-requested outcomes, engineering execution, worktree integration, deferred checks, and manual acceptance clearly separated and regularly updated. | In progress | A fresh agent and Masih can each find the current truth without reconstructing it from chat history. |
| U13 | **Plugins are strictly user-added.** Elpis must not install, enable, load, or inject a plugin merely because it is bundled, listed by a marketplace, or enabled upstream. A plugin participates only after Masih explicitly adds or enables it. | Under acceptance | Start from a clean Elpis profile, inspect the plugin and prompt/context surfaces, and verify that only explicitly added plugins participate. |
| U15 | **Sessions named after the task, not raw identifiers.** `/resume` rows should carry a short LLM-generated task name instead of a first-message echo or a bare identifier, and manual names must survive. Sessions worth reviewing for deletion should be marked in `/resume` with an explicit conservative reason; nothing is ever deleted automatically. | Implemented in source at `98584413`/`d421b9be`; not built, not installed, not seen by Masih | Open `/resume` and confirm readable task names, preserved manual names, and visible deletion candidates. |
| U16 | **No raw evidence identifiers in memory prose.** Saved memory must not carry long session/turn identifiers inline; traceability belongs behind a short reference. | Source fix `b5e8d374` widens shortening to legacy damaged identifiers; unit tests pass. Already-saved memory files are NOT backfilled, and a review found live `MEMORY.md` reference numbers mis-attributed by one row from `[2]` onward with `[9]` dangling | Read `MEMORY.md` after a save and find no long identifiers in the prose. |
| U17 | **Exit is immediate.** Pressing exit must stop Elpis at once. Today it lingers. | Located and verified, not implemented: quit runs the whole app-server and core teardown inside the alt screen before the terminal is released (`tui/src/app.rs:1287`, unbounded) through a nested 5s-per-rung timeout ladder; and the invisible continuity save keeps the turn "running" after the visible answer, so the first Ctrl+C is consumed as an interrupt. No exit measurement exists | Press exit during and after a turn and observe an immediate process exit. |
| U18 | **Escape sends a queued message instead of stopping the model.** With one or more messages queued while the model is streaming, Escape must deliver the queued message to the running turn and leave the turn running. Deliberate double-Escape editing and empty-queue interruption must be preserved. | Located and verified, not implemented: Escape falls through to `should_interrupt_running_task` and sends `Op::Interrupt`; the queued text is only pushed back into the composer afterwards. The steer drain already exists in `tui/src/chatwidget/input_flow.rs` | Queue a message mid-stream, press Escape once, and confirm the message is sent and the response continues. |
| U19 | **Escape behavior for `/context`.** Escape does not dismiss the `/context` report. | Located and verified, not implemented: `/context` writes `transcript.active_cell` instead of opening an overlay, so Escape falls to backtrack priming when idle and to interrupting the turn mid-stream. `/usage` already solves this with an overlay whose close keymap has Escape prepended | Open `/context`, press Escape, and accept the resulting behavior. |
| U20 | **Composer line continuation without a forked editor path.** A backslash immediately before the cursor followed by plain Enter must replace the marker with a newline instead of submitting or queueing. Behaviors shared with Codex should reuse Codex's existing mechanisms rather than grow parallel implementations. | Installed in the September 20 candidate through the existing `TextArea` edit path; positive, ordinary-submit/queue, and active-paste cases pass. Not accepted by Masih. | Type `first line\`, press Enter while idle and during an active turn, and confirm the backslash becomes a newline without sending the draft. Confirm pasted text ending in a backslash remains literal. |
| U21 | **Long conversations remain responsive and continuity saves never fail visibly for exceeding their output budget.** Typing, returning focus, and sending one or two queued messages must update promptly even in a long active conversation. Automatic memory consolidation must stay within its persisted character budget, recover from a legacy oversized checkpoint without modifying it before commit, and preserve the previous valid files if a provider still returns an oversized result. Shared TUI behavior should follow Codex. | Installed in the September 20 candidate: the memory schema carries the persisted limits with oversized-input/output safety guards, legacy oversized checkpoints recover without an eager rewrite, and bounded overlapping save ownership now coalesces quietly instead of surfacing `another memory save is already running`. Focused positive/negative evals and the full release verifier pass. Masih accepted the faster Enter-to-queue response on September 20; the remaining behavior is not yet accepted. | Restart Elpis, resume a long conversation, type during an active response, queue two messages, and confirm every keystroke and queue update appears promptly. Complete a turn with memory autosave enabled and confirm neither budget nor concurrent-save warnings appear and the prior files remain valid. |
| U22 | **The context count does not jump to a nearby estimate when Enter sends.** Keep the last provider-authoritative count stable while a request is pending; do not fabricate a zero before the first provider report; update when the provider reports the next usage. | Corrected and installed in the September 20 token-count candidate. Positive/negative core regressions and the full checked release selector pass; Masih's visual acceptance remains open. | Note the Context Ledger count, press Enter, and confirm it stays unchanged while pending and then changes only when the provider usage report arrives. |
| U23 | **Long active output follows the latest row without destroying intentional browsing.** While the normal chat is at the bottom, streamed and finalized output must keep it there. If the user deliberately scrolls up, new output must not yank the viewport away. Shared behavior must match Codex. | A controlled six-turn native VTE comparison passed on Elpis and Codex with terminal scroll-on-output disabled: every unscrolled sample stayed at bottom; both preserved the manually scrolled position. No production scroll change is warranted. | Run a long response from the bottom and confirm the latest output stays visible; scroll up deliberately and confirm the reading position remains fixed until returning to the bottom. |

## 2026-09-20 token-count candidate checkpoint

- Built from local commit `17d0f1fe` with the required two-job thermal guard; the optimized build completed successfully at a measured 79 C peak with one guarded cooling pause.
- Installed atomically as `~/.local/bin/elpis`: version `0.2.0`, 225,699,840 bytes.
- Artifact and installed SHA-256 both equal
  `4b2e49c0fd4f069d6b0f07c32e04777efb5900798ab8bd10b90748de62b9ce8f`.
- The replaced executable and bundled sandbox are retained under
  `~/.local/share/elpis/release-recovery/token-count-20260920/`.
- Already-running clients and local-server processes retain the previous executable; restart is required before user acceptance. Nothing was pushed or published.

## 2026-09-20 long-session candidate checkpoint

- Built from local commit `8ccc7693` with the required two-job thermal guard; the optimized build completed successfully at a measured 77 C peak.
- Installed atomically as `~/.local/bin/elpis`: version `0.2.0`, 225,703,936 bytes.
- Artifact and installed SHA-256 both equal
  `b0f25ccbe400a1f89ea586f7a50d1d7bc25f4fd325ab3b169d054b73ecdc7f62`.
- The previous executable is retained at
  `~/.local/share/elpis/release-recovery/long-session-memory-20260920/elpis-before`.
- The pre-install process remains running on the old executable; restart is required before user acceptance. Nothing was pushed or published.

## 2026-09-20 memory-contention and selection checkpoint

- Routine overlapping memory saves now coalesce after the bounded wait; unrelated save failures
  remain visible.
- Composer, identity/status, and terminal-title motion share an 800 ms burst plus four-second
  redraw-free wait. The final off-screen native-VTE protocol passed 5/5 exact Elpis drags; Codex
  0.155.1 passed the same control 3/3. [Evidence](evals/memory-selection-20260920.md).
- The guarded optimized artifact and atomically installed `~/.local/bin/elpis` share SHA-256
  `49f4ef0cfdb22772e0354823e5b24bd554808e90c41ef6139f28a7b103ff3c0c`.
- Existing sessions retain their older executable; restart is required. Masih's visible acceptance
  remains open, and nothing was pushed or published.

## 2026-09-02 candidate checkpoint

- Built from local `main` commit `f0411a0` with the required two-job, low-priority release command.
- Installed as `~/.local/bin/elpis`: version `0.1.2`, 173,348,960 bytes.
- Artifact and installed SHA-256 both equal
  `99a2f9c0f3938a71c77ac5258d5016965e2972396fb8a4886eeafca03ba946df`.
- Automated evidence is recorded in `~/Desktop/ELPIS_PRESENTATION_BRIEF.md`.
- Masih's visual and live acceptance remains open; this is not a public release.

## Standing boundaries

- Linux is the current platform priority; macOS and Windows are deferred.
- Functional work precedes the visual-identity pass.
- Skills and plugins are opt-in user choices: only the curated skill allowlist and explicitly added
  plugins may participate.
- No local Rust build/test occurs before the functional source issues close.
- Any eventual local Rust verification follows `docs/LOCAL_BUILD_RULES.md`; never use all
  cores or maximum-frequency load.
- No process restart, tmux workflow, push, tag, hosted release, package publication, or
  worktree deletion is implied by these outcomes.
- Automated checks and agent reviews are evidence. Masih alone provides user-visible
  acceptance.

## 2026-09-21 v0.3.0 candidate checkpoint

- Built from local commit `891253ac` under the thermal guard; peak 73 C, no cooling pauses.
- Installed atomically as `~/.local/bin/elpis`: version `0.3.0`, 225,695,744 bytes. Artifact and
  installed SHA-256 both equal
  `37a6a5f5ef71a9b5c1585c91a3314d3845b5bbd44de1f635c1b77de2b3cbe433`.
- The replaced executable is retained at
  `~/.local/share/elpis/release-recovery/motion-update-20260921/elpis-before`.
- Zero compiler warnings on the workspace check, the release test profile, and the shipping
  binaries. Interface 3,271 · engine 2,243 · engine integration 987 · app server 657 · model
  catalogs 157, all passing.
- Whole-workspace survey recorded separately: 152 test binaries, 10,391 passing, 13 failing, every
  failure in a crate no verification surface selects. Eight closed, five open.
- The Elpis and Elpising names animate continuously again at the 3× speed; the composer and the
  approval label stay static, which is how Codex behaves.
- Running clients keep the previous executable; restart is required. Nothing was pushed, tagged, or
  published.

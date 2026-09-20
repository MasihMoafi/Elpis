# Masih's Elpis Outcome Ledger

This file records what Masih asked Elpis to become. It is deliberately separate from
`TASKS.md`, implementation plans, review rounds, and agent-created engineering work.

- Agents may split these outcomes into implementation tasks in `TASKS.md`.
- Agent tasks do not replace, narrow, or silently close an outcome here.
- Only Masih's explicit acceptance changes an outcome to `Accepted`.
- New implementation ideas belong in `TASKS.md`, not here, unless Masih asks for the
  user-visible outcome itself.

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
| U20 | **Composer line continuation without a forked editor path.** A backslash immediately before the cursor followed by plain Enter must replace the marker with a newline instead of submitting or queueing. Behaviors shared with Codex should reuse Codex's existing mechanisms rather than grow parallel implementations. | Implemented in source through the existing `TextArea` edit path; positive, ordinary-submit/queue, and active-paste cases pass. Not installed or accepted by Masih. | Type `first line\`, press Enter while idle and during an active turn, and confirm the backslash becomes a newline without sending the draft. Confirm pasted text ending in a backslash remains literal. |
| U21 | **Long conversations remain responsive and continuity saves never fail visibly for exceeding their output budget.** Typing, returning focus, and sending one or two queued messages must update promptly even in a long active conversation. Automatic memory consolidation must stay within its persisted character budget and preserve the previous valid files if a provider still returns an oversized result. Shared TUI behavior should follow Codex. | Implemented in source: the memory schema now carries the persisted limits with an oversized-output safety guard, and the current Codex focus/terminal-size policy is ported across chat and standalone screens. Focused positive/negative evals pass; not installed or accepted by Masih. | Resume a long conversation, type during an active response, queue two messages, and confirm every keystroke and queue update appears promptly. Complete a turn with memory autosave enabled and confirm no budget warning appears and the prior files remain valid. |

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

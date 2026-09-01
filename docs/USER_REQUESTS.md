# Masih's Elpis Outcome Ledger

This file records what Masih asked Elpis to become. It is deliberately separate from
`TASKS.md`, implementation plans, review rounds, and agent-created engineering work.

- Agents may split these outcomes into implementation tasks in `TASKS.md`.
- Agent tasks do not replace, narrow, or silently close an outcome here.
- Only Masih's explicit acceptance changes an outcome to `Accepted`.
- New implementation ideas belong in `TASKS.md`, not here, unless Masih asks for the
  user-visible outcome itself.

## Requested outcomes

| ID | Masih-requested outcome | Current state | Acceptance belongs to Masih |
| --- | --- | --- | --- |
| U1 | **A dependable personalized Codex daily driver.** Elpis should first be at least as usable and reliable as current Codex while preserving the working OpenAI subscription model/reasoning picker, authentication, state, and session behavior. | In progress | Use Elpis normally and find no important regression from Codex. |
| U2 | **Codex-equivalent compaction with optional Elpis pruning.** Native compaction should match Codex. Manual `/prune` remains available. Automatic pruning is clearly labelled Experimental, visible in settings, and does not silently become the trusted default. | In progress | Compare long Elpis and Codex sessions; manually accept compaction, `/prune`, and the Experimental control. |
| U3 | **A deliberately tiny, user-chosen skill/context set.** `/home/masih/Desktop/p/skills/dev` is the default Elpis development-rule source. Unrelated bundled/installed skills must not flood the Context Ledger. The currently named hand-picked skill choices are `first-principles` and `experiment-workflow`; no additional skill becomes an Elpis default without Masih choosing it. Ledger provenance and token estimates must describe the actual source files. | In progress | Inspect the Ledger and settings; approve the exact final allowlist and verify no unrelated skills are loaded by default. |
| U4 | **Useful in-product observability.** Turn latency/timing and available usage information should be visible inside Elpis and its dashboard without tmux or a second terminal. ChatGPT subscription price is shown as `unavailable`, never invented, and message content is not captured as telemetry. | In progress | Run a real subscription turn and manually inspect Elpis/dashboard values and privacy behavior. |
| U5 | **A genuinely useful, visually strong dashboard.** `/dashboard` should prioritize actionable session/context/agent information, strong UX, and a next-level Elpis-specific visual design—not a cosmetic data dump. | Requested | Manually review the rendered dashboard and accept both usefulness and appearance. |
| U6 | **An agent-handling interface and accountable work graph.** `/agent` should open quickly, allow safe ordinary-agent handling, and expose the existing work graph as clearly Experimental and read-only until mutation semantics are trustworthy. Generic swarm complexity is not a goal by itself. | Planned | Exercise agent navigation/controls and work-graph inspection, including rejection and stale-result cases. |
| U7 | **Understandable manual memory.** Elpis should explain and expose the actual `MEMORY.md` admission model, show truthful status without leaking contents, and let Masih create/admit/withdraw it explicitly. Do not claim an automatic memory pipeline exists. | Planned | Plant a fact, admit/withdraw it, and verify the next real request follows the visible state. |
| U8 | **Elpis's own visual identity.** Functional correctness comes first; then restore and improve the distinctive Elpis look rather than copying Codex. Preserve the liked reddish/black direction and Elpising animation, reconsider the older Ledger colors, and apply strong UI/UX design to the dashboard and core surfaces. | Deferred until functional work closes | Manually compare the finished TUI/dashboard and approve the Elpis identity. |
| U9 | **Fast, maintainable change and verification cycles.** Small feature changes should not take hours. Reuse upstream mechanisms, keep source slices narrow, and make verification proportional. Never run an all-core/max-frequency local build; use the documented two-job low-priority throttle, or hosted CI only when pushing is separately authorized. | In progress | Make a representative small change and review measured edit/check/build effort plus workstation impact. |
| U10 | **One integrated local candidate, not a premature release.** Audit Elpis worktrees, integrate distinct correct compatible work into local `main`, preserve unrelated/auth/context/memory changes, build and atomically install one optimized `elpis` only after functional issues close, and prove artifact/installed hashes match. Do not push, tag, publish, or call it a release. | In progress | Masih runs the installed candidate and performs the final checklist; only then may it be called verified. |
| U11 | **Side-by-side Codex regression check.** Compare Elpis with current Codex for startup, interaction, Ctrl+C/exit latency, compaction, model/reasoning selection, and other important daily-driver behavior before acceptance. | Planned | Review recorded comparison evidence and personally test the important differences. |
| U12 | **Durable, current documentation.** Keep product behavior, user-requested outcomes, engineering execution, worktree integration, deferred checks, and manual acceptance clearly separated and regularly updated. | In progress | A fresh agent and Masih can each find the current truth without reconstructing it from chat history. |
| U13 | **Plugins are strictly user-added.** Elpis must not install, enable, load, or inject a plugin merely because it is bundled, listed by a marketplace, or enabled upstream. A plugin participates only after Masih explicitly adds or enables it. | Requested | Start from a clean Elpis profile, inspect the plugin and prompt/context surfaces, and verify that only explicitly added plugins participate. |

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

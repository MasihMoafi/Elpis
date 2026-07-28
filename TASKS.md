# Elpis Tasks

Live task list. Names, not essays. Detail lives in the task's own notes when it is picked
up, not here. Closed work: `docs/TASKS_ARCHIVE_V0_1_1.md`, `docs/TASKS_V0_1_ARCHIVE.md`.

## How this file works

- **Masih picks the task.** 
- **Type** classifies the work: Docs, Optimization, Feature, Experiment, Bug.
- **Parallel** says whether it can run beside the task above it without touching the same
  files or interfaces. `yes` = safe to run concurrently. `no` = needs the tree to itself.
- Standing rule: defects in shipped behavior outrank everything on this list.
- **Landed** holds work that is implemented and checked in but not yet confirmed by
  Masih. It leaves for the archive only after he verifies it.
- No claim of "done" without Masih's verification. CI and cargo are necessary, never
  sufficient.
- **Verification states are recorded literally, for whoever reads this next:**
  `Masih-verified` (he used it and accepted it), `agent-verified` (an agent ran a check
  and Masih has not confirmed it), and `unverifiable here` (Masih lacks the machine or
  environment to confirm it at all). Never write `agent-verified` work up as done.

## Landed — awaiting Masih's verification

Implemented and checked in; not "done" until Masih confirms the behavior.

| #   | Task                                          | State | Verify by |
| --- | --------------------------------------------- | ----- | --------- |
| 2   | Startup — remove the visible launch wait      | agent-verified | Launch `elpis`; the window should accept a keystroke immediately, with no 2–3s pause after the frame is drawn. Masih, 2026-07-27: "it's not instant." Not accepted. |
| 12  | RTK hook active on a fresh install            | agent-verified; unverifiable here | Needs a machine without RTK: run the install one-liner, launch Elpis, trust the hook it offers, then have the agent run a broad `rg` and check the output arrives RTK-compacted. Masih has no such machine, so this will not become Masih-verified without a clean VM or container. |

Evidence — 2: `be0a78e`, `c54b95d`, `554e666`. `Feature::Apps` now defaults off, removing
the 2–3s remote connector boot that was the entire visible wait; ChatGPT connectors are
opt-in via `apps = true`. Launch is now measured from process creation to the first
accepted keystroke and written per launch under `<elpis_home>/logs/startup/`. Warm
release: 435ms total, 10ms before `main`, ready at 425ms.

Evidence — 12: the installer now installs RTK through its own `install.sh` unless RTK is
already present or `ELPIS_SKIP_RTK=1`, and `codex-rs/tui/src/rtk_hook.rs` writes the
`PreToolUse` hook on a launch that finds `rtk` on `PATH` and no `hooks.json`. Three unit
tests cover written / left alone / no RTK. Verified locally: with `hooks.json` moved
aside, one launch recreated it byte-identical to the known-good hook and `/hooks` showed
`PreToolUse  Installed 1  Active 1`. The first-run trust prompt on a machine that has
never trusted this hook is not yet exercised.

## In flight — on branches, not merged

Each worker prompt lives at `WORKER_PROMPT.md` in its own worktree.

| #   | Task                                      | Branch                     | State |
| --- | ----------------------------------------- | -------------------------- | ----- |
| 5   | macOS build (Apple Silicon)               | `agent/macos-build`        | Built on a `macos-14` runner; one test failed and exposed a real symlink bug, fixed on main and cherry-picked here. CI re-run in progress. Ceiling is CI-proven, user-unverified — nobody has run the TUI on a Mac. |
| 3   | Startup — measurement done                | `agent/startup-size`       | Measured, no code change. See the finding below. |
| 13  | Clean-install check in a container        | `agent/clean-install-check`| Harness and Dockerfile committed **unrun** — the worker hit its session limit mid-run. None of the five assertions has a real result. |

### Finding — task 3, binary size is a dead end

Warm launch is 415 ms, of which the loader contributes 10 ms. Forcing the whole 168 MB
binary back off disk costs 111 ms. `panic = "abort"` (~25 MB) is unsafe because
`catch_unwind` runs during startup; fat LTO was already tried and reverted for ~13 min of
CI; relocation packing could attack at most 30 ms and would raise the glibc floor. Close
the size half.

True cold start is still unmeasured: the `pkexec` page-cache drop was refused by the
permission classifier, so the number above is binary-eviction only — a lower bound.

## First

| #   | Task                                                          | Type         | Parallel |
| --- | ------------------------------------------------------------- | ------------ | -------- |
| 15  | First launch costs ~2.16s, not 415ms — ~1.75s of it is in the final bootstrap phase | Optimization | yes      |
| 13  | Finish the clean-install check — resume from the committed harness | Bug       | yes      |

## Second

Needs Masih at the wheel: 4 and 6 need his direction throughout, 7 needs him only to set
the plan and instructions at the start.

| #   | Task                                                                 | Type     | Parallel |
| --- | -------------------------------------------------------------------- | -------- | -------- |
| 4   | RAG — unreachable from binary installs; hard-imports torch on Ollama | Feature  | yes      |
| 6   | Multi-agents                                                         | Feature  | no       |
| 7   | Endurance run — one long real session, measured                      | Research | yes      |

## Later

| #   | Task                                                        | Type     | Parallel |
| --- | ----------------------------------------------------------- | -------- | -------- |
| 8   | LSP-backed code intelligence                                | Feature  | yes      |
| 9   | `/auto` model routing — test the routing before building it | Research | yes      |
| 10  | Voice input                                                 | Feature  | yes      |
| 11  | `/remote` - Remote messaging, scheduling, mobile control    | Feature  | yes      |
| 14  | Windows build                                               | Platform | yes      |

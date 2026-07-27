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

## Landed — awaiting Masih's verification

Implemented and checked in; not "done" until Masih confirms the behavior.

| #   | Task                                          | Type         | Verify by |
| --- | --------------------------------------------- | ------------ | --------- |
| 1   | Condense `docs/` — one source per topic       | Docs         | Read `readme.md` and the five topic docs; no topic is explained twice, no link is dead. |
| 2   | Startup — remove the visible launch wait      | Optimization | Launch `elpis`; the window should accept a keystroke immediately, with no 2–3s pause after the frame is drawn. |

Evidence — 1: `65bac2f`, `6058a0f`. `CONTEXT_AND_SESSIONS.md` and `visual-walkthrough.md`
deleted, `GUIDE.md` and `SECURITY.md` moved under `docs/`, GUIDE's stale provider tables
folded into `providers.md`, every reference repaired. `docs/` now holds one file per
topic plus two task archives and the build/shipping rules.

Evidence — 2: `be0a78e`, `c54b95d`, `554e666`. `Feature::Apps` now defaults off, removing
the 2–3s remote connector boot that was the entire visible wait; ChatGPT connectors are
opt-in via `apps = true`. Launch is now measured from process creation to the first
accepted keystroke and written per launch under `<elpis_home>/logs/startup/`. Warm
release: 435ms total, 10ms before `main`, ready at 425ms.

## First

| #   | Task                                                          | Type         | Parallel |
| --- | ------------------------------------------------------------- | ------------ | -------- |
| 12  | RTK hook is not active on a fresh install — layer 1 is absent | Bug          | no       |
| 3   | Startup — cold start is still unmeasured; 168 MB binary       | Optimization | yes      |

## Second

| #   | Task                                                                 | Type     | Parallel |
| --- | -------------------------------------------------------------------- | -------- | -------- |
| 4   | RAG — unreachable from binary installs; hard-imports torch on Ollama | Feature  | yes      |
| 5   | macOS build (Apple Silicon) — largest adoption blocker               | Platform | yes      |
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

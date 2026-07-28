# Elpis Tasks

Live task list. Names, not essays. Detail lives in the task's own notes when it is picked
up, not here. Closed work: `docs/TASKS_ARCHIVE_V0_1_1.md`, `docs/TASKS_V0_1_ARCHIVE.md`.

## How this file works

- **Masih picks the task.** 
- **Type** classifies the work: Docs, Optimization, Feature, Experiment, Bug.
- **Parallel** says whether it can run beside the task above it without touching the same
  files or interfaces. `yes` = safe to run concurrently. `no` = needs the tree to itself.
- Standing rule: defects in shipped behavior outrank everything on this list.


## In flight — on branches, not merged

Each worker prompt lives at `WORKER_PROMPT.md` in its own worktree.

| #   | Task                               | Branch                      | State                                                                                                                                                                                                               |
| --- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | macOS build (Apple Silicon)        | `agent/macos-build`         | Built on a `macos-14` runner; one test failed and exposed a real symlink bug, fixed on main and cherry-picked here. CI re-run in progress. Ceiling is CI-proven, user-unverified — nobody has run the TUI on a Mac. |

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

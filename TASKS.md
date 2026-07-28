# Elpis Tasks

Live task list. Names, not essays. Detail lives in the task's own notes when it is picked
up, not here. Closed work: `docs/TASKS_ARCHIVE_V0_1_1.md`, `docs/TASKS_V0_1_ARCHIVE.md`.

## How this file works

- **Masih picks the task.** 
- **Type** classifies the work: Docs, Optimization, Feature, Experiment, Bug.
- **Parallel** says whether it can run beside the task above it without touching the same
  files or interfaces. `yes` = safe to run concurrently. `no` = needs the tree to itself.
- Standing rule: defects in shipped behavior outrank everything on this list.


## On main — awaiting Masih's verification

| #   | Task                                | State                                                                                                                                                                                                          |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | RAG — engine moved out of Elpis     | agent-verified. `38520fc`, `564961e`, `1064497`. Elpis ships no engine and no Python; `/rag` is a client of a registered MCP retrieval server. Test checklist below. |

Task 4 also fixed two live defects. `/rag` never checked that a retrieval server existed —
it told the model to answer from "retrieved chunks" and cite paths with nothing behind it,
so the failure mode was a confident cited answer grounded in nothing. And `/rag -- <query>`
could never reach the path picker: arguments arrive trimmed, so `split_once(" -- ")` missed
and it searched the workspace for the literal string `-- <query>`.

Test checklist for Masih:

- With no retrieval server registered, run `/rag anything` — expect a refusal naming what to
  register, not an answer.
- Register rag-mcp as `rag` in `config.toml`, restart, run `/rag <query>` — expect real
  excerpts with source paths.
- Run `/rag docs -- <query>` — expect the search scoped to that folder.
- Run `/rag -- <query>` — expect a path picker prefilled with the working directory, and
  Enter to search it.
- Confirm a fresh binary install pulls no PyTorch.

## Second

Needs Masih at the wheel: 6 needs his direction throughout, 7 needs him only to set
the plan and instructions at the start.

| #   | Task                                                                 | Type     | Parallel |
| --- | -------------------------------------------------------------------- | -------- | -------- |
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

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

| #   | Task                              | State                                                                                                                                                                                        |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | RAG — removed from Elpis entirely | agent-verified. `38520fc`, `564961e`, `1064497`, `306a4a3`. No engine, no Python, no `/rag`. Retrieval is an MCP server the user registers. Evals moved to rag-mcp `dac6f86`. |

Retrieval left in two steps. First the engine: a bundled Python sidecar pinning PyTorch,
which is why `/rag` could never reach a binary install — you cannot put 2.5GB in a release
artifact. Then the command itself, since MCP already covers registering a tool and calling
it, and a dedicated command implied Elpis owned a capability it does not.

Two live defects were found and fixed on the way, both now moot but worth recording.
`/rag` never checked that a server existed, so it asked the model to cite "retrieved chunks"
that were never retrieved — a confident cited answer grounded in nothing. And
`/rag -- <query>` could never reach its path picker: arguments arrive trimmed, so the split
never matched and it searched for the literal string `-- <query>`.

Known loss: `/rag <path> -- <query>` scoped a search to a folder in one keystroke. That now
depends on naming the folder in plain language and the model passing `doc_path` through.

Test checklist for Masih:

- `/rag` no longer appears in the slash-command popup.
- Register rag-mcp in `config.toml`, restart, run `/mcp` — expect it listed and connected.
- Ask for something in plain language that needs retrieval — expect the agent to call
  `query_knowledge_base` and cite source paths.
- Ask with a folder named — expect the search scoped to it.
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

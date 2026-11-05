# Elpis terminal requirements

The required behaviors of the terminal app (`elpis`), numbered 1–43 without gaps; refer to one as "TUI item N". The desktop app has its own list in [SPEC.md](../apps/elpis-desktop/SPEC.md). In parentheses: the source (a [GUIDE](GUIDE.md#confirmed-requirements) requirement R*n*, a dated request in `REQUESTS.md`, or a feature ID from the local `verify-elpis-tui` skill, which also says how to check each item). Requests dated before 1 November come from the old ledger, which Masih has not yet confirmed. Mechanics live in the linked docs, not here.

## Foundation

1. Shared terminal behavior and layout follow Codex; Elpis keeps only its own controls and per-agent model labels. A difference from Codex in shared behavior is a defect. (Product scope decisions in [GUIDE](GUIDE.md#product-scope-decisions); request 9 Oct)
2. Elpis owns the interface, provider and runtime selection, context projection, durable memory, continuity, behavioral policy, permissions and evidence; the selected runtime may own its model loop and native tools. Authentication alone never selects a runtime. (R1; [runtime architecture](GUIDE.md#runtime-architecture))
3. Commands and file changes follow explicit permission and sandbox policies, and the interface keeps changed paths, diffs, command status, failures and verification evidence visible. (R2)
4. Add no slash command unless Masih selects it. (Product scope decisions in [GUIDE](GUIDE.md#product-scope-decisions))
5. Semantic search and voice come from external programs over MCP; the repository takes no machine-learning dependency for them. (R8)
6. Exit stops Elpis at once, during or after a turn. (request 15 Sep)
7. Elpis never refuses to start because of proxy settings alone, and leftover idle bridges never block a terminal. (request 1 Nov)
8. The terminal app and the desktop app each offer the other: open it, or download it. (request 3 Nov)

## Context Ledger

9. The Ledger shows at startup beside the conversation without taking focus, and hides below 80 columns. (ledger-default, ledger-narrow; [context.md §4](context.md#4-context-ledger-and-admission))
10. Tab, Alt+C or Ctrl+X focus it; the same key or Esc closes it and leaves the draft untouched. Alt+C and Ctrl+X never conflict with other bindings. (ledger-focus, ledger-close; request 10 Oct)
11. Space or Enter flips one row and saves the choice per workspace; `i` admits every admissible row or excludes all; `w` shows why a row is included. (ledger-row, ledger-bulk, ledger-why)
12. `p` flips Smart Prune, `s` flips subagents and `m` picks the pruning model, each saved to `config.toml`. (ledger-switches)
13. The headline shows the measured context use after a turn, and keeps the last provider count while a request is pending instead of showing zero. (ledger-usage; request 20 Sep)
14. Development rules come only from configured roots, and the Ledger shows their real sources and token estimates. (request 29 Oct; [context.md §4](context.md#development-rules-and-skills))

## Instructions and workspace context

15. Global and project AGENTS.md files are Ledger rows and reach the model only while admitted; both start admitted until the person excludes them, and one switch covers every row of the same name. (R6; agents-listed, agents-admit, agents-withdraw; [context.md §4](context.md#4-context-ledger-and-admission))
16. An admission survives a restart in the same folder; another folder starts with its own rows excluded. (agents-admit-kept, agents-per-folder)
17. Admitted sources reach the model as one `Elpis Admitted Context` section, and the section is absent when nothing is admitted. (ctx-empty; [context.md §1](context.md#1-admission-requirements))
18. `/add <path>` adds an admitted user-file row; deleting the row removes its admission, never the file. (ctx-add)
19. Development rules start admitted; Space excludes one from the next request. (ctx-dev-default)
20. Ordinary and bundled skills stay off until configured, and plugins stay inactive until the person adds or enables them. (request 2 Sep; [context.md §4](context.md#development-rules-and-skills))

## Memory and checkpoints

21. `c` on the MEMORY.md row creates the file without admitting it; Space admits it, capped at 8,000 characters. The interface explains manual admission without showing the file's contents. (R5; ctx-memory-create, ctx-memory-admit; request 2 Sep)
22. Each finished turn writes the thread's `ES.md`; a failed write still completes the turn and says why. (R4; ctx-checkpoint; [sessions.md §4](sessions.md#4-failure-behavior))
23. Memory is searchable, attributable, reviewable, deletable and bounded; long session IDs stay out of memory prose. (R5; request 15 Sep; [context.md §3](context.md#3-memory-and-checkpoints))
24. Saving memory keeps the previous valid files when a save fails, and checkpoints stay within budget in long chats. (request 20 Sep)

## Context control

25. `/compact` matches Codex compaction; `/compact N` saves a pressure threshold. (request 24 Sep; [context.md §2](context.md#2-context-control-mechanisms-and-native-compaction))
26. Smart Prune is experimental, optional and off by default, shortens only fresh tool output, never rewrites earlier history, and keeps every original in its audit log. (request 24 Sep; [context.md §2](context.md#2-context-control-mechanisms-and-native-compaction))
27. The model can fetch a pruned original back by call ID. (request 1 Nov)
28. `/context` reports estimated window use; Esc dismisses it without interrupting a running turn. (request 15 Sep; [context.md §4](context.md#context-accounting))

## Sessions

29. A session gets a generated title from its first message unless it already has a name; `/rename` saves a manual name. (session-title, session-rename)
30. `/new` starts a separate thread and keeps the old one saved. (session-new)
31. `/resume` lists sessions by title with Active and Archived filters, opens one with its history, and is fast. (session-resume-picker; request 10 Oct)
32. `elpis resume --last` or `elpis resume <id>` reopens a session after a restart, and `--resume` stays compatible. (R4; session-resume-cli; request 12 Sep)
33. `/fork` copies the conversation and its name into a new thread. (session-fork)
34. `/archive` and `/del` ask first; delete also removes the session's subagent threads, and a session with a fork cannot be deleted. Nothing is deleted automatically. (session-archive, session-delete; requests 29 Oct and 3 Nov)
35. Exact resume and lean continuation keep their own semantics; Elpis never switches between them on its own. (R4; [sessions.md §1](sessions.md#1-two-continuation-modes))

## Agents

36. Left arrow in an empty composer, or `/agents`, opens the Agent command center: every task on the server, children nested under their parent, with status filters and keyboard actions. (center-open, center-child, center-actions)
37. Enter on a child opens its chat read-only; an unrelated root stays a sibling, never a parent. (center-open-child, center-sibling)
38. The command center's right pane summarizes tool work in plain words, not raw commands. (request 3 Nov)
39. `/subagents` lists the main thread and the session's agent threads. Work graphs stay visibly experimental and read-only. (R12; subagent-picker; request 2 Sep; [WORK_GRAPHS.md](WORK_GRAPHS.md))

## Models, providers and permissions

40. `/model` shows providers, then the provider's models, from one live catalogue shared with the desktop app and refreshed each time the picker opens; the selection is kept and fetch failures are shown. (model-menu; request 1 Nov; [providers.md](providers.md))
41. `/effort` lists the model's levels or takes one inline, saves it as the default, and `s` applies one for this session only; an unknown level changes nothing. Claude promotional credits offer every level, including xhigh and max. (effort-menu, effort-inline, effort-invalid, effort-persist, effort-session; request 1 Nov)
42. Native Anthropic and Claude subscription paths stay explicit, and a native provider is never silently routed through another. (R11; [providers.md](providers.md))
43. Full Access is the default and means no approval prompts; Shift+Tab changes permissions with visible feedback, and the change governs the next tool calls. ([desktop SPEC](../apps/elpis-desktop/SPEC.md#permissions) item 70 covers both apps; [permission baseline](GUIDE.md#permission-baseline); request 10 Oct)

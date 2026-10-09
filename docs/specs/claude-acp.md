# Claude inside Elpis through ACP

Status: working prototype, 2026-10-06 night, awaiting Masih's acceptance. Elpis's Rust code is unchanged; the prototype is `tools/elpis-claude/`.

## Request

Use Claude, on the Pro/Max subscription, inside the Elpis TUI with Claude's own tools, the way Cloudroom shows Claude inside its app.

## Conflict to resolve first

GUIDE R11 says Claude runs only through the native Anthropic API adapter. F8, the Claude Code runtime, was removed on 2026-07-20 because every turn started a fresh `claude -p` process, which was structurally slow (`docs/TASKS_ARCHIVE.md`, F8). This proposal reverses R11 for one reason: ACP keeps one Claude session alive, so per-turn startup disappears.

## Evidence (local spike, `~/Desktop/p/elpis-acp-spike`)

Adapter: `@agentclientprotocol/claude-agent-acp` 0.86.0. It drove the installed `claude` 2.1.285 through `CLAUDE_CODE_EXECUTABLE`, with no API key.

| Check | Result |
| --- | --- |
| Subscription login, no API key | Worked |
| Claude's own tool (Bash `pwd` in `/tmp/acp-probe`) | Ran; reply `/tmp/acp-probe` |
| ACP session, 3 turns | 2.5 s, 2.3 s, 1.8 s per turn; Claude processes stable (none per turn) |
| Old way, fresh `claude -p`, 2 runs | 10.5 s, 7.2 s |
| Events Elpis can show | `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update` |

These are small samples (n=3 and n=2), not a benchmark. The permission request did not fire for `pwd`, probably because of the user's Claude settings; A3 must show it.

## Approach

Elpis becomes an ACP client, using the official Rust crate `agent-client-protocol` 2.2.0. On selection, it starts the adapter and maps:

- message and tool events → TUI cells;
- `session/request_permission` → Elpis approval prompt;
- `usage_update` → `/usage` and `/dashboard`.

Any ACP agent (Gemini CLI, others) would work through the same path.

## What Elpis keeps with Claude

| Feature | With Claude via ACP |
| --- | --- |
| Chat, Claude's tools, tool steps | Yes |
| Approvals | Yes, via ACP permission requests |
| `/usage`, `/dashboard` | Yes, from `usage_update` |
| Context Ledger admission | Partly: admitted items sent as session context; Claude manages its own window |
| Smart Prune | Not natively. Untested option: point the adapter's `claude` at `elpis-claude-proxy`, as `elpis claude` does |
| Codex-only commands | Hidden or disabled for this runtime |

## Acceptance harness (each eval must be shown able to fail)

- **A1 Claude turn:** plant a nonce file, ask Claude to read it, reply contains the nonce. Negative: adapter missing → a clear error, never a silent fallback to another model.
- **A2 Speed:** turns 2 and 3 are under 3 s for a one-line reply, and the Claude process count stays stable. Negative: forcing a per-turn restart makes the count grow.
- **A3 Approvals:** in Ask mode, a Bash write raises the Elpis prompt. Deny → no file. Allow → file exists.
- **A4 Usage:** after one turn, `/usage` shows Claude session numbers. Before any turn, it shows "unavailable".
- **A5 Continuity:** switching from Codex to Claude keeps the goal and the admitted ledger items visible.

## Prototype (built 2026-10-06 night)

`tools/elpis-claude/elpis-claude [elpis options]` starts a small bridge and opens the normal Elpis TUI attached to it (`elpis --remote`). The bridge passes everything to the real Elpis engine (Context Ledger, settings, account, slash commands). Only chat turns go to Claude through ACP.

Setup once: `cd tools/elpis-claude && npm install --omit=optional` (about 64 MB). It uses the installed `claude`.

| Check | Result |
| --- | --- |
| A1 positive: planted nonce read by Claude's Read tool, shown in the Elpis TUI | Pass |
| A1 negative: adapter missing → red "Claude (ACP) error…", no fallback answer | Pass |
| A3 Ask mode (`-a on-request`): Elpis approval prompt; decline → no file | Pass |
| A3 allow → file created | Pass |
| A2 speed | Spike only (~2 s/turn); not re-measured through the TUI |
| A4 `/usage` token usage and context window from Claude | Pass (28.2K used / 1M) |
| A4 `/usage` Claude limits | Fetched (5h 39%, week 57%), but the TUI shows limits only from its own ChatGPT-account read (`tui/src/chatwidget/rate_limits.rs:374`). Needs a small TUI change |
| Elpis instructions | Pass. New engine method `thread/elpisInstructions/read` (developer instructions, Ledger-admitted AGENTS.md, admitted continuity); the bridge appends it to Claude Code's system prompt. e2e: Claude named an Elpis-only developer-instruction word (DEVNONCE-5366) with the new engine and answered NONE with the old one. |
| Context breakdown | Pass. A Claude chat's parts come from Claude's own token counts in its Claude Code transcript (since its last compaction): each request's growth is shared among the inputs added since, a reply's tokens its text and tool calls do not explain are the thinking Claude keeps, and a request after a changed system prompt carries it as system. They hold after Elpis restarts; before, a reopened chat's earlier messages and Claude's thinking were drawn as System instructions (Masih saw 141.2k). Antigravity chats still count text length. Evidence: `context-split.test.mjs`; e2e `context-parts` (tool output 7,977 tokens by Claude's count, 3,473 by the old length estimate, which fails it); live: a chat's Ledger read the same before and after quitting and reopening Elpis. |
| `/model` | Opens "Choose a provider" on the current provider (live check); unit test pending. |
| Selection everywhere | Pass (live, dev build). "Claude subscription — your Claude sign-in" in the provider list; Claude rows lead every provider's list; picking Claude from the OpenAI list kept the thread and provider config; the dashboard Chat card switched Claude Opus → Sonnet with config unchanged. |
| A5 continuity on runtime switch | Pass. GPT-6-Luna got MANGO-62d4, then Claude Opus in the same thread answered MANGO-62d4 (seeded from thread history). Claude got TEAL-3355, then GPT-6-Luna answered TEAL-3355 (Claude turns recorded through `thread/inject_items`). |
| Resume | Pass. Claude-only chat resumed with `elpis resume <id>`: Claude model restored, earlier Claude turns and tool steps shown, Claude remembered ZEBRA-e6a26e (session reloaded through ACP `session/load`). |

Approval mapping: Elpis Full Access keeps the user's Claude settings. Any Ask mode starts Claude without the user's personal settings, so Claude must ask through Elpis.

Known gaps:
- Claude's own slash commands are not exposed (except `/goal` and `/compact`, which Elpis's own commands run).

## Claude runs other-model agents (U26 prototype)

`tools/elpis-claude/elpis-agents-mcp.mjs` is an MCP server (`elpis-agents`) the bridge passes to every Claude and Antigravity session that has subagents on. Tools: `list_models` (every model Elpis offers, grouped by provider, with Elpis's own descriptions and efforts), `delegate` (any model id, on any provider: engine models, `claude/…`, `agy/…`; optional `effort`), `delegate_status`, `delegate_steer`, `delegate_stop`. Started through the bridge (`ELPIS_BRIDGE_URL`), a helper on a Claude or Antigravity model runs through the same bridge. Each helper is a normal Elpis thread titled by its task, `approvalPolicy: never`, `read-only` unless `allow_writes` is true. The bridge records its parent (`_delegations` in the store) and adds `parentThreadId` to it in `thread/list` and `thread/read`, so `/agents` nests it under the chat that started it.

Evidence (2026-10-07): e2e `pick` — Opus called `list_models`, gave the easy task to `gpt-6-luna`, the hard one to `gpt-6-astra` and the Gemini task to `agy/gemini-3.8-flash`; on the old code it guessed models and the Gemini task failed. e2e `helper-parent` — the helper lists under its parent; it failed before the parent link. e2e `delegate` (word.txt) failed with `ACP_BRIDGE_NO_AGENTS=1`.

A helper asks before acting when its chat does: it inherits the chat's approval policy, and its approval requests travel from the delegate tool's connection to the TUI (e2e helper-approval). Writes are opt-in per call. It does not see the parent's conversation, only the task text.

## Automated checks

`node tools/elpis-claude/test/bridge-e2e.mjs [scenario...]` acts as the TUI over the app-server protocol against the real engine and Claude (`E2E_MODEL=claude/haiku` for cheap runs). Each run uses its own bridge store and a stand-in usage endpoint, so it never touches Masih's store or asks Anthropic for limits. All scenarios passed on 2026-10-07; image, delegate and resume-with-broken-session were also shown failing with the feature removed.

### Functional fixes found by using Claude in the Elpis TUI (2026-10-07)

Each fix has an e2e scenario that failed on the bridge before it and passes after it.

| Problem seen | Fix | Scenario |
| --- | --- | --- |
| A message sent mid-reply (Esc on a queued message) stopped Claude ("Model interrupted to submit steer instructions") | `turn/steer` goes to the adapter's `_session/steering`, after any running tool ends (a steer cut a running `sleep` and failed the turn) | steer |
| Tool rows read "Ran Terminal", output in ```` ``` ```` fences, reads "(no output)", edits without diffs | Rows wait for the real command; Bash output from the tool response; reads are Elpis reads; Edit/Write are `fileChange` diffs | tools |
| Claude's task list invisible | ACP `plan` updates become `turn/plan/updated`; Task*/TodoWrite rows hidden | plan |
| Claude limits vanished after quick turns (Anthropic answered HTTP 429) | Limits asked at most once a minute; the last answer is reused | usage |
| Token totals "39 total (0 input …)" for a 32k context | Cache reads/writes count as input | usage |
| `/new` and the next start forgot a Claude model picked as default | The pick lives in the bridge store (`_default`), is reported by `config/read`, and answers `thread/start`/`thread/fork` | default |
| Haiku offered six effort levels; "reasoning max" shown for "default" | Per-model levels and defaults from the adapter, saved in `catalog.json`, refreshed daily in the background (startup reads one model; all 12 take ~46 s) | efforts |
| Esc-Esc edit failed: "thread/revert failed: turn not found" | Rewound Claude turns leave the store; Claude gets a fresh session seeded from the kept history; the engine reverts its own turns from the same point | revert |
| `/review` ran on the engine's own model (OpenRouter, 401) | Review runs as a Claude turn with Elpis's rubric, Markdown findings, the usual banners | review |
| Approval "No, and tell Elpis…" refused one command and Claude carried on | Prompts offer accept / decline / cancel; cancel stops the reply. No "don't ask again": Claude Code would save that rule to the project for good | approval |
| Shift+Tab showed no lasting sign of Plan mode | The idle Elpis tip yields the footer to "Plan mode (shift+tab to cycle)" (TUI test `plan_mode_label_outranks_the_elpis_tip`) | — |
| Chat titles and `/recap` on a Claude chat ran on the engine's model (OpenRouter, 401) | Hidden `temporary-structured-turn` requests on a Claude thread go to a one-off Claude Haiku session with no tools, MCP servers or user settings, told the JSON schema; nothing is recorded. A `/memory-model` set to a non-Claude model still names chats with that model, by choice | structured |
| `/goal` and `thread/queue/add` on a Claude chat made the engine start its own model's turn | `/goal` runs Claude Code's own `/goal` as the chat's next Claude turn; the bridge keeps Elpis's goal record (active, complete, paused). Queued messages run as the next Claude turns | goal, queue |
| `/side` and `/btw` on a Claude chat answered without knowing the chat | A fork of a Claude chat inherits the parent's Claude turns up to the fork point when its Claude session is seeded | side |
| The Ledger's Subagents switch did nothing for Claude: off, Claude still listed Agent, ListAgents and Workflow | The bridge reads the engine's `features.multi_agent` (what the switch writes) each Claude turn. Off: `disallowedTools` Agent, Task, ListAgents, SendMessage, Workflow, RemoteTrigger and no elpis-agents server. A change reloads the session, so the next turn follows it. The bridge logs Claude Code's own tool list each turn | subagents |
| The Ledger's Smart Prune line promised pruning on Claude chats | It says "Does not apply to Claude chats" (TUI test `smart_prune_row_says_it_does_not_apply_to_claude_chats`, unbuilt). The adapter fixes Claude Code's executable for all sessions; `elpis claude` prunes whatever the switch says, opens a browser per process, and reports outside the Ledger | — |
| `/resume` did not list a chat only Claude answered: the engine takes a thread's preview only from its own user-message events, and `thread/list` leaves out threads without one | The bridge adds such chats from its store to `thread/list`, previewed by their first message, at their place in the list's order and page | picker |
| A shell line with an operator read `echo one '&&' echo two`: the TUI splits a command into words and quotes them again | A command that is not plain words goes as `bash -lc '<script>'`, which the TUI shows as the script, as it does Elpis's own | shell |
| Each task-list change drew two identical "Updated Plan" rows | An unchanged list is not sent again | plan |
| Gemini wanted from the Antigravity (Google) sign-in, like Claude | `agy-acp.mjs` wraps the `agy` CLI's NDJSON stream mode as an ACP agent; the bridge serves agents by prefix (`claude/`, `agy/`). Approvals do not apply (agy decides its own permissions in print mode); Full Access and Plan map to agy flags | antigravity |

### Fixes from Masih's review (2026-10-08)

| Problem seen | Fix | Check |
| --- | --- | --- |
| An Antigravity chat crashed Elpis (`context_usage.rs:221`, 4379 vs 3210) | The bridge's context split shrinks its estimates to the reported total (`context-split.mjs`); Elpis logs a disagreeing split instead of panicking | `context-split.test.mjs`, TUI `run_built_categories_tolerate_a_total_that_disagrees` |
| Antigravity showed no account and no usage | The bridge sends agy's `/usage` limits after each turn and records each subscription's account (`elpis-claude/accounts.json`); `/status` names that account in a Claude or Antigravity chat | antigravity; TUI `status_names_the_subscription_account_of_a_bridged_chat` |
| Gemini never asked before acting | agy's PreToolUse hook (`agy-gate.mjs`, in a hooks folder added as a workspace only for Elpis's own agy runs) asks through `session/request_permission` | agy-approval |
| Helpers declined every approval unseen | A helper inherits its chat's approval policy; its requests go to the TUI | helper-approval |
| Claude could not save durable memory | `save_memory` through a hidden `elpis memory-save`, the engine's own guarded save | cli `elpis_memory_save`; e2e memory (temporary ELPIS_HOME) |
| A reopened chat lost its plan | The bridge keeps each chat's latest plan and sends it after `thread/resume` | plan |
| The dashboard's Last answer showed 32k total over 0 input and 0 output | `tokenUsage.last` is the latest request: its parts add up to the context | usage |
| A new Claude chat listed as GPT-6.1-Sol | Start answer, `thread/started` and reads name the Claude model | new-chat-model |
| Helper titles began "Delegated by Claude:" | Titled by their task | helper-parent |
| Test chats cluttered history; an unsaved helper could not be archived | Each e2e run archives its chats; a chat only the bridge knows archives by leaving its records | archive-unsaved |
| Live check after install: `/usage` in a Gemini chat showed the ChatGPT plan's limits | Bridged limits (ids `claude`, `antigravity-*`) are kept when signed in to ChatGPT; a Claude or Antigravity chat shows only its subscription's limits | TUI `usage_card_of_a_bridged_chat_shows_that_subscriptions_limits` |
| Live check after install: Elpis would not start with `FORCE_COLOR` set (Node 26 coloured the port) | The launcher writes the port as plain text | checked with `FORCE_COLOR=1` |

### Second round of Masih's review (2026-10-08)

| Problem seen | Fix | Check |
| --- | --- | --- |
| `/model` listed providers that do not answer here (Anthropic and Gemini API keys, Ollama, LM Studio), in name order | OpenAI, Claude subscription, Antigravity, OpenRouter, in that order; another provider only while a chat runs on it | TUI `the_provider_list_is_openai_claude_antigravity_openrouter`, `a_left_out_provider_is_listed_while_the_chat_runs_on_it` |
| OpenAI's model list also showed Claude and Antigravity models | Each provider lists only its own models | TUI `a_provider_lists_only_its_own_models` |
| Effort could change only by picking the model again | `/effort` lists the current model's levels; `/effort <level>` sets one. An Antigravity model's levels are its ids' `-low`/`-medium`/`-high` | TUI `elpis_effort` |
| No keyboard selection in the composer | Shift+arrows, Ctrl+Shift+Left/Right by word (Alt+Shift in GNOME Terminal, which keeps Ctrl+Shift+arrows for scrolling), Shift+Home/End, Ctrl+A for everything; typing, Backspace, Delete and Ctrl+C act on the selection; a key the keymap config binds keeps its binding. Ctrl+V pastes the clipboard's text when it holds no image | TUI `elpis_composer` selection tests, `inline_ctrl_c_copies_a_keyboard_selection`, `ctrl_v_pastes_clipboard_text_whatever_the_right_click_setting`; live in tmux with the release build |
| The Left arrow showed no agents | A server at a loopback address (the Claude bridge) lists its agents as the local daemon does | TUI `loopback_servers_list_their_agents`; live: ← opens the Agent command center, the dashboard's Agents tab lists the chats |
| `/resume` named no model | Each row names the model the chat last ran on, by the agent center's names | TUI `session_rows_name_their_model`; live |
| Shift+Tab switched Plan mode, not permissions | Shift+Tab cycles Read Only, Default, Approve for me and Full Access through the permission-shortcut flow (v0.3.0); bare `/plan` enters and leaves Plan mode | TUI `shift_tab_cycles_permission_modes_including_full_access`, `bare_plan_command_toggles_plan_mode`; live: `/usage` shows the new mode |
| Codex's permission modes did not reach Claude: Default and Read Only both ran Claude's Manual, Full Access was refused silently (Masih's Claude settings turn Bypass off) | The bridge maps Codex's modes to Claude Code's own: Read Only = Manual, Default = Accept edits, Approve for me = Auto, Full Access = Bypass permissions, Plan = Plan. Full Access never asks, for Claude and Gemini alike (as in Codex, and as Cloudroom does): the bridge answers each of their questions yes, even when Claude's own settings refuse Bypass, Claude Code still asks (its .claude folder) or a Plan turn goes on after its plan. Approving a plan stays the user's, and the approved plan goes on in the chat's permission mode (Bypass, else Auto, for Full Access; Accept edits for Default), not Claude's "manually approve edits". Another mode Claude refuses becomes an Elpis warning naming why. Claude models no longer copy GPT's Fast tier (Claude's Fast bills extra usage), personality or access programs | bridge e2e `claude-modes` (Manual asked and wrote nothing; Accept edits wrote unasked; Auto set; Bypass set), `full-access` (Bypass refused by the project's Claude settings: the question was answered by the bridge, none reached Elpis; it failed before the fix), `plan-full-access` (only the plan was asked, the file was made after it; before, the write asked), `approval` and `agy-approval` (Default still asks) and the speed-tier check; live: Default, Full Access, Read Only in a Claude chat |
| Masih preferred the earlier look after seeing it removed (8 Oct evening) | The Elpis gold, the composer wash and gold sweeps, and the composer box joined to the Ledger are back (745efb19 undoes the look part of c3f60058 and 8b175439); Shift+Tab still cycles the permission modes and the Plan footer says "/plan to leave" | TUI `elpis_look` and the touched snapshots; live in a VTE terminal with the installed build |

Shift+Enter cannot be told from Enter in GNOME Terminal: VTE 0.84 sends `\r` for both (measured with a VTE widget). Alt+Enter or Ctrl+J inserts a new line there; a terminal with the kitty keyboard protocol (Ghostty, kitty) reports Shift+Enter.

Known gaps: Smart Prune does not reach Claude chats (the Ledger says so); Claude Code also reads CLAUDE.md/AGENTS.md itself, so a file excluded in the Ledger can still reach Claude; after rewinding a Claude chat with no later GPT turn, the engine keeps the rewound turns' recorded text, which a later GPT turn in that chat could see.

## Decisions (defaults taken overnight under Masih's "go"; change any)

1. R11: reversed for this ACP runtime, as a prototype.
2. Selection: Claude models appear first in `/model` as "<model> (Claude subscription)" when Elpis is started with `elpis-claude`. Picking one sends turns to Claude with that model and effort; picking any other model returns turns to the Elpis engine. Claude picks are never written to `config.toml`.
3. Adapter: installed once with npm, not bundled.
4. First slice: A1, A3 and A4 token usage. Next: the TUI change for Claude limits, then history and continuity.

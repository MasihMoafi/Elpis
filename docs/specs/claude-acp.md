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
| Context breakdown | Pass. Estimated contextAttribution per Claude turn; the dashboard Context tab shows 5 kinds instead of an empty window. |
| `/model` | Opens "Choose a provider" on the current provider (live check); unit test pending. |
| Selection everywhere | Pass (live, dev build). "Claude subscription — your Claude sign-in" in the provider list; Claude rows lead every provider's list; picking Claude from the OpenAI list kept the thread and provider config; the dashboard Chat card switched Claude Opus → Sonnet with config unchanged. |
| A5 continuity on runtime switch | Pass. GPT-6-Luna got MANGO-62d4, then Claude Opus in the same thread answered MANGO-62d4 (seeded from thread history). Claude got TEAL-3355, then GPT-6-Luna answered TEAL-3355 (Claude turns recorded through `thread/inject_items`). |
| Resume | Pass. Claude-only chat resumed with `elpis resume <id>`: Claude model restored, earlier Claude turns and tool steps shown, Claude remembered ZEBRA-e6a26e (session reloaded through ACP `session/load`). |

Approval mapping: Elpis Full Access keeps the user's Claude settings. Any Ask mode starts Claude without the user's personal settings, so Claude must ask through Elpis.

Known gaps:
- The chat title is still generated by the Elpis engine's model.
- Claude's own slash commands are not exposed.

## Claude runs other-model agents (U26 prototype)

`tools/elpis-claude/elpis-agents-mcp.mjs` is an MCP server the bridge passes to every Claude session (`mcpServers` on ACP `session/new` and `session/load`). Its `delegate` tool starts a normal Elpis thread through `elpis app-server` with the chosen `model` and `provider` (default `openai/gpt-6.1-sol` on the OpenAI sign-in), `approvalPolicy: never`, and a `read-only` sandbox unless `allow_writes` is true. It returns the agent's answer and the commands it ran. The delegated thread is named "Delegated by Claude: …" and stays in Elpis history.

Evidence: a direct call ran `cat nonce.txt` on `gpt-6-luna` and returned LUNA-9924. Through Claude, the e2e `delegate` scenario passed (SOL-3120), and failed with `ACP_BRIDGE_NO_AGENTS=1` (Claude reported no such tool).

Limits: the delegated agent cannot ask for approval (no UI); writes are opt-in per call. It does not see Claude's conversation, only the task text.

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
| `/goal` and `thread/queue/add` on a Claude chat made the engine start its own model's turn | Refused with a chat warning naming the reason; pausing, completing or clearing a goal still passes | goal |
| `/side` and `/btw` on a Claude chat answered without knowing the chat | A fork of a Claude chat inherits the parent's Claude turns up to the fork point when its Claude session is seeded | side |
| The Ledger's Subagents switch did nothing for Claude: off, Claude still listed Agent, ListAgents and Workflow | The bridge reads the engine's `features.multi_agent` (what the switch writes) each Claude turn. Off: `disallowedTools` Agent, Task, ListAgents, SendMessage, Workflow, RemoteTrigger and no elpis-agents server. A change reloads the session, so the next turn follows it. The bridge logs Claude Code's own tool list each turn | subagents |
| The Ledger's Smart Prune line promised pruning on Claude chats | It says "Does not apply to Claude chats" (TUI test `smart_prune_row_says_it_does_not_apply_to_claude_chats`, unbuilt). The adapter fixes Claude Code's executable for all sessions; `elpis claude` prunes whatever the switch says, opens a browser per process, and reports outside the Ledger | — |

Known gaps: Smart Prune does not reach Claude chats (the Ledger says so); Claude Code also reads CLAUDE.md/AGENTS.md itself, so a file excluded in the Ledger can still reach Claude; after rewinding a Claude chat with no later GPT turn, the engine keeps the rewound turns' recorded text, which a later GPT turn in that chat could see.

## Decisions (defaults taken overnight under Masih's "go"; change any)

1. R11: reversed for this ACP runtime, as a prototype.
2. Selection: Claude models appear first in `/model` as "<model> (Claude subscription)" when Elpis is started with `elpis-claude`. Picking one sends turns to Claude with that model and effort; picking any other model returns turns to the Elpis engine. Claude picks are never written to `config.toml`.
3. Adapter: installed once with npm, not bundled.
4. First slice: A1, A3 and A4 token usage. Next: the TUI change for Claude limits, then history and continuity.

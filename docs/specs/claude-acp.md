# Claude inside Elpis through ACP — proposal

Status: proposal for Masih's decision, 2026-10-06. Nothing in Elpis is changed yet.

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

## Decisions for Masih

1. Reverse R11 for an ACP runtime? (Yes/No)
2. How to select it: the existing `/model` picker, or a `--runtime claude` flag. No new slash command unless you choose one.
3. Ship the adapter with Elpis (needs Node; about 64 MB of dependencies) or require a one-time `npm install`.
4. First slice: A1 and A3 only (chat, tools, approvals), then A2, A4, A5.

# SPEC: Trajectory: one page that shows what every agent did, and why each request hit or missed the cache

Status: draft for Masih's review (4 Nov 2026). Nothing is built yet.

## Goal

In one place, you can see what an agent did, step by step: each model request, tool call, compaction and model change, with its time, tokens and cost. You can also see whether each request reused the provider's prompt cache and, when it missed, what broke the cache.

The model is DeepSeek Harness's **Trajectory** view (`~/Desktop/p/ext/deepseek-harness/packages/client/ui-trajectory`) and its cache rules (`packages/core/agent-loop/README.md`, "KV Cache effect"). Elpis adopts what they got right and drops what doesn't fit.

It ships in two forms on the same data:

- **Desktop:** a Trajectory tab beside Chat.
- **Terminal app (TUI):** a Trajectory pane in the agent dashboard.

## What we borrow from DeepSeek Harness, and why

| Their idea | Where in their code | What Elpis takes |
| --- | --- | --- |
| A turn-aware ledger: User, Assistant, Tool, nested sub-calls and compaction rows, grouped by turn and step | `TrajectoryTable.tsx`, `TrajectoryTurn.tsx` | The same ledger, one row per event, folded by turn |
| An Overview timeline above the ledger: real start and duration per record; Assistant bars split into TTFT and decoding; drag a range to filter the ledger; wheel to zoom | `TrajectoryTimeline.tsx` | The same timeline (desktop); a one-line bar per turn (TUI) |
| A record inspector: token usage, duration, Input, Output, Timing, images | `TrajectoryCell.tsx`, `trajectory-record.ts` | The same inspector, plus the cache verdict |
| Disjoint token counts: uncached input, cache read and cache write are separate, and "billed input" is their sum. Adapters that fold cache hits into one prompt total subtract them back out | `docs/subsystems/llm-streaming.md` §"Per-call token accounting" | Elpis's engine reports `input_tokens` *including* `cached_input_tokens` (checked in a real rollout, 4 Nov). The Trajectory shows the three disjoint numbers and never adds cached input twice |
| Every change that touches history says what it does to the cache ("KV Cache effect"): append-only growth keeps the prefix; a replaced system node misses from its first token; a changed system prompt is *appended* after the cached history instead of rewriting message 0 | `packages/core/agent-loop/README.md` | Each request names its first changed token and the change that caused it (see items 6–8) |
| Long histories open at the tail, load older pages on demand, render only visible rows; streaming follows the tail until you scroll up | ui-trajectory README | The same, for both desktop and TUI |
| Compact mode shows only output speed and cache-hit % under the composer | `ui-chat` README §Performance & usage | A small "cache 87% · 42 tok/s" reading under the composer, opening the Trajectory |

Not borrowed: their plugin framework (Cordis), image and attachment previews in the ledger (later), and Python/TypeScript `run_code` highlighting.

## Invariants

- **Read-only.** The Trajectory is a projection of what the engine already records: rollout JSONL lines with `timestamp`, `response_item`, `turn_context` and `token_count`, plus live app-server events. It never changes a chat, its history or the cache.
- **Measured, not estimated.** Times come from recorded timestamps, and tokens from the provider's own usage. A value that wasn't recorded shows "—", never a guess. That includes the TTFT of a stream that hasn't produced a token yet.
- **The cache verdict states its cause.** A miss is attributed only to a recorded change: a different model or provider, a compaction, a Context Ledger change, Smart Prune, reasoning expiry, or a changed tool list. Otherwise it reads "miss, cause not recorded".
- **The same numbers everywhere.** Desktop, TUI and the composer reading compute from one shared function, tested once.
- Elpis's existing cache design (`docs/prompt-caching.md`: stable prefix, `prompt_cache_key` namespaces, cache-write accounting) stays as it is; this spec measures it and makes it visible.

## Constraints

- Desktop: shadcn components and `app/globals.css` tokens; readable in every theme (R-rules in `docs/MASIH-RULES.md`).
- TUI: ratatui, Codex layout parity; the dashboard keeps its existing scope (GUIDE "UI Identity").
- No new network calls and no new dependencies; the data is local.
- 10,000-event chats must open in under 1 s at the tail and scroll at 60 fps, as DeepSeek's virtualised ledger does.

## Items

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 1 | **One record model** shared by desktop and TUI. Each record has: kind (user, assistant request, tool call, sub-call, compaction, model change, Ledger change); start; duration; turn and step; model and provider; and tokens (uncached input, cache read, cache write, output, reasoning). | Unit test over three real rollouts (OpenAI, Claude, a compacted chat): records and token sums equal the rollout's own `token_count` totals | todo |
| 2 | **Desktop Trajectory tab** beside Chat: a ledger folded by turn, opening at the tail and loading older pages on demand | Playwright: a 10,000-event fixture opens at the last turn in < 1 s; scrolling up loads the previous page | todo |
| 3 | **Overview timeline** above the ledger: assistant bars split into TTFT and decoding, tool bars, compaction marks. Dragging a range filters the ledger; the wheel zooms; right-click clears the range | Playwright: dragging over one tool call leaves exactly the records active in that range | todo |
| 4 | **Inspector** for a selected record: input, output, timing (start, TTFT, duration, tokens/s), tokens in the three disjoint parts, and the cache verdict | Playwright: on a fixture request with known usage, the inspector shows its exact numbers | todo |
| 5 | **TUI Trajectory pane** in the agent dashboard: the same ledger as text rows, one timing bar per turn, Enter opens the inspector | tmux run (verify-elpis-tui): the pane lists the fixture's turns with the same numbers as desktop item 4 | todo |
| 6 | **Per-request cache verdict**: hit % = cache read / (uncached input + cache read + cache write) | Unit test: OpenAI-style usage (cached inside input) and Anthropic-style usage (cache read and write separate) give the same verdict for the same request | todo |
| 7 | **Cache-break attribution**: when hit % drops between two requests of one chat, name the recorded change between them (model or provider, compaction, Ledger toggle, prune, reasoning expiry, tool list) | Fixture with one Ledger toggle between requests 3 and 4: request 4 reads "miss from Ledger change: excluded AGENTS.md" | todo |
| 8 | **Audit Elpis's own cache breakers**: measure whether a Ledger toggle, Smart Prune, reasoning expiry or a model switch rewrites earlier history (a miss) or appends after it (a hit). Each one that rewrites gets a fix proposal modelled on DeepSeek's in-history update, for Masih to decide | A short report with one measured row per change (hit % before and after) on a real GPT and a real Claude chat | todo |
| 9 | **Composer reading**: "cache 87% · 42 tok/s" under the composer, opening the Trajectory | Playwright: the reading equals item 6 for the last request; a click opens the Trajectory at that request | todo |
| 10 | **Live chats**: during streaming the ledger follows the tail until you scroll up, and an in-flight request shows its start without an invented duration | Playwright with a held stream: the row has a start marker and "—" for duration until the first token | todo |
| 11 | **Failure**: an unreadable or partial rollout shows what it can and says what is missing; it never blanks the page | Test with a truncated rollout: earlier turns render, plus one note "the rest of this chat could not be read" | todo |
| 12 | **Rollback**: the Trajectory tab and the TUI pane each sit behind a setting, off by default until Masih accepts them | Turning the setting off removes the tab and pane; chats are unchanged (rollout bytes identical) | todo |

## Non-goals

- Cost in dollars; tokens only, until prices per model are recorded reliably.
- Editing, replaying or branching from the Trajectory.
- Workflows' multi-agent board; the Trajectory shows one chat, and a subagent's records nest under the tool call that started it.
- Changing Elpis's cache boundary or `prompt_cache_key` design (item 8 only proposes).

## Stop and ask

- Item 8 finds that a feature Masih uses (Ledger, Smart Prune) breaks the cache on every toggle, and the only fix changes what the model sees.
- A provider reports cache usage in a shape not covered by item 6.
- The 1 s / 60 fps target needs a new dependency.
- Where the TUI pane goes in the dashboard: as a new tab, or replacing a view.

## Plan (order and size)

1. **Record model and cache verdict** (items 1, 6): foundational, medium. A pure module in the bridge, plus a Rust twin for the TUI, both tested on the same fixtures.
2. **Cache audit** (item 8): important, medium. Its findings may change items 7 and 9, so it comes early.
3. **Desktop ledger and inspector** (items 2, 4, 10, 11): foundational, hard.
4. **Timeline** (item 3): important, hard.
5. **Cache-break attribution** (item 7): important, medium.
6. **TUI pane** (item 5): important, medium.
7. **Composer reading, setting and rollback** (items 9, 12): nice-to-have, easy.

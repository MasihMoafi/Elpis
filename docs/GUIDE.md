# Elpis Technical Guide

## Product Thesis

> You put an agent into an Elpis, and it becomes Elpis. Be Elpis, my friend.

Elpis is the environment an agent enters and assimilates into. The selected model or
agent runtime may change, but the user's goals, working style, durable knowledge,
context policy, evidence, and behavioral boundaries continue coherently. Elpis is both
a state and a direction: it is never fully complete, and each verified change should
make the environment clearer, more capable, and easier for its creator to control.

## Purpose

Elpis is a provider-neutral coding-agent TUI. It does not try to make a new foundation
model. It gives agents backed by OpenAI/Codex, Gemini, Claude, or another model one
coherent local interface by managing:

- the instructions and project knowledge admitted into working context;
- the boundary between transient context and durable memory;
- tools, edits, commands, permissions, and their evidence;
- continuity across turns, compaction, and sessions;
- a model-independent TUI where consequential actions remain inspectable.

The intended result is assimilation: whichever model provider is selected, the agent
adopts the user's harness, workspace, memory, and control policy without being buried
under them.

## Product Value

Elpis should create value in five ways:

1. **Assimilation:** a selected runtime adopts the creator's applicable instructions,
   goals, context, memory, and behavioral rules, rather than the user adapting to it.
2. **Context sovereignty:** the user can see and control what enters the agent's
   working set. Selecting a file is an intentional context operation, not decoration.
3. **Reliable continuity:** sessions preserve goals, decisions, changes, and evidence
   across model changes, compaction, and restarts, while disposable logs and stale
   file bodies fall away instead of replaying an ever-growing transcript.
4. **Safe, transparent agency:** edits and commands use explicit sandbox and approval
   contracts. The UI shows what is proposed and records what happened; Elpis does not
   claim success when it has only hidden or documented a gap.
5. **Runtime choice and user ownership:** Elpis keeps one surrounding control
   environment while allowing the model provider and low-level agent runtime to
   change explicitly. Durable state is inspectable, editable, exportable, and not
   tied to one model provider or agent runtime.

Elpis is not primarily a provider switcher, a transcript viewer, or a collection of
slash commands. A command belongs in the product only when the user deliberately
selects it and its behavior has a stable contract.

Elpis is not distinguished by having another terminal chat interface — existing
projects already provide excellent model access, tools, permissions, terminal
rendering, and agent loops, and Elpis reuses those implementations. It is
distinguished by the five values above.

## Desired Output: First Public Release

Ship an installable terminal product, not a repository demo, in which a user can:

1. authenticate and deliberately select a supported model and runtime;
2. see which runtime owns the turn and which capabilities Elpis retains;
3. give the agent a task under Read Only, Default, or Full Access permissions;
4. watch readable commands, output, file changes, diffs, failures, and verification;
5. inspect and control the exact working context admitted by Elpis;
6. resume later from the same goal, decisions, changes, and relevant memory without
   replaying irrelevant history;
7. switch to at least one non-Codex runtime while retaining Elpis-owned continuity;
8. install and complete a first real coding task from a clean environment.

The release is successful only when these behaviors pass their acceptance checks from
a clean checkout and the distinctive context/continuity behavior is visibly better than
using the selected runtime alone.

Not required for the first release: messaging channels, scheduled automation, voice,
or desktop applications; dream narratives or autonomous skill creation; support for
every provider or every upstream Codex/OpenClaw feature; a new implementation where a
proven upstream component can satisfy the contract.

## Proof Standard

A feature is real only when its user-visible acceptance check passes and the evidence
is recorded. Documentation, hidden code, or a plausible architecture is not proof. The
defining evaluation: can a fresh supported runtime enter Elpis, receive the right
current goal and relevant history, obey the creator's rules, perform visible work under
the chosen permission mode, and resume later without irrelevant context? `TASKS.md` is
the current-state record against this standard.

## Requirements

This section preserves confirmed product requirements. A feature is not implemented
until its user-visible behavior is verified; current implementation state lives in
`TASKS.md`, not here, so the two documents do not drift against each other.

### Working Agreement

- Keep required work ahead of speculative features.
- Challenge unnecessary complexity and solution-first requests.
- Record evidence rather than confidence.
- Prefer small, reversible changes and the smallest useful verification.

### Confirmed Requirements

**R1. Provider-neutral Elpis environment** — Elpis owns the TUI, provider/runtime
selection, context projection, durable memory, provider-neutral continuity, behavioral
policy, permissions bridge, and evidence. A selected runtime may own its low-level
model loop and native tools, but authentication must never silently transfer
Elpis-owned state or product identity to that runtime.

**R2. Visible and controlled agency** — Commands and file changes follow explicit
permission and sandbox policies. The interface must preserve changed paths, diffs,
command status, failures, and verification evidence.

**R3. Deliberate context lifecycle** — Elpis must know what the model receives. Rules,
goal, selected files, conversation, tool output, and memory have visible sources,
sizes, reasons, and lifetimes. Stale exploration leaves the next request only after
its conclusion and exact evidence pointer are retained. A length threshold alone is not
a complete context policy.

**R4. Exact and lean continuity** — The active goal, decisions, constraints, changed
files, verification, blockers, and next action survive restarts. Elpis supports exact
native-thread resume and lean continuation from a compact portable checkpoint.

**R5. Curated memory** — Memory stores reusable facts and proven procedures, not
transcripts. Promotion requires repeated useful recall across distinct contexts.
Memory remains searchable, attributable, reviewable, deletable, and bounded. Deleted
or faded facts enter a searchable archive before baseline reset; archive failure must
stop the reset.

**R6. Enforceable creator and project rules** — Applicable `AGENTS.md`, project
requirements, and behavioral rules reach the model and action layer. Hard safety rules
are enforced by code where prompts are insufficient.

**R7. Claims require proof** — Documentation separates implemented behavior, remote
tests, and outstanding user acceptance. Design documents and hidden code are not proof.

**R8. Expensive capabilities are plugged in, not built in** — Elpis ships no retrieval or
speech engine, no model weights, and no `/rag` or `/voice` command. Workspace semantic search
is obtained by registering an MCP server that exposes a retrieval tool. Voice capture and
transcription belong to an external program such as
[Voice Commander](https://github.com/MasihMoafi/Voice-commander), which may expose a
transcription tool through MCP. Exact current-file evidence remains required before editing.
Never add a machine-learning dependency to this repository; engines, models, and their
download size belong to the user who chooses them.

**R9. Proportionate, measured development cycle** — Ordinary changes receive focused
first-release checks. Exhaustive inherited TUI/app-server regression runs nightly,
manually, and for releases unless the change directly touches that surface. CI must not
edit source or create status-only commits. Dependency deletion follows Cargo timing
evidence and product optionality, not crate names.

**R10. Distinctive continuity-first identity** — Elpis uses a cyan visual identity
(superseding an earlier amber design) and visibly separates runtime, model, context,
memory, permissions, and evidence. The [UI Identity](#ui-identity) section below is the
acceptance contract, not proof that every surface it describes already ships.

**R11. Claude Code as a selectable runtime** — Confirmed by Masih 2026-07-18, **reversed
by Masih 2026-07-20**: the CLI-subprocess bridge (`/claude-code`, the `ClaudeCode`
runtime, `codex-rs/claude-bridge`) is inherently slower than a native model — every turn
spawns a fresh `claude` CLI process — and was removed entirely rather than kept in a
known-degraded state. The native Anthropic Messages API adapter (`--provider anthropic`)
is unaffected and remains the supported way to run Claude models in Elpis.

### First-Release Order

1. Keep the canonical repository and verification cycle clean.
2. Preserve accepted internal RAG behavior.
3. Finish memory acceptance, including archive, review, deletion, and reset.
4. Finish exact/lean context and session acceptance; replace the length-only cleaner.
5. Verify authenticated OpenAI and OpenRouter task/resume paths.
6. Implement the persistent identity line and coherent cyan foundation.
7. For every release, install the artifact in a clean environment and complete a real task.

`v0.1.0` is the release tag (re-tagged 2026-07-23 after history cleanup; do not pin its hash in docs). Its remaining acceptance evidence, if any, is
recorded in `TASKS.md`; this order is a release checklist, not a claim that every item
was complete when the tag was made.

### State Layout

- `~/.elpis/context/workspaces/<workspace>/GOAL.md` — active goal.
- `~/.elpis/context/workspaces/<workspace>/ES.md` — compact latest checkpoint.
- `~/.elpis/memories/MEMORY.md` — curated durable memory.
- `~/.elpis/memories/archive.md` — append-only faded/deleted evidence.
- `~/.elpis/state/memories_1.sqlite` — recall, promotion, and consolidation state.
- Provider transcripts and workspace artifacts remain the exact evidence sources.

### Deferred Decisions

- Whether goal changes require explicit confirmation.
- Default threshold for switching from exact to lean continuation.
- Native Anthropic and Google adapter order.
- `/auto`, dreaming reports, voice, rich animation, and scheduled work.

## Source Map

Treat upstream behavior as evidence, not inspiration copied from memory.

### Codex: execution and interface reference

Primary source is the local clone at `~/Desktop/p/codex`, a sibling of this
repository:

- App-server: `~/Desktop/p/codex/codex-rs/app-server`
- App-server protocol: `~/Desktop/p/codex/codex-rs/app-server-protocol`
- Rust TUI: `~/Desktop/p/codex/codex-rs/tui`
- Core agent runtime: `~/Desktop/p/codex/codex-rs/core`

The clone's origin is [openai/codex](https://github.com/openai/codex). Use the remote
only for provenance or an explicitly requested update; do not browse it when the local
clone can answer the question.

Codex is the contained implementation foundation for thread/turn/item semantics,
streaming, file changes, command execution, approvals, sandboxing, `@` interactions,
and TUI ergonomics. The pinned Rust workspace and tests live under `codex-rs/`, with
Apache-2.0 notices preserved. Elpis does not load code from, or require, the separate
Codex clone directory at runtime.

The active foundation strategy is **fork and subtract**: keep the pinned Codex
execution and TUI paths intact, remove unwanted
OpenAI-specific product surfaces in small tested steps, and introduce a provider
subsystem only after the foundation is stable. Do not revive the archived hand-grown
prototype as the active runtime.

### OpenClaw: context and continuity reference

Primary source is the local clone at `~/Desktop/p/openclaw`, a sibling of this
repository. Checked 2026-07-28 at `22950e5a` (source version `2026.7.2`).
Read implementation and tests, not only explanatory documents. The main source areas
are:

- live context pruning: `src/agents/agent-hooks/context-pruning/`;
- pre-compaction memory flush: `src/auto-reply/reply/memory-flush.ts` and
  `agent-runner-memory.ts`;
- guarded compaction: `src/agents/agent-hooks/compaction-safeguard.ts`;
- search and retrieval: `extensions/memory-core/src/memory/`;
- dated notes, long-term promotion, size budgets, and dreaming:
  `extensions/memory-core/src/flush-plan.ts`, `short-term-promotion.ts`,
  `memory-budget.ts`, and `dreaming.ts`.

The upstream project is [openclaw/openclaw](https://github.com/openclaw/openclaw).

OpenClaw's useful memory behavior is a pipeline, not a special Markdown filename:
ephemeral pruning keeps a live turn small; guarded compaction preserves continuity;
pre-compaction flush writes dated append-only notes; hybrid search retrieves only
relevant excerpts; repeated useful recalls may be promoted into bounded long-term
memory. Dreaming is optional scheduled review and promotion on top of that foundation.

Elpis's concrete context-record and session-checkpoint contract lives in
[context.md](context.md) and [sessions.md](sessions.md).

### Other reference sources

Elpis should reuse proven implementations and reserve original work for its
distinctive context, memory, continuity, assimilation, and supervision layer.

| Source | Proven capability to reuse or study | Elpis boundary |
| --- | --- | --- |
| Pi | Small composable TypeScript packages for multi-provider APIs, agent state, TUI, and coding CLI | Study provider-neutral interfaces and extension simplicity; Pi does not supply Codex-level built-in permissions |
| Hermes Agent | Provider choice, TUI, cross-session search, user modeling, skill learning, scheduled work, multiple execution backends | Study the closed learning loop and user-facing memory controls; verify implementation before adopting claims |
| OpenCode | Multi-provider coding product, read-only/build agents, subagents, polished installation and desktop/TUI delivery | Study routing, product packaging, agent modes, and release experience |

No capability should enter `TASKS.md` as implemented merely because an upstream project
has it. It becomes an Elpis feature only after the Elpis acceptance check passes.

### Codex import provenance

Pinned candidate revision: repository `openai/codex`, revision
`2e1607ee2fa8099a233df7437adee5f16a741905`, license Apache-2.0 (`LICENSE` and `NOTICE`
retained under `codex-rs/`). The donor working tree at `~/Desktop/p/codex` has unrelated
local edits; only committed content from the pinned revision was imported, never the
donor's working-tree state.
`codex-rs/ELPIS_UPSTREAM.md` records this provenance. After the imported foundation
passed its authenticated milestone, the superseded root `tui/` prototype was archived on
the `archive/pre-cleanup-20260716` branch and removed from canonical `main`. Crate and
module boundaries remain upstream-shaped so later action-rendering, permission, and
mouse-selection work can stay isolated and keep upstream tests.

### Preserve-first behaviors

Import these proven behaviors with their existing tests before subtracting features:

| Behavior | Principal Codex source |
| --- | --- |
| Permission types and profiles | `protocol/src/protocol.rs`, `protocol/src/models.rs`, `utils/approval-presets/` |
| Patch safety and writable-root checks | `core/src/safety.rs`, `core/src/tools/handlers/apply_patch.rs`, `apply-patch/` |
| Shell lifecycle and running processes | `core/src/tools/handlers/shell.rs`, `core/src/tools/runtimes/shell/`, `exec/` |
| Sandbox enforcement | `core/src/tools/sandboxing.rs`, `sandboxing/`, `linux-sandbox/`, `execpolicy/` |
| Command event rendering | `tui/src/chatwidget/command_lifecycle.rs`, `exec_cell/`, `exec_state.rs` |
| File/patch event rendering | `tui/src/chatwidget/tool_lifecycle.rs`, `history_cell/patches.rs`, `diff_render.rs` |
| Approval interface | `tui/src/chatwidget/permissions_menu.rs`, `permission_popups.rs`, `bottom_pane/approval_overlay.rs` |
| Event routing and replay | `tui/src/chatwidget/protocol.rs`, `replay.rs`, app-server protocol item types |
| Session/thread storage | `rollout/`, `thread-store/`, `state/` |
| OpenAI login and refresh | `login/` and its narrow auth dependencies |
| Provider definitions | `model-provider/`, `model-provider-info/`, `core/src/client.rs` |

All paths above are relative to `codex-rs/`. Codex's provider definition supports the
OpenAI Responses wire format; it is not by itself a native Gemini/Claude abstraction —
see [Providers](#providers) for the adapter layer Elpis adds on top.

### Stable task boundaries

Keep these ownership seams intact when changing shared rendering/permission code:

| Task | Primary files | Preserved contract and tests |
| --- | --- | --- |
| Action rendering | `tui/src/chatwidget/command_lifecycle.rs`, `tool_lifecycle.rs`, `exec_state.rs`, `exec_cell/`, `history_cell/patches.rs`, `diff_render.rs` | Own command/file lifecycle projection and rendered cells. Keep colocated unit tests and `snapshots/` fixtures with any change. Treat `chatwidget/protocol.rs` as the shared event-routing seam. |
| Permissions | `protocol/src/protocol.rs`, `protocol/src/models.rs`, `utils/approval-presets/`, `core/src/safety.rs`, `core/src/tools/sandboxing.rs`, `sandboxing/`, `linux-sandbox/`, `execpolicy/`, `tui/src/app_server_session.rs`, `tui/src/chatwidget/permissions_menu.rs`, `permission_popups.rs`, `bottom_pane/approval_overlay.rs` | Own permission types, preset selection, enforcement, and approval UI. Preserve crate tests plus approval snapshots; do not alter rendering lifecycle files while changing policy. |
| Mouse selection and copy | `tui/src/tui.rs`, `tui/event_stream.rs`, `app/input.rs`, `app/event_dispatch.rs`, `app_event.rs`, `chatwidget.rs` raw-output methods, `history_cell/mod.rs` raw lines, `insert_history.rs` | Codex deliberately skips mouse events and does not enable mouse capture, leaving selection to the terminal. Raw scrollback supplies copy-faithful lines. Preserve `history_cell/tests.rs`, raw-mode chatwidget tests/snapshots, and terminal-mode tests. |

`chatwidget.rs` and `chatwidget/protocol.rs` are shared seams, not general cleanup areas:
rendering owns lifecycle routing, and mouse-selection work owns only raw-output state and
copy-friendly transcript projection. Coordinate before changing either seam. All paths
above are relative to `codex-rs/`.

### Exact permission baseline

Copy Codex's semantics before adding Elpis-specific policy:

- **Read Only:** may read workspace files; edits or internet require approval.
- **Default:** may read/edit within the workspace and run commands; internet or work
  outside the workspace requires approval.
- **Full Access:** no approval prompts; filesystem and internet restrictions are off.

### Migration status

The migration sequence (preserve prototype checkpoint → import pinned workspace →
rename/package as Elpis → subtract cloud/product surfaces → replace branding → introduce
the runtime contract → move Elpis product rules onto the new foundation → add Gemini/
Claude adapters → add the OpenClaw-derived context/session/memory pipeline) is complete
through native provider adapters; the OpenClaw-derived context/session/memory pipeline is
the current foundation work — see [Current State](#current-state).

Open questions not yet approved as requirements:

- which Codex cloud, apps, realtime, and experimental surfaces remain (tracked as
  reduction-campaign candidates in `docs/BUILD_AND_REDUCTION_AUDIT.md`);
- the final visual redesign beyond the shipped cyan identity line and Context Ledger
  (see [UI Identity](#ui-identity)).

Two questions this document previously left open are now answered: Claude/Gemini use
direct native APIs as well as OpenRouter compatibility aliases (see
[Providers](#providers)), and live mid-session provider switching is not yet
implemented — `ThreadSettingsUpdateParams` carries a model override but no provider
field (see `TASKS.md` F5).

## Runtime Architecture

```text
User
  -> Elpis TUI (presentation, selection, approvals, context visibility)
  -> Elpis control layer (runtime choice, context, memory, session mirror, policy)
       -> selected agent runtime
            -> Codex app-server (owns a Codex turn and its native tools/thread)
            -> Elpis embedded runtime (provider-neutral direct model path)
            -> external/ACP runtime (Claude CLI, Gemini CLI, or another harness)
       -> Elpis retrieval services
  -> Workspace + durable Elpis state (~/.elpis)
```

The current `elpis` executable is built from the contained `codex-rs/` foundation. It
uses the existing ChatGPT/Codex authentication and native Codex turn implementation;
it does not launch code from the donor clone or the archived prototype.

Runtime ownership is explicit. When Codex is selected, Codex may own the low-level
model loop, native shell/file tools, native thread, and native compaction. Elpis still
owns the surrounding product: runtime selection, context projection, durable memory,
provider-neutral session mirror, behavioral policy, approvals bridge, and visible TUI.
Selecting another runtime must not silently route through Codex.

Authentication alone must never silently select a runtime; the active model and
runtime owner must be visible.

## Authentication Boundary

Elpis retains Codex/ChatGPT login and may deliberately select the Codex agent runtime.
Authentication and runtime selection are separate decisions. The supported boundary has
three parts:

1. For a status-only authentication check, Elpis uses only the Codex app-server v2
   account RPCs: `account/read`, `account/login/start`, `account/login/cancel`, and the
   `account/login/completed` and `account/updated` notifications. It must not send
   `thread/*`, `turn/*`, file, command, approval, or tool requests through this
   authentication connection.
2. An Elpis-owned direct OpenAI runtime may port the required Rust authentication
   component from the local `codex-login` crate. That component owns browser/device
   login, Codex credential storage compatibility, token refresh, and transient
   bearer-token access for the Elpis-owned model adapter. The token must not be
   rendered, logged, returned to the TUI, or persisted in a second Elpis credential
   store.
3. When the user selects the Codex runtime, Codex app-server may own that low-level
   model loop, native tools, native thread, and native compaction. Elpis retains
   runtime selection, context projection, durable memory, session mirroring,
   behavioral policy, approval bridging, and presentation. The UI must show that Codex
   owns the turn.

The stable app-server `account/read` response intentionally reports account state
without returning a token. The legacy `getAuthStatus` request can return a token with
`includeToken`, but Codex marks that API deprecated in favor of `account/read`; Elpis
therefore must not build its native model adapter on that RPC.

A direct path dependency on the separate Codex clone is never a finished boundary.
Elpis may vendor/adapt Codex source or manage a compatible app-server binary, but it
must not load source from the donor directory. Selecting Gemini, Claude, or another
runtime must not implicitly delegate its turn to Codex.

Upstream evidence for this boundary (paths relative to `~/Desktop/p/codex/codex-rs/`):

- Account protocol: `app-server-protocol/src/protocol/v2/account.rs`
- Account processor: `app-server/src/request_processors/account_processor.rs`
- Reusable auth component: `login/`
- Deprecation marker: `app-server-protocol/src/protocol/common.rs`

Run `scripts/codex-auth-status-smoke.sh` from the Elpis repository to check this
boundary: it initializes app-server and sends exactly one `account/read` request,
printing only the account type and whether OpenAI authentication is required — no
email, tokens, account IDs, or raw response payloads — and does not start a thread or
model turn.

## Providers

Elpis owns context admission, durable memory, continuity, permissions, evidence, and the
terminal interface. The selected provider owns inference. Provider changes must not
discard the Elpis state around them, and a native-provider selection must never be
redirected through another provider.

Routes, credentials, wire-protocol translation, compatibility aliases, protocol
limitations, and the manual smoke tests all live in [providers.md](providers.md).
Elpis's native provider IDs never install an OpenRouter model override; the
`claude`, `gemini`, and `gemini-flash` launcher values are compatibility aliases
that deliberately route through OpenRouter.

## Context Contract

Context is a budgeted working set, not the session archive.

> For deep-dive technical details on the 3-layer pruning pipeline, context lifetimes, and the Context Ledger (`Tab` / `Alt+C`), see [context.md](context.md).

### 1. Durable prefix

Load the smallest stable routing layer: applicable `AGENTS.md`, this guide, and a
short skill index. Detailed rules are loaded only when a task triggers them. An
instruction file should behave like a table of contents, not a knowledge dump.

### 2. Turn input

Send the new user message plus explicitly requested context. An `@file` mention is
an explicit refresh. A pinned checklist file is injected once and again only when its
content changes. Never append the same unchanged file body on every turn.

### 3. Exploration expires

Searches, directory listings, file reads, probes, and unsuccessful paths are temporary
working material. Once they have answered the current question, remove their raw output
from the model-visible context. Keep only the useful conclusion, a pointer to its source,
and the consequence for the next action.

Do not turn `GUIDE.md` into an exploration log. Promote one distilled fact only when it is
durable enough to change how future agents should work on Elpis; replace stale guidance
instead of accumulating discoveries.

### 4. Compact tool and file records

Keep full events in the on-disk transcript. The model-visible working set should
replace stale bulky results with compact records containing:

- operation and target;
- success/failure and exit status;
- concise result or error summary;
- changed paths and a diff/stat reference;
- verification performed;
- a pointer for rereading the full artifact when needed.

After a file edit, preserve the path, semantic change, diff, and verification. Do not
retain the entire old and new file merely because the agent touched them.

### 5. Pruning and compaction

- **Pruning is ephemeral:** trim or replace old tool results for the next request;
  leave the durable transcript intact.
- **Compaction is persistent:** summarize older conversation into a checkpoint that
  preserves the goal, constraints, decisions, changed files, verification, blockers,
  and next action.
- Before compaction, flush genuinely reusable facts to durable memory.
- Keep a recent-turn suffix verbatim so the agent does not wake up inside a summary.

### 6. Memory

Memory is curated cross-session knowledge, not a transcript mirror. Store stable user
preferences, project facts, decisions, and proven procedures. Retrieve only relevant
entries for the current task and make provenance visible.

> For full technical architecture on 2-stage SQLite extraction/consolidation and live workspace re-verification, see [memory.md](memory.md).

### 7. Measurement

Prefer runtime-reported token usage and context-window size. Character division is a
fallback estimate only. Track injected sources and bytes/tokens by category so the
user can answer: "Why is this in context?"

## Session Semantics

An API call does not receive previous messages by magic. Either Elpis resends the chosen
working context, or a provider stores a thread and reconstructs it. Elpis must keep its
own provider-neutral session record and context list even when a provider also offers
thread IDs. Resume, fork, rollback, and compaction must therefore have Elpis semantics,
with provider thread IDs treated as adapter-specific state rather than the project truth.

> For technical details on Tier 1 Native Resume vs. Tier 2 Lean Continuation and `GOAL.md` / `ES.md` checkpoints, see [sessions.md](sessions.md).

Reasoning tokens count toward usage, but hidden reasoning is not a useful transcript
to carry forward verbatim. Preserve decisions and evidence. Streamed tool events and
large outputs also should not remain indefinitely in the model-visible working set.

## UI Identity

Elpis should feel unique because the interface exposes what Elpis uniquely owns: runtime
identity, admitted context, durable memory, continuity, permissions, and evidence.

The current product priority is to make the existing interface solid before adding new
features. The Context Ledger is the first target. Tab must never submit a draft or behave
like Enter; opening and closing the ledger must preserve the composer exactly. After that
bug is fixed, Masih will review the ledger and decide whether its design should be
improved or the ledger should be removed. Do not assume that decision.

> The model may change; the work continues.

### Implemented

- Elpis product naming (`PRODUCT_NAME`/`CODEX_RUNTIME_TITLE` = `"Elpis"`,
  `codex-rs/tui/src/branding.rs`), rendered in the startup session header as
  `>_ Elpis (v0.1.0)`. Earlier design notes describing a longer
  `Elpis · continuity runtime` or `Elpis · Codex runtime` title string are not what
  ships; the actual title is the bare product name and version.
- A persistent cyan identity header (`render_identity_line`,
  `codex-rs/tui/src/chatwidget/rendering.rs`) that always renders above the chat
  surface: `Elpis · model {model} · location {cwd}`. The context percentage is not
  on this header — it is reported inside the Context Ledger, which computes it as
  used tokens over the model context window
  (`codex-rs/tui/src/chatwidget/context_ledger.rs`).
  The inherited footer status line is deliberately suppressed
  (`set_status_line_enabled(false)`) so this header is the one context-percent
  source, per the Context Accounting Contract in [context.md](context.md).
  This shipped design accents with cyan and shows model/context/location; an earlier
  design note proposed amber and a `runtime:`/`memory:`/`mode:` layout instead — that
  earlier layout was not carried into the implementation.
- The Context Ledger (`Tab` or `Alt+C`, `codex-rs/tui/src/chatwidget/context_ledger.rs`):
  a side panel shown by default (52 columns, hidden below 100-column terminals) listing
  every admitted portable-context source with its admitted state and byte size, and
  a total for currently admitted bytes. Selecting a row toggles its admission and
  writes the workspace `admission.toml` (`codex-rs/core/src/elpis_context.rs`), which
  governs next-turn admission for `GOAL.md`, `ES.md`, applicable global/project
  `AGENTS.md` rules, and `skills/dev/*.md` rules. Each `skills/dev/*.md` file is
  enumerated as its own independently toggleable row, admitted by default.
- The provider-aware **Choose a mind** naming for `/model`
  (`codex-rs/tui/src/chatwidget/model_popups.rs`, commit `bae7108`), surfacing
  provider, protocol, route, and credential labels.
- `/usage` context-source reporting.

### Not yet implemented

- A signature **continuity event** for resume, compaction, and provider switches. The
  only implemented notice is a context-eviction message that now also names what
  persisted (`"Elpis evicted context: {reason}. Evidence: {evidence}. Eviction count:
  {count}. Survived: goal, checkpoint, and admitted rules (see /usage)."`,
  `codex-rs/tui/src/chatwidget/protocol.rs`, commit `de4ed6f`); it still does not
  distinguish resume, compaction, or provider-change events from each other.
- An **evidence-first completion hierarchy** that visually separates a generated
  claim, changed paths, command/test status, and unresolved gaps.

### Acceptance

A new user watches one task cross compaction or provider change and can explain:
which runtime performed each turn; which goal, context, and memories survived; what
expired; what changed and was verified; and where exact evidence can be inspected.

## Current State

Current priority:

- Polish and stabilize the features already in daily use.
- Fix the Context Ledger first, beginning with its Tab key-routing bug.
- Add no new product features until the current baseline is accepted, unless Masih
  explicitly changes priority.

Verified foundation:

- `main` contains the pinned Codex Rust workspace under `codex-rs/` and builds the
  user-facing `elpis` executable;
- ChatGPT authentication, streaming, commands, patches, permission modes, sandboxing,
  mouse interaction, native sessions, and native compaction are inherited from Codex;
- a real authenticated turn ran a command and created a file, and launch checks proved
  no donor-clone runtime dependency;
- the old hand-grown TUI, Python agent state, and Gemini/runtime-boundary experiments
  are preserved as named tips inside `archive/pre-cleanup-20260716`; they are not part
  of canonical `main`.

Context continuity, pruning, memory, local RAG, provider adapters, permissions, and
release installation have shipped and are in daily use. Defects in those systems are
foundational regressions. The active work is UI stability and polish, beginning with the
Context Ledger. `/auto` routing and other new features have not started.

### Task importance and task difficulty

Elpis product tasks use three importance levels:

- **Foundational:** Elpis loses its purpose, reliability, or basic usability without it.
- **Important:** a material improvement after the foundation is solid.
- **Nice-to-have:** optional work that cannot delay foundational polish.

These levels are not release numbers and do not describe implementation complexity.
Easy, Medium, and Hard are separate difficulty labels for the proposed `/auto` feature,
which would use task difficulty to choose an appropriate model. `/auto` remains optional
future work.

The currently installed build includes the command-surface changes from `b135e7a` and
the startup-tip/test-command changes from `419384d`. Most unwanted commands were made
undiscoverable, not fully deleted from the Rust implementation; this does **not** satisfy
the approved subtraction requirement. Complete removal must proceed feature by feature
without deleting shared machinery required by retained behavior.

### Startup performance

Typing `elpis` previously took about five seconds before the TUI was usable; the archived
prototype took under one second. The regression is now resolved. Keep the startup target
below one second, with optional services forbidden from blocking the first usable frame.

A profiled Elpis launch scheduled its first frame in 0.049 seconds and Masih confirmed
that the fresh launch is fast. Startup performance is accepted.

Elpis contains no Python. Retrieval runs in an MCP server the user registers, in its own
process, started by the MCP layer — so an engine's imports, model loading, and indexing
cost cannot reach the launch path no matter how heavy that engine is. Never reintroduce a
machine-learning dependency into this repository to serve retrieval; see [rag.md](rag.md).

### Memory ownership

Elpis memory artifacts default to `~/.elpis/memories` and memory database state defaults
to `~/.elpis/state`. Codex configuration, authentication, threads, logs, and goals remain
separate. Resetting Elpis memory must not delete Codex memory or state. Unconfigured
non-TUI consumers retain the inherited Codex-home fallback for compatibility.

### Product scope already decided

- The active terminal interface is Codex's contained Rust TUI and already uses Ratatui.
  Elpis does not need a UI-framework rewrite for the visual identity pass.
- UI work is appearance-only for now: colors and styling may change, but Codex-quality
  content, rendering, and interactions must remain.
- Dictation is a required future feature. First audit the contained Codex source for an
  existing speech-to-text path; otherwise specify a visible, consent-based Whisper
  integration. Dictation must insert editable text and must not auto-submit it.
- Kiro may be researched for reusable ideas only after its actual source availability,
  language, license, and performance claims are verified. Do not assume it is open
  source or copyable.

## Engineering Rules

- Read this guide before architectural work; read only the source sections relevant
  to the current task.
- Keep upstream protocol handling version-aware. Generate schemas from the installed
  Codex version when exact message shapes matter.
- Do not add slash commands without explicit user selection.
- Do not call a temporary directory a sandbox. State the actual isolation boundary.
- Preserve user-visible behavior with focused tests for protocol and context changes.
- Record what is implemented separately from what is intended.
- Treat `main` as canonical. Read archive branches only when historical prototype
  behavior is specifically needed.
- Keep one normal local worktree. Create a temporary worktree only for an approved,
  genuinely parallel task; remove it after its useful commit is merged or archived.
- Push accepted canonical checkpoints to `main`. Historical or abandoned branch tips
  belong in the single `archive/pre-cleanup-20260716` history branch, not in a growing
  set of active-looking branches.

## Verification

For fast local binary build and verification (~15s), run:
```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo build --manifest-path codex-rs/Cargo.toml --bin elpis && install -m 755 codex-rs/target/debug/elpis ~/.local/bin/elpis
```

Use `.github/workflows/embedded-elpis-linux.yml` for CI Rust formatting, focused tests, release build, executable identity, and artifact verification.

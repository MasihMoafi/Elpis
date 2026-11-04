# Elpis Technical Guide

The [README](../readme.md) introduces the product. This guide describes its architecture and contracts.

## Proof Standard

Behavior is accepted through the user-visible checks described by the relevant feature. Current state and open requests are in [ES.md](../ES.md) and [REQUESTS.md](../REQUESTS.md).

## Requirements

This section preserves confirmed product requirements. Current implementation state belongs in [ES.md](../ES.md), not here.

### Confirmed Requirements

**R1. Provider-neutral Elpis environment** — Elpis owns the TUI, provider/runtime selection, context projection, durable memory, provider-neutral continuity, behavioral policy, permissions bridge, and evidence. A selected runtime may own its low-level model loop and native tools, but authentication must never silently transfer Elpis-owned state or product identity to that runtime.

**R2. Visible and controlled agency** — Commands and file changes follow explicit permission and sandbox policies. The interface must preserve changed paths, diffs, command status, failures, and verification evidence.

**R3. Context lifecycle** — [Context reference](context.md).

**R4. Continuity** — [Session reference](sessions.md).

**R5. Memory** — [Memory and checkpoints](context.md#3-memory-and-checkpoints).

**R6. Creator and project rules** — [Context reference](context.md#3-memory-and-checkpoints).

**R8. Expensive capabilities are plugged in, not built in** — Workspace semantic search is provided by an MCP server the user registers. Voice capture/transcription belongs to an external program such as [WhisperType](https://github.com/MasihMoafi/Voice-commander), which may expose a transcription tool through MCP. Never add a machine-learning dependency to this repository for those capabilities.

**R11. Explicit Claude provider and subscription paths** — Preserve the native Anthropic API path and the later user-selected Claude subscription ACP bridge, [`tools/elpis-claude/acp-bridge.mjs`](../tools/elpis-claude/acp-bridge.mjs). Authentication and provider selection remain explicit. `elpis claude` separately starts Claude Code through a loopback Smart Prune proxy.

Account switching uses [`claude-accounts.mjs`](../tools/elpis-claude/claude-accounts.mjs).

**R12. Deterministic multi-agent orchestration** — [Work-graph contract](WORK_GRAPHS.md).

### State Layout

The default runtime home and its override are in the [README](../readme.md#how-it-works). The [session reference](sessions.md#3-portable-checkpoint-layout) owns the checkpoint layout; provider transcripts and workspace artifacts remain evidence sources.

### Product Scope Decisions

- The active terminal interface is the contained Codex Rust TUI and already uses Ratatui; Elpis does not need a UI-framework rewrite.
- UI changes must preserve Codex-quality content, rendering, and interactions unless a separate behavior change is explicitly approved.
- Dictation: [desktop README](../apps/elpis-desktop/README.md).
- Do not add slash commands unless Masih explicitly selects them.

### Deferred Decisions

- Whether goal changes require explicit confirmation.
- Default threshold for switching from exact to lean continuation.
- `/auto`, dreaming reports, richer animation, voice integration details, and scheduled work.

## Source Map

Treat upstream behavior as evidence, not inspiration copied from memory.

### Codex: Execution and Interface Reference

Primary source is [openai/codex](https://github.com/openai/codex). Clone it beside this repository and read the committed source when it can answer the question.

Important areas:

- app-server and protocol: `codex-rs/app-server`, `codex-rs/app-server-protocol`;
- Rust TUI: `codex-rs/tui`;
- core runtime: `codex-rs/core`.

Codex is the contained implementation foundation for thread/turn semantics, streaming, file changes, commands, approvals, sandboxing, sessions, and TUI ergonomics. Elpis does not load code from or require the separate donor clone at runtime.

The foundation strategy is **vendor and carry**: pin an unmodified upstream Codex release; carry Elpis as copied Elpis-owned modules and crates plus a few small, marked seams in upstream files; switch unwanted upstream surfaces off by configuration, proven by a network-capture eval, rather than deleting them; and absorb a new release by rebasing the Elpis commits onto a new vendor commit. Non-Responses providers reach Codex through an Elpis-owned local Responses gateway.

### OpenClaw: Context and Continuity Reference

Primary source is [openclaw/openclaw](https://github.com/openclaw/openclaw). Clone it beside this repository and read implementation and tests rather than relying on explanatory prose.

Useful areas include live context pruning, guarded compaction, pre-compaction memory flush, search/retrieval, memory budgets, promotion, and dreaming. Elpis adopts ideas only when they fit its own contracts and pass Elpis acceptance.

Elpis's concrete context and session contracts live in [context.md](context.md) and [sessions.md](sessions.md).

### Other Reference Sources

| Source | Proven capability to reuse or study | Elpis boundary |
| --- | --- | --- |
| Pi | Composable multi-provider APIs, agent state, TUI, coding CLI | Study provider-neutral interfaces and extension simplicity; it does not supply Codex-level built-in permissions |
| Hermes Agent | Provider choice, TUI, cross-session search, user modeling, skill learning, scheduled work, multiple execution backends | Study the learning loop and memory controls; verify implementation before adopting claims |
| OpenCode | Multi-provider coding product, read-only/build agents, subagents, installation and TUI delivery | Study routing, packaging, agent modes, and release experience |

No capability becomes an Elpis feature merely because an upstream project has it. It becomes real only after its Elpis acceptance check passes.

### Codex Import Provenance

The contained Codex workspace was imported from `openai/codex` revision `2e1607ee2fa8099a233df7437adee5f16a741905` under Apache-2.0, with notices retained under `codex-rs/`. Only committed donor content was imported; the donor working tree's unrelated local edits were not.

### Preserve-First Behaviors

Preserve these proven seams and their tests when changing the contained foundation:

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

All paths above are relative to `codex-rs/`.

### Stable Task Boundaries

Keep ownership seams intact when changing shared rendering or permission code:

| Task | Primary files | Contract |
| --- | --- | --- |
| Action rendering | `tui/src/chatwidget/command_lifecycle.rs`, `tool_lifecycle.rs`, `exec_state.rs`, `exec_cell/`, `history_cell/patches.rs`, `diff_render.rs` | Own command/file lifecycle projection and rendered cells; preserve colocated tests and snapshots. |
| Permissions | protocol, approval presets, `core/src/safety.rs`, sandboxing, permission UI | Own permission types, preset selection, enforcement, and approval UI; preserve policy tests and approval snapshots. |
| Mouse selection and copy | TUI event/input paths, raw-output methods, history raw lines | Preserve terminal-native selection and copy-faithful raw scrollback behavior. |

`chatwidget.rs` and `chatwidget/protocol.rs` are shared seams, not general cleanup areas.

### Permission Baseline

- **Read Only:** may read workspace files; edits or internet require approval.
- **Default:** may read/edit within the workspace and run commands; internet or work outside the workspace requires approval.
- **Full Access:** no approval prompts; filesystem and internet restrictions are off.

Confirmed permission changes govern subsequent tool dispatches in an active turn.
Switching Claude or Gemini out of Full Access stops the active turn so its provider
process cannot retain bypass permissions; the next message uses the selected mode.
Environment-owner restrictions remain authoritative for attached environments.

## Runtime Architecture

```text
User
  -> Elpis TUI (presentation, selection, approvals, context visibility)
  -> Elpis control layer (runtime choice, context, memory, session mirror, policy)
       -> selected agent runtime
            -> Codex app-server/native runtime
            -> Elpis provider-neutral direct model path
            -> other explicitly supported runtimes
       -> Elpis retrieval services
  -> Workspace + durable Elpis state ($ELPIS_HOME)
```

The `elpis` executable is built from the contained `codex-rs/` foundation. Runtime ownership is explicit. When Codex is selected, Codex may own the low-level model loop, native tools, native thread, and native compaction. Elpis still owns the surrounding product: runtime/provider selection, context projection, durable memory, provider-neutral continuity, behavioral policy, approvals bridge, and visible TUI.

Authentication alone must never silently select a runtime. The active model/provider/runtime owner must be visible.

## Authentication Boundary

Authentication and runtime selection are separate decisions.

- Status-only Codex authentication uses the app-server account RPCs and must not start threads, turns, commands, approvals, or tools.
- An Elpis-owned direct OpenAI path may reuse the contained Codex login component for compatible credentials and refresh, but bearer tokens must never be rendered, logged, returned to the TUI, or persisted in a second Elpis credential store.
- When Codex is deliberately selected as runtime, Codex may own its low-level model loop and native thread while Elpis retains its surrounding state and policy.
- Selecting Anthropic, Gemini, or another native provider must never silently route its inference through Codex or another provider.
- A path dependency on the separate donor clone is never a finished runtime boundary.

The status smoke check is `scripts/codex-auth-status-smoke.sh`; it must perform authentication status inspection without starting a model turn or printing sensitive account/token data.

## Providers

Elpis owns context admission, durable memory, continuity, permissions, evidence, and the terminal interface; the selected provider owns inference. Provider changes must not discard Elpis-owned state, and a native provider selection must never be silently redirected through another provider.

Routes, credentials, BYOK setup, wire-protocol translation, compatibility aliases, limitations, and smoke tests live in [providers.md](providers.md).

## Context Contract

See the [context reference](context.md).

## Session Semantics

Elpis keeps its own provider-neutral continuity state even when a provider also offers thread IDs. Resume, fork, rollback, compaction, and provider changes therefore have Elpis semantics; provider thread IDs are adapter-specific state rather than project truth.

Exact resume and lean continuation, including `GOAL.md` and `ES.md`, are specified in [sessions.md](sessions.md).

## UI Identity

Elpis-specific controls keep context, memory, provider and permission state legible. Context-specific mechanics belong in [context.md](context.md).
The dashboard remains a dashboard, with its existing scope preserved.

### Acceptance

A user watches one task cross compaction or provider change and can explain which runtime performed each turn; which goal, context, and memories survived; what expired; what changed and was verified; and where exact evidence can be inspected.

## Engineering Rules

- Read this guide before architectural work; load only sections relevant to the task.
- Keep upstream protocol handling version-aware; derive exact schemas from the contained/upstream version when message shapes matter.
- Do not call a temporary directory a sandbox; state the actual isolation boundary.
- Preserve user-visible behavior with focused tests for protocol and context changes.
- Record implemented behavior separately from intended behavior.
- Treat `main` as canonical; consult archives only when historical prototype behavior is specifically needed.
- Agent workflow and delegation rules live in `AGENTS.md`.
- Local build constraints live in `LOCAL_BUILD_RULES.md`.
- Release, machine-boundary, and clean-install rules live in `SHIPPING_RULES.md`.
- Security policy lives in `SECURITY.md`.

## Verification

Verification is proportional to the change and must establish behavior, not merely compilation.

- Use `AGENTS.md` for acceptance/worker discipline.
- Use `LOCAL_BUILD_RULES.md` for local Rust build and test commands.
- Use `SHIPPING_RULES.md` for release verification and clean-machine checks.
- Use `.github/workflows/embedded-elpis-linux.yml` for CI Rust formatting, focused tests, release build, executable identity, and artifact verification.
- Record current acceptance state in [ES.md](../ES.md).

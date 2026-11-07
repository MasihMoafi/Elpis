# Elpis Technical Guide

Architecture and contracts. The [README](../readme.md) introduces the product; [ES.md](../ES.md) holds current state and acceptance, [REQUESTS.md](../REQUESTS.md) open requests. A behaviour is accepted through its feature's user-visible checks.

## Requirements

Confirmed product requirements. Implementation state belongs in [ES.md](../ES.md). Feature-level requirements: [terminal](TUI_SPEC.md) and [desktop](../apps/elpis-desktop/SPEC.md).

### Confirmed Requirements

**R1. Provider-neutral Elpis environment** — Elpis owns the interface (terminal and desktop), provider/runtime selection, context projection, durable memory, provider-neutral continuity, behavioral policy, permissions bridge, and evidence. A selected runtime may own its low-level model loop and native tools, but authentication must never silently transfer Elpis-owned state or product identity to that runtime.

**R2. Visible and controlled agency** — Commands and file changes follow explicit permission and sandbox policies. The interface preserves changed paths, diffs, command status, failures, and verification evidence.

**R3. Context lifecycle** — [Context reference](context.md).

**R4. Continuity** — [Session reference](sessions.md).

**R5. Memory** and **R6. Creator and project rules** — [Memory and checkpoints](context.md#3-memory-and-checkpoints).

**R8. Expensive capabilities are plugged in, not built in** — Workspace semantic search comes from an MCP server the user registers. Voice capture and transcription belong to an external program such as [WhisperType](https://github.com/MasihMoafi/Voice-commander), which may expose a transcription tool through MCP. Never add a machine-learning dependency to this repository for those capabilities.

**R11. Explicit Claude provider and subscription paths** — Preserve the native Anthropic API path and the user-selected Claude subscription ACP bridge, [`tools/elpis-claude/acp-bridge.mjs`](../tools/elpis-claude/acp-bridge.mjs). Authentication and provider selection stay explicit. `elpis claude` separately starts Claude Code through a loopback Smart Prune proxy. [`claude-accounts.mts`](../tools/elpis-claude/claude-accounts.mts) switches accounts.

**R12. Deterministic multi-agent orchestration** — [Work-graph contract](WORK_GRAPHS.md).

### State Layout

The runtime home and its override: [README](../readme.md#how-it-works). Checkpoint layout: [session reference](sessions.md#3-portable-checkpoint-layout). Provider transcripts and workspace artifacts remain evidence sources.

### Product Scope Decisions

- UI changes preserve Codex-quality content, rendering, and interactions unless a behaviour change is explicitly approved.
- Dictation: [desktop README](../apps/elpis-desktop/README.md).
- Add no slash command unless Masih explicitly selects it.

## Source Map

Treat upstream behaviour as evidence: read its committed source, not memory. An upstream capability becomes an Elpis feature only when it fits Elpis's contracts and passes its Elpis acceptance check.

### Codex: Execution and Interface Reference

Source: [openai/codex](https://github.com/openai/codex). Key areas: app-server and protocol (`codex-rs/app-server`, `codex-rs/app-server-protocol`), Rust TUI (`codex-rs/tui`), core runtime (`codex-rs/core`).

Codex is the contained foundation for thread/turn semantics, streaming, file changes, commands, approvals, sandboxing, sessions, and TUI ergonomics. Elpis never loads code from or requires the donor clone at runtime.

The foundation strategy is **vendor and carry**: pin an unmodified upstream Codex release; carry Elpis as copied Elpis-owned modules and crates plus a few small, marked seams in upstream files; switch unwanted upstream surfaces off by configuration, proven by a network-capture eval, rather than deleting them; absorb a new release by rebasing the Elpis commits onto a new vendor commit. Non-Responses providers reach Codex through an Elpis-owned local Responses gateway.

### Codex Import Provenance

See [codex-rs/ELPIS_UPSTREAM.md](../codex-rs/ELPIS_UPSTREAM.md).

### Preserve-First Behaviors

Preserve these seams and their tests when changing the foundation. Paths are relative to `codex-rs/`.

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

### Stable Task Boundaries

Action rendering, permissions, and mouse selection and copy (terminal-native selection, copy-faithful raw scrollback) each own their files in the table above; keep their colocated tests and snapshots. `chatwidget.rs` and `chatwidget/protocol.rs` are shared seams, not general cleanup areas.

### Permission Baseline

- **Read Only:** may read workspace files; edits or internet require approval.
- **Default:** may read/edit within the workspace and run commands; internet or work outside the workspace requires approval.
- **Full Access:** no approval prompts; filesystem and internet restrictions are off.

A confirmed permission change governs later tool dispatches in the active turn. Switching Claude or Gemini (Antigravity) out of Full Access stops the active turn, so its provider process cannot keep bypass permissions; the next message uses the selected mode. Environment-owner restrictions remain authoritative for attached environments.

## Runtime Architecture

```text
User
  -> Elpis TUI (presentation, selection, approvals, context visibility)
  -> Elpis control layer (runtime choice, context, memory, session mirror, policy)
       -> selected agent runtime
            -> Codex app-server/native runtime
            -> Elpis provider-neutral direct model path
            -> other explicitly supported runtimes
  -> Workspace + durable Elpis state ($ELPIS_HOME)
```

The `elpis` executable is built from the contained `codex-rs/` foundation. When Codex is selected, it may own the low-level model loop, native tools, native thread, and native compaction; Elpis keeps everything R1 lists. The active model, provider, and runtime owner must be visible.

## Authentication Boundary

Authentication alone must never select a runtime.

- Status-only Codex authentication uses the app-server account RPCs and must not start threads, turns, commands, approvals, or tools. `scripts/codex-auth-status-smoke.sh` checks this without starting a model turn or printing account or token data.
- An Elpis-owned direct OpenAI path may reuse the contained Codex login component for compatible credentials and refresh. Bearer tokens must never be rendered, logged, returned to the TUI, or persisted in a second Elpis credential store.
- A path dependency on the donor clone is never a finished runtime boundary.

## Providers

Provider changes must not discard Elpis-owned state. Routes, credentials, BYOK setup, wire-protocol translation, compatibility aliases, limitations, and smoke tests: [providers.md](providers.md).

## Session Semantics

Elpis keeps its own provider-neutral continuity state even when a provider offers thread IDs. Resume, fork, rollback, compaction, and provider changes therefore have Elpis semantics; provider thread IDs are adapter state, not project truth. Exact resume and lean continuation, including `GOAL.md` and `ES.md`: [sessions.md](sessions.md).

## UI Identity

Elpis-specific controls keep context, memory, provider, and permission state legible.

### Acceptance

A user watches one task cross compaction or provider change and can explain which runtime performed each turn; which goal, context, and memories survived; what expired; what changed and was verified; and where exact evidence can be inspected.

## Engineering Rules

- Keep upstream protocol handling version-aware; derive exact schemas from the contained/upstream version when message shapes matter.
- Do not call a temporary directory a sandbox; state the actual isolation boundary.
- Cover protocol and context changes with focused tests of user-visible behaviour.
- Record implemented behaviour separately from intended behaviour.

## Verification

Verify in proportion to the change, and establish behaviour, not just compilation.

- Agent workflow, delegation, acceptance and worker discipline: the local `AGENTS.md`.
- Terminal build and test commands: [CONTRIBUTING.md](../CONTRIBUTING.md#building-the-terminal-app); local build limits, formatting and the `verify-elpis` selector: [LOCAL_BUILD_RULES.md](LOCAL_BUILD_RULES.md).
- Release, machine-boundary, clean-install and release verification: [SHIPPING_RULES.md](SHIPPING_RULES.md).
- Security policy: [SECURITY.md](SECURITY.md).
- CI Rust formatting, focused tests, release build, executable identity, and artifact verification: [`.github/workflows/embedded-elpis-linux.yml`](../.github/workflows/embedded-elpis-linux.yml).

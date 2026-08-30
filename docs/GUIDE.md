# Elpis Technical Guide

## Product Thesis

> You put an agent into an Elpis, and it becomes Elpis. Be Elpis, my friend.

Elpis is the environment an agent enters and assimilates into. The selected model or agent runtime may change, but the user's goals, working style, durable knowledge, context policy, evidence, and behavioral boundaries continue coherently. Elpis is both a state and a direction: it is never fully complete, and each verified change should make the environment clearer, more capable, and easier for its creator to control.

## Purpose

Elpis is a provider-neutral coding-agent TUI. It does not try to make a new foundation model. It gives agents backed by OpenAI/Codex, Gemini, Claude, or another model one coherent local interface by managing:

- instructions and project knowledge admitted into working context;
- the boundary between transient context and durable memory;
- tools, edits, commands, permissions, and their evidence;
- continuity across turns, compaction, and sessions;
- a model-independent TUI where consequential actions remain inspectable.

The intended result is assimilation: whichever model provider is selected, the agent adopts the user's harness, workspace, memory, and control policy without being buried under them.

## Product Value

Elpis should create value in five ways:

1. **Assimilation:** a selected runtime adopts the creator's applicable instructions, goals, context, memory, and behavioral rules, rather than the user adapting to it.
2. **Context sovereignty:** the user can see and control what enters the agent's working set. Selecting a file is an intentional context operation, not decoration.
3. **Reliable continuity:** sessions preserve goals, decisions, changes, and evidence across model changes, compaction, and restarts, while disposable logs and stale file bodies fall away instead of replaying an ever-growing transcript.
4. **Safe, transparent agency:** edits and commands use explicit sandbox and approval contracts. The UI shows what is proposed and records what happened; Elpis does not claim success when it has only hidden or documented a gap.
5. **Runtime choice and user ownership:** Elpis keeps one surrounding control environment while allowing the model provider and low-level agent runtime to change explicitly. Durable state is inspectable, editable, exportable, and not tied to one provider or runtime.

Elpis is not primarily a provider switcher, transcript viewer, or collection of slash commands. It is not distinguished by having another terminal chat interface. Existing projects already provide strong model access, tools, permissions, terminal rendering, and agent loops; Elpis reuses those implementations and is distinguished by the five values above.

## Desired Output

Ship an installable terminal product, not a repository demo, in which a user can:

1. authenticate and deliberately select a supported model and runtime;
2. see which runtime owns the turn and which capabilities Elpis retains;
3. give the agent a task under Read Only, Default, or Full Access permissions;
4. watch readable commands, output, file changes, diffs, failures, and verification;
5. inspect and control the exact working context admitted by Elpis;
6. resume later from the same goal, decisions, changes, and relevant memory without replaying irrelevant history;
7. switch to at least one non-Codex runtime while retaining Elpis-owned continuity;
8. install and complete a real coding task from a clean environment.

The product succeeds only when these behaviors pass their acceptance checks and the distinctive context/continuity behavior is demonstrably useful compared with the selected runtime alone.

## Proof Standard

A feature is real only when its user-visible acceptance check passes and the evidence is recorded. Documentation, hidden code, or a plausible architecture is not proof. `TASKS.md` is the current-state record against this standard.

The defining evaluation is whether a fresh supported runtime can enter Elpis, receive the right current goal and relevant history, obey creator rules, perform visible work under the chosen permission mode, and resume later without irrelevant context.

## Requirements

This section preserves confirmed product requirements. Current implementation state belongs in `TASKS.md`, not here.

### Working Agreement

- Keep required work ahead of speculative features.
- Challenge unnecessary complexity and solution-first requests.
- Record evidence rather than confidence.
- Prefer small, reversible changes and the smallest useful verification.

### Task Importance and Task Difficulty

Elpis product tasks use three importance levels:

- **Foundational:** Elpis loses its purpose, reliability, or basic usability without it.
- **Important:** a material improvement after the foundation is solid.
- **Nice-to-have:** optional work that cannot delay foundational polish.

These levels are not release numbers and do not describe implementation complexity.

Easy, Medium, and Hard are separate difficulty labels. They describe how much reasoning, coordination, and architectural judgment a task requires and may be used by future automatic model routing such as `/auto`.

### Confirmed Requirements

**R1. Provider-neutral Elpis environment** — Elpis owns the TUI, provider/runtime selection, context projection, durable memory, provider-neutral continuity, behavioral policy, permissions bridge, and evidence. A selected runtime may own its low-level model loop and native tools, but authentication must never silently transfer Elpis-owned state or product identity to that runtime.

**R2. Visible and controlled agency** — Commands and file changes follow explicit permission and sandbox policies. The interface must preserve changed paths, diffs, command status, failures, and verification evidence.

**R3. Deliberate context lifecycle** — Elpis must know what the model receives. Rules, goal, selected files, conversation, tool output, and memory have visible sources, sizes, reasons, and lifetimes. Stale exploration leaves the next request only after its useful conclusion and exact evidence pointer are retained. A length threshold alone is not a complete context policy.

**R4. Exact and lean continuity** — The active goal, decisions, constraints, changed files, verification, blockers, and next action survive restarts. Elpis supports exact native-thread resume and lean continuation from a compact portable checkpoint.

**R5. Curated memory** — Memory stores reusable facts and proven procedures, not transcripts. Promotion requires repeated useful recall across distinct contexts. Memory remains searchable, attributable, reviewable, deletable, and bounded. Deleted or faded facts enter a searchable archive before baseline reset; archive failure must stop the reset.

**R6. Enforceable creator and project rules** — Applicable `AGENTS.md`, project requirements, and behavioral rules reach the model and action layer. Hard safety rules are enforced by code where prompts are insufficient.

**R7. Claims require proof** — Documentation separates implemented behavior, remote tests, and outstanding user acceptance. Design documents and hidden code are not proof.

**R8. Expensive capabilities are plugged in, not built in** — Elpis ships no retrieval or speech engine and no model weights. Workspace semantic search is provided by an MCP server the user registers. Voice capture/transcription belongs to an external program such as [WhisperType](https://github.com/MasihMoafi/Voice-commander), which may expose a transcription tool through MCP. Never add a machine-learning dependency to this repository for those capabilities.

**R9. Proportionate, measured development cycle** — Ordinary changes receive focused checks. Exhaustive inherited TUI/app-server regression runs belong to nightly/manual/release verification unless a change directly touches that surface. CI must not edit source or create status-only commits. Dependency deletion follows measured cost and product optionality, not crate names.

**R10. Distinctive continuity-first identity** — Elpis uses a cyan visual identity and visibly separates runtime, model, context, memory, permissions, and evidence. UI design is an acceptance contract, not proof of implementation.

**R11. Claude models use the native provider path** — The removed Claude Code CLI-subprocess bridge is not a supported runtime. Claude models are supported through the native Anthropic Messages API adapter; authentication/provider selection must remain explicit.

**R12. Deterministic multi-agent orchestration** — Elpis owns a persisted task DAG above the agent lineage graph. It validates dependencies and bounded task roles, controls concurrency and write authority, measures file changes, requires evidence, and requires a directly dependent read-only verifier for writable work. Branch/worktree creation and integration remain deliberate coordinator actions. The exact contract and verification state live in [WORK_GRAPHS.md](WORK_GRAPHS.md).

### State Layout

- `~/.elpis/context/workspaces/<workspace>/GOAL.md` — active goal.
- `~/.elpis/context/workspaces/<workspace>/ES.md` — compact latest checkpoint.
- `~/.elpis/memories/MEMORY.md` — user-maintained memory admitted into context.
- `~/.elpis/state/state_5.sqlite` — threads, agent jobs, persisted work graphs, task claims, evidence, and transition events.
- Provider transcripts and workspace artifacts remain exact evidence sources.

### Product Scope Decisions

- The active terminal interface is the contained Codex Rust TUI and already uses Ratatui; Elpis does not need a UI-framework rewrite.
- UI changes must preserve Codex-quality content, rendering, and interactions unless a separate behavior change is explicitly approved.
- Dictation remains a future feature. It must insert editable text and must not auto-submit it.
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

The foundation strategy is **fork and subtract**: preserve proven execution/TUI behavior and tests, remove unwanted product surfaces in bounded steps, and add Elpis-owned provider, context, continuity, memory, and control layers without reviving the archived hand-grown prototype.

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

The contained Codex workspace was imported from `openai/codex` revision `2e1607ee2fa8099a233df7437adee5f16a741905` under Apache-2.0, with notices retained under `codex-rs/`. `codex-rs/ELPIS_UPSTREAM.md` records provenance. Only committed donor content was imported; the donor working tree's unrelated local edits were not.

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
  -> Workspace + durable Elpis state (~/.elpis)
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

Context is a budgeted working set, not the session archive. The detailed implementation, pruning triggers, audit records, context lifetimes, Context Ledger behavior, and accounting contract live in [context.md](context.md).

At the product-contract level:

- load the smallest stable routing layer and only the detailed rules required by the task;
- send the new user message plus explicitly requested/admitted context;
- treat `@file` as an explicit refresh and do not repeatedly append unchanged file bodies;
- let searches, listings, file reads, probes, dead ends, and bulky tool outputs expire from the model-visible working set after their useful conclusion and evidence pointer are retained;
- keep exact full events in durable on-disk evidence;
- preserve changed paths, semantic changes, verification, blockers, and the next action rather than entire stale file bodies;
- keep memory curated and attributable rather than mirroring transcripts;
- prefer authoritative runtime/provider token usage and context-window sizes; estimates are fallback only.

Do not turn `GUIDE.md` into an exploration log. Promote only durable rules or facts that change how future agents should work; replace stale guidance instead of accumulating discoveries.

## Session Semantics

Elpis keeps its own provider-neutral continuity state even when a provider also offers thread IDs. Resume, fork, rollback, compaction, and provider changes therefore have Elpis semantics; provider thread IDs are adapter-specific state rather than project truth.

Exact resume and lean continuation, including `GOAL.md` and `ES.md`, are specified in [sessions.md](sessions.md).

Reasoning tokens count toward usage, but hidden reasoning is not a useful transcript to carry forward verbatim. Preserve decisions and evidence; do not retain streamed tool events and large outputs indefinitely in the model-visible working set.

## UI Identity

Elpis should feel unique because the interface exposes what Elpis uniquely owns: runtime identity, admitted context, durable memory, continuity, permissions, and evidence.

> The model may change; the work continues.

The identity is cyan and continuity-first. UI changes should make runtime/model ownership, context, memory, permission state, and evidence legible without degrading the contained TUI's interaction quality.

Implementation status belongs in `TASKS.md`; context-specific UI mechanics belong in [context.md](context.md).

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
- Record current acceptance state and evidence in `TASKS.md`.

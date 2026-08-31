# Manual Memory and Agent/Work-Graph Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement one checked task at a time. Do not dispatch parallel implementers: both plans touch shared app-server/TUI seams and the coordinator must review each commit before starting the next task.

This is deliberately split into two independently reviewable plans with no code dependency on one another. Execute Plan A first as the product priority; after its review gate, Plan B may be executed from the same approved baseline by one implementer. The only order within a plan is the listed task order.

## Common evidence and constraints

- Spec: `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md`, sections 3.4–3.5 and Verification and Acceptance.
- Source audit: `.superpowers/daily-driver-audits/agents-memory.md`.
- Keep `enable_fanout = false`; do not add a scheduler, swarm layer, graph authoring, or automatic branch/worktree integration.
- Do not add a slash command. Reuse `/agent`; preserve its existing selection and Alt+Left/Right behavior.
- App-server protocol changes are additive. Existing JSON must deserialize unchanged; use `#[serde(default)]` on every newly added response field that can appear in an existing persisted/test fixture. Do not rename an existing method or field.
- All TUI/network-like app-server requests are asynchronous. Do not mutate visible selection/status optimistically; apply a result only if it still belongs to the same active primary thread and request generation.
- No dashboard file is in scope for either plan. In particular, memory contents, memory metadata, and graph data must not be added to the dashboard in this slice.
- The implementer must first read `AGENTS.md`, `docs/GUIDE.md`, `docs/context.md`, `docs/sessions.md`, `docs/WORK_GRAPHS.md`, `docs/SHIPPING_RULES.md`, and `docs/LOCAL_BUILD_RULES.md`, then verify the worktree is clean apart from this plan’s own changes.
- Do not run Cargo, Rust tests, `rustfmt`, builds, installation, tmux, browser/editor/process/config changes, or network actions while drafting or implementing this daily-driver stage. The commands in the final verification sections are deferred commands, not commands to run now.

## Genuine source blocker: memory editing

`codex-rs/tui/src/external_editor.rs` proves that Elpis can open a temporary Markdown file, waits for a successful editor exit, and returns the edited text. `codex-rs/tui/src/app/input.rs` only writes that returned text into the chat composer. There is no existing target-file writeback helper in the TUI that atomically replaces `MEMORY.md` after that exit. Therefore this candidate must **not** wire the external editor to memory. It supplies atomic create plus reveal/copy-path and deliberately defers edit/writeback until a separately reviewed file-write contract exists. This is a source-backed scope boundary, not a UI omission.

---

# Plan A — Truthful Usable Manual Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task. Checkbox steps are review checkpoints, not evidence that a command has already run.

**Goal:** Make the one canonical user-maintained `MEMORY.md` visible, creatable, explicitly admissible, and truthful about its 8,000-character request contribution without restoring automatic memory promotion.

**Architecture:** Keep request injection in the current app-server extension path and keep admission persisted per workspace. Add a small typed memory-status projection derived from the same canonical path and admission record as injection; the Context Ledger renders that projection as its special durable-memory row. Creation is a `create_new` file operation, leaves admission false, and never starts an editor. The TUI can reveal/copy the exact path but never reads or exposes memory content beyond the existing request-path tests.

**Tech Stack:** Rust workspace (`codex-core`, `codex-app-server`, `codex-tui`), Tokio filesystem APIs, existing Context Ledger and app-server extension tests.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` §3.5 and §Verification; `.superpowers/daily-driver-audits/agents-memory.md` §3.

## Plan A global constraints

- Canonical path is exactly `config.memory_dir/MEMORY.md` (normally `~/.elpis/memories/MEMORY.md`); no second memory file, database, retrieval index, or automatic extractor is introduced.
- Status values are exactly `missing`, `available_not_admitted`, and `admitted`; status includes `injected_chars`, `limit_chars: 8000`, and `truncated`.
- `injected_chars` is the character count actually eligible for the request after existing `trim()` and `truncate_chars` semantics; `truncated` is true iff trimmed character count exceeds 8,000. Missing has `injected_chars = 0`, `truncated = false`; an empty present file is `available_not_admitted`/`admitted` according to persisted admission but contributes zero characters.
- A missing-memory Create action creates only `# Elpis Memory\n`, creates the parent directory as needed, uses exclusive creation so it never overwrites a concurrent/user-created file, and leaves its admission state false.
- Admission remains the existing explicit per-workspace toggle. An immediate withdrawal must affect the next app-server-built request.
- No content is rendered in the ledger, history, notifications, clipboard error output, dashboard, logs, or tests. Tests use planted non-secret fixtures only.

## Plan A file map and interfaces

| File | Responsibility |
| --- | --- |
| `codex-rs/core/src/elpis_context.rs` | Canonical memory path/status/create helpers and unit tests; existing request builder remains the single admission/injection authority. |
| `codex-rs/app-server/src/extensions.rs` | No new memory transport; retain the extension call path and add only a narrow regression assertion if a helper extraction makes it necessary. |
| `codex-rs/app-server/tests/suite/v2/memory_recall.rs` | Full mock-request positive, negative, create, withdrawal, and truncation evidence. |
| `codex-rs/tui/src/chatwidget/context_ledger.rs` | Render and key handling for the typed memory row, Create and reveal/copy path actions, and focused rendering/key tests. |
| `codex-rs/tui/src/clipboard_copy.rs` | Reuse only its existing safe clipboard result/fallback API if it already accepts a literal path; do not broaden clipboard behavior. |
| `codex-rs/tui/src/chatwidget/tests/*` or colocated `#[cfg(test)]` module | Focused ledger tests in the existing local test style. |

The core interface introduced in Task A1 is the contract consumed by the TUI and request tests:

```rust
pub const MANUAL_MEMORY_LIMIT_CHARS: usize = 8_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManualMemoryAdmissionState {
    Missing,
    AvailableNotAdmitted,
    Admitted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualMemoryStatus {
    pub path: PathBuf,
    pub state: ManualMemoryAdmissionState,
    pub bytes: u64,
    pub injected_chars: usize,
    pub limit_chars: usize,
    pub truncated: bool,
}

pub fn manual_memory_status(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Option<ManualMemoryStatus>;

pub fn create_manual_memory(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> std::io::Result<ManualMemoryStatus>;
```

`manual_memory_status(None, _)` returns `None` only when Elpis has no configured memory root. `create_manual_memory(None, _)` returns `NotFound` and performs no filesystem write. It calls no admission setter. The existing `set_continuity_source_admitted(..., "MEMORY.md", admitted)` remains the only API changing admission.

### Task A1: Make canonical memory state and atomic creation testable in core

**Files:**

- Modify: `codex-rs/core/src/elpis_context.rs`
- Test: colocated `#[cfg(test)]` tests in `codex-rs/core/src/elpis_context.rs`

**Consumes:** Existing `workspace_context_dir`, `read_admission`, `set_continuity_source_admitted`, `truncate_chars`, and the actual `memory_dir/MEMORY.md` convention.

**Produces:** `ManualMemoryAdmissionState`, `ManualMemoryStatus`, `MANUAL_MEMORY_LIMIT_CHARS`, `manual_memory_status`, and `create_manual_memory` used by Tasks A2–A3.

- [ ] **Step 1: Add failing core tests before changing the source.**

  Add temp-directory tests with these exact assertions:

  ```rust
  #[test]
  fn manual_memory_missing_is_typed_and_not_injected() {
      let status = manual_memory_status(Some(memories.path()), cwd.path()).unwrap();
      assert_eq!(status.state, ManualMemoryAdmissionState::Missing);
      assert_eq!(status.injected_chars, 0);
      assert_eq!(status.limit_chars, MANUAL_MEMORY_LIMIT_CHARS);
      assert!(!status.truncated);
  }

  #[test]
  fn create_manual_memory_is_exclusive_and_leaves_memory_unadmitted() {
      let created = create_manual_memory(Some(memories.path()), cwd.path()).unwrap();
      assert_eq!(created.state, ManualMemoryAdmissionState::AvailableNotAdmitted);
      assert_eq!(std::fs::read_to_string(&created.path).unwrap(), "# Elpis Memory\n");
      set_continuity_source_admitted(Some(memories.path()), cwd.path(), "MEMORY.md", true).unwrap();
      std::fs::write(&created.path, "user content").unwrap();
      assert!(matches!(
          create_manual_memory(Some(memories.path()), cwd.path()),
          Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists
      ));
      assert_eq!(std::fs::read_to_string(&created.path).unwrap(), "user content");
  }
  ```

  Also add one 8,001-character Unicode-safe fixture asserting `AvailableNotAdmitted`, `injected_chars == 8_000`, `limit_chars == 8_000`, and `truncated == true`; then explicitly admit it and assert only the enum state changes to `Admitted`.

- [ ] **Step 2: Record the required fail-first command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core --lib elpis_context::tests::manual_memory`

  Expected initial result: compilation failure because the status type/helpers do not exist. Do not execute it in this stage.

- [ ] **Step 3: Implement the minimal projection and exclusive creation.**

  Put `MANUAL_MEMORY_LIMIT_CHARS` beside the current `MAX_RULE_CHARS` and make the memory branch of `source_char_limit` use that named constant. Derive `path` once from `memories_root.join("MEMORY.md")`; read metadata/content only when the file exists; count trimmed Rust `char`s before and after the existing truncation helper. `create_manual_memory` must `create_dir_all(memories_root)`, use `OpenOptions::write(true).create_new(true)` on that exact path, write the literal template, `sync_all`, then derive/return the status. Do not call `set_continuity_source_admitted`, alter `admission.toml`, or replace an existing file.

- [ ] **Step 4: Make the existing source list agree with the status.**

  Retain `ContinuitySource` and its existing API for non-memory rows. When `manual_memory_status` is `Missing`, add a selectable durable-memory placeholder row with zero bytes/tokens and `admitted = false`; when present, retain the existing real `MEMORY.md` source row. The Ledger must obtain its display state from `manual_memory_status`, not infer missingness from a missing `ContinuitySource`. This preserves current callers while making `missing` visible.

- [ ] **Step 5: Run the deferred focused core check only at functional close, inspect its output, and commit.**

  Deferred expected result: all new missing/create/race/truncation tests pass, with no test creating admission for the new file. Commit only the explicit paths with:

  ```bash
  git add codex-rs/core/src/elpis_context.rs
  git commit -m "feat: expose truthful manual memory status"
  ```

### Task A2: Prove app-server request admission, withdrawal, and truncation

**Files:**

- Modify: `codex-rs/app-server/tests/suite/v2/memory_recall.rs`
- Modify only if necessary for testability: `codex-rs/app-server/src/extensions.rs`
- Test support: `codex-rs/core/src/elpis_context.rs`

**Consumes:** Task A1 status helpers and the existing `ElpisContinuityExtension` request contribution path.

**Produces:** Request-level proof that the app server, rather than a ledger-only path, obeys manual-memory state.

- [ ] **Step 1: Add failing request-level fixtures.**

  Extend the existing mock Responses capture test with four exact cases:

  1. no `MEMORY.md` yields no `## Elpis Admitted Context` fragment containing the planted marker;
  2. `create_manual_memory` yields `available_not_admitted` and the next request still excludes `MEMORY_CREATE_MARKER`;
  3. explicitly admitting the created file after writing `MEMORY_ADMITTED_MARKER` puts that marker in the outgoing developer fragment, then setting admission false removes it from the immediately following captured request;
  4. an admitted 8,001+ character fixture reports `truncated = true` and the captured source body has exactly 8,000 Rust characters under the existing ellipsis truncation convention, with no character after the capped fragment.

  The test must inspect only the local mock request payload and literal fixture markers. It must not print a real memory file or call a provider.

- [ ] **Step 2: Record the fail-first request command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --test suite -- memory_recall`

  Expected initial result: the create/status/truncation assertions fail before Task A1/A2 implementation is complete. Do not execute it now.

- [ ] **Step 3: Make request construction use the same cap constant and status semantics.**

  Do not add a second injection path or a memory RPC. Keep `ElpisContinuityExtension` calling `build_continuity_prompt_with_dev_rule_roots`. Replace any remaining memory use of the generic `MAX_RULE_CHARS` with `MANUAL_MEMORY_LIMIT_CHARS` through `source_char_limit`; preserve all existing non-memory caps. The builder continues to skip unadmitted/missing content and returns `None` when no admitted content exists.

- [ ] **Step 4: Add an old-state compatibility test.**

  Use an admission file with no `memory` key and assert it loads as unadmitted; use the legacy flat `MEMORY.md = true` fallback and assert it still loads admitted. This protects current user state without silently changing default admission.

- [ ] **Step 5: Run the deferred request check only at functional close, inspect it, and commit.**

  Deferred expected result: positive admission and immediate withdrawal are both demonstrated through the app-server mock request, while missing/create remain negative. Commit with:

  ```bash
  git add codex-rs/core/src/elpis_context.rs codex-rs/app-server/src/extensions.rs codex-rs/app-server/tests/suite/v2/memory_recall.rs
  git commit -m "test: prove manual memory request boundaries"
  ```

### Task A3: Render actionable memory state in the Context Ledger without editing content

**Files:**

- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Modify only if an existing literal-path copy helper requires a narrow public wrapper: `codex-rs/tui/src/clipboard_copy.rs`
- Test: colocated Context Ledger tests or the existing focused TUI ledger test module

**Consumes:** Task A1 `ManualMemoryStatus`; current Ledger selection, admission toggle, and literal clipboard fallback behavior.

**Produces:** A user can see `Missing`, `Available — not admitted`, or `Admitted`; see `0/8000 chars` or `8000/8000 chars — truncated`; create missing memory; and reveal/copy its exact path.

- [ ] **Step 1: Add failing rendered-state and key-action tests.**

  Use temporary `memory_dir` fixtures and assert the rendered ledger text contains all of the following exact semantic states:

  ```text
  MEMORY.md  Missing  0/8000 chars
  MEMORY.md  Available — not admitted  0/8000 chars
  MEMORY.md  Admitted  8000/8000 chars — truncated
  ```

  Add keyboard tests for: `c` on missing calls `create_manual_memory` and leaves the rendered state `Available — not admitted`; Space/Enter then admits it; `p` copies/reveals exactly the canonical path; a `create_new` collision preserves user content and renders an error instead of changing admission. Assert no action places memory body text in ledger history.

- [ ] **Step 2: Record the fail-first TUI command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib context_ledger`

  Expected initial result: the status text and Create/Path key behavior are absent. Do not execute it now.

- [ ] **Step 3: Implement the smallest Ledger-only interaction contract.**

  In focused Ledger mode, reserve `c` for **Create memory** only when the memory row is `Missing`; reserve `p` for **Copy/reveal memory path** for all three states; retain Space/Enter exclusively for explicit admission toggling and never toggle a missing row. Add these keys to the focused hint only when the selected row is memory. `p` uses the existing clipboard result path if available; on clipboard failure it displays the exact path in a transient TUI info/error message, so no desktop/file-manager launch is required. Do not invoke `external_editor`, do not add an edit key, and do not show memory content.

- [ ] **Step 4: Preserve failure and selection behavior.**

  On `create_manual_memory` `AlreadyExists`, refresh the status and preserve the original file; on any other error, preserve selection/admission and show the error. After a successful create, keep the row selected, refresh the context estimate, and leave its admission false. Context source removal keys must continue to reject the discovered canonical memory row.

- [ ] **Step 5: Record deferred full Plan A checks and commit.**

  At functional close only, defer these exact commands through the future verification manifest’s `memory` surface:

  ```bash
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core --lib elpis_context::tests::manual_memory
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --test suite -- memory_recall
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib context_ledger
  ```

  Expected final evidence: all three layers agree on missing/create/admit/withdraw/truncate behavior; any unavailable local check remains explicitly unexecuted. Commit with:

  ```bash
  git add codex-rs/tui/src/chatwidget/context_ledger.rs codex-rs/tui/src/clipboard_copy.rs
  git commit -m "feat: make manual memory usable in context ledger"
  ```

## Plan A acceptance checklist

- A fresh workspace with no file says `missing`, injects nothing, and offers Create.
- Create atomically leaves the exact minimal non-secret file and remains `available_not_admitted`.
- Admission is separate; a planted fact appears only in the app-server request after explicit admission and disappears in the next request after withdrawal.
- A long file makes the 8,000-character cap/truncation visible and the captured request matches the stated cap.
- The TUI exposes only path/status/actions, never content; editor/writeback remains deferred by the stated source blocker.

---

# Plan B — Safe `/agent` Controls and Read-Only Experimental Work Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task and one implementer at a time. This plan has no source dependency on Plan A, but do not start it until Plan A’s review gate is complete because manual memory is the required product priority.

**Goal:** Extend the existing `/agent` surface with authority-checked ordinary-child controls while making the already-persisted work graph inspectable as an off-by-default, experimental, read-only mode.

**Architecture:** Add one typed app-server control RPC which resolves authority server-side from the active root lineage, not from a TUI-selected thread. It owns duplicate coalescing and validates action/status before delegating to existing `AgentControl`. Graph-owned worker actions are rejected visibly in this read-only graph slice, preserving their task transitions unchanged. `/agent` becomes a small two-mode overlay: Agents retains the current picker/navigation and adds controls; Work graph reads the newest graph owned by the active primary root through the existing `workGraph/list` endpoint, with generation-guarded refresh.

**Tech Stack:** Rust app-server protocol v2, app-server request processor, existing core `AgentControl`, persisted SQLite work-graph state, Ratatui TUI selection view.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` §3.4 and §Verification; `.superpowers/daily-driver-audits/agents-memory.md` §§1–2; `docs/WORK_GRAPHS.md`.

## Plan B global constraints

- The primary/coordinator thread is never a target. The server derives it from `root_thread_id`; a client-provided target may not substitute for it.
- Valid targets are only non-primary descendants in the active root lineage. Wrong-root, unrelated, unknown, stale, and primary targets are errors with no core/graph side effect.
- `follow_up` accepts a non-empty message only for an ordinary child; `interrupt` only a running ordinary child; `resume` only a closed ordinary child; `close` only a non-primary ordinary child in a status the existing core operation accepts. Validate again at execution time, not just when the overlay opened.
- Per `(root_thread_id, target_thread_id, action)` an in-flight action has one shared server future/result; duplicate requests coalesce rather than double-send/double-close. Different actions are serialized per target while one is pending.
- `interrupt` and `close` require a TUI confirmation naming the target agent. `follow_up` and `resume` do not. The request runs after confirmation, not when the menu opens.
- For this slice every graph-owned worker control is rejected with the exact visible class `GraphOwnedWorkerReadOnly`; it does not call `AgentControl` and does not mutate the graph. This deliberately satisfies the safe “reject visibly” branch of the spec. Atomic task cancellation/blocking is deferred to a separate graph-control proposal; it must not be smuggled into this read-only plan.
- Work graph inspection is disabled by default and labelled `Experimental · read-only`. It does not enable fanout or schedule any worker. It is not dashboard content.

## Plan B file map and interfaces

| File | Responsibility |
| --- | --- |
| `codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs` (new) | Additive typed RPC parameter/response/error enums with serde/TS/schema derives. |
| `codex-rs/app-server-protocol/src/protocol/v2/mod.rs` | Export the new v2 protocol module. |
| `codex-rs/app-server-protocol/src/protocol/common.rs` | Register the additive `agent/control` method without changing existing methods. |
| `codex-rs/app-server/src/message_processor.rs` | Dispatch `ClientRequest::AgentControl` to the thread processor. |
| `codex-rs/app-server/src/request_processors/thread_processor.rs` | Root-lineage authority, target status checks, duplicate coalescing, graph-owned detection/rejection, and delegation to existing core control. |
| `codex-rs/app-server/src/request_processors/*tests*` | RPC positive/negative/race tests in the existing app-server test convention. |
| `codex-rs/state/src/runtime/work_graphs.rs` | Make root graph list order explicit (newest first) and test root/order behavior. |
| `codex-rs/app-server/src/request_processors/thread_processor.rs` | Continue mapping the ordered list into the existing `WorkGraphListResponse`; do not invent a new graph mutation RPC. |
| `codex-rs/tui/src/app_server_session.rs` | Async typed control client and generation-tagged work-graph list client. |
| `codex-rs/tui/src/app_event.rs`, `codex-rs/tui/src/app/event_dispatch.rs`, `codex-rs/tui/src/app/session_lifecycle.rs` | New overlay events, async result application, and `/agent` two-mode lifecycle. |
| `codex-rs/tui/src/multi_agents.rs` | Focused Agents/Work graph models and renderers, including empty/error/experimental/read-only states. |
| `codex-rs/tui/src/app/tests.rs`, `codex-rs/tui/src/multi_agents.rs` tests | Deterministic authority-result, confirmation, stale-response, and rendering tests. |

The additive RPC contract introduced in Task B1 is:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentControlAction { FollowUp, Interrupt, Resume, Close }

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlParams {
    pub root_thread_id: String,
    pub target_thread_id: String,
    pub action: AgentControlAction,
    #[serde(default)]
    pub follow_up: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentControlTargetStatus { Running, Closed, Interrupted }

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentControlErrorCode {
    PrimaryTargetForbidden, TargetOutsideActiveLineage, TargetNotFound,
    InvalidActionForStatus, EmptyFollowUp, GraphOwnedWorkerReadOnly,
    RequestAlreadyPending, CoreOperationFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlResponse {
    pub target_thread_id: String,
    pub status: AgentControlTargetStatus,
    #[serde(default)]
    pub detail: Option<String>,
}
```

`agent/control` is a new method, so legacy clients remain functional because they never call it. Existing `workGraph/list` request/response names and fields stay unchanged. The server enforces root ownership; TUI checks are usability guards only.

### Task B1: Add fail-first, additive app-server authority control

**Files:**

- Create: `codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/mod.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/common.rs`
- Modify: `codex-rs/app-server/src/message_processor.rs`
- Modify: `codex-rs/app-server/src/request_processors/thread_processor.rs`
- Test: existing app-server request-processor test module nearest `work_graph_list`/thread lifecycle tests

**Consumes:** Existing root-scoped `AgentControl`, its `send_input`, `interrupt_agent`, resume, and close methods; existing persisted lineage and state DB graph-task assignment data.

**Produces:** A server-authoritative `agent/control` route and a stable error/result contract used by Task B3.

- [ ] **Step 1: Write protocol compatibility and authority tests before source changes.**

  Add serialization/deserialization cases proving: (a) old `WorkGraphListResponse` JSON without any new fields still parses; (b) all four new actions parse with `follow_up: null`; (c) an unknown action fails decoding; and (d) `AgentControlResponse` without optional `detail` parses with `detail == None`.

  In a harness with a root, ordinary child, unrelated root child, closed child, and graph-owned worker, add exact server tests:

  ```text
  root + interrupt/close/resume/follow_up => PrimaryTargetForbidden
  unrelated-root target => TargetOutsideActiveLineage
  unknown target => TargetNotFound
  running child + resume => InvalidActionForStatus
  closed child + interrupt => InvalidActionForStatus
  ordinary child + blank follow_up => EmptyFollowUp
  graph-owned worker + each action => GraphOwnedWorkerReadOnly; no AgentControl call; task status unchanged
  ```

  Add positive spies showing follow-up calls existing `send_input` once with the supplied message, interrupt calls existing `interrupt_agent` once, resume calls the existing closed-agent resume path once, and close calls the existing close path once. Add a two-request barrier test showing duplicate interrupt requests share one underlying call/result and do not freeze a second unrelated request.

- [ ] **Step 2: Record fail-first commands without running them.**

  Deferred commands:

  ```bash
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server-protocol --lib agent_control
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --lib agent_control
  ```

  Expected initial result: method/types are unresolved and no authority route exists. Do not execute now.

- [ ] **Step 3: Add the protocol as a strictly additive v2 method.**

  Put the exact contract above in `v2/agent_control.rs`, export it, and register `AgentControl => "agent/control"` in the same `ClientRequest` macro/style used by `WorkGraphList`. Preserve the generated TypeScript/schema attributes used by sibling v2 request types. No existing JSON field or endpoint changes.

- [ ] **Step 4: Implement authority and coalescing in the app server, not TUI.**

  In the thread processor: resolve the requested root to its active `AgentControl`; enumerate its live/persisted descendant lineage; reject before delegation if target is root/not a descendant/not found. Obtain graph task ownership by assigned thread ID from state for that root; if owned, return `GraphOwnedWorkerReadOnly` without changing state. Validate action against a fresh target status, then register a per-target pending entry before awaiting the core call. A matching in-flight key awaits/reuses that result; a different action for the same target gets `RequestAlreadyPending`. Remove the entry on success, validation failure after registration, or core error. Map core failures to `CoreOperationFailed` with a safe short detail; do not leak prompts, transcript content, or paths.

- [ ] **Step 5: Commit protocol/server authority slice.**

  Deferred expected result: each positive uses exactly one intended core method; all negative/race/graph-owned cases leave the wrong thread and graph unchanged. Commit:

  ```bash
  git add codex-rs/app-server-protocol/src/protocol/v2/agent_control.rs codex-rs/app-server-protocol/src/protocol/v2/mod.rs codex-rs/app-server-protocol/src/protocol/common.rs codex-rs/app-server/src/message_processor.rs codex-rs/app-server/src/request_processors/thread_processor.rs
  git commit -m "feat: add authoritative agent control rpc"
  ```

### Task B2: Make existing work-graph listing newest, root-owned, and read-only-safe

**Files:**

- Modify: `codex-rs/state/src/runtime/work_graphs.rs`
- Modify: `codex-rs/app-server/src/request_processors/thread_processor.rs`
- Test: colocated `codex-rs/state/src/runtime/work_graphs.rs` tests and existing app-server work-graph list tests

**Consumes:** Existing `list_work_graphs_for_root`, `WorkGraphListParams { root_thread_id }`, graph/task/event persistence.

**Produces:** `workGraph/list` returns only the requested root’s graphs in a documented newest-first order; old clients retain the same schema.

- [ ] **Step 1: Add failing order/isolation/transition-integrity tests.**

  Persist two graphs for root A at different creation times and one newer graph for root B. Assert root A list is `[newer_a, older_a]`, never contains root B, and an absent state DB returns `data: []`. Exercise a graph-owned worker rejection through Task B1’s route and assert its task remains running, every descendant retains its pre-request status, and no additional graph transition event exists. This is the integrity proof for the intentionally read-only branch.

- [ ] **Step 2: Record the fail-first command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-state --lib work_graph`

  Expected initial result: list order is not guaranteed and the new isolation/transition cases fail. Do not execute now.

- [ ] **Step 3: Make ordering explicit at persistence boundary.**

  Modify only `list_work_graphs_for_root` SQL to filter by `root_thread_id` and order `created_at DESC, id DESC`. Do not change schema or graph transition methods. Keep `work_graph_list` mapping all existing task/evidence/failure fields exactly as today; it must not call any mutator.

- [ ] **Step 4: Preserve old protocol behavior.**

  Keep `WorkGraphListResponse { data: Vec<WorkGraphSummary> }` unchanged. Add a regression test decoding a legacy list response and a request test that an empty `data` is a successful response, not an RPC error. The TUI will select `data.first()` only because Task B2 establishes it is newest.

- [ ] **Step 5: Commit the read-only ordering contract.**

  Deferred expected result: root isolation, deterministic newest selection, empty success, and rejected graph-worker control all pass. Commit:

  ```bash
  git add codex-rs/state/src/runtime/work_graphs.rs codex-rs/app-server/src/request_processors/thread_processor.rs
  git commit -m "fix: order root work graphs newest first"
  ```

### Task B3: Add `/agent` controls with confirmation and non-stale asynchronous results

**Files:**

- Modify: `codex-rs/tui/src/app_server_session.rs`
- Modify: `codex-rs/tui/src/app_event.rs`
- Modify: `codex-rs/tui/src/app/event_dispatch.rs`
- Modify: `codex-rs/tui/src/app/session_lifecycle.rs`
- Modify: `codex-rs/tui/src/multi_agents.rs`
- Test: `codex-rs/tui/src/app/tests.rs` and/or the nearest existing multi-agent overlay tests

**Consumes:** Task B1 typed RPC and Task B2 ordered `workGraph/list`; existing `/agent` selection and `Alt+Left/Right` navigation.

**Produces:** Agents mode offers follow-up/interrupt/resume/close for the selected ordinary child and only applies a completed result to the still-current root/target/generation.

- [ ] **Step 1: Add failing interaction tests.**

  Construct deterministic TUI/app-server fakes and assert:

  1. `/agent` opens in **Agents** mode and preserves current row selection and Alt+Left/Right behavior;
  2. selected running child: `i` opens a confirmation naming that child; declining sends no request; confirming sends `AgentControlAction::Interrupt` for that exact ID;
  3. selected ordinary child: `f` opens a follow-up composer; blank submit sends no RPC; non-empty submit sends only that child/message;
  4. selected closed ordinary child exposes `r`; `x` requires target-named confirmation; primary row has no action affordance;
  5. server error leaves the same selection/status intact and renders its safe error;
  6. a late result after selection/root changes is discarded; a newer refresh cannot be overwritten by an older completion;
  7. an in-flight action visibly disables that target action but unrelated selection/navigation remains responsive.

  Name the focused test entry points `agent_view_preserves_navigation_and_targets_confirmed_child`, `agent_view_rejects_blank_follow_up_and_preserves_server_failure`, and `agent_view_discards_stale_async_results`; the deferred `agent_view_` filter below must match all three.

- [ ] **Step 2: Record the fail-first TUI command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib agent_view_`

  Expected initial result: no typed TUI control event/confirmation state exists. Do not execute now.

- [ ] **Step 3: Add a minimal nonblocking overlay model.**

  In `multi_agents.rs`, define a local `AgentViewMode { Agents, WorkGraph }`, `PendingAgentControl { root_thread_id, target_thread_id, action, generation }`, and confirmation/follow-up input state. Use one compact key legend: `f Follow-up`, `i Interrupt`, `r Resume`, `x Close`, `1 Agents`, `2 Work graph`, `Esc Back`. Only show permitted actions for the selected ordinary child. Render the explicit target label in confirmation copy. Do not alter global key bindings or graph authoring.

- [ ] **Step 4: Wire lifecycle and result guards.**

  Add app events for opening confirmation, submitting/cancelling it, sending the control request, receiving its result, opening Work graph mode, refreshing graph data, and receiving graph data. `AppServerSession::agent_control` sends the new RPC asynchronously. Increment a per-overlay generation whenever root/target/mode changes or refresh starts; apply a response only if root, target (for control), mode, and generation still match. Refresh selection/status only after successful response. On error, clear only the pending indicator and display the server’s safe detail.

- [ ] **Step 5: Commit the Agents control surface.**

  Deferred expected result: confirmation, exact targeting, failure handling, and stale-result protection pass while the TUI event loop stays responsive. Commit:

  ```bash
  git add codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/app_event.rs codex-rs/tui/src/app/event_dispatch.rs codex-rs/tui/src/app/session_lifecycle.rs codex-rs/tui/src/multi_agents.rs codex-rs/tui/src/app/tests.rs
  git commit -m "feat: control ordinary agents from agent view"
  ```

### Task B4: Surface the newest work graph as experimental, read-only, and refreshable

**Files:**

- Modify: `codex-rs/tui/src/app/session_lifecycle.rs`
- Modify: `codex-rs/tui/src/multi_agents.rs`
- Modify: `codex-rs/tui/src/app_server_session.rs`
- Modify: `codex-rs/tui/src/app/tests.rs`
- Modify only if no equivalent feature gate exists: the existing feature registry/config source that controls experimental TUI exposure

**Consumes:** Task B2 newest-first root list and Task B3 two-mode generation guard.

**Produces:** Off-by-default Work graph mode displays the newest root-owned persisted graph and its tasks/dependencies/evidence/blockers/history, but never sends a mutation/control request.

- [ ] **Step 1: Add failing Work graph rendering and async-state tests.**

  Assert these states exactly:

  ```text
  Work graph — Experimental · read-only
  No work graph exists for this agent lineage.
  Work graph data unavailable: <safe server error>
  Refreshing work graph…
  ```

  Use a two-graph response and assert only `data.first()` (the Task B2 newest graph) renders. Assert tasks include status, dependencies, evidence, failure reason/blocker, and event count; never render graph task instructions, prompt bodies, or mutation controls. Add a stale-response test: request A begins, request B begins/returns, then A returns; B remains rendered. Add a feature-off test: key `2` shows an explanatory experimental-disabled state and sends no `workGraph/list` request. Add a graph-owned selected worker test: actions show the read-only rejection affordance/error and no control request is sent.

- [ ] **Step 2: Record the fail-first TUI command without running it.**

  Deferred command: `cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib work_graph`

  Expected initial result: `/agent` appends a one-time history cell and has no tab/mode/refresh/stale guard. Do not execute now.

- [ ] **Step 3: Replace the one-time history append with a mode-local read-only view.**

  Remove only the `open_agent_picker` behavior that appends `work_graph_history_cell(response.data.first())` to chat history. Keep the `workGraph/list` client method, but call it only when the experimental Work graph mode is opened or `r` refresh is requested. The view header always says `Experimental · read-only`; it exposes `r Refresh` and `1 Agents`, no execute/cancel/retry/author controls. A missing graph is a normal empty state; RPC failure is an error state with prior valid data retained only if it belongs to the same root/generation.

- [ ] **Step 4: Keep the graph disabled by default.**

  Reuse a current feature registry mechanism if it can represent an experimental, default-false TUI inspector. If none exists, add exactly one `WorkGraphInspector` feature flag defaulting false and surface it only through the existing feature configuration/experimental visibility path. This flag gates inspection only; it does not change the existing `enable_fanout` runtime gate. Add a config deserialization regression test proving missing legacy config keeps it false.

- [ ] **Step 5: Record deferred Plan B checks and commit.**

  At functional close only, defer these commands through the future `agents-work-graph` and `app-server` verification surfaces:

  ```bash
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-state --lib work_graph
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server-protocol --lib agent_control
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --lib agent_control
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --lib work_graph
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib agent_view_
  cd codex-rs && CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib work_graph
  ```

  Expected final evidence: old protocol/config fixtures deserialize; empty/error/disabled/live-refresh states are distinguishable; stale responses cannot regress display; graph inspection sends no mutation request. Commit:

  ```bash
  git add codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/app/session_lifecycle.rs codex-rs/tui/src/multi_agents.rs codex-rs/tui/src/app/tests.rs
  git commit -m "feat: inspect work graphs from agent view"
  ```

## Plan B acceptance checklist

- `/agent` remains the only command and preserves transcript switching/Alt navigation.
- An ordinary selected child receives only the explicitly chosen control after server lineage/status validation and, for interrupt/close, a target-named confirmation.
- The coordinator, an unrelated/stale target, and invalid statuses cannot be controlled; duplicate actions coalesce without freezing the TUI.
- Graph-owned workers are visibly rejected in this read-only candidate, and the rejection leaves their task plus descendants transition-identical.
- Work graph inspection is off by default, labelled experimental/read-only, uses the newest graph for the active root, supports safe refresh, and correctly distinguishes disabled, empty, loading, stale/error, and loaded states.
- No graph authoring, generic swarm, automatic worktree/branch integration, or dashboard surface is added.

## Deferred integration gate

After code review of each task and only after the broader daily-driver functional issues are closed, use the repository-owned verification manifest’s memory and agents-work-graph surfaces plus its conservative full Linux surface. Follow `docs/LOCAL_BUILD_RULES.md` first, including target-disk inspection. Do not claim either plan complete from this draft or from unexecuted commands; Masih’s manual acceptance of the TUI workflows remains the final gate.

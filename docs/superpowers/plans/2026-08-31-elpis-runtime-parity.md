# DD-RUNTIME-PLAN-DRAFT: Elpis Runtime Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the pinned Codex donor's native compaction threshold/headroom behavior on Elpis's shared regular-turn path, make Ctrl-C nonblocking and retryable after failure, make pruning cancellation-safe and explicitly opt-in, and expose the automatic-pruning state without redesigning the dashboard.

**Architecture:** Port Codex's model-window and nonblocking-interrupt seams rather than recreating their policy. Keep native compaction, manual Ace pruning, and opt-in automatic Ace pruning as distinct flows: the compaction task always takes the native summarization lifecycle; the prune task alone owns Ace history mutation; and feature metadata owns the setting's name, warning, default, and discovery. Publish one additive boolean in the existing dashboard snapshot as the handoff contract for the later typed-dashboard plan; do not alter the current HTML/dashboard layout in this plan.

**Tech Stack:** Rust workspace (`codex-rs/core`, `protocol`, `features`, `tui`), Tokio cancellation/tasks, app-server JSON-RPC, Ratatui settings popup, Serde dashboard snapshot, existing Rust unit/integration/snapshot tests, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` (Stage 1); `.superpowers/daily-driver-audits/runtime-parity.md`.

## Goal-specific evidence and decisions

- Implement against Codex donor commit `a9519cbcdd2d664530edb2469224ee03c1056799`; port the nonblocking-interrupt precedent from ancestor commit `62ba648136c7e60b9380c40b60cb553a7d8eb1ab`.
- Port the donor's shared regular-turn compaction semantics exactly, including its centralized config/model helper and configured-limit behavior: in `Total` scope the model metadata's `auto_compact_token_limit()` owns the limit, while the configured limit remains the donor's `BodyAfterPrefix` behavior. Do not retain Elpis's 60%/40%-remaining backstop. The pinned donor's model-specific helper is called only by a guardian review path that this Elpis checkout does not contain; record that source difference rather than claiming parity for an absent donor-only subsystem.
- Remove `Config::elpis_compact_cleanup` and its compact route. Ordinary `/compact` remains native summarization; it must never invoke manual pruning as a hidden compaction phase.
- Treat the user's Headroom reference as the donor's built-in usable-window headroom. No separate Headroom integration exists in this checkout, so none is planned.
- First Ctrl-C cancels an active turn without awaiting app-server I/O on the UI loop. Repeated Ctrl-C for that same turn coalesces. Retain one stale-turn retry and visible warning delivery. Clear pending state on matching lifecycle events and, unlike the donor's stuck-failure edge, clear only the matching reservation after final RPC failure so a later Ctrl-C can retry. Do not change top-level shutdown unless a later failing test or the measured parity comparison proves a residual divergence.
- Automatic Ace pruning is `Experimental` and disabled by default. `/prune` and `/force-prune <1-100>` remain independent manual operations.

## Global constraints

- One implementer owns one task at a time. Do not run Task N+1 until Task N's fail-first test source, independent diff review, and commit are complete. Rust execution remains deferred to the final functional-close batch. Tasks 3 and 4 both touch TUI app routing: execute them serially.
- Preserve unrelated worktree state. Stage only the exact files named by the completed task; never use `git add -A`.
- Start every behavior change with a failing focused Rust test. A new test must prove both its positive behavior and its negative/no-op case where stated below.
- The exact automatic-pruning warning copy is: `Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.` Do not paraphrase it in settings or configuration documentation.
- The feature label is exactly `Automatic pruning — Experimental`. Because persisted settings do not mutate the active core session, the future dashboard rendering contract is exactly `Automatic pruning next conversation: Off` or `Automatic pruning next conversation: On · Experimental`.
- The only dashboard work here is the additive data interface described in Task 5. Do not edit `codex-rs/tui/src/dashboard_assets/index.html`, add current-layout snapshots, or implement the typed-dashboard/observability redesign.
- Existing manifests/checkpoints and raw rollouts remain evidence. This plan does not rewrite historic rollout data. Test updates may replace only tests for the removed dormant cleanup route; normal native compaction and manual-prune resume coverage must remain.
- Documentation describes implemented semantics and limits, not unmeasured latency, pruning quality, cache benefit, or Headroom-product compatibility.
- All Rust commands below are deferred until execution. Run them from `codex-rs`. Before any Cargo command, read `docs/LOCAL_BUILD_RULES.md`, capture the pre-existing failure baseline, inspect target disk use, and retain the exact `CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo ... --locked` wrapper shown below.

## Source-only interim checks for every task

Run these after each implementation step and before its commit; they do not build, launch, modify configuration, or start a process:

```bash
git diff --check
git diff -- <only files named by the task>
git status --short
```

At the end of the implementation sequence, run only the deferred Rust checks listed in the final verification section. Do not claim runtime latency, process-exit parity, or user acceptance from source/unit results.

---

### Task 1: Port donor context-window and usable-headroom semantics

**Files:**

- Modify: `codex-rs/core/src/session/context_window.rs`
- Modify: `codex-rs/protocol/src/openai_models.rs` only if it lacks the donor-compatible `ModelInfo::{resolved_context_window,usable_context_window,auto_compact_token_limit}` behavior already present at the pinned donor revision
- Modify: `codex-rs/tui/src/main.rs` only to remove/update the stale comment that names the deleted Elpis 40%-remaining constant
- Modify: colocated `#[cfg(test)]` modules in the two files above

**Interfaces:**

- Consumes: `ModelInfo::resolved_context_window() -> Option<i64>`, `ModelInfo::auto_compact_token_limit() -> Option<i64>`, `ModelInfo::effective_context_window_percent`, `Config::model_auto_compact_token_limit_scope`, and `AutoCompactTokenLimitScope::{Total,BodyAfterPrefix}`.
- Produces: the donor-shaped `context_window_token_status_with_config(...)` seam and `context_window_token_status(...) -> ContextWindowTokenStatus` whose `auto_compact_scope_limit` and `full_context_window_limit` follow shared regular-turn donor semantics. `full_context_window_limit` is the usable window, not the raw window.
- Invariant: for resolved window `272_000`, 95% usable headroom is `258_400` and the automatic-compaction threshold is `244_800`; a configured model limit is clamped by the donor's 90%-of-resolved-window rule.

- [ ] **Step 1: Write failing parity tests before changing runtime code.**

  Replace the Elpis-only 60% assertions with donor-compatible fixtures in the smallest existing test modules. Cover all of these independently:

  ```rust
  assert_eq!(model.resolved_context_window(), Some(272_000));
  assert_eq!(model.usable_context_window(), Some(258_400));
  assert_eq!(model.auto_compact_token_limit(), Some(244_800));
  ```

  Add context-window status fixtures for:

  ```text
  Total/default model metadata -> 244_800 threshold, 258_400 hard usable cap
  Total/explicit config limit -> same model-owned donor limit (not the config override)
  BodyAfterPrefix/explicit config limit -> explicit limit, measured after prefill
  missing context_window + max_context_window -> fallback model resolution
  unknown window -> no synthetic Elpis threshold or cap
  ```

- [ ] **Step 2: Run the focused tests to prove the current 60% implementation fails.**

  Deferred execution command:

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core context_window --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-protocol model_context_window_limits_preserve_their_distinct_meanings --lib --locked
  ```

  Expected before implementation: the old `155_040` / `103_360` assertions or Total-scope configured-limit expectation conflicts with the new donor fixtures.

- [ ] **Step 3: Port the donor calculation exactly.**

  In `context_window.rs`, replace the Elpis helper and all 60% fallback precedence with the donor's centralized `context_window_token_status_with_config(sess, config, model_info)` structure. This Elpis revision exposes `model_info` as a field, so the public-in-module regular-turn wrapper passes `turn_context.config.as_ref()` and `&turn_context.model_info`:

  ```rust
  // Total scope: model metadata owns the threshold.
  (active_context_tokens, model_info.auto_compact_token_limit(), None)

  // Full-window ceiling: donor usable headroom, not raw config window.
  let full_context_window_limit = model_info.usable_context_window();
  ```

  Preserve the existing fallback-buffer behavior, token accounting fields, and `BodyAfterPrefix` explicit-config behavior. Remove `ELPIS_COMPACT_REMAINING_PERCENT`, `elpis_auto_compact_token_limit`, their Elpis-specific tests, and comments that call 60% a safety backstop, including the stale default-injection comment in `tui/src/main.rs`. If the contained protocol model methods differ from donor `a9519…`, port only those model methods and their donor tests; do not create a second Elpis resolver. Do not add the donor's `context_window_token_status_for_model` as unused code: its only donor caller is in a guardian review subsystem absent from Elpis.

- [ ] **Step 4: Perform source-only parity review.**

  ```bash
  rg -n 'ELPIS_COMPACT_REMAINING_PERCENT|elpis_auto_compact_token_limit|155_040|103_360|40%-remaining' codex-rs --glob '!target/**'
  git diff --check
  ```

  Expected: no old helper/constant/test value/comment remains; no second Total-scope precedence is introduced. The preflight's pinned-donor source evidence records the donor-only guardian caller as an explicit source difference, rather than silently copying a helper without its subsystem.

- [ ] **Step 5: Run the focused tests after implementation.**

  Re-run Step 2's commands. Expected: pass, including default, model-specific, explicit-override, unknown-window, and scoped-accounting fixtures.

- [ ] **Step 6: Commit.**

  ```bash
  git add codex-rs/core/src/session/context_window.rs codex-rs/protocol/src/openai_models.rs codex-rs/tui/src/main.rs
  git commit -m "fix(context): port donor compaction window semantics"
  ```

  If `openai_models.rs` was already donor-compatible and unchanged, omit it from the explicit `git add` command.

### Task 2: Delete the dormant cleanup compaction route without changing native lifecycle

**Files:**

- Modify: `codex-rs/core/src/config/mod.rs`
- Modify: `codex-rs/core/src/compact.rs`
- Modify: `codex-rs/core/src/tasks/compact.rs`
- Modify: `codex-rs/core/tests/common/test_codex.rs`
- Modify: `codex-rs/core/tests/suite/compact.rs`
- Modify: `codex-rs/thread-manager-sample/src/main.rs`

**Interfaces:**

- Consumes: `CompactTask::run(...)`, `Config::compact_prompt`, native local/remote compact selection, and the existing manual-prune API.
- Produces: one `/compact` behavior: the normal native summarizer/lifecycle (or existing native remote compact branch) selected by the inherited compact code. `Config` has no `elpis_compact_cleanup` field.
- Preserves: manual `PruneTask` and `/prune`; remote compaction and TokenBudget branches; `CodexErr::TurnAborted` propagation.

- [ ] **Step 1: Replace cleanup-route tests with a failing native-route regression.**

  Refactor `run_compact_preservation_scenario` into a generic native-route scenario that can run with or without `Op::Compact`. Keep `compact_preservation_control_without_compaction_keeps_all_markers` wired to its no-compact branch unchanged. Replace only the two cleanup-manifest cases (`compact_preserves_critical_markers_and_removes_redundant_noise` and `malformed_cleanup_manifest_preserves_everything`) plus their manifest fixtures with one explicitly named compact branch, `native_compact_uses_summarization_without_elpis_cleanup_route`. In its red form, retain `config.elpis_compact_cleanup = true` but invert the expectation: submitting `Op::Compact` must use `SUMMARIZATION_PROMPT`, must not contain `CLEANUP_PROMPT`, and must not issue an Ace-prune request. This is intentionally red against the hidden alternate route. After removing the field and branch, delete only the now-impossible field assignment and cleanup-manifest fixtures while keeping the native-route/control assertions. Keep the separate normal compact lifecycle, history-shape, custom-prompt, and manual-prune tests; do not delete unrelated snapshot coverage.

  Required assertion shape:

  ```rust
  assert!(body_contains_text(&compact_body, SUMMARIZATION_PROMPT));
  assert!(!body_contains_text(&compact_body, CLEANUP_PROMPT));
  assert_eq!(requests.len(), expected_native_compact_request_count);
  ```

- [ ] **Step 2: Run the focused compact test and prove the dormant route is currently reachable only through code/test configuration.**

  Deferred execution command:

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite --locked
  ```

  Expected before implementation: the explicit hidden flag selects `CLEANUP_PROMPT`, so the inverted native-route assertion fails. After implementation the flag assignment is removed because the field no longer exists, while the same native-route assertions pass.

- [ ] **Step 3: Remove the field and branch.**

  Delete `Config::elpis_compact_cleanup`, its default/test setup, all `CleanupCandidate`/`CleanupRecord` parsing and `run_cleanup_compact_task` code in `core/src/compact.rs`, and the `cleanup_enabled` branch in `CompactTask::run`. Remove the sample struct field in `thread-manager-sample`. Retain the inherited prompt constant/template only if needed by a compatibility/export surface; it must have no runtime caller. The remaining local input is exactly:

  ```rust
  text: ctx.config.compact_prompt
      .as_deref()
      .unwrap_or(crate::compact::SUMMARIZATION_PROMPT)
      .to_string(),
  ```

  Preserve the current TokenBudget and remote-compaction branches. Do not route `/compact` through `run_manual_context_prune`.

- [ ] **Step 4: Check all internal callers and historic-test compatibility.**

  ```bash
  rg -n 'elpis_compact_cleanup|CLEANUP_PROMPT' codex-rs --glob '!target/**'
  git diff --check
  ```

  Expected: no field/runtime caller remains. A static inherited cleanup prompt may remain only as an unused compatibility/export surface; normal historical `CompactedItem` rollout fixtures remain unchanged because their schema is not this route's configuration.

- [ ] **Step 5: Run focused regression checks.**

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core compact --test suite --locked
  ```

  Expected: native compaction requests retain normal summarization; manual `/prune` tests still exercise the separate task.

- [ ] **Step 6: Commit.**

  ```bash
  git add codex-rs/core/src/config/mod.rs codex-rs/core/src/compact.rs codex-rs/core/src/tasks/compact.rs codex-rs/core/tests/common/test_codex.rs codex-rs/core/tests/suite/compact.rs codex-rs/thread-manager-sample/src/main.rs
  git commit -m "fix(compact): remove dormant Elpis cleanup route"
  ```

### Task 3: Port nonblocking active-turn interruption

**Files:**

- Modify: `codex-rs/tui/src/app/thread_events.rs`
- Modify: `codex-rs/tui/src/app/thread_routing.rs`
- Modify: `codex-rs/tui/src/app_server_session.rs`
- Modify: `codex-rs/tui/src/app/tests.rs`
- Modify: `codex-rs/tui/src/app/tests/safety_buffering.rs`

**Interfaces:**

- Consumes: `AppCommand::Interrupt`, `App::active_turn_id_for_thread`, `AppServerSession::request_handle`, `AppServerSession::next_request_id`, `active_turn_interrupt_race`, and `ServerNotification` lifecycle events.
- Produces: `ThreadEventStore::pending_interrupt_turn_id: Option<String>` and a nonblocking `try_submit_active_thread_op_via_app_server(...) -> Result<bool>` interrupt path.
- Contract: reserve the active turn ID before spawning; coalesce when `pending_interrupt_turn_id == active_turn_id`; retry exactly once when the app server reports a different active turn; deliver final failure as `Failed to interrupt turn: {error}` warning; clear pending state on matching `TurnCompleted` and `ThreadClosed`; after final RPC failure clear only the reservation that still matches the failed turn ID so a later Ctrl-C can retry.

- [ ] **Step 1: Port the donor's gated-RPC regression test first.**

  Adapt `active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests` from donor commit `62ba648…` into `tui/src/app/tests/safety_buffering.rs`. It must gate the `turn/interrupt` response, send Ctrl-C twice, assert one request ID is consumed, inject a warning notification while the response remains gated, and then assert that matching completion clears pending state.

  Required assertions include:

  ```rust
  assert_eq!(store.pending_interrupt_turn_id.as_deref(), Some(turn_id.as_str()));
  assert_eq!(app_server.next_request_id(), AppServerRequestId::Integer(next_request_id + 1));
  assert!(matches!(app_event_rx.try_recv(), Ok(AppEvent::InsertHistoryCell(_))));
  assert_eq!(pending_interrupt_turn_id, None);
  ```

  Add the donor no-active-turn/backtrack-reset assertion to `tui/src/app/tests.rs`. Add `failed_active_turn_interrupt_clears_pending_and_allows_retry`: force the final RPC attempt to fail, assert the exact warning is delivered and pending state is cleared, press Ctrl-C again while the same turn remains active, and assert a fresh request ID is consumed.

- [ ] **Step 2: Run the focused test to show that the current inline await blocks it.**

  Deferred execution command:

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib --locked
  ```

  Expected before implementation: the test cannot observe its injected notification until the gated `turn_interrupt(...).await` returns, or it consumes a second request for duplicate Ctrl-C.

- [ ] **Step 3: Port the donor state and request-handle implementation.**

  Add and initialize `pending_interrupt_turn_id`; update `push_notification` so matching completion clears it and thread close clears both active and pending IDs. Make `AppServerSession::next_request_id` `pub(crate)` exactly as the donor does. In the interrupt arm:

  ```rust
  let request_handle = app_server.request_handle();
  let request_ids = [app_server.next_request_id(), app_server.next_request_id()];
  tokio::spawn(async move { /* donor typed turn/interrupt request and one stale-ID retry */ });
  ```

  Use `TurnInterruptParams`, `TurnInterruptResponse`, `ClientRequest::TurnInterrupt`, and `WarningNotification` from the donor patch. Reset backtrack state before return. The spawned task owns failures; it must enqueue the visible warning and must not return an RPC error through the event loop. On final failure, while holding the thread store lock, clear `pending_interrupt_turn_id` only when it still equals the final attempted turn ID, then record/deliver the warning. Do not clear a newer reservation.

- [ ] **Step 4: Source-review the liveness and cleanup invariants.**

  ```bash
  rg -n -C 3 'pending_interrupt_turn_id|turn_interrupt\(|tokio::spawn|Failed to interrupt turn' codex-rs/tui/src/app codex-rs/tui/src/app_server_session.rs
  git diff --check
  ```

  Expected: no await of `turn_interrupt` remains in the `AppCommand::Interrupt` UI routing path; there is exactly one pending field and exactly one retry loop; both lifecycle completion and final failure have matching-ID cleanup.

- [ ] **Step 5: Run focused TUI tests.**

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui failed_active_turn_interrupt_clears_pending_and_allows_retry --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui interrupt_without_active_turn_is_treated_as_handled --lib --locked
  ```

  Expected: delayed RPC does not block a later UI event, duplicates coalesce, stale retry/failure route remains visible, and pending state clears on lifecycle notification.

- [ ] **Step 6: Commit.**

  ```bash
  git add codex-rs/tui/src/app/thread_events.rs codex-rs/tui/src/app/thread_routing.rs codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/app/tests.rs codex-rs/tui/src/app/tests/safety_buffering.rs
  git commit -m "fix(tui): make active-turn interrupts nonblocking"
  ```

### Task 4: Make prune cancellation atomic across streams, commits, and task completion

**Files:**

- Modify: `codex-rs/core/src/tasks/prune.rs`
- Modify: `codex-rs/core/src/session/context_prune.rs`
- Modify: `codex-rs/core/src/session/handlers.rs`
- Modify: `codex-rs/core/src/tasks/mod.rs`
- Modify: `codex-rs/core/src/state/turn.rs`
- Modify: `codex-rs/core/src/test_support.rs`
- Test: `codex-rs/core/tests/suite/context_prune.rs`
- Test: `codex-rs/core/src/tasks/mod_tests.rs`
- Test: `codex-rs/core/src/session/tests.rs`

**Interfaces and invariants:**

- Manual `PruneTask` threads its cancellation token through the pruning stream. Automatic pressure pruning retains `None` and its existing feature gate.
- Cancellation before a pass claims its commit boundary causes no fallback request, history replacement, checkpoint/audit/report write, covered-call update, saved-token update, or applied-pass increment.
- A pass that has atomically begun committing finishes that pass. A simultaneous interrupt records stop-after-commit, reports the completed work as `TurnComplete`, and prevents the next batch. A normal committed pass re-arms cancellation before the next batch.
- Task completion uses one atomic five-state lifecycle: Pending, AbortRequested, Normal, IntentionalAbort, Abnormal. AbortRequested is nonterminal; Abnormal is terminal and can never be relabelled as a user abort.
- Late interrupts after abnormal completion enter recovery instead of the normal `TurnAborted` path. Recovery may clear only the exact installed task, matched by completion, turn-state, and turn-context identity; a replacement active turn is never cleared.

- [x] **Step 1: Add deterministic gated regression sources.**

  The tests cover cancellation before mutation, re-arming before a later batch, interrupt during commit, transition latching, genuine requested abort, late abort after normal completion, and a real session task that panics before a later interrupt. Gates use channels/notifications rather than timing sleeps.

- [x] **Step 2: Implement stream cancellation and the pass-scoped commit boundary.**

  A dedicated cancelled result stops retry/fallback. The mutation sequence is guarded by `TaskCancellationBoundary`; `finish_commit` either re-arms the next pass or returns stop-after-commit.

- [x] **Step 3: Implement panic-safe task completion and pointer-matched recovery.**

  One `AtomicU8` owns abort intent and terminal outcome. `take_active_turn_for_abort` distinguishes requested, already-finished, and abnormal tasks; abnormal recovery requires all three stored identities and emits no false abort lifecycle.

- [x] **Step 4: Pass fresh independent source review.**

  Review the complete source slice at commits `f7e5a2a`, `0364701`, and `86ee247`, including every caller of the changed task/turn helpers. Reject hangs, abnormal-to-intentional relabeling, unlocked mutation paths, loss of between-pass re-arming, or replacement-turn clearing.

  ```bash
  git show --check f7e5a2a
  git show --check 0364701
  git show --check 86ee247
  rg -n -C 5 'CancellationToken|TaskCancellationBoundary|TaskCompletion|state\.history\.replace|persist_rollout_items' codex-rs/core/src/tasks codex-rs/core/src/session codex-rs/core/src/state/turn.rs
  ```

- [ ] **Step 5: Run the deferred focused checks only at functional close.**

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint --test suite --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core manual_prune --test suite --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core tasks::tests --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core interrupt_recovers_latched_abnormal_task_without_turn_aborted --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core automatic_prune_is_disabled_by_default --test suite --locked
  ```

  Expected: all deterministic cancellation/completion tests pass; manual and default-off automatic pruning remain independent. Runtime evidence remains deferred until this source slice and later functional tasks close.

**Source commits:** `f7e5a2a` (atomic mutation boundary), `0364701` (between-pass re-arm and latched completion), and `86ee247` (single-state abnormal-safe completion/recovery).

### Task 5: Expose automatic pruning as persisted Experimental metadata and publish its dashboard contract

**Files:**

- Modify: `codex-rs/features/src/lib.rs`
- Modify: `codex-rs/features/src/tests.rs`
- Modify: `codex-rs/core/src/session/mod.rs`
- Modify: `codex-rs/core/src/session/tests.rs`
- Modify: `codex-rs/tui/src/bottom_pane/experimental_features_view.rs`
- Modify: `codex-rs/tui/src/chatwidget/settings_popups.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs`
- Modify: `codex-rs/tui/src/slash_command.rs`
- Modify: `codex-rs/tui/src/dashboard_server.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/app/tests.rs`
- Modify: tests colocated with `dashboard_server.rs` and `context_usage.rs` as needed

**Interfaces:**

- Consumes: `Feature::stage()`, `Feature::default_enabled()`, `Feature::key()`, `FEATURES`, `AppEvent::UpdateFeatureFlags`, `App::update_feature_flags`, and `DashboardSnapshot` serialization.
- Produces: `AutomaticContextPruning` metadata at `Stage::Experimental { name, menu_description, announcement }`, one metadata-derived automatic-pruning settings row appended to the existing `Keep computer awake` row, and additive `DashboardSnapshot { automatic_pruning_configured_for_next_conversation: bool, .. }` JSON. It does not expose unrelated Experimental registry entries such as Network proxy.
- Network contract: automatic pruning is local Elpis behavior. Enabling it must not add `automatic_context_pruning` to the OpenAI `x-codex-beta-features` header; the existing server-advertised feature behavior remains unchanged.
- Dashboard handoff contract: the later typed-dashboard plan consumes the configured-value boolean and renders `Automatic pruning next conversation: Off` when false and `Automatic pruning next conversation: On · Experimental` when true. This task does not render those strings in current `index.html` and does not claim to change the active thread's feature gates.
- Persistence contract: opening or cancelling `/settings`, and accepting without a changed row, emit no update and perform no write. Accepting changes emits only the changed rows through the existing `UpdateFeatureFlags` route. Enabling persists `[features] automatic_context_pruning = true`; disabling a default-false feature removes that key through the existing config edit helper, and config reload resolves it Off. Manual `/prune` remains enabled regardless of the flag. Saved settings apply to the next conversation; live feature-gate updates for an active core session are out of scope.

- [x] **Step 1: Write feature, settings-discovery, persistence, and JSON-contract test sources.**

  Add/assert all of the following:

  ```rust
  assert_eq!(Feature::AutomaticContextPruning.default_enabled(), false);
  assert_eq!(
      Feature::AutomaticContextPruning.stage(),
      Stage::Experimental {
          name: "Automatic pruning — Experimental",
          menu_description: "Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.",
          announcement: "",
      }
  );
  ```

  Render `/settings` through `ChatWidget::open_experimental_popup()` and assert it retains `Keep computer awake`, contains both exact automatic-pruning strings below, and does not expose `Network proxy`:

  ```text
  Automatic pruning — Experimental
  Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.
  ```

  Assert `/settings` is included in `built_in_slash_commands()` rather than only parseable/hidden. Add view-level tests proving Esc, Ctrl-C, and unchanged accept emit no feature events, while accepting one changed row emits only that row and cannot overwrite a stale sibling value. In `tui/src/app/tests.rs`, toggle the automatic-pruning row, accept it, run the real existing `App::update_feature_flags` persistence path in a temp `codex_home`, and assert the written TOML contains `automatic_context_pruning = true`; then disable it, assert the key is absent, reload config, and assert the feature resolves Off. Reopen/read config and assert Off remains the default without user action. Add the explicitly named `dashboard_snapshot_serializes_automatic_pruning_configuration` test: serialize `DashboardSnapshot` and assert its new configured-for-next-conversation boolean is present with exact false and true values. Add `automatic_context_pruning_is_local_only_in_beta_header`: enabling only the local pruning flag must not add its key to the model-client beta header, while a known server-advertised feature must still be present. This test must fail if the local key leaks or if the existing positive path is accidentally disabled.

- [ ] **Step 2: Run focused tests and show current gaps.**

  Deferred execution commands:

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core automatic_context_pruning_is_local_only_in_beta_header --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui experimental --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui settings --lib --locked
  ```

  Expected before implementation: the stage is `UnderDevelopment`; settings has only `PreventIdleSleep`; `/settings` is excluded from discovered slash commands; JSON has no automatic-pruning field.

- [x] **Step 3: Make registry metadata the single user-facing source.**

  Change only the `AutomaticContextPruning` `FeatureSpec` to:

  ```rust
  stage: Stage::Experimental {
      name: "Automatic pruning — Experimental",
      menu_description: "Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.",
      announcement: "",
  },
  default_enabled: false,
  ```

  In `open_experimental_popup`, retain the existing explicit `Feature::PreventIdleSleep` / `Keep computer awake` row. Then use only `Feature::AutomaticContextPruning` and its `stage()` metadata to derive that row's name/description through `experimental_menu_name()` / `experimental_menu_description()`, plus `self.config.features.enabled(feature)`. Do not iterate `FEATURES`: Network proxy and other unrelated features remain hidden. Do not add hard-coded automatic-pruning copy outside its metadata.

  In `Session::build_model_client_beta_features_header`, exclude only `Feature::AutomaticContextPruning` from advertisement before the existing Experimental/`RemoteCompactionV2` selection. Do not broaden the exclusion or change any existing advertised key. The focused core test owns this local/server boundary.

- [x] **Step 4: Restore `/settings` discovery and make the existing popup write only real changes.**

  Change `built_in_slash_commands()` visibility only so the already parsing/dispatching `SlashCommand::Experimental` (`/settings`) is discoverable. In the shared `ExperimentalFeaturesView`, retain each row's initial value: Esc/Ctrl-C emit nothing, unchanged accept emits nothing, and changed accept emits only changed rows. Keep the command string and existing popup/event route. Do not add a new slash command or config store; `AppEvent::UpdateFeatureFlags`, `App::update_feature_flags`, and the existing default-aware config edit helper remain the sole persistence path. Do not special-case automatic pruning in the helper: true is explicit, while disabling this default-false feature clears its key and reloads as Off.

- [x] **Step 5: Add the additive dashboard data field only.**

  Extend the snapshot and publisher:

  ```rust
  pub(crate) automatic_pruning_configured_for_next_conversation: bool,
  // publish the effective TUI config after persistence/override resolution,
  // not Task 4's active-turn execution state
  ```

  Give the field Serde's existing snake_case output (`automatic_pruning_configured_for_next_conversation`). Add a narrow serialization/publisher test. Derive it from the TUI's effective configuration after successful persistence and any override resolution, never from the raw requested toggle, Task 4's pass/commit state, saved tokens, or prune history. It reports what a newly started conversation will use, not whether automatic pruning is active or completed in the current thread.

- [x] **Step 6: Source-review metadata, discovery, persistence, and interface boundaries.**

  ```bash
  rg -n -C 3 'Automatic pruning — Experimental|Distills completed tool output|AutomaticContextPruning|automatic_pruning_configured_for_next_conversation' codex-rs/features codex-rs/core/src/session codex-rs/tui
  rg -n -C 3 'initial|changed|UpdateFeatureFlags' codex-rs/tui/src/bottom_pane/experimental_features_view.rs
  rg -n -C 2 'settings' codex-rs/tui/src/slash_command.rs
  git diff --check
  ```

  Expected: exact automatic-pruning copy appears only through metadata and docs; settings retains Keep computer awake, derives only the automatic-pruning addition from the named feature, excludes Network proxy, and writes only changed rows; the local pruning key is absent from the OpenAI beta-feature header while existing advertised keys remain; the dashboard asset remains untouched; no current snapshot UI claims active-thread enablement or automatic completion.

- [ ] **Step 7: Run focused feature/TUI checks.**

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core automatic_context_pruning_is_local_only_in_beta_header --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui experimental --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui update_feature_flags --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui dashboard_snapshot_serializes_automatic_pruning_configuration --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui renamed_commands_use_elpis_names --lib --locked
  ```

  Expected: off by default; cancel/no-change writes nothing; explicit enable persists true; disable removes the key and reloads Off; `/settings` is discoverable; manual prune tests continue to pass while the flag is off; dashboard JSON has the configured-for-next-conversation Boolean contract.

- [x] **Step 8: Commit.**

  ```bash
  git add codex-rs/features/src/lib.rs codex-rs/features/src/tests.rs codex-rs/core/src/session/mod.rs codex-rs/core/src/session/tests.rs codex-rs/tui/src/bottom_pane/experimental_features_view.rs codex-rs/tui/src/chatwidget/settings_popups.rs codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs codex-rs/tui/src/slash_command.rs codex-rs/tui/src/dashboard_server.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/app/tests.rs
  git commit -m "feat(prune): expose experimental automatic pruning setting"
  ```

**Source commit/review:** `bc8f18f`; fresh independent source/static review passed. Deferred Rust checks and Masih's manual acceptance remain open.

### Task 6: Keep manual status distinct and correct Stage 1 documentation

**Files:**

- Modify: `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/chatwidget/turn_runtime.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/slash_commands.rs`
- Modify: tests/snapshots colocated with `codex-rs/tui/src/chatwidget/context_usage.rs` if status text changes snapshots
- Modify comments only: `codex-rs/core/src/context_pruner.rs`
- Modify comments only: `codex-rs/core/src/session/context_prune.rs`
- Modify comments only: `codex-rs/core/src/session/context_prune_audit.rs`
- Modify: `docs/context.md`
- Modify: `docs/cache-friendly-pruning.md`
- Modify: `docs/prompt-caching.md`
- Modify: `docs/assets/elpis-context-control.svg`
- Modify: `readme.md`

**Interfaces:**

- Consumes: explicit `SlashCommand::{Prune,ForcePrune}`, existing prune tracking, `Feature::AutomaticContextPruning`, native compact semantics from Tasks 1–2, and the dashboard contract from Task 5. Start only after Task 5's `context_usage.rs` change passes review.
- Produces: transient manual-command start/completion language that calls the action manual; failure/interrupt cleanup that cannot leak manual tracking into a later turn; neutral persistent savings/accounting text; truthful documentation for immediate manual native `/compact`, threshold-triggered automatic native compaction, manual `/prune`/`/force-prune`, and opt-in experimental automatic pruning.
- Does not produce: a dashboard HTML redesign, new dashboard pages/snapshots, a new command, a Headroom integration, a top-level shutdown policy, or an automatic pruning success claim.

- [ ] **Step 1: Write failing manual-status and documentation regression tests.**

  Extend existing slash-command/context-usage tests so `/prune` and `/force-prune` retain their exact operation routing while transient feedback includes `Manual pruning` and contains no `Automatic pruning` state claim. Only start copy distinguishes ordinary from forced targeting. A normal terminal event says only `Manual pruning command finished`; it must not claim success, application, or savings because core also completes normally after a no-op or swallowed prune failure. Start manual tracking, interrupt/fail the turn through `finalize_turn`, then complete an unrelated turn and prove no stale `RequestContextUsageReport` or manual-completion message is emitted. Keep cumulative saved-token rendering neutral: it may say Ace pruning reclaimed tokens, but never identifies those totals as manual or automatic. Replace the false no-pass explanation with a neutral state such as `No Ace pruning totals recorded yet`; it must not claim the context is below an automatic trigger.

  No documentation-test convention exists here. Do not invent one. The task's static source review must reject claims that `/compact` is Elpis cleanup, `/prune` is a `/compact` phase, the audit value `pressure` proves automatic invocation, or manual `/compact` waits for a model-window threshold.

- [ ] **Step 2: Run focused TUI tests before implementation.**

  Deferred execution commands:

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_prune --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_force_prune --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui manual_prune_tracking --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui context_usage --lib --locked
  ```

  Expected before implementation: direct manual routing works, but status tracking is generic and current documentation falsely describes `/compact` as the cleanup/prune route.

- [ ] **Step 3: Make transient manual feedback explicit and clear it on every terminal path.**

  Preserve these existing op contracts:

  ```rust
  AppEvent::CodexOp(Op::Prune { target_pct: None })
  AppEvent::CodexOp(Op::Prune { target_pct: Some(target_pct) })
  ```

  Make the initial strings identify manual pruning and distinguish forced targeting when `target_pct` is present. The normal terminal string is exactly neutral about outcome: `Manual pruning command finished`; neither the TUI Boolean nor core `TurnCompleted` proves an applied/successful pass. Continue to request the existing post-prune context report only after a normally completed tracked command. In the shared failed/interrupted `finalize_turn` path, clear `context_prune_report_pending` before a later turn can inherit it. Do not consult `Feature::AutomaticContextPruning` in slash dispatch: its enabled state must not gate manual operation. `last_prune_saved_tokens` is cumulative across Ace passes, so persistent `/context` and dashboard totals stay origin-neutral and never derive automatic/manual state from that number.

- [ ] **Step 4: Update documentation and source comments to the new truth.**

  Make these exact distinctions consistently:

  ```text
  Manual `/compact`: runs Codex native summarization/lifecycle immediately when invoked.
  Automatic native compaction: uses the donor model-window threshold and usable-window headroom.
  Manual `/prune` and `/force-prune`: explicit Ace actions, independent of automatic setting; force-prune's `pressure` audit value names its targeted selection strategy, not automatic invocation.
  Automatic pruning — Experimental: off by default; saved through visible `/settings` for the next conversation; uses the exact warning copy; may run before native compaction only in a conversation started with it enabled.
  ```

  Remove all claims that `/compact` runs an Elpis cleanup pass, invokes Ace pruning first, uses Luna Max to delete conversation messages, is available only after Ace fails, or is an opt-out from cleanup. Replace the stale four-layer language with the actual three context-control mechanisms plus distinct native compaction. Correct the architecture SVG so native compaction is independent, not a pruning-only fallback. Update stale source comments that still name removed layer/steady-trigger behavior. Retain the cautious, source-backed pruning limitations and never state that automatic pruning improves task success, cost, cache reuse, or latency.

  In `docs/prompt-caching.md`, state that audit `trigger = "pressure"` records the targeted selection strategy and cannot by itself identify automatic invocation because manual `/force-prune` uses the same strategy. In README evaluation history, label the reported automatic runs as configured historical runs with automatic pruning enabled under the superseded high-frequency setup; do not present them as current default behavior.

- [ ] **Step 5: Source-review user copy and removed claims.**

  ```bash
  rg -n -C 2 '/compact|/prune|Automatic pruning|automatic_context_pruning|cleanup|CLEANUP_PROMPT|Luna Max|4-Layer|steady backlog|trigger floor|configured historical runs|superseded high-frequency|"trigger": "pressure"' docs/context.md docs/cache-friendly-pruning.md docs/prompt-caching.md docs/assets/elpis-context-control.svg readme.md codex-rs/core/src/context_pruner.rs codex-rs/core/src/session/context_prune.rs codex-rs/core/src/session/context_prune_audit.rs codex-rs/tui/src/chatwidget
  git diff --check
  ```

  Expected: docs use the exact warning and distinguish manual compact, automatic native compaction, manual Ace, and opt-in automatic Ace; no user-facing cleanup-route/fallback-only claim remains; `pressure` is described as a selection strategy; manual tracking clears on failure/interrupt; cumulative accounting stays origin-neutral; settings never imply that saving the flag mutates the active conversation.

- [ ] **Step 6: Run focused tests and inspect the documentation diff.**

  ```bash
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_prune --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_force_prune --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui manual_prune_tracking --lib --locked
  CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui context_usage --lib --locked
  ```

  Then inspect only:

  ```bash
  git diff -- docs/context.md docs/cache-friendly-pruning.md docs/prompt-caching.md docs/assets/elpis-context-control.svg readme.md codex-rs/core/src/context_pruner.rs codex-rs/core/src/session/context_prune.rs codex-rs/core/src/session/context_prune_audit.rs
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add codex-rs/tui/src/chatwidget/slash_dispatch.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/chatwidget/turn_runtime.rs codex-rs/tui/src/chatwidget/tests/slash_commands.rs codex-rs/core/src/context_pruner.rs codex-rs/core/src/session/context_prune.rs codex-rs/core/src/session/context_prune_audit.rs docs/context.md docs/cache-friendly-pruning.md docs/prompt-caching.md docs/assets/elpis-context-control.svg readme.md
  git commit -m "fix(prune): align manual status and documentation"
  ```

## Deferred final Rust verification and acceptance handoff

Run these only after Tasks 1–6 are individually committed, after reading `docs/LOCAL_BUILD_RULES.md`, checking target disk size, and capturing known pre-existing failures. These commands are intentionally not part of this planning task.

This final batch is the accumulated union of every deferred task command; no per-task Rust command is run earlier.

```bash
du -sh codex-rs/target
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo check --workspace --all-targets --exclude codex-sandboxing --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core context_window --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-protocol model_context_window_limits_preserve_their_distinct_meanings --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core compact --test suite --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint --test suite --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core manual_prune --test suite --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core tasks::tests --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core interrupt_recovers_latched_abnormal_task_without_turn_aborted --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core automatic_prune_is_disabled_by_default --test suite --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core automatic_context_pruning_is_local_only_in_beta_header --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui failed_active_turn_interrupt_clears_pending_and_allows_retry --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui interrupt_without_active_turn_is_treated_as_handled --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui experimental --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui settings --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui update_feature_flags --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui dashboard_snapshot_serializes_automatic_pruning_configuration --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui renamed_commands_use_elpis_names --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_prune --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui slash_force_prune --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui manual_prune_tracking --lib --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui context_usage --lib --locked
```

Then perform the Stage 1 manual acceptance on a disposable state directory: default automatic pruning must cause no automatic pass; `/settings` must show the exact Experimental row, write nothing on cancel/no-change, persist explicit enablement, remove the key on disable, and truthfully say the saved value applies to the next conversation; `/prune` and `/force-prune` must still work with it off; ordinary `/compact` must follow normal native summarization; Ctrl-C during a delayed active turn must keep the UI responsive and repeated Ctrl-C must coalesce. The future typed-dashboard task must consume `automatic_pruning_configured_for_next_conversation` and render the two exact next-conversation strings before dashboard acceptance is claimed.

Do not alter top-level shutdown based on this plan. The separate direct non-tmux PTY comparison (five runs per interrupt/exit state; healthy Elpis median within 250 ms of Codex and no healthy exit over three seconds) is required only after this source/test slice demonstrates a measured residual difference or as the spec's later candidate-evaluation gate.

## Coverage review and real blockers

| Requirement | Task(s) |
| --- | --- |
| Donor context resolution, threshold, usable headroom, explicit configured-limit behavior | 1 |
| Delete 60% backstop and `elpis_compact_cleanup`; preserve native `/compact` | 1, 2 |
| Nonblocking first Ctrl-C, coalescing, stale retry, warning, pending clear | 3 |
| Cancel before prune mutation | 4 |
| Default-off Experimental feature, metadata-derived `/settings`, persistence, manual independence | 5, 6 |
| Dashboard state interface without throwaway redesign | 5 |
| Manual completion/status distinction and documentation truth | 6 |
| No speculative Headroom or top-level-shutdown change | global constraints and acceptance handoff |

There is no remaining implementation blocker for this runtime plan: the user decision resolves configured-limit semantics and treats Headroom as built-in usable-window headroom. Runtime latency and process-exit values remain unmeasured and are explicitly deferred; they are not grounds to change shutdown now. Dashboard visual acceptance remains owned by the later typed-dashboard plan, which must consume the documented JSON field.

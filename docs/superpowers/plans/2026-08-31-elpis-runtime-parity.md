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
- The feature label is exactly `Automatic pruning — Experimental`. The future dashboard rendering contract is exactly `Automatic pruning: Off` or `Automatic pruning: On · Experimental`.
- The only dashboard work here is the additive data interface described in Task 5. Do not edit `codex-rs/tui/src/dashboard_assets/index.html`, add current-layout snapshots, or implement the typed-dashboard/observability redesign.
- Existing manifests/checkpoints and raw rollouts remain evidence. This plan does not rewrite historic rollout data. Test updates may replace only tests for the removed dormant cleanup route; normal native compaction and manual-prune resume coverage must remain.
- Documentation describes implemented semantics and limits, not unmeasured latency, pruning quality, cache benefit, or Headroom-product compatibility.
- All Rust commands below are deferred until execution. Before any Cargo command, read `docs/LOCAL_BUILD_RULES.md`, capture the pre-existing failure baseline, inspect target disk use, and prefix every command with `CODEX_SKIP_BWRAP_BUILD=1`.

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
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core context_window --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-protocol model_context_window_limits_preserve_their_distinct_meanings --lib
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
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite
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
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core compact --test suite
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
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib
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
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui failed_active_turn_interrupt_clears_pending_and_allows_retry --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui interrupt_without_active_turn_is_treated_as_handled --lib
  ```

  Expected: delayed RPC does not block a later UI event, duplicates coalesce, stale retry/failure route remains visible, and pending state clears on lifecycle notification.

- [ ] **Step 6: Commit.**

  ```bash
  git add codex-rs/tui/src/app/thread_events.rs codex-rs/tui/src/app/thread_routing.rs codex-rs/tui/src/app_server_session.rs codex-rs/tui/src/app/tests.rs codex-rs/tui/src/app/tests/safety_buffering.rs
  git commit -m "fix(tui): make active-turn interrupts nonblocking"
  ```

### Task 4: Make manual prune cancellation stop before any history mutation

**Files:**

- Modify: `codex-rs/core/src/tasks/prune.rs`
- Modify: `codex-rs/core/src/session/context_prune.rs`
- Modify: `codex-rs/core/tests/suite/context_prune.rs`
- Modify: colocated unit tests in `codex-rs/core/src/session/context_prune.rs` only if a private stream helper needs direct cancellation coverage

**Interfaces:**

- Consumes: `PruneTask::run(..., cancellation_token: CancellationToken)`, `run_manual_context_prune_with_target`, the model stream, and the current atomic mutation sequence beginning with `state.history.replace(...)`.
- Produces: cancellation-aware manual prune helpers. Automatic pressure calls pass no cancellation token and retain their existing behavior. A cancelled manual stream returns without fallback inference, history replacement, prune checkpoint persistence, covered-call updates, saved-token updates, applied-pass accounting, or latest-report write.
- Required private result distinction: cancellation must be distinguishable from a provider/parse failure so `run_prune_pass` does not attempt the fallback model after cancellation.

- [ ] **Step 1: Write a gated-stream failing regression test.**

  In `core/tests/suite/context_prune.rs`, use the existing mock response machinery to start a manual prune, gate the pruning stream after it starts, cancel the task token, then release the stream. Assert all negative invariants as well as the positive precondition:

  ```text
  precondition: candidate batch and prune request were created
  after cancellation: raw working history equals its pre-prune copy
  after cancellation: no CompactedItem::context_prune_checkpoint_message exists
  after cancellation: context_prune_saved_tokens and covered_call_ids are unchanged
  after cancellation: no fallback pruning-model request is issued
  ```

  Name the test `manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint`.

- [ ] **Step 2: Run the focused test to prove a late stream can currently commit.**

  Deferred execution command:

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint --test suite
  ```

  Expected before implementation: `PruneTask::run` discards `_cancellation_token`, and the delayed response can reach `state.history.replace(...)` and checkpoint persistence.

- [ ] **Step 3: Thread cancellation through the manual path and make the stream responsive to it.**

  Change the manual API to accept an optional token and retain automatic callers as `None`:

  ```rust
  pub(crate) async fn run_manual_context_prune_with_target(
      sess: &Arc<Session>,
      turn_context: &Arc<TurnContext>,
      target_pct: Option<i64>,
      cancellation_token: Option<&CancellationToken>,
  )
  ```

  `PruneTask::run` passes `Some(&_cancellation_token)`. Propagate the option to `run_context_prune`, `run_prune_pass`, `try_validated_prune_pass`, and `try_stream_prune_pass`. Use `tokio::select!` between `cancellation_token.cancelled()` and each awaited stream item. Return a dedicated private cancelled outcome, stop retry/fallback on that outcome, and re-check cancellation immediately before the first mutation (`apply_prune_record_untracked` / `state.history.replace`).

  Do not write a failure audit for user cancellation and do not mark the batch covered. Provider/parse failures retain the current fail-open audit/backoff behavior.

- [ ] **Step 4: Source-check the mutation boundary.**

  ```bash
  rg -n -C 5 'CancellationToken|is_cancelled|cancelled\(|state\.history\.replace|persist_rollout_items' codex-rs/core/src/tasks/prune.rs codex-rs/core/src/session/context_prune.rs
  git diff --check
  ```

  Expected: the manual token reaches the stream and an explicit cancellation check precedes every state/rollout mutation path; automatic entry points remain feature-gated and token-free.

- [ ] **Step 5: Run cancellation plus existing manual/automatic regression checks.**

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint --test suite
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core manual_prune --test suite
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core automatic_prune_is_disabled_by_default --test suite
  ```

  Expected: the cancellation test passes; direct manual prune and default-off automatic pruning remain independent.

- [ ] **Step 6: Commit.**

  ```bash
  git add codex-rs/core/src/tasks/prune.rs codex-rs/core/src/session/context_prune.rs codex-rs/core/tests/suite/context_prune.rs
  git commit -m "fix(prune): prevent cancelled passes from mutating history"
  ```

### Task 5: Expose automatic pruning as persisted Experimental metadata and publish its dashboard contract

**Files:**

- Modify: `codex-rs/features/src/lib.rs`
- Modify: `codex-rs/features/src/tests.rs`
- Modify: `codex-rs/tui/src/chatwidget/settings_popups.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs`
- Modify: `codex-rs/tui/src/slash_command.rs`
- Modify: `codex-rs/tui/src/dashboard_server.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/app/tests.rs`
- Modify: tests colocated with `dashboard_server.rs` and `context_usage.rs` as needed

**Interfaces:**

- Consumes: `Feature::stage()`, `Feature::default_enabled()`, `Feature::key()`, `FEATURES`, `AppEvent::UpdateFeatureFlags`, `App::update_feature_flags`, and `DashboardSnapshot` serialization.
- Produces: `AutomaticContextPruning` metadata at `Stage::Experimental { name, menu_description, announcement }`, one metadata-derived automatic-pruning settings row appended to the existing `Keep computer awake` row, and additive `DashboardSnapshot { automatic_pruning_enabled: bool, .. }` JSON. It does not expose unrelated Experimental registry entries such as Network proxy.
- Dashboard handoff contract: the later typed-dashboard plan consumes the boolean and renders `Automatic pruning: Off` when false and `Automatic pruning: On · Experimental` when true. This task does not render those strings in current `index.html`.
- Persistence contract: opening `/settings` merely reads current state; accepting a toggle sends the existing `UpdateFeatureFlags` route, persists `[features] automatic_context_pruning = true|false`, and leaves manual `/prune` enabled regardless of the flag.

- [ ] **Step 1: Write failing feature, settings-discovery, persistence, and JSON-contract tests.**

  Add/assert all of the following:

  ```rust
  assert_eq!(Feature::AutomaticContextPruning.default_enabled(), false);
  assert!(matches!(Feature::AutomaticContextPruning.stage(), Stage::Experimental { .. }));
  ```

  Render `/settings` through `ChatWidget::open_experimental_popup()` and assert it retains `Keep computer awake`, contains both exact automatic-pruning strings below, and does not expose `Network proxy`:

  ```text
  Automatic pruning — Experimental
  Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.
  ```

  Assert `/settings` is included in `built_in_slash_commands()` rather than only parseable/hidden. In `tui/src/app/tests.rs`, toggle the automatic-pruning row, accept it, run the real existing `App::update_feature_flags` persistence path in a temp `codex_home`, and assert the written TOML contains `automatic_context_pruning = true`; then disable it and assert `false` persists. Reopen/read config and assert false remains the default without user action. Add the explicitly named `dashboard_snapshot_serializes_automatic_pruning_state` test: serialize `DashboardSnapshot` and assert its new boolean is present with exact false and true values.

- [ ] **Step 2: Run focused tests and show current gaps.**

  Deferred execution commands:

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui experimental --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui settings --lib
  ```

  Expected before implementation: the stage is `UnderDevelopment`; settings has only `PreventIdleSleep`; `/settings` is excluded from discovered slash commands; JSON has no automatic-pruning field.

- [ ] **Step 3: Make registry metadata the single user-facing source.**

  Change only the `AutomaticContextPruning` `FeatureSpec` to:

  ```rust
  stage: Stage::Experimental {
      name: "Automatic pruning — Experimental",
      menu_description: "Distills completed tool output before native compaction. Uses an extra AI call and may slow a turn, reduce prompt cache reuse, or remove useful detail.",
      announcement: "",
  },
  default_enabled: false,
  ```

  In `open_experimental_popup`, retain the existing explicit `Feature::PreventIdleSleep` / `Keep computer awake` row. Then look up only `Feature::AutomaticContextPruning` in `FEATURES` and derive that row's name/description through `stage.experimental_menu_name()` / `experimental_menu_description()` plus `self.config.features.enabled(spec.id)`. Do not iterate every Experimental registry entry: Network proxy and other unrelated features remain hidden. Do not add hard-coded automatic-pruning copy outside its metadata.

- [ ] **Step 4: Restore `/settings` discovery and use existing persistence.**

  Change `built_in_slash_commands()` visibility only so the already parsing/dispatching `SlashCommand::Experimental` (`/settings`) is discoverable. Keep its command string and existing popup/event route. Do not add a new slash command or a new config store; `AppEvent::UpdateFeatureFlags` and `App::update_feature_flags` are the sole persistence path.

- [ ] **Step 5: Add the additive dashboard data field only.**

  Extend the snapshot and publisher:

  ```rust
  pub(crate) automatic_pruning_enabled: bool,
  // publish from self.config.features.enabled(Feature::AutomaticContextPruning)
  ```

  Give the field Serde's existing snake_case output (`automatic_pruning_enabled`). Add a narrow serialization/publisher test. Do not infer the field from saved tokens or prune history: it reports configured mode only, so manual and automatic completion cannot be conflated.

- [ ] **Step 6: Source-review metadata, discovery, persistence, and interface boundaries.**

  ```bash
  rg -n -C 3 'Automatic pruning — Experimental|Distills completed tool output|AutomaticContextPruning|automatic_pruning_enabled' codex-rs/features codex-rs/tui
  rg -n -C 2 'settings' codex-rs/tui/src/slash_command.rs
  git diff --check
  ```

  Expected: exact automatic-pruning copy appears only through metadata and docs; settings retains Keep computer awake, derives only the automatic-pruning addition from registry data, and excludes Network proxy; the dashboard asset remains untouched; no current snapshot UI claims an automatic completion.

- [ ] **Step 7: Run focused feature/TUI checks.**

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui experimental_popup --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui update_feature_flags --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui renamed_commands_use_elpis_names --lib
  ```

  Expected: off by default; explicit enable persists; `/settings` is discoverable; manual prune tests continue to pass while the flag is off; dashboard JSON has the Boolean contract.

- [ ] **Step 8: Commit.**

  ```bash
  git add codex-rs/features/src/lib.rs codex-rs/features/src/tests.rs codex-rs/tui/src/chatwidget/settings_popups.rs codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs codex-rs/tui/src/slash_command.rs codex-rs/tui/src/dashboard_server.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/app/tests.rs
  git commit -m "feat(prune): expose experimental automatic pruning setting"
  ```

### Task 6: Keep manual status distinct and correct Stage 1 documentation

**Files:**

- Modify: `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/slash_commands.rs`
- Modify: tests/snapshots colocated with `codex-rs/tui/src/chatwidget/context_usage.rs` if status text changes snapshots
- Modify: `docs/context.md`
- Modify: `docs/cache-friendly-pruning.md`
- Modify: `readme.md`

**Interfaces:**

- Consumes: explicit `SlashCommand::{Prune,ForcePrune}`, existing prune tracking, `Feature::AutomaticContextPruning`, native compact semantics from Tasks 1–2, and the dashboard contract from Task 5.
- Produces: manual-command start/completion/status language that calls the action manual and does not represent saved tokens as evidence of automatic mode; truthful documentation for native compaction, manual `/prune`, and opt-in experimental automatic pruning.
- Does not produce: a dashboard HTML redesign, new dashboard pages/snapshots, a new command, a Headroom integration, a top-level shutdown policy, or an automatic pruning success claim.

- [ ] **Step 1: Write failing manual-status and documentation regression tests.**

  Extend existing slash-command/context-usage tests so `/prune` and `/force-prune` retain their exact operation routing while manual UI feedback includes `Manual pruning` and never says `Automatic pruning: On`. Add documentation truth checks that fail if `docs/context.md` says `/compact` is Elpis cleanup or `/prune` is a `/compact` phase; use targeted read assertions or a lightweight source-text test only if this repository's existing test conventions support it. Otherwise record documentation exactness in the task's manual diff review rather than creating a new test harness.

- [ ] **Step 2: Run focused TUI tests before implementation.**

  Deferred execution commands:

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_prune --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_force_prune --lib
  ```

  Expected before implementation: direct manual routing works, but status tracking is generic and current documentation falsely describes `/compact` as the cleanup/prune route.

- [ ] **Step 3: Make manual feedback explicit without gating it.**

  Preserve these existing op contracts:

  ```rust
  AppEvent::CodexOp(Op::Prune { target_pct: None })
  AppEvent::CodexOp(Op::Prune { target_pct: Some(target_pct) })
  ```

  Make the initial and completion/status strings identify manual pruning (and forced manual pruning when `target_pct` is present). Continue to request the existing post-prune context report. Do not consult `Feature::AutomaticContextPruning` in slash dispatch: its enabled state must not gate manual operation. Do not derive automatic state from `last_prune_saved_tokens`.

- [ ] **Step 4: Update the three docs to the new truth.**

  Make these exact distinctions consistently:

  ```text
  Native `/compact`: Codex normal summarization/lifecycle and donor model-window threshold.
  Manual `/prune` and `/force-prune`: explicit Ace actions, independent of automatic setting.
  Automatic pruning — Experimental: off by default; configured through visible `/settings`; uses the exact warning copy; may run before native compaction only after explicit enablement.
  ```

  Remove all claims that `/compact` runs an Elpis cleanup pass, invokes Ace pruning first, uses Luna Max to delete conversation messages, or is an opt-out from cleanup. Retain the cautious, source-backed pruning limitations and never state that automatic pruning improves task success, cost, cache reuse, or latency.

- [ ] **Step 5: Source-review user copy and removed claims.**

  ```bash
  rg -n -C 2 '/compact|/prune|Automatic pruning|automatic_context_pruning|cleanup|CLEANUP_PROMPT|Luna Max' docs/context.md docs/cache-friendly-pruning.md readme.md codex-rs/tui/src/chatwidget
  git diff --check
  ```

  Expected: docs use the exact warning and distinguish all three flows; no user-facing cleanup-route claim remains; manual status is not conflated with automatic mode.

- [ ] **Step 6: Run focused tests and inspect the documentation diff.**

  ```bash
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_prune --lib
  CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_force_prune --lib
  ```

  Then inspect only:

  ```bash
  git diff -- docs/context.md docs/cache-friendly-pruning.md readme.md
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add codex-rs/tui/src/chatwidget/slash_dispatch.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/chatwidget/tests/slash_commands.rs docs/context.md docs/cache-friendly-pruning.md readme.md
  git commit -m "docs(context): distinguish native compaction and pruning"
  ```

## Deferred final Rust verification and acceptance handoff

Run these only after Tasks 1–6 are individually committed, after reading `docs/LOCAL_BUILD_RULES.md`, checking target disk size, and capturing known pre-existing failures. These commands are intentionally not part of this planning task.

This final batch is the accumulated union of every deferred task command; no per-task Rust command is run earlier.

```bash
du -sh codex-rs/target
CODEX_SKIP_BWRAP_BUILD=1 cargo check --workspace --all-targets --exclude codex-sandboxing
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core context_window --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-protocol model_context_window_limits_preserve_their_distinct_meanings --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core native_compact_uses_summarization_without_elpis_cleanup_route --test suite
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core compact --test suite
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core manual_prune_cancellation_before_mutation_preserves_history_and_writes_no_checkpoint --test suite
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core manual_prune --test suite
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core automatic_prune_is_disabled_by_default --test suite
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui active_turn_interrupt_is_nonblocking_and_coalesces_repeated_requests --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui failed_active_turn_interrupt_clears_pending_and_allows_retry --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui interrupt_without_active_turn_is_treated_as_handled --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-features automatic_context_pruning_is_experimental_and_opt_in --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui experimental_popup --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui update_feature_flags --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui dashboard_snapshot_serializes_automatic_pruning_state --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui renamed_commands_use_elpis_names --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_prune --lib
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui slash_force_prune --lib
```

Then perform the Stage 1 manual acceptance on a disposable state directory: default automatic pruning must cause no automatic pass; `/settings` must show the exact Experimental row and persist explicit enablement; `/prune` and `/force-prune` must still work with it off; ordinary `/compact` must follow normal native summarization; Ctrl-C during a delayed active turn must keep the UI responsive and repeated Ctrl-C must coalesce. The future typed-dashboard task must consume `automatic_pruning_enabled` and render the two exact dashboard strings before dashboard acceptance is claimed.

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

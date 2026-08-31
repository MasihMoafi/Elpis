# Truthful Activity Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Each task has one implementer, one review gate, and checkbox tracking.

**Task ID:** DD-ACTIVITY-OBSERVABILITY

**Goal:** Make measured per-turn timing/profile facts and explicitly available backend-cost facts visible in a small, current-session-only Activity tab in the existing local dashboard, without changing turn behavior, enabling cost polling, or exposing private content.

**Architecture:** Core emits a dedicated scalar-only `TurnProfileEvent` through an explicit non-persisting delivery method after immutable timing completion; existing terminal event structs remain unchanged. The app server converts that transient event into a dedicated ephemeral activity notification, so rollouts and replay cannot restore it. An always-present no-network cost classifier gives every live turn an initial typed status, while the separately optional existing worker can emit a bounded late update only when its current exporter gate already allows polling. The TUI owns a bounded process-session activity model and publishes one versioned dashboard state. The loopback server serves that state read-only with a fact revision and an independent response heartbeat; the static page renders it with DOM node APIs only.

**Tech stack:** Rust, serde, existing core/protocol/app-server notifications, Ratatui TUI state, `tiny_http`, static HTML/CSS/JavaScript, focused Rust unit/fixture tests.

**Spec:**

- `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` sections 3.1–3.3 and Verification and Acceptance
- `docs/superpowers/specs/2026-08-31-turn-cost-latency-observability-design.md`
- `.superpowers/daily-driver-audits/observability-ui.md`

## Preconditions and non-goals

- Start only after the observability import is the integration baseline. This plan relies on its measured `TurnTimingState`, immutable `TurnProfile`, and bounded opt-in `TurnCostWorker`; it does not reimplement them.
- The automatic-pruning owner supplies the already-approved runtime fact as `Option<bool>`. This slice carries that value through `DashboardState` when supplied; it does **not** add the setting, persistence, default, UI control, or new pruning behavior.
- The worker’s existing explicit exporter gate remains authoritative. The always-present classifier performs no I/O and does not imply a worker exists. Dashboard work must not create a worker, start a backend poller, change OTLP settings, or make a request in the default configuration.
- Functional Activity comes before any cyan/palette/spine/animation/whole-product visual work. Keep Context and Tokens working; do not redesign them.
- No browser, app, process, tmux, network, config, build, formatter, Cargo command, installation, release, or push occurs while executing the source-first tasks. Every Rust command below is deferred to the final functional-close verification batch.

## Global constraints

- Carry TTFT and phase timing only as typed optional fields from the measured terminal event. Never infer them from OTLP, rendered transcript cells, tokens, timestamps, model names, or rollout text.
- Preserve old rollout and app-server protocol compatibility. Existing `TurnCompleteEvent`, `TurnAbortedEvent`, thread-history, and `v2::Turn` types gain no profile field. The new `TurnProfileEvent` must use an explicit `persist = false` core delivery path and have a regression proving the rollout omits it. Rollout policy must also classify it as nonpersistent so an accidental future normal-delivery call still cannot make it durable. Existing imported duration/TTFT persistence remains unchanged. Missing live profile means unavailable, never zero.
- Retain no dashboard Activity rows beyond the active process/session. Use `VecDeque` with `ACTIVITY_RECENT_LIMIT = 20`; ignore every replay kind and reset Activity on new session, resume, and visible-thread switch. Do not add a database, rollout activity/profile/cost record, analytics store, cost cache, or browser persistence.
- Subscription authentication renders exactly `Cost unavailable for subscription authentication`. It never produces a price, `$0`, a blank success state, or a backend cost query.
- Other unavailable states are typed. The first-slice wire enum is `SubscriptionAuthentication`, `CostObservationDisabled`, `ProviderUnsupported`, `AwaitingBackendPrice`, `BackendUnavailable`, and `ObservationDropped`; do not send formatted display strings over the app-server protocol.
- A `Priced` value is a backend decimal string accepted by one shared cost parser before either telemetry or UI emission. Accept only an unsigned ASCII decimal, preserve six micro-USD places, round from the seventh digit exactly as the imported R3 contract requires, and require the rounded micro-USD value to fit `i64`; reject signs, whitespace, exponent notation, empty components, malformed digits, and overflow. Preserve the exact accepted backend string for display and label it `Backend-reported`; the dashboard never performs its own conversion, estimate, round, combination, or inference.
- A late price notification is emitted only after the existing worker has accepted a complete backend result and immediately before it removes that tracked entry. It is best-effort and can update only a retained matching row.
- Dashboard data contains scalar timing/count/cost/status facts only. It must never contain prompt/input text, response text, tool arguments or output, command output, account identifiers/email, credentials, trace IDs, source paths, rollout paths, or absolute paths.
- The server is loopback-only and read-only; reject foreign Host values; add `Cache-Control: no-store`, CSP, `X-Content-Type-Options: nosniff`, and frame denial. The browser performs no external request and uses `textContent`/node construction for every dynamic value; no dynamic `innerHTML`.
- `revision` changes only on a semantic state mutation. The response heartbeat is generated independently for every `/data.json` response, so an idle but reachable session is fresh without revision churn. Publishing/serialization/server failure never delays or fails a turn.
- A running-turn projection carries its measured start time as an optional scalar timestamp. The browser computes elapsed time against the response heartbeat; a display timer must not mutate `revision` or require periodic TUI publication.

## File map and interfaces

| Area | Files | Responsibility |
| --- | --- | --- |
| Measured live terminal event | `codex-rs/protocol/src/protocol.rs`, `codex-rs/protocol/src/lib.rs`, `codex-rs/core/src/turn_timing.rs`, `codex-rs/core/src/turn_timing_tests.rs`, `codex-rs/core/src/session/mod.rs`, `codex-rs/core/src/session/tests.rs`, `codex-rs/core/src/session/turn.rs`, `codex-rs/core/src/tasks/mod.rs`, `codex-rs/core/src/tasks/mod_tests.rs`, `codex-rs/rollout/src/policy.rs`, `codex-rs/rollout-trace/src/protocol_event.rs`, `codex-rs/mcp-server/src/codex_tool_runner.rs`, `codex-rs/thread-manager-sample/src/main.rs` | Emit a dedicated transient profile event after immutable completion through explicit non-persisting delivery; keep terminal structs and existing TTFT persistence unchanged; explicitly classify the new exhaustive variant as nonpersistent/no-op outside its live consumer. |
| Ephemeral app-server projection | `codex-rs/app-server-protocol/src/protocol/common.rs`, `codex-rs/app-server/src/bespoke_event_handling.rs`, focused tests | Map only the dedicated transient core event to a live activity notification; never derive it from a terminal event or add it to `v2::Turn` or thread history. |
| Cost status producer | `codex-rs/otel/src/lib.rs`, `otel/src/events/session_telemetry.rs`, focused OTEL tests, `codex-rs/app-server/src/turn_cost_worker.rs`, `turn_cost_worker_tests.rs`, `message_processor.rs`, `outgoing_message.rs`, `request_processors/thread_lifecycle.rs`, `bespoke_event_handling.rs`, focused app-server tests | Share exact R3 decimal parsing, classify every live turn without I/O, keep the poller optional/dormant under subscription auth, and emit initial/late typed status through an already-constructed outgoing route. |
| Activity state owner | `codex-rs/tui/src/activity_state.rs` (new), `chatwidget.rs`, `chatwidget/protocol.rs`, `chatwidget/replay.rs`, `chatwidget/tests.rs`, `chatwidget/tests/app_server.rs`, `chatwidget/tests/history_replay.rs`, `app/app_server_event_targets.rs`, `app/app_server_events.rs`, `app/thread_events.rs`, `app/thread_routing.rs` | Maintain live current/recent state, ignore replay, reset at session/thread boundaries, match late cost updates privately by turn id, evict oldest entries, and request a best-effort dashboard publication. |
| Dashboard state/server | `codex-rs/tui/src/dashboard_server.rs`, `dashboard_server_tests.rs` (new), `chatwidget/context_usage.rs`, `app/event_dispatch.rs` | Replace the raw global context JSON with revisioned `DashboardState`, merge current context facts and activity projection, safely serve response data, and preserve the existing dashboard command. |
| Activity page | `codex-rs/tui/src/dashboard_assets/index.html`, `dashboard_assets/fixtures/activity-state.json` (new), `dashboard_server_tests.rs` | Add functional Activity tab and empty states with frozen fixture/source guards; preserve Context/Tokens without visual redesign. |

The exact cross-layer types are deliberately small:

```rust
// codex-protocol scalar profile type carried only by a transient core event.
pub struct TurnProfileSummary {
    pub before_first_sampling_ms: u64,
    pub sampling_ms: u64,
    pub compaction_ms: u64,
    pub between_sampling_overhead_ms: u64,
    pub tool_blocking_ms: u64,
    pub after_last_sampling_ms: u64,
    pub sampling_request_count: u64,
    pub sampling_retry_count: u64,
}

// Dedicated ephemeral server notification; never part of v2::Turn/thread history.
pub struct TurnActivityUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub status: TurnActivityStatus,
    pub started_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub time_to_first_token_ms: Option<i64>,
    pub profile: Option<TurnProfileSummary>,
}

pub enum TurnCostAvailability {
    SubscriptionAuthentication,
    CostObservationDisabled,
    ProviderUnsupported,
    AwaitingBackendPrice,
    BackendUnavailable,
    ObservationDropped,
}

pub enum TurnCostState {
    Unavailable { reason: TurnCostAvailability },
    Priced { backend_total_usd: String },
}

pub struct TurnCostUpdatedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub cost: TurnCostState,
}
```

`TurnProfileSummary` has no turn id, trace id, messages, or provider data. Both live notifications need a turn id for in-memory matching, but dashboard serialization removes it. The TUI-projected `DashboardTurnSummary` includes only `status`, optional `duration_ms`, optional `time_to_first_token_ms`, optional `profile`, and `cost`.

## Task 1: Carry immutable profile through a transient non-persisting route

**Files:**

- Modify: `codex-rs/protocol/src/protocol.rs`
- Modify: `codex-rs/protocol/src/lib.rs`
- Modify: `codex-rs/core/src/turn_timing.rs`
- Modify: `codex-rs/core/src/turn_timing_tests.rs`
- Modify: `codex-rs/core/src/session/mod.rs`
- Modify: `codex-rs/core/src/session/tests.rs`
- Modify: `codex-rs/core/src/session/turn.rs`
- Modify: `codex-rs/core/src/tasks/mod.rs`
- Modify: `codex-rs/core/src/tasks/mod_tests.rs`
- Modify: `codex-rs/rollout/src/policy.rs`
- Modify: `codex-rs/rollout-trace/src/protocol_event.rs`
- Modify: `codex-rs/mcp-server/src/codex_tool_runner.rs`
- Modify: `codex-rs/thread-manager-sample/src/main.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/common.rs`
- Modify: `codex-rs/app-server/src/bespoke_event_handling.rs`
- Modify: focused tests colocated with `bespoke_event_handling.rs`

**Consumes:** imported `TurnTimingState::complete`, existing `TurnProfile`, existing persisted duration/TTFT fields, core event delivery, and the live app-server event handler.

**Produces:** `TurnProfileSummary`; `EventMsg::TurnProfile(TurnProfileEvent)`; a narrowly named core `send_event_without_persistence(...)` route; and `turn/activityUpdated` carrying terminal status, existing scalar timing, and profile only on the live path. Existing terminal event literals do not change, and no `v2::Turn`, thread-history, or rollout profile field is produced.

- [ ] **Step 1: Write core/protocol RED tests.** In `core/src/tasks/mod_tests.rs`, drive one normal completion and one abort with deterministic `TurnTimingState` profile values. Assert each live stream emits one `TurnProfileEvent` with outcome, existing scalar timing, and all six exact phases/counts, followed by the unchanged terminal event. Assert existing normal-completion TTFT remains unchanged and abort TTFT stays unavailable. In `turn_timing_tests.rs`, assert an unfinished state cannot fabricate a completed profile. Add the exact core session regression `transient_turn_profile_event_is_not_persisted`: capture rollout output and assert it contains the normal terminal event but no `TurnProfileEvent`, profile phases, or request/retry counts. Add the exact rollout-policy regression `turn_profile_events_are_never_persisted`, asserting false in both legacy and paginated history modes.

- [ ] **Step 2: Write app-server live-route RED tests.** Add an exact `turn/activityUpdated` protocol fixture and feed complete/abort `TurnProfileEvent` values through bespoke handling. Assert the outgoing live notification preserves status, duration, existing TTFT, and all profile fields exactly while containing no message body, error body, trace/account/provider/path value, or rollout identifier. Feed ordinary replayed terminal events without a transient profile event and assert no activity notification is emitted.

- [ ] **Step 3: Run the focused checks and verify RED.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core tasks::tests:: --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core turn_timing --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core transient_turn_profile_event_is_not_persisted --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-rollout turn_profile_events_are_never_persisted --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server turn_activity --lib -- --nocapture
```

Expected: the tests fail because live profile fields/notification do not exist; no broad workspace command.

- [ ] **Step 4: Implement the narrow measured route.** Define `TurnProfileSummary` and `TurnProfileEvent` in `codex-protocol`. Add a lossless conversion from imported immutable `TurnProfile` in core and create the transient event only after `complete_profile_and_duration_ms` on normal and abort paths. Add a core method that records/delivers the event through the existing event channel with `persist = false`; it must not call normal `send_event`, materialize a rollout, parent-notify, or create legacy events. Deliver the profile event before the unchanged terminal event so live consumers see deterministic ordering. Do not inspect OTLP or response text. Define the dedicated app-server notification in `protocol/common.rs`; bespoke handling maps only `EventMsg::TurnProfile`. Explicitly add `TurnProfile` to the transient-false arm in rollout policy, both no-trace/no-wrapper arms in rollout trace, the no-model-response arm in core session turn projection, and the ignored arms in the MCP runner and thread-manager sample. Handle any additional compiler-reported exhaustive match only by an explicit transient/no-op case after coordinator review. Do not modify `TurnCompleteEvent`, `TurnAbortedEvent`, `v2::Turn`, `ThreadHistoryTurnChange`, thread reads, or history projection.

- [ ] **Step 5: Run the same focused checks and verify GREEN.** Require literal normal/abort values, sum-preserving existing profile tests, explicit rollout omission, deterministic transient-before-terminal ordering, replay suppression, and no app-server message contents. Also run `git diff --check`.

- [ ] **Step 6: Commit the compatible timing slice.** Stage only Task 1 files and commit:

```bash
git add codex-rs/protocol/src/protocol.rs codex-rs/protocol/src/lib.rs codex-rs/core/src/turn_timing.rs codex-rs/core/src/turn_timing_tests.rs codex-rs/core/src/session/mod.rs codex-rs/core/src/session/tests.rs codex-rs/core/src/session/turn.rs codex-rs/core/src/tasks/mod.rs codex-rs/core/src/tasks/mod_tests.rs codex-rs/rollout/src/policy.rs codex-rs/rollout-trace/src/protocol_event.rs codex-rs/mcp-server/src/codex_tool_runner.rs codex-rs/thread-manager-sample/src/main.rs codex-rs/app-server-protocol/src/protocol/common.rs codex-rs/app-server/src/bespoke_event_handling.rs
git commit -m "feat(activity): project live measured turn timing"
```

## Task 2: Emit typed initial and late cost state without changing polling

**Files:**

- Modify: `codex-rs/app-server-protocol/src/protocol/common.rs`
- Modify: `codex-rs/otel/src/lib.rs`
- Modify: `codex-rs/otel/src/events/session_telemetry.rs`
- Modify: `codex-rs/otel/tests/suite/snapshot.rs`
- Modify: `codex-rs/app-server/src/turn_cost_worker.rs`
- Modify: `codex-rs/app-server/src/turn_cost_worker_tests.rs`
- Modify: `codex-rs/app-server/src/message_processor.rs`
- Modify: `codex-rs/app-server/src/outgoing_message.rs` only if a narrow cloneable late-update notifier cannot use the existing sender without an adapter
- Modify: `codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- Modify: `codex-rs/app-server/src/bespoke_event_handling.rs`
- Modify: focused existing app-server notification tests or create `codex-rs/app-server/src/activity_notifications_tests.rs` and register it from `lib.rs`

**Consumes:** Task 1 live terminal route, current per-turn config, dynamic cached auth state, the imported worker’s provider/exporter gates and accepted priced result just before removal, plus the existing outgoing-message sender.

**Produces:** `TurnCostState`, `TurnCostUpdatedNotification`, `turn/costUpdated`, an always-present internal `TurnCostAvailabilityPolicy` that classifies a started turn without a backend request, and an optional worker handle with a cloneable late-update notifier. The classifier exists even when `TurnCostWorker::spawn()` returns `None`.

- [ ] **Step 1: Write RED protocol/classifier/worker tests.** Add an exact serialized notification fixture:

```json
{"method":"turn/costUpdated","params":{"threadId":"thread-1","turnId":"turn-1","cost":{"type":"unavailable","reason":"subscriptionAuthentication"}}}
```

Assert dynamic subscription auth takes precedence over exporter/provider status and sends this state at turn start. With an explicitly enabled exporter the existing worker may remain spawned but dormant: subscription turns are never submitted to it, it makes no backend HTTP request, and it can never later send `priced`. Assert API-key/default-exporter-off sends `costObservationDisabled` with no worker/request; unsupported provider sends `providerUnsupported`; supported API-key plus explicitly enabled exporter starts as `awaitingBackendPrice`. An accepted complete result emits exactly one `priced` update with the literal backend string before the worker removes the entry. Add the exact OTEL unit test `turn_cost_decimal_parser_rounds_seventh_digit_and_rejects_invalid`: table-test the shared parser with valid `0`, `0.000001`, `1.250000`, and `0.0001245 -> 125` micro-USD; reject negative/signed, whitespace, exponent, empty, malformed, and rounded-`i64`-overflowing values. Separately assert the worker preserves each accepted source string exactly for UI and rejects malformed/overflow values before both telemetry and UI. Backend-failed/retry-exhausted/channel-or-capacity-dropped entries emit the appropriate typed unavailable update, never zero or a price.

- [ ] **Step 2: Run the focused RED checks.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-otel turn_cost_decimal_parser_rounds_seventh_digit_and_rejects_invalid --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-otel --test tests manager_turn_cost_ -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server turn_cost_worker --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server activity_notifications --lib -- --nocapture
```

Expected: type/notification/policy symbols are absent. The existing subscription negative test must stay red if implementation accidentally begins a request.

- [ ] **Step 3: Implement typed cost availability.** Add the protocol enum/structs and `ServerNotification` entry. Extract the imported OTEL R3 decimal conversion into one shared `codex_otel` parser returning `Option<i64>` micro-USD; keep `SessionTelemetry::record_turn_cost` on that parser and call the same parser in the worker before either telemetry or UI emission. In `message_processor`, construct the always-present policy from config plus `AuthManager`; its turn-start classification reads current cached auth without I/O, with subscription precedence. Construct the optional worker separately under the unchanged exporter/provider spawn gate and give it a cloneable late-update notifier backed by the existing outgoing sender. A subscription-auth worker is allowed to exist dormant for auth-change support, but its turns are never submitted. In `thread_lifecycle`, construct the `ThreadScopedOutgoingMessageSender` before any activity/cost observation. Preserve wire order: forward the existing live `TurnStarted` notification first, then emit the initial typed cost state, so the TUI always has a current row to update. Submit to the worker only for `AwaitingBackendPrice`. Make `observe_event` report channel/capacity drops instead of silently ignoring `try_send` failure. Only a successfully parsed string is passed unchanged to both `record_turn_cost` and `Priced`, immediately before removal. Use the notifier for retry exhaustion/backend unavailable/observation dropped as well. Keep channel/map/query/retry limits and shutdown behavior unchanged.

- [ ] **Step 4: Run the same focused checks and verify GREEN.** Require dynamic subscription precedence with dormant-worker no-observation/no-request assertions, default disabled no-worker/no-request assertion, provider unsupported classification, one late validated accepted-price notification, exact-string preservation, `0.0001245 -> 125` micro-USD, typed malformed/overflow/failure/drop outcomes, and no change to existing valid OTLP metric/log expectations. Run `git diff --check`.

- [ ] **Step 5: Commit the cost-notification slice.** Stage only Task 2 files and commit:

```bash
git add codex-rs/app-server-protocol/src/protocol/common.rs codex-rs/otel/src/lib.rs codex-rs/otel/src/events/session_telemetry.rs codex-rs/otel/tests/suite/snapshot.rs codex-rs/app-server/src/turn_cost_worker.rs codex-rs/app-server/src/turn_cost_worker_tests.rs codex-rs/app-server/src/message_processor.rs codex-rs/app-server/src/outgoing_message.rs codex-rs/app-server/src/request_processors/thread_lifecycle.rs codex-rs/app-server/src/bespoke_event_handling.rs codex-rs/app-server/src/activity_notifications_tests.rs codex-rs/app-server/src/lib.rs
git commit -m "feat(activity): notify typed turn cost availability"
```

Omit `outgoing_message.rs`, `activity_notifications_tests.rs`, or `lib.rs` from the explicit add if the existing sender is sufficient or the optional test module is not created.

## Task 3: Own bounded activity state in the TUI and consume runtime facts

**Files:**

- Create: `codex-rs/tui/src/activity_state.rs`
- Modify: `codex-rs/tui/src/lib.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/chatwidget/protocol.rs`
- Modify: `codex-rs/tui/src/chatwidget/replay.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/app_server.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/history_replay.rs`
- Modify: `codex-rs/tui/src/app/app_server_event_targets.rs`
- Modify: `codex-rs/tui/src/app/app_server_events.rs`
- Modify: `codex-rs/tui/src/app/thread_events.rs`
- Modify: `codex-rs/tui/src/app/thread_routing.rs`

**Consumes:** live `TurnStarted`, Task 1 `TurnActivityUpdatedNotification`, Task 2 `TurnCostUpdatedNotification`, `ReplayKind`, session/thread lifecycle, and the runtime-plan’s `Option<bool>` automatic-pruning fact.

**Produces:** private `ActivityState`, safe `DashboardActivityState` projection (including optional running-turn start time but no turn ID), thread-target routing for the two new live notifications, and `ChatWidget::{on_turn_started_activity,on_turn_completed_activity,on_turn_cost_updated_activity,reset_activity,dashboard_activity_state}`. It also accepts `automatic_pruning_enabled: Option<bool>` as a dashboard-state input without defining the setting.

- [ ] **Step 1: Write RED pure-state tests.** In `activity_state.rs` tests, assert this literal transition sequence: start `turn-a` -> `current = Running` with its measured start timestamp; completed `turn-a` with profile/TTFT -> `current = None`, exactly one completed recent row; interrupted `turn-b` -> one interrupted row. Apply a late `Priced { backend_total_usd: "1.250000" }` for `turn-a` and assert only that retained row changes. Fill `ACTIVITY_RECENT_LIMIT + 1` completions and assert the oldest row is evicted. Send an update for evicted/unknown `turn_id` and assert no row is created. Missing start, duration, TTFT, and profile remain `None`; none becomes zero.

- [ ] **Step 2: Write RED TUI routing/replay/session tests.** In `chatwidget/tests/app_server.rs`, feed only synthetic live app-server notifications; assert no prompt, last-agent message, command output, raw error body, account data, or turn id appears in `dashboard_activity_state()`. Verify a subscription event projects the exact cost string and an unavailable active/default state does not render a dollar amount. In `app/app_server_event_targets.rs` tests, assert both new notifications target exactly their thread. In `history_replay.rs`, replay started/completed turns under both `ResumeInitialMessages` and `ThreadSnapshot` and assert Activity remains empty. Assert new session, resume, and visible-thread switch each reset current/recent Activity rather than carrying the previous widget/session's rows.

- [ ] **Step 3: Run the focused RED checks.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui activity_state --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui chatwidget::tests::app_server --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui history_replay --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui app_server_event_targets --lib -- --nocapture
```

Expected: activity model and cost notification handling do not exist.

- [ ] **Step 4: Implement the bounded live state owner.** Keep the correlation turn id private to `ActivityState`. Route both new notifications by their explicit thread id. Handle Activity only when `replay_kind.is_none()`; activity notifications are live-only and must not be retained in thread replay buffers. On live start, replace only the active `current` turn and retain only its optional scalar start time for dashboard projection; on live terminal activity notification, remove matching current state and append one immutable summary, regardless of complete/abort/failed status. Invoke `reset_activity` on new session, resume, and visible-thread switch before replay. Do not scrape cells or read rollouts. After every semantic state mutation, request a nonblocking dashboard publication; normal `on_task_complete`, interrupt, and redraw paths must still run if publication fails. Do not republish merely to advance elapsed time: the page derives that from start time plus heartbeat. Keep `automatic_pruning_enabled: Option<bool>` as a typed dashboard-input field supplied by its owner; do not read config or add a control in this task.

- [ ] **Step 5: Run the same focused checks and verify GREEN.** Also add a regression where dashboard serialization returns an error/injected failure and assert completion handling still finalizes. Run `git diff --check`.

- [ ] **Step 6: Commit the TUI state slice.** Stage only Task 3 files and commit:

```bash
git add codex-rs/tui/src/activity_state.rs codex-rs/tui/src/lib.rs codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/chatwidget/protocol.rs codex-rs/tui/src/chatwidget/replay.rs codex-rs/tui/src/chatwidget/tests.rs codex-rs/tui/src/chatwidget/tests/app_server.rs codex-rs/tui/src/chatwidget/tests/history_replay.rs codex-rs/tui/src/app/app_server_event_targets.rs codex-rs/tui/src/app/app_server_events.rs codex-rs/tui/src/app/thread_events.rs codex-rs/tui/src/app/thread_routing.rs
git commit -m "feat(activity): retain current session turn summaries"
```

## Task 4: Replace one-shot snapshot publication with revisioned, safe dashboard state

**Files:**

- Modify: `codex-rs/tui/src/dashboard_server.rs`
- Create: `codex-rs/tui/src/dashboard_server_tests.rs`
- Modify: `codex-rs/tui/src/lib.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/app/event_dispatch.rs`

**Consumes:** Task 3 dashboard activity projection and automatic-pruning optional input, existing context/token snapshot facts, and the current `/dashboard` command path.

**Produces:** `DashboardState { schema_version, revision, generated_at, context, tokens, activity }`, `DashboardEnvelope { state, heartbeat_at }`, `publish_state`, `response_for`, and loopback/Host/header guards.

- [ ] **Step 1: Write RED state/server tests.** Create deterministic unit tests for: (a) first publish has `schema_version == 1` and revision 1; (b) equal state preserves revision; (c) a start, completion, or cost change increments revision once; (d) two responses from identical state have equal revision and distinct/test-clock heartbeats; (e) missing auto-pruning input stays null/unavailable rather than false; (f) state JSON lacks every forbidden sample key/value: prompt, response, tool output, account, credential, `trace_id`, and `/home/private-user`.

Add request-helper tests: `127.0.0.1` binding only; `Host: 127.0.0.1:<port>` and `Host: localhost:<port>` accepted, `Host: evil.example` rejected; only `/`, `/index.html`, `/data.json` return 200; all other routes/methods return non-mutating 404/405. Assert every response has exact `Cache-Control: no-store`, CSP that allows only self-contained inline asset execution and no external connect/source, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`; assert no `Access-Control-Allow-Origin` header.

- [ ] **Step 2: Run the focused RED check.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui dashboard_server --lib -- --nocapture
```

Expected: versioned state, host guard, envelope, and headers are absent.

- [ ] **Step 3: Implement the smallest publication/server replacement.** Make `DashboardState` the mutex-held value, not pre-rendered raw JSON. Serialize only inside a best-effort helper; on failure retain the last valid state and return a safe unavailable response rather than blocking the caller. `publish_state` compares semantic state excluding `generated_at`, updates `generated_at` and revision only for changed facts, and never writes a path/identifier or content field. `/data.json` creates `DashboardEnvelope` with a fresh heartbeat at response time. `ensure_running` keeps `127.0.0.1:0`; test Host before routing, add response headers on all routes, and leave no mutation/CORS path. `publish_dashboard_snapshot` becomes a merge/update that preserves context/token values and receives Activity from Task 3; remove existing `unwrap_or(0)` substitutions for unknown context facts in the new state.

- [ ] **Step 4: Run the same focused check and verify GREEN.** Also run the existing slash-command dashboard assertion to prove `/dashboard` still reaches `ensure_running`; no browser is launched as part of automated verification. Run `git diff --check`.

- [ ] **Step 5: Commit the dashboard-state/security slice.** Stage only Task 4 files and commit:

```bash
git add codex-rs/tui/src/dashboard_server.rs codex-rs/tui/src/dashboard_server_tests.rs codex-rs/tui/src/lib.rs codex-rs/tui/src/chatwidget/context_usage.rs codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/app/event_dispatch.rs
git commit -m "feat(dashboard): publish revisioned safe activity state"
```

## Task 5: Add the functional Activity tab against frozen safe fixtures

**Files:**

- Modify: `codex-rs/tui/src/dashboard_assets/index.html`
- Create: `codex-rs/tui/src/dashboard_assets/fixtures/activity-state.json`
- Modify: `codex-rs/tui/src/dashboard_server_tests.rs`

**Consumes:** Task 4’s stable `DashboardEnvelope` JSON shape.

**Produces:** the `Activity` tab and exact empty/unavailable text, with no new theme or continuity-spine styling.

- [ ] **Step 1: Add a frozen RED fixture and source-level render/control tests.** Fixture contents must cover one running turn and two recent turns: one measured completed turn with all six profile values and `Backend-reported 1.250000`, and one interrupted subscription turn. The test reads it through `include_str!`, deserializes it to `DashboardEnvelope`, and asserts the asset contains each fixed Activity element id plus these exact strings:

```text
Running
Idle
Timing breakdown unavailable for this turn
Cost unavailable for subscription authentication
Cost unavailable — awaiting backend price
Backend-reported
Pause updates
Resume updates
Refresh now
Fresh
Stale
Unavailable
```

Add hostile values (`<img src=x onerror=1>`, `<script>`, a fake `/home/private-user/...` path) to a separate fixture field that is ignored by the typed deserializer; assert it has no rendered sink. Add guards that the asset has no `innerHTML` token, no `eval`, no external `http:`/`https:` fetch, and uses `textContent` for dynamic text. Add source guards for semantic tab/control buttons, `aria-selected`, arrow/Home/End keyboard handling, visible `:focus-visible`, a responsive narrow-width rule plus table overflow, and `@media (prefers-reduced-motion: reduce)`. Require fixed control ids for pause/resume, refresh, and freshness status.

- [ ] **Step 2: Run the focused RED check.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui dashboard_server_tests --lib -- --nocapture
```

Expected: frozen fixture, Activity ids, precise unavailable copy, and DOM safety checks fail.

- [ ] **Step 3: Implement the bounded functional page.** Add an `Activity` tab while retaining Context/Tokens. Render: Now (`Running` with elapsed or `Idle`), latest outcome/total/TTFT/requests/retries/cost, six labelled durations only with a profile, and a 20-row-or-fewer recent table of outcome/total/TTFT/cost. Use `createElement`, `append`, `textContent`, and a closed color/class allowlist; never interpolate dynamic values into HTML or CSS. The formatter maps the typed enum to exact text, keeps all optional timing missing values as `Unavailable`, and only prefixes a price after `Priced`. It must not show a cost total for all unavailable states. Preserve the existing Context/Tokens content functionally, replacing their current dynamic `innerHTML` rendering with node construction as part of this security prerequisite.

  Add functional controls without changing product styling: automatic polling is on by default; `Pause updates` stops polling and the elapsed display timer and changes to `Resume updates`; resume performs an immediate fetch then restarts both; `Refresh now` performs one fetch even while paused. Freshness is `Unavailable` until the first valid response, `Fresh` while the newest successful response heartbeat is at most 10 seconds old, and `Stale` after 10 seconds. A failed fetch never fabricates a new heartbeat or erases the last valid one, so a previously live page ages from Fresh to Stale; pausing follows the same heartbeat rule. Tabs and controls are native buttons, tabs use the ARIA tab pattern and ArrowLeft/ArrowRight/Home/End, focus is visibly styled, narrow layouts stack summary cards and horizontally scroll tables, and reduced-motion disables all nonessential transitions/animation.

- [ ] **Step 4: Run the same focused check and verify GREEN.** Require fixture parse, exact unavailable text, no dollar price for subscription/disabled/awaiting, no dynamic HTML API, no forbidden serialized data, control/freshness state hooks, keyboard/focus semantics, responsive rule, and reduced-motion rule. Run `git diff --check`.

- [ ] **Step 5: Commit the functional Activity page.** Stage only Task 5 files and commit:

```bash
git add codex-rs/tui/src/dashboard_assets/index.html codex-rs/tui/src/dashboard_assets/fixtures/activity-state.json codex-rs/tui/src/dashboard_server_tests.rs
git commit -m "feat(dashboard): render truthful activity facts"
```

## Task 6: Cross-slice regression and acceptance handoff

**Files:**

- Inspect: only files changed in Tasks 1–5
- Update: coordinator-owned integration ledger only if the coordinator authorizes it; workers must not edit `TASKS.md`

**Consumes:** committed Tasks 1–5.

**Produces:** deferred focused automated evidence and a manual acceptance checklist; it makes no runtime-success claim.

- [ ] **Step 1: Review boundaries and source assertions.** Run `git status --short` and `git diff --check`; inspect every changed file. Confirm no Cargo lock/dependency/config file, telemetry exporter gate, cost polling interval, installed binary, durable `v2::Turn`/thread-history/rollout profile field, prompt/message/tool capture, absolute path, account field, visual identity, or pruning setting changed. Confirm existing terminal structs remain unchanged, the transient `TurnProfileEvent` is absent from rollout output and replay buffers, and replay cannot repopulate Activity.

- [ ] **Step 2: Run focused green checks.** Defer until implementation; execute only:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core turn_timing --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core tasks::tests:: --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core transient_turn_profile_event_is_not_persisted --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-rollout turn_profile_events_are_never_persisted --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo check -p codex-rollout-trace -p codex-mcp-server -p codex-thread-manager-sample --all-targets
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-otel turn_cost_decimal_parser_rounds_seventh_digit_and_rejects_invalid --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-otel --test tests manager_turn_cost_ -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server turn_activity --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server turn_cost_worker --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server activity_notifications --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui activity_state --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui dashboard_server --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui chatwidget::tests::app_server --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui history_replay --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui app_server_event_targets --lib -- --nocapture
```

Expected: every listed test filter produces at least one positive libtest summary and all selected tests pass; a zero-match filter is a failure. The three-package check covers the explicit exhaustive non-live consumers without building an executable. Do not run broad workspace tests, start a server, open a browser, or perform a network call in this slice.

- [ ] **Step 3: Conduct source-level acceptance review.** Verify the diff proves all of the following: complete and abort live profile/TTFT route; unchanged terminal structs; transient profile omitted from rollouts and replay buffers; one late validated accepted-cost match before removal; explicit dynamic subscription precedence and no subscription/default-exporter request; current/recent bounded eviction plus reset/ignore-replay behavior; typed other unavailable reasons; revision versus heartbeat; loopback/Host/no-store/CSP/nosniff/frame denial; text-only DOM creation; pause/resume/refresh/freshness and keyboard/responsive/reduced-motion hooks; frozen fixture coverage; and automatic-pruning typed input preserved without adding its task.

- [ ] **Step 4: Hand off as unaccepted.** Give Masih a future manual checklist: open `/dashboard` during a running turn; confirm Running elapsed updates; complete and interrupt turns; inspect a known missing-profile state; confirm subscription wording; observe a late price only in an explicitly active existing cost worker configuration; pause and verify polling/elapsed stop; refresh once while paused; resume and verify immediate refresh; force/observe Fresh, Stale, and Unavailable states; navigate tabs with ArrowLeft/ArrowRight/Home/End and visible keyboard focus; narrow the window; enable reduced motion; inspect Context/Tokens; and attempt no remote/control interaction. State that source/unit evidence is not runtime or visual acceptance.

- [ ] **Step 5: Commit only if Task 6 changed an authorized coordinator record.** Otherwise do not make a status-only commit. If authorized, stage that exact record and commit `docs: record activity observability verification evidence`.

## Review gates and deferred work

1. Review Task 1 before Task 2: live-only core-field omission and the ephemeral notification schema are shared compatibility boundaries.
2. Review Task 2 before Task 3: TUI cost behavior must not invent reasons or silently alter polling.
3. Review Task 3 before Task 4: only the TUI owns session-bounded activity and private turn-id correlation.
4. Review Task 4 before Task 5: the page consumes a stable, safe envelope; browser markup must not define product truth.
5. Defer the daily-driver visual direction, Continuity Spine, Activity token/cached-input additions not already available as typed per-turn facts, Agents, Work graph, Continuity, dashboard controls beyond the required pause/resume/refresh/freshness behavior, and any network/runtime evidence to their explicitly approved owners.

## Self-review

- **Spec coverage:** Tasks 1–3 cover typed measured timing, live-only profiles, existing TTFT, complete/abort, serialization/replay omission, typed cost states, dynamic subscription wording, no default polling, validated bounded late price, process-session retention/reset, eviction, routing, and automatic-pruning fact carriage. Tasks 4–5 cover revision/heartbeat, live best-effort publishing, loopback-only read-only serving, Host/security headers, no dynamic HTML, Activity/empty states, pause/resume/refresh/freshness, keyboard/responsive/reduced-motion behavior, and frozen fixtures. Task 6 covers the required source/unit/regression and manual acceptance boundary.
- **Truth boundary:** No task reads OTLP, rendered terminal output, model/token metadata, rollout files, browser state, or prices inferred locally. No unavailable path maps to zero.
- **Privacy boundary:** The dashboard projection intentionally omits all messages, tools, command output, account/credential/trace/path values; tests include forbidden samples.
- **Plan boundary:** This plan is derived from source inspection only. It contains deferred commands and no claim that a binary, server, browser, or visual result has been run.

# Truthful Activity Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Each task has one implementer, one review gate, and checkbox tracking.

**Task ID:** DD-ACTIVITY-OBSERVABILITY

**Goal:** Make measured per-turn timing/profile facts and explicitly available backend-cost facts visible in a small, current-session-only Activity tab in the existing local dashboard, without changing turn behavior, enabling cost polling, or exposing private content.

**Architecture:** The core serializes an optional, measured profile on both terminal turn events; the app server projects it and TTFT into its existing terminal notifications. A separate typed cost-status notification gives the TUI an initial unavailable reason and, only when the already opt-in worker accepts a backend price, a bounded late update. The TUI owns a bounded activity model and publishes one versioned dashboard state. The loopback server serves that state read-only with a fact revision and an independent response heartbeat; the static page renders it with DOM node APIs only.

**Tech stack:** Rust, serde, existing core/protocol/app-server notifications, Ratatui TUI state, `tiny_http`, static HTML/CSS/JavaScript, focused Rust unit/fixture tests.

**Spec:**

- `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md` sections 3.1–3.3 and Verification and Acceptance
- `docs/superpowers/specs/2026-08-31-turn-cost-latency-observability-design.md`
- `.superpowers/daily-driver-audits/observability-ui.md`

## Preconditions and non-goals

- Start only after the observability import is the integration baseline. This plan relies on its measured `TurnTimingState`, immutable `TurnProfile`, and bounded opt-in `TurnCostWorker`; it does not reimplement them.
- The automatic-pruning owner supplies the already-approved runtime fact as `Option<bool>`. This slice carries that value through `DashboardState` when supplied; it does **not** add the setting, persistence, default, UI control, or new pruning behavior.
- The worker’s existing explicit exporter gate remains authoritative. Dashboard work must not create a worker, start a backend poller, change OTLP settings, or make a request in the default configuration.
- Functional Activity comes before any cyan/palette/spine/animation/whole-product visual work. Keep Context and Tokens working; do not redesign them.
- No browser, app, process, tmux, network, config, build, formatter, Cargo command, installation, release, or push occurs while executing the source-first tasks. Every Rust command below is deferred to the final functional-close verification batch.

## Global constraints

- Carry TTFT and phase timing only as typed optional fields from the measured terminal event. Never infer them from OTLP, rendered transcript cells, tokens, timestamps, model names, or rollout text.
- Preserve old rollout and app-server protocol compatibility: all new persisted-event and `v2::Turn` fields are optional with serde defaults. Missing means unavailable, never zero.
- Retain no activity beyond the active process/session. Use `VecDeque` with `ACTIVITY_RECENT_LIMIT = 20`; do not add a database, rollout cost record, analytics store, cost cache, or browser persistence.
- Subscription authentication renders exactly `Cost unavailable for subscription authentication`. It never produces a price, `$0`, a blank success state, or a backend cost query.
- Other unavailable states are typed. The first-slice wire enum is `SubscriptionAuthentication`, `CostObservationDisabled`, `ProviderUnsupported`, `AwaitingBackendPrice`, `BackendUnavailable`, and `ObservationDropped`; do not send formatted display strings over the app-server protocol.
- A `Priced` value is the already accepted backend decimal string, labelled `Backend-reported`; do not convert, estimate, round, combine, or infer a price in the dashboard.
- A late price notification is emitted only after the existing worker has accepted a complete backend result and immediately before it removes that tracked entry. It is best-effort and can update only a retained matching row.
- Dashboard data contains scalar timing/count/cost/status facts only. It must never contain prompt/input text, response text, tool arguments or output, command output, account identifiers/email, credentials, trace IDs, source paths, rollout paths, or absolute paths.
- The server is loopback-only and read-only; reject foreign Host values; add `Cache-Control: no-store`, CSP, `X-Content-Type-Options: nosniff`, and frame denial. The browser performs no external request and uses `textContent`/node construction for every dynamic value; no dynamic `innerHTML`.
- `revision` changes only on a semantic state mutation. The response heartbeat is generated independently for every `/data.json` response, so an idle but reachable session is fresh without revision churn. Publishing/serialization/server failure never delays or fails a turn.
- A running-turn projection carries its measured start time as an optional scalar timestamp. The browser computes elapsed time against the response heartbeat; a display timer must not mutate `revision` or require periodic TUI publication.

## File map and interfaces

| Area | Files | Responsibility |
| --- | --- | --- |
| Measured terminal event | `codex-rs/protocol/src/protocol.rs`, `codex-rs/protocol/src/lib.rs`, `codex-rs/core/src/turn_timing.rs`, `codex-rs/core/src/tasks/mod.rs`, `codex-rs/core/src/tasks/tests.rs` | Add optional serializable profile to complete and abort events only after immutable completion; keep TTFT unchanged. |
| Durable/app-server projection | `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`, `protocol/v2/turn.rs`, `protocol/common.rs`, `protocol/thread_history.rs`, `protocol/thread_history_projection.rs`, their tests | Project terminal timing to `v2::Turn` and preserve old event replay/default behavior. |
| Cost status producer | `codex-rs/app-server/src/turn_cost_worker.rs`, `turn_cost_worker_tests.rs`, `request_processors/thread_lifecycle.rs`, `bespoke_event_handling.rs`, focused app-server tests | Decide typed initial cost availability without polling and emit a later accepted-price/unavailable notification through the existing thread-scoped sender. |
| Activity state owner | `codex-rs/tui/src/activity_state.rs` (new), `chatwidget.rs`, `chatwidget/protocol.rs`, `chatwidget/tests.rs`, `chatwidget/tests/app_server.rs` | Maintain current/recent state, match late cost updates privately by turn id, evict oldest entries, and request a best-effort dashboard publication. |
| Dashboard state/server | `codex-rs/tui/src/dashboard_server.rs`, `dashboard_server_tests.rs` (new), `chatwidget/context_usage.rs`, `app/event_dispatch.rs` | Replace the raw global context JSON with revisioned `DashboardState`, merge current context facts and activity projection, safely serve response data, and preserve the existing dashboard command. |
| Activity page | `codex-rs/tui/src/dashboard_assets/index.html`, `dashboard_assets/fixtures/activity-state.json` (new), `dashboard_server_tests.rs` | Add functional Activity tab and empty states with frozen fixture/source guards; preserve Context/Tokens without visual redesign. |

The exact cross-layer types are deliberately small:

```rust
// codex-protocol terminal events; both fields use serde(default) and omit None.
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

// app-server protocol, all optional to keep pre-change clients/rollouts valid.
pub struct Turn {
    // existing fields...
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

`TurnProfileSummary` has no turn id, trace id, messages, or provider data. `TurnCostUpdatedNotification` needs a turn id for in-memory matching, but dashboard serialization removes it. The TUI-projected `DashboardTurnSummary` includes only `status`, optional `duration_ms`, optional `time_to_first_token_ms`, optional `profile`, and `cost`.

## Task 1: Carry immutable profile and TTFT through compatible terminal/app-server types

**Files:**

- Modify: `codex-rs/protocol/src/protocol.rs`
- Modify: `codex-rs/protocol/src/lib.rs`
- Modify: `codex-rs/core/src/turn_timing.rs`
- Modify: `codex-rs/core/src/tasks/mod.rs`
- Modify: `codex-rs/core/src/tasks/tests.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/thread_history.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/thread_history_projection_tests.rs`
- Modify: `codex-rs/app-server/src/bespoke_event_handling.rs`
- Modify: focused existing `codex-rs/app-server/tests/suite/v2/thread_read.rs` expectations affected by `Turn`

**Consumes:** imported `TurnTimingState::complete`, existing `TurnProfile`, `TurnCompleteEvent`, `TurnAbortedEvent`, and app-server `TurnCompletionMetadata`.

**Produces:** `TurnProfileSummary`, optional `profile` on both terminal events and `v2::Turn`, optional `time_to_first_token_ms` on `v2::Turn`, and a projection that defaults these fields for old data.

- [ ] **Step 1: Write core/protocol RED tests.** In `core/src/tasks/tests.rs`, drive one normal completion and one abort with deterministic `TurnTimingState` profile values. Assert both emitted terminal events contain the six exact phases/counts and that only normal completion carries measured TTFT when it exists. Add serde assertions for old JSON terminal events with neither new field: `profile == None` and `time_to_first_token_ms == None`; assert an unfinished timing state never emits a fabricated profile.

- [ ] **Step 2: Write app-server projection RED tests.** Extend `thread_history_projection_tests.rs` with a complete fixture and an abort fixture containing a literal `TurnProfileSummary`. Assert `ThreadHistoryTurnChange` and `v2::Turn` retain TTFT/profile exactly. Preserve a pre-change event fixture and assert all three new `Turn` fields are `None`; assert its serialized shape has no message body.

- [ ] **Step 3: Run the focused checks and verify RED.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core tasks::tests:: --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server-protocol thread_history_projection --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --test suite v2::thread_read -- --nocapture
```

Expected: the tests fail because profile/TTFT fields and forwarding do not exist; no broad workspace command.

- [ ] **Step 4: Implement the narrow measured route.** Define `TurnProfileSummary` in `codex-protocol`, derive `Serialize`, `Deserialize`, `JsonSchema`, `TS`, `Clone`, `PartialEq`, and add `#[serde(default, skip_serializing_if = "Option::is_none")]` to each terminal-event optional field. Add a lossless conversion from the imported immutable `TurnProfile` in core; call it only after `complete_profile_and_duration_ms` on normal and abort paths. Do not inspect OTLP or response text. Add equivalent optional fields to `v2::Turn`, `ThreadHistoryTurnChange`, the canonical history projection, `TurnCompletionMetadata`, start/completion literals, and all compiler-required `Turn` fixtures.

- [ ] **Step 5: Run the same focused checks and verify GREEN.** Require literal normal/abort values, sum-preserving existing profile tests, replay defaults, and no app-server message contents. Also run `git diff --check`.

- [ ] **Step 6: Commit the compatible timing slice.** Stage only Task 1 files and commit:

```bash
git add codex-rs/protocol/src/protocol.rs codex-rs/protocol/src/lib.rs codex-rs/core/src/turn_timing.rs codex-rs/core/src/tasks/mod.rs codex-rs/core/src/tasks/tests.rs codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs codex-rs/app-server-protocol/src/protocol/v2/turn.rs codex-rs/app-server-protocol/src/protocol/thread_history.rs codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs codex-rs/app-server-protocol/src/protocol/thread_history_projection_tests.rs codex-rs/app-server/src/bespoke_event_handling.rs codex-rs/app-server/tests/suite/v2/thread_read.rs
git commit -m "feat(activity): project measured turn timing"
```

## Task 2: Emit typed initial and late cost state without changing polling

**Files:**

- Modify: `codex-rs/app-server-protocol/src/protocol/common.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`
- Modify: `codex-rs/app-server/src/turn_cost_worker.rs`
- Modify: `codex-rs/app-server/src/turn_cost_worker_tests.rs`
- Modify: `codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- Modify: `codex-rs/app-server/src/bespoke_event_handling.rs`
- Modify: focused existing app-server notification tests or create `codex-rs/app-server/src/activity_notifications_tests.rs` and register it from `lib.rs`

**Consumes:** Task 1 terminal notification route, the imported worker’s auth/provider/exporter gates and its accepted priced result just before removal, plus `ThreadScopedOutgoingMessageSender`.

**Produces:** `TurnCostState`, `TurnCostUpdatedNotification`, `turn/costUpdated` server notification, and an internal `TurnCostAvailabilityPolicy` that classifies a started turn without a backend request.

- [ ] **Step 1: Write RED protocol/worker tests.** Add an exact serialized notification fixture:

```json
{"method":"turn/costUpdated","params":{"threadId":"thread-1","turnId":"turn-1","cost":{"type":"unavailable","reason":"subscriptionAuthentication"}}}
```

Assert subscription auth sends this state at turn start, makes no backend request, and can never later send `priced`. Assert disabled worker sends `costObservationDisabled` without spawning/polling. Assert supported active API-key worker starts as `awaitingBackendPrice`; an accepted complete result emits exactly one `priced` update with the literal backend string before the worker removes the entry. Assert malformed/backend-failed/retry-exhausted entries emit an explicit typed unavailable update, never zero or a price.

- [ ] **Step 2: Run the focused RED checks.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server turn_cost_worker --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server activity_notifications --lib -- --nocapture
```

Expected: type/notification/policy symbols are absent. The existing subscription negative test must stay red if implementation accidentally begins a request.

- [ ] **Step 3: Implement typed cost availability.** Add the protocol enum/structs and `ServerNotification` entry. In app-server startup/lifecycle, construct availability policy from the already existing auth/provider/exporter decision. On `TurnStarted`, emit the initial typed state through the scoped outgoing sender; do not call the backend here. Give the existing worker a bounded callback/sender which emits only after `process_api_key_cost` accepts a complete priced result and before `turns.remove`; use the same path for terminal unavailable reasons. Keep channel/map/query/retry limits and shutdown behavior unchanged.

- [ ] **Step 4: Run the same focused checks and verify GREEN.** Require the subscription no-request assertion, disabled no-worker/no-request assertion, one late accepted-price notification, typed failures, and no change to existing OTLP metric expectations. Run `git diff --check`.

- [ ] **Step 5: Commit the cost-notification slice.** Stage only Task 2 files and commit:

```bash
git add codex-rs/app-server-protocol/src/protocol/common.rs codex-rs/app-server-protocol/src/protocol/v2/turn.rs codex-rs/app-server/src/turn_cost_worker.rs codex-rs/app-server/src/turn_cost_worker_tests.rs codex-rs/app-server/src/request_processors/thread_lifecycle.rs codex-rs/app-server/src/bespoke_event_handling.rs codex-rs/app-server/src/activity_notifications_tests.rs codex-rs/app-server/src/lib.rs
git commit -m "feat(activity): notify typed turn cost availability"
```

## Task 3: Own bounded activity state in the TUI and consume runtime facts

**Files:**

- Create: `codex-rs/tui/src/activity_state.rs`
- Modify: `codex-rs/tui/src/lib.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/chatwidget/protocol.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests.rs`
- Modify: `codex-rs/tui/src/chatwidget/tests/app_server.rs`

**Consumes:** Task 1 `TurnStarted`/`TurnCompleted` fields, Task 2 `TurnCostUpdatedNotification`, and the runtime-plan’s `Option<bool>` automatic-pruning fact.

**Produces:** private `ActivityState`, safe `DashboardActivityState` projection (including optional running-turn start time but no turn ID), and `ChatWidget::{on_turn_started_activity,on_turn_completed_activity,on_turn_cost_updated_activity,dashboard_activity_state}`. It also accepts `automatic_pruning_enabled: Option<bool>` as a dashboard-state input without defining the setting.

- [ ] **Step 1: Write RED pure-state tests.** In `activity_state.rs` tests, assert this literal transition sequence: start `turn-a` -> `current = Running` with its measured start timestamp; completed `turn-a` with profile/TTFT -> `current = None`, exactly one completed recent row; interrupted `turn-b` -> one interrupted row. Apply a late `Priced { backend_total_usd: "1.250000" }` for `turn-a` and assert only that retained row changes. Fill `ACTIVITY_RECENT_LIMIT + 1` completions and assert the oldest row is evicted. Send an update for evicted/unknown `turn_id` and assert no row is created. Missing start, duration, TTFT, and profile remain `None`; none becomes zero.

- [ ] **Step 2: Write RED TUI notification tests.** In `chatwidget/tests/app_server.rs`, feed only synthetic app-server notifications; assert no prompt, last-agent message, command output, raw error body, account data, or turn id appears in `dashboard_activity_state()`. Verify a subscription event projects the exact cost string and an unavailable active/default state does not render a dollar amount.

- [ ] **Step 3: Run the focused RED checks.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui activity_state --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui chatwidget::tests::app_server --lib -- --nocapture
```

Expected: activity model and cost notification handling do not exist.

- [ ] **Step 4: Implement the bounded state owner.** Keep the correlation turn id private to `ActivityState`. On start, replace only the active `current` turn and retain only its optional scalar start time for dashboard projection; on terminal notification, remove matching current state and append one immutable summary, regardless of complete/abort/failed status. Do not scrape cells or read rollouts. After every semantic state mutation, request a nonblocking dashboard publication; normal `on_task_complete`, interrupt, and redraw paths must still run if publication fails. Do not republish merely to advance elapsed time: the page derives that from start time plus heartbeat. Keep `automatic_pruning_enabled: Option<bool>` as a typed dashboard-input field supplied by its owner; do not read config or add a control in this task.

- [ ] **Step 5: Run the same focused checks and verify GREEN.** Also add a regression where dashboard serialization returns an error/injected failure and assert completion handling still finalizes. Run `git diff --check`.

- [ ] **Step 6: Commit the TUI state slice.** Stage only Task 3 files and commit:

```bash
git add codex-rs/tui/src/activity_state.rs codex-rs/tui/src/lib.rs codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/chatwidget/protocol.rs codex-rs/tui/src/chatwidget/tests.rs codex-rs/tui/src/chatwidget/tests/app_server.rs
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

- [ ] **Step 1: Add a frozen RED fixture and source-level render tests.** Fixture contents must cover one running turn and two recent turns: one measured completed turn with all six profile values and `Backend-reported 1.250000`, and one interrupted subscription turn. The test reads it through `include_str!`, deserializes it to `DashboardEnvelope`, and asserts the asset contains each fixed Activity element id plus these exact strings:

```text
Running
Idle
Timing breakdown unavailable for this turn
Cost unavailable for subscription authentication
Cost unavailable — awaiting backend price
Backend-reported
```

Add hostile values (`<img src=x onerror=1>`, `<script>`, a fake `/home/private-user/...` path) to a separate fixture field that is ignored by the typed deserializer; assert it has no rendered sink. Add guards that the asset has no `innerHTML` token, no `eval`, no external `http:`/`https:` fetch, and uses `textContent` for dynamic text.

- [ ] **Step 2: Run the focused RED check.** Defer until implementation:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui dashboard_server_tests --lib -- --nocapture
```

Expected: frozen fixture, Activity ids, precise unavailable copy, and DOM safety checks fail.

- [ ] **Step 3: Implement the bounded page.** Add an `Activity` tab while retaining Context/Tokens. Render: Now (`Running` with elapsed or `Idle`), latest outcome/total/TTFT/requests/retries/cost, six labelled durations only with a profile, and a 20-row-or-fewer recent table of outcome/total/TTFT/cost. Use `createElement`, `append`, `textContent`, and a closed color/class allowlist; never interpolate dynamic values into HTML or CSS. The formatter maps the typed enum to exact text, keeps all optional timing missing values as `Unavailable`, and only prefixes a price after `Priced`. It must not show a cost total for all unavailable states. Preserve the existing Context/Tokens content functionally, replacing their current dynamic `innerHTML` rendering with node construction as part of this security prerequisite.

- [ ] **Step 4: Run the same focused check and verify GREEN.** Require fixture parse, exact unavailable text, no dollar price for subscription/disabled/awaiting, no dynamic HTML API, and no forbidden serialized data. Run `git diff --check`.

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

- [ ] **Step 1: Review boundaries and source assertions.** Run `git status --short` and `git diff --check`; inspect every changed file. Confirm no Cargo lock/dependency/config file, telemetry exporter gate, cost polling interval, installed binary, rollout persistence, prompt/message/tool capture, absolute path, account field, visual identity, or pruning setting changed.

- [ ] **Step 2: Run focused green checks.** Defer until implementation; execute only:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-core turn_timing --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server-protocol thread_history_projection --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server 'turn_cost_worker|activity_notifications' --lib -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui 'activity_state|dashboard_server|chatwidget::tests::app_server' --lib -- --nocapture
```

Expected: all new positive/negative cases and existing imported worker/timing tests pass. Do not run broad workspace tests, build an executable, start a server, open a browser, or perform a network call in this slice.

- [ ] **Step 3: Conduct source-level acceptance review.** Verify the diff proves all of the following: complete and abort profile/TTFT route; optional old-event defaults; one late accepted-cost match before removal; explicit subscription text and no subscription request; current/recent bounded eviction; typed other unavailable reasons; revision versus heartbeat; loopback/Host/no-store/CSP/nosniff/frame denial; text-only DOM creation; frozen fixture coverage; and automatic-pruning typed input preserved without adding its task.

- [ ] **Step 4: Hand off as unaccepted.** Give Masih a future manual checklist: open `/dashboard` during a running turn; confirm Running elapsed updates; complete and interrupt turns; inspect a known missing-profile state; confirm subscription wording; observe a late price only in an explicitly active existing cost worker configuration; verify refresh/pause/resume and stale/unavailable display; inspect Context/Tokens; and attempt no remote/control interaction. State that source/unit evidence is not runtime or visual acceptance.

- [ ] **Step 5: Commit only if Task 6 changed an authorized coordinator record.** Otherwise do not make a status-only commit. If authorized, stage that exact record and commit `docs: record activity observability verification evidence`.

## Review gates and deferred work

1. Review Task 1 before Task 2: the protocol schema and default behavior are shared compatibility boundaries.
2. Review Task 2 before Task 3: TUI cost behavior must not invent reasons or silently alter polling.
3. Review Task 3 before Task 4: only the TUI owns session-bounded activity and private turn-id correlation.
4. Review Task 4 before Task 5: the page consumes a stable, safe envelope; browser markup must not define product truth.
5. Defer the daily-driver visual direction, Continuity Spine, Activity token/cached-input additions not already available as typed per-turn facts, Agents, Work graph, Continuity, dashboard controls beyond polling/refresh, and any network/runtime evidence to their explicitly approved owners.

## Self-review

- **Spec coverage:** Tasks 1–3 cover typed measured timing, profiles, TTFT, complete/abort, old events, typed cost states, subscription wording, no default polling, bounded late price, current-session retention, eviction, and automatic-pruning fact carriage. Tasks 4–5 cover revision/heartbeat, live best-effort publishing, loopback-only read-only serving, Host/security headers, no dynamic HTML, Activity/empty states, and frozen fixtures. Task 6 covers the required source/unit/regression and manual acceptance boundary.
- **Truth boundary:** No task reads OTLP, rendered terminal output, model/token metadata, rollout files, browser state, or prices inferred locally. No unavailable path maps to zero.
- **Privacy boundary:** The dashboard projection intentionally omits all messages, tools, command output, account/credential/trace/path values; tests include forbidden samples.
- **Plan boundary:** This plan is derived from source inspection only. It contains deferred commands and no claim that a binary, server, browser, or visual result has been run.

# Turn Cost and Latency Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add current Codex's backend-estimated turn cost and detailed turn-latency profile to Elpis's existing opt-in OTLP telemetry without importing a new analytics subsystem.

**Architecture:** Adapt the bounded Codex turn-cost worker to Elpis's existing backend-client, auth, provider, and app-server interfaces. Extend `TurnTimingState` with exclusive phase guards and send the completed profile directly through `SessionTelemetry`, keeping all new export behavior behind the existing disabled-by-default OTLP settings.

**Tech Stack:** Rust, Tokio, Elpis app-server events, backend-client HTTP requests, OpenTelemetry metrics and structured events.

**Spec:** `docs/superpowers/specs/2026-08-31-turn-cost-latency-observability-design.md`

## Global Constraints

- Do not import `codex-rs/analytics`, Statsig, a dashboard, or a new database.
- Do not enable logs, traces, metrics, or cost polling by default.
- Do not fabricate a per-turn dollar cost for ChatGPT subscription auth.
- Do not log prompts, responses, tool output, credentials, or hidden reasoning.
- Do not change model selection, reasoning selection, pruning policy, memory, RAG, or session semantics.
- Do not stop, replace, install, or restart the running Elpis process.
- Prefix every Cargo command with `CODEX_SKIP_BWRAP_BUILD=1` and use the existing shared target directory.
- Run focused local checks; leave broad workspace and platform builds to CI.

---

### Task 1: Backend turn-cost query boundary

**Files:**
- Create: `codex-rs/backend-client/src/client/turn_usage.rs`
- Modify: `codex-rs/backend-client/src/client.rs`
- Modify: `codex-rs/backend-client/src/lib.rs`
- Modify: `codex-rs/backend-client/Cargo.toml`
- Create: `codex-rs/backend-client/tests/turn_usage.rs`
- Modify: `codex-rs/Cargo.lock`

**Interfaces:**
- Consumes: `Client.base_url`, `Client.auth_provider`, and provider scope headers.
- Produces: `ApiKeyTurnCostStatus`, `ApiKeyResponseCost`, `ApiKeyTurnCost`, `Client::query_api_key_turn_costs`, and `Client::query_api_key_turn_costs_at`.

- [ ] **Step 1: Write the fail-first request/response tests**

Add tests that call the real client against the existing local HTTP test server and assert the literal request body:

```json
{"turn_ids":["turn-a","turn-b"]}
```

Assert API-key authorization and only `OpenAI-Organization` / `OpenAI-Project` provider headers reach the request. Deserialize one `pending` turn and one fully populated `priced` turn. Add a negative test proving an unrelated provider header is absent.

- [ ] **Step 2: Run the backend-client tests and verify RED**

Run:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target nice -n 10 cargo test -p codex-backend-client --test turn_usage --locked -- --nocapture
```

Expected: compilation fails because the module, exported types, and methods do not exist.

- [ ] **Step 3: Implement the minimal query boundary**

Add the source-faithful serde types and two methods. `query_api_key_turn_costs` rewrites ChatGPT hosts to the analytics host and `/v1/analytics/codex/turn-costs`; `query_api_key_turn_costs_at` accepts an explicit custom-provider URL. Both reuse the existing auth provider and detailed request error path.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: positive request/response and negative header cases pass.

- [ ] **Step 5: Commit the backend boundary**

Stage only the six Task 1 files and commit `feat(telemetry): query backend turn costs`.

---

### Task 2: Cost metric and bounded app-server worker

**Files:**
- Modify: `codex-rs/otel/src/events/session_telemetry.rs`
- Modify: `codex-rs/otel/src/metrics/client.rs`
- Modify: `codex-rs/otel/src/metrics/config.rs`
- Modify: `codex-rs/otel/src/metrics/names.rs`
- Modify: `codex-rs/otel/src/provider.rs`
- Modify: `codex-rs/otel/tests/suite/snapshot.rs`
- Create: `codex-rs/app-server/src/turn_cost_worker.rs`
- Create: `codex-rs/app-server/src/turn_cost_worker_tests.rs`
- Modify: `codex-rs/app-server/src/lib.rs`
- Modify: `codex-rs/app-server/src/message_processor.rs`
- Modify: `codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- Modify: `codex-rs/app-server/src/request_processors/thread_processor.rs`
- Modify: `codex-rs/app-server/src/request_processors/turn_processor.rs`

**Interfaces:**
- Consumes: Task 1 query methods, `EventMsg` lifecycle events, `AuthManager`, `Config.otel`, and `SessionTelemetry`.
- Produces: `SessionTelemetry::record_turn_cost`, `TurnCostWorker::spawn`, `TurnCostWorker::handle`, and nonblocking `TurnCostWorkerHandle::observe_event`.

- [ ] **Step 1: Write fail-first cost conversion tests**

Add an in-memory metric test that records `0.0001245` and asserts exactly `125` on `codex.turn.cost_microusd`, including turn, conversation, interruption, speed, and effort attributes. Add malformed and overflowing inputs and assert no metric point is created.

- [ ] **Step 2: Run the OTEL tests and verify RED**

Run:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target nice -n 10 cargo test -p codex-otel --test tests turn_cost --locked -- --nocapture
```

Expected: compilation fails because `record_turn_cost` and the metric name do not exist.

- [ ] **Step 3: Implement and verify the cost recording method**

Port Codex's checked decimal-to-microdollar conversion and structured event. Run Step 2 again and require all positive and negative cases to pass.

- [ ] **Step 4: Write fail-first worker behavior tests**

Add tests for these literal behaviors:

- default no-export config returns `None`;
- configured exporter plus supported API-key auth creates a worker;
- ChatGPT subscription auth does not enqueue default-provider cost observations;
- start + response-complete + turn-complete + priced backend result records once;
- pending, response-count lag, interruption, retry exhaustion, and shutdown follow the spec.

- [ ] **Step 5: Run worker tests and verify RED**

Run:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target nice -n 10 cargo test -p codex-app-server turn_cost_worker --locked -- --nocapture
```

Expected: compilation fails because the worker and event wiring do not exist.

- [ ] **Step 6: Adapt the bounded worker and lifecycle wiring**

Use the current Codex limits: channel 16,384; tracked turns 4,096; query batch 100; request timeout 15 seconds; poll interval 150 seconds; stalled polls 5. Spawn only when log or metric OTLP is explicitly configured and disable Amazon Bedrock. Pass a handle through both thread and turn processors, observe outbound thread events without blocking, and cancel the worker during app-server drain.

- [ ] **Step 7: Run worker and adjacent app-server tests and verify GREEN**

Run the Step 5 command plus the focused thread lifecycle tests touched by constructor changes. Expected: worker positive/negative tests and existing lifecycle tests pass.

- [ ] **Step 8: Commit the cost worker slice**

Stage only the Task 2 files and commit `feat(telemetry): emit bounded turn cost observations`.

---

### Task 3: Exclusive turn-latency profile

**Files:**
- Modify: `codex-rs/core/src/turn_timing.rs`
- Modify: `codex-rs/core/src/turn_timing_tests.rs`
- Modify: `codex-rs/core/src/tasks/compact.rs`
- Modify: `codex-rs/core/src/tasks/mod.rs`
- Modify: `codex-rs/core/src/session/turn.rs`
- Modify: `codex-rs/core/tests/suite/otel.rs`
- Modify: `codex-rs/otel/src/events/session_telemetry.rs`
- Modify: `codex-rs/otel/src/metrics/config.rs`
- Modify: `codex-rs/otel/src/metrics/names.rs`
- Modify: `codex-rs/otel/src/provider.rs`
- Modify: `codex-rs/otel/tests/suite/otel_export_routing_policy.rs`
- Modify: `codex-rs/otel/tests/suite/snapshot.rs`

**Interfaces:**
- Consumes: existing `TurnTimingState`, sampling loop, compaction paths, tool-future drain, and `SessionTelemetry`.
- Produces: `TurnProfile`, `TurnProfileTimingGuard`, `begin_sampling`, `begin_compaction`, `begin_tool_blocking`, `record_sampling_retry`, `complete_profile_and_duration_ms`, and `SessionTelemetry::record_turn_profile`.

- [ ] **Step 1: Write fail-first profile state tests**

Drive a hand-timed state machine with literal expected output:

```rust
TurnProfile {
    before_first_sampling_ms: 100,
    sampling_ms: 700,
    compaction_ms: 0,
    between_sampling_overhead_ms: 100,
    tool_blocking_ms: 300,
    after_last_sampling_ms: 100,
    sampling_request_count: 2,
    sampling_retry_count: 1,
}
```

Add separate compaction exclusivity, sum-equals-duration, repeated-completion, pre-start, overlap, and post-completion negative tests.

- [ ] **Step 2: Run core timing tests and verify RED**

Run:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target nice -n 10 cargo test -p codex-core turn_timing --lib --locked -- --nocapture
```

Expected: compilation fails because the profile API does not exist.

- [ ] **Step 3: Implement the profile state machine**

Adapt the current Codex phase accumulator and RAII guard into the existing Elpis timing file. Preserve TTFT, TTFM, Unix timestamps, and completion event duration. Recover a poisoned profile mutex using its inner state.

- [ ] **Step 4: Run core timing tests and verify GREEN**

Run Step 2 and require all timing tests to pass.

- [ ] **Step 5: Write fail-first profile telemetry tests**

Record a literal profile and assert six `codex.turn.profile.duration_ms` points with exact phase tags, plus request/retry histograms and a structured `codex.turn_profile` event. Assert no prompt or response fields exist.

- [ ] **Step 6: Run OTEL profile tests and verify RED**

Run:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target nice -n 10 cargo test -p codex-otel --test tests turn_profile --locked -- --nocapture
```

Expected: compilation fails because profile metric names and recording method do not exist.

- [ ] **Step 7: Implement profile telemetry and runtime guards**

Record the six low-cardinality phase measurements and two count measurements. Start sampling immediately before stream creation, count accepted retries, wrap manual and automatic compaction, wrap only a nonempty tool-future drain, and record the immutable profile on both completion and abort paths.

- [ ] **Step 8: Run focused core and OTEL tests and verify GREEN**

Run Steps 2 and 6 plus focused sampling, compaction, and task completion tests. Expected: new profile behavior and existing TTFT/TTFM/completion behavior pass.

- [ ] **Step 9: Commit the latency slice**

Stage only the Task 3 files and commit `feat(telemetry): profile turn latency phases`.

---

### Task 4: Combined regression, build, and isolated evidence

**Files:**
- Inspect: all files changed by Tasks 1-3
- Update local-only coordinator record: `~/Desktop/p/Elpis/TASKS.md`

**Interfaces:**
- Consumes: Tasks 1-3 and the committed OpenAI model/reasoning picker baseline.
- Produces: focused automated evidence, a separate binary, and an isolated tmux user test; no installation or acceptance claim.

- [ ] **Step 1: Review scope and formatting**

Run `git status --short`, `git diff --check`, and format only explicit edited Rust paths. Confirm no auth, pruning, memory, RAG, TUI, session storage, or installed-binary file changed.

- [ ] **Step 2: Run all focused green tests**

Rerun Tasks 1-3 commands and the existing model catalog/reasoning/config tests from `docs/superpowers/plans/2026-08-31-openai-model-reasoning-selection.md`.

- [ ] **Step 3: Run focused crate checks**

Run checks for `codex-backend-client`, `codex-otel`, `codex-core`, `codex-app-server`, and the Elpis-producing TUI package with `CODEX_SKIP_BWRAP_BUILD=1`. Do not run a comprehensive local workspace build.

- [ ] **Step 4: Build a separate Elpis binary**

Build only the package that produces `elpis` into the shared target directory. Copy or link it to a new test-only launcher path; do not replace `~/.local/bin/elpis` and do not restart any process.

- [ ] **Step 5: Verify opt-in and opt-out behavior**

Use isolated configuration and a local OTLP capture endpoint. Run one real turn and assert at least one sampling request profile arrives. Run with default telemetry settings and assert no cost probe or telemetry export occurs. Use mocked backend evidence for monetary cost because ChatGPT subscription auth does not report a metered per-turn price.

- [ ] **Step 6: Launch the test binary in tmux**

Create a separate, visible, resumable tmux session. Preserve the existing test and normal Elpis sessions. Give Masih the session name and a short acceptance checklist.

- [ ] **Step 7: Record evidence without claiming acceptance**

Update local `TASKS.md` with exact checks, skipped broad checks, limitations, and `awaiting Masih acceptance`. Only Masih may mark the feature verified.

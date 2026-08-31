# Turn Cost and Latency Observability

## Status

Approved in chat by Masih on 2026-08-31. Automated checks are evidence; only
Masih can accept the installed behavior.

## Intent

Bring current Codex turn-cost and turn-profile observability into Elpis without
importing Codex's analytics subsystem, enabling telemetry by default, changing
authentication, or disturbing the existing model/reasoning picker and running
Elpis process.

## Scope

### Included

1. Query the same backend turn-cost endpoint used by current Codex for metered
   API-key and compatible custom-provider turns.
2. Emit the backend's estimated turn cost as `codex.turn.cost_microusd`, rounded
   to the nearest micro-US-dollar, plus the existing structured cost log event.
3. Break each turn's elapsed time into these mutually exclusive phases:
   - before first sampling request;
   - model sampling;
   - compaction;
   - between-sampling Elpis overhead;
   - blocking on tools or user input;
   - after the final sampling request.
4. Record sampling request and retry counts for each completed or interrupted
   turn.
5. Export these signals only through Elpis's existing explicitly configured
   OTLP logs/metrics path.
6. Preserve the committed OpenAI model/reasoning picker behavior as a regression
   gate on the combined branch.

### Excluded

- importing `codex-rs/analytics`, Statsig, a new analytics database, or a
  background upload service;
- enabling any telemetry exporter by default;
- a dashboard or new TUI surface;
- fabricating a monetary price for ChatGPT subscription turns, whose cost is not
  reported by Codex's API-key turn-cost endpoint;
- local pricing tables or token-to-dollar estimates;
- pricing Elpis's separate Ace pruning pass archive (the existing Task 33);
- RAG, MCP, memory, pruning policy, model picker animation, or release work.

## Requirements

### R1. No exporter means no new network activity

When both OTLP log and metric exporters are disabled, the turn-cost worker is
not created and no cost probe or polling request is made.

Positive test: configure an in-memory or explicit OTLP exporter and assert the
worker is available for a supported provider.

Negative test: use the default telemetry configuration and assert worker
creation returns `None` without constructing or calling a backend client.

### R2. Backend cost is source-faithful and bounded

The worker observes turn start, raw-response completion, successful completion,
and interruption. It polls only finished turns, batches at most 100 IDs, bounds
its channel and tracked-turn map, retries stalled backend results at most five
times, and stops cleanly with app-server shutdown.

Positive test: a priced response with enough completed response events emits one
cost observation with model, speed, reasoning effort, and interruption state.

Negative tests: pending, malformed, incomplete-response, unsupported-auth,
unsupported-provider, and exhausted-retry cases emit no cost observation.

### R3. Cost conversion is exact and safe

Decimal US-dollar strings convert to integer microdollars, preserving six
decimal places and rounding from the seventh. Malformed, negative, and
overflowing values do not create a metric. The structured log retains the
backend-provided string.

Positive test: `0.0001245` records `125` microdollars.

Negative tests: malformed and overflowing strings produce no metric point.

### R4. Turn profile partitions total latency

Each completed or interrupted turn yields one immutable profile. For ordinary
turns, the six phase durations sum to the same measured total duration. Repeated
completion reads return the same profile and do not double-count.

Positive test: drive a deterministic sampling, tool-wait, retry, second-sampling
timeline and assert exact literal durations and counts.

Negative tests: phase starts before a turn, overlapping phase starts, and
transitions after completion do not corrupt or extend the profile.

### R5. Real runtime boundaries drive the profile

Sampling begins immediately before opening the model stream and ends when the
stream loop finishes. Compaction wraps manual and automatic compaction. Tool
blocking wraps only the await of nonempty in-flight tools. A retry increments
only after the retry handler accepts a retryable sampling failure.

Acceptance test: focused core tests prove the timing state; a real isolated turn
with opt-in metrics emits a profile containing at least one sampling request.

### R6. Existing telemetry is extended, not replaced

Existing end-to-end, TTFT, TTFM, API-request, and tool-call metrics remain
unchanged. The profile adds:

- `codex.turn.profile.duration_ms`, with one low-cardinality `phase` tag per
  phase;
- `codex.turn.profile.sampling_request_count`;
- `codex.turn.profile.sampling_retry_count`;
- structured `codex.turn_profile` fields including the turn ID for correlation.

No prompt, response, tool output, credential, filesystem content, or hidden
reasoning is attached.

### R7. Model, auth, context, and process behavior are regressions

The combined branch must retain account catalog loading, model selection,
reasoning selection, provider/model/effort persistence, context pruning, session
continuity, and process ownership. Automated work does not replace or restart
the installed Elpis binary.

## Architecture

### Cost path

Add the current Codex turn-cost request schema to `codex-backend-client`. Add a
bounded app-server worker that receives relevant thread events and polls the
backend only when a user explicitly configured OTLP logs or metrics. Adapt the
current Codex implementation to Elpis's existing HTTP-client and provider APIs;
do not update unrelated donor subsystems.

The default OpenAI provider path accepts API-key authentication only, matching
Codex. Compatible custom providers may expose the same analytics endpoint.
ChatGPT subscription authentication remains usable for inference and model
selection but does not claim a monetary turn price.

### Latency path

Extend the existing `TurnTimingState` with the current Codex exclusive-phase
state machine and RAII guards. Keep the timing fact local to `codex-core`; emit
its scalar values through a new `SessionTelemetry::record_turn_profile` method
instead of depending on `codex-analytics`.

The profile method records low-cardinality metrics and one structured event.
Metric export remains governed by the existing optional metrics exporter; log
export remains governed by the existing optional log exporter.

### Failure behavior

- Cost backend failure never blocks or fails a user turn.
- A full observation channel drops the telemetry observation, not the turn.
- Unsupported authentication/provider combinations emit no cost rather than
  guessing.
- A poisoned profile lock recovers its inner state, matching current Codex.
- Missing or disabled exporters preserve the existing no-export default.

## Expected Files

- `codex-rs/backend-client/src/client.rs`
- `codex-rs/backend-client/src/client/turn_usage.rs`
- `codex-rs/backend-client/src/lib.rs`
- `codex-rs/backend-client/Cargo.toml`
- `codex-rs/backend-client/tests/turn_usage.rs`
- `codex-rs/Cargo.lock`
- `codex-rs/app-server/src/lib.rs`
- `codex-rs/app-server/src/message_processor.rs`
- `codex-rs/app-server/src/request_processors/thread_lifecycle.rs`
- `codex-rs/app-server/src/request_processors/thread_processor.rs`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/app-server/src/turn_cost_worker.rs`
- `codex-rs/app-server/src/turn_cost_worker_tests.rs`
- `codex-rs/core/src/turn_timing.rs`
- `codex-rs/core/src/turn_timing_tests.rs`
- `codex-rs/core/src/tasks/compact.rs`
- `codex-rs/core/src/tasks/mod.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/otel/src/events/session_telemetry.rs`
- `codex-rs/otel/src/metrics/names.rs`
- `codex-rs/otel/tests/suite/snapshot.rs`
- focused test/support files only when compilation proves they are required.

If implementation requires a new analytics service, database migration, TUI
surface, credential store, context-policy change, or default exporter, stop and
return to Masih.

## Evaluation

1. Establish focused green baselines for `codex-backend-client`, OTEL metrics,
   core turn timing, and app-server lifecycle tests.
2. Add positive and negative tests and demonstrate the relevant tests fail for
   the intended missing behavior before production changes.
3. Implement each slice minimally, then rerun its focused tests to green.
4. Format only edited Rust files and run `git diff --check`.
5. Run focused crate checks locally with `CODEX_SKIP_BWRAP_BUILD=1`; leave broad
   workspace/platform coverage to CI.
6. Build a separate Elpis binary without installing or restarting it.
7. Run that binary in a separate tmux session with isolated telemetry settings;
   capture profile export from a real turn and verify the default configuration
   emits nothing.
8. Compare the model/reasoning picker path against its prior focused tests.
9. Hand Masih the isolated test command and exact limitations. The work remains
   unverified until Masih accepts it.

# Smart Prune Admission Implementation Plan

> **Coordinator rule:** One implementation owner edits this worktree. Subagents may
> inspect and review bounded surfaces, but they do not edit production files or the
> project control documents.

**Goal:** Admit semantically compact client-side tool output before its first main-model
exposure, keep admitted history immutable, expose a persistent Ledger switch and
dashboard evidence, and prove the cache-stability mechanism without overstating
provider cache benefit.

**Architecture:** Batch fresh post-hook textual tool results at `drain_in_flight`, run a
strict fail-open Luna decision in an isolated client session, atomically archive exact
source/admitted envelopes, and record only the admitted envelopes in ordinary history.
Remove automatic retrospective Ace calls; retain manual `/prune`. Correlate each applied
admission with a hash-only pre-send manifest and the following provider-reported usage.

**Tech stack:** Rust, Tokio, Responses mock server/Wiremock, serde JSON, SHA-256,
ratatui, static HTML/CSS/JavaScript dashboard.

**Spec:** `docs/superpowers/specs/2026-08-31-smart-prune-admission-design.md`

**Execution status (2026-09-01):** Local implementation and deterministic mechanism
verification are complete. A matched live-provider OFF/ON study remains intentionally
separate; no provider cache/cost benefit is claimed from the local tests.

## Global constraints

- Work only in `.worktrees/smart-prune-admission` on branch
  `feat/smart-prune-admission`, based on exact SHA `9024d4b01d76e320b5d31ecf36e1178d47be5620`.
- Do not touch, install, restart, or attach to the running Elpis process.
- Do not edit another worktree, generated user config, benchmark result, or credential.
- Prefix every Cargo command with `CODEX_SKIP_BWRAP_BUILD=1` and use
  `CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target`.
- Format only explicit edited Rust files; never run workspace-wide formatting.
- Keep Smart Prune default off.
- Automatic Smart Prune never deletes a whole event and never rewrites admitted history.
- Full tool content stays out of dashboard payloads and ordinary logs.
- Missing `cache_write_tokens` remains distinct from reported zero.
- Every behavioral slice needs a positive and negative/failure check where applicable.
  Captured fail-first evidence is required for the primary admission seam; historical
  pre-implementation RED output is not reconstructed for every slice.

---

### Task 1: Pure admission policy and envelope transformer

**Files:**

- Create: `codex-rs/core/src/smart_prune.rs`
- Modify: `codex-rs/core/src/lib.rs`
- Test in: `codex-rs/core/src/smart_prune.rs`

- [x] Write tests for 1,024-token eligibility, strict all-ids JSON parsing, unknown/
  duplicate/missing ids, `unchanged`, savings floor, function/custom envelopes, success
  preservation, and unsupported structured content.
- [ ] Run the focused test filter and capture RED because the policy/transformer does
  not exist.
- [x] Implement constants, request/decision serde types, batch construction, validation,
  stable archive marker, and body-only transformation.
- [x] Require no decision representation capable of deleting an event.
- [x] Run focused tests GREEN.

Command:

```bash
cd codex-rs
CODEX_SKIP_BWRAP_BUILD=1 CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target \
  cargo test -p codex-core --lib -- smart_prune:: --nocapture
```

---

### Task 2: Preserve hook precedence at the admission boundary

**Files:**

- Modify: `codex-rs/tools/src/tool_output.rs`
- Modify: `codex-rs/core/src/tools/registry.rs`
- Modify: `codex-rs/core/src/tools/parallel.rs`
- Modify: `codex-rs/core/src/stream_events_utils.rs`
- Modify focused tool tests only as required.

- [x] Add a test proving explicit `PostToolUse` feedback is marked
  ineligible while ordinary tool output remains eligible.
- [x] Add an internal pending-tool-output wrapper carrying the response item and
  admission eligibility; do not change provider protocol shapes.
- [x] Add a default-true `ToolOutput` eligibility method and forward it through boxed
  trait objects; override only the post-hook feedback wrapper to false.
- [x] Adapt the normal turn future type and existing direct tool tests.
- [x] Run focused registry/parallel tests GREEN.

---

### Task 3: Atomic admission audit

**Files:**

- Create: `codex-rs/core/src/session/smart_prune_audit.rs`
- Modify: `codex-rs/core/src/session/mod.rs`
- Test in the new module.

- [x] Write filesystem tests for atomic publication, exact source/admitted
  JSON, SHA-256 verification, no overwrite, safe call-id filenames, and injected write
  failure.
- [x] Implement staged UUIDv7 admission directories under
  `logs/smart-prune/admissions` with schema-versioned manifest, `ace.json`, and item
  artifacts.
- [x] Make the write API return a typed durable receipt for audit callers and tests.
- [x] Ensure no compact item is returned if the audit cannot publish.
- [x] Run focused audit tests GREEN.

---

### Task 4: Model-backed admission runner and first-exposure seam

**Files:**

- Create: `codex-rs/core/src/session/smart_prune.rs`
- Modify: `codex-rs/core/src/session/mod.rs`
- Modify: `codex-rs/core/src/session/turn.rs`
- Modify: `codex-rs/core/src/responses_metadata.rs`
- Create: `codex-rs/core/tests/suite/smart_prune.rs`
- Modify: `codex-rs/core/tests/suite/mod.rs`
- Add prompt template through the existing prompts crate if required.

- [x] Add `smart_prune_admits_compact_output_before_first_main_followup` using the
  existing Responses mock sequence. Assert request order `main -> Luna -> main`, raw
  sentinel only in the Luna request, compact output only in the first main follow-up,
  unchanged envelope/call id, stable main cache key, and isolated Smart Prune cache key.
- [ ] Run and capture RED on the untouched seam.
- [x] Implement one 45-second-bounded admission pass after all tool futures finish and
  before any result is recorded.
- [x] Skip admission when the turn is already cancelled and cancel an in-flight optimizer
  request immediately on interrupt without publishing an audit.
- [x] Pass active question, matching invocation, and eligible sibling results. Preserve
  original order and pass ineligible outputs through byte-for-byte.
- [x] Archive the canonical post-hook source before returning any compact result.
- [x] Cover mode-off, malformed/incomplete responses, audit-write failure,
  insufficient savings, and mixed eligible/ineligible outputs at the smallest owning
  unit. Keep the 45-second timeout on the same fail-open branch; the timer expiration
  itself is code-inspected rather than exercised by a 45-second test fixture.
- [x] Add a two-tool-cycle test asserting the first main follow-up input is an exact
  prefix of the second and its first admitted item appears once, byte-identical.
- [x] Run core unit and smart-prune integration tests GREEN.

---

### Task 5: Eliminate automatic retrospective mutation

**Files:**

- Modify: `codex-rs/core/src/session/turn.rs`
- Modify: `codex-rs/core/src/session/context_prune.rs`
- Modify: `codex-rs/core/src/context_pruner.rs` only as needed to remove dead automatic
  entry points while retaining manual behavior.
- Modify: `codex-rs/core/tests/suite/context_prune.rs`
- Modify: `codex-rs/features/src/lib.rs`
- Modify: `codex-rs/features/src/tests.rs`

- [x] Add a negative integration test that enables Smart Prune, advances beyond the old
  pressure boundary, and asserts no automatic compacted checkpoint/history rewrite.
- [x] Remove both pre-request and post-sampling automatic Ace calls.
- [x] Preserve `run_manual_context_prune` and `/force-prune` behavior.
- [x] Update the feature description to Smart Prune while retaining the existing config
  key and default-off behavior.
- [x] Run manual-prune regression tests plus the no-retrospective-rewrite test GREEN.

---

### Task 6: Runtime state, request manifest, and response correlation

**Files:**

- Modify: `codex-rs/protocol/src/protocol.rs`
- Modify: `codex-rs/core/src/state/session.rs`
- Modify: `codex-rs/core/src/session/session.rs`
- Modify: `codex-rs/core/src/session/mod.rs`
- Modify: `codex-rs/core/src/session/turn.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- Modify: `codex-rs/app-server/src/bespoke_event_handling.rs`
- Modify: `codex-rs/app-server/src/request_processors/token_usage_replay.rs`
- Modify generated protocol schemas only with the repository generator.

- [x] Add tests for per-session counters, bounded latest summary, request sequence/hash,
  pending admission linkage, response id/usage correlation, and nullable cache writes.
- [x] Add a narrow runtime Smart Prune state initialized from the feature key.
- [x] Make `refresh_runtime_config` update only this state from freshly resolved config;
  existing turn snapshots remain immutable and the next turn observes the new value.
- [x] Before each main send, hash the logical `ResponseItem` input before transport and
  atomically attach a hash-only request manifest to pending admission evidence.
- [x] On `ResponseEvent::Completed`, attach response id and provider-reported usage to
  that request and update per-session counters.
- [x] Propagate the bounded stats snapshot through token-usage notifications and the
  dedicated thread-scoped config-refresh notification path.
- [x] Run protocol/core/app-server focused tests GREEN.

---

### Task 7: Ledger switch and `/smart-prune`

**Files:**

- Modify: `codex-rs/tui/src/slash_command.rs`
- Modify: `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/chatwidget/constructor.rs`
- Modify focused Ledger/slash/config tests and snapshots.

- [x] Add command tests for toggle/on/off/idempotence/invalid arguments and
  active-turn rejection.
- [x] Add render/input tests for ON/OFF rail position, literal state, gradient
  cells, minimum/wide widths, `p` key, mouse click, and no effect while unfocused/busy.
- [x] Implement the persist-first feature update using `UpdateFeatureFlags`; never mutate
  the displayed state optimistically.
- [x] Render the signature violet-to-teal-to-emerald-to-mint rail with explicit text and
  an ANSI-safe semantic fallback.
- [x] Add bounded aggregate/latest evidence below the switch without turning the Ledger
  into a raw event viewer.
- [x] Run focused TUI tests and review rendered buffers.

---

### Task 8: Dashboard evidence surface

**Files:**

- Modify: `codex-rs/tui/src/dashboard_server.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs`
- Modify: `codex-rs/tui/src/dashboard_assets/index.html`
- Modify focused dashboard/context-usage tests.

- [x] Add snapshot serialization tests for state, counters, latest admission,
  request hash/sequence, response linkage, and `cache_write_tokens` null versus zero.
- [x] Implement the Smart Prune evidence section with the Ledger palette and restrained
  emphasis.
- [x] Label local estimates and mechanism evidence explicitly; do not claim dollars,
  task quality, or causal cache savings.
- [ ] Re-capture desktop and narrow-width light/dark dashboard screenshots without
  touching the running Elpis process. The dashboard was inspected in those states, but
  the temporary screenshots expired and the current browser backend is unavailable, so
  no durable screenshot artifact is claimed below.

---

### Task 9: Documentation and control-layer alignment

**Files:**

- Modify: `docs/GUIDE.md`
- Modify: `docs/context.md`
- Modify: `docs/cache-friendly-pruning.md`
- Modify: `docs/prompt-caching.md`
- Modify: `docs/WORKTREE_INTEGRATION_LEDGER.md` if its contract applies.

- [x] Describe admission-time versus retrospective pruning without Headroom-derived
  claims that are not implemented.
- [x] State exact limitations: client-side textual outputs only, local audit not
  tamper-proof, provider telemetry needed for cache benefit, task verifier needed for
  quality.
- [x] Record branch/base, changed behavior, focused validation, and integration risk with
  the moving daily-driver branch.
- [x] Do not mark provider cache/cost benefit accepted solely because code compiles.

---

### Task 10: Deliberate-break proof and focused verification

- [x] Format only edited Rust files.
- [x] Run `git diff --check` and inspect `git diff --stat`/`git status` for scope.
- [x] Run focused core, tools, protocol, app-server, and TUI tests.
- [x] Run the existing WebSocket strict-prefix tests unchanged.
- [x] Temporarily bypass the admission call, rerun the first-exposure test, and preserve
  the expected failure output; restore immediately and rerun GREEN.
- [x] Run focused crate checks; run workspace `--all-targets` only if disk and time remain
  safe and classify all pre-existing failures separately.
- [x] Ask read-only review subagents to inspect cache invariants, failure/audit behavior,
  UI/measurement truthfulness, and final contract drift.

Focused command family:

```bash
cd codex-rs
export CODEX_SKIP_BWRAP_BUILD=1
export CARGO_TARGET_DIR=~/Desktop/p/Elpis/codex-rs/target
cargo test -p codex-core --lib -- smart_prune:: --nocapture
cargo test -p codex-core --test all -- suite::smart_prune:: --nocapture
cargo test -p codex-core --test all -- suite::context_prune:: --nocapture
cargo test -p codex-core --test all -- suite::client_websockets:: --nocapture
cargo test -p codex-tui --lib -- context_ledger --nocapture
cargo check -p codex-core -p codex-app-server -p codex-tui --all-targets
```

---

### Task 11: Optional live-provider cache/cost validation

This is deliberately separate from the completed local mechanism proof. It requires a
provider-authorized, matched experimental run and is not inferred from mock telemetry.

- [ ] Build a separate non-installed binary in the shared target directory.
- [ ] Create an isolated temporary Codex home and deterministic large-output task; do not
  use Masih's active session/config/rollout.
- [ ] Verify provider, model, endpoint, credentials availability, and task verifier before
  interpreting results.
- [ ] Run a Smart Prune OFF/ON pilot and inspect raw audit/request/dashboard/Ledger data.
- [ ] If the pilot is healthy, run three batches of ten matched paired trials; otherwise
  report the exact external blocker and do not fabricate provider evidence.
- [ ] Compare first-exposure payload, prefix hashes, main/Ace input/output,
  cached-input, optional cache-write, latency, failures/timeouts, and task result.
- [ ] Preserve dashboard JSON, screenshot, Ledger render, audit paths, commands, and raw
  measurement table.
- [ ] Distinguish:
  - mechanically proved cache-safe history construction;
  - provider-observed cache non-regression;
  - any statistically supported cache improvement;
  - unknown or unmeasured outcomes.

---

### Task 12: Final evidence audit and handoff

- [x] Re-read the spec acceptance criteria and map each to a test or artifact.
- [x] Confirm this implementation's writes stayed inside the isolated worktree and the
  active Elpis process was untouched.
- [x] Report exact changed files, commands/results, deliberate-break evidence, dashboard/
  Ledger artifacts, provider-run results, and remaining limitations.
- [x] Do not merge, install, push, or replace the running binary without a separate user
  instruction.

Acceptance-to-evidence map:

- admission policy, envelope preservation, no-delete representation, and fail-open
  boundaries: `core` Smart Prune unit tests;
- pre-first-exposure placement, stable main cache key/prefix, audit-before-admission,
  failure pass-through, retry correlation, and cancellation: mock-provider Smart Prune
  integration tests;
- no retrospective automatic Ace mutation: focused `context_prune` regression test;
- toggle, Ledger state/input/layout, dashboard counters, and missing-versus-zero cache
  telemetry: focused TUI, dashboard, protocol, and app-server tests;
- deliberate seam break: captured fail-first request-length mismatch, followed by restored
  GREEN test;
- provider-observed cache/cost/quality and durable screenshot artifacts: explicitly
  pending under Task 11 and the unchecked dashboard capture item, not local acceptance.

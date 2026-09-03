# Smart Prune: Cache-Stable Tool-Output Admission

## Status

Approved in chat by Masih on 2026-08-31. Masih delegated threshold, key-binding,
failure-policy, and implementation details provided the core intent remains:
automatic pruning must not damage prompt-cache reuse, whole tool events must not
be deleted automatically, and the result must be proved with tests, the runtime
dashboard, the Context Ledger, and durable evidence.

## Intent

Replace Elpis's automatic retrospective Ace rewriting with admission-time semantic
optimization of fresh client-executed tool results. The main model must receive the
admitted form on its first exposure, after which that exact history remains stable.

`/prune` remains the explicit retrospective maintenance command. Native compaction
remains the context-limit fallback. Neither is part of Smart Prune's automatic path.

## Non-negotiable invariants

1. Smart Prune never deletes a tool call or tool-output event.
2. It preserves the output variant, call id, custom-tool name, success value, item
   ordering, and call/output pairing. Only a textual output body may change.
3. It runs after the tool and `PostToolUse` hooks finish, but before
   `record_conversation_items` admits that output to working history or a main-model
   request.
4. Explicit hook feedback or blocking takes precedence and is never semantically
   rewritten.
5. Once an item has entered main-model history, Smart Prune never revisits it.
6. Automatic pressure Ace does not run while this design is in force. Any automatic
   retrospective mutation would change an already-sent prefix and make the
   cache-non-disruption claim false by construction.
7. Failure is fail-open: timeout, provider failure, malformed response, unsupported
   payload, insufficient savings, or audit-write failure sends the canonical original
   output unchanged.
8. A compact result may reference archived evidence only after that evidence has been
   durably written.
9. The admission Ace call uses an isolated client session and cache namespace; it must
   not disturb the main turn's incremental response state.
10. No dashboard number is presented as provider cost, task quality, or causal cache
    improvement unless its source supports that claim.

## Scope

### Included

- client-executed `FunctionCallOutput` and `CustomToolCallOutput` textual bodies;
- one batched Ace decision after each sampling step's tool futures finish;
- a default-off, persist-first Smart Prune control;
- `/smart-prune`, `/smart-prune on`, and `/smart-prune off`;
- a prominent Context Ledger switch and keyboard control;
- an append-only admission audit and pre-send request manifest;
- runtime dashboard and Ledger aggregates;
- deterministic unit and mock-provider integration tests;
- documentation of mechanism, measurements, and limitations.

### Excluded

- matched live-provider cache/cost/quality validation, which remains an optional
  follow-up experiment rather than local implementation acceptance;
- provider-executed built-in tool results that Elpis never receives before the
  provider sees them;
- images, audio, encrypted content, tool-search payloads, user messages, assistant
  messages, and reasoning items;
- automatic deletion of dead-end call/output pairs;
- retrospective automatic rewriting, even at an apparent cache miss;
- dollar estimates without a provider/model rate source;
- claims that fewer tokens alone prove better task quality or lower latency.

## Terminology

- **Canonical source:** the model-visible tool result after tool execution, output
  truncation, and `PostToolUse` policy. It is the exact value Elpis would have admitted
  without Smart Prune. It is not a pre-hook secret bypass.
- **Admitted output:** either the byte-identical canonical source or a validated compact
  textual body inside the same response envelope.
- **Main provider:** the user-turn inference stream. The separate Ace maintenance call
  does not count as first exposure to the main conversation history.
- **Admission:** the single boundary at which a fresh local tool result becomes durable
  model-visible history.

## Admission pipeline

```text
main model emits call
        |
client tool executes
        |
PostToolUse policy runs
        |
canonical result batch assembled
        |
Smart Prune OFF / ineligible --------------------------> admit originals
        |
durable proposed-admission audit written
        |
validated compact bodies applied to cloned envelopes
        |
admit exactly once to working history + rollout
        |
hash request input immediately before next main send
        |
provider usage linked back to that request manifest
```

The optimizer sees the active user question, matching tool name/input, and all eligible
sibling results from the same sampling step. This provides the relevant available
picture without waiting until the history has already reached the main provider.

## Eligibility and profitability policy

Admission-time optimization adds one model request and therefore needs a guard distinct
from cache safety.

- A result is eligible only when its body is pure text and contains at least 1,024
  approximate tokens.
- The 1,024-token initial threshold is conservative for a model-backed pass; it is not
  copied from Headroom's cheaper compressor and is not claimed as a provider cache
  boundary.
- Eligible sibling results are batched once per sampling step, oldest/call order
  preserved, with a hard 24,000 approximate-token pass cap. A result that exceeds the cap
  remains unchanged; it is not sent unbounded to the optimizer. Later in-range siblings
  remain eligible.
- Ace may explicitly choose `unchanged` for any result.
- Elpis rejects a proposed compact body unless the final admitted body, including its
  evidence marker, saves at least 20 percent and at least 256 approximate tokens.
- The session snapshot records eligible unchanged, optimized, and failed outcomes, plus
  optimizer request/usage/latency totals, so the threshold can later be tuned from
  evidence. Below-threshold outputs do not trigger or count as optimizer requests.

This policy bounds cost and latency. It does not provide cache safety; immutability after
admission provides cache safety.

## Ace contract

Use `gpt-5.6-luna` with maximum reasoning for the initial implementation, falling back
to the active turn model only through the existing provider-compatible fallback rule.
The request uses a dedicated `:smart-prune` prompt-cache namespace and a fresh model
client session.

The response is strict JSON containing exactly one decision per eligible call id:

```json
{
  "items": [
    {"call_id": "call-1", "decision": "compact", "content": "..."},
    {"call_id": "call-2", "decision": "unchanged"}
  ]
}
```

Unknown, duplicate, missing, or empty compact entries invalidate the entire batch. A
compact body must state concrete relevant evidence and outcomes, not invent facts or
instructions. Elpis appends a small stable archive marker containing the admission id,
source SHA-256, and call id. The marker never claims the model can dereference it.

The full pass is bounded by a 45-second timeout. Failure leaves every output unchanged.
Turn cancellation skips a not-yet-started pass and cancels an in-flight optimizer request;
it never publishes an admission audit.

## Durable evidence

Each successfully applied batch receives a UUIDv7 admission id under:

```text
<codex_home>/logs/smart-prune/admissions/<admission-id>/
```

Successful atomic publication contains:

- `manifest.json`: schema version, session/turn/admission ids, timestamp, model,
  estimated source/admitted/saved tokens, item decisions, source hashes, and artifact paths;
- `ace.json`: instructions, bounded input, raw response, and reported usage;
- `items/NNN-<safe-call-id>.source.json`: the exact canonical source envelope;
- `items/NNN-<safe-call-id>.admitted.json`: the exact admitted envelope.

The directory is staged and renamed atomically. If publication fails, the batch is not
optimized. The Smart Prune subtree is private (`0700` directories and `0600` JSON on
Unix). Rejected and failed optimizer calls are represented by bounded aggregate session
counters rather than a second raw-output archive.

Immediately before the next main-provider attempt, Elpis appends `request.json` containing
the request sequence and canonical SHA-256 of the logical `ResponseItem` input before
transport adaptation. Instructions, tools, and request options are outside that hash. It
does not duplicate the full prompt and does not claim that HTTP and WebSocket framing are
byte-identical. The matching completed response appends `response.json` with response id
and provider-reported input, cached-input, optional cache-write, output, reasoning, and
total tokens.

The audit preserves exact source/admitted envelopes and records ordering plus a logical
input hash. Mock-provider captures provide the request-input comparison. Neither makes
the local filesystem tamper-proof or proves provider-side cache causality.

## Runtime state and toggle semantics

Keep the existing default-off `automatic_context_pruning` config key for compatibility,
but change its product meaning and label to Smart Prune. Do not create a second setting.

- Startup initializes the session's Smart Prune runtime state from that key.
- Config writes remain persist-first and managed-config constraints remain authoritative.
- Runtime config refresh updates only this narrow Smart Prune state; other feature gates
  remain session-static.
- The control is disabled while a turn is active. A change applies to future turns only,
  preventing a half-turn whose early and late tool results use different policies.
- Turning Smart Prune on never rewrites existing history.
- Turning it off never expands or mutates already-admitted compact results.

Command behavior:

- `/smart-prune` toggles the effective state.
- `/smart-prune on` and `/smart-prune off` are explicit and idempotent.
- Any other argument displays the exact usage and changes nothing.

## Context Ledger design

Place the control between the Ledger identity/header and `CONTEXT WINDOW`:

```text
SMART PRUNE                          [━━━●] ON
  Before first send · sent history stays stable
  p toggle · /smart-prune on|off
```

Off state:

```text
SMART PRUNE                         [●━━━] OFF
  Tool results pass through unchanged
```

Press `p` while the Ledger is focused and the session is idle. A mouse click on the
switch has the same effect. While a turn is active, the control remains visible but
shows `available after turn` and emits no update.

The on-state rail is a discrete terminal-cell gradient, not a fake CSS gradient:

- violet `#8B5CF6` for one leading rail cell;
- teal `#14B8A6`;
- emerald `#10B981`;
- mint `#4ADE80` for the knob and `ON` label.

The visual spends its emphasis on this one control. `ON`/`OFF` text and knob position
make state legible without color; ANSI-only terminals fall back to bold green or muted
gray. There is no blinking or background fill.

Below the switch, show per-session aggregate evidence when available: optimized versus
examined outputs, approximate source to admitted tokens, failures, and the latest
admission id/status. The Ledger remains a compact control/summary, not a raw event log.

## Dashboard design

Extend the existing dashboard with a Smart Prune evidence section using the same
teal-to-mint identity as the Ledger:

- current effective state;
- examined, optimized, unchanged, and failed counts;
- approximate source, admitted, and saved tokens;
- latest admission id and outcome;
- explicit `before first send -> request N -> provider response` sequence;
- request-input hash;
- provider-reported main-response input, cached-input, optional cache-write, and output;
- optimizer request count, usage-report coverage, cumulative provider-reported usage, and
  cumulative wait, shown separately from main-session usage;
- link/path hint for local audit details without rendering raw tool content.

The UI must render `cache_write_tokens: null` as `not reported`, never zero. It must label
token estimates as approximate and include: `Mechanism evidence; cache benefit requires
matched runs.`

## Session statistics

Store per-session Smart Prune state in core and deliver a bounded snapshot through the
existing token/context update path. An idle config change uses a dedicated thread-scoped
Smart Prune notification instead of inventing a token-usage event or turn id. The snapshot
contains cumulative admission counters, separate optimizer overhead, and only the latest
admission/request correlation. It survives neither arbitrary audit deletion nor
cross-machine migration; the append-only audit is the detailed source.

Resume reconstructs admitted history from the normal rollout. It does not rerun Smart
Prune on old items. Aggregate statistics may reconstruct from explicit rollout metadata
if added; otherwise the UI must label unavailable historical totals rather than infer
them.

## Failure behavior

- Below threshold or unsupported: unchanged, no Ace request.
- Hook feedback/block: unchanged by Smart Prune.
- Timeout/provider/stream/parse error: unchanged; failed count and optimizer overhead
  recorded in the session snapshot.
- Compact content grows or misses the profitability floor: unchanged.
- Audit write failure: unchanged and no evidence pointer.
- Request-manifest write failure: inference continues, but the dashboard marks request
  linkage unverified.
- Dashboard/Ledger failure: never blocks the user turn.
- Automatic retrospective pressure code is not called; no fallback silently invokes it.

## Verification strategy

### Deterministic red-green tests

1. Pure eligibility, strict parsing, envelope preservation, savings floor, unsupported
   payload, and all-or-nothing failure tests.
2. Hook integration proving hook input sees the canonical tool result and explicit hook
   feedback bypasses optimization.
3. Mock-provider integration proving:
   - the first follow-up request contains the admitted compact body;
   - the raw source never appears in that request;
   - call id/variant/success are unchanged;
   - a later follow-up reuses the exact admitted bytes;
   - moving optimization after send makes the assertion fail.
4. Smart Prune request-prefix coverage plus the existing generic WebSocket incremental
   tests proving an unchanged logical prefix uses the previous response id and a changed
   prefix falls back to a full input.
5. Failure coverage proving audit publication errors, malformed/incomplete responses, and
   insufficient savings pass the source through unchanged; the implementation's bounded
   timeout follows the same fail-open branch. Local tests do not wait out the 45-second
   timer itself.
6. Runtime-toggle tests proving persist-first behavior, authoritative state refresh,
   idle-only changes, and next-turn application. Managed feature constraints are not
   separately exercised.
7. Ledger render/input/mouse tests at minimum and wide widths, plus no-color semantics.
8. Dashboard serialization/render tests including absent versus zero cache writes.
9. Audit tests verifying atomicity, exact source/admitted artifacts, source SHA-256,
   request ordering, and response correlation.

Require green positive and failure-path checks for each behavior where applicable.
Historical pre-implementation RED output was not preserved for every slice; the primary
admission seam has a captured deliberate-break failure followed by restored GREEN.

### Optional controlled runtime validation

Use a separately built binary, isolated `CODEX_HOME`, isolated session ids, and a
deterministic task whose tool emits a large sentinel-rich output. Never install, restart,
or attach to Masih's running Elpis process.

Run paired Smart Prune OFF/ON trials with fixed provider, model, endpoint, prompt, and
tool output. First run a small pilot; only if provider access and verifier health are
confirmed, run three batches of ten paired trials. Capture:

- exact outgoing request assertion from the local harness;
- admission audit and request/response manifests;
- dashboard JSON and rendered screenshot;
- Context Ledger render/screenshot;
- main and Ace input/output/cached/cache-write tokens;
- latency and errors/timeouts;
- deterministic task answer/verifier result.

Optional live-provider validation is accepted only if every optimized ON trial sends
compact output on first exposure, never later rewrites it, and preserves the verifier
result. Cache non-disruption is accepted only when identical admitted prefixes remain
byte-stable and provider telemetry shows no regression versus the matched control. Cache
improvement is reported only if repeated provider telemetry supports it.

## Acceptance criteria

- Smart Prune is default off and visibly controllable through the Ledger and command.
- Enabled mode changes only future eligible client-side textual tool outputs.
- No Smart Prune or automatic Ace path deletes a whole tool call/output pair.
- No automatic retrospective Ace pass is invoked.
- The exact source is durably archived before a compact body is admitted.
- The first main-provider request contains the compact body, and no earlier
  main-conversation request contains the source body. The isolated optimizer request must
  receive the source in order to compact it.
- Subsequent history retains byte-identical admitted output.
- Every failure before admission publication passes the source through unchanged; later
  linkage or UI-refresh failures do not rewrite an already admitted envelope.
- Dashboard and Ledger accurately expose state and bounded evidence.
- Focused tests pass, the deliberate-break negative control fails, and the local
  mechanism evidence is reported with limitations stated. Live provider validation is
  optional and cannot be inferred from local acceptance.

## Expected implementation surfaces

- `codex-rs/core/src/smart_prune.rs`
- `codex-rs/core/src/session/smart_prune.rs`
- `codex-rs/core/src/session/smart_prune_audit.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/core/src/session/mod.rs`
- `codex-rs/core/src/session/session.rs`
- `codex-rs/core/src/state/session.rs`
- `codex-rs/core/src/tools/parallel.rs`
- `codex-rs/core/src/tools/registry.rs`
- `codex-rs/tools/src/tool_output.rs`
- `codex-rs/protocol/src/protocol.rs`
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`
- app-server token-usage adapters and generated schemas if compilation requires them;
- `codex-rs/features/src/lib.rs`
- `codex-rs/tui/src/slash_command.rs`
- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- `codex-rs/tui/src/chatwidget/context_ledger.rs`
- `codex-rs/tui/src/chatwidget/context_usage.rs`
- `codex-rs/tui/src/dashboard_server.rs`
- `codex-rs/tui/src/dashboard_assets/index.html`
- focused tests and documentation only.

If implementation would require storing full prompts in dashboard data, changing tool
execution semantics, bypassing hooks, enabling telemetry/network activity by default, or
touching the installed/running Elpis process, stop that approach and preserve the
invariants above.

---
name: Smart Prune cache validation
type: Maintainer acceptance protocol
---

# Smart Prune cache validation

This protocol checks one narrow claim: when Smart Prune is enabled, a fresh tool
result is optimized before its first main-model request, and later main requests
keep the already-visible prefix unchanged. It is for Elpis maintainers validating
the implementation and for a user checking it during normal work.

The existing integration test is the encoded provider-request structure proof for the
direct OpenAI GPT-5.6 default cache path. The Context Ledger, dashboard, immutable
admission audit, and optional local rollout trace provide live session evidence. A
reduced live trace proves normalized logical-history stability, not encoded wire-body
identity. No result from this protocol alone proves lower subscription cost or a
universal provider cache-hit rate.

Recorded observation: [2026-09-01 live pilot](2026-09-01-live-pilot.md).

## Claims and verdicts

| Question | Required evidence | Allowed verdict |
| --- | --- | --- |
| Did admission happen automatically before first exposure? | Positive integration test plus a linked live admission | `PROVED_MECHANISM` or `NOT_OBSERVED` |
| Did the tested GPT-5.6 path preserve the encoded provider-visible prefix and main cache key? | Captured encoded-request prefix, stamped breakpoint, and nonempty cache-key assertions | `PROVED_TESTED_PATH` or `FAILED_TESTED_PATH` |
| Did a live session retain normalized logical history? | Reduced full request-item snapshots and audit linkage | `OBSERVED_LOGICAL_STABILITY`, `CONFOUNDED`, or `UNKNOWN` |
| Did the provider reuse cache in this live session? | Nonzero cached input on the linked response | `OBSERVED_REUSE`, `NO_REUSE_OBSERVED`, or `UNKNOWN` |
| Did Smart Prune reduce provider cost versus OFF? | Matched ON/OFF provider runs with the same model, request sequence, timing, and configuration | `NOT_TESTED` unless that study is run |

`NO_REUSE_OBSERVED` is not proof that Smart Prune invalidated the cache. Provider
eviction, routing, minimum cacheable-prefix length, and elapsed time can also cause a
miss. A provider response that omits cached-input detail is currently represented as
zero, so zero cannot distinguish an explicit miss from an unreported field.
Missing `cache_write_tokens` does preserve that distinction. It may be omitted from
audit or reduced JSON rather than serialized as `null`, and must never be converted to
zero.

## Test 1: deterministic admission seam

Do not run these commands until the protocol has passed independent review.

From `codex-rs/`, run the focused target with one build job and one test thread:

```bash
CODEX_SKIP_BWRAP_BUILD=1 CARGO_BUILD_JOBS=1 nice -n 10 \
  cargo test -p codex-core --test all \
  'suite::smart_prune::smart_prune_admits_compact_output_before_first_main_followup' \
  -- --exact --test-threads=1

CODEX_SKIP_BWRAP_BUILD=1 CARGO_BUILD_JOBS=1 nice -n 10 \
  cargo test -p codex-core --test all \
  'suite::smart_prune::smart_prune_off_sends_original_without_optimizer_request' \
  -- --exact --test-threads=1
```

The positive test must prove all of these in the actual request bodies captured by the
mock provider:

- the optimizer sees the exact large source output;
- the first main follow-up sees the admitted body, not the source body;
- the first main request is an exact prefix of the follow-up main request;
- both main requests keep the cache-relevant non-input fields, including tools,
  instructions, model, reasoning settings, and `prompt_cache_key`, unchanged;
- the direct GPT-5.6 request carries a stamped `prompt_cache_breakpoint` in that stable
  prefix and a nonempty main cache key;
- the optimizer uses a different key ending in `:smart-prune`;
- the immutable audit links the admission to that first main request and response.

The OFF test is the negative condition: no optimizer request or admission audit exists,
and the first main follow-up receives the original output.

Acceptance: both tests pass. Any failed prefix, breakpoint, or key assertion is
`FAILED_TESTED_PATH`; token-usage percentages cannot override that failure.

## Test 2: normal-work live observation

Use a binary built from the reviewed branch. Do not replace the installed `elpis`
binary while another Elpis session is active. To retain exact local request evidence,
launch that binary with a private trace root:

```bash
TRACE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/elpis-smart-prune-trace.XXXXXX")
chmod 700 "$TRACE_ROOT"
CODEX_ROLLOUT_TRACE_ROOT="$TRACE_ROOT" ./target/debug/elpis
```

The command assumes the current directory is `codex-rs/` and the reviewed binary is
`target/debug/elpis`. The trace is local-only but sensitive: it can contain prompts,
tool inputs and outputs, terminal output, and paths. Do not upload it.

Inside Elpis:

1. While idle, open the Context Ledger and press `p`, or run `/smart-prune on`.
   Confirm the teal/green switch reads `ON`. The setting applies to later turns, not a
   turn already running.
2. Work normally. An eligible fresh textual tool result is approximately 1,024 tokens
   or larger; a small result may correctly pass through without an admission.
3. Do not use `/prune` or `/compact`, change model/provider, restart the session, or
   leave a long pause inside the measured window. Record any accidental confounder.
4. After a qualifying turn, reopen the Ledger. Require increased examined and admitted
   counts, a smaller source-to-admitted estimate, zero new failed batches, and
   `response linked` for the latest admission.
5. Run `/dashboard` and open **Smart Prune**. Require the latest aggregate to show
   verified request and response linkage. Record the configured preference and
   current-thread next-turn state; examined, admitted, and unchanged output counts and
   failed batch count; approximate source, admitted, and saved tokens; response input,
   cached input, and cache-write display; optimizer request and usage-report counts and
   usage; and optimizer latency.

Interpret the linked response as follows:

- cached input above zero: `OBSERVED_REUSE` for this response;
- cached input shown as zero: `NO_REUSE_OBSERVED`, not an invalidation diagnosis or
  proof that the provider explicitly reported zero;
- response usage absent: `UNKNOWN`;
- cache write shown as `not reported`: unknown, not zero.

The dashboard is aggregate-only and does not expose raw tool output, identifiers,
hashes, or filesystem paths. The authoritative exact evidence remains in the private
on-disk admission audit under `~/.elpis/logs/smart-prune/admissions/` and, when enabled,
the private trace bundle.

## Test 3: normalized live-session check

After the user finishes the session, reduce its trace without contacting a provider:

```bash
TRACE_BUNDLE=$(find "$TRACE_ROOT" -mindepth 1 -maxdepth 1 -type d -print -quit)
CODEX_SKIP_BWRAP_BUILD=1 CARGO_BUILD_JOBS=1 nice -n 10 \
  cargo run -p codex-cli --bin codex -- debug trace-reduce "$TRACE_BUNDLE"
```

Find the unique completed inference call whose `response_id` matches the admission
audit's `response.json`. Require
`state.json.rollout_id == manifest.json.session_id` and
`InferenceCall.codex_turn_id == manifest.json.turn_id`. `request_input_sha256` is an
immutable logical-request receipt, not the primary trace join: WebSocket deltas and
transport normalization may prevent recomputing it directly from a raw request payload.

Use the reducer's full ordered `request_item_ids` snapshots for prefix checks. Raw
WebSocket request `input` can contain only a delta and must not be treated as full
history. The check must establish:

1. same session and provider, with model, instructions, tools, tool choice, parallel
   tool setting, reasoning settings, store, stream, include, service tier, prompt-cache
   options, text controls, and main `prompt_cache_key` unchanged;
2. the preceding main request's `request_item_ids` are an exact prefix of the linked
   request's `request_item_ids`;
3. the linked request's `request_item_ids` remain an exact prefix of every later main
   request in the same thread until a documented confounder;
4. the linked request contains the admitted artifact and not the exact source artifact,
   allowing only the transport metadata normalization already used by the integration
   test;
5. the response ID and token usage agree with `response.json` in the admission audit;
6. no retry, manual prune/compact, model/provider change, restart, missing trace span,
   or unexplained time gap confounds the pair.

Report hashes, IDs, aggregate token counts, and verdicts only. Do not copy raw prompts
or tool output into the result.

Passing all six items yields `OBSERVED_LOGICAL_STABILITY`. Nonzero cached input
additionally yields `OBSERVED_REUSE`. It still does not establish encoded live wire-body
identity or an ON-versus-OFF cost difference.

The reducer intentionally normalizes model-visible history. It may omit Responses Lite
`AdditionalTools`, and trace requests are recorded before request-only cache-breakpoint
markers are stamped. Test 3 therefore cannot award `PROVED_TESTED_PATH`; that verdict
comes only from the encoded mock-provider requests in Test 1.

The live trace intentionally excludes the Smart Prune optimizer request. Its isolated
`:smart-prune` cache key is therefore proved by Test 1, not by the live trace.

## Optional matched cost study

Run this only if a cost claim is needed. Replay the same short captured request sequence
under fresh cache keys in two arms: recorded Smart Prune admissions versus exact-source
substitutions from the private audit. Keep model, provider, instructions, tools, timing,
and request order fixed. Report main-model usage, optimizer usage, latency, and missing
fields separately.

This study spends provider calls and tests transport/cache cost, not counterfactual task
quality. A normal work session is sufficient for the mechanism and observational checks;
it should not be duplicated merely to produce a headline percentage.

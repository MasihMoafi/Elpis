# Prompt caching

How Elpis uses the OpenAI Responses API prompt cache, where it places breakpoints, and what
it measures. For *why* the pruning layer is shaped the way it is, see
`docs/cache-friendly-pruning.md`.

## Implicit vs explicit

The Responses API caches a *prefix* of the prompt. The prefix is `instructions`, then
`tools`, then `input` up to a breakpoint. A later request whose prefix is byte-identical up
to that breakpoint reads it from cache instead of paying full input price.

**Implicit** (`prompt_cache_options` omitted, the API default): the server places one
breakpoint on the latest message **and honours any explicit breakpoints the request
carries**. That combination is what Elpis uses.

**Explicit** (`prompt_cache_options.mode = "explicit"`): the automatic latest-message
breakpoint is *disabled* and only the breakpoints the request carries are used.

A breakpoint is a `prompt_cache_breakpoint: {"mode": "explicit"}` marker on a content
block — the marker is named "explicit" in both modes:

```json
{
  "model": "gpt-5.6-sol",
  "prompt_cache_key": "019fe741-dc08-7151-8706-71ead8fcceb8",
  "prompt_cache_options": { "mode": "explicit" },
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "…",
          "prompt_cache_breakpoint": { "mode": "explicit" } }
      ]
    }
  ]
}
```

Constraints that shape everything below:

- Breakpoints are valid **only** on `input_text`, `input_image`, and `input_file` blocks.
  Reasoning items, tool calls, and tool outputs — the bulk of an agent transcript — cannot
  carry one.
- A request may create at most **four** new cache writes. In implicit mode the automatic
  latest-message breakpoint uses one, leaving three for explicit ones. Reads consider the
  latest 50 breakpoints, so entries from earlier turns can still hit.
- Explicit mode with **zero** breakpoints disables prompt caching for that request
  entirely, and is therefore strictly worse than implicit.
- GPT-5.6+ caches prefixes of **at least 1,024 tokens**. Below that a breakpoint is inert.
- `prompt_cache_options` and `prompt_cache_breakpoint` are **rejected** by models before
  GPT-5.6.

## Elpis's cache boundary

Breakpoints are gated two ways, both of which must hold:

1. the provider is OpenAI, and
2. the model slug parses as `gpt-<major>.<minor>` at or past `5.6` (`gpt-5.6-sol`,
   `gpt-5.6-terra`, `gpt-5.6-luna`, and later families).

Within that gate they ship **on by default**: they ride alongside the server's implicit
breakpoint rather than replacing it, so they can only add cache reads.

`core/src/prompt_cache.rs` places up to two positions:

- **Stable prefix** — the last eligible block in the leading run of instruction and
  tool-definition items (`AdditionalTools` and `Message` items, i.e. the developer
  instructions, AGENTS.md, and the opening user turn). The run ends at the first reasoning
  item, tool call, or assistant message. Nothing rewrites items in that run, so this is the
  floor every request can fall back to.
- **Frozen epoch boundary** — the newest context-pruning epoch marker
  (`context_pruner::frozen_prefix_len`). A pruning pass rewrites only what comes *after*
  it, so this entry survives the pass that invalidates everything else. Before the first
  pass it resolves to the stable prefix and dedupes away.

The **rolling tail** is deliberately *not* pinned on the default path: the server writes
that breakpoint itself, and duplicating it would spend one of the four per-request writes
for nothing. It is added only in explicit mode, where the automatic one is gone.

If no eligible block exists, no breakpoints and no `prompt_cache_options` are sent at all
and the server stays on implicit — never explicit-with-no-breakpoints.

The marker is stamped at serialization time (`codex_api::encode_responses_request`), not
stored on `ContentItem`. `ContentItem` is a persisted history type; a request-only cache
marker must not end up in rollouts.

### Why implicit rather than explicit

Explicit mode is available behind `Feature::ExplicitPromptCache` (`explicit_prompt_cache` in
config, **off by default**) and is not recommended. Per the current API documentation,
implicit mode already honours the breakpoints a request carries, so switching to explicit
buys no additional placement — it only *removes* the free latest-message write and forces
Elpis to reproduce it out of its own four-write budget. There is no serialized request shape
here where explicit wins.

An earlier revision of this document assumed explicit mode was required to place
breakpoints at all. It is not.

On the websocket incremental path, where a request sends only the delta and refers to the
rest via `previous_response_id`, both the options and the breakpoints are dropped: the
positions index the full input and no longer address anything.

## `prompt_cache_key`

The key routes a request to the machine holding its cache. It does not itself invalidate
anything.

- **Turn requests** use the bare session id. It is fixed for the life of the session, so
  pruning, compaction, and every other history rewrite leave it untouched. Only the prefix
  changes, which is exactly what the cache is meant to notice.
- **Background requests that reuse the session's client** get their own namespace:
  `<session-id>:context-prune` and `<session-id>:memory`. Their prefix is unrelated to the
  conversation, so sharing the turn's slot could only evict the turn prefix for no possible
  hit. Each namespace is itself constant per session and kind.
- A `prompt_cache_key` override (guardian review sessions) still wins over both.

## Cache-write accounting

`usage.input_tokens_details.cache_write_tokens` is parsed from the Responses stream. It is
never inferred.

`TokenUsage::cache_write_tokens` is `Option<i64>`:

- `None` — the provider did not report the field. Every model before GPT-5.6, and every
  usage record written before this field existed.
- `Some(0)` — the provider reported a genuine zero.

Keep the distinction when analysing runs: "no cache writes" and "cache writes not
measurable" are different findings. `TokenUsage::cache_write()` flattens to a number where
only display or arithmetic matters.

Accumulation stays `None` only while neither side ever reported the field; once one request
does, the running total is a number and later silent requests add nothing.

`input_tokens` remains the provider's **total** input. `cached_input_tokens` and
`cache_write_tokens` are breakdowns *of* it, not additions *to* it — nothing sums them into
input.

The field flows to the rollout `token_count` records, the pruning audit archive
(`~/.elpis/logs/pruning/`), and the `rollout-trace` inference records. It is **not** carried
by the app-server `TokenUsageBreakdown` wire type, so the TUI status card does not show it;
extending that type means regenerating its TypeScript and JSON schema artifacts.

## How pruning interacts with cached prefixes

A pruning pass rewrites the oldest rewritable items, so every prefix past its first
rewritten item diverges. **No breakpoint can prevent that** — removing content from the
middle of a prompt changes every prefix after it. Two things are done about it instead, both
described in `docs/cache-friendly-pruning.md`:

1. **Prune far less often.** Automatic pruning runs as a hysteresis cycle: 30% used → one
   cycle → ~20% used → no further pass until use regrows to 30%. The backlog-sized "steady"
   trigger, which fired independently of how full the window was, is gone.
2. **Raise the floor each pass falls back to.** Each applied pass seals its region with a
   byte-stable epoch marker and a breakpoint is placed on it, so the *next* pass falls back
   to that boundary instead of to the initial prefix.

### The measurement that motivated this

Session `019fe741` (2026-08-09, `gpt-5.6-sol`), before either change:

| | |
|---|---|
| requests | 103 |
| applied pruning passes | 42 |
| overall cached-input rate | 62.8% (4.32M of 6.88M input tokens) |
| requests falling back to the 17,152-token stable prefix | 43 |
| requests with cached input under 30k | 47 |

The `cached = 17,152` plateau appears exactly 43 times — once per pruning event. That number
*is* the stable prefix (instructions + tools + initial context bundle). The region between
that prefix and the divergence point was already large and already stable across passes;
it simply had never been *written* as a cache entry, because implicit caching only writes
near the end of each prompt. The epoch breakpoint is what makes that region an entry.

**Both effects are predictions, not results.** No run has been made against the new
layout. See "What to inspect" below for how to check.

## What to inspect

Per request, from the rollout `token_count` records:

- `input_tokens` — total input billed.
- `cached_input_tokens` — the part that hit. Divide by `input_tokens` for the hit rate.
- `cache_write_tokens` — the part written this request. `null` means unreported, not zero.

Signals worth watching:

- **A repeating low `cached_input_tokens` value** is a prefix invalidation, and its value
  tells you where the surviving boundary is. Correlate the count against
  `elpis.context-prune.v1:` checkpoints in the rollout.
- **The plateau value should now climb over a session.** Each pruning event should fall back
  to the newest epoch boundary, not to a fixed initial prefix. A *constant* plateau across
  many passes means the epoch breakpoint is not being written — check that the frozen prefix
  exceeds 1,024 tokens and that the marker is present in the request body.
- **The number of pruning events should be roughly (peak use − 20%) / 10% per session**, not
  one per turn. Count `"trigger": "pressure"` manifests in `~/.elpis/logs/pruning/passes/`.
- **`cached_input_tokens: 0` on pruning calls** is expected: each pruning batch is unique
  content, so it can never hit. The namespaced key keeps that miss from costing the turn
  loop its slot.
- **A prefix under 1,024 tokens** never caches on GPT-5.6, so a small stable prefix is
  worth nothing whichever mode is on.

## Enabling explicit mode

```toml
[features]
explicit_prompt_cache = true
```

This switches `prompt_cache_options.mode` to `"explicit"` and adds a rolling-tail
breakpoint to replace the automatic one it disables. It affects only GPT-5.6+ requests to
OpenAI, and it is **not** needed to get Elpis's breakpoints — those ship on by default. See
"Why implicit rather than explicit" above; keep it off unless a paired run shows otherwise.

## Provider Prompt-Cache Lifecycle Awareness

In addition to breakpoint placement, Elpis manages provider-specific prompt-cache lifecycles (`codex-model-provider::cache_lifecycle`):

### 1. Anthropic TTL Tracking (5-minute ephemeral window)

Anthropic Claude enforces a 5-minute (300-second) TTL on cached prompt prefixes:
- **`Hot` / `Fresh`:** Elapsed time since last request < 270s (well within TTL).
- **`NearExpiry`:** Elapsed time between 270s and 300s (warning window, 30s remaining).
- **`Cold` / `Expired`:** Elapsed time >= 300s (cache evicted by provider; requires full write).

Subsequent requests within the active TTL window refresh the 5-minute timer from the newest request timestamp.

### 2. Cache-Miss Detection & Metrics

The tracker records per-thread/session and per-provider metrics:
- **Miss Categorization:** Differentiates `ColdStart`, `TtlExpired`, `BelowTokenThreshold` (< 1,024 tokens), and `PrefixInvalidated`.
- **Metrics Tracked:** Total requests, hits, misses, creations, total input tokens, cached tokens, created tokens, `hit_rate()`, and `token_cached_ratio()`.

### 3. Safe Input Queueing

To prevent busting cached prompt prefixes during rapid user interaction or multi-turn bursts:
- **Prefix Preservation:** Enforces append-only invariants on queued inputs, ensuring existing prompt history is not mutated or reordered.
- **Turn Coalescing:** Batches rapid micro-inputs arriving during active tool runs into a single consolidated turn payload to avoid cache thrashing.
- **TTL-Aware Urgency:** Evaluates `should_flush_urgently` when queued messages exist and cache state enters `NearExpiry` (e.g. at 270s+ for Anthropic), dispatching immediately before the 5-minute window expires.


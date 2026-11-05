# Prompt caching

How Elpis uses the OpenAI Responses API prompt cache, where it places breakpoints, and what
it measures.

## Implicit vs explicit

The Responses API caches a *prefix* of the prompt: `instructions`, then `tools`, then `input`
up to a breakpoint. A later request whose prefix is byte-identical up to that breakpoint reads
it from cache instead of paying full input price.

**Implicit** (`prompt_cache_options` omitted, the API default): the server places one
breakpoint on the latest message **and honours any explicit breakpoints the request
carries**. Elpis uses this.

**Explicit** (`prompt_cache_options.mode = "explicit"`): the automatic latest-message
breakpoint is *disabled*; only the request's breakpoints count.

A breakpoint is a `prompt_cache_breakpoint: {"mode": "explicit"}` marker on a content
block; the marker says "explicit" in both modes:

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

Constraints:

- Breakpoints are valid **only** on `input_text`, `input_image` and `input_file` blocks.
  Reasoning items, tool calls and tool outputs, the bulk of an agent transcript, cannot
  carry one.
- A request may create at most **four** new cache writes. In implicit mode the automatic
  breakpoint uses one, leaving three. Reads consider the latest 50 breakpoints, so entries
  from earlier turns can still hit.
- Explicit mode with **zero** breakpoints disables caching for that request, so it is
  strictly worse than implicit.
- GPT-5.6+ caches prefixes of **at least 1,024 tokens**; below that a breakpoint is inert.
- Models before GPT-5.6 **reject** `prompt_cache_options` and `prompt_cache_breakpoint`.

## Elpis's cache boundary

Elpis sends breakpoints only when both hold:

1. the provider is OpenAI, and
2. the model slug parses as `gpt-<major>.<minor>` at or past `5.6` (`gpt-5.6-sol`,
   `gpt-5.6-terra`, `gpt-5.6-luna`, and later families).

Within that gate they are **on by default**. They add to the server's implicit breakpoint
rather than replace it, so they can only add cache reads.

`core/src/prompt_cache.rs` places up to two:

- **Stable prefix**: the last eligible block in the leading run of instruction and
  tool-definition items (`AdditionalTools` and `Message` items: developer instructions,
  AGENTS.md and the opening user turn). The run ends at the first reasoning item, tool call
  or assistant message. Nothing rewrites that run, so every request can fall back to it.
- **Frozen epoch boundary**: the newest context-pruning epoch marker
  (`context_pruner::frozen_prefix_len`). A pruning pass rewrites only what follows it, so
  this entry survives a pass that invalidates everything later. Before the first pass it
  equals the stable prefix and is deduplicated.

The **rolling tail** is not pinned by default: the server writes that breakpoint itself, and
a copy would waste one of the four writes. Elpis adds it only in explicit mode.

With no eligible block, Elpis sends neither breakpoints nor `prompt_cache_options`, leaving
the server on implicit, never explicit-with-no-breakpoints.

The marker is added at serialization (`codex_api::encode_responses_request`), not stored on
`ContentItem`: `ContentItem` is persisted history, and a request-only marker must not reach
rollouts.

On the websocket incremental path, where a request sends only the delta and refers to the
rest via `previous_response_id`, Elpis drops both the options and the breakpoints: their
positions index the full input and address nothing in a delta.

### Why implicit rather than explicit

Explicit mode sits behind `Feature::ExplicitPromptCache` (`explicit_prompt_cache` in config,
**off by default**) and is not recommended. Per the current API documentation, implicit mode
already honours the request's breakpoints, so explicit adds no placement. It only removes
the free latest-message write and makes Elpis spend one of its four writes to replace it.
No serialized request shape here favours explicit. To enable it anyway:

```toml
[features]
explicit_prompt_cache = true
```

This sets `prompt_cache_options.mode` to `"explicit"` and adds a rolling-tail breakpoint in
place of the automatic one. It affects only GPT-5.6+ requests to OpenAI. Keep it off unless
a paired run shows otherwise.

## `prompt_cache_key`

The key routes a request to the machine holding its cache; it invalidates nothing.

- **Turn requests** use the bare session id, fixed for the session's life, so pruning,
  compaction and other history rewrites leave it unchanged. Only the prefix changes, which
  is what the cache should detect.
- **Background requests that reuse the session's client** get their own namespace:
  `<session-id>:context-prune` and `<session-id>:memory`. Their prefix is unrelated to the
  conversation, so sharing the turn's slot could only evict the turn prefix. Each namespace
  is constant per session and kind.
- A `prompt_cache_key` override (guardian review sessions) wins over both.

## Cache-write accounting

`usage.input_tokens_details.cache_write_tokens` is parsed from the Responses stream, never
inferred. `TokenUsage::cache_write_tokens` is `Option<i64>`:

- `None`: the provider did not report the field. This covers every model before GPT-5.6 and
  every usage record written before the field existed.
- `Some(0)`: the provider reported zero.

When analysing runs, "no cache writes" and "cache writes not measurable" are different
findings. `TokenUsage::cache_write()` flattens to a number for display or arithmetic.
Accumulation stays `None` only while no request has reported the field; after one does, the
total is a number and later silent requests add nothing.

`input_tokens` is the provider's **total** input. `cached_input_tokens` and
`cache_write_tokens` are parts *of* it; nothing adds them to input.

The field reaches the rollout `token_count` records, the pruning audit archive
(`$ELPIS_HOME/logs/pruning/`) and the `rollout-trace` inference records. The app-server
`TokenUsageBreakdown` wire type does **not** carry it, so the TUI status card does not show
it; adding it means regenerating that type's TypeScript and JSON schema artifacts.

## How pruning interacts with cached prefixes

The [context reference](context.md#2-context-control-mechanisms-and-native-compaction) covers Smart Prune and `/force-prune`. A retrospective rewrite of admitted output invalidates cached prefixes after the first changed item; no breakpoint prevents that.

### Historical measurement behind the legacy epoch boundary

Session `019fe741` (2026-08-09, `gpt-5.6-sol`), before the epoch breakpoint existed:

| | |
|---|---|
| requests | 103 |
| applied pruning passes | 42 |
| overall cached-input rate | 62.8% (4.32M of 6.88M input tokens) |
| requests falling back to the 17,152-token stable prefix | 43 |
| requests with cached input under 30k | 47 |

The `cached = 17,152` plateau appears exactly 43 times, once per pruning event; it is the
stable prefix (instructions + tools + initial context bundle). The region between that
prefix and the divergence point was already large and stable across passes, but was never
*written* as a cache entry, because implicit caching writes only near the end of each
prompt. The epoch breakpoint makes that region an entry.

Its cache benefit is a prediction, not a measurement: no run has been made against that
legacy layout. "What to inspect" below shows how to check it.

## What to inspect

Per request, from the rollout `token_count` records:

- `input_tokens`: total input billed.
- `cached_input_tokens`: the part that hit; divide by `input_tokens` for the hit rate.
- `cache_write_tokens`: the part written this request; `null` means unreported, not zero.

Signals:

- **A repeating low `cached_input_tokens` value** is a prefix invalidation; its value marks
  the surviving boundary. Correlate the count with `elpis.context-prune.v1:` checkpoints in
  the rollout.
- **The plateau should climb over a session**, each pruning event falling back to the newest
  epoch boundary. A *constant* plateau across many passes means the epoch breakpoint is not
  written: check that the frozen prefix exceeds 1,024 tokens and the marker is in the
  request body.
- **A retrospective manifest with `"trigger": "pressure"`** records the legacy targeted
  selection strategy, not Smart Prune, whose admission audits live under `logs/smart-prune`.
- **`cached_input_tokens: 0` on pruning calls** is expected: each batch is unique, so it
  cannot hit. The namespaced key keeps that miss from costing the turn loop its slot.
- **A prefix under 1,024 tokens** never caches on GPT-5.6, in either mode.

## Provider Prompt-Cache Lifecycle Awareness

Elpis also tracks provider-specific prompt-cache lifecycles (`codex-model-provider::cache_lifecycle`).

### 1. Anthropic TTL Tracking (5-minute ephemeral window)

Anthropic caches prompt prefixes for 5 minutes (300 s), measured from the newest request;
each request within the window restarts it.

- **`Hot` / `Fresh`:** under 270 s since the last request.
- **`NearExpiry`:** 270 to 300 s (30 s left).
- **`Cold` / `Expired`:** 300 s or more; the provider has evicted the cache and the next
  request pays a full write.

### 2. Cache-Miss Detection & Metrics

Per thread/session and per provider, the tracker records:

- **Miss category:** `ColdStart`, `TtlExpired`, `BelowTokenThreshold` (< 1,024 tokens) or
  `PrefixInvalidated`.
- **Metrics:** total requests, hits, misses, creations, total input tokens, cached tokens,
  created tokens, `hit_rate()` and `token_cached_ratio()`.

### 3. Safe Input Queueing

To avoid breaking cached prefixes during rapid input or multi-turn bursts:

- **Prefix preservation:** queued inputs are append-only; existing history is never mutated
  or reordered.
- **Turn coalescing:** rapid small inputs that arrive during tool runs are batched into one
  turn.
- **TTL-aware urgency:** `should_flush_urgently` dispatches queued messages at once when the
  cache enters `NearExpiry` (270 s+ for Anthropic), before the 5-minute window expires.

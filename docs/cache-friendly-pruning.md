# Cache-friendly pruning

Why Elpis's context pruning is organised into **cycles** and **epochs**, and what that buys
the prompt cache. Companion to `docs/context.md` (what pruning does) and
`docs/prompt-caching.md` (how the cache is addressed).

## The old behaviour

Two triggers could start an automatic Ace pass:

- **pressure** — active use reached 30% of the window; reclaim down toward 20%.
- **steady** — completed turns held ≥5% of the window in uncovered tool output. This one
  did not look at how full the window was at all.

Steady is what made passes frequent. In the healthy 20–30% band a working agent produces
several percent of the window in tool output per turn, so steady re-armed almost as fast as
it was satisfied, and the automatic check runs twice per turn (once before the request, once
after sampling). One measured session ran **42 applied passes over 103 requests**, most of
them reclaiming a small increment.

A budget of two passes per *pressure crossing* existed, but steady was never budgeted, so it
was not a bound on total passes.

## Why that cost cache reuse

The Responses API caches a **prefix**. A request reads from cache only up to the first byte
that differs from a previously *written* prefix.

Pruning rewrites the oldest rewritable items — that is the point of it — so every pass
invalidates the prompt from its first rewritten item onward. Ordinary turns only append, so
between passes the prefix is stable and hits; each pass is a cliff.

Two things made the cliff worse than it had to be:

1. **42 cliffs.** Frequency alone dominates.
2. **Nothing had ever been written at the surviving boundary.** Implicit caching writes one
   breakpoint near the end of each prompt. After a pass, all of those sit past the point of
   divergence and are useless, so the request falls back to the newest entry that happens to
   predate the divergence — in the measured session, the 17,152-token initial prefix. It hit
   that plateau 43 times.

Point 2 is the important one: the region *before* the divergence was already large and
already stable. It just was not a cache entry.

## New behaviour: cycles with hysteresis

Automatic pruning now runs as a gated cycle (`PruneCycle` in `core/src/context_pruner.rs`):

```
Armed  --(use >= 30%, pass applied)-->  Open{passes}
Open   --(target reached | budget spent | nothing reclaimable)-->  Cooling
Cooling --(use seen < 30%, then use >= 30%)-->  Armed
```

- **Trigger** stays 30% used, **target** stays ~20% used.
- **Steady is gone.** Backlog size no longer starts a pass. The case it existed for — a
  single tool-driven turn ballooning without ever ending — is already covered by pressure,
  whose eligible region is cut by recency rather than at a turn boundary.
- A cycle may spend up to `MAX_PRESSURE_PRUNE_PASSES_PER_CYCLE` (2) passes **back to back**,
  because one pass is capped at `MAX_PRUNE_BATCH_TOKENS` and on a large window that can be
  less than the 30%→20% distance. Those are one logical cycle finishing its descent, not
  separate cycles.
- `Cooling` blocks every automatic pass. `run_context_prune` returns before it even selects
  a batch, so the 20–30% band cannot produce a pass of any kind.

The resulting shape is `20% → work → 21…29% → 30% → one cycle → 20% → work`.

### The invariant

> After a cycle closes, no automatic pass may run until measured use has been observed
> **below** the 30% trigger and has then climbed back **up to** it.

Both halves are required, and they are mutually exclusive within a single observation, so a
cooling cycle always spans at least two measurements on opposite sides of the boundary.

The "below first" half is not redundant. A cycle can also close *while still in pressure* —
budget spent, or nothing left to reclaim. There `use >= 30%` is trivially true, so a
trigger-only test would re-arm on the very next step and restore the old nibbling. Instead
that case is handed to whatever can actually reclaim (compaction/rollover), exactly as
before.

Guarded by `no_new_cycle_starts_while_use_stays_inside_the_healthy_band`,
`a_cycle_that_stalled_in_pressure_does_not_re_arm_on_the_trigger_alone`, and
`a_cycle_that_closed_below_the_trigger_always_re_arms_again` (a deadlock regression: a cycle
that closes at 24% must still re-arm even though it never returns to 20%).

## New behaviour: epochs

An applied pass now seals its rewritten region with an **epoch marker** — a small
developer-role message, `[elpis.context-prune.epoch N] …`, inserted immediately after the
last covered item. Its text is fixed at write time, so it is byte-stable forever after.

`frozen_prefix_len(input)` returns everything up to and including the newest marker. Two
consumers read it:

- `pressure_eligible_items` and `build_manual_prune_batch` start **after** it. A later pass
  therefore cannot rewrite a sealed epoch *by construction*, rather than incidentally
  because the covered-id filter happened to skip it.
- `plan_prompt_cache` places a cache breakpoint **on** it.

The epoch number is derived by counting markers already in history, so the sequence lives in
history itself and survives resume with no parallel counter to keep in step.

### Why a marker item rather than a boundary index

A breakpoint is only valid on an `input_text` / `input_image` / `input_file` content block.
Tool outputs, tool calls, and reasoning items — the bulk of an agent transcript, and exactly
what sits at a pruning boundary — cannot carry one. Inserting a real message makes the
boundary addressable at all. Its role is `developer` rather than `user` so it does not
shadow the active question that `latest_user_message_text` feeds to the pruning model.

## The prompt-cache boundary

Requests to OpenAI GPT-5.6+ carry up to two explicit breakpoints and stay on **implicit** mode
(one before the first epoch exists):

| position | what it pins | survives |
|---|---|---|
| stable prefix | instructions, tools, opening context bundle | everything |
| frozen epoch boundary | newest epoch marker | the next pruning pass |

Implicit mode is kept because the API honours explicit breakpoints *in addition to* the
automatic latest-message one; `mode: explicit` would replace that free write and buy
nothing. See `docs/prompt-caching.md` for the full decision.

The second breakpoint is the fix for the 17,152-token plateau: the next pass invalidates
everything after the boundary, and the entry written *at* the boundary is what the following
request now falls back to instead of the initial prefix.

## What is unchanged

- 30% trigger, ~20% target.
- Native Codex-style automatic compaction stays disabled in Elpis; the pruning layer is
  still what holds context down, and the hand-off to compaction fires only when a cycle
  stalls in pressure.
- Every applied pass still writes a full audit record (`~/.elpis/logs/pruning/`) and a
  rollout checkpoint. Raw evidence remains intact in the rollout.
- `/prune` is unaffected: it passes an explicit trigger, so it never consults the cycle gate.

## Remaining limitations

- **A pruning pass still invalidates its suffix.** Nothing can prevent that — removing
  content from the middle of a prompt changes every prefix past it. The work here reduces
  how *often* that happens and raises the floor it falls back to; it does not eliminate the
  cliff.
- **The epoch breakpoint only pays off if the frozen prefix exceeds 1,024 tokens**, the
  GPT-5.6 minimum cacheable prefix. Early in a session it will not.
- **Marker accumulation.** One ~40-token message per applied pass, never removed (removing
  one would rewrite the prefix it exists to protect). Negligible under hysteresis; a long
  `/prune` sweep can add up to 12 in one go.
- **The reclaim-per-cycle figure is unmeasured.** Whether two passes are usually enough to
  reach 20% from 30% on a large window, or whether cycles routinely stall and hand off to
  compaction, needs a real run to answer.
- **Cache-write behaviour is unmeasured.** `cache_write_tokens` telemetry exists but no run
  has been made against the new breakpoint layout, so the actual hit-rate and write-cost
  change is a prediction, not a result.

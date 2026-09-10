# Cost-Efficiency Protocol for Fresh-Output Pruning

Drafted 8 September 2026; executed 8 to 9 September, results in
[COST_EFFICIENCY_RESULTS.md](COST_EFFICIENCY_RESULTS.md). Owner and acceptance
authority: Masih. This protocol
supersedes nothing; it adds the cost and horizon experiments that
`BOUNDED_SYNTHETIC_EVALUATION.md` explicitly left open.

## Why the 8 September cost result is not evidence against the method

The four-case cohort reported pruning as 122% more expensive at published Luna
rates. Two properties of that study, both visible in its sealed evidence, make it
uninformative about cost:

1. **Minimum horizon.** Each native conversation makes three requests: the read,
   one continuation tool call, and the answer. The pruned output is re-sent in
   exactly two requests. Per-request usage from the sealed rollout
   (`replica_quorum`, `REMAINING-COVERAGE-LUNA-20260908-01`):

   | Request | OFF input (cached) | ON input (cached) |
   | --- | ---: | ---: |
   | 1 read | 10,482 (0) | 10,482 (0) |
   | 2 continuation | 17,678 (8,960) | 11,003 (0) |
   | 3 answer | 17,790 (17,152) | 11,298 (9,984) |

   Pruning saves about 6,700 input tokens per request after the output lands.
   Two requests cannot amortize any fixed optimizer cost.

2. **Max-effort optimizer.** The candidate hard-codes `ReasoningEffort::Max`.
   Across the four admissions the optimizer emitted 22,388 output tokens, of
   which 21,131 were reasoning, at $1.20 per million. That single category cost
   $0.0254, more than the entire $0.0245 net loss. Masih asked on 6 September for Low or
   Medium; the coverage study still ran at Max. Sealed receipts from the
   30-run robustness batch (`ROBUSTNESS-LUNA-30-20260906-01`) record, for
   admitted attempts on comparable inputs:

   | Effort | Reasoning tokens | Output tokens | Latency |
   | --- | ---: | ---: | ---: |
   | Low (4 admissions) | 71 to 394 | 1,221 to 2,375 | 23 to 44 s |
   | Max (11 admissions) | 1,034 to 8,920 | 2,924 to 10,469 | 54 to 189 s |

   Those Low receipts come from an earlier optimizer policy and are not a
   retention result for the current policy. They bound the cost lever.

The 8 September result therefore measured a configuration the owner had already
rejected, at the one horizon where amortization is impossible. It remains in the
record as what it is.

## Research question

For a session that continues for T requests after a large tool output of S
tokens, does fresh-output pruning reduce total provider cost (main model plus
optimizer) relative to no pruning, and at what horizon T* does it break even?
Secondary: does the answer hold while the admitted summary still passes the
existing closed-book retention gate, and how does the optimizer's reasoning
effort move T*?

## Cost model

Let S be the raw output tokens, A the admitted tokens, I the optimizer
instruction and question tokens, R the optimizer reasoning tokens, and p_in,
p_cached, p_out the published per-token prices. Both arms send S uncached once:
OFF to the main model, ON to the optimizer. The optimizer's additional cost is

    C_opt = I * p_in + (R + A) * p_out

Each later request re-sends the output inside the prefix. With cache-hit
fraction h on that span, the saving per request is

    D = (S - A) * (h * p_cached + (1 - h) * p_in)

and the break-even horizon is T* = C_opt / D. Using the sealed numbers above
(S - A about 6,700; I about 1,100; A about 300):

| Effort | R (per admission) | C_opt | T* at h = 1 | T* at h = 0.5 | T* at h = 0 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Max (measured) | 5,283 | $0.0069 | 51 | 9.4 | 5.1 |
| Low (projected from robustness receipts) | 200 | $0.0008 | 6.0 | 1.1 | 0.6 |

These are projections from existing receipts, not results. The experiments
below measure C_opt, h, and T* directly. Observed h on the re-sent span in the
sealed cohort was 0.51 to 0.96, never 1.

## Experiments

All experiments use one frozen release build of the measured candidate with one
change: the optimizer effort becomes the config key `smart_prune_reasoning_effort`
(default unchanged, Max). Arms differ only by `-c` overrides recorded in
`launch.json`. Model `gpt-5.6-luna`, main effort medium, ChatGPT authentication,
1,200 s conversation guard, no retries, one lane, sealed checkpoints, existing
graders and oracles unchanged.

### E1. Optimizer effort ablation

- Cases: the eight fact cases (`lease_fencing`, `schema_defaults`,
  `archive_paths`, `event_dedupe`, `replica_quorum`, `export_order`,
  `quota_rollover`, `key_rotation`).
- Arms per case: OFF, NATIVE, ADMITTED. RAW and DAMAGED are fixture validity
  controls already sealed for these fixtures and are not repeated.
- Batches: one per effort, Low first, then Medium, then Max. OFF is repeated in
  each batch so pairing is within batch and same day.
- Measures: native answer grade, ADMITTED 6/6 including withheld facts, strict
  prefix verdict, optimizer input/output/reasoning tokens, latency, per-request
  main usage.
- Stop rule: a failed gate stops that batch. A retention failure at an effort
  level disqualifies that level from E2 and E3.

### E2. Horizon sweep

- Native prompt adds N sequential short tool calls (`printf STEP_k`) after the
  read and before the answer, one per turn, no parallel calls. Horizon is
  measured from the rollout as the number of requests after the read, not
  assumed from N.
- N in {8, 32}; arms OFF and NATIVE at the cheapest effort that passed E1.
- Eight cases, both arms, both N: 32 conversations.
- Measures: per-request input, cached input, output; cumulative cost curve;
  fitted per-request saving D and observed h; T* per case.
- Gate: native answers correct, tool-call count equals N + 2, requests at
  least N / 2 + 2.

### E3. Multi-output session

- One conversation reads the eight evidence files, one call each, then runs
  eight `printf STEP_k` calls, then answers the four native questions of the
  first file read.
- Four orderings (first file rotates), arms OFF and NATIVE: eight
  conversations.
- Measures: peak request input, total main and optimizer usage, cost, native
  grade for the oldest output, admissions and prefix verdicts.

### E4. Product iteration from results

After E1 to E3, with Masih's acceptance: set the default optimizer effort to the
cheapest level that passed retention; set the prune threshold near the measured
break-even output size; re-run E1 on the four untouched cases as a regression.

Status 9 September: the candidate source now defaults to Low (None also passed
retention and is cheaper; the choice between them is Masih's). No rebuild,
install, or threshold change yet. Measured break-even at None with a warm cache
is 7 to 15 later requests for 7,000-token outputs; per-request saving scales
with output size, so outputs near the current 1,024-token minimum would need
roughly 50 to 100 later requests to pay back in dollars.

## Sample and inference

Eight fixtures give eight paired differences per condition. Report per-case
signed savings, sign counts, median and range, and an exact sign test on the
eight pairs (all eight in one direction gives p = 0.0078 two-sided). No pooled
confidence interval is claimed; cases are constructed, not sampled.

## Claims this can support

- Measured C_opt at each effort and its effect on T*, for this model and
  workload.
- Whether pruning saves total cost at horizons 8 and 32 and in an eight-output
  session, with the cache-hit fraction observed.
- Whether the retention gate survives the cheaper effort.

## Claims this cannot support

- General cost savings on real repositories or other models.
- Provider cache-hit guarantees; h is observed, not controlled.
- Task-quality improvement.

## Reproduction

Harness: `.worktrees/parallel-runner-offline/tools/parallel-pilot` (`staged-study.mjs`,
`cost-fixtures.mjs`, `cost-metrics.mjs`). Profiles: `effort-ablation:<effort>`,
`horizon:<steps>:<effort>`, `multi-output:<count>:<effort>`, with effort in
low, medium, high, max. Each batch seals its plan, oracle fixtures, harness
copies, and binary provenance before the first call.

```sh
node staged-study.mjs BATCH_DIR FROZEN_BINARY AUTH_JSON effort-ablation:low
node staged-study.mjs --audit BATCH_DIR
node cost-metrics.mjs --rates ../../../../docs/evals/rq3/LUNA_PUBLISHED_RATES_2026-09-08.json BATCH_DIR...
```

Real-repository coding fixtures (B1 to D5 in `PRUNING_ABLATION_DRAFT.md`) remain
a separate, unstarted study; nothing here substitutes for them.

## Evidence to keep

Sealed plan, per-conversation `launch.json`, `result.json`, rollouts, traces,
optimizer receipts, binary provenance, and the analysis output with calculator
hash. Rates: `LUNA_PUBLISHED_RATES_2026-09-08.json`.

# Smart Prune live pilot — 2026-09-01

Session: `01a05be9-cda6-7f21-9681-6b387bb0f151`

This was a normal-work Smart Prune ON observation, not a matched OFF/ON cost study.
It observed provider cache reuse around two admissions and exposed an unacceptable
same-turn optimizer retry storm.

## Verdicts

| Claim | Verdict | Evidence boundary |
| --- | --- | --- |
| Admission occurs before first main-model exposure | `PROVED_MECHANISM` | Two live admissions linked to their first main request and response; the mock-provider admission suite also passed. |
| Tested main-request prefix and cache key remain stable | `PROVED_TESTED_PATH` | The encoded mock-provider suite passed. No private live trace was captured. |
| Provider reused cache after live admissions | `OBSERVED_REUSE` | The two linked first-exposure responses reported 98.96% and 98.89% cached input. |
| Full live logical history stayed prefix-stable | `UNKNOWN` | `CODEX_ROLLOUT_TRACE_ROOT` was not set, so the reduced full-request trace required by Test 3 does not exist. |
| Smart Prune reduced provider cost versus OFF | `NOT_TESTED` | There was no matched OFF arm. |
| Original pilot was operationally healthy | `NO` | 18 of 20 optimizer attempts failed and recorded 860.732 seconds of cumulative optimizer latency. |

## Evidence

Rollout:

`~/.elpis/sessions/2026/09/01/rollout-2026-09-01T11-10-44-01a05be9-cda6-7f21-9681-6b387bb0f151.jsonl`

Admission manifests:

- `~/.elpis/logs/smart-prune/admissions/01a05bf3-3d59-7a53-a4bd-e7634f77c7c9/manifest.json`
- `~/.elpis/logs/smart-prune/admissions/01a05bf3-c359-7351-8d52-8226cc5131e1/manifest.json`

The 68 main-model responses exactly match the terminal aggregate:

| Input | Cached input | Cache hit | Cache writes | Output | Reasoning | Total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,986,458 | 2,862,592 | 95.8524% | 0 | 42,342 | 32,692 | 3,028,800 |

`cache writes = 0` is a separate provider field and does not contradict the nonzero
cached-input reads. One context compaction occurred after main response 43 and is a
confounder for later cache-rate movement.

The two live admissions were:

| Admission | First main request | Source | Admitted | Saved | Linked response input | Linked cached input | Cache hit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `01a05bf3-3d59-7a53-a4bd-e7634f77c7c9` | 33 | 1,385 | 472 | 913 | 64,933 | 64,256 | 98.96% |
| `01a05bf3-c359-7351-8d52-8226cc5131e1` | 35 | 1,385 | 534 | 851 | 65,886 | 65,152 | 98.89% |

Together they reduced 2,770 approximate source tokens to 1,006, saving 1,764
(63.68%) in those admitted outputs only. This is not a provider-cost estimate.

The Smart Prune snapshot that feeds the Context Ledger and dashboard recorded:

- 23 examined, 2 admitted, 21 unchanged, and 18 failed batches;
- 20 optimizer requests and 860,732 ms cumulative optimizer latency;
- 2 optimizer usage reports totaling 7,471 tokens; usage for the 18 failed calls is
  unknown;
- zero retrospective automatic-prune events, keeping Smart Prune evidence separate
  from late `/prune` accounting.

No dashboard JSON, screenshot, or Ledger render was preserved during the observation, so
the rendered live UI is not claimed as verified. The aggregate snapshot and private,
persisted admission/linkage files are the durable evidence available for this session.

## Runtime defect and fix

All 20 optimizer attempts belonged to user turn
`01a05bea-37e8-7192-a8ce-e414d33ca318`. Attempt 1 failed after 45,000 ms. The old code
then retried on every later eligible batch in the same turn.

The telemetry labels attempt 1 only as a failure, not explicitly as a timeout. Treating
it as a non-cancellation failure is an inference supported by the exact 45-second
duration, the absence of a cancellation/interrupt event, and normal task continuation.

The candidate fix records the failed turn ID and passes later eligible outputs through
unchanged for that turn. A new user turn may try Smart Prune again. It changes neither
history admission nor cache-key construction.

Counterfactual calculation from this recorded turn, clearly not a new provider
measurement or task replay:

- 19 later optimizer attempts would have been skipped;
- 815,732 ms (13m35.732s) of recorded optimizer latency would have been avoided;
- 17 later failures and both late successful admissions would have been skipped;
- the only 7,471 reported optimizer tokens and all 1,764 approximate admitted-output
  savings would both have been forgone;
- the original outputs would still have reached the main model unchanged.

No counterfactual task result was run or verifier-tested.

The timeout regression was independently reviewed before execution. It first failed on
the old behavior because request 4 was another Smart Prune request, then passed after the
fix because request 4 went directly to the main model. The test also proves exact
fail-open output preservation and one attempted/failed batch in the turn. A second test
proves normal retry on the next user turn. The full focused result is 13 Smart Prune
integration tests and 6 Smart Prune core unit tests passing.

The original task result itself was only partial: direct runtime skill exposure was not
proved, and the final answer incorrectly claimed no Elpis process was active. Task
quality is therefore not accepted from this pilot.

## Remaining validation

A later normal session can confirm the installed fix limits failures to one optimizer
attempt per user turn. A causal cost claim still requires the matched OFF/ON study in the
protocol; this pilot must not be reused as that control.

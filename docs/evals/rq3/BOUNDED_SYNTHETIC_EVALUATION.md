# Bounded Synthetic Evaluation of Fresh-Output Pruning

Draft for the paper, 8 September 2026. This evaluates a pinned candidate, not an
unidentified public release. No additional experiments were run for this write-up.

## Research Question

Can Elpis shorten newly produced tool output without rewriting the previously
submitted conversation prefix, while retaining predefined facts and citations
needed both immediately and by later questions?

We evaluate three distinct properties: actual admission of a shorter output;
preservation of the existing prefix by the pruning operation; and recoverability
of task-relevant facts from the admitted representation. We also report separately
measured native ON/OFF usage, including optimizer overhead. Monetary estimates
require evidenced billing rates.

## Cache-Preservation Argument

Headroom describes a fresh-content-only design: compression operates on new
content while the frozen historical prefix remains unchanged. Its cache-aware
component does not rewrite prompts. This is the relevant architectural comparison,
not merely reserving unused context-window capacity. [Headroom implementation
overview](https://github.com/headroomlabs-ai/headroom)

Elpis's measured candidate follows that boundary. Tool results are collected in
`drain_in_flight`, passed through `optimize_pending_outputs`, and only then recorded
in conversation history. The optimizer substitutes entries in the pending-output
vector; it does not replace historical conversation entries. An admission requires
a written audit containing the source and admitted output. Failures retain the
original pending output. See the candidate's
[admission call site](../../../.worktrees/ace-fact-preservation/codex-rs/core/src/session/turn.rs#L1780)
and [optimizer](../../../.worktrees/ace-fact-preservation/codex-rs/core/src/session/smart_prune.rs#L206).
These working-tree links aid inspection; the frozen artifacts below identify the
measured implementation.

Let H be the already submitted history and O a new, unsubmitted tool result.
The operation constructs H followed by C(O), rather than transforming H. Thus,
for this operation, H_after = H_before. With unchanged request configuration and
serialization, an existing cache entry for that prefix is not invalidated by
pruning: all changed content occurs after the prefix. This is a design-level
non-mutation guarantee, not a statistical hypothesis requiring many repetitions.
It applies to fresh-output Smart Prune, not to manual history rewriting, older
pressure-pruning behavior, or compaction.

Live traces check the operational boundary: stable normalized request options and
cache key, a valid previous-response chain, exactly one new tool-output delta at
each continuation, the exact admitted output, and a subsequent linked request.
Every actual admission in the four candidate cohorts below passed this check
(11 admissions, including development and repeated cases). The trace verdict is
`PASS_OBSERVED_CONTINUATION_LINKAGE`.

These two forms of evidence should not be conflated. Source inspection establishes
that the pruning operation leaves history unchanged; the normalized traces
corroborate continuation without a historical rewrite. The trace recorder does
not independently capture full encoded wire-prefix bytes. Neither result promises
that a provider retains an entry or serves a hit on every request. Provider cache
configuration, retention, and execution remain separate from pruning-induced
invalidation. OpenAI's documentation likewise distinguishes stable prefixes from
actual cache entries and describes appending tool results without rewriting earlier
context. [OpenAI prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching)

## Experimental Method

Each synthetic diagnostic artifact contains six annotated requirements distributed
through a longer source with repetitive content. Coverage includes fencing and
lease expiry, absent versus explicit defaults, path and symlink rejection,
tenant-scoped deduplication, replica voting, ordered exports and exact identifiers,
quota exceptions, and key rotation. For example, the replica-voting case requires
three voting acknowledgments out of five replicas; two are insufficient. These
are diagnostic reasoning tasks, not implementations of those systems.

For each completed case we ran five conversations:

1. **Native OFF:** answer four questions with pruning disabled after reading the
   full diagnostic source.
2. **Native ON:** the same task with pruning enabled. A separate continuation
   marker makes a post-admission request observable. Admission receipts and traces,
   rather than the final answer alone, establish that pruning actually occurred.
3. **RAW:** a fresh, no-tool conversation answers all six questions from the raw
   source.
4. **ADMITTED:** an equivalent fresh, no-tool conversation answers all six questions
   using only the exact admitted summary.
5. **DAMAGED:** a negative control removes one required fact. The answer must report
   UNKNOWN without a citation for that requirement, retain the other five answers,
   and fail the ordinary full-source grade.

Two of the six questions are withheld from the native task, testing whether
information not requested at pruning time remains available later. The RAW arm
checks whether the task is answerable before compression; the ADMITTED arm prevents
success through rereading the original. Answers are machine-graded for exact values
and annotated supporting citations, not by another model's subjective rating.
These controls test the six designated requirements, not exhaustive preservation
of every source fact.

Arm order alternates across cases to reduce simple order confounding. Every
conversation is checked before the next launch; a failed checkpoint stops its
stage. There are no automatic retries. Completed checkpoints are retained across
resume. Although the harness originated as a parallel runner, these gated stages
used one lane; they are not parallel-throughput measurements.

All four candidate cohorts use main model `gpt-5.6-luna` at medium effort and Luna
at Max effort for the optimizer. ACE has a 180-second connection/inactivity
allowance renewed by activity, not a 180-second total deadline; the outer
conversation guard is 1,200 seconds. The tested executable SHA-256 is
`21cbb5e2cf325fb0e47a5c054a48fc337b74637074a7d28993c6f7b8950ef8b5`;
the optimizer-instruction SHA-256 is
`ddd4d0909c81bb979c8346686524af8c15e9c8914a77e974964853f171719b61`.
No model, effort, runtime, account, or timeout change occurred within these runs.

## Results

Development cases and fresh coverage are reported separately. Fact counts below
require both the correct value and accepted supporting citations. RAW and ADMITTED
achieved the same counts in every completed set of probes.

| Cohort | Conversations | Completed cases | ADMITTED requirements | Withheld requirements | Missing-fact controls | Prefix checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development canary | 10 | 2 | 12/12 | 4/4 | 2/2 | 2/2 |
| Fresh coverage, original citation annotations | 16 | 3; fourth stopped | 18/18 | 6/6 | 3/3 | 4/4 |
| Citation development rerun, reused case | 5 | 1 | 6/6 | 2/2 | 1/1 | 1/1 |
| Untouched coverage, corrected annotations | 20 | 4 | 24/24 | 8/8 | 4/4 | 4/4 |

The fourth case in the original-annotation cohort stopped after native ON, before
RAW/ADMITTED probes; its prefix check passed but it supplies no closed-book
retention result in that cohort. Its later development rerun does not replace the
original stopped result or count as another fresh case.

The four untouched cases completed all 20 checkpoints without retry. Native OFF
and ON each returned 16/16 correct values and citation sets. RAW and ADMITTED each
returned 24/24, including eight withheld requirements. All four missing-fact
controls detected the deliberately absent requirement.

| Untouched case | Estimated raw output tokens | Estimated admitted tokens | ACE latency (seconds) |
| --- | ---: | ---: | ---: |
| Replica voting (`replica_quorum`) | 6,618 | 288 | 181.348 |
| Ordered export (`export_order`) | 7,003 | 299 | 75.870 |
| Quota rollover (`quota_rollover`) | 6,742 | 306 | 106.857 |
| Key rotation (`key_rotation`) | 7,423 | 378 | 226.158 |
| Total | 27,786 | 1,271 | Not an end-to-end latency aggregate |

These are harness-estimated representation sizes, distinct from the recorded
inference usage below. All four admissions completed without an ACE error;
activity-aware waiting permits the two durations above 180 seconds.

## Paired Token Usage and Cost

We extracted recorded usage from each native OFF/ON conversation and every
optimizer attempt. Main usage is the final cumulative rollout token counter,
checked against the sealed result; optimizer usage is independently checked against
the attempt receipts. Result and evidence hashes are verified before extraction.
Total tokens are input plus output: cached input is already part of input, and
reasoning output is already part of output. Neither is added twice. RAW, ADMITTED,
and DAMAGED probe calls are evaluation overhead, not calls in the native workflow,
and are excluded from this paired deployment-usage comparison. All observed
optimizer attempts in these matched pairs were admitted and had recorded usage.

Positive savings below mean OFF minus ON; negative values mean increased usage.
All four latest native pairs completed and passed their native answer checks.

| Case | OFF total | ON main | ON optimizer | ON combined | Tokens saved | Saved (%) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Replica voting | 46,407 | 33,360 | 14,206 | 47,566 | -1,159 | -2.50 |
| Ordered export | 46,375 | 32,954 | 12,240 | 45,194 | 1,181 | 2.55 |
| Quota rollover | 46,186 | 32,999 | 11,740 | 44,739 | 1,447 | 3.13 |
| Key rotation | 47,266 | 33,186 | 17,281 | 50,467 | -3,201 | -6.77 |
| Total | 186,234 | 132,499 | 55,467 | 187,966 | -1,732 | -0.93 |

Main-model token usage decreased by 28.85%, but optimizer overhead more than offset
that decrease in this four-case aggregate. Two cases saved total tokens and two
used more. Thus these runs demonstrate smaller admitted context and reduced main
usage, but not aggregate total-token savings for this cohort. The native task has
only a short post-pruning continuation, so this measures that horizon rather than
amortization over a long session. We do not extrapolate a long-session saving.

The other candidate cohorts remain separate:

| Cohort | Complete native pairs | OFF total | ON combined | Tokens saved | Saved (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development canary | 2 | 92,845 | 93,882 | -1,037 | -1.12 |
| Original-annotation fresh coverage | 3 | 139,492 | 136,412 | 3,080 | 2.21 |
| Citation development rerun | 1 | 48,020 | 44,736 | 3,284 | 6.84 |
| Corrected-annotation untouched coverage | 4 | 186,234 | 187,966 | -1,732 | -0.93 |

The stopped original `event_dedupe` native ON conversation has no OFF counterpart
and is explicitly recorded as unpaired, not included in a fabricated paired total.
The later development pair does not fill that gap. These are descriptive
within-cohort sums, not pooled statistical estimates.

### Cache Usage and Billing Inputs

The following are recorded token categories for the latest four pairs:

| Usage category | OFF main | ON main | ON optimizer | ON combined |
| --- | ---: | ---: | ---: | ---: |
| Input tokens | 184,620 | 130,675 | 33,079 | 163,754 |
| Cached input tokens (included above) | 104,448 | 95,744 | 0 | 95,744 |
| Cache-write tokens (included above) | 0 | 0 | 0 | 0 |
| Output tokens | 1,614 | 1,824 | 22,388 | 24,212 |
| Reasoning output (included above) | 537 | 730 | 21,131 | 21,861 |

The main-model cached-input fraction was 56.57% OFF and 73.27% ON. These are
token-weighted observed fractions, not request hit rates or an isolated causal
cache experiment. Cache warmth and sharing are not controlled between arms.
These observations supplement, rather than replace, the prefix non-mutation
argument and strict continuation checks.

The archived launches use ChatGPT authentication and contain usage counters but
no invoice attribution. We therefore estimate costs using published Luna prices,
checked on 8 September 2026: $0.20 input, $0.02 cached input, and $1.20 output per
million tokens. Both the model page and the Enterprise token-based ChatGPT rate
card list these rates. These are published-rate estimates, not verified charges
to this account. [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[ChatGPT rate card](https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing).
The calculator uses:

```text
ordinary_input = input - cached_input - cache_write
cost = (ordinary_input * input_rate + cached_input * cached_rate
        + cache_write * write_rate + output * output_rate) / 1,000,000
ON cost = main cost + all optimizer-attempt costs
savings = OFF cost - ON cost
```

Main and optimizer prices may differ. If they have identical rates, the latest
cohort's cost saving is exactly
`(12,162 * input_rate + 8,704 * cached_rate - 22,598 * output_rate) / 1,000,000`.
Applying those prices gives the following USD estimates, including optimizer usage:

| Latest case | OFF cost | ON combined cost | Cost saved (OFF minus ON) |
| --- | ---: | ---: | ---: |
| Replica voting | $0.00503824 | $0.01437808 | -$0.00933984 |
| Ordered export | $0.00492084 | $0.00842708 | -$0.00350624 |
| Quota rollover | $0.00492704 | $0.00782376 | -$0.00289672 |
| Key rotation | $0.00517404 | $0.01394236 | -$0.00876832 |
| Total | $0.02006016 | $0.04457128 | -$0.02451112 |

At these rates the latest four-case aggregate costs **122.19% more** with pruning.
(Addendum, 9 September 2026: this figure is specific to the Max-effort optimizer
and to a task with only two requests after the output. On the same fixtures with
the same binary, Low and None effort retain the same facts at a fraction of the
cost, and pruning becomes cheaper than no pruning at longer horizons; see
[COST_EFFICIENCY_RESULTS.md](COST_EFFICIENCY_RESULTS.md).)
Although two cases save total tokens, none saves estimated money: input savings
do not offset the optimizer's output-token cost at the published prices.

| Other cohort | OFF cost | ON combined cost | Cost saved |
| --- | ---: | ---: | ---: |
| Development canary | $0.00797024 | $0.02352192 | -$0.01555168 |
| Three original-annotation fresh pairs | $0.01154300 | $0.02753372 | -$0.01599072 |
| Citation development rerun | $0.00659408 | $0.00699248 | -$0.00039840 |

These cohorts remain separate. No matched cohort demonstrates cost savings at
these rates. This result does not negate prefix preservation or tested retention;
it means the measured short workflows do not establish the cost-saving claim.
Fixed subscription expenditure is not a per-token charge, and actual account
charges would require invoice evidence. That distinction no longer blocks the
published-rate analysis.

Machine-readable per-case/cohort calculations, including unpaired cases and priced
cost fields, are in [PRUNING_USAGE_METRICS.json](PRUNING_USAGE_METRICS.json).
The [calculator](../../../.worktrees/parallel-runner-offline/tools/parallel-pilot/pruning-metrics.mjs)
accepts archive paths and optional `--rates PRICES_JSON`. A rates file must identify
its currency and provenance and provide separate `main` and `optimizer` rate
objects with `input`, `cached`, `write`, and `output` prices per million tokens.
Rates produce estimates, not invoice verification. The dated rate inputs and
sources are in [LUNA_PUBLISHED_RATES_2026-09-08.json](LUNA_PUBLISHED_RATES_2026-09-08.json).
Cache-write pricing is left unspecified because every recorded count is zero;
the calculator rejects nonzero cache-write usage without an applicable rate.

The seven focused calculator checks pass. They cover overhead, reasoning accounting,
cost buckets, missing usage, mismatched pairs, incomplete pairs, and signed savings.
A deliberate mutation omitting optimizer overhead failed five of the original six checks;
the archived experiments themselves were not modified. This analysis adds no model
calls and does not change the experiment protocol or frozen grading decisions.

## Failures and Development Decisions

An earlier policy genuinely omitted required information in the `rollforward`
canary: RAW recovered 6/6 requirements, while ADMITTED recovered only 4/6. The
missing requirements were a 36-hour retention rule and an exact audit destination.
They were not requested by the native task. The revised policy explicitly requires
all distinct facts, including currently unasked facts, to survive compression.
The candidate passes this regression, which is development evidence rather than
an independent held-out success. A single before/after comparison does not isolate
the prompt wording from stochastic model behavior.

The original fresh-coverage stage stopped at `event_dedupe` because the answer
included a valid supporting citation absent from the frozen allowlist. All four
native values were correct; only three of four citation sets passed the original
grader. Both supporting facts remained in the admitted summary. The old failed
grade is preserved. An offline regression using that exact answer demonstrates
the annotation correction; a separately frozen five-conversation live rerun passes
but is reported as development. Four previously unrun cases then use the corrected,
frozen annotations. This was a grading defect, not observed fact loss.

Earlier HTTP 404 failures before inference and earlier timeout-limited studies
remain separate from these candidate results. Their causes or incomplete runs are
not recoded as successes, and they are not pooled into a retention accuracy score.

## Scope and Threats to Validity

Seven fresh cases completed across two annotation versions, yielding descriptive
strata of 18/18 and 24/24 requirements. The 42 questions are correlated within
cases, and the 51 conversations include controls and development reruns. Neither
is an independent sample size. Cases are deliberately constructed, not randomly
sampled from a defined coding-task population. We therefore report counts, not a
pooled p-value, confidence interval, or non-inferiority claim.

Known question types, repetitive source structure, one model configuration, and
adaptation during development limit generalization. The original stop and protocol
amendment further preclude treating completed cases as a single untouched study.
Missing-fact controls show that the selected probes can detect designated omissions;
they do not establish sensitivity to every harmful omission. No experiment here
measures real-repository implementation quality or worker-graph correctness.

The defensible conclusion is that the tested fresh-output pruning design preserves
the existing conversation prefix, and its admitted summaries retained all designated
facts and citations in the completed closed-book probes, including facts needed
only by later questions. This is bounded evidence of useful compression and tested
fact recoverability, not universal losslessness. A guarantee against pruning-induced
prefix mutation is supported; a guarantee of provider cache-hit availability is
neither measured nor required for that claim.

## Evidence and Reproduction

All four core checksum manifests were revalidated for this write-up. Reports,
fixtures, frozen harness, traces, admission audits, and binary provenance remain in
the local archives below. Use each archive's own harness and oracle, not today's
development code:

```sh
node ARCHIVE_ROOT/harness/staged-study.mjs --audit ARCHIVE_ROOT
```

| Archive | Core files | Report |
| --- | ---: | --- |
| FACT-PRESERVATION-CANARY-LUNA-20260908-01 | 251 | [Development canary](../final-data/FACT-PRESERVATION-CANARY-LUNA-20260908-01/report.json) |
| FACT-PRESERVATION-COVERAGE-LUNA-20260908-01 | 413 | [Original coverage, stopped](../final-data/FACT-PRESERVATION-COVERAGE-LUNA-20260908-01/report.json) |
| CITATION-ORACLE-REGRESSION-LUNA-20260908-01 | 136 | [Development rerun](../final-data/CITATION-ORACLE-REGRESSION-LUNA-20260908-01/report.json) |
| REMAINING-COVERAGE-LUNA-20260908-01 | 490 | [Untouched coverage](../final-data/REMAINING-COVERAGE-LUNA-20260908-01/report.json) |

The latest stage's independent frozen audit reproduced its report; resume retained
20 launches before and after, with no new calls. The development harness passed
85 offline checks, including negative regressions. These checks validate the
harness, not 85 additional model experiments. Archives are private local evidence;
a sanitized public reproducibility package has not been prepared or published.

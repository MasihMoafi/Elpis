# Evaluation status

Last revised 2026-10-25; measurements retain their original dates. Every figure here comes from a recorded run. Where a question is
open it says so, and nothing on this page is stated more strongly than the evidence carries.

Raw records: [`final-rq1-rq4-data`](https://github.com/MasihMoafi/Elpis) ·
derived analysis with per-metric provenance and cross-checks:
`rq1_rq4_analysis_bundle/` · pruning audit archive: `~/.elpis/logs/pruning/`.

| | Question | Status |
|---|---|---|
| RQ1 | Context efficiency | **Measured on three repetitions of one workload** |
| RQ2 | Information retention | **Tested targets retained; fresh summary-only probes recovered 24/24 requirements and citations** |
| RQ3 | Task performance | **Future work**; exploratory Terminal-Bench runs did not establish a clear directional difference |
| RQ4 | Overhead and cache | **Cache-preserving method and Claude Code integration**; cost measurements on the September candidate depend on optimizer effort and horizon |
| RQ5 | Auditability | **Seven of nine inspected reconstruction properties fully available, two partial** |

These evaluations cover different revisions. RQ1, the August RQ2 audit, and RQ5
describe the older Ace history-pruning implementation. The September summary-only
study and RQ4 evaluate fresh-output Smart Prune. The current Claude Code integration
is supported by implementation inspection, separately from those historical runs.

---

## RQ1 — Context efficiency

Three paired runs. One byte-identical prompt (SHA-256 verified), same model
(`gpt-5.6-luna`), same 258,400-token window, same source commit (`646c94a`) on both arms.

| Run | Codex peak | Elpis peak | Reduction |
|---|---:|---:|---:|
| 1 | 243,012 | 83,885 | **65.5%** |
| 2 | 242,057 | 127,873 | **47.2%** |
| 3 | 238,141 | 123,900 | **48.0%** |

Median context per request fell 41.6% / 51.6% / 45.5%. The direction held in all three
runs.

**Scope.** Three repetitions of *one* task, not three tasks. The recorded reduction
occurred in each repetition. Four runtime controls were not matched between arms
(`history_mode`, `cli_version`, `approval_policy`, `sandbox_policy`); they are recorded in
the historical `comparability.csv`. Each peak is an observed within-arm measurement;
the unmatched controls limit causal attribution of differences between arms.

## RQ2 — Information retention

**Important information remained answerable from admitted tool-output summaries.**
In the September [fresh-output study](rq3/BOUNDED_SYNTHETIC_EVALUATION.md#results),
four untouched synthetic cases completed 20 conversations across five conditions.
Fresh no-tool conversations received only the exact admitted summary and recovered
**24/24 designated requirements with correct values and supporting citations**,
matching the raw-source condition. Eight questions were withheld from the task shown
at pruning time. Four damaged-summary controls correctly identified a missing fact.

Estimated tool-output representation size fell from 27,786 to 1,271 tokens
(95.4%). This measures the supplied representation, separately from total model
usage, pruning overhead, or cost. The 24 requirements are grouped within four
cases, not 24 independent software tasks. The [offline verification receipt](../reviews/evidence-20261025/preservation-verification.json)
records the matching frozen audit and 490 validated core checksums.

An earlier [independent forensic audit](rq2/INDEPENDENT_AUDIT.md) reconstructed controlled session
`019ff1b2-be61-7ea3-b835-652379b13f91` from its raw rollout after 11 automatic Ace pruning
passes. All six planted task-relevant targets were explicitly present in the post-prune
model context (`replacement_history`, record 298): four requirements from the user prompt
and two exact values from the initial tool output.

This establishes **6/6 post-prune context retention for those historical targets**.
They remained intact in primary history; this older run does not show answering from
a replacement summary. Its original rollout was not available for the October recheck.
The two studies therefore provide separate retention results, not a pooled success rate.

## RQ4 — Overhead and cache

**Fresh-output pruning preserves the existing cache prefix.** Smart Prune shortens a new
tool result before its first admission and leaves previously submitted history unchanged.
In the current [admission path](../../codex-rs/core/src/session/turn.rs#L2541),
optimization precedes recording of the pending outputs.
The measured candidate's normalized continuation checks passed across 11 admissions in
four cohorts. The source-level non-mutation property and trace evidence are described in
the [cache-preservation argument](rq3/BOUNDED_SYNTHETIC_EVALUATION.md#cache-preservation-argument).
These traces establish normalized continuation linkage, not equality of captured
wire-prefix bytes or guaranteed provider cache hits. The non-mutation argument
assumes unchanged request configuration and serialization.

The same method supports Claude Code through `elpis claude`. Its
[proxy](../../codex-rs/elpis-claude-proxy/src/prune.rs) stores the admitted form by tool-use
identifier and reuses it on subsequent requests. Assistant and thinking blocks remain
unchanged, and the last text part's tool-result cache breakpoint is retained when
text parts are combined. This implements the relevant boundary in Claude's
[identical-prefix caching requirement](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and its requirement to return
[thinking blocks unchanged](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows).
This is implementation evidence for Claude Code support; the archived continuation
measurements above used the OpenAI candidate.

Pruning is not free: it runs a second model call per admission, and its cost only
pays back over the requests that follow, because each later request re-sends the
admitted summary instead of the raw output. On 8 and 9 September 2026 we measured
this directly on the pinned fresh-output candidate (`gpt-5.6-luna`, published rates
$0.20 / $0.02 cached / $1.20 per million tokens; one frozen build; arms differ only
by the pruning flag). Full tables, provenance, and every deviation:
[`rq3/COST_EFFICIENCY_RESULTS.md`](rq3/COST_EFFICIENCY_RESULTS.md); protocol:
[`rq3/COST_EFFICIENCY_PROTOCOL.md`](rq3/COST_EFFICIENCY_PROTOCOL.md).

**Optimizer effort changes the overhead.** With the same binary and eight fixtures,
the completed single-file Max, Low, and None batches each retained 6/6 designated
facts and citations per case. Later cohorts also exposed citation-label errors,
described below.

| Optimizer effort | Reasoning tokens per admission | Latency per admission | Cost vs OFF at 3 requests | Total tokens vs OFF |
|---|---:|---:|---:|---:|
| Max (the 8 Sep setting) | 2,914–6,214 | 60–119 s | +163% | −1.1% |
| Low | 78–516 | 10–19 s | +54% | −10.5% (8/8 cases) |
| None | 0 | 6–8 s | +25% | −11.4% (8/8 cases) |

**Horizon changes the cost balance.** Over eight fixtures each, except the five-pair
Terra cohort and three multi-file orderings (Low effort unless stated):

| Requests after the output | Cost vs OFF (cases cheaper) | Total tokens vs OFF | Peak request input |
|---|---:|---:|---:|
| 2 (the 8 Sep design) | +54% (0/8) | −10.5% (8/8) | −40% |
| 10 | −3% (4/8) | −31% (8/8) | −40% |
| 34 | **−9.8% (7/8)** | **−33.5% (8/8)** | −35% |
| 34, optimizer at None | **−20.9% (8/8)** | **−33.6% (8/8)** | −35% |
| Short horizon, Terra main (10× Luna price), Luna Low optimizer | **−43.3% (5/5 priced pairs)** | −14.8% (4/5 cases lower) | −40% |
| Eight-file session, 17 later requests (3 valid orderings) | **−7.5% (3/3)** | **−63% (3/3)** | 15k vs 70k tokens |

With the pricier Terra main model, pruning was cheaper in all five priced pairs
at the short horizon.
Those arms used three or four requests, rather than identical realized request counts.
Break-even for the Luna Low pairs, extrapolated from the
optimizer's cost and the measured per-request saving, is 3–4 later requests when the provider cache is cold and 10–28
when it is warm, because cached input costs one tenth of uncached input. Token
savings held in all eight Luna cases at the reported horizons. Token counts and
the dollar value of cached input are separate measurements.
Wall-clock rose 16% at the 34-request horizon (optimizer calls of 10–19 s each).

**Against native compaction (three eight-file orderings, Low).** A third arm forced the
provider's own compaction at 40k tokens. Pruning kept the smallest context (peak 15k–28k
versus 33k–40k compacted and 70k unmanaged) and the observed cache prefix continued
without a reset. After compaction, cached input on the following request fell to
2,816–8,960 tokens from roughly 25k–31k. Compaction also retained the tested facts and
reports zero usage for its own call, so in visible counters it is the cheapest arm (−30%
versus no pruning; pruning −3%). Priced as an API compaction of the full context, the two
land within about 6% of each other. The recorded compaction summaries are encrypted,
so their text cannot be audited; pruning's admissions can. Details in
`rq3/COST_EFFICIENCY_RESULTS.md`, E5.

**Citation fidelity.** The cost study records citation-label errors in a None-effort
multi-file summary and a Low-effort Terra-cohort summary. Values and line numbers
remained correct, but the rewritten file labels failed the exact-citation oracle.
These cases remain failures for exact recoverability. They do not change the separate
four-case 24/24 result or establish that retention is invariant to optimizer effort.

**Scope.** These fixtures contain designated facts within repetitive synthetic
documents, using Luna and a smaller Terra-main cohort; dollar figures are September
published-rate estimates, not invoices. The provider cache is observed, not
controlled. In multi-file sessions the optimizer
declined to compress 4 of 29 outputs, each a wasted call; one ON conversation stalled
without a receipt and is kept as a failure. No real-repository task is measured.

## RQ5 — Auditability

Nine reconstruction properties were audited against artifacts on disk: **7 yes, 2 partial,
0 no**.

For the inspected historical artifacts, an evaluator could recover when a pass ran
and its trigger, the material reviewed, the per-item keep/delete decision, the verbatim pre-mutation text,
the replacement, a resolvable source pointer into the session rollout, and the pruning
model's own token usage.

Partial on two counts: passes record character savings rather than exact token deltas, and
session linkage is reconstructed indirectly through item `call_id` rather than stored
directly.

---

## RQ3 task performance — exploratory results and future work

Exploratory Terminal-Bench tests did not establish a clear, consistent task-performance
difference in either direction. The preserved report records eight paired comparisons
across seven distinct Terminal-Bench tasks, using `gpt-5.6-terra` at medium effort and
`gpt-5.6-luna` at Low effort for pruning. Two older LHTB tasks have saved grades, with
model settings unavailable in those records. These give nine named real tasks with
recorded outcomes; the [historical evidence receipt](../reviews/evidence-20261025/rq3-historical-tasks.json)
separates paired runs, repeated tasks, and additional probes with incomplete records.

Resource limits prevented systematic evaluation on the
demanding tasks and model combinations where we hypothesize Elpis would provide its
largest benefit: a powerful main model, such as Fable, Opus, or Astra, paired with an
inexpensive or free pruning model. Future work should evaluate that configuration on
long-horizon software tasks, comparing task correctness and total resource use against
matched no-pruning and native-compaction baselines. The
[historical pilot record](../context.md#research-boundary-historical-real-task-evidence)
describes the earlier task experiments.

A [paired correctness protocol](rq3/FINAL_PROTOCOL.md) specifies a proposed
non-inferiority study and its sample-size assumptions. The 25 October
[Sol High/Luna Low pilot](rq3/SOL_LUNA_PILOT_20261025.md) recorded six runs across
three tasks, using the saved ChatGPT login: regex passed in both arms; web-server
ON failed; SQLite ON passed. Both remaining OFF arms timed out in the verifier
without grades. Five ON admissions are verified across web-server and SQLite;
regex ON's pruning receipts were lost through an export error. Only one pair has
both grades, with its pruning exposure unknown. Two earlier setup incidents and
all known usage are retained separately. These results establish neither unchanged
task performance nor a directional effect. The pilot is excluded from confirmatory
inference; the larger task-performance study remains future work.

The subsequent [grading recovery](rq3/RECOVERY_20261025.md) ran four new agent
executions on the two affected tasks with matched 4 GiB/two-CPU limits. Web-server
scored **0/0 OFF/ON**; SQLite scored **1/1**. Seven ON admissions are verified.
One grader was resumed on its retained candidate after a download timeout, without
another model call; the original error and unchanged test/configuration hashes are
retained. Exact public bootstrap files were cached to remove the download stall.
The original six runs remain separate. No score difference was observed in these
two rerun pairs; this descriptive result does not establish performance equivalence.

The recovery recorded **703,692 tokens OFF versus 1,250,509 ON**, counting main
input plus output and all pruner usage, including cached input once. The ON total
includes **37,321 Luna tokens**. ON used **77.7% more tokens** overall (web-server
138.4% more; SQLite 24.2% more). Different agent rollouts and shared cache state
limit interpretation. Dollar cost was not measured through the saved login.
These runs demonstrated no token or monetary savings.

---

## Provider rules

**Elpis does not modify a model's own output, and does not alter any request already in
flight.** This is deliberate and worth stating plainly, because context manipulation can
be done in ways that are not.

- Pruning only ever rewrites **tool output** — content the harness supplies. Model
  reasoning, assistant messages, and user messages are ineligible by construction
  (see the fresh-output admission path and Claude proxy linked in RQ4).
- Pruning is a **separate call to a separate model instance**. It is sequenced with
  `.await` against the main agent, so the two never run concurrently and a request being
  sampled is never mutated. The main agent stops; the pruner runs; a new request is built
  from the updated history. That sequencing is why pruning adds wall-clock time.
- Providers require a model's reasoning blocks to be passed back complete and unmodified
  within a tool-use turn — Anthropic states this explicitly and rejects modified blocks
  with a 400 error ([thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking)).
  Elpis never touches those blocks.

We will not adopt any technique that violates a provider's stated requirements, and any
future change to what pruning may rewrite will be checked against them first.

## What is not established

The measurements establish context reduction on the tested workload, recoverability
of designated information from compressed summaries, and inspectable pruning records.
Fresh-output pruning leaves the submitted prefix unchanged and supports Claude Code
through the proxy. Synthetic cost cohorts show savings that depend on optimizer effort,
main-model price, and the number of later requests. Pruning adds latency per admission;
the archived citation failures bound claims about exact recoverability. These results
do not establish improved or unchanged software-task success.

## What we suspect, and why

We hypothesize that compressing individual fresh tool outputs may preserve more
task-relevant detail on demanding long-horizon tasks than replacing a span of history
with a compaction summary. The recorded synthetic comparison retained the tested facts
under both methods, so it does not establish that advantage. RQ3 future work should
test whether any difference affects task correctness and resource use.

## Known limitations

- An older turn-boundary implementation reclaimed nothing in one recorded long
  tool-driven turn: 36 tool calls, with context climbing 22k → 217k. Fresh-output
  admission addresses a different boundary, before new tool results enter history.
- The context ledger has known display defects and is being reworked.
- RQ1 covers one workload; retention and cost studies cover synthetic cases with
  Luna and a smaller Terra cohort. The models, cases, and historical versions differ
  across RQs and do not support a pooled general-performance claim.

# Evaluation status

Last revised 2026-09-09. Every figure here comes from a recorded run. Where a question is
open it says so, and nothing on this page is stated more strongly than the evidence carries.

Raw records: [`final-rq1-rq4-data`](https://github.com/MasihMoafi/Elpis) ·
derived analysis with per-metric provenance and cross-checks:
`rq1_rq4_analysis_bundle/` · pruning audit archive: `~/.elpis/logs/pruning/`.

| | Question | Status |
|---|---|---|
| RQ1 | Context efficiency | **Answered** |
| RQ2 | Information retention | **Established for the tested post-prune targets** |
| RQ3 | Task performance | Not established |
| RQ4 | Overhead and cache | **Measured for the current design** (9 Sep 2026): cost depends on optimizer effort and horizon; see below |
| RQ5 | Auditability | **Answered** |

---

## RQ1 — Context efficiency · answered

Three paired runs. One byte-identical prompt (SHA-256 verified), same model
(`gpt-5.6-luna`), same 258,400-token window, same source commit (`646c94a`) on both arms.

| Run | Codex peak | Elpis peak | Reduction |
|---|---:|---:|---:|
| 1 | 243,012 | 83,885 | **65.5%** |
| 2 | 242,057 | 127,873 | **47.2%** |
| 3 | 238,141 | 123,900 | **48.0%** |

Median context per request fell 41.6% / 51.6% / 45.5%. The direction held in all three
runs.

**Scope.** Three repetitions of *one* task, not three tasks. It generalises to repeated
runs of this workload and no further. Four runtime controls were not matched between arms
(`history_mode`, `cli_version`, `approval_policy`, `sandbox_policy`); they are recorded in
`comparability.csv`. They affect cost comparisons, not the peak-context measurement, which
is a within-arm property.

## RQ2 — Information retention · established for the tested targets

An [independent forensic audit](rq2/INDEPENDENT_AUDIT.md) reconstructed controlled session
`019ff1b2-be61-7ea3-b835-652379b13f91` from its raw rollout after 11 automatic Ace pruning
passes. All six planted task-relevant targets were explicitly present in the post-prune
model context (`replacement_history`, record 298): four requirements from the user prompt
and two exact values from the initial tool output.

This establishes **6/6 post-prune context retention for the tested targets**. Those targets
survived because they remained intact in primary history; the run does not show a deleted
or replaced fact being recovered. The retention result does not establish a
task-performance improvement.

Pruning can only ever rewrite tool output, from the source rather than an experiment:

```rust
match item {
    FunctionCallOutput { .. } | CustomToolCallOutput { .. } => …
    _ => None,   // reasoning, assistant messages, user messages
}
```

User instructions, assistant messages, and model reasoning are structurally ineligible.
That is a property of the code, not a result, and it is stated here as such.

## RQ3 — Task performance · not established

The available runs do not support a comparative correctness or task-performance claim.
No per-arm score from an incomplete, unreplicated benchmark is reported here. In
particular, there is no evidence that pruning improves task completion or output quality.

## RQ4 — Overhead and cache · measured for the current design

Pruning is not free: it runs a second model call per admission, and its cost only
pays back over the requests that follow, because each later request re-sends the
admitted summary instead of the raw output. On 8 and 9 September 2026 we measured
this directly on the current fresh-output design (`gpt-5.6-luna`, published rates
$0.20 / $0.02 cached / $1.20 per million tokens; one frozen build; arms differ only
by the pruning flag). Full tables, provenance, and every deviation:
[`rq3/COST_EFFICIENCY_RESULTS.md`](rq3/COST_EFFICIENCY_RESULTS.md); protocol:
[`rq3/COST_EFFICIENCY_PROTOCOL.md`](rq3/COST_EFFICIENCY_PROTOCOL.md).

**Optimizer effort decides the overhead, not what survives.** Same binary, same
eight fixtures, one batch per effort; every completed batch retained 6/6 planted
facts and citations on all eight closed-book probes:

| Optimizer effort | Reasoning tokens per admission | Latency per admission | Cost vs OFF at 3 requests | Total tokens vs OFF |
|---|---:|---:|---:|---:|
| Max (the 8 Sep setting) | 2,914–6,214 | 60–119 s | +163% | −1.1% |
| Low | 78–516 | 10–19 s | +54% | −10.5% (8/8 cases) |
| None | 0 | 6–8 s | +25% | −11.4% (8/8 cases) |

**Horizon decides the sign.** Over eight fixtures each (Low effort unless stated):

| Requests after the output | Cost vs OFF (cases cheaper) | Total tokens vs OFF | Peak request input |
|---|---:|---:|---:|
| 2 (the 8 Sep design) | +54% (0/8) | −10.5% (8/8) | −40% |
| 10 | −3% (4/8) | −31% (8/8) | −40% |
| 34 | **−9.8% (7/8)** | **−33.5% (8/8)** | −35% |
| 34, optimizer at None | **−20.9% (8/8)** | **−33.6% (8/8)** | −35% |
| 2, main model Terra (10× Luna price), optimizer Luna Low | **−43.3% (5/5)** | −14.8% | −40% |
| Eight-file session, 17 later requests (3 valid orderings) | **−7.5% (3/3)** | **−63% (3/3)** | 15k vs 70k tokens |

With a pricier main model the fixed optimizer cost is dwarfed by the per-request
saving: measured with Terra in front of the Luna optimizer, pruning is cheaper in
every case at the shortest horizon. Break-even, extrapolated per pair from the
optimizer's cost and the measured per-request saving, is 3–4 later requests when the provider cache is cold and 10–28
when it is warm, because cached input costs one tenth of uncached input. Token
savings do not depend on the cache and held in every case at every horizon.
Wall-clock rose 16% at the 34-request horizon (optimizer calls of 10–19 s each).

**Against native compaction (three eight-file orderings, Low).** A third arm forced the
provider's own compaction at 40k tokens. Pruning kept the smallest context (peak 15k–28k
versus 33k–40k compacted and 70k unmanaged) and never reset the cache; compaction reset the
cached prefix to the 9k system prompt at every event, also retained the planted facts, and
reports zero usage for its own call, so in visible counters it is the cheapest arm (−30%
versus no pruning; pruning −3%). Priced as an API compaction of the full context, the two
land within about 6% of each other. Compaction's summaries are encrypted and cannot be
audited; pruning's admissions can. Details in `rq3/COST_EFFICIENCY_RESULTS.md`, E5.

**Effort caveat.** In the eight-file session, one None-effort summary rewrote citation
labels (`evidence.txt:3` for `replica_quorum.log:3`) with every fact and line number
intact, failing the exact-citation oracle; Low and Max never did in 53 admissions. Low
is therefore the recommended default; None is the cost-optimal setting with that caveat.

**What this does not show.** All fixtures are synthetic single-fact documents on one
model and one account; dollar figures are published-rate estimates, not invoices;
the provider cache is observed, not controlled. In multi-file sessions the optimizer
declined to compress 4 of 29 outputs, each a wasted call; one ON conversation stalled
without a receipt and is kept as a failure. No real-repository task is measured.

## RQ5 — Auditability · answered

Nine reconstruction properties were audited against artifacts on disk: **7 yes, 2 partial,
0 no**.

An evaluator can recover, for any pruning pass: when it ran and under which trigger, what
material it reviewed, the per-item keep/delete decision, the verbatim pre-mutation text,
the replacement, a resolvable source pointer into the session rollout, and the pruning
model's own token usage.

Partial on two counts: passes record character savings rather than exact token deltas, and
session linkage is reconstructed indirectly through item `call_id` rather than stored
directly.

---

## Provider rules

**Elpis does not modify a model's own output, and does not alter any request already in
flight.** This is deliberate and worth stating plainly, because context manipulation can
be done in ways that are not.

- Pruning only ever rewrites **tool output** — content the harness supplies. Model
  reasoning, assistant messages, and user messages are ineligible by construction (see
  RQ2 above).
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

No evidence shows that selective pruning improves coding quality or task success over
native compaction. The measured facts are narrower: it reduces active context and total
tokens, retained the planted facts in every closed-book probe, leaves an inspectable audit
trail, and at Low or None optimizer effort costs less than no pruning once a session runs
past roughly ten requests after a large output (RQ4). It adds latency per admission.
Treat that as a measured trade-off on synthetic fixtures, not a performance improvement.

## What we suspect, and why

Stated as a hypothesis, not a result. We suspect selective pruning may preserve
task-relevant detail better than summarising compaction, because it removes individual tool
outputs and leaves the rest verbatim, while summarisation replaces a whole span with prose.
RQ5 shows each decision is inspectable, so the claim is at least checkable. It remains
untested against compaction directly — RQ2's forensic audit shows retention within Elpis's
own pruning, not a head-to-head comparison with compaction's information loss.

## Known limitations

- Pruning at turn boundaries only reclaims nothing on long tool-driven turns: one recorded
  session ran 36 tool calls with context climbing 22k → 217k and zero tokens reclaimed.
  Pruning inside an unfinished turn is what makes it effective, and is also where the cost
  in RQ4 comes from.
- The context ledger has known display defects and is being reworked.
- All figures come from one workload on one model. Nothing here has been replicated
  elsewhere.

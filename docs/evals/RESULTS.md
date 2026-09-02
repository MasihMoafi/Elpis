# Evaluation status

Last revised 2026-09-02. Every figure here comes from a recorded run. Where a question is
open it says so, and nothing on this page is stated more strongly than the evidence carries.

Raw records: [`final-rq1-rq4-data`](https://github.com/MasihMoafi/Elpis) ·
derived analysis with per-metric provenance and cross-checks:
`rq1_rq4_analysis_bundle/` · pruning audit archive: `~/.elpis/logs/pruning/`.

| | Question | Status |
|---|---|---|
| RQ1 | Context efficiency | **Answered** |
| RQ2 | Information retention | **Established for the tested post-prune targets** |
| RQ3 | Task performance | Not established |
| RQ4 | Overhead and cache | **Cache reuse observed; comparative economics open** |
| RQ5 | Manual Ace auditability | **Answered** |

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

## RQ4 — Overhead and cache · cache reuse observed; comparative economics open

Retrospective pruning is not free. It runs an auxiliary model call, and changing
already-sent history invalidates the cached suffix. The earlier 42-pass measurements
establish that penalty for the superseded retrospective design; they do not describe Smart
Prune.

Smart Prune instead decides a fresh tool result before the main model first sees it. In one
normal-work Smart Prune-ON session, the provider reported 2,862,592 cached tokens out of
2,986,458 input tokens (95.85%) across 68 main responses. The first main responses linked
to the two applied admissions reported 98.96% and 98.89% cached input. Encoded
mock-provider tests establish cache-preserving request construction on the tested HTTP
path; the live pilot observed provider cache reuse at both admission boundaries. See the
[2026-09-01 live pilot](tasks/smart_prune_cache_validation/2026-09-01-live-pilot.md).

This supports the cache-preserving mechanism, not a complete cost or quality result. No
private full-request trace was captured, so later live logical-prefix stability is unknown.
There was no matched OFF arm, so the pilot does not quantify Smart Prune's causal effect on
cache rate, cost, or latency. The pilot also exposed a same-turn retry storm: 18 of 20
optimizer attempts hit Elpis's 45-second deadline, and all attempts together accumulated
860.732 seconds of optimizer latency before the per-turn failure guard was added. Current
end-to-end economics and task quality remain open.

## RQ5 — Manual Ace auditability · answered

Nine reconstruction properties were audited against artifacts on disk: **7 yes, 2 partial,
0 no**.

For the evaluated manual Ace pass schema, an evaluator can recover when a pass ran and
under which trigger, what material it reviewed, the per-item keep/delete decision, the
verbatim pre-mutation text, the replacement, a resolvable source pointer into the session
rollout, and the pruning model's own token usage.

Partial on two counts: passes record character savings rather than exact token deltas, and
session linkage is reconstructed indirectly through item `call_id` rather than stored
directly.

Smart Prune writes a separate admission schema under
`~/.elpis/logs/smart-prune/admissions/`. Its focused tests cover source/admitted envelopes,
hashes, and request/response linkage; the historical 7/9 reconstruction score does not
evaluate that newer schema.

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

No evidence shows that selective pruning improves coding quality, task success, or cost per
successful task over native compaction. The measured facts are narrower: it reduces active
context, retained all six tested targets in post-prune context, and leaves an inspectable
audit trail. It also adds model cost and latency. Treat that as a trade-off, not a
performance improvement.

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

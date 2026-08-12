# Evaluation status

Last revised 2026-08-12. Every figure here comes from a recorded run. Where a question is
open it says so, and nothing on this page is stated more strongly than the evidence carries.

Raw records: [`final-rq1-rq4-data`](https://github.com/MasihMoafi/Elpis) ·
derived analysis with per-metric provenance and cross-checks:
`rq1_rq4_analysis_bundle/` · pruning audit archive: `~/.elpis/logs/pruning/`.

| | Question | Status |
|---|---|---|
| RQ1 | Context efficiency | **Answered** |
| RQ2 | Information retention | **Established for the tested post-prune targets** |
| RQ3 | Task performance | Not established |
| RQ4 | Overhead and cache | Cost and latency penalty established; current magnitude open |
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
or replaced fact being recovered. Provider capacity errors prevented a subsequent final
response, so final-answer use was not observed. The retention result does not establish a
task-performance improvement.

## RQ3 — Task performance · not established

The available runs do not support a comparative correctness or task-performance claim.
No per-arm score from an incomplete, unreplicated benchmark is reported here. In
particular, there is no evidence that pruning improves task completion or output quality.

## RQ4 — Overhead and cache · penalty established; current magnitude open

Pruning is not free. It runs a second model call per pass, and rewriting history
invalidates the provider's cached prefix, since [cache hits require an exact prefix
match](https://developers.openai.com/api/docs/guides/prompt-caching). Both costs are real
and measured.

The measurements available describe a high-frequency configuration (42 passes in one run)
that the implementation has since replaced with a low-frequency one built specifically to
reduce prefix invalidation. **The current design has not been measured under the same
protocol**, so publishing the old numbers as the cost of the current system would be
misleading.

We therefore report no cost figure for the current design. The direction of the trade-off
is established: pruning adds model cost and wall-clock latency and can reduce cache reuse.
Without a demonstrated task-performance benefit, context reduction alone does not justify
that overhead.

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

No evidence shows that selective pruning improves coding quality, task success, or cost per
successful task over native compaction. The measured facts are narrower: it reduces active
context, retained all six tested targets in post-prune context, and leaves an inspectable
audit trail. It also adds model cost and latency. Treat that as a trade-off, not a
performance improvement.

## Known limitations

- Pruning at turn boundaries only reclaims nothing on long tool-driven turns: one recorded
  session ran 36 tool calls with context climbing 22k → 217k and zero tokens reclaimed.
  Pruning inside an unfinished turn is what makes it effective, and is also where the cost
  in RQ4 comes from.
- The context ledger has known display defects and is being reworked.
- All figures come from one workload on one model. Nothing here has been replicated
  elsewhere.

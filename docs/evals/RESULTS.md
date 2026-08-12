# Evaluation status

Last revised 2026-08-12. Every figure here comes from a recorded run. Where a question is
open it says so, and nothing on this page is stated more strongly than the evidence carries.

Raw records: [`final-rq1-rq4-data`](https://github.com/MasihMoafi/Elpis) ·
derived analysis with per-metric provenance and cross-checks:
`rq1_rq4_analysis_bundle/` · pruning audit archive: `~/.elpis/logs/pruning/`.

| | Question | Status |
|---|---|---|
| RQ1 | Context efficiency | **Answered** |
| RQ2 | Information retention | Not established |
| RQ3 | Task correctness | Inconclusive — needs a real benchmark |
| RQ4 | Overhead and cache | Needs further study |
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

## RQ2 — Information retention · not established

The intended experiment planted facts and checked whether pruning preserved them. It never
produced a usable measurement: the planted facts sat in regions pruning does not touch, so
the design could not have answered its own question, and both attempted sessions were
interrupted by provider capacity errors before completion.

**We therefore make no retention claim in either direction.** No evidence that information
was lost; no evidence that it was preserved.

One thing *is* established, from the source rather than an experiment — pruning can only
ever rewrite tool output:

```rust
match item {
    FunctionCallOutput { .. } | CustomToolCallOutput { .. } => …
    _ => None,   // reasoning, assistant messages, user messages
}
```

User instructions, assistant messages, and model reasoning are structurally ineligible.
That is a property of the code, not a result, and it is stated here as such.

A corrected protocol is written up in `RQ2_PROTOCOL.md` on the `eval/rq2-v2` branch. It has
not been run.

## RQ3 — Task correctness · inconclusive

No public correctness claim is made. The available pilot work is not sufficient to support
a conclusion about whether Elpis changes task correctness. A real answer requires a
proper multi-task benchmark under a fixed protocol.

## RQ4 — Overhead and cache · needs further study

Pruning is not free. It runs a second model call per pass, and rewriting history
invalidates the provider's cached prefix, since [cache hits require an exact prefix
match](https://developers.openai.com/api/docs/guides/prompt-caching). Both costs are real
and measured.

The measurements available describe a high-frequency configuration (42 passes in one run)
that the implementation has since replaced with a low-frequency one built specifically to
reduce prefix invalidation. **The current design has not been measured under the same
protocol**, so publishing the old numbers as the cost of the current system would be
misleading.

We therefore report no cost figure yet. This needs further study, and it is the most
important open question about the approach.

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

## What we suspect, and why

Stated as a hypothesis, not a result.

We suspect selective pruning may preserve task-relevant detail better than summarising
compaction, because it removes individual tool outputs and leaves the rest verbatim, while
summarisation replaces a whole span with prose. RQ5 shows each decision is inspectable, so
the claim is at least checkable.

It is untested. Neither mechanism's information loss has been measured — including
compaction's. RQ2 is the experiment that would settle it.

## Known limitations

- Pruning at turn boundaries only reclaims nothing on long tool-driven turns: one recorded
  session ran 36 tool calls with context climbing 22k → 217k and zero tokens reclaimed.
  Pruning inside an unfinished turn is what makes it effective, and is also where the cost
  in RQ4 comes from.
- The context ledger has known display defects and is being reworked.
- All figures come from one workload on one model. Nothing here has been replicated
  elsewhere.

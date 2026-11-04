# Evaluation evidence

The records below contain the methods, results and limitations. Read the relevant record before citing a finding.

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

- [Independent retention audit](rq2/INDEPENDENT_AUDIT.md).
- [Fresh-output study](rq3/BOUNDED_SYNTHETIC_EVALUATION.md#results) and [preservation verification](../reviews/evidence-20261025/preservation-verification.json).

## RQ4 — Overhead and cache

- [Cache-preservation argument](rq3/BOUNDED_SYNTHETIC_EVALUATION.md#cache-preservation-argument).
- [Cost protocol](rq3/COST_EFFICIENCY_PROTOCOL.md) and [cost results](rq3/COST_EFFICIENCY_RESULTS.md).
- [Prompt-cache mechanics](../prompt-caching.md).

## RQ5 — Auditability

- [Forensic reconstruction audit](rq5/FINAL_RESULTS.md).

## RQ3 task performance — exploratory results and future work

- [Historical tasks](../reviews/evidence-20261025/rq3-historical-tasks.json).
- [Sol/Luna pilot](rq3/SOL_LUNA_PILOT_20261025.md) and [recovery](rq3/RECOVERY_20261025.md).
- [Study protocol](rq3/FINAL_PROTOCOL.md).

The [research review](../reviews/elpis-20261025.md) records the scope of these studies. Do not treat results from different revisions and tasks as one experiment.

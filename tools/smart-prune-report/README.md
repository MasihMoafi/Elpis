# Offline Smart Prune receipt report

This dependency-free Node tool helps Elpis maintainers inspect recorded attempts,
admissions, usage completeness, and observed cache reuse. It reads one explicit
Smart Prune directory and prints aggregate JSON; it never calls a provider, edits
receipts, or substitutes generated examples.

```bash
node tools/smart-prune-report/report.mjs --root /home/masih/.elpis/logs/smart-prune
node --test tools/smart-prune-report/report.test.mjs
```

Exit codes: `0` means inspected receipts are structurally complete, `1` means
incomplete/inconsistent evidence, and `2` means missing arguments or an unreadable
root. A complete receipt report does not establish functional or paper acceptance.
Prompts, tool bodies, raw optimizer replies, error text, IDs, and paths are not
printed. Source and admitted JSON bodies are read privately for receipt checks.

The report deduplicates attempt IDs and shared response IDs. It rejects cumulative
usage snapshots rather than summing them as requests. For every usage field,
`known_sum` totals reported values; `unknown_records` counts missing values;
`total` stays `null` unless every inspected record reports that field. Optimizer
usage comes from attempt receipts only, never counted again from `ace.json`.
Older admissions without attempt receipts are explicitly incomplete.

`source_reduction` sums recorded token estimates only for internally consistent
admissions whose source hashes and body files pass checks. It is the verified
subset of receipt estimates, not provider-token savings or net cost. The runtime
schema records a source hash but no admitted-body hash: source tampering can be
detected; historical admitted-body integrity is explicitly unavailable. Request
checksums alone cannot prove later prefix stability. Cache reads above zero show
observed reuse; zero cannot distinguish a real miss from an upstream field that
Elpis defaulted to zero. Absent cache-write fields remain unknown.

Tests create disposable synthetic fixtures for success, timeout, malformed or
missing receipts, source tampering, duplicate IDs, cumulative counters, and shared
responses. These prove report behavior only. Explicit local receipts are supplied
evidence; their provenance is not authenticated by this report, and fixtures must
never be presented as provider measurements.

## Controlled experiment still required

For the narrow question of transport/cache cost, prepare one fixed recorded
request sequence and its source/admitted artifacts. Pin code and binary hashes,
provider, exact model, reasoning effort, instructions, tools, token pricing date,
request timing, and request count in a manifest. Replay the source version with
Smart Prune OFF and the admitted version ON using distinct fresh cache keys.
Counterbalance arm order across repeated pairs and keep the request workload
identical. Record every response and every optimizer attempt, including failures,
missing usage, latency, retries, and any compaction/model change. Hash private raw
artifacts; publish only reviewed aggregates and reproducibility metadata.

Compare paired main input/cache/output usage and optimizer overhead separately.
Keep total cost unknown whenever required usage or prices are absent. Use the
encoded-request integration tests for the narrower stable-prefix mechanism proof;
this report always returns `NOT_TESTED` for prefix preservation and causal cost.
Frozen request replay measures transport cost, not counterfactual task quality.
Task quality needs a separate fixed-task OFF/ON evaluation with planted tool-only
facts, negative recall controls, and the same objective verifier for both arms.

No matched provider experiment is executed or claimed by this tool. The existing
[Smart Prune protocol](../../docs/evals/tasks/smart_prune_cache_validation/README.md)
defines the mechanism and live-observation evidence boundaries.

# Experiment dashboard

**Historical Run 1 comparison, reviewed September 9, 2026.** This dashboard uses
the superseded pruning configuration. It is separate from the current product's
live dashboard and from the [newer cost study](../rq3/COST_EFFICIENCY_RESULTS.md).
See the [public-content audit](../public-content-audit-20260909.md) for build and
test provenance. The current cost charts come from `scripts/refresh-public-evidence.py`.

The measuring instruments. `dashboard.html` is generated — never edit it by hand, edit the
inputs and re-run `build.py`.

Everything the page renders is measured. There is no projection, extrapolation or synthetic
series anywhere in the pipeline.

## Adding a run

```bash
python3 collect.py <path-to-rollout.jsonl> --split --system <codex|elpis>   # writes runs/exp<N>-<system>.json
python3 build.py                                                            # redraws dashboard.html
```

The collector names runs `exp<N>-codex` and `exp<N>-elpis`. The current `build.py`
explicitly loads `exp1-codex` and `exp1-elpis`; adding a file does not automatically
include a new cohort. Update the selected inputs and evidence labels deliberately.

## Files

| File | Does |
| --- | --- |
| `collect.py` | Transcript → `runs/<id>.json` |
| `charts.py` | Pure-SVG primitives — no CDN, so the page opens offline |
| `build.py` | Redraws the historical comparison from the two selected Run 1 files |

## Two accounting rules that change the headline if you get them wrong

1. **Per-request usage comes from deltas of the cumulative counters**, never from the per-turn
   field. That field is re-emitted when a turn ends without issuing a request, which invented
   211,106 phantom input tokens the first time this was measured.
2. **Elpis writes prune checkpoints as `compacted` rollout items**, distinguished from a real
   compaction only by the `elpis.context-prune.v1:` message prefix. Miss it and a run with zero
   compactions reports twenty-six.

## Not measured

Money. No rate card is applied — vendor caching behaviour is not something we have measured,
so nothing is priced.

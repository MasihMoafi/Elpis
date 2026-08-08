# Context economics dashboard

Charts every experiment from session transcripts. Adding a run is one command; the charts
redraw from whatever is in `runs/`.

## Add a run

```bash
python3 collect.py <path-to-rollout.jsonl> --id <name> --system <elpis|codex> \
        --label "Human readable" [--prune-window <UTC-FROM> <UTC-TO>]
python3 build.py
```

`--prune-window` bounds which Ace passes in `~/.elpis/logs/pruning/passes` belong to the run.
Omit it for Codex, which has none.

## Files

| file | what it owns |
|---|---|
| `collect.py` | transcript → canonical run record in `runs/` |
| `project.py` | extends a measured run to a longer horizon (block bootstrap) |
| `pricing.json` | rate cards, including context tiers and their thresholds |
| `cost.py` | prices a run against a rate card |
| `charts.py` | SVG primitives — no external libraries, opens from `file://` |
| `build.py` | renders `dashboard.html` |

## Accounting rules that matter

- **Per-request usage comes from the movement in cumulative counters**, not `last_token_usage`.
  That block is re-emitted when a turn ends without a request; summing the re-emits overstated
  one run by 211k phantom input tokens.
- **Prune checkpoints are not compactions.** Elpis writes both as `compacted` rollout items;
  only the `elpis.context-prune.v1:` message prefix distinguishes them.
- **Cost is a range, not a number.** The split between fresh input and cache writes is not in
  the telemetry, so `base` (fresh at input rate) and `write` (fresh at cache-write rate)
  bracket it.
- **Tiers key on a request's input size**, not the window: OpenAI's long-context line is
  272k, above the 258.4k window, so it never applies here. Anthropic Sonnet and Gemini 3 Pro
  cross at 200k, which Codex does routinely and Elpis does not.

## Runs on file

Measured: `exp1-codex`, `exp1-elpis` (experiment 1, identical prompt and checkout);
`long-codex-a/b/c` (real sessions of 1,566 / 1,672 / 983 requests with 13 / 11 / 7 compactions).
Projected: `long-elpis-hold`, `long-elpis-drift` — see the method note in the dashboard.

# Handoff: cost / compaction experiments (2026-09-09)

For a fresh session. Read this, then `docs/evals/rq3/COST_EFFICIENCY_RESULTS.md`
and `docs/evals/terminal-bench/PLAN.md` (on branch `agent/terminal-bench-eval`).

## State: nothing running. Nothing to clean up.

### Result 2026-09-10 07:43-08:56 (valid pair, Terra)
Both arms PASSED. Compactions 1 vs 1 (OFF hit 60k at request 130, ON at 138).
ON: 190 requests vs 164, +11.5% tokens, +12.6% cost ($2.06 vs $1.83 incl. $0.017
optimizer), +24% wall; 11 admissions saved ~22k source tokens but the context is mostly
non-prunable. Hypothesis NOT supported at n=1: growth-rate reduction ~6%, not ~20%.
Full table and interpretation in `docs/evals/terminal-bench/PLAN.md` (branch
`agent/terminal-bench-eval`). Runs in `~/elpis-tb-scratch/compact/compile-compcert-{off,on}`.

### Attempt 2026-09-09 20:29-20:44 (void, quota)
The compile-compcert pair below was launched at a 60k budget / 2400s limit. Both arms
died early on provider-side limits, not on the task: OFF at request 9 ("Selected model
is at capacity"), ON at request 6 ("You've hit your usage limit ... try again at
Sep 12th, 2026 9:45 AM"). 0 compactions, ~160k tokens total, container networking
fine. Void runs kept for the record under `~/elpis-tb-scratch/compact/compile-compcert-
{off,on}.void-*`. Scoring is ready: `tools/terminal-bench/compact_pair_report.py RUN_DIR...`
(worktree `agent/terminal-bench-eval`), validated on the dna-assembly 25k pair
(OFF 1 / ON 1 compaction, ON cost +10.6% incl. optimizer). Re-launch the same command
after the PRO limit resets on 2026-09-12 09:45; the script skips nothing now (void dirs
were renamed), so it will run OFF then ON afresh.

A Luna-main retry at 20:56 (`ELPIS_TB_MODEL=gpt-5.6-luna`, runs under
`~/elpis-tb-scratch/compact-luna/`) died at the first request with the same
`usage_limit_exceeded`: the limit is account-wide, not per model. Do not read model
availability off the `rate_limits` fields in old token_count events; the `premium`
record with null fields is what comes back once limited. Before relaunching, send one
cheap request (or check https://chatgpt.com/codex/settings/usage) and only then start
the pair.

## Proven and written up
- Synthetic cost study (Luna, Terra): pruning cuts tokens ~33%; at Low/None optimizer
  effort it is cheaper than no pruning past ~10 requests after a large output, growing
  with horizon (-21% at 35 req) and with a pricier main model (-43% Terra at 3 req).
  Retention 6/6 at every effort. Docs in `docs/evals/rq3/`, 23 sealed archives in
  `docs/evals/final-data/COST-*`.
- Cache/compaction head-to-head (E5): pruning keeps smaller context and does not reset
  the cache; native compaction resets it every event and is unauditable (encrypted item).
- Terminal-Bench real-task pilot (6 engaging pairs, Terra): pruning did NOT harm task
  success; token/cost effect weak and not significant at n=6; a single 770k-token output
  made pruning backfire. Honest boundary, not a win.
- Candidate source default optimizer effort flipped Max -> Low (NOT rebuilt/installed).

## The one open experiment (the goldmine, if it holds)
Hypothesis (Masih): pruning reduces how often the agent must run native compaction;
compaction is costly, resets the cache, and loses context, so fewer compactions =>
lower cost AND better task success. Pruning only DELAYS compaction (reduces frequency
~ prunable fraction, ~20%), it does not eliminate it.

Why not yet proven: bounded Terminal-Bench tasks compact 0-1 times, so a ~20% frequency
reduction is invisible (20% of 1 = 1). First compaction pair (dna-assembly @25k budget)
showed OFF 1 compaction / ON 1 compaction, pruning cost +11%: negative on a short task.

Next step: ONE long, output-heavy, multi-compaction session where OFF compacts several
times, e.g. `compile-compcert` (2400s agent limit, verbose build output), OFF vs ON on
Terra at a realistic budget. Measure compaction COUNT per arm, cost, and the benchmark's
pass/fail. Est. ~$5-15 usage-equivalent per arm. If OFF compacts more than ON and ON is
at least as good, the hypothesis holds and becomes the headline. Command:
  ELPIS_TB_TIMEOUT=2400 bash tools/terminal-bench/run_compact_pair.sh compile-compcert 60000
(from the `agent/terminal-bench-eval` worktree). Then analyze with the per-arm compaction
count + cost logic already in the pilot. If too costly, characterize analytically from the
measured ~20% growth-rate reduction and label it a projection.

## Guardrails (do not break)
- Use the ChatGPT PRO subscription auth (`~/.codex/auth.json`), NOT an API key. Dollar
  figures are published-rate ESTIMATES from token counts, never charges.
- The per-run auth copy blanks the refresh token (auth_copy.py) so a 401 fails the run
  instead of rotating Masih's live session. Never commit auth.json anywhere.
- Terra (or Luna) only; Sol/Astra by projection unless Masih approves a run. Optimizer
  stays Luna Low regardless of main model.
- Run ONE validated pair first, inspect, then continue. Nothing pushed without Masih's go.
- Free account `~/.elpis/auth.json` hit its limit; resets 2026-09-13 11:48.

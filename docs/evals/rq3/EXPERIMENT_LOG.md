# Experiment log: cost-efficiency and cache studies

Generated from the sealed archives under `docs/evals/final-data/COST-*` on 9
September 2026. One row per batch; every batch runs one lane, no retries, and
seals its plan, oracles, harness copy, checkpoints, and report. Status
`stopped` means a gate failed at the listed conversation count and the batch
ended there; the sealed evidence up to that point is kept. Binary: the frozen
local-release build in `~/.local/share/elpis/experiments/COST-EFFORT-BUILD-20260908-01`.

| Archive | First launch | Profile | Main / optimizer @ effort | Status | Conversations | Binary |
| --- | --- | --- | --- | --- | ---: | --- |
| COST-CACHE-8-LOW-LUNA-20260908-01 | 2026-09-09 08:02 | cache:8:low | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 4/12 | d58e8c9b8861 |
| COST-CACHE-8B-LOW-LUNA-20260908-01 | 2026-09-09 08:11 | cache:8:low:cases=3-8 | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 9/9 | d58e8c9b8861 |
| COST-E1-LOW-LUNA-20260908-01 | 2026-09-08 23:54 | effort-ablation:low | gpt-5.6-luna / gpt-5.6-luna @ low | passed | 24/24 | d58e8c9b8861 |
| COST-E1-LOW-TERRA-20260908-01 | 2026-09-09 08:09 | effort-ablation:low:main=gpt-5.6-terra | gpt-5.6-terra / gpt-5.6-luna @ low | stopped | 2/24 | d58e8c9b8861 |
| COST-E1-LOW-TERRA-B-20260908-01 | 2026-09-09 08:26 | effort-ablation:low:main=gpt-5.6-terra | gpt-5.6-terra / gpt-5.6-luna @ low | stopped | 15/24 | d58e8c9b8861 |
| COST-E1-MAX-B-LUNA-20260908-01 | 2026-09-09 03:58 | effort-ablation:max | gpt-5.6-luna / gpt-5.6-luna @ max | passed | 24/24 | d58e8c9b8861 |
| COST-E1-MAX-LUNA-20260908-01 | 2026-09-09 01:08 | effort-ablation:max | gpt-5.6-luna / gpt-5.6-luna @ max | stopped | 1/24 | d58e8c9b8861 |
| COST-E1-MEDIUM-B-LUNA-20260908-01 | 2026-09-09 04:17 | effort-ablation:medium | gpt-5.6-luna / gpt-5.6-luna @ medium | stopped | 3/24 | d58e8c9b8861 |
| COST-E1-MEDIUM-C-LUNA-20260908-01 | 2026-09-09 04:38 | effort-ablation:medium:cases=2-8 | gpt-5.6-luna / gpt-5.6-luna @ medium | stopped | 16/21 | d58e8c9b8861 |
| COST-E1-MEDIUM-LUNA-20260908-01 | 2026-09-09 01:29 | effort-ablation:medium | gpt-5.6-luna / gpt-5.6-luna @ medium | stopped | 1/24 | d58e8c9b8861 |
| COST-E1-MINIMAL-LUNA-20260908-01 | | (no sealed report; copied with SHA256SUMS) | | | | |
| COST-E1-NONE-B-LUNA-20260908-01 | 2026-09-09 04:18 | effort-ablation:none | gpt-5.6-luna / gpt-5.6-luna @ none | passed | 24/24 | d58e8c9b8861 |
| COST-E1-NONE-LUNA-20260908-01 | 2026-09-09 01:49 | effort-ablation:none | gpt-5.6-luna / gpt-5.6-luna @ none | stopped | 1/24 | d58e8c9b8861 |
| COST-E2-32-LOW-ABORTED-STRICT-GATE-LUNA-20260908-01 | | (no sealed report; copied with SHA256SUMS) | | | | |
| COST-E2-32-NONE-LUNA-20260908-01 | 2026-09-09 04:53 | horizon:32:none | gpt-5.6-luna / gpt-5.6-luna @ none | passed | 16/16 | d58e8c9b8861 |
| COST-E2-32B-LOW-LUNA-20260908-01 | 2026-09-09 00:24 | horizon:32:low | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 3/16 | d58e8c9b8861 |
| COST-E2-32C-LOW-LUNA-20260908-01 | 2026-09-09 03:11 | horizon:32:low:cases=2-8 | gpt-5.6-luna / gpt-5.6-luna @ low | passed | 14/14 | d58e8c9b8861 |
| COST-E2-8-LOW-LUNA-20260908-01 | 2026-09-09 00:03 | horizon:8:low | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 6/16 | d58e8c9b8861 |
| COST-E2-8B-LOW-LUNA-20260908-01 | 2026-09-09 00:10 | horizon:8:low | gpt-5.6-luna / gpt-5.6-luna @ low | passed | 16/16 | d58e8c9b8861 |
| COST-E3-8-LOW-LUNA-20260908-01 | 2026-09-09 00:48 | multi-output:8:low | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 1/8 | d58e8c9b8861 |
| COST-E3-8-NONE-LUNA-20260908-01 | 2026-09-09 05:20 | multi-output:8:none | gpt-5.6-luna / gpt-5.6-luna @ none | stopped | 6/8 | d58e8c9b8861 |
| COST-E3-8B-LOW-LUNA-20260908-01 | 2026-09-09 03:34 | multi-output:8:low | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 3/8 | d58e8c9b8861 |
| COST-E3-8C-LOW-LUNA-20260908-01 | 2026-09-09 04:26 | multi-output:8:low:cases=3-8 | gpt-5.6-luna / gpt-5.6-luna @ low | stopped | 6/6 | d58e8c9b8861 |

Account: all batches used `~/.elpis/auth.json`, a free-tier ChatGPT login (masked
email jos***@outlook.com); the owner's Pro account was not used. Its usage limit was
reached on 9 September and resets on 13 September 11:48.

Analysis: `cost-metrics.mjs` with `LUNA_PUBLISHED_RATES_2026-09-08.json`
(Luna main) or `TERRA_MAIN_LUNA_OPTIMIZER_RATES_2026-09-09.json` (Terra main);
outputs `COST_EFFICIENCY_METRICS.json` and `COST_EFFICIENCY_METRICS_TERRA.json`.
Narrative: `COST_EFFICIENCY_RESULTS.md`. Deviations and product findings are
listed there, not here.

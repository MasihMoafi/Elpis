# Experiment log

Stable references for Elpis's paper and engineering evaluation. A run's existence
is not a positive result. Keep planned, executed, failed, and confounded work distinct.
Never replace an old result when code, inputs, or analysis changes; add a linked entry.

| ID | Date | Kind | Status and supported conclusion |
| --- | --- | --- | --- |
| [ELPIS-BRAND-20260905-01](tasks/context_ui_validation/2026-09-05-brand.md) | 2026-09-05 | Native branding and guarded build check |80 focused checks pass; narrow cache recovery succeeded in2,006s outer with25 holds. Installation took0.21s. Offline eight-category/count/color/bar checks pass; user acceptance pending. Outer peak82 C, so below80 C was not maintained. No provider or matched speed claim. |
| [ELPIS-SMOKE-20260905-01](tasks/smart_prune_cache_validation/2026-09-05-live-smoke.md) | 2026-09-05 | Live functional smoke, ON only | One admitted tool result retained a planted fact; linked response reported cache reuse. Not a comparative savings experiment. |
| [ELPIS-BUILD-20260905-01](../LOCAL_BUILD_RULES.md#measured-on-2026-09-04) | 2026-09-05 | Local engineering timing | Changed-core/TUI optimized build 290.127 s, peak 74 C; installation 0.14 s. No matched language/compiler comparison. |
| [ELPIS-BUILD-20260905-02](../LOCAL_BUILD_RULES.md#measured-on-2026-09-04) | 2026-09-05 | Local engineering timing | Changed app-server/TUI optimized build 111.283 s, sampled peak 77 C; installation 0.16 s. Raw details remain private. Different edits from run 01, not a matched speedup comparison. |
| [ELPIS-BUILD-20260905-03](../LOCAL_BUILD_RULES.md#measured-on-2026-09-04) | 2026-09-05 | Local engineering timing | TUI-only optimized build 113.966 s (outer guard116 s), sampled peak73 C, one logical CPU; installation 0.19 s. Different edit/load from earlier runs; no matched speedup claim. |
| [ELPIS-UI-20260905-01](tasks/context_ui_validation/2026-09-05-resume.md) | 2026-09-05 | Offline installed-TUI replay | Resumed Ledger and `/context` match on all eight estimated categories and RGB colors; 9,805 / 258,400 = 3.7945%. Three in-memory count/color/bar corruption controls fail as intended. Native visual acceptance remains open. |

## Rules for subsequent entries

Before paid execution, record the question, input/workload and verifier, treatment
and control, exact provider/model/effort, code/binary hashes, request budget, stopping
condition, randomization/order and intended analysis. Get user agreement when
those choices change the question, cost, data, or method.

After execution, append start/end timestamps, actual calls/models/retries where
observable, every failed or timed-out attempt, original and admitted estimates,
provider usage with missing fields preserved, latency, objective quality results,
deviations, raw-evidence hashes/location, analysis command/version, and allowed claims.
Archive raw evidence privately; commit only reviewed aggregate reports and methods.

Unit/mock tests are mechanism checks, not provider measurements. Generated website
demos and legacy sample benchmark traces are illustrative, never experimental arms.
Current paired OFF/ON cache-cost and task-quality studies remain **not executed**;
their protocol is [here](tasks/smart_prune_cache_validation/README.md).

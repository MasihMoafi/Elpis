# RQ3 paired task-correctness study

25 October 2026. **The six-arm Sol/Luna feasibility pilot finished with four official grades and two verifier timeouts.** Only one pair has both grades, and that pair lacks reliable ON admission evidence. See the [pilot result](SOL_LUNA_PILOT_20261025.md). The launcher is closed; main-study tasks, sample size and quota budget remain unfrozen. **RQ3 remains future work. Astra and paid OpenRouter remain forbidden; any authorized inference must use the saved ChatGPT login.**

Masih then requested reruns or continuation ASAP. The [four-run recovery](RECOVERY_20261025.md)
completed both affected task pairs: web-server 0/0 OFF/ON; SQLite 1/1, with seven
verified admissions. Its matched resource caps and cached bootstrap are recorded;
one grade was recovered from a retained candidate without repeating its model run.
Original timeouts and grades remain intact. These are descriptive follow-up data,
excluded from a confirmatory study. No larger batch is launched automatically.

**Question:** does Smart Prune reduce task success by less than a declared practical margin? The recommended primary margin is **5 percentage points**, with one-sided 95% confidence and 80% power. This is a proposed practical tolerance, not a universal research standard or a claim of exactly zero effect.

| Acceptance contract | State |
| --- | --- |
| Compare one pinned Elpis binary with pruning ON/OFF; same main model, prompts, graders, tools, native compaction, and budgets. | Matched invocation/config checks passed |
| First configuration: `gpt-6-sol` high main, `gpt-6-luna` low pruner; saved ChatGPT authentication only, no paid OpenRouter calls or API-key billing. | Live main and pruner inference verified |
| Three distinct cached Terminal-Bench tasks, one pair each, one lane; balanced arm order. Pilot is excluded from the confirmatory study. | Six arms recorded; launch gate closed |
| Use official hidden graders. Preserve all attempts, including timeouts, failures and cases with no pruning admission; record infrastructure failures separately. | Four grades; two verifier timeouts; two earlier setup incidents retained |
| Keep resource guard enabled, original auth unchanged, credentials out of evidence, no paid API keys, no production changes. | Native guard observed in all six arms |
| Capture model identities, actual admissions, raw grades, final changes, all inference usage, cache counters and elapsed time. | Partial: five confirmed admissions; regex ON receipts lost; snapshot size limit retained |
| Freeze independent main tasks, model configuration, N and total quota cap before collection. Model configurations receive separate conclusions. | Pending grading repair and complete audit capture |

At equal true success rates, conditional planning gives:

| Permitted loss | Pairs if 10% disagree | Pairs if 20% disagree |
| --- | ---: | ---: |
| 2 percentage points | 1,578 | 3,104 |
| **5 percentage points** | **274** | **507** |
| 10 percentage points | 81 | 134 |

Each pair means two agent executions on one distinct task. These are planning scenarios; actual disagreement, task dependence and finite-sample behavior determine the final design. [Calculator](paired_power.py) reproduces a [published 507-pair example](https://doi.org/10.1186/s12874-025-02497-2).

The primary analysis uses a Nam/Tango paired score interval for ON-minus-OFF success rate. Declare non-inferiority only when the one-sided 95% lower bound exceeds −0.05. A nonsignificant McNemar test cannot establish unchanged performance. Report all four paired outcome counts and the interval; token use and latency are separate outcomes.

Execution requires a compatible Linux sandbox host, not a local GPU. This pilot ran locally in Docker using process-specific supplementary-group access. Kaggle's separate model-proxy/notebook service remains an unvalidated Elpis/Terminal-Bench integration. Repair grader reliability and verify complete audit capture before a main study; uploads, large downloads, or a new paid budget require separate authorization.

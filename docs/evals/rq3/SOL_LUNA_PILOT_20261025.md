# Sol/Luna task-performance pilot

25 October 2026. **GPT-6 Sol High main; GPT-6 Luna Low pruner**, both through the
saved ChatGPT login. Three task pairs, one execution per arm, one lane.
No Astra, paid OpenRouter, API-key billing, or automatic main study.

| Official task | Pruning OFF | Pruning ON | Verified ON admissions |
| --- | --- | --- | ---: |
| regex-log | Pass | Pass | Unknown: audit export gap |
| configure-git-webserver | Ungraded: verifier timeout | Fail: HTTP 404 | 3 |
| sqlite-with-gcov | Ungraded: verifier timeout | Pass: 3/3 checks | 2 |

**This pilot cannot establish unchanged task performance.** Six runs finished:
four official grades and two verifier timeouts. The only fully graded pair lacks
reliable ON admission evidence. Timeouts remain ungraded. Their logs show no pytest
result; a later bootstrap-URL probe returned 403. The exact cause is unproven.

Binary, prompts, models, config, guard, native compaction and deadlines matched;
only the pruning flag differed. Graders and fixtures were unchanged. Five admissions
have Luna Low attempt records, manifests and linked request/response receipts.
Regex ON's exporter used the wrong directory; cleanup prevented recovery.
Its exposure and optimizer usage remain unknown, not zero.

Two earlier setup incidents remain separate: missing CA prevented routing before
recorded usage; missing code-mode companion prevented tools despite 49,285 input
and 2,735 output Sol tokens. A Luna tool smoke is not a benchmark result.
All incidents and known usage are retained. SQLite overlaps the historical nine
tasks: **11 named real tasks across records**, with model cohorts kept separate.

The [receipt](../../reviews/evidence-20261025/sol-luna-pilot.json) and
[offline generator](summarize_sol_pilot.py) preserve grades, hashes, usage and controls.
Known usage, including setup and smoke, is at least 1,781,718 tokens; cached input
is included. Missing optimizer receipts prevent a complete total. Repair grading
and audit capture before freezing a separately budgeted main study.
**RQ3 remains future work; this pilot is excluded from confirmatory inference.**

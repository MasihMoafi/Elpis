# Pruning Ablation: Review Draft

2026-09-05. NOT APPROVED. Owner and acceptance authority: Masih.
Scope: specification only; no experiments, installs, uploads, or paid inference.

## Proposed Decision

Compare the same Elpis binary with automatic pruning ON versus OFF, not Elpis
versus Codex. Prefer local Luna, after resolving the exact model/provider ID and
pruning-model configuration. An inexpensive model is acceptable, not interchangeable
with other models: conclusions apply to the tested model, settings, and workload.

Propose the three-task feasibility pilot below (six runs), then a fixed main study
sized using justified variability assumptions and an approved budget. Pilot data is
excluded from the main hypothesis test. Neither stage starts until Masih accepts its protocol and
executable fixtures. This draft does not replace FINAL_PROTOCOL.md or existing RQ
results. RQ2 demonstrated retention of six tested targets, not general correctness.

## Claims

- Primary: does automatic pruning reduce total model tokens per attempted task?
- Secondary: what happens to objectively graded success, latency, and cache use?
- Proposed meaningful alternative for power planning: 20% geometric-mean reduction
  in total tokens. Masih must accept this choice; it is not an observed effect.
- Fewer tokens because ON fails early is not useful efficiency. Present correctness
  alongside resource use. Do not claim non-inferiority, no quality loss, or improved
  correctness from a nonsignificant success-rate comparison.

## Sample Size, Not a Magic Minimum

Calculated for a two-sided paired t-test, alpha 0.05, power 0.80, independent task
pairs, and approximately normal paired log-token differences:

| Standardized paired effect dz | Distinct tasks / pairs | Main runs | With six pilot runs |
| --- | ---: | ---: | ---: |
| 0.8 | 15 | 30 | 36 |
| 0.5 | 34 | 68 | 74 |
| 0.3 | 90 | 180 | 186 |

One pair is one ON and one OFF run of the same task. Tool calls, assertions, pruning
passes, and repetitions of a task are not independent tasks. This budget design
prioritizes distinct tasks over repetitions; stochastic variability remains a limit.

For each task D = log(total_tokens_ON / total_tokens_OFF). Planning uses
dz = abs(log(0.8)) / SD(D). The rows correspond approximately to SD(D) of 0.279,
0.446, and 0.744. We do not know the actual variability yet. These are conditional
sample sizes, not guaranteed power or an academic acceptance rule.

Verified locally using SciPy's noncentral t distribution:

```text
critical = t.isf(0.025, n - 1)
noncentrality = dz * sqrt(n)
power = nct.sf(critical, n - 1, noncentrality)
      + nct.cdf(-critical, n - 1, noncentrality)
Select the smallest integer n with power >= 0.80.
```

Power at n=15,34,90: 0.8213, 0.8078, 0.8038 respectively; each preceding integer
falls below 0.80. This was a statistical calculation, not an Elpis experiment.

After the pilot, show SD(D), its uncertainty, sample-size sensitivity, measured
run cost, and proposed N. Three pairs are a feasibility check, not a reliable
variance estimate. If no defensible variance assumption exists, seek approval for
additional independent calibration before a powered main study. Do not use an
optimistically selected pilot mean as the target effect. Keep the meaningful
alternative fixed; obtain approval for main N and budget before independent main
data collection. If justified N is unaffordable, publish an exploratory study with
its detectable effect and uncertainty, not a claim of adequate power.

Correctness requires different planning. Even with zero ON-fail/OFF-pass outcomes,
the exact one-sided 95% upper bound on that event probability is 1-0.05^(1/N):
18.1% at 15 independent pairs, 8.4% at 34, and below 5% only at 59. This is a
best-case precision illustration, NOT a powered paired non-inferiority design or
proof that pruning caused individual discordances. Establishing a 5-percentage-point
correctness margin needs a separate design and assumptions about discordance.

## Proposed Tasks

Self-contained, offline, pinned coding fixtures with hidden deterministic graders.
Prefer small JavaScript/TypeScript or shell projects to avoid repeated Rust builds.
These are proposed fixtures, not an already validated benchmark.

Each requires earlier tool evidence after substantial intervening work. Relevant
facts must arrive through normal source/log/test output, not user/system prompts.
Use meaningful source/log volume rather than repeated filler. Keep original files
rereadable and count recovery reads. Verify target facts are initially visible,
not already removed by output caps or RTK.

| ID | Task | Hidden correctness check |
| --- | --- | --- |
| B1 | Repair cache expiry boundary | Fake-clock live/expired cases |
| B2 | Repair file/env/CLI config precedence | Complete precedence matrix |
| B3 | Repair cursor pagination with duplicate keys | No skipped/duplicated records |
| B4 | Repair Unicode diagnostic positions | Exact line/column cases |
| B5 | Repair listener cleanup on cancellation | No post-cancellation callbacks |
| C1 | Add CLI dry-run across modules | Correct plan and zero writes |
| C2 | Migrate config key with legacy support | Old/new/conflicting keys |
| C3 | Add filter across parser/service/serializer | End-to-end result and compatibility |
| C4 | Add bounded retry with existing error types | Permanent/transient/max-attempt cases |
| C5 | Add structured logging | Schema, ordering, and secret redaction |
| D1 | Diagnose stale cache from a recorded trace | Stale-read regression repaired |
| D2 | Diagnose timezone conversion from logs | Exact boundary timestamps |
| D3 | Diagnose dropped CLI option across layers | Option reaches final behavior |
| D4 | Diagnose persistence serialization mismatch | Round-trip and legacy fixtures |
| D5 | Diagnose dependency ordering from build trace | Correct order or cycle error |

The pilot uses three separate fixtures, not reused in the main study:

| ID | Fixed task | Earlier tool evidence | Hidden grading |
| --- | --- | --- | --- |
| P1 | Diagnose and fix duplicate delivery from a long event log | Retry sequence and idempotency rule | Reproduce duplicate; repair it without dropping distinct events |
| P2 | Add an output-format option across CLI modules | Legacy output contract discovered early | New format works; existing default output stays byte-compatible |
| P3 | Investigate a recorded multi-stage import failure | Source schema, trace IDs, and ordering facts spread across outputs | Exact root cause, affected records, and supporting source references |

P3 uses structured answers and deterministic checks, not a model judging prose.
Fixtures require enough meaningful intervening evidence to exercise production
Smart Prune. Their exact content and hashes remain subject to fixture review.

If main N exceeds 15, approve additional genuinely distinct tasks before main runs.
Do not inflate N with cosmetic variants. Shared templates/repositories may introduce
dependence: revise sampling and power analysis if present. Freeze the complete suite
and selection method. Results describe this synthetic stress suite, not arbitrary
repositories or developer productivity.

Each fixture must have an exact prompt, immutable starting tree, source/hash manifest,
reference repair, hidden grader, and pressure profile before approval. These artifacts
are not yet implemented; title-only tasks cannot enter the main study.

## Acceptance Harness

1. Every grader must fail the starting defect, pass a reference repair, and reject a
   plausible incomplete repair. Keep hidden answers inaccessible to the running agent.
2. Through the real runtime, show ON applies an audited rewrite to eligible old tool
   evidence and a subsequent model request sees it. OFF must retain the original and
   have no applied pruning pass. Include a below-threshold negative case.
3. Deliberately break the expected condition and show the evaluator fails. A log
   claiming a pruning call happened is insufficient behavioral evidence.
4. Reconcile usage for main, pruning, retry, fallback, and compaction calls exactly
   once. Incomplete usage blocks total-token claims.
5. Verify headless execution exercises production automatic pruning. If it does not,
   stop and revise the harness rather than silently test a different mechanism.
6. Show Masih representative transcripts, grader results, and failure controls before
   the calibration batch; seek separate approval for the main sample and budget.

## Controls and Stopping

- Freeze the current release-candidate binary/hash, model/provider IDs, reasoning
  effort, model window, prompts, tools, and limits. Only automatic pruning differs.
- Record pruning thresholds, protected region, pass caps, prompt/model/effort, and
  fallback. Do not assume the pruning model is Luna or automatic pruning is default-on.
- Native compaction stays enabled with identical settings; RTK, hooks, and output
  caps stay identical. Record compactions, not hand-disable production mechanisms.
- Start each run with isolated workspace/session state, no prior patches, memory,
  checkpoints, or personal instruction leakage. Use identical approved instructions.
- Fixed scripted prompts; no human or outer browser/terminal-agent assistance.
  Elpis and its selected model perform the work, not the orchestration agent.
- Bounded parallel execution on one host/provider as specified below. Randomize task
  order and balance ON-first/OFF-first pairs with a recorded seed (imbalance at most
  one for odd counts). Do not pool local and Kaggle conditions.
- Proposed ceilings: 50 tool calls and 20 minutes per run. Approve a calibration
  spend cap first; use observed cost to freeze per-run and total main-study caps.
  Smoke checks and retained infrastructure failures add cost beyond the table.
- Calibrate workloads to reach pressure without shrinking the model's real context
  window. Freeze workloads before main runs. If main ON does not activate pruning,
  retain that run and report it; no post-hoc selection of successful pruning cases.
- Agent errors, early exits, and timeouts remain scored attempts. Classify quota,
  auth, and transport failures separately and retain all evidence. Permit at most
  one replacement pair after an infrastructure failure is resolved; an unresolved
  pair blocks a complete-study claim. No silent retries or selective extensions.
- No significance peeking or stopping when a favorable p-value appears.

## Parallel Runner Contract

This specifies a future external experiment harness, not Elpis's worker-agent graph.
Do not enable fanout or use graph workers to solve these tasks: that would introduce
a second experimental variable. No harness or experiment has been launched.

### Scheduling and Isolation

- One coordinator owns the persistent schedule and results index. Default maximum:
  two active Elpis processes, one attempt per lane. No additional analysis agents.
- Schedule complete task pairs into lanes. Each lane runs the assigned task's two
  arms sequentially in predeclared randomized order, using separate fresh state.
  Different tasks may run concurrently; the same task's ON/OFF arms never overlap.
- Process waves of at most two pairs. Do not start the next wave until the current
  wave's pairs are terminal. With three pilot tasks, the first wave has two pairs
  and the second one. The schedule is frozen before inference, not chosen by results.
- Give each attempt its own fixture copy, session/config/state directories, temp
  directory, logs, working directory, and process group. No shared writable files,
  databases, checkpoints, tool caches, or build outputs. Reuse only immutable assets.
- Use the frozen release binary; no builds during measured runs. Verify effective
  state roots for this binary rather than assume an environment variable isolates it.
  Authentication access must not expose personal workspace/session state or secrets.
- Record lane, wave, arm order, concurrency at every request, resource contention,
  provider throttling, model fingerprint when available, and all retry/backoff events.
  ON may add optimizer requests, so process count does not equal inference concurrency.
- A shared admission budget must cover main and optimizer requests. Verify that the
  provider quota can support both lanes and that all inference usage is observable.
  Pause new dispatch on quota/backoff pressure; never switch models or silently lower
  reasoning effort. Changed concurrency/settings require a separately labeled batch.

### Cache and Latency Confounding

Parallel execution can warm shared provider prefixes and compete for quota/CPU.
An isolated filesystem does not imply an isolated provider cache.

Before cache comparisons, verify whether supported provider cache keys/namespaces
actually isolate reuse. If available and demonstrated, assign each attempt a stable
unique namespace, keep it fixed within the attempt, and make both arms start under
equivalent cold/warm conditions. Log settings without modifying task semantics.
Do not claim a cache-key field guarantees isolation merely because it is accepted.

If provider cache isolation cannot be established, the parallel pilot may report
observed cached-input counts but cannot establish unchanged cache reuse versus OFF.
Do not present cache-dependent cost differences as isolated pruning effects. Ask
Masih to approve a separately controlled cache experiment if that claim is required.
Existing September 1/5 cache-admission evidence remains valid within its recorded
limits; it is not replaced by this pilot.

Elapsed time here means performance under the recorded two-lane schedule, not
single-session latency. Provider cache/interference may also induce dependence
between pairs; before using the sample-size table for a main study, validate the
independence assumptions or revise the blocking/analysis and power calculation.
The six-run pilot is descriptive, regardless of favorable results.

### Durable Progress and Recovery

The coordinator keeps a transactional local journal with protocol/config/fixture
hashes, the frozen schedule, attempt IDs, state transitions, process identity,
artifact paths/hashes, reserved budget, and terminal reasons. Only the coordinator
updates this journal. Workers append only to their own attempt directories.

```text
pending -> running -> completed | agent_failed | infrastructure_failed | interrupted
completed -> scored
agent_failed -> scored_failure
```

Terminal attempts are immutable. Retry means a new pair-attempt ID, never editing
or overwriting the original. Finalization is idempotent: after a crash between
writing artifacts and committing state, reconcile checksums and completion markers
before scoring; do not run the model again merely because a report is missing.

- On restart, acquire an exclusive coordinator lock, verify manifest hashes, and
  reconcile recorded process identities. Refuse resume if binary/model/task/settings
  changed; a new version needs a new batch and approval.
- Never launch a duplicate while an old process might still be running. Reattach
  monitoring only when the original process and evidence stream are intact; otherwise
  stop the owned process group and mark it interrupted. Do not resume its conversation.
- Preserve already terminal results. Continue pending pairs; no whole-suite restart.
  Resume a pair's not-yet-started second arm only if the frozen execution/cache
  conditions remain valid; otherwise invalidate that pair attempt explicitly.
- Agent timeout, incorrect answer, exhausted tool budget, and early agent exit are
  scored outcomes, not infrastructure excuses. Runner crash, host loss, auth/quota,
  or transport interruption are separately recorded infrastructure outcomes.
- For an infrastructure-invalid pair, retain both original arms and permit at most
  one fresh replacement pair, after recovery and budget checks. Never combine an
  original arm with a replacement arm. Label the replacement and include original
  resource expenditure in the operational-cost report, outside the paired endpoint.
- Missing final output is never success. Incomplete usage remains unknown, not zero.
  A second infrastructure interruption leaves the pair unresolved for review.
- Reserve worst-case allowed spend for every in-flight attempt before dispatch.
  Retries consume the same approved total budget. Stop admitting work when remaining
  budget cannot cover a reservation; report unknown in-flight charges conservatively.
  If hard caps cannot be enforced for the backend, disclose that before execution.

### Offline Harness Acceptance Checks

Use deterministic stub processes, without provider calls, to show:

1. Two lanes progress concurrently but never exceed two active Elpis processes or
   overlap a task's arms; disabled concurrency produces a sequential schedule.
2. An attempt writes a sentinel into its own state; the other lane and its paired
   arm cannot see it. Deliberately shared state must make the isolation check fail.
3. Kill the coordinator during dispatch, active execution, and result finalization.
   Restart without duplicate processes, overwritten evidence, or rerun scored results.
4. Inject agent failure and infrastructure failure: only the latter gets one clean
   pair retry; a second failure or insufficient budget blocks further dispatch.
5. Inject missing artifacts, usage, and bad hashes; the report must reject completion.
   Show each detector fails when its required condition is deliberately violated.

Then obtain approval for a bounded live preflight verifying the real state roots,
automatic-pruning path, provider accounting, and cache limitations. Offline stubs
alone cannot establish those properties.

## Measurement and Analysis

- Primary: provider input + output tokens summed over every inference call per
  attempt, including pruning. Cached input and reasoning output may be subsets;
  normalize accounting without double-counting and retain raw categories.
- One primary paired t-test on D against zero, two-sided alpha 0.05. Report
  exp(mean(D)), geometric-mean percentage change, and transformed 95% CI. A token
  reduction conclusion requires the ratio CI wholly below 1. Detecting a reduction
  does not establish a reduction of at least 20%.
- Review distribution/dependence assumptions in calibration and freeze the method
  before main. If assumptions fail in main, report that and descriptive evidence;
  do not shop among tests for significance.
- Correctness: all-hidden-tests-pass status, all four paired outcome counts, observed
  pass-rate difference, and exploratory exact McNemar test. Never infer equivalence
  from p > 0.05. Retain individual test outcomes for failure diagnosis.
- Secondary: elapsed/model/pruner time, tool calls, recovery reads, pruning count,
  bytes removed, compactions, cache use, and billed cost when actually available.
  Free quota/subscription access does not mean zero resource cost. Do not invent
  subscription dollar prices or present character estimates as exact token savings.
- Also report total tokens / tasks solved per arm, undefined if none solved.
  Both-solved-only comparisons are descriptive and selection-biased, not primary.
- Publish raw paired points, uncertainty, failures, and all exclusions, including
  negative/inconclusive findings. No blanket no-quality-loss conclusion.

## Kaggle and Local Execution

Kaggle Benchmarks provides model inference access separate from GPU hours. Its CLI
documents proxy credentials, quota inspection, local development, and remote tasks.
Current local proxy tokens are restricted to a curated model subset; remote tasks
can use the broader catalog. Check actual account permissions, catalog, and quota;
documentation example amounts are not an entitlement. See the
[official CLI documentation](https://github.com/Kaggle/kaggle-cli/blob/main/docs/benchmarks.md).

Binary hosting and subsidized inference are separate compatibility questions.
The SDK documents notebook tasks, not guaranteed compatibility with Elpis. Source
inspection found configurable provider base URLs and a Chat Completions wire option;
integration is plausible, not verified. Do not promise drop-in access.

After approval only: check permissions/quota; run the matched Linux binary in a task
notebook; exercise one harmless tool call and one pruning pass; verify streaming,
tool protocol, usage, audits, and task-result capture. If a bridge is needed, get
approval for that scope. A Kaggle SDK wrapper would be Python in a separate benchmark
workspace, not added to this Rust repository. Binary/fixture uploads need approval.

A terminal agent can automate CLI runs; a browser agent can operate notebook UI.
Neither grants API access or should solve the benchmark tasks. Prefer terminal
orchestration. Local Luna needs no Kaggle installation, but exact model IDs, pruning
backend, and account limits still need verification. Do not mix models mid-study.

## Evidence and Approval

Retain protocol version, source/binary/fixture hashes, secret-free settings, random
schedule, permitted raw inference/tool transcripts, provider usage, pruning audits,
final diffs, hidden-grader logs, timing, and paired machine-readable results.

Masih's gates: accept/revise the primary claim, 20% planning alternative, and task
families; choose local Luna or authorize Kaggle feasibility; approve executable
fixtures and a capped calibration batch; then approve fixed main N and cost.
No experiments, binaries installed, Rust builds, or uploads happened for this draft.

## Sources

- [NIST: sample-size dependencies](https://www.itl.nist.gov/div898/handbook/prc/section2/prc222.htm)
- [NIST: paired observations](https://www.itl.nist.gov/div898/handbook/prc/section3/prc311.htm)
- [statsmodels: paired-test power](https://www.statsmodels.org/stable/generated/statsmodels.stats.power.TTestPower.html)
- [SciPy: noncentral t calculation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.nct.html)
- [SciPy: exact binomial intervals](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats._result_classes.BinomTestResult.proportion_ci.html)
- [Kaggle Benchmarks SDK](https://github.com/Kaggle/kaggle-benchmarks)
- [Kaggle local-development announcement](https://blog.google/innovation-and-ai/technology/developers-tools/build-kaggle--benchmarks-locally/)

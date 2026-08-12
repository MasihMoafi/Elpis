# RQ2 Final Protocol: Information Retention & Data Loss Under Pruning

## Research Question
Does Elpis's context pruning mechanism retain task-critical information (constraints, facts, prior tool outputs) without semantic data loss across multi-step execution sessions?

## Hypothesis
Elpis retains key task constraints and facts in distilled memory/summary structures while reducing token footprint, outperforming or matching unpruned context continuity in targeted recall tests.

## Independent & Dependent Variables
- **Independent Variables**:
  - Context Management Strategy: Elpis Context Pruning vs. Unpruned/Baseline Context
  - Session Length / Horizon: 5-step, 10-step, 20-step synthetic multi-turn turns
- **Dependent Variables**:
  - Fact Recall Accuracy (% of embedded needle facts correctly retrieved/used)
  - Constraint Adherence Rate (% of turn instructions strictly obeying early-turn constraints)
  - Token Footprint (total prompt tokens sent per step)

## Exact Comparison
Paired evaluation between Elpis (with pruning enabled at standard threshold) and Baseline Codex/Elpis (unpruned) on identical multi-step synthetic turn series containing embedded needle facts and constraints.

## Number of Runs & Tasks
- **Tasks**: 10 synthetic multi-turn probe tasks (5 short, 5 long horizon).
- **Runs per Task**: 3 independent runs per configuration (Total: 60 runs).

## Model
`gemini-2.5-pro` (or active default designated model, locked across all paired runs).

## Frozen Binary & Source
- **Commit**: `0b832c3ef77ed29a658b694e73a0cd356a6fe99a`
- **Binary Hash**: `782fd9859e1dd69aa5fb7074bfebf4dbd0e319574412cdc742926816a19ee0a1`

## Stopping Rules
1. Halt immediately if any agent process panics, crashes, or returns HTTP 429/5xx rate limits repeatedly (>3 retries).
2. Halt if unhandled exception causes turn skipping.

## Success Criteria
- Elpis achieves ≥ 95% constraint retention matching or exceeding baseline while demonstrating measurable token reduction (≥ 20% average prompt token reduction in steps post-prune).

## Failure Criteria
- Severe key information loss (e.g., pruning eliminates an explicitly stated constraint leading to violation in > 10% of runs).
- Silent failure where pruned summary omits critical variables.

## Required Evidence to Save
- Full JSONL transcripts (`transcript_full.jsonl`) for every run.
- Exact raw prompt payload at each step (before and after pruning).
- Per-step token accounting logs.
- Evaluation scorecards detailing fact/constraint verification results per run.

## Analysis Method
- Automated exact-match & semantic evaluation of agent responses against ground-truth needle facts.
- Statistical paired t-test / Wilcoxon signed-rank test comparing recall accuracy and token usage.

## Supported vs. Unsupported Claims
- **Claims Supported**:
  - Quantifiable retention rate of explicit facts and constraints post-pruning.
  - Token savings directly attributable to context distillation without critical data loss on probe tasks.
- **Claims CANNOT Support**:
  - Generalization to arbitrarily long 100+ turn conversational sessions outside the tested probe range.
  - Zero-information-loss guarantee for implicit or non-symbolic task context.

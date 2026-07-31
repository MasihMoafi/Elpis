# Session Continuity, Goal Drift, and Cost-Effectiveness Experiment

Following the canonical `experiment-workflow` skill framework (`file:///home/masih/Desktop/p/skills/experiment-workflow/SKILL.md`).

## A. Objectives (The Questions We Want Answers To)

This experiment evaluates Elpis's multi-turn session continuity against baseline Codex across compactions and selective pruning:
1. **Goal Drift:** Does the agent maintain its original system prompt, project constraints, and user objectives without hallucinating or dropping rules after context pruning/compaction?
2. **Task Completion:** Does the agent successfully implement complex multi-turn coding tasks with clean passing unit tests?
3. **Cost & Token Efficiency:** For runs where both systems achieve 100% task success, which system is more cost-effective (total input/output tokens and model invocation costs)?

## B. The Source Material

- **Target Repository:** `file:///home/masih/Desktop/p/Elpis` (or standard benchmark coding repository).
- **Environment & Models:**
  - Elpis version: `main` (commit pinned in run manifest).
  - Context Prune Model: `gpt-5.6-luna` with High reasoning effort (`ReasoningEffort::High`).
  - Auto-routing & turn model: Provider-aware models (Sol / Terra / Luna).
  - Benchmark harness: 5-turn sequential multi-step engineering tasks.

## C. The Queries & Scenarios (3x10 Protocol)

### 10 Goal-Drift & Constraint-Retention Scenarios
Evaluates whether system instructions and explicit constraints persist across context pruning:
1. Preserve explicit formatting rules specified in Turn 1 after Turn 3 pruning.
2. Maintain negative constraints ("do not modify public API signature") across 5 turns.
3. Retain project architectural scope without drifting to unrequested refactors.
4. Recall user preferences set in initial turn after selective tool-output distillation.
5. Preserve file-path boundaries and sandbox restrictions across pruning boundaries.
6. Remember active goal status without re-executing completed work.
7. Maintain environment variable definitions introduced in early turns.
8. Avoid inventing non-existent APIs when context history is distilled.
9. Sustain multi-step plan objectives across automatic 30% pressure pruning.
10. Verify negative assertions (absent-fact checks) to prevent hallucinated continuity.

### 10 Task-Completion & Correctness Scenarios
Evaluates functional execution under real context pressure:
1. Implement localized feature refactor while preserving full test suite passing.
2. Debug and fix a complex multi-file async race condition across 3 turns.
3. Add unit test suite to untested module without modifying underlying logic.
4. Execute multi-step dependency migration with verified compilation at each step.
5. Implement protocol schema extension and update corresponding handlers.
6. Resolve memory/resource leak identified in diagnostic stack traces.
7. Refactor error handling logic to preserve error propagation contracts.
8. Update command registry and tool declarations across multiple system modules.
9. Implement selective data filtering logic matching quantitative rules.
10. Complete end-to-end integration test suite setup.

### 10 Cost & Token-Efficiency Scenarios
Evaluates resource consumption and model call costs:
1. Single-session 5-turn feature build: total prompt and output token count.
2. Tool-heavy exploration (large terminal output): raw vs. distilled token ratio.
3. Multi-turn debugging session: total LLM context window pressure growth rate.
4. High-frequency inspection turns: cost comparison of Luna High Ace pass vs full compaction.
5. Large workspace code search: context tokens reclaimed by selective Ace distillation.
6. 10-turn continuous refactor: cumulative API billing cost per completed subtask.
7. Multi-file editing session: comparison of active context tokens remaining.
8. Long-running diagnostic session: tokens saved by RTK shell output compression.
9. Automated pressure pruning vs manual `/prune`: token reclamation efficiency.
10. Overall session cost per successful task completion benchmarked against Codex.

## D. Execution & Raw Metrics Logging

Each run logs raw execution metadata into `results.tsv` and unedited conversation transcripts:
- `timestamp`, `setup_id`, `turn_index`, `active_context_tokens`, `uncovered_tool_tokens`, `prune_passes`, `saved_chars`, `task_success`, `goal_drift_flag`, `total_prompt_tokens`, `total_completion_tokens`, `estimated_cost_usd`.

## E. Evaluation & Tuning Directives

Results are scored deterministically:
1. **Goal Drift Rate:** Percentage of turns maintaining 100% constraint compliance.
2. **Success Rate:** Percentage of test suites passing cleanly after 5 turns.
3. **Cost-per-Success Ratio:** `Total Tokens / Task Success Count`.

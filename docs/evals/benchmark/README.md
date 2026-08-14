# Elpis Automated Evaluation Suite & Benchmark Runner

A comprehensive, reproducible benchmark suite for measuring context efficiency, prompt-cache persistence, AST refactoring correctness under context pressure, and tool filtering efficiency.

---

## 1. Directory Overview

```text
docs/evals/
├── tasks/
│   ├── task1_ast_refactor/              # Task 1: Multi-file AST refactoring under context pressure
│   │   ├── README.md                    # Specification & scoring gates
│   │   ├── instructions.md              # Deterministic prompt for agents
│   │   ├── fixture/                     # Baseline AST engine (pre-refactor)
│   │   ├── ground_truth/                # Reference refactored AST engine
│   │   └── verify.py                    # 24-check automated unit/semantic test harness
│   ├── task2_cache_persistence/         # Task 2: Multi-turn prompt-cache persistence test
│   │   ├── README.md                    # Cache breakpoint & epoch rules
│   │   ├── scenario.json                # 8-turn conversation scenario & threshold bounds
│   │   └── verify_cache.py              # Cache hit rate & epoch marker trajectory verifier
│   └── task3_agent_grep_efficiency/     # Task 3: Agent-Grep vs Ripgrep context efficiency
│       ├── README.md                    # Protocol & SNR measurement formulas
│       ├── fixtures/                    # Test corpus with src, lockfiles, noise files
│       ├── queries.json                 # 10 benchmark search queries with ground truth
│       └── score_efficiency.py          # Context Reduction Factor (CRF) and Recall scorer
└── benchmark/
    ├── README.md                        # This document
    ├── run_benchmark.py                 # Master benchmark orchestrator
    ├── score_context.py                 # Context token & prompt-cache statistical analyzer
    ├── generate_sample_traces.py        # Canonical sample trace generator
    └── sample_traces/                   # Canonical rollout traces for self-tests and CI
        ├── task1_elpis_trace.jsonl
        ├── task1_codex_trace.jsonl
        ├── task2_cache_persistence_trace.jsonl
        └── task3_agent_grep_trace.jsonl
```

---

## 2. Quickstart & Benchmark Commands

### Run Full Benchmark Suite (Self-Test Mode)

```bash
python3 docs/evals/benchmark/run_benchmark.py --self-test
```

### Output Formats

Generate Markdown scorecard report:
```bash
python3 docs/evals/benchmark/run_benchmark.py --self-test --markdown
```

Generate JSON payload:
```bash
python3 docs/evals/benchmark/run_benchmark.py --self-test --json
```

---

## 3. Individual Task Verification

### Task 1: Multi-File AST Refactoring
Verifies parsing, type checking, constant-folding optimization, evaluation, and formatting of Ternary expressions (`IfExp`), Pattern Matching (`MatchStmt`), and source spans (`Span`):

```bash
python3 docs/evals/tasks/task1_ast_refactor/verify.py --dir docs/evals/tasks/task1_ast_refactor/ground_truth
```

### Task 2: Multi-Turn Prompt-Cache Persistence
Verifies prompt-cache hit rate trajectory, stable prefix preservation, and epoch marker breakpoints:

```bash
python3 docs/evals/tasks/task2_cache_persistence/verify_cache.py \
  --rollout docs/evals/benchmark/sample_traces/task2_cache_persistence_trace.jsonl
```

### Task 3: Agent-Grep Context Efficiency
Evaluates Context Reduction Factor ($CRF$) and Information Retrieval Recall across 10 standardized query categories against noisy codebases:

```bash
python3 docs/evals/tasks/task3_agent_grep_efficiency/score_efficiency.py
```

---

## 4. Context & Cache Scoring (`score_context.py`)

### Single Rollout Analysis
```bash
python3 docs/evals/benchmark/score_context.py --rollout path/to/rollout.jsonl --system elpis
```

### Paired Comparison (Elpis vs Codex)
```bash
python3 docs/evals/benchmark/score_context.py --compare path/to/elpis_rollout.jsonl path/to/codex_rollout.jsonl
```

Calculates:
- **Peak Context Tokens ($C_{\text{peak}}$):** Maximum total context tokens in the model window.
- **Median Context Tokens & Remaining Context (%):** Median window occupancy throughout the run.
- **Context Spread ($\sigma$):** Standard deviation of context window remaining percentage.
- **Time Under Pressure:** Share of the run where context remaining is $<65\%$.
- **Prompt Cache Hit Rate ($H$):** Percentage of input tokens served from cache: $H = \frac{T_{\text{cached}}}{T_{\text{in}}} \times 100\%$.
- **Context Reduction Factor ($CRF$):** Percentage reduction in peak and median context tokens over unmanaged baselines.

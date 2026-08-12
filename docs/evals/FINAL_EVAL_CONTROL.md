# Final Elpis Paper Evaluation Control Document

## 1. Frozen Implementation

- **Repository Absolute Path**: `/home/masih/Desktop/p/Elpis`
- **Branch**: `main`
- **Frozen Commit (FROZEN_EVAL_COMMIT)**: `0b832c3ef77ed29a658b694e73a0cd356a6fe99a`
- **Installed Binary Hash (SHA256)**: `782fd9859e1dd69aa5fb7074bfebf4dbd0e319574412cdc742926816a19ee0a1` (`/home/masih/.local/bin/elpis`)
- **Date**: `2026-08-11`

> **Mandatory Policy Directive**:
> No behavioral Elpis changes are permitted during final evaluation unless a reproducible correctness bug blocks execution.

---

## 2. Completed Work

### RQ1: Token / Cost Efficiency
- **Status**: COMPLETE
- **Evidence Location**:
  - `docs/evals/archive/rq14-pilot-2026-08-09/`
  - `/home/masih/Desktop/p/final-rq1-rq4-data`
  - `/home/masih/Desktop/p/rq1_rq4_analysis_bundle`
- **Directive**: Evidence is final and frozen. Do not reinterpret or rerun RQ1 evaluations.

### RQ4: Prompt Cache Interaction & Cost Dynamics
- **Status**: COMPLETE
- **Finding**: Measured tradeoff / negative result documented.
- **Evidence Location**: `/home/masih/Desktop/p/elpis-rq4-final-forensics.zip`
- **Directive**: No further RQ4 experiments.

---

## 3. Remaining Work

### RQ2: Information Retention & Data Loss
- **Focus**: Data loss / Information retention under context pruning.
- **Worktree Path**: `/home/masih/Desktop/p/elpis-rq2-final` (`eval/rq2-final`)
- **Status**: NOT STARTED
- **Rules**: No code modifications allowed.

### RQ3: Task Correctness
- **Focus**: Task completion correctness across long-horizon workloads.
- **Worktree Path**: `/home/masih/Desktop/p/elpis-rq3-final` (`eval/rq3-final`)
- **Status**: NOT STARTED
- **Rules**: No code modifications allowed.

### RQ5: Auditability & Provenance
- **Focus**: Auditability, provenance tracking, and inspection metrics.
- **Worktree Path**: `/home/masih/Desktop/p/elpis-rq5-final` (`eval/rq5-final`)
- **Status**: EVIDENCE CONSOLIDATION ONLY
- **Rules**: No new expensive experiments unless existing evidence proves insufficient.

---

## 4. Hard Experiment Rules

1. Each RQ uses its own worktree.
2. No agent may modify Elpis behavior during an evaluation.
3. Every experiment must record source commit + binary hash + session ID.
4. No benchmark starts until its protocol has been independently reviewed.
5. Failed runs are preserved, never silently rerun.
6. Experimental prompts must be frozen before execution.
7. Elpis and Codex paired runs must use identical task/prompt/model/environment where applicable.
8. No result is added to the paper until raw evidence has been audited.
9. RQ1 and RQ4 are frozen and must not be reopened without explicit instruction.
10. If an agent finds a possible bug, STOP and report it instead of fixing it.

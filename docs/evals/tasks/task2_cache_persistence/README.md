# Task 2: Historical Retrospective-Pruning Cache Test

> **Legacy protocol.** This fixture evaluates the former 30% pressure cycle and epoch
> markers. It does not evaluate current Smart Prune admission-time behavior and cannot
> close current RQ4. Use `../smart_prune_cache_validation/README.md` for the current
> matched OFF/ON protocol.

## 1. Objective

Evaluate prompt-cache behavior for the former retrospective pruning architecture versus
unmanaged or naive-compaction baselines.

The benchmark measures:
1. **Cache Hit Rate Trajectory ($H_t = \frac{\text{cached\_tokens}_t}{\text{input\_tokens}_t}$):** Cache hit rate evolution across 8 sequential conversational turns.
2. **Stable Prefix Retention:** Preservation of developer instructions, tool definitions, and workspace rules (>1,024 tokens) across all turns.
3. **Epoch Marker Resilience:** When context pruning occurs (triggered at 30% window utilization), whether the sealed epoch marker (`[elpis.context-prune.epoch N]`) acts as a secondary cache breakpoint, preventing cache collapse back to the initial prefix.
4. **Cache Miss Classification:** Automated identification and auditing of `ColdStart`, `PrefixInvalidated`, `BelowTokenThreshold`, and `TtlExpired` events.

---

## 2. Benchmark Scenario & Protocol

The test executes an 8-turn interactive development workflow:

```text
Turn 1 [Ingestion]        -> Project architecture analysis & initial tool exploration (~18k tokens, Cold Start)
Turn 2 [Query 1]          -> Specific symbol query (Verifying Stable Prefix Cache Hit > 90%)
Turn 3 [Deep Dive]        -> Method inspection & tool output expansion (Incremental append cache hit)
Turn 4 [Pressure Burst]   -> Heavy search & log inspection triggering 30% context threshold (~85k tokens)
Turn 5 [Post-Prune 1]     -> Follow-up question after Ace Prune Cycle 1 (Verifying Epoch 1 Cache Breakpoint)
Turn 6 [Refactor Step]    -> Code modification and test execution (Cache hit on Epoch 1 prefix)
Turn 7 [Post-Prune 2]     -> Second pruning cycle trigger (Verifying Epoch 2 Marker & Hysteresis Cooling)
Turn 8 [Final Check]      -> End-of-session verification query (High terminal cache hit rate > 75%)
```

### Prompt-Cache Invariants Evaluated:

- **Invariant 1 (Initial Breakpoint):** Request 1 writes initial prefix (>1,024 tokens); Request 2+ reads this prefix with 0 fresh input tokens for the shared prefix.
- **Invariant 2 (Epoch Breakpoint):** When pruning pass $N$ rewrites history, an epoch marker `[elpis.context-prune.epoch N]` is inserted. Turn $N+1$ falls back to this epoch boundary rather than falling all the way back to the turn 1 baseline.
- **Invariant 3 (Hysteresis Gating):** Context pruner does not fire repeatedly in the 20%–30% band. No rapid prefix invalidations ("nibbling").
- **Invariant 4 (Session Key Isolation):** Background pruning and memory calls use `<session-id>:context-prune` namespace, preventing slot eviction in the main conversation loop.

---

## 3. Verification & Metrics

Run the automated cache persistence validator on any rollout transcript:

```bash
python3 docs/evals/tasks/task2_cache_persistence/verify_cache.py --rollout <path_to_rollout.jsonl>
```

### Acceptance Criteria:
- **`Overall Cache Hit Rate`:** $\ge 65.0\%$ across the entire multi-turn session.
- **`Turn 2+ Hit Rate`:** $\ge 80.0\%$ for append-only turns.
- **`Post-Prune Floor`:** Post-prune turns must retain $\ge 40\%$ cached tokens (falling back to sealed epoch boundary rather than $0$).
- **`Invalidation Count`:** No more than 1 prefix invalidation per pressure cycle.

### Output Report:
Outputs JSON and tabular reports containing:
- Per-turn input, cached, output, and hit rate %
- Detected epoch markers and trigger events
- Identified cache misses and classification
- Overall session score and Pass/Fail status

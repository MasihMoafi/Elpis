# Task 3: Agent-Grep vs Standard Ripgrep Context Efficiency Scorer

## 1. Objective

Quantify and evaluate the context efficiency gains of **Agent-Grep** (RTK shell filter, AST-aware symbol extraction, and compact evidence pointers) versus **Standard Ripgrep** (`rg` dumping raw lines and context into the agent's context window).

The benchmark measures:
1. **Context Reduction Factor ($CRF$):**
   $$\text{CRF} = 1 - \frac{\text{Context Tokens (Agent-Grep)}}{\text{Context Tokens (Standard Ripgrep)}}$$
2. **Information Retrieval Recall ($R$):**
   $$R = \frac{|\text{Retrieved Ground Truth Targets}|}{|\text{Total Ground Truth Targets}|} = 100\%$$
   Ensures that compact filtering does not drop critical matching locations or line references.
3. **Signal-to-Noise Ratio ($SNR$):**
   $$\text{SNR} = \frac{\text{Ground Truth Match Bytes}}{\text{Total Emitted Context Bytes}}$$
4. **Token Savings ($S$):** Total token reduction across the search workload.

---

## 2. Workload & Test Corpus

The test corpus in `fixtures/` models a realistic software repository containing:
- **Core Source Files (`src/`):** Real Rust and TypeScript modules defining structs, traits, async functions, error types, and state management.
- **Distractor & Noise Files:** Large generated dependency lockfiles (`Cargo.lock`, `package-lock.json`), build logs, minified asset bundles, and vendor code.
- **Homonyms & Comments:** False-positive test mocks and doc comments containing search terms.

### 10 Standardized Evaluation Queries (`queries.json`):

| ID | Query Type | Pattern | Description | Selectivity |
|---|---|---|---|---|
| `Q01` | Exact Symbol Definition | `pub struct ContextPruner` | Primary struct declaration | High (1 match) |
| `Q02` | Common Keyword | `Result<` | Pervasive error-handling idiom | Low (50+ matches in lockfiles & src) |
| `Q03` | Cross-Module Reference | `ContextLedger::record` | Specific method call site across modules | Moderate (4 matches) |
| `Q04` | Trait Implementation | `impl PromptCache for` | Trait implementations | Moderate (3 matches) |
| `Q05` | Async Function Regex | `pub\s+async\s+fn\s+\w+_prune` | Dynamic function signature regex | High (2 matches) |
| `Q06` | Config Option | `explicit_prompt_cache` | Boolean configuration parameter | Moderate (6 matches) |
| `Q07` | Marker Constant | `[elpis.context-prune.epoch` | Epoch boundary string constant | High (3 matches) |
| `Q08` | Error Variant | `ContextOverflow` | Specific enum error variant | High (2 matches) |
| `Q09` | Broad Pattern | `fn test_` | All test functions in workspace | Low (35+ matches) |
| `Q10` | Chained Method | `.context_pruner.run_cycle` | Deep chained call invocations | Moderate (4 matches) |

---

## 3. Scorer Execution & Metrics

Run the efficiency scorer:

```bash
python3 docs/evals/tasks/task3_agent_grep_efficiency/score_efficiency.py
```

### Evaluation Criteria:
- **`Recall Gate`:** $100\%$ recall on all 10 queries (0 lost ground-truth references).
- **`Context Reduction Gate`:** Mean $CRF \ge 60\%$ across the full query workload ($>75\%$ on low-selectivity queries like `Result<` and `fn test_`).
- **`SNR Improvement`:** $\ge 3.0\times$ signal-to-noise improvement over standard ripgrep.

# Task 1: Multi-File AST Refactoring Under Heavy Context Pressure

## 1. Objective

Evaluate an agent's ability to execute a coordinated, semantic refactoring across multiple interdependent AST (Abstract Syntax Tree) modules while operating under heavy context pressure (60,000–180,000+ context tokens).

The benchmark measures:
1. **Semantic Correctness:** Whether the refactored AST engine parses, optimizes, type-checks, evaluates, and pretty-prints new language constructs correctly without breaking existing invariants.
2. **Context Stability:** Whether the agent maintains coherent state, symbol references, and API signatures across files without hallucination or regression as context grows and pruning / compaction cycles occur.
3. **Efficiency:** Peak context tokens, median context occupancy, and prompt cache hit rate throughout the refactoring workflow.

---

## 2. Benchmark Scenario & Architecture

The target codebase is an expression and statement AST engine with 6 core modules:

```text
fixture/
├── ast_nodes.py      # Core AST node definitions (Expr, Stmt, Literal, BinaryOp, etc.)
├── parser.py         # Recursive-descent Pratt parser generating AST
├── type_checker.py   # Type inference, environment checking, and type validation
├── optimizer.py      # Constant folding, algebraic simplification, dead-code elimination
├── evaluator.py      # Tree-walking runtime interpreter with environment scopes
├── formatter.py      # Code pretty-printer reconstructing source from AST
└── test_suite.py     # Unit and regression test suite
```

### Refactoring Requirements

The agent is tasked with upgrading the language from primitive scalar operations to support:
1. **Ternary Expressions (`IfExp`):** Syntax `cond ? then_val : else_val`.
   - Node: `IfExp(test: Expr, consequent: Expr, alternate: Expr, span: Optional[Span])`
   - Parser: Right-associative ternary operator parsing with precedence between assignment and logical-OR.
   - Type Checker: Infers unified return type of `then_val` and `else_val`; validates `test` is boolean.
   - Optimizer: Constant-folds when `test` is known literal boolean (`true ? a : b -> a`, `false ? a : b -> b`).
   - Evaluator: Lazily evaluates only the branch determined by `test`.
   - Formatter: Pretty-prints `cond ? then_expr : else_expr`.
2. **Pattern Matching Statements (`MatchStmt` & `MatchCase`):** Syntax `match <expr> { case <pattern> => <stmt> }`.
   - Nodes: `MatchStmt(subject: Expr, cases: List[MatchCase], span: Optional[Span])`, `MatchCase(pattern: Pattern, body: Stmt, guard: Optional[Expr])`, `LiteralPattern`, `VariablePattern`, `WildcardPattern`.
   - Parser: Parses match blocks with pattern matching and optional guards `if <guard>`.
   - Type Checker: Checks exhaustiveness of literals / wildcards and type compatibility of subject.
   - Evaluator: Evaluates patterns, binds matched variables in local scope, and executes matched case body.
   - Formatter: Formats match blocks with standard indentation.
3. **AST Source Spans (`Span`):**
   - Node: `Span(start_line: int, start_col: int, end_line: int, end_col: int)`.
   - Every AST node must carry an optional `span` field.
   - Parser must attach accurate token spans to all constructed nodes.
   - Optimizer must preserve source spans when transforming nodes.

---

## 3. Context Pressure Dynamics

The task is designed to induce context pressure in three ways:
1. **Multi-File Breadth:** 6 interdependent files must be inspected and edited in sync. Partial edits break type checking or evaluation.
2. **Verbose Test Output:** The test suite generates detailed AST dump traces and error diffs when partial implementations are tested.
3. **Multi-Step Execution:** Requires iterative cycles of code edits, test runs, linting, and formatting.

This workload was used in the historical high-frequency retrospective-pruning evaluation.
Those configured Elpis runs held median context near 27% of the window; they did not prove
prompt-cache preservation or describe the current default. Current automatic optimization
is Smart Prune admission-time processing, evaluated under a separate protocol.

---

## 4. Verification & Scoring

Run the automated verification harness:

```bash
python3 docs/evals/tasks/task1_ast_refactor/verify.py
```

### Verification Checks:
- **`Syntax & Import Integrity`:** All 6 modules load and type-check cleanly.
- **`Ternary Expression Suite`:** Parsing, typing, optimization, evaluation, and formatting of `IfExp`.
- **`Pattern Match Suite`:** Literal, variable, wildcard, and guarded pattern matching.
- **`Span Preservation`:** Accurate span propagation from parser through optimizer.
- **`Regression Suite`:** Zero regressions on existing arithmetic, control-flow, and function tests.

### Metrics Recorded:
- Task Completion: `Pass` / `Fail` (Binary acceptance)
- Test Pass Rate: $X / 24$ tests passed
- Peak Context Tokens
- Median Context Tokens
- Prompt Cache Hit Rate (%)

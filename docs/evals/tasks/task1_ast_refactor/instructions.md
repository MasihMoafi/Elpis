# Task Prompt: Multi-File AST Refactoring

You are tasked with refactoring the core AST engine in the workspace to support ternary conditional expressions (`IfExp`), pattern matching statements (`MatchStmt`), and AST source spans (`Span`).

## Target Files:
- `ast_nodes.py`: AST data classes and hierarchy
- `parser.py`: Recursive-descent Pratt parser
- `type_checker.py`: Static type checker and inference engine
- `optimizer.py`: AST optimizer and constant folder
- `evaluator.py`: Tree-walking interpreter
- `formatter.py`: Source code pretty-printer
- `test_suite.py`: Test suite and validation runner

## Specification Requirements:

1. **AST Node Definitions (`ast_nodes.py`)**:
   - Add `Span(start_line: int, start_col: int, end_line: int, end_col: int)` dataclass.
   - Ensure all `Node`, `Expr`, `Stmt` subclasses accept an optional `span: Optional[Span] = None`.
   - Implement `IfExp(test: Expr, consequent: Expr, alternate: Expr, span: Optional[Span] = None)` inheriting from `Expr`.
   - Implement Pattern classes: `Pattern`, `LiteralPattern(value: Any)`, `VariablePattern(name: str)`, `WildcardPattern()`.
   - Implement `MatchCase(pattern: Pattern, body: Stmt, guard: Optional[Expr] = None)` and `MatchStmt(subject: Expr, cases: List[MatchCase], span: Optional[Span] = None)` inheriting from `Stmt`.

2. **Parser (`parser.py`)**:
   - Add support for ternary operator `<test> ? <consequent> : <alternate>`. Precedence should be between logical OR and assignment.
   - Add support for `match <subject> { case <pattern> [if <guard>] => <stmt>; ... }`.
   - Propagate source token `Span` onto every parsed AST node.

3. **Type Checker (`type_checker.py`)**:
   - For `IfExp`: Verify `test` evaluates to boolean (`Type.BOOL`). Verify `consequent` and `alternate` unify to a common type.
   - For `MatchStmt`: Verify `subject` type matches pattern types. Ensure pattern exhaustiveness (wildcard or variable pattern covers all cases).
   - Report type errors with accurate node `Span` coordinates.

4. **Optimizer (`optimizer.py`)**:
   - Constant fold `IfExp`: When `test` is a `Literal(True)`, replace with optimized `consequent`. When `Literal(False)`, replace with optimized `alternate`.
   - Eliminate dead code in `MatchStmt`: Drop cases following an unguarded wildcard or variable pattern.
   - Preserve original `span` metadata on transformed nodes.

5. **Evaluator (`evaluator.py`)**:
   - Evaluate `IfExp`: Lazily evaluate `consequent` if `test` is truthy, else `alternate`.
   - Evaluate `MatchStmt`: Match `subject` against cases in order. If a case matches (and guard evaluates truthy), bind any variable in pattern to local scope and execute `body`.

6. **Formatter (`formatter.py`)**:
   - Format `IfExp` as `f"{format(node.test)} ? {format(node.consequent)} : {format(node.alternate)}"`.
   - Format `MatchStmt` with structured indentation for each `case <pattern> [if <guard>] => <stmt>`.

7. **Verification**:
   - Run `python3 verify.py` to ensure all tests pass with zero regressions.

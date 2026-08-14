"""AST Optimizer with IfExp constant folding, match dead code elimination, and span preservation."""
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, IfExp,
    MatchStmt, MatchCase, Pattern, LiteralPattern, VariablePattern, WildcardPattern,
    Span
)

class Optimizer:
    def optimize(self, node: Node) -> Node:
        if node is None:
            return None
        method_name = f"optimize_{node.__class__.__name__}"
        visitor = getattr(self, method_name, self.generic_optimize)
        return visitor(node)

    def generic_optimize(self, node: Node) -> Node:
        return node

    def optimize_Program(self, node: Program) -> Program:
        new_stmts = [self.optimize(s) for s in node.statements]
        return Program(statements=[s for s in new_stmts if s is not None], span=node.span)

    def optimize_BinaryOp(self, node: BinaryOp) -> Expr:
        left = self.optimize(node.left)
        right = self.optimize(node.right)
        if isinstance(left, Literal) and isinstance(right, Literal):
            lv = left.value
            rv = right.value
            try:
                if node.op == '+': return Literal(value=lv + rv, span=node.span)
                elif node.op == '-': return Literal(value=lv - rv, span=node.span)
                elif node.op == '*': return Literal(value=lv * rv, span=node.span)
                elif node.op == '/' and rv != 0: return Literal(value=lv / rv, span=node.span)
                elif node.op == '==': return Literal(value=(lv == rv), span=node.span)
                elif node.op == '!=': return Literal(value=(lv != rv), span=node.span)
                elif node.op == '<': return Literal(value=(lv < rv), span=node.span)
                elif node.op == '>': return Literal(value=(lv > rv), span=node.span)
                elif node.op == '<=': return Literal(value=(lv <= rv), span=node.span)
                elif node.op == '>=': return Literal(value=(lv >= rv), span=node.span)
            except Exception:
                pass
        return BinaryOp(op=node.op, left=left, right=right, span=node.span)

    def optimize_UnaryOp(self, node: UnaryOp) -> Expr:
        operand = self.optimize(node.operand)
        if isinstance(operand, Literal):
            if node.op == '-':
                return Literal(value=-operand.value, span=node.span)
            elif node.op in ('not', '!'):
                return Literal(value=not operand.value, span=node.span)
        return UnaryOp(op=node.op, operand=operand, span=node.span)

    def optimize_IfExp(self, node: IfExp) -> Expr:
        test = self.optimize(node.test)
        consequent = self.optimize(node.consequent)
        alternate = self.optimize(node.alternate)
        if isinstance(test, Literal) and isinstance(test.value, bool):
            if test.value:
                consequent.span = node.span
                return consequent
            else:
                alternate.span = node.span
                return alternate
        return IfExp(test=test, consequent=consequent, alternate=alternate, span=node.span)

    def optimize_BlockStmt(self, node: BlockStmt) -> BlockStmt:
        return BlockStmt(statements=[self.optimize(s) for s in node.statements], span=node.span)

    def optimize_IfStmt(self, node: IfStmt) -> Stmt:
        cond = self.optimize(node.condition)
        then_b = self.optimize(node.then_branch)
        else_b = self.optimize(node.else_branch) if node.else_branch else None
        if isinstance(cond, Literal) and isinstance(cond.value, bool):
            if cond.value:
                return then_b
            else:
                return else_b if else_b else BlockStmt(statements=[], span=node.span)
        return IfStmt(condition=cond, then_branch=then_b, else_branch=else_b, span=node.span)

    def optimize_MatchStmt(self, node: MatchStmt) -> MatchStmt:
        subject = self.optimize(node.subject)
        optimized_cases = []
        for case in node.cases:
            body = self.optimize(case.body)
            guard = self.optimize(case.guard) if case.guard else None
            opt_case = MatchCase(pattern=case.pattern, body=body, guard=guard, span=case.span)
            optimized_cases.append(opt_case)
            # Dead code elimination after unconditional catch-all
            if isinstance(case.pattern, (WildcardPattern, VariablePattern)) and guard is None:
                break
        return MatchStmt(subject=subject, cases=optimized_cases, span=node.span)

    def optimize_VarDecl(self, node: VarDecl) -> VarDecl:
        init = self.optimize(node.init) if node.init else None
        return VarDecl(name=node.name, var_type=node.var_type, init=init, span=node.span)

    def optimize_AssignStmt(self, node: AssignStmt) -> AssignStmt:
        return AssignStmt(name=node.name, value=self.optimize(node.value), span=node.span)

    def optimize_ReturnStmt(self, node: ReturnStmt) -> ReturnStmt:
        val = self.optimize(node.value) if node.value else None
        return ReturnStmt(value=val, span=node.span)

"""AST Optimizer for constant folding and dead code elimination (Initial Baseline)."""
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr
)

class Optimizer:
    def optimize(self, node: Node) -> Node:
        method_name = f"optimize_{node.__class__.__name__}"
        visitor = getattr(self, method_name, self.generic_optimize)
        return visitor(node)

    def generic_optimize(self, node: Node) -> Node:
        return node

    def optimize_Program(self, node: Program) -> Program:
        new_stmts = [self.optimize(s) for s in node.statements]
        return Program(statements=[s for s in new_stmts if s is not None])

    def optimize_BinaryOp(self, node: BinaryOp) -> Expr:
        left = self.optimize(node.left)
        right = self.optimize(node.right)
        if isinstance(left, Literal) and isinstance(right, Literal):
            lv = left.value
            rv = right.value
            try:
                if node.op == '+': return Literal(value=lv + rv)
                elif node.op == '-': return Literal(value=lv - rv)
                elif node.op == '*': return Literal(value=lv * rv)
                elif node.op == '/' and rv != 0: return Literal(value=lv / rv)
                elif node.op == '==': return Literal(value=(lv == rv))
                elif node.op == '!=': return Literal(value=(lv != rv))
                elif node.op == '<': return Literal(value=(lv < rv))
                elif node.op == '>': return Literal(value=(lv > rv))
                elif node.op == '<=': return Literal(value=(lv <= rv))
                elif node.op == '>=': return Literal(value=(lv >= rv))
            except Exception:
                pass
        return BinaryOp(op=node.op, left=left, right=right)

    def optimize_UnaryOp(self, node: UnaryOp) -> Expr:
        operand = self.optimize(node.operand)
        if isinstance(operand, Literal):
            if node.op == '-':
                return Literal(value=-operand.value)
        return UnaryOp(op=node.op, operand=operand)

    def optimize_BlockStmt(self, node: BlockStmt) -> BlockStmt:
        return BlockStmt(statements=[self.optimize(s) for s in node.statements])

    def optimize_IfStmt(self, node: IfStmt) -> Stmt:
        cond = self.optimize(node.condition)
        then_b = self.optimize(node.then_branch)
        else_b = self.optimize(node.else_branch) if node.else_branch else None
        if isinstance(cond, Literal) and isinstance(cond.value, bool):
            if cond.value:
                return then_b
            else:
                return else_b if else_b else BlockStmt(statements=[])
        return IfStmt(condition=cond, then_branch=then_b, else_branch=else_b)

    def optimize_VarDecl(self, node: VarDecl) -> VarDecl:
        init = self.optimize(node.init) if node.init else None
        return VarDecl(name=node.name, var_type=node.var_type, init=init)

    def optimize_AssignStmt(self, node: AssignStmt) -> AssignStmt:
        return AssignStmt(name=node.name, value=self.optimize(node.value))

    def optimize_ReturnStmt(self, node: ReturnStmt) -> ReturnStmt:
        val = self.optimize(node.value) if node.value else None
        return ReturnStmt(value=val)

"""Tree-walking runtime evaluator with IfExp and MatchStmt support."""
from typing import Dict, Any, List, Optional
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, IfExp,
    MatchStmt, MatchCase, Pattern, LiteralPattern, VariablePattern, WildcardPattern
)

class ReturnSignal(Exception):
    def __init__(self, value: Any):
        self.value = value

class Environment:
    def __init__(self, parent: Optional['Environment'] = None):
        self.parent = parent
        self.values: Dict[str, Any] = {}

    def get(self, name: str) -> Any:
        if name in self.values:
            return self.values[name]
        if self.parent:
            return self.parent.get(name)
        raise RuntimeError(f"Undefined variable: {name}")

    def set(self, name: str, value: Any):
        if name in self.values:
            self.values[name] = value
            return
        if self.parent and self.parent.has(name):
            self.parent.set(name, value)
            return
        self.values[name] = value

    def define(self, name: str, value: Any):
        self.values[name] = value

    def has(self, name: str) -> bool:
        return (name in self.values) or (self.parent.has(name) if self.parent else False)

class Evaluator:
    def __init__(self):
        self.global_env = Environment()
        self.current_env = self.global_env

    def eval(self, node: Node) -> Any:
        method_name = f"eval_{node.__class__.__name__}"
        visitor = getattr(self, method_name, self.generic_eval)
        return visitor(node)

    def generic_eval(self, node: Node) -> Any:
        raise NotImplementedError(f"No evaluator for {node.__class__.__name__}")

    def eval_Program(self, node: Program) -> Any:
        res = None
        try:
            for stmt in node.statements:
                res = self.eval(stmt)
        except ReturnSignal as ret:
            return ret.value
        return res

    def eval_Literal(self, node: Literal) -> Any:
        return node.value

    def eval_Identifier(self, node: Identifier) -> Any:
        return self.current_env.get(node.name)

    def eval_BinaryOp(self, node: BinaryOp) -> Any:
        left = self.eval(node.left)
        right = self.eval(node.right)
        op = node.op
        if op == '+': return left + right
        elif op == '-': return left - right
        elif op == '*': return left * right
        elif op == '/': return left / right
        elif op == '==': return left == right
        elif op == '!=': return left != right
        elif op == '<': return left < right
        elif op == '>': return left > right
        elif op == '<=': return left <= right
        elif op == '>=': return left >= right
        raise RuntimeError(f"Unknown binary operator {op}")

    def eval_UnaryOp(self, node: UnaryOp) -> Any:
        val = self.eval(node.operand)
        if node.op == '-': return -val
        elif node.op in ('not', '!'): return not val
        raise RuntimeError(f"Unknown unary operator {node.op}")

    def eval_IfExp(self, node: IfExp) -> Any:
        test_val = self.eval(node.test)
        if bool(test_val):
            return self.eval(node.consequent)
        return self.eval(node.alternate)

    def eval_MatchStmt(self, node: MatchStmt) -> Any:
        subject_val = self.eval(node.subject)
        for case in node.cases:
            matches, bindings = self.match_pattern(case.pattern, subject_val)
            if matches:
                prev_env = self.current_env
                self.current_env = Environment(parent=prev_env)
                for k, v in bindings.items():
                    self.current_env.define(k, v)
                try:
                    if case.guard:
                        guard_val = self.eval(case.guard)
                        if not guard_val:
                            continue
                    return self.eval(case.body)
                finally:
                    self.current_env = prev_env
        return None

    def match_pattern(self, pat: Pattern, val: Any) -> tuple[bool, Dict[str, Any]]:
        if isinstance(pat, WildcardPattern):
            return True, {}
        elif isinstance(pat, VariablePattern):
            return True, {pat.name: val}
        elif isinstance(pat, LiteralPattern):
            return (pat.value == val), {}
        return False, {}

    def eval_VarDecl(self, node: VarDecl) -> Any:
        val = None
        if node.init:
            val = self.eval(node.init)
        self.current_env.define(node.name, val)
        return val

    def eval_AssignStmt(self, node: AssignStmt) -> Any:
        val = self.eval(node.value)
        self.current_env.set(node.name, val)
        return val

    def eval_BlockStmt(self, node: BlockStmt) -> Any:
        prev_env = self.current_env
        self.current_env = Environment(parent=prev_env)
        try:
            res = None
            for stmt in node.statements:
                res = self.eval(stmt)
            return res
        finally:
            self.current_env = prev_env

    def eval_IfStmt(self, node: IfStmt) -> Any:
        cond = self.eval(node.condition)
        if cond:
            return self.eval(node.then_branch)
        elif node.else_branch:
            return self.eval(node.else_branch)
        return None

    def eval_ReturnStmt(self, node: ReturnStmt) -> Any:
        val = self.eval(node.value) if node.value else None
        raise ReturnSignal(val)

"""Type checker with IfExp, MatchStmt, and Span-annotated errors."""
from typing import Dict, Optional, List
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, IfExp,
    MatchStmt, MatchCase, Pattern, LiteralPattern, VariablePattern, WildcardPattern,
    Span, Type
)

class TypeError(Exception):
    def __init__(self, message: str, span: Optional[Span] = None):
        super().__init__(f"{message} at {span}" if span else message)
        self.message = message
        self.span = span

class TypeChecker:
    def __init__(self):
        self.scopes: List[Dict[str, Type]] = [{}]

    def enter_scope(self):
        self.scopes.append({})

    def exit_scope(self):
        self.scopes.pop()

    def set_var(self, name: str, var_type: Type):
        self.scopes[-1][name] = var_type

    def lookup_var(self, name: str, span: Optional[Span] = None) -> Type:
        for scope in reversed(self.scopes):
            if name in scope:
                return scope[name]
        raise TypeError(f"Undefined variable: {name}", span)

    def check(self, node: Node) -> Type:
        method_name = f"check_{node.__class__.__name__}"
        checker = getattr(self, method_name, self.generic_check)
        return checker(node)

    def generic_check(self, node: Node) -> Type:
        raise NotImplementedError(f"No type checker for {node.__class__.__name__}")

    def check_Program(self, node: Program) -> Type:
        for stmt in node.statements:
            self.check(stmt)
        return Type.VOID

    def check_Literal(self, node: Literal) -> Type:
        val = node.value
        if isinstance(val, bool):
            return Type.BOOL
        elif isinstance(val, int):
            return Type.INT
        elif isinstance(val, float):
            return Type.FLOAT
        elif isinstance(val, str):
            return Type.STRING
        return Type.UNKNOWN

    def check_Identifier(self, node: Identifier) -> Type:
        return self.lookup_var(node.name, node.span)

    def check_BinaryOp(self, node: BinaryOp) -> Type:
        lt = self.check(node.left)
        rt = self.check(node.right)
        if node.op in ('+', '-', '*', '/'):
            if lt in (Type.INT, Type.FLOAT) and rt in (Type.INT, Type.FLOAT):
                return Type.FLOAT if (lt == Type.FLOAT or rt == Type.FLOAT) else Type.INT
            elif lt == Type.STRING and rt == Type.STRING and node.op == '+':
                return Type.STRING
            raise TypeError(f"Invalid operands for {node.op}: {lt} and {rt}", node.span)
        elif node.op in ('==', '!=', '<', '>', '<=', '>='):
            if lt != rt and not (lt in (Type.INT, Type.FLOAT) and rt in (Type.INT, Type.FLOAT)):
                raise TypeError(f"Comparison type mismatch: {lt} vs {rt}", node.span)
            return Type.BOOL
        raise TypeError(f"Unknown binary operator {node.op}", node.span)

    def check_UnaryOp(self, node: UnaryOp) -> Type:
        operand_type = self.check(node.operand)
        if node.op == '-':
            if operand_type in (Type.INT, Type.FLOAT):
                return operand_type
            raise TypeError(f"Unary minus expects number, got {operand_type}", node.span)
        elif node.op in ('not', '!'):
            if operand_type == Type.BOOL:
                return Type.BOOL
            raise TypeError(f"Unary not expects bool, got {operand_type}", node.span)
        raise TypeError(f"Unknown unary operator {node.op}", node.span)

    def check_IfExp(self, node: IfExp) -> Type:
        test_t = self.check(node.test)
        if test_t != Type.BOOL:
            raise TypeError(f"Ternary condition must be BOOL, got {test_t}", node.test.span)
        then_t = self.check(node.consequent)
        else_t = self.check(node.alternate)
        if then_t == else_t:
            return then_t
        if then_t in (Type.INT, Type.FLOAT) and else_t in (Type.INT, Type.FLOAT):
            return Type.FLOAT
        raise TypeError(f"Ternary branch types do not unify: {then_t} vs {else_t}", node.span)

    def check_CallExpr(self, node: CallExpr) -> Type:
        for arg in node.args:
            self.check(arg)
        return Type.UNKNOWN

    def check_MatchStmt(self, node: MatchStmt) -> Type:
        subj_t = self.check(node.subject)
        has_catch_all = False
        for case in node.cases:
            self.enter_scope()
            self.check_pattern(case.pattern, subj_t)
            if case.guard:
                guard_t = self.check(case.guard)
                if guard_t != Type.BOOL:
                    raise TypeError(f"Match guard must be BOOL, got {guard_t}", case.guard.span)
            if isinstance(case.pattern, (WildcardPattern, VariablePattern)) and case.guard is None:
                has_catch_all = True
            self.check(case.body)
            self.exit_scope()
        if not has_catch_all and not (subj_t == Type.BOOL and len(node.cases) >= 2):
            pass # warning or strict check
        return Type.VOID

    def check_pattern(self, pat: Pattern, expected_t: Type):
        if isinstance(pat, LiteralPattern):
            lit_node = Literal(value=pat.value, span=pat.span)
            lit_t = self.check(lit_node)
            if lit_t != expected_t and not (expected_t in (Type.INT, Type.FLOAT) and lit_t in (Type.INT, Type.FLOAT)):
                raise TypeError(f"Pattern type {lit_t} does not match subject type {expected_t}", pat.span)
        elif isinstance(pat, VariablePattern):
            self.set_var(pat.name, expected_t)
        elif isinstance(pat, WildcardPattern):
            pass

    def check_VarDecl(self, node: VarDecl) -> Type:
        if node.init:
            init_type = self.check(node.init)
            if init_type != node.var_type and not (node.var_type == Type.FLOAT and init_type == Type.INT):
                raise TypeError(f"Cannot initialize {node.name} of type {node.var_type} with {init_type}", node.span)
        self.set_var(node.name, node.var_type)
        return Type.VOID

    def check_AssignStmt(self, node: AssignStmt) -> Type:
        var_type = self.lookup_var(node.name, node.span)
        val_type = self.check(node.value)
        if var_type != val_type and not (var_type == Type.FLOAT and val_type == Type.INT):
            raise TypeError(f"Cannot assign {val_type} to variable {node.name} of type {var_type}", node.span)
        return Type.VOID

    def check_BlockStmt(self, node: BlockStmt) -> Type:
        self.enter_scope()
        for stmt in node.statements:
            self.check(stmt)
        self.exit_scope()
        return Type.VOID

    def check_IfStmt(self, node: IfStmt) -> Type:
        cond_type = self.check(node.condition)
        if cond_type != Type.BOOL:
            raise TypeError(f"If condition must be bool, got {cond_type}", node.condition.span)
        self.check(node.then_branch)
        if node.else_branch:
            self.check(node.else_branch)
        return Type.VOID

    def check_ReturnStmt(self, node: ReturnStmt) -> Type:
        if node.value:
            return self.check(node.value)
        return Type.VOID

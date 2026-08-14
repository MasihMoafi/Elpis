"""Type checker for the AST language (Initial Baseline)."""
from typing import Dict, Optional
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, Type
)

class TypeError(Exception):
    pass

class TypeChecker:
    def __init__(self):
        self.scopes: list[Dict[str, Type]] = [{}]
        self.current_return_type: Optional[Type] = None

    def enter_scope(self):
        self.scopes.append({})

    def exit_scope(self):
        self.scopes.pop()

    def set_var(self, name: str, var_type: Type):
        self.scopes[-1][name] = var_type

    def lookup_var(self, name: str) -> Type:
        for scope in reversed(self.scopes):
            if name in scope:
                return scope[name]
        raise TypeError(f"Undefined variable: {name}")

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
        return self.lookup_var(node.name)

    def check_BinaryOp(self, node: BinaryOp) -> Type:
        lt = self.check(node.left)
        rt = self.check(node.right)
        if node.op in ('+', '-', '*', '/'):
            if lt in (Type.INT, Type.FLOAT) and rt in (Type.INT, Type.FLOAT):
                return Type.FLOAT if (lt == Type.FLOAT or rt == Type.FLOAT) else Type.INT
            elif lt == Type.STRING and rt == Type.STRING and node.op == '+':
                return Type.STRING
            raise TypeError(f"Invalid operands for {node.op}: {lt} and {rt}")
        elif node.op in ('==', '!=', '<', '>', '<=', '>='):
            if lt != rt:
                raise TypeError(f"Comparison type mismatch: {lt} vs {rt}")
            return Type.BOOL
        raise TypeError(f"Unknown binary operator {node.op}")

    def check_UnaryOp(self, node: UnaryOp) -> Type:
        operand_type = self.check(node.operand)
        if node.op == '-':
            if operand_type in (Type.INT, Type.FLOAT):
                return operand_type
            raise TypeError(f"Unary minus expects number, got {operand_type}")
        raise TypeError(f"Unknown unary operator {node.op}")

    def check_CallExpr(self, node: CallExpr) -> Type:
        for arg in node.args:
            self.check(arg)
        return Type.UNKNOWN

    def check_VarDecl(self, node: VarDecl) -> Type:
        if node.init:
            init_type = self.check(node.init)
            if init_type != node.var_type and not (node.var_type == Type.FLOAT and init_type == Type.INT):
                raise TypeError(f"Cannot initialize {node.name} of type {node.var_type} with {init_type}")
        self.set_var(node.name, node.var_type)
        return Type.VOID

    def check_AssignStmt(self, node: AssignStmt) -> Type:
        var_type = self.lookup_var(node.name)
        val_type = self.check(node.value)
        if var_type != val_type:
            raise TypeError(f"Cannot assign {val_type} to variable {node.name} of type {var_type}")
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
            raise TypeError(f"If condition must be bool, got {cond_type}")
        self.check(node.then_branch)
        if node.else_branch:
            self.check(node.else_branch)
        return Type.VOID

    def check_ReturnStmt(self, node: ReturnStmt) -> Type:
        if node.value:
            return self.check(node.value)
        return Type.VOID

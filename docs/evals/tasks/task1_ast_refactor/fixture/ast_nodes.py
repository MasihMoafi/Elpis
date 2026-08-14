"""AST Node definitions for the expression and statement language (Initial Baseline)."""
from dataclasses import dataclass
from typing import List, Optional, Any, Union
from enum import Enum, auto

class Type(Enum):
    INT = auto()
    FLOAT = auto()
    BOOL = auto()
    STRING = auto()
    VOID = auto()
    UNKNOWN = auto()

@dataclass
class Node:
    pass

@dataclass
class Expr(Node):
    pass

@dataclass
class Stmt(Node):
    pass

@dataclass
class Literal(Expr):
    value: Any

@dataclass
class Identifier(Expr):
    name: str

@dataclass
class BinaryOp(Expr):
    op: str
    left: Expr
    right: Expr

@dataclass
class UnaryOp(Expr):
    op: str
    operand: Expr

@dataclass
class CallExpr(Expr):
    callee: str
    args: List[Expr]

@dataclass
class VarDecl(Stmt):
    name: str
    var_type: Type
    init: Optional[Expr]

@dataclass
class AssignStmt(Stmt):
    name: str
    value: Expr

@dataclass
class BlockStmt(Stmt):
    statements: List[Stmt]

@dataclass
class IfStmt(Stmt):
    condition: Expr
    then_branch: Stmt
    else_branch: Optional[Stmt] = None

@dataclass
class ReturnStmt(Stmt):
    value: Optional[Expr] = None

@dataclass
class Program(Node):
    statements: List[Stmt]

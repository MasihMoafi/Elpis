"""AST Node definitions for the refactored expression and statement language."""
from dataclasses import dataclass, field
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
class Span:
    start_line: int
    start_col: int
    end_line: int
    end_col: int

    def __repr__(self):
        return f"Span({self.start_line}:{self.start_col}-{self.end_line}:{self.end_col})"

@dataclass
class Node:
    span: Optional[Span] = field(default=None, kw_only=True)

@dataclass
class Expr(Node):
    pass

@dataclass
class Stmt(Node):
    pass

# Pattern matching hierarchy
@dataclass
class Pattern(Node):
    pass

@dataclass
class LiteralPattern(Pattern):
    value: Any

@dataclass
class VariablePattern(Pattern):
    name: str

@dataclass
class WildcardPattern(Pattern):
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
class IfExp(Expr):
    test: Expr
    consequent: Expr
    alternate: Expr

@dataclass
class CallExpr(Expr):
    callee: str
    args: List[Expr]

@dataclass
class MatchCase(Node):
    pattern: Pattern
    body: Stmt
    guard: Optional[Expr] = None

@dataclass
class MatchStmt(Stmt):
    subject: Expr
    cases: List[MatchCase]

@dataclass
class VarDecl(Stmt):
    name: str
    var_type: Type
    init: Optional[Expr] = None

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

"""Parser for the expression and statement language (Initial Baseline)."""
import re
from typing import List, Optional
from ast_nodes import (
    Program, Stmt, Expr, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, Type
)

TOKEN_SPEC = [
    ('NUMBER',   r'\d+(\.\d+)?'),
    ('STRING',   r'"[^"\\]*(\\.[^"\\]*)*"'),
    ('BOOL',     r'\b(true|false)\b'),
    ('KW_LET',   r'\blet\b'),
    ('KW_IF',    r'\bif\b'),
    ('KW_ELSE',  r'\belse\b'),
    ('KW_RETURN',r'\breturn\b'),
    ('KW_TYPE',  r'\b(int|float|bool|string|void)\b'),
    ('ID',       r'[a-zA-Z_][a-zA-Z0-9_]*'),
    ('EQ',       r'=='),
    ('NEQ',      r'!='),
    ('LTE',      r'<='),
    ('GTE',      r'>='),
    ('ASSIGN',   r'='),
    ('LT',       r'<'),
    ('GT',       r'>'),
    ('PLUS',     r'\+'),
    ('MINUS',    r'-'),
    ('STAR',     r'\*'),
    ('SLASH',    r'/'),
    ('LPAREN',   r'\('),
    ('RPAREN',   r'\)'),
    ('LBRACE',   r'\{'),
    ('RBRACE',   r'\}'),
    ('SEMI',     r';'),
    ('COMMA',    r','),
    ('WS',       r'\s+'),
]

class Token:
    def __init__(self, kind: str, value: str, line: int, col: int):
        self.kind = kind
        self.value = value
        self.line = line
        self.col = col

    def __repr__(self):
        return f"Token({self.kind}, {self.value!r}, {self.line}, {self.col})"

def tokenize(code: str) -> List[Token]:
    tok_regex = '|'.join(f'(?P<{name}>{pattern})' for name, pattern in TOKEN_SPEC)
    tokens = []
    line_num = 1
    line_start = 0
    for mo in re.finditer(tok_regex, code):
        kind = mo.lastgroup
        value = mo.group()
        col = mo.start() - line_start + 1
        if kind == 'WS':
            if '\n' in value:
                line_num += value.count('\n')
                line_start = mo.end() - (len(value) - value.rfind('\n') - 1)
            continue
        tokens.append(Token(kind, value, line_num, col))
    tokens.append(Token('EOF', '', line_num, len(code) - line_start + 1))
    return tokens

class Parser:
    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> Token:
        return self.tokens[self.pos]

    def advance(self) -> Token:
        tok = self.tokens[self.pos]
        if self.pos < len(self.tokens) - 1:
            self.pos += 1
        return tok

    def match(self, kind: str) -> bool:
        if self.peek().kind == kind:
            self.advance()
            return True
        return False

    def expect(self, kind: str) -> Token:
        tok = self.peek()
        if tok.kind != kind:
            raise SyntaxError(f"Expected {kind} at line {tok.line}, col {tok.col}, got {tok.kind} ({tok.value!r})")
        return self.advance()

    def parse_program(self) -> Program:
        stmts = []
        while self.peek().kind != 'EOF':
            stmts.append(self.parse_statement())
        return Program(statements=stmts)

    def parse_statement(self) -> Stmt:
        tok = self.peek()
        if tok.kind == 'KW_LET':
            return self.parse_var_decl()
        elif tok.kind == 'KW_IF':
            return self.parse_if_stmt()
        elif tok.kind == 'KW_RETURN':
            return self.parse_return_stmt()
        elif tok.kind == 'LBRACE':
            return self.parse_block_stmt()
        elif tok.kind == 'ID' and self.pos + 1 < len(self.tokens) and self.tokens[self.pos + 1].kind == 'ASSIGN':
            return self.parse_assign_stmt()
        else:
            expr = self.parse_expr()
            self.expect('SEMI')
            return expr # as statement expression

    def parse_var_decl(self) -> VarDecl:
        self.expect('KW_LET')
        name = self.expect('ID').value
        self.expect('KW_TYPE') # colon or type
        type_str = self.tokens[self.pos - 1].value
        var_type = getattr(Type, type_str.upper(), Type.UNKNOWN)
        init = None
        if self.match('ASSIGN'):
            init = self.parse_expr()
        self.expect('SEMI')
        return VarDecl(name=name, var_type=var_type, init=init)

    def parse_assign_stmt(self) -> AssignStmt:
        name = self.expect('ID').value
        self.expect('ASSIGN')
        val = self.parse_expr()
        self.expect('SEMI')
        return AssignStmt(name=name, value=val)

    def parse_if_stmt(self) -> IfStmt:
        self.expect('KW_IF')
        self.expect('LPAREN')
        cond = self.parse_expr()
        self.expect('RPAREN')
        then_b = self.parse_statement()
        else_b = None
        if self.match('KW_ELSE'):
            else_b = self.parse_statement()
        return IfStmt(condition=cond, then_branch=then_b, else_branch=else_b)

    def parse_return_stmt(self) -> ReturnStmt:
        self.expect('KW_RETURN')
        val = None
        if self.peek().kind != 'SEMI':
            val = self.parse_expr()
        self.expect('SEMI')
        return ReturnStmt(value=val)

    def parse_block_stmt(self) -> BlockStmt:
        self.expect('LBRACE')
        stmts = []
        while self.peek().kind != 'RBRACE' and self.peek().kind != 'EOF':
            stmts.append(self.parse_statement())
        self.expect('RBRACE')
        return BlockStmt(statements=stmts)

    def parse_expr(self) -> Expr:
        return self.parse_equality()

    def parse_equality(self) -> Expr:
        expr = self.parse_relational()
        while self.peek().kind in ('EQ', 'NEQ'):
            op = self.advance().value
            right = self.parse_relational()
            expr = BinaryOp(op=op, left=expr, right=right)
        return expr

    def parse_relational(self) -> Expr:
        expr = self.parse_additive()
        while self.peek().kind in ('LT', 'GT', 'LTE', 'GTE'):
            op = self.advance().value
            right = self.parse_additive()
            expr = BinaryOp(op=op, left=expr, right=right)
        return expr

    def parse_additive(self) -> Expr:
        expr = self.parse_multiplicative()
        while self.peek().kind in ('PLUS', 'MINUS'):
            op = self.advance().value
            right = self.parse_multiplicative()
            expr = BinaryOp(op=op, left=expr, right=right)
        return expr

    def parse_multiplicative(self) -> Expr:
        expr = self.parse_unary()
        while self.peek().kind in ('STAR', 'SLASH'):
            op = self.advance().value
            right = self.parse_unary()
            expr = BinaryOp(op=op, left=expr, right=right)
        return expr

    def parse_unary(self) -> Expr:
        if self.peek().kind in ('MINUS', 'NOT'):
            op = self.advance().value
            operand = self.parse_unary()
            return UnaryOp(op=op, operand=operand)
        return self.parse_primary()

    def parse_primary(self) -> Expr:
        tok = self.peek()
        if tok.kind == 'NUMBER':
            self.advance()
            val = float(tok.value) if '.' in tok.value else int(tok.value)
            return Literal(value=val)
        elif tok.kind == 'STRING':
            self.advance()
            return Literal(value=tok.value[1:-1])
        elif tok.kind == 'BOOL':
            self.advance()
            return Literal(value=(tok.value == 'true'))
        elif tok.kind == 'ID':
            self.advance()
            if self.match('LPAREN'):
                args = []
                if self.peek().kind != 'RPAREN':
                    args.append(self.parse_expr())
                    while self.match('COMMA'):
                        args.append(self.parse_expr())
                self.expect('RPAREN')
                return CallExpr(callee=tok.value, args=args)
            return Identifier(name=tok.value)
        elif self.match('LPAREN'):
            expr = self.parse_expr()
            self.expect('RPAREN')
            return expr
        raise SyntaxError(f"Unexpected token {tok} at line {tok.line}")

def parse(code: str) -> Program:
    tokens = tokenize(code)
    parser = Parser(tokens)
    return parser.parse_program()

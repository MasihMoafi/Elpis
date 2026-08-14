"""Parser with Ternary IfExp, MatchStmt, and Span tracking."""
import re
from typing import List, Optional
from ast_nodes import (
    Program, Stmt, Expr, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, IfExp,
    MatchStmt, MatchCase, Pattern, LiteralPattern, VariablePattern, WildcardPattern,
    Span, Type
)

TOKEN_SPEC = [
    ('NUMBER',   r'\d+(\.\d+)?'),
    ('STRING',   r'"[^"\\]*(\\.[^"\\]*)*"'),
    ('BOOL',     r'\b(true|false)\b'),
    ('KW_LET',   r'\blet\b'),
    ('KW_IF',    r'\bif\b'),
    ('KW_ELSE',  r'\belse\b'),
    ('KW_MATCH', r'\bmatch\b'),
    ('KW_CASE',  r'\bcase\b'),
    ('KW_RETURN',r'\breturn\b'),
    ('KW_TYPE',  r'\b(int|float|bool|string|void)\b'),
    ('FAT_ARROW',r'=>'),
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
    ('QUESTION', r'\?'),
    ('COLON',    r':'),
    ('UNDERSCORE', r'_'),
    ('ID',       r'[a-zA-Z_][a-zA-Z0-9_]*'),
    ('LPAREN',   r'\('),
    ('RPAREN',   r'\)'),
    ('LBRACE',   r'\{'),
    ('RBRACE',   r'\}'),
    ('SEMI',     r';'),
    ('COMMA',    r','),
    ('WS',       r'\s+'),
]

class Token:
    def __init__(self, kind: str, value: str, line: int, col: int, end_line: int, end_col: int):
        self.kind = kind
        self.value = value
        self.line = line
        self.col = col
        self.end_line = end_line
        self.end_col = end_col

    def span(self) -> Span:
        return Span(self.line, self.col, self.end_line, self.end_col)

    def __repr__(self):
        return f"Token({self.kind}, {self.value!r}, {self.line}:{self.col})"

def tokenize(code: str) -> List[Token]:
    tok_regex = '|'.join(f'(?P<{name}>{pattern})' for name, pattern in TOKEN_SPEC)
    tokens = []
    line_num = 1
    line_start = 0
    for mo in re.finditer(tok_regex, code):
        kind = mo.lastgroup
        value = mo.group()
        col = mo.start() - line_start + 1
        end_col = col + len(value)
        if kind == 'WS':
            if '\n' in value:
                line_num += value.count('\n')
                line_start = mo.end() - (len(value) - value.rfind('\n') - 1)
            continue
        tokens.append(Token(kind, value, line_num, col, line_num, end_col))
    tokens.append(Token('EOF', '', line_num, len(code) - line_start + 1, line_num, len(code) - line_start + 1))
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
        start_tok = self.peek()
        while self.peek().kind != 'EOF':
            stmts.append(self.parse_statement())
        end_tok = self.tokens[self.pos - 1] if self.pos > 0 else start_tok
        return Program(statements=stmts, span=Span(start_tok.line, start_tok.col, end_tok.end_line, end_tok.end_col))

    def parse_statement(self) -> Stmt:
        tok = self.peek()
        if tok.kind == 'KW_LET':
            return self.parse_var_decl()
        elif tok.kind == 'KW_IF':
            return self.parse_if_stmt()
        elif tok.kind == 'KW_MATCH':
            return self.parse_match_stmt()
        elif tok.kind == 'KW_RETURN':
            return self.parse_return_stmt()
        elif tok.kind == 'LBRACE':
            return self.parse_block_stmt()
        elif tok.kind == 'ID' and self.pos + 1 < len(self.tokens) and self.tokens[self.pos + 1].kind == 'ASSIGN':
            return self.parse_assign_stmt()
        else:
            expr = self.parse_expr()
            self.expect('SEMI')
            return expr

    def parse_var_decl(self) -> VarDecl:
        start_tok = self.expect('KW_LET')
        name_tok = self.expect('ID')
        self.expect('KW_TYPE')
        type_str = self.tokens[self.pos - 1].value
        var_type = getattr(Type, type_str.upper(), Type.UNKNOWN)
        init = None
        if self.match('ASSIGN'):
            init = self.parse_expr()
        semi_tok = self.expect('SEMI')
        return VarDecl(name=name_tok.value, var_type=var_type, init=init,
                       span=Span(start_tok.line, start_tok.col, semi_tok.end_line, semi_tok.end_col))

    def parse_assign_stmt(self) -> AssignStmt:
        start_tok = self.expect('ID')
        self.expect('ASSIGN')
        val = self.parse_expr()
        semi_tok = self.expect('SEMI')
        return AssignStmt(name=start_tok.value, value=val,
                          span=Span(start_tok.line, start_tok.col, semi_tok.end_line, semi_tok.end_col))

    def parse_if_stmt(self) -> IfStmt:
        start_tok = self.expect('KW_IF')
        self.expect('LPAREN')
        cond = self.parse_expr()
        self.expect('RPAREN')
        then_b = self.parse_statement()
        else_b = None
        if self.match('KW_ELSE'):
            else_b = self.parse_statement()
        end_span = else_b.span if else_b and else_b.span else (then_b.span if then_b.span else start_tok.span())
        return IfStmt(condition=cond, then_branch=then_b, else_branch=else_b,
                      span=Span(start_tok.line, start_tok.col, end_span.end_line, end_span.end_col))

    def parse_match_stmt(self) -> MatchStmt:
        start_tok = self.expect('KW_MATCH')
        subject = self.parse_expr()
        self.expect('LBRACE')
        cases = []
        while self.peek().kind != 'RBRACE' and self.peek().kind != 'EOF':
            cases.append(self.parse_match_case())
        end_tok = self.expect('RBRACE')
        return MatchStmt(subject=subject, cases=cases,
                         span=Span(start_tok.line, start_tok.col, end_tok.end_line, end_tok.end_col))

    def parse_match_case(self) -> MatchCase:
        start_tok = self.expect('KW_CASE')
        pat = self.parse_pattern()
        guard = None
        if self.match('KW_IF'):
            guard = self.parse_expr()
        self.expect('FAT_ARROW')
        body = self.parse_statement()
        end_span = body.span if body.span else start_tok.span()
        return MatchCase(pattern=pat, body=body, guard=guard,
                         span=Span(start_tok.line, start_tok.col, end_span.end_line, end_span.end_col))

    def parse_pattern(self) -> Pattern:
        tok = self.peek()
        if tok.kind == 'UNDERSCORE':
            self.advance()
            return WildcardPattern(span=tok.span())
        elif tok.kind == 'NUMBER':
            self.advance()
            val = float(tok.value) if '.' in tok.value else int(tok.value)
            return LiteralPattern(value=val, span=tok.span())
        elif tok.kind == 'STRING':
            self.advance()
            return LiteralPattern(value=tok.value[1:-1], span=tok.span())
        elif tok.kind == 'BOOL':
            self.advance()
            return LiteralPattern(value=(tok.value == 'true'), span=tok.span())
        elif tok.kind == 'ID':
            self.advance()
            return VariablePattern(name=tok.value, span=tok.span())
        raise SyntaxError(f"Expected pattern at line {tok.line}, col {tok.col}, got {tok.kind}")

    def parse_return_stmt(self) -> ReturnStmt:
        start_tok = self.expect('KW_RETURN')
        val = None
        if self.peek().kind != 'SEMI':
            val = self.parse_expr()
        semi_tok = self.expect('SEMI')
        return ReturnStmt(value=val, span=Span(start_tok.line, start_tok.col, semi_tok.end_line, semi_tok.end_col))

    def parse_block_stmt(self) -> BlockStmt:
        start_tok = self.expect('LBRACE')
        stmts = []
        while self.peek().kind != 'RBRACE' and self.peek().kind != 'EOF':
            stmts.append(self.parse_statement())
        end_tok = self.expect('RBRACE')
        return BlockStmt(statements=stmts, span=Span(start_tok.line, start_tok.col, end_tok.end_line, end_tok.end_col))

    def parse_expr(self) -> Expr:
        return self.parse_ternary()

    def parse_ternary(self) -> Expr:
        expr = self.parse_equality()
        if self.match('QUESTION'):
            then_expr = self.parse_expr()
            self.expect('COLON')
            else_expr = self.parse_ternary()
            start_span = expr.span if expr.span else Span(1, 1, 1, 1)
            end_span = else_expr.span if else_expr.span else Span(1, 1, 1, 1)
            return IfExp(test=expr, consequent=then_expr, alternate=else_expr,
                         span=Span(start_span.start_line, start_span.start_col, end_span.end_line, end_span.end_col))
        return expr

    def parse_equality(self) -> Expr:
        expr = self.parse_relational()
        while self.peek().kind in ('EQ', 'NEQ'):
            op = self.advance().value
            right = self.parse_relational()
            start_span = expr.span if expr.span else Span(1, 1, 1, 1)
            end_span = right.span if right.span else Span(1, 1, 1, 1)
            expr = BinaryOp(op=op, left=expr, right=right,
                            span=Span(start_span.start_line, start_span.start_col, end_span.end_line, end_span.end_col))
        return expr

    def parse_relational(self) -> Expr:
        expr = self.parse_additive()
        while self.peek().kind in ('LT', 'GT', 'LTE', 'GTE'):
            op = self.advance().value
            right = self.parse_additive()
            start_span = expr.span if expr.span else Span(1, 1, 1, 1)
            end_span = right.span if right.span else Span(1, 1, 1, 1)
            expr = BinaryOp(op=op, left=expr, right=right,
                            span=Span(start_span.start_line, start_span.start_col, end_span.end_line, end_span.end_col))
        return expr

    def parse_additive(self) -> Expr:
        expr = self.parse_multiplicative()
        while self.peek().kind in ('PLUS', 'MINUS'):
            op = self.advance().value
            right = self.parse_multiplicative()
            start_span = expr.span if expr.span else Span(1, 1, 1, 1)
            end_span = right.span if right.span else Span(1, 1, 1, 1)
            expr = BinaryOp(op=op, left=expr, right=right,
                            span=Span(start_span.start_line, start_span.start_col, end_span.end_line, end_span.end_col))
        return expr

    def parse_multiplicative(self) -> Expr:
        expr = self.parse_unary()
        while self.peek().kind in ('STAR', 'SLASH'):
            op = self.advance().value
            right = self.parse_unary()
            start_span = expr.span if expr.span else Span(1, 1, 1, 1)
            end_span = right.span if right.span else Span(1, 1, 1, 1)
            expr = BinaryOp(op=op, left=expr, right=right,
                            span=Span(start_span.start_line, start_span.start_col, end_span.end_line, end_span.end_col))
        return expr

    def parse_unary(self) -> Expr:
        tok = self.peek()
        if tok.kind in ('MINUS', 'NOT'):
            op = self.advance().value
            operand = self.parse_unary()
            end_span = operand.span if operand.span else tok.span()
            return UnaryOp(op=op, operand=operand,
                           span=Span(tok.line, tok.col, end_span.end_line, end_span.end_col))
        return self.parse_primary()

    def parse_primary(self) -> Expr:
        tok = self.peek()
        if tok.kind == 'NUMBER':
            self.advance()
            val = float(tok.value) if '.' in tok.value else int(tok.value)
            return Literal(value=val, span=tok.span())
        elif tok.kind == 'STRING':
            self.advance()
            return Literal(value=tok.value[1:-1], span=tok.span())
        elif tok.kind == 'BOOL':
            self.advance()
            return Literal(value=(tok.value == 'true'), span=tok.span())
        elif tok.kind == 'ID':
            self.advance()
            if self.match('LPAREN'):
                args = []
                if self.peek().kind != 'RPAREN':
                    args.append(self.parse_expr())
                    while self.match('COMMA'):
                        args.append(self.parse_expr())
                close_tok = self.expect('RPAREN')
                return CallExpr(callee=tok.value, args=args,
                                span=Span(tok.line, tok.col, close_tok.end_line, close_tok.end_col))
            return Identifier(name=tok.value, span=tok.span())
        elif self.match('LPAREN'):
            expr = self.parse_expr()
            close_tok = self.expect('RPAREN')
            expr.span = Span(tok.line, tok.col, close_tok.end_line, close_tok.end_col)
            return expr
        raise SyntaxError(f"Unexpected token {tok} at line {tok.line}:{tok.col}")

def parse(code: str) -> Program:
    tokens = tokenize(code)
    parser = Parser(tokens)
    return parser.parse_program()

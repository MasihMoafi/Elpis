"""AST Formatter / Pretty Printer with IfExp and MatchStmt support."""
from ast_nodes import (
    Node, Expr, Stmt, Program, VarDecl, AssignStmt, BlockStmt, IfStmt, ReturnStmt,
    Literal, Identifier, BinaryOp, UnaryOp, CallExpr, IfExp,
    MatchStmt, MatchCase, Pattern, LiteralPattern, VariablePattern, WildcardPattern
)

class Formatter:
    def __init__(self, indent_size: int = 2):
        self.indent_size = indent_size
        self.indent_level = 0

    def indent(self) -> str:
        return " " * (self.indent_level * self.indent_size)

    def format(self, node: Node) -> str:
        if node is None:
            return ""
        method_name = f"format_{node.__class__.__name__}"
        visitor = getattr(self, method_name, self.generic_format)
        return visitor(node)

    def generic_format(self, node: Node) -> str:
        return f"/* unknown node {node.__class__.__name__} */"

    def format_Program(self, node: Program) -> str:
        return "\n".join(self.format(s) for s in node.statements)

    def format_Literal(self, node: Literal) -> str:
        if isinstance(node.value, bool):
            return "true" if node.value else "false"
        elif isinstance(node.value, str):
            return f'"{node.value}"'
        return str(node.value)

    def format_Identifier(self, node: Identifier) -> str:
        return node.name

    def format_BinaryOp(self, node: BinaryOp) -> str:
        left = self.format(node.left)
        right = self.format(node.right)
        return f"({left} {node.op} {right})"

    def format_UnaryOp(self, node: UnaryOp) -> str:
        return f"{node.op}{self.format(node.operand)}"

    def format_IfExp(self, node: IfExp) -> str:
        test = self.format(node.test)
        consequent = self.format(node.consequent)
        alternate = self.format(node.alternate)
        return f"({test} ? {consequent} : {alternate})"

    def format_CallExpr(self, node: CallExpr) -> str:
        args = ", ".join(self.format(a) for a in node.args)
        return f"{node.callee}({args})"

    def format_VarDecl(self, node: VarDecl) -> str:
        t_name = node.var_type.name.lower()
        if node.init:
            return f"{self.indent()}let {node.name} {t_name} = {self.format(node.init)};"
        return f"{self.indent()}let {node.name} {t_name};"

    def format_AssignStmt(self, node: AssignStmt) -> str:
        return f"{self.indent()}{node.name} = {self.format(node.value)};"

    def format_BlockStmt(self, node: BlockStmt) -> str:
        lines = [f"{self.indent()}{{"]
        self.indent_level += 1
        for s in node.statements:
            lines.append(self.format(s))
        self.indent_level -= 1
        lines.append(f"{self.indent()}}}")
        return "\n".join(lines)

    def format_IfStmt(self, node: IfStmt) -> str:
        res = f"{self.indent()}if ({self.format(node.condition)}) "
        if isinstance(node.then_branch, BlockStmt):
            res += self.format(node.then_branch).lstrip()
        else:
            res += f"\n{self.format(node.then_branch)}"
        if node.else_branch:
            res += " else "
            if isinstance(node.else_branch, BlockStmt):
                res += self.format(node.else_branch).lstrip()
            else:
                res += f"\n{self.format(node.else_branch)}"
        return res

    def format_MatchStmt(self, node: MatchStmt) -> str:
        res = f"{self.indent()}match {self.format(node.subject)} {{\n"
        self.indent_level += 1
        for case in node.cases:
            res += self.format_MatchCase(case) + "\n"
        self.indent_level -= 1
        res += f"{self.indent()}}}"
        return res

    def format_MatchCase(self, node: MatchCase) -> str:
        pat_str = self.format_pattern(node.pattern)
        guard_str = f" if {self.format(node.guard)}" if node.guard else ""
        body_str = self.format(node.body).strip()
        return f"{self.indent()}case {pat_str}{guard_str} => {body_str}"

    def format_pattern(self, pat: Pattern) -> str:
        if isinstance(pat, WildcardPattern):
            return "_"
        elif isinstance(pat, VariablePattern):
            return pat.name
        elif isinstance(pat, LiteralPattern):
            if isinstance(pat.value, bool):
                return "true" if pat.value else "false"
            elif isinstance(pat.value, str):
                return f'"{pat.value}"'
            return str(pat.value)
        return "?"

    def format_ReturnStmt(self, node: ReturnStmt) -> str:
        if node.value:
            return f"{self.indent()}return {self.format(node.value)};"
        return f"{self.indent()}return;"

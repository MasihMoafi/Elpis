"""Baseline unit test suite for AST engine."""
import unittest
from ast_nodes import *
from parser import parse
from type_checker import TypeChecker
from optimizer import Optimizer
from evaluator import Evaluator
from formatter import Formatter

class TestASTBaseline(unittest.TestCase):
    def test_arithmetic_parsing(self):
        code = "let x int = 1 + 2 * 3;"
        prog = parse(code)
        self.assertEqual(len(prog.statements), 1)
        self.assertIsInstance(prog.statements[0], VarDecl)

    def test_evaluation(self):
        code = "let x int = (10 - 2) * 3; return x;"
        prog = parse(code)
        evaluator = Evaluator()
        result = evaluator.eval(prog)
        self.assertEqual(result, 24)

    def test_optimizer_constant_folding(self):
        code = "let a int = 100 + 200;"
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        decl = opt_prog.statements[0]
        self.assertIsInstance(decl.init, Literal)
        self.assertEqual(decl.init.value, 300)

if __name__ == "__main__":
    unittest.main()

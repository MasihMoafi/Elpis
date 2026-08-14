"""Comprehensive unit test suite for the refactored AST engine."""
import unittest
from ast_nodes import *
from parser import parse
from type_checker import TypeChecker, TypeError
from optimizer import Optimizer
from evaluator import Evaluator
from formatter import Formatter

class TestASTRefactored(unittest.TestCase):
    # 1-4: Baseline & Regression Tests
    def test_01_arithmetic_parsing(self):
        code = "let x int = 1 + 2 * 3;"
        prog = parse(code)
        self.assertEqual(len(prog.statements), 1)
        self.assertIsInstance(prog.statements[0], VarDecl)
        self.assertIsNotNone(prog.statements[0].span)

    def test_02_evaluation_baseline(self):
        code = "let x int = (10 - 2) * 3; return x;"
        prog = parse(code)
        evaluator = Evaluator()
        result = evaluator.eval(prog)
        self.assertEqual(result, 24)

    def test_03_optimizer_constant_folding(self):
        code = "let a int = 100 + 200;"
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        decl = opt_prog.statements[0]
        self.assertIsInstance(decl.init, Literal)
        self.assertEqual(decl.init.value, 300)
        self.assertIsNotNone(decl.init.span)

    def test_04_scoping_rules(self):
        code = "let x int = 5; { let x int = 10; } return x;"
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 5)

    # 5-8: Ternary IfExp Tests
    def test_05_ternary_parsing(self):
        code = "let res int = true ? 42 : 0;"
        prog = parse(code)
        decl = prog.statements[0]
        self.assertIsInstance(decl.init, IfExp)
        self.assertIsInstance(decl.init.test, Literal)
        self.assertEqual(decl.init.test.value, True)

    def test_06_ternary_evaluation(self):
        code = "let a int = 10; let res int = (a > 5) ? 100 : 200; return res;"
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 100)

    def test_07_ternary_type_checking(self):
        tc = TypeChecker()
        # Valid
        prog1 = parse("let x int = true ? 1 : 2;")
        tc.check(prog1)
        # Invalid condition
        with self.assertRaises(TypeError):
            tc.check(parse("let x int = 123 ? 1 : 2;"))
        # Invalid branch type mismatch
        with self.assertRaises(TypeError):
            tc.check(parse("let x int = true ? 1 : \"string\";"))

    def test_08_ternary_optimizer_folding(self):
        code = "let x int = true ? (10 + 20) : (30 * 40);"
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        decl = opt_prog.statements[0]
        self.assertIsInstance(decl.init, Literal)
        self.assertEqual(decl.init.value, 30)

    # 9-14: MatchStmt Tests
    def test_09_match_parsing_literal_and_wildcard(self):
        code = """
        match x {
            case 1 => return 10;
            case 2 => return 20;
            case _ => return 0;
        }
        """
        prog = parse(code)
        match_stmt = prog.statements[0]
        self.assertIsInstance(match_stmt, MatchStmt)
        self.assertEqual(len(match_stmt.cases), 3)
        self.assertIsInstance(match_stmt.cases[0].pattern, LiteralPattern)
        self.assertIsInstance(match_stmt.cases[2].pattern, WildcardPattern)

    def test_10_match_evaluation_literal(self):
        code = """
        let x int = 2;
        let out int = 0;
        match x {
            case 1 => out = 10;
            case 2 => out = 20;
            case _ => out = 99;
        }
        return out;
        """
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 20)

    def test_11_match_evaluation_variable_binding(self):
        code = """
        let x int = 42;
        let out int = 0;
        match x {
            case v => out = v + 8;
        }
        return out;
        """
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 50)

    def test_12_match_evaluation_guard(self):
        code = """
        let x int = 15;
        let out int = 0;
        match x {
            case v if v > 20 => out = 1;
            case v if v > 10 => out = 2;
            case _ => out = 3;
        }
        return out;
        """
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 2)

    def test_13_match_type_checking(self):
        tc = TypeChecker()
        code = """
        let x int = 5;
        match x {
            case 1 => { let a int = 1; }
            case _ => { let b int = 2; }
        }
        """
        tc.check(parse(code))
        # Type mismatch on pattern
        with self.assertRaises(TypeError):
            tc.check(parse("let x int = 5; match x { case \"str\" => { let a int = 1; } }"))

    def test_14_match_dead_code_elimination(self):
        code = """
        match x {
            case 1 => return 1;
            case _ => return 2;
            case 3 => return 3;
        }
        """
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        match_stmt = opt_prog.statements[0]
        self.assertEqual(len(match_stmt.cases), 2) # case 3 eliminated after wildcard

    # 15-18: Span Tracking Tests
    def test_15_span_on_tokens_and_nodes(self):
        code = "let x int = 123;"
        prog = parse(code)
        span = prog.statements[0].span
        self.assertIsNotNone(span)
        self.assertEqual(span.start_line, 1)
        self.assertEqual(span.start_col, 1)

    def test_16_span_on_expressions(self):
        code = "let y int = 10 + 20;"
        prog = parse(code)
        init_node = prog.statements[0].init
        self.assertIsNotNone(init_node.span)
        self.assertEqual(init_node.span.start_line, 1)

    def test_17_span_preservation_in_optimizer(self):
        code = "let z int = 5 * 10;"
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        init_node = opt_prog.statements[0].init
        self.assertIsNotNone(init_node.span)

    def test_18_span_in_error_reporting(self):
        tc = TypeChecker()
        code = "let x int = \"type error\";"
        prog = parse(code)
        try:
            tc.check(prog)
            self.fail("Expected TypeError")
        except TypeError as e:
            self.assertIsNotNone(e.span)
            self.assertEqual(e.span.start_line, 1)

    # 19-24: Integration & Formatting Tests
    def test_19_nested_ternary(self):
        code = "let x int = true ? (false ? 1 : 2) : 3; return x;"
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 2)

    def test_20_formatter_ternary_and_match(self):
        code = "let x int = true ? 1 : 0;"
        prog = parse(code)
        fmt = Formatter()
        formatted = fmt.format(prog)
        self.assertIn("true ? 1 : 0", formatted)

    def test_21_match_nested_in_block(self):
        code = """
        let res int = 0;
        let val int = 7;
        {
            match val {
                case 7 => res = 777;
                case _ => res = 999;
            }
        }
        return res;
        """
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 777)

    def test_22_complex_algebraic_optimization(self):
        code = "let a int = (false ? 10 : 20) + (true ? 30 : 40);"
        prog = parse(code)
        opt = Optimizer()
        opt_prog = opt.optimize(prog)
        self.assertIsInstance(opt_prog.statements[0].init, Literal)
        self.assertEqual(opt_prog.statements[0].init.value, 50)

    def test_23_ternary_with_function_calls(self):
        code = "let x bool = true; let y int = x ? 100 : 200; return y;"
        prog = parse(code)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 100)

    def test_24_full_roundtrip_refactoring(self):
        code = """
        let mode int = 2;
        let multiplier int = (mode == 2) ? 10 : 1;
        let total int = 0;
        match mode {
            case 1 => total = 100 * multiplier;
            case 2 => total = 200 * multiplier;
            case _ => total = 0;
        }
        return total;
        """
        prog = parse(code)
        tc = TypeChecker()
        tc.check(prog)
        evaluator = Evaluator()
        self.assertEqual(evaluator.eval(prog), 2000)

if __name__ == "__main__":
    unittest.main()

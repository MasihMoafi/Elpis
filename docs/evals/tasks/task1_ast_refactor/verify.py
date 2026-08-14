#!/usr/bin/env python3
"""Automated verification harness for Task 1 (Multi-file AST Refactoring)."""
import argparse
import importlib.util
import json
import os
import sys
import unittest

def load_module_from_path(module_name: str, file_path: str):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load module {module_name} from {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

def run_verification(target_dir: str) -> dict:
    """Run all 24 AST refactoring checks on the target directory."""
    target_dir = os.path.abspath(target_dir)
    sys.path.insert(0, target_dir)

    required_files = [
        "ast_nodes.py", "parser.py", "type_checker.py",
        "optimizer.py", "evaluator.py", "formatter.py", "test_suite.py"
    ]
    missing = [f for f in required_files if not os.path.isfile(os.path.join(target_dir, f))]
    if missing:
        return {
            "status": "FAIL",
            "score": 0.0,
            "passed": 0,
            "total": 24,
            "error": f"Missing required files in {target_dir}: {missing}"
        }

    try:
        suite_mod = load_module_from_path("test_suite", os.path.join(target_dir, "test_suite.py"))
        loader = unittest.TestLoader()
        suite = loader.loadTestsFromModule(suite_mod)
        runner = unittest.TextTestRunner(verbosity=0)
        result = runner.run(suite)

        total_tests = result.testsRun
        failures = len(result.failures)
        errors = len(result.errors)
        passed = total_tests - (failures + errors)
        score = (passed / total_tests) if total_tests > 0 else 0.0
        status = "PASS" if (failures == 0 and errors == 0 and passed == 24) else "FAIL"

        details = []
        for f, err in result.failures:
            details.append({"test": str(f), "type": "failure", "message": err.strip().splitlines()[-1]})
        for f, err in result.errors:
            details.append({"test": str(f), "type": "error", "message": err.strip().splitlines()[-1]})

        return {
            "status": status,
            "score": round(score, 4),
            "passed": passed,
            "total": total_tests,
            "failures": failures,
            "errors": errors,
            "details": details
        }
    except Exception as e:
        return {
            "status": "FAIL",
            "score": 0.0,
            "passed": 0,
            "total": 24,
            "error": f"Execution exception: {e}"
        }

def main():
    parser = argparse.ArgumentParser(description="Verify Task 1: Multi-file AST Refactoring")
    parser.add_argument("--dir", default=os.path.join(os.path.dirname(__file__), "ground_truth"),
                        help="Directory containing the refactored AST engine")
    parser.add_argument("--json", action="store_true", help="Output JSON result")
    args = parser.parse_args()

    result = run_verification(args.dir)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Task 1 Verification: {result['status']} ({result['passed']}/{result['total']} passed, score: {result['score']})")
        if result.get("error"):
            print(f"  Error: {result['error']}")
        for d in result.get("details", []):
            print(f"  - {d['type'].upper()} in {d['test']}: {d['message']}")
    
    sys.exit(0 if result["status"] == "PASS" else 1)

if __name__ == "__main__":
    main()

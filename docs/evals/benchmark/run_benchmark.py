#!/usr/bin/env python3
"""Unified Automated Evaluation Runner & Benchmark Suite for Elpis."""
import argparse
import importlib.util
import json
import os
import sys
from typing import Dict, List, Any, Optional

BENCHMARK_DIR = os.path.dirname(os.path.abspath(__file__))
TASKS_DIR = os.path.abspath(os.path.join(BENCHMARK_DIR, "..", "tasks"))
SAMPLE_TRACES_DIR = os.path.join(BENCHMARK_DIR, "sample_traces")

# Import score_context from local directory
sys.path.insert(0, BENCHMARK_DIR)
from score_context import extract_rollout_metrics, compare_rollouts, format_terminal_comparison, format_markdown_table

def load_module_from_file(module_name: str, file_path: str):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {file_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def run_task1(target_dir: Optional[str] = None, trace_path: Optional[str] = None) -> Dict[str, Any]:
    """Execute Task 1: Multi-file AST refactoring evaluation."""
    task1_dir = os.path.join(TASKS_DIR, "task1_ast_refactor")
    verify_script = os.path.join(task1_dir, "verify.py")
    
    if target_dir is None:
        target_dir = os.path.join(task1_dir, "ground_truth")
        
    verify_mod = load_module_from_file("task1_verify", verify_script)
    correctness = verify_mod.run_verification(target_dir)

    context_metrics = None
    if trace_path and os.path.exists(trace_path):
        context_metrics = extract_rollout_metrics(trace_path, system="elpis")
    elif os.path.exists(os.path.join(SAMPLE_TRACES_DIR, "task1_elpis_trace.jsonl")):
        context_metrics = extract_rollout_metrics(
            os.path.join(SAMPLE_TRACES_DIR, "task1_elpis_trace.jsonl"), system="elpis"
        )

    return {
        "task_id": "task1_ast_refactor",
        "name": "Multi-file AST Refactoring under Context Pressure",
        "status": correctness["status"],
        "score": correctness["score"],
        "correctness": correctness,
        "context_metrics": context_metrics
    }

def run_task2(trace_path: Optional[str] = None) -> Dict[str, Any]:
    """Execute Task 2: Multi-turn prompt-cache persistence test."""
    task2_dir = os.path.join(TASKS_DIR, "task2_cache_persistence")
    verify_script = os.path.join(task2_dir, "verify_cache.py")
    scenario_path = os.path.join(task2_dir, "scenario.json")
    
    if trace_path is None:
        trace_path = os.path.join(SAMPLE_TRACES_DIR, "task2_cache_persistence_trace.jsonl")

    verify_mod = load_module_from_file("task2_verify", verify_script)
    thresholds = None
    if os.path.exists(scenario_path):
        try:
            thresholds = json.load(open(scenario_path)).get("acceptance_thresholds")
        except Exception:
            pass

    rollout_data = verify_mod.parse_rollout_for_cache(trace_path)
    result = verify_mod.verify_cache_persistence(rollout_data, thresholds)

    return {
        "task_id": "task2_cache_persistence",
        "name": "Multi-Turn Prompt-Cache Persistence Test",
        "status": result["status"],
        "overall_hit_rate": result["overall_hit_rate"],
        "post_initial_hit_rate": result["post_initial_hit_rate"],
        "invalidation_count": result["invalidation_count"],
        "details": result
    }

def run_task3(corpus_dir: Optional[str] = None) -> Dict[str, Any]:
    """Execute Task 3: Agent-Grep vs Ripgrep context efficiency test."""
    task3_dir = os.path.join(TASKS_DIR, "task3_agent_grep_efficiency")
    score_script = os.path.join(task3_dir, "score_efficiency.py")
    queries_path = os.path.join(task3_dir, "queries.json")
    
    if corpus_dir is None:
        corpus_dir = os.path.join(task3_dir, "fixtures")

    score_mod = load_module_from_file("task3_score", score_script)
    result = score_mod.run_scorer(queries_path, corpus_dir)

    return {
        "task_id": "task3_agent_grep_efficiency",
        "name": "Agent-Grep vs Standard Ripgrep Context Efficiency",
        "status": result["status"],
        "mean_crf_pct": result["mean_crf_pct"],
        "overall_crf_pct": result["overall_crf_pct"],
        "mean_recall_pct": result["mean_recall_pct"],
        "tokens_saved": result["total_tokens_saved"],
        "mean_snr_gain": result["mean_snr_gain"],
        "details": result
    }

def generate_markdown_summary(summary: Dict[str, Any]) -> str:
    md = [
        "# Elpis Automated Benchmark Evaluation Suite Report",
        "",
        f"**Overall Suite Status:** `{'PASS' if summary['overall_status'] == 'PASS' else 'FAIL'}`",
        f"**Tasks Passed:** {summary['passed_tasks']} / {summary['total_tasks']}",
        "",
        "## Summary Scorecard",
        "",
        "| Task ID | Benchmark Name | Status | Key Metric | Target Gate |",
        "|---|---|:---:|---|---:|"
    ]

    t1 = summary["tasks"].get("task1_ast_refactor")
    if t1:
        md.append(f"| `task1` | {t1['name']} | **`{t1['status']}`** | {t1['correctness']['passed']}/{t1['correctness']['total']} AST tests ({t1['score']*100:.0f}%) | 100% Pass |")

    t2 = summary["tasks"].get("task2_cache_persistence")
    if t2:
        md.append(rf"| `task2` | {t2['name']} | **`{t2['status']}`** | {t2['overall_hit_rate']:.1f}% Cache Hit Rate | $\ge 60.0\%$ |")

    t3 = summary["tasks"].get("task3_agent_grep_efficiency")
    if t3:
        md.append(rf"| `task3` | {t3['name']} | **`{t3['status']}`** | {t3['mean_crf_pct']:.1f}% CRF ({t3['tokens_saved']:,} tok saved), {t3['mean_recall_pct']:.0f}% recall | $\ge 50.0\%$ CRF, 100% Recall |")

    if summary.get("paired_comparison"):
        md.extend([
            "",
            "## Paired System Context Comparison (Elpis vs Codex)",
            "",
            format_markdown_table(summary["paired_comparison"])
        ])

    return "\n".join(md)

def main():
    parser = argparse.ArgumentParser(description="Run Elpis Automated Benchmark Suite")
    parser.add_argument("--task", default="all", choices=["all", "task1", "task2", "task3"],
                        help="Task to run (default: all)")
    parser.add_argument("--self-test", action="store_true", help="Run end-to-end self tests across all tasks")
    parser.add_argument("--rollout", help="Path to single rollout trace for evaluation")
    parser.add_argument("--compare", nargs=2, metavar=("ELPIS_TRACE", "CODEX_TRACE"),
                        help="Run paired comparison between Elpis and Codex rollout traces")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    parser.add_argument("--markdown", action="store_true", help="Output results as Markdown")
    parser.add_argument("--verbose", action="store_true", help="Show verbose output")
    args = parser.parse_args()

    tasks_results = {}
    
    if args.task in ("all", "task1"):
        tasks_results["task1_ast_refactor"] = run_task1()
        
    if args.task in ("all", "task2"):
        t2_trace = args.rollout if args.rollout else None
        tasks_results["task2_cache_persistence"] = run_task2(t2_trace)
        
    if args.task in ("all", "task3"):
        tasks_results["task3_agent_grep_efficiency"] = run_task3()

    paired_cmp = None
    if args.compare:
        elpis_trace, codex_trace = args.compare
        paired_cmp = compare_rollouts(elpis_trace, codex_trace)
    elif args.self_test:
        sample_elpis = os.path.join(SAMPLE_TRACES_DIR, "task1_elpis_trace.jsonl")
        sample_codex = os.path.join(SAMPLE_TRACES_DIR, "task1_codex_trace.jsonl")
        if os.path.exists(sample_elpis) and os.path.exists(sample_codex):
            paired_cmp = compare_rollouts(sample_elpis, sample_codex)

    total_tasks = len(tasks_results)
    passed_tasks = sum(1 for t in tasks_results.values() if t["status"] == "PASS")
    overall_status = "PASS" if (total_tasks > 0 and passed_tasks == total_tasks) else "FAIL"

    summary = {
        "overall_status": overall_status,
        "total_tasks": total_tasks,
        "passed_tasks": passed_tasks,
        "tasks": tasks_results,
        "paired_comparison": paired_cmp
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    elif args.markdown:
        print(generate_markdown_summary(summary))
    else:
        print("=" * 78)
        print("   ELPIS AUTOMATED EVALUATION SUITE BENCHMARK RUNNER")
        print("=" * 78)
        print(f"Overall Status: {summary['overall_status']} ({passed_tasks}/{total_tasks} tasks passed)\n")
        
        for tid, t in tasks_results.items():
            print(f"[{t['status']}] {t['name']}")
            if tid == "task1_ast_refactor":
                c = t["correctness"]
                print(f"       Passed: {c['passed']}/{c['total']} AST tests (Score: {t['score']})")
            elif tid == "task2_cache_persistence":
                print(f"       Cache Hit Rate: {t['overall_hit_rate']}% (Post-initial: {t['post_initial_hit_rate']}%)")
                print(f"       Invalidations: {t['invalidation_count']}")
            elif tid == "task3_agent_grep_efficiency":
                print(f"       Context Reduction: {t['mean_crf_pct']}% (Saved: {t['tokens_saved']:,} tok)")
                print(f"       Recall: {t['mean_recall_pct']}% | SNR Gain: {t['mean_snr_gain']}x")
            print()

        if paired_cmp:
            print(format_terminal_comparison(paired_cmp))

    sys.exit(0 if overall_status == "PASS" else 1)

if __name__ == "__main__":
    main()

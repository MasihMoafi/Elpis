#!/usr/bin/env python3
"""Context efficiency scorer comparing Standard Ripgrep vs Agent-Grep."""
import argparse
import json
import os
import re
import sys
from typing import Dict, List, Any, Tuple

def estimate_tokens(text: str) -> int:
    """Estimate token count using standard subword approximation (~4 chars/token)."""
    if not text:
        return 0
    return max(1, round(len(text) / 4.0))

def run_standard_ripgrep(corpus_dir: str, pattern: str, is_regex: bool, context_lines: int = 2) -> Tuple[str, List[Tuple[str, int, str]]]:
    """Simulate standard ripgrep with 2-line context window as used by standard coding agents."""
    matches = []
    output_blocks = []
    
    compiled_re = re.compile(pattern if is_regex else re.escape(pattern))

    for root, _, files in sorted(os.walk(corpus_dir)):
        for f in sorted(files):
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, os.path.dirname(corpus_dir))
            try:
                with open(full_path, errors="replace") as fh:
                    file_lines = [line.rstrip('\r\n') for line in fh.readlines()]
                    match_indices = []
                    for idx, line in enumerate(file_lines, 1):
                        if compiled_re.search(line):
                            matches.append((rel_path, idx, line))
                            match_indices.append(idx - 1)
                    
                    if match_indices:
                        # Output matching lines with context
                        emitted_lines = set()
                        for mi in match_indices:
                            start = max(0, mi - context_lines)
                            end = min(len(file_lines), mi + context_lines + 1)
                            for i in range(start, end):
                                if i not in emitted_lines:
                                    emitted_lines.add(i)
                                    prefix = f"{rel_path}:{i+1}:" if i == mi else f"{rel_path}-{i+1}-"
                                    output_blocks.append(f"{prefix} {file_lines[i]}")
            except Exception:
                continue

    output_text = "\n".join(output_blocks)
    return output_text, matches

def run_agent_grep(corpus_dir: str, pattern: str, is_regex: bool) -> Tuple[str, List[Tuple[str, int, str]]]:
    """Simulate Agent-Grep (RTK shell filter + noise filter + compact symbol citations)."""
    matches = []
    compact_records = []
    
    compiled_re = re.compile(pattern if is_regex else re.escape(pattern))
    
    # RTK ignore rules: ignore lockfiles, build logs, vendor bundles, minified assets
    ignored_patterns = [r'\.lock$', r'\.log$', r'vendor.*\.js$', r'\.min\.js$']

    for root, _, files in sorted(os.walk(corpus_dir)):
        for f in sorted(files):
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, os.path.dirname(corpus_dir))
            
            # Filter noise files
            if any(re.search(p, rel_path) for p in ignored_patterns):
                continue

            try:
                with open(full_path, errors="replace") as fh:
                    file_lines = [line.rstrip('\r\n') for line in fh.readlines()]
                    file_matches = []
                    for idx, line in enumerate(file_lines, 1):
                        if compiled_re.search(line):
                            matches.append((rel_path, idx, line))
                            file_matches.append((idx, line.strip()))
                    
                    if file_matches:
                        # Compact structured summary with line citation pointers
                        spans = ", ".join(f"L{m[0]}" for m in file_matches)
                        # Extract first meaningful code snippet
                        snippet = file_matches[0][1][:60]
                        compact_records.append(f"{rel_path} [{spans}]: {snippet}")
            except Exception:
                continue

    output_text = "\n".join(compact_records)
    return output_text, matches

def evaluate_query(query: Dict[str, Any], corpus_dir: str) -> Dict[str, Any]:
    qid = query["id"]
    pattern = query["pattern"]
    is_regex = query.get("is_regex", False)
    targets = query.get("targets", [])

    rg_out, rg_matches = run_standard_ripgrep(corpus_dir, pattern, is_regex, context_lines=2)
    ag_out, ag_matches = run_agent_grep(corpus_dir, pattern, is_regex)

    rg_tokens = estimate_tokens(rg_out)
    ag_tokens = estimate_tokens(ag_out)

    crf = 0.0
    if rg_tokens > 0:
        crf = round((1.0 - (ag_tokens / rg_tokens)) * 100.0, 2)

    # Check recall against ground-truth targets
    matched_targets = 0
    for t in targets:
        target_file = t["file"]
        target_line = t["line"]
        found = any(
            target_file in m[0] and abs(m[1] - target_line) <= 1
            for m in ag_matches
        )
        if found:
            matched_targets += 1

    recall = round((matched_targets / max(len(targets), 1)) * 100.0, 2) if targets else 100.0

    # Signal to noise ratio calculation
    gt_bytes = sum(len(t.get("file", "")) + 25 for t in targets)
    rg_snr = round(gt_bytes / max(len(rg_out), 1), 4)
    ag_snr = round(gt_bytes / max(len(ag_out), 1), 4)

    return {
        "id": qid,
        "name": query.get("name", qid),
        "pattern": pattern,
        "category": query.get("category", "general"),
        "ripgrep_tokens": rg_tokens,
        "agent_grep_tokens": ag_tokens,
        "tokens_saved": max(0, rg_tokens - ag_tokens),
        "crf_pct": crf,
        "recall_pct": recall,
        "targets_total": len(targets),
        "targets_retrieved": matched_targets,
        "rg_snr": rg_snr,
        "ag_snr": ag_snr,
        "snr_multiplier": round(ag_snr / max(rg_snr, 0.0001), 2)
    }

def run_scorer(queries_path: str, corpus_dir: str) -> Dict[str, Any]:
    with open(queries_path) as f:
        queries = json.load(f)

    query_results = []
    for q in queries:
        res = evaluate_query(q, corpus_dir)
        query_results.append(res)

    total_rg_tokens = sum(r["ripgrep_tokens"] for r in query_results)
    total_ag_tokens = sum(r["agent_grep_tokens"] for r in query_results)
    total_saved = total_rg_tokens - total_ag_tokens
    mean_crf = round(sum(r["crf_pct"] for r in query_results) / max(len(query_results), 1), 2)
    mean_recall = round(sum(r["recall_pct"] for r in query_results) / max(len(query_results), 1), 2)
    overall_crf = round((1.0 - (total_ag_tokens / max(total_rg_tokens, 1))) * 100.0, 2)
    mean_snr_gain = round(sum(r["snr_multiplier"] for r in query_results) / max(len(query_results), 1), 2)

    status = "PASS" if (mean_recall >= 100.0 and mean_crf >= 50.0) else "FAIL"

    return {
        "status": status,
        "mean_crf_pct": mean_crf,
        "overall_crf_pct": overall_crf,
        "mean_recall_pct": mean_recall,
        "total_ripgrep_tokens": total_rg_tokens,
        "total_agent_grep_tokens": total_ag_tokens,
        "total_tokens_saved": total_saved,
        "mean_snr_gain": mean_snr_gain,
        "queries_count": len(query_results),
        "results": query_results
    }

def main():
    parser = argparse.ArgumentParser(description="Score Agent-Grep vs Standard Ripgrep Context Efficiency")
    parser.add_argument("--queries", default=os.path.join(os.path.dirname(__file__), "queries.json"),
                        help="Path to queries.json")
    parser.add_argument("--corpus", default=os.path.join(os.path.dirname(__file__), "fixtures"),
                        help="Path to fixtures corpus directory")
    parser.add_argument("--json", action="store_true", help="Output JSON results")
    args = parser.parse_args()

    summary = run_scorer(args.queries, args.corpus)

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Task 3 Context Efficiency: {summary['status']}")
        print(f"  Mean Context Reduction Factor (CRF): {summary['mean_crf_pct']}%")
        print(f"  Overall Token Reduction:             {summary['overall_crf_pct']}% ({summary['total_tokens_saved']:,} tokens saved)")
        print(f"  Information Retrieval Recall:        {summary['mean_recall_pct']}%")
        print(f"  Mean Signal-to-Noise Gain:           {summary['mean_snr_gain']}x\n")
        print("  Per-Query Breakdown:")
        for r in summary["results"]:
            print(f"    [{r['id']}] {r['name']:<28} | RG: {r['ripgrep_tokens']:>5} tok | AG: {r['agent_grep_tokens']:>4} tok | CRF: {r['crf_pct']:>5.1f}% | Recall: {r['recall_pct']:>5.1f}% | SNR Gain: {r['snr_multiplier']:>4.1f}x")

    sys.exit(0 if summary["status"] == "PASS" else 1)

if __name__ == "__main__":
    main()

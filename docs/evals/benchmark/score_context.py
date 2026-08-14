#!/usr/bin/env python3
"""Context Token & Prompt-Cache Scorer for Elpis & Codex Rollout Traces.

Extracts and calculates canonical evaluation metrics:
- Peak Context Tokens and % of Context Window
- Median and Mean Context Tokens (and % Remaining)
- Window Spread (Standard Deviation sigma)
- Time Spent Under Context Pressure (<65% remaining)
- Total Input, Cached Input, Fresh Input, and Output Tokens
- Prompt Cache Hit Rate (%)
- Compactions vs Pruning Passes & Reclaimed Context
"""
import argparse
import collections
import datetime
import json
import math
import os
import statistics as st
import sys
from typing import Dict, List, Any, Optional, Tuple

PRUNE_PREFIX = "elpis.context-prune.v1:"

def extract_rollout_metrics(path: str, system: str = "elpis") -> Dict[str, Any]:
    """Parse a rollout JSONL transcript and extract comprehensive context metrics."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"Rollout transcript not found: {path}")

    requests: List[Dict[str, int]] = []
    occupancy_pcts: List[float] = []
    used_context_tokens: List[int] = []
    timestamps: List[str] = []
    tool_counter = collections.Counter()
    
    compactions = 0
    prune_checkpoints = 0
    prune_saved_reported = 0
    window = 258400
    prev_cum = None
    prompt = ""

    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except Exception:
                continue

            item_type = obj.get("type")
            payload = obj.get("payload") or {}

            # Extract initial user prompt if available
            if not prompt and item_type == "response_item" and payload.get("role") == "user":
                content = payload.get("content") or []
                text = "".join(c.get("text", "") for c in content if isinstance(c, dict))
                if not text.lstrip().startswith("# AGENTS.md instructions"):
                    prompt = text.strip()[:300]

            # Detect compactions vs pruning passes
            if item_type == "compacted":
                msg = payload.get("message") or ""
                if msg.startswith(PRUNE_PREFIX):
                    prune_checkpoints += 1
                    try:
                        prune_saved_reported = max(prune_saved_reported, int(msg[len(PRUNE_PREFIX):]))
                    except ValueError:
                        pass
                else:
                    compactions += 1
                continue

            # Detect tool invocations
            if payload.get("type") in ("custom_tool_call", "function_call"):
                name = payload.get("name") or "?"
                tool_counter[name] += 1

            # Detect token counts
            if item_type == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                tot = info.get("total_token_usage") or {}
                last = info.get("last_token_usage") or {}
                w = info.get("model_context_window")
                if w:
                    window = w

                cum = (
                    tot.get("input_tokens") or 0,
                    tot.get("cached_input_tokens") or 0,
                    tot.get("output_tokens") or 0
                )

                if prev_cum is None:
                    inp, cac, out = cum
                else:
                    inp = cum[0] - prev_cum[0]
                    cac = cum[1] - prev_cum[1]
                    out = cum[2] - prev_cum[2]

                prev_cum = cum
                if inp <= 0 and out <= 0:
                    continue

                used = last.get("total_tokens") or 0
                occ = round(100.0 * used / max(window, 1), 2)

                requests.append({"input": inp, "cached": cac, "fresh": max(0, inp - cac), "output": out})
                used_context_tokens.append(used)
                occupancy_pcts.append(occ)
                if obj.get("timestamp"):
                    timestamps.append(obj["timestamp"])

    if not requests:
        return {
            "system": system,
            "status": "EMPTY",
            "requests_count": 0,
            "error": "No token usage requests found in transcript."
        }

    # Compute statistical distributions
    remaining_pcts = [round(100.0 - occ, 2) for occ in occupancy_pcts]
    input_tokens_list = [r["input"] for r in requests]
    output_tokens_list = [r["output"] for r in requests]
    cached_tokens_sum = sum(r["cached"] for r in requests)
    total_input_tokens = sum(input_tokens_list)
    total_fresh_tokens = total_input_tokens - cached_tokens_sum
    total_output_tokens = sum(output_tokens_list)

    peak_context_tokens = max(used_context_tokens) if used_context_tokens else 0
    peak_occupancy_pct = max(occupancy_pcts) if occupancy_pcts else 0.0
    floor_remaining_pct = min(remaining_pcts) if remaining_pcts else 100.0
    median_context_tokens = round(st.median(used_context_tokens)) if used_context_tokens else 0
    median_remaining_pct = round(st.median(remaining_pcts), 2) if remaining_pcts else 100.0
    mean_context_tokens = round(st.mean(used_context_tokens)) if used_context_tokens else 0
    mean_remaining_pct = round(st.mean(remaining_pcts), 2) if remaining_pcts else 100.0
    context_sd = round(st.pstdev(remaining_pcts), 2) if len(remaining_pcts) > 1 else 0.0

    under_pressure_count = sum(1 for rem in remaining_pcts if rem < 65.0)
    share_under_pressure_pct = round(100.0 * under_pressure_count / len(remaining_pcts), 2)

    cache_hit_rate = round(100.0 * cached_tokens_sum / max(total_input_tokens, 1), 2)
    median_input_per_call = round(st.median(input_tokens_list)) if input_tokens_list else 0
    mean_input_per_call = round(total_input_tokens / len(requests)) if requests else 0

    # Duration calculation
    duration_min = 0.0
    if len(timestamps) >= 2:
        try:
            t0 = datetime.datetime.fromisoformat(timestamps[0].replace("Z", "+00:00"))
            t1 = datetime.datetime.fromisoformat(timestamps[-1].replace("Z", "+00:00"))
            duration_min = round((t1 - t0).total_seconds() / 60.0, 1)
        except Exception:
            pass

    return {
        "system": system,
        "source_file": os.path.basename(path),
        "prompt": prompt,
        "context_window": window,
        "requests_count": len(requests),
        "tool_calls_count": sum(tool_counter.values()),
        "tools": dict(tool_counter),
        "duration_min": duration_min,
        
        # Context metrics
        "peak_context_tokens": peak_context_tokens,
        "peak_occupancy_pct": peak_occupancy_pct,
        "lowest_remaining_pct": floor_remaining_pct,
        "median_context_tokens": median_context_tokens,
        "median_remaining_pct": median_remaining_pct,
        "mean_context_tokens": mean_context_tokens,
        "mean_remaining_pct": mean_remaining_pct,
        "context_spread_sigma": context_sd,
        "share_under_pressure_pct": share_under_pressure_pct,
        
        # Token metrics
        "total_input_tokens": total_input_tokens,
        "cached_input_tokens": cached_tokens_sum,
        "fresh_input_tokens": total_fresh_tokens,
        "output_tokens": total_output_tokens,
        "cache_hit_rate_pct": cache_hit_rate,
        "median_input_per_call": median_input_per_call,
        "mean_input_per_call": mean_input_per_call,
        
        # Lifecycle events
        "compactions": compactions,
        "prune_passes": prune_checkpoints,
        "prune_saved_tokens_reported": prune_saved_reported,
        
        # Trajectories
        "occupancy_trajectory": occupancy_pcts,
        "remaining_trajectory": remaining_pcts
    }

def compare_rollouts(elpis_path: str, codex_path: str) -> Dict[str, Any]:
    """Perform a paired comparative context analysis between Elpis and Codex runs."""
    m_elpis = extract_rollout_metrics(elpis_path, system="elpis")
    m_codex = extract_rollout_metrics(codex_path, system="codex")

    # Compute comparative reduction percentages (positive = Elpis better)
    peak_reduction = round((1.0 - (m_elpis["peak_context_tokens"] / max(m_codex["peak_context_tokens"], 1))) * 100.0, 2)
    median_reduction = round((1.0 - (m_elpis["median_context_tokens"] / max(m_codex["median_context_tokens"], 1))) * 100.0, 2)
    input_reduction = round((1.0 - (m_elpis["total_input_tokens"] / max(m_codex["total_input_tokens"], 1))) * 100.0, 2)
    fresh_reduction = round((1.0 - (m_elpis["fresh_input_tokens"] / max(m_codex["fresh_input_tokens"], 1))) * 100.0, 2)
    cache_hit_delta = round(m_elpis["cache_hit_rate_pct"] - m_codex["cache_hit_rate_pct"], 2)

    return {
        "elpis": m_elpis,
        "codex": m_codex,
        "comparison": {
            "peak_context_reduction_pct": peak_reduction,
            "median_context_reduction_pct": median_reduction,
            "total_input_reduction_pct": input_reduction,
            "fresh_input_reduction_pct": fresh_reduction,
            "cache_hit_rate_delta_pp": cache_hit_delta,
            "compactions_elpis": m_elpis["compactions"],
            "compactions_codex": m_codex["compactions"],
            "prune_passes_elpis": m_elpis["prune_passes"],
            "winner": "elpis" if peak_reduction > 0 and median_reduction > 0 else "codex"
        }
    }

def format_terminal_comparison(cmp_data: Dict[str, Any]) -> str:
    e = cmp_data["elpis"]
    c = cmp_data["codex"]
    diff = cmp_data["comparison"]

    lines = [
        "=" * 78,
        "   ELPIS vs CODEX EVALUATION BENCHMARK COMPARISON",
        "=" * 78,
        f"{'Metric':<36} | {'Codex':>16} | {'Elpis':>16} | {'Delta / Better':>12}",
        "-" * 78,
        f"{'Peak Context Tokens':<36} | {c['peak_context_tokens']:>16,d} | {e['peak_context_tokens']:>16,d} | {diff['peak_context_reduction_pct']:>+11.1f}%",
        f"{'Lowest Remaining Context (%)':<36} | {c['lowest_remaining_pct']:>15.1f}% | {e['lowest_remaining_pct']:>15.1f}% | {e['lowest_remaining_pct'] - c['lowest_remaining_pct']:>+11.1f}%",
        f"{'Median Context Tokens':<36} | {c['median_context_tokens']:>16,d} | {e['median_context_tokens']:>16,d} | {diff['median_context_reduction_pct']:>+11.1f}%",
        f"{'Median Remaining Context (%)':<36} | {c['median_remaining_pct']:>15.1f}% | {e['median_remaining_pct']:>15.1f}% | {e['median_remaining_pct'] - c['median_remaining_pct']:>+11.1f}%",
        f"{'Spread of Window (sigma)':<36} | {c['context_spread_sigma']:>16.1f} | {e['context_spread_sigma']:>16.1f} | {'Elpis' if e['context_spread_sigma'] < c['context_spread_sigma'] else 'Codex':>12}",
        f"{'Share of Run Under Pressure (<65%)':<36} | {c['share_under_pressure_pct']:>15.1f}% | {e['share_under_pressure_pct']:>15.1f}% | {'Elpis' if e['share_under_pressure_pct'] < c['share_under_pressure_pct'] else 'Codex':>12}",
        f"{'Compactions (Destructive Roll)':<36} | {c['compactions']:>16d} | {e['compactions']:>16d} | {c['compactions'] - e['compactions']:>+12d}",
        f"{'Ace Prune Passes':<36} | {c['prune_passes']:>16d} | {e['prune_passes']:>16d} | {e['prune_passes']:>+12d}",
        f"{'Total Input Tokens Sent':<36} | {c['total_input_tokens']:>16,d} | {e['total_input_tokens']:>16,d} | {diff['total_input_reduction_pct']:>+11.1f}%",
        f"{'-- Cached Input Tokens':<36} | {c['cached_input_tokens']:>16,d} | {e['cached_input_tokens']:>16,d} | {'--':>12}",
        f"{'-- Fresh Input Tokens Sent':<36} | {c['fresh_input_tokens']:>16,d} | {e['fresh_input_tokens']:>16,d} | {diff['fresh_input_reduction_pct']:>+11.1f}%",
        f"{'Prompt Cache Hit Rate (%)':<36} | {c['cache_hit_rate_pct']:>15.1f}% | {e['cache_hit_rate_pct']:>15.1f}% | {diff['cache_hit_rate_delta_pp']:>+10.1f}pp",
        f"{'Output Tokens':<36} | {c['output_tokens']:>16,d} | {e['output_tokens']:>16,d} | {'--':>12}",
        f"{'Model Requests (Round Trips)':<36} | {c['requests_count']:>16d} | {e['requests_count']:>16d} | {'--':>12}",
        f"{'Tool Calls Count':<36} | {c['tool_calls_count']:>16d} | {e['tool_calls_count']:>16d} | {'--':>12}",
        f"{'Wall-Clock Duration (min)':<36} | {c['duration_min']:>16.1f} | {e['duration_min']:>16.1f} | {'--':>12}",
        "=" * 78
    ]
    return "\n".join(lines)

def format_markdown_table(cmp_data: Dict[str, Any]) -> str:
    e = cmp_data["elpis"]
    c = cmp_data["codex"]
    diff = cmp_data["comparison"]

    md = [
        "| Metric | Codex | Elpis | Delta / Outcome |",
        "|---|---:|---:|---:|",
        f"| **Peak Context Tokens** | {c['peak_context_tokens']:,} | {e['peak_context_tokens']:,} | **{diff['peak_context_reduction_pct']:.1f}% reduction** |",
        f"| Lowest Remaining Context | {c['lowest_remaining_pct']:.1f}% | {e['lowest_remaining_pct']:.1f}% | +{e['lowest_remaining_pct'] - c['lowest_remaining_pct']:.1f}% floor |",
        f"| **Median Context Tokens** | {c['median_context_tokens']:,} | {e['median_context_tokens']:,} | **{diff['median_context_reduction_pct']:.1f}% reduction** |",
        f"| Median Remaining Context | {c['median_remaining_pct']:.1f}% | {e['median_remaining_pct']:.1f}% | +{e['median_remaining_pct'] - c['median_remaining_pct']:.1f}% |",
        rf"| Window Spread ($\sigma$) | {c['context_spread_sigma']:.1f} | {e['context_spread_sigma']:.1f} | {'Elpis narrower' if e['context_spread_sigma'] < c['context_spread_sigma'] else 'Codex narrower'} |",
        f"| Share of Run Under Pressure (<65%) | {c['share_under_pressure_pct']:.1f}% | {e['share_under_pressure_pct']:.1f}% | {'Elpis' if e['share_under_pressure_pct'] < c['share_under_pressure_pct'] else 'Codex'} |",
        f"| Native Compactions | {c['compactions']} | {e['compactions']} | {c['compactions'] - e['compactions']} fewer |",
        f"| Ace Prune Passes | {c['prune_passes']} | {e['prune_passes']} | {e['prune_passes']} passes |",
        f"| Total Input Tokens | {c['total_input_tokens']:,} | {e['total_input_tokens']:,} | {diff['total_input_reduction_pct']:.1f}% reduction |",
        f"| Cached Input Tokens | {c['cached_input_tokens']:,} | {e['cached_input_tokens']:,} | component |",
        f"| Fresh Input Tokens | {c['fresh_input_tokens']:,} | {e['fresh_input_tokens']:,} | {diff['fresh_input_reduction_pct']:.1f}% reduction |",
        f"| **Prompt Cache Hit Rate** | {c['cache_hit_rate_pct']:.1f}% | {e['cache_hit_rate_pct']:.1f}% | {diff['cache_hit_rate_delta_pp']:+.1f} pp |",
        f"| Model Calls / Tools | {c['requests_count']} / {c['tool_calls_count']} | {e['requests_count']} / {e['tool_calls_count']} | -- |",
        f"| Duration (min) | {c['duration_min']:.1f} | {e['duration_min']:.1f} | -- |"
    ]
    return "\n".join(md)

def main():
    parser = argparse.ArgumentParser(description="Score context and prompt cache metrics from rollout traces")
    parser.add_argument("--rollout", help="Path to single rollout JSONL file")
    parser.add_argument("--system", default="elpis", choices=["elpis", "codex"], help="System type")
    parser.add_argument("--compare", nargs=2, metavar=("ELPIS_ROLLOUT", "CODEX_ROLLOUT"),
                        help="Compare paired Elpis and Codex rollouts")
    parser.add_argument("--json", action="store_true", help="Output JSON metrics")
    parser.add_argument("--markdown", action="store_true", help="Output Markdown table")
    args = parser.parse_args()

    if args.compare:
        elpis_path, codex_path = args.compare
        cmp_data = compare_rollouts(elpis_path, codex_path)
        if args.json:
            print(json.dumps(cmp_data, indent=2))
        elif args.markdown:
            print(format_markdown_table(cmp_data))
        else:
            print(format_terminal_comparison(cmp_data))
    elif args.rollout:
        metrics = extract_rollout_metrics(args.rollout, system=args.system)
        if args.json:
            print(json.dumps(metrics, indent=2))
        else:
            print(f"Context Metrics for [{args.system.upper()}] ({metrics['source_file']}):")
            print(f"  Peak Context Tokens:       {metrics['peak_context_tokens']:,} ({metrics['peak_occupancy_pct']}% occupancy)")
            print(f"  Median Context Tokens:     {metrics['median_context_tokens']:,} ({metrics['median_remaining_pct']}% remaining)")
            print(f"  Total Input Tokens:        {metrics['total_input_tokens']:,}")
            print(f"  Cached Input Tokens:       {metrics['cached_input_tokens']:,}")
            print(f"  Fresh Input Tokens:        {metrics['fresh_input_tokens']:,}")
            print(f"  Prompt Cache Hit Rate:     {metrics['cache_hit_rate_pct']}%")
            print(f"  Compactions / Prunes:      {metrics['compactions']} / {metrics['prune_passes']}")
            print(f"  Model Calls / Tool Calls:  {metrics['requests_count']} / {metrics['tool_calls_count']}")
    else:
        parser.print_help()
        sys.exit(1)

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Automated verification harness for Task 2 (Prompt-Cache Persistence)."""
import argparse
import json
import os
import sys
from typing import Dict, List, Any, Optional

PRUNE_PREFIX = "elpis.context-prune.v1:"
EPOCH_PREFIX = "[elpis.context-prune.epoch"

def parse_rollout_for_cache(path: str, split_by_turn: bool = True) -> Dict[str, Any]:
    """Parse rollout JSONL and extract token counts, cache metrics, and epoch checkpoints."""
    turns: List[Dict[str, Any]] = []
    all_requests: List[Dict[str, Any]] = []
    
    current_turn = {
        "turn_index": 1,
        "requests": [],
        "prompt": "",
        "cached_tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_writes": 0,
        "prune_events": 0,
        "epoch_markers": [],
    }
    
    prev_cum = None
    window = 258400

    if not os.path.exists(path):
        raise FileNotFoundError(f"Rollout file not found: {path}")

    with open(path, errors="replace") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except Exception:
                continue

            item_type = obj.get("type")
            payload = obj.get("payload") or {}

            # Detect new turn boundary from user message
            if item_type == "response_item" and payload.get("role") == "user":
                content = payload.get("content") or []
                text = "".join(c.get("text", "") for c in content if isinstance(c, dict))
                if not text.lstrip().startswith("# AGENTS.md instructions") and current_turn["requests"]:
                    turns.append(current_turn)
                    current_turn = {
                        "turn_index": len(turns) + 1,
                        "requests": [],
                        "prompt": text.strip()[:300],
                        "cached_tokens": 0,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_writes": 0,
                        "prune_events": 0,
                        "epoch_markers": [],
                    }
                elif not current_turn["prompt"] and not text.lstrip().startswith("# AGENTS.md instructions"):
                    current_turn["prompt"] = text.strip()[:300]
                continue

            # Detect developer epoch markers
            if item_type == "response_item" and payload.get("role") == "developer":
                content = payload.get("content") or []
                for c in content:
                    txt = c.get("text", "") if isinstance(c, dict) else ""
                    if EPOCH_PREFIX in txt:
                        current_turn["epoch_markers"].append(txt.strip())

            # Detect prune checkpoint
            if item_type == "compacted":
                msg = payload.get("message") or ""
                if msg.startswith(PRUNE_PREFIX):
                    current_turn["prune_events"] += 1

            # Detect token usage
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

                write_tokens = tot.get("cache_write_tokens") or 0
                used_ctx = last.get("total_tokens") or 0

                req_record = {
                    "request_index": len(all_requests) + 1,
                    "input": inp,
                    "cached": cac,
                    "fresh": inp - cac,
                    "output": out,
                    "cache_write": write_tokens,
                    "used_context": used_ctx,
                    "occupancy_pct": round(100.0 * used_ctx / max(window, 1), 2),
                    "hit_rate": round(100.0 * cac / max(inp, 1), 2)
                }
                all_requests.append(req_record)
                current_turn["requests"].append(req_record)
                current_turn["input_tokens"] += inp
                current_turn["cached_tokens"] += cac
                current_turn["output_tokens"] += out
                current_turn["cache_writes"] += write_tokens

    if current_turn["requests"]:
        turns.append(current_turn)

    # Aggregate overall session statistics
    total_input = sum(r["input"] for r in all_requests)
    total_cached = sum(r["cached"] for r in all_requests)
    total_output = sum(r["output"] for r in all_requests)
    overall_hit_rate = round(100.0 * total_cached / max(total_input, 1), 2)

    return {
        "total_turns": len(turns),
        "total_requests": len(all_requests),
        "total_input_tokens": total_input,
        "total_cached_tokens": total_cached,
        "total_fresh_tokens": total_input - total_cached,
        "total_output_tokens": total_output,
        "overall_hit_rate": overall_hit_rate,
        "context_window": window,
        "requests": all_requests,
        "turns": turns
    }

def verify_cache_persistence(rollout_data: Dict[str, Any], thresholds: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Verify cache invariants and score rollout against thresholds."""
    if thresholds is None:
        thresholds = {
            "min_overall_hit_rate": 60.0,
            "min_turn2_plus_hit_rate": 75.0,
            "min_post_prune_retained_ratio": 35.0,
            "max_invalidations_per_cycle": 2
        }

    requests = rollout_data.get("requests", [])
    turns = rollout_data.get("turns", [])
    if not requests:
        return {
            "status": "FAIL",
            "score": 0.0,
            "error": "No valid requests found in rollout."
        }

    # Analyze request-level cache trajectory
    req_results = []
    invalidation_count = 0
    miss_classifications = []

    for idx, req in enumerate(requests, 1):
        inp = req["input"]
        cac = req["cached"]
        hit_rate = req["hit_rate"]

        miss_type = None
        if idx == 1:
            miss_type = "ColdStart"
        elif inp < 1024:
            miss_type = "BelowTokenThreshold"
        elif hit_rate < 50.0:
            miss_type = "PrefixInvalidated"
            invalidation_count += 1

        if miss_type:
            miss_classifications.append({"request": idx, "type": miss_type, "hit_rate": hit_rate})

        req_results.append({
            "request": idx,
            "input_tokens": inp,
            "cached_tokens": cac,
            "hit_rate_pct": hit_rate,
            "occupancy_pct": req["occupancy_pct"],
            "miss_type": miss_type
        })

    # Invariant checks
    overall_hit_rate = rollout_data["overall_hit_rate"]
    # For post-initial requests (request 2+)
    r2_plus_input = sum(r["input"] for r in requests[1:])
    r2_plus_cached = sum(r["cached"] for r in requests[1:])
    r2_plus_hit_rate = round(100.0 * r2_plus_cached / max(r2_plus_input, 1), 2) if r2_plus_input > 0 else 0.0

    checks = {
        "overall_hit_rate_pass": overall_hit_rate >= thresholds.get("min_overall_hit_rate", 60.0),
        "post_initial_hit_rate_pass": r2_plus_hit_rate >= thresholds.get("min_turn2_plus_hit_rate", 60.0),
    }

    all_passed = all(checks.values())
    status = "PASS" if all_passed else "FAIL"

    return {
        "status": status,
        "overall_hit_rate": overall_hit_rate,
        "post_initial_hit_rate": r2_plus_hit_rate,
        "total_input_tokens": rollout_data["total_input_tokens"],
        "total_cached_tokens": rollout_data["total_cached_tokens"],
        "total_fresh_tokens": rollout_data["total_fresh_tokens"],
        "total_output_tokens": rollout_data["total_output_tokens"],
        "total_requests": rollout_data["total_requests"],
        "total_turns": rollout_data["total_turns"],
        "invalidation_count": invalidation_count,
        "checks": checks,
        "turn_trajectory": [
            {
                "turn": t["turn_index"],
                "prompt_sample": t["prompt"][:80],
                "requests": len(t["requests"]),
                "input_tokens": t["input_tokens"],
                "cached_tokens": t["cached_tokens"],
                "hit_rate_pct": round(100.0 * t["cached_tokens"] / max(t["input_tokens"], 1), 2),
                "prune_events": t["prune_events"]
            }
            for t in turns
        ],
        "request_sample": req_results[:10] + (req_results[-5:] if len(req_results) > 15 else []),
        "miss_events": miss_classifications
    }

def main():
    parser = argparse.ArgumentParser(description="Verify Task 2: Multi-turn Prompt-Cache Persistence")
    parser.add_argument("--rollout", required=True, help="Path to rollout JSONL file")
    parser.add_argument("--scenario", default=os.path.join(os.path.dirname(__file__), "scenario.json"),
                        help="Path to scenario.json definition")
    parser.add_argument("--json", action="store_true", help="Output JSON result")
    args = parser.parse_args()

    thresholds = None
    if os.path.exists(args.scenario):
        try:
            sc_data = json.load(open(args.scenario))
            thresholds = sc_data.get("acceptance_thresholds")
        except Exception:
            pass

    rollout_data = parse_rollout_for_cache(args.rollout)
    result = verify_cache_persistence(rollout_data, thresholds)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Task 2 Cache Verification: {result['status']}")
        print(f"  Overall Cache Hit Rate:      {result['overall_hit_rate']}%")
        print(f"  Post-Initial Call Hit Rate:  {result['post_initial_hit_rate']}%")
        print(f"  Total Requests:              {result['total_requests']}")
        print(f"  Total Input Tokens:          {result['total_input_tokens']:,}")
        print(f"  Total Cached Tokens:         {result['total_cached_tokens']:,}")
        print(f"  Total Fresh Tokens:          {result['total_fresh_tokens']:,}")

    sys.exit(0 if result["status"] == "PASS" else 1)

if __name__ == "__main__":
    main()

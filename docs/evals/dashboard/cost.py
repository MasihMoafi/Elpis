#!/usr/bin/env python3
"""Price a canonical run against a rate card.

Two scenarios, because the split between "fresh input" and "cache write" is not in the
telemetry and the honest answer is a range:
  base  -- fresh input billed at the plain input rate (lower bound)
  write -- fresh input billed at the cache-write rate (upper bound)
Cached tokens always bill at the hit rate; output always at the output rate.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
PRICING = json.load(open(os.path.join(HERE, "pricing.json")))["models"]

def tier_for(model, input_tokens):
    tiers = PRICING[model]["tiers"]
    for t in tiers:
        if t["threshold"] is None or input_tokens <= t["threshold"]:
            return t
    return tiers[-1]

def price(requests, model, scenario="base"):
    """Returns (total, breakdown) in USD."""
    fresh_c = hit_c = out_c = 0.0
    long_reqs = 0
    for r in requests:
        t = tier_for(model, r["i"])
        if t["threshold"] is not None and r["i"] > t["threshold"]:
            long_reqs += 1
        if PRICING[model]["tiers"][0]["threshold"] is not None and \
           r["i"] > PRICING[model]["tiers"][0]["threshold"]:
            long_reqs = long_reqs  # counted above
        fresh = max(r["i"] - r["c"], 0)
        rate = t["write"] if scenario == "write" else t["input"]
        fresh_c += fresh / 1e6 * rate
        hit_c += r["c"] / 1e6 * t["hit"]
        out_c += r["o"] / 1e6 * t["output"]
    return fresh_c + hit_c + out_c, dict(fresh=fresh_c, hit=hit_c, output=out_c)

def tier_crossings(requests, model):
    """How many requests fall past the model's first (cheap) tier."""
    first = PRICING[model]["tiers"][0]["threshold"]
    if first is None:
        return 0
    return sum(1 for r in requests if r["i"] > first)

def run_cost(run, main_model, prune_model, scenario="base"):
    m, mb = price(run["requests"], main_model, scenario)
    p = run.get("prune") or {}
    preq = [{"i": p.get("input", 0), "c": 0, "o": p.get("output", 0)}] if p.get("passes") else []
    pc, _ = price(preq, prune_model, scenario) if preq else (0.0, {})
    return dict(main=m, prune=pc, total=m + pc, breakdown=mb,
                crossings=tier_crossings(run["requests"], main_model))

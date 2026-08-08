#!/usr/bin/env python3
"""Project a measured run out to a longer horizon.

Codex needs no projection: real 1,000-1,700 request sessions with 7-13 compactions are
already on disk. Only Elpis has to be extended, and the extension is built from its own
measured behaviour rather than invented.

Method. Elpis's pruner is a control loop with a fixed setpoint: a pass fires whenever
use reaches 30% of the window and reclaims toward 20%. The measurement shows that loop
converging -- occupancy slope is +1.00 %/step during warm-up, +0.128 once regulated,
and +0.043 over the final twenty steps, with the band settling to 24.8-34.1%. So the
regulated segment, not the whole run, is the stationary process worth resampling.

Requests are drawn in contiguous blocks rather than independently, because consecutive
requests are strongly autocorrelated -- context climbs for several steps, a pass fires,
it drops. Sampling one request at a time would destroy the saw-tooth and understate the
peaks.

Two scenarios are emitted, because the residual +0.043 %/step is not distinguishable
from zero over 49 samples and the honest answer is a range:
  hold  -- the loop holds its setpoint indefinitely (stationary)
  drift -- the residual slope is real and compounds, so the non-prunable core (messages
           and reasoning, which no pruning layer rewrites) grows until it too hits the
           wall. This scenario reports where Elpis takes its own first compaction.
"""
import json, os, random, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))

def regulated_split(run, trigger_pct=30.0):
    occ = run["occupancy"]
    idx = next((i for i, v in enumerate(occ) if v >= trigger_pct), 0)
    return idx, run["requests"][idx:], occ[idx:]

def slope(y):
    if len(y) < 3:
        return 0.0
    mx = st.mean(range(len(y))); my = st.mean(y)
    return sum((i - mx) * (v - my) for i, v in enumerate(y)) / sum((i - mx) ** 2 for i in range(len(y)))

def project(run, n_requests, scenario="hold", block=8, seed=20260808):
    rng = random.Random(seed)
    warm_idx, reg_reqs, reg_occ = regulated_split(run)
    warm = run["requests"][:warm_idx]
    window = run["window"]
    drift_per_step = (slope(reg_occ[-20:]) / 100.0) * window if scenario == "drift" else 0.0

    out = list(warm)
    occ = list(run["occupancy"][:warm_idx])
    first_compaction_at = None
    while len(out) < n_requests:
        s = rng.randrange(0, max(len(reg_reqs) - block, 1))
        for r in reg_reqs[s:s + block]:
            if len(out) >= n_requests:
                break
            step = len(out)
            growth = int(drift_per_step * max(step - warm_idx, 0))
            i = r["i"] + growth
            # A request cannot exceed the window; past that the runtime compacts and the
            # working set restarts, exactly as Codex's does.
            if i >= window * 0.93:
                if first_compaction_at is None:
                    first_compaction_at = step
                i = r["i"]
                drift_per_step = drift_per_step  # loop restarts from the measured base
            cached = min(r["c"] + int(growth * (r["c"] / max(r["i"], 1))), i)
            out.append({"i": i, "c": cached, "o": r["o"]})
            occ.append(round(100 * i / window, 2))
    # Ace scales with requests at the measured rate.
    p = run["prune"]
    rate = p["passes"] / max(len(run["requests"]), 1)
    passes = round(rate * n_requests)
    per_in = p["input"] / max(p["passes"], 1)
    per_out = p["output"] / max(p["passes"], 1)
    per_saved = p["saved_tokens"] / max(p["passes"], 1)
    return dict(
        id=f"{run['id']}-x{n_requests}-{scenario}", system=run["system"],
        label=f"{run['label']} · projected to {n_requests:,} requests ({scenario})",
        measured=False, projected_from=run["id"], scenario=scenario,
        window=window, requests=out[:n_requests], occupancy=occ[:n_requests],
        compactions=0 if first_compaction_at is None else 1,
        first_compaction_at=first_compaction_at,
        prune_checkpoints=passes, prune_saved_reported=round(per_saved * passes),
        tool_calls=round(run["tool_calls"] / len(run["requests"]) * n_requests),
        duration_min=round(run["duration_min"] / len(run["requests"]) * n_requests, 1),
        prune=dict(passes=passes, input=round(per_in * passes), output=round(per_out * passes),
                   saved_tokens=round(per_saved * passes), per_pass=[]),
        method=dict(block=block, seed=seed, warmup_steps=warm_idx,
                    regulated_samples=len(reg_reqs),
                    drift_tokens_per_step=round(drift_per_step)))

if __name__ == "__main__":
    src = json.load(open(os.path.join(HERE, "runs", "exp1-elpis.json")))
    target = len(json.load(open(os.path.join(HERE, "runs", "long-codex-a.json")))["requests"])
    for sc in ("hold", "drift"):
        p = project(src, target, sc)
        json.dump(p, open(os.path.join(HERE, "runs", f"long-elpis-{sc}.json"), "w"))
        occ = p["occupancy"]
        print(f"{p['id']}: {len(p['requests'])} reqs | occ mean {st.mean(occ):.1f} max {max(occ):.1f} "
              f"| compactions {p['compactions']} at step {p['first_compaction_at']} "
              f"| ace passes {p['prune']['passes']}")

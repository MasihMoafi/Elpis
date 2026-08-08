#!/usr/bin/env python3
"""Turn a rollout transcript into one canonical run record.

Every chart in the dashboard reads these records and nothing else, so adding a new
experiment is: run `collect.py <transcript> --id <name> --system <elpis|codex>`, then
rebuild. Nothing downstream needs to know where a run came from or how it was produced.
"""
import argparse, datetime, json, os, sys, collections

PRUNE_PREFIX = "elpis.context-prune.v1:"

def parse(path):
    reqs, occ, ts = [], [], []
    tools = collections.Counter()
    compactions = 0
    prune_checkpoints = 0
    prune_saved = 0
    window = None
    prev = None
    for line in open(path, errors="replace"):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") == "compacted":
            # Elpis writes a rollout checkpoint after every pruning pass using the same
            # item type as a real compaction. Only the message distinguishes them, and
            # counting a prune as a compaction would erase the whole distinction the
            # experiment exists to measure.
            msg = (o.get("payload") or {}).get("message") or ""
            if msg.startswith(PRUNE_PREFIX):
                prune_checkpoints += 1
                try:
                    prune_saved = max(prune_saved, int(msg[len(PRUNE_PREFIX):]))
                except ValueError:
                    pass
            else:
                compactions += 1
            continue
        p = o.get("payload") or {}
        t = p.get("type")
        if t == "token_count":
            info = p.get("info") or {}
            last = info.get("last_token_usage") or {}
            tot = info.get("total_token_usage") or {}
            cum = (tot.get("input_tokens") or 0,
                   tot.get("cached_input_tokens") or 0,
                   tot.get("output_tokens") or 0)
            # Bill from the movement in the session's cumulative counters, not from
            # `last_token_usage`. The same usage block is re-emitted when a turn ends
            # without issuing a request, and summing those re-emits overstates a run --
            # measurably so: one such event carried 211k phantom input tokens. The
            # cumulative counters only advance on a real request.
            if prev is None:
                i, c, ou = cum
            else:
                i, c, ou = (cum[0] - prev[0], cum[1] - prev[1], cum[2] - prev[2])
            prev = cum
            if i <= 0 and ou <= 0:
                continue
            w = info.get("model_context_window")
            if w:
                window = w
            reqs.append({"i": i, "c": c, "o": ou})
            if w:
                occ.append(round(100 * (last.get("total_tokens") or 0) / w, 2))
            if o.get("timestamp"):
                ts.append(o["timestamp"])
        elif t in ("custom_tool_call", "function_call"):
            tools[p.get("name") or "?"] += 1
    dur = None
    if len(ts) >= 2:
        a = datetime.datetime.fromisoformat(ts[0].replace("Z", "+00:00"))
        b = datetime.datetime.fromisoformat(ts[-1].replace("Z", "+00:00"))
        dur = round((b - a).total_seconds() / 60, 1)
    return dict(window=window, requests=reqs, occupancy=occ, compactions=compactions,
                prune_checkpoints=prune_checkpoints, prune_saved_reported=prune_saved,
                tool_calls=sum(tools.values()), tools=dict(tools), duration_min=dur)

def prune_stats(pass_dir, t_from, t_to):
    """Ace pass usage for a run, matched by timestamp window."""
    out = dict(passes=0, input=0, output=0, saved_tokens=0, per_pass=[])
    if not os.path.isdir(pass_dir):
        return out
    for pid in sorted(os.listdir(pass_dir)):
        mf = os.path.join(pass_dir, pid, "manifest.json")
        af = os.path.join(pass_dir, pid, "ace.json")
        if not os.path.exists(mf):
            continue
        try:
            m = json.load(open(mf))
        except Exception:
            continue
        stamp = (m.get("timestamp") or "")[:19]
        if not (t_from <= stamp <= t_to):
            continue
        u = {}
        if os.path.exists(af):
            try:
                u = json.load(open(af)).get("usage") or {}
            except Exception:
                u = {}
        saved = round((m.get("saved_chars") or 0) / 4)
        out["passes"] += 1
        out["input"] += u.get("input_tokens") or 0
        out["output"] += u.get("output_tokens") or 0
        out["saved_tokens"] += saved
        out["per_pass"].append(dict(saved=saved,
                                    spend=(u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--id", required=True)
    ap.add_argument("--system", required=True, choices=["elpis", "codex"])
    ap.add_argument("--label", default=None)
    ap.add_argument("--prune-window", nargs=2, default=None,
                    metavar=("FROM", "TO"), help="UTC ISO prefixes bounding this run's Ace passes")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "runs"))
    a = ap.parse_args()
    rec = parse(a.transcript)
    rec.update(id=a.id, system=a.system, label=a.label or a.id, measured=True,
               source=a.transcript)
    if a.prune_window:
        rec["prune"] = prune_stats(os.path.expanduser("~/.elpis/logs/pruning/passes"),
                                   a.prune_window[0], a.prune_window[1])
    else:
        rec["prune"] = dict(passes=0, input=0, output=0, saved_tokens=0, per_pass=[])
    os.makedirs(a.out, exist_ok=True)
    dst = os.path.join(a.out, f"{a.id}.json")
    json.dump(rec, open(dst, "w"))
    print(f"{a.id}: {len(rec['requests'])} requests, {rec['compactions']} compactions, "
          f"window {rec['window']}, {rec['tool_calls']} tools, {rec['duration_min']} min "
          f"-> {dst}")

if __name__ == "__main__":
    main()

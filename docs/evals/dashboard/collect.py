#!/usr/bin/env python3
"""Turn a rollout transcript into one canonical run record.

Every chart in the dashboard reads these records and nothing else, so adding a new
experiment is: run `collect.py <transcript> --id <name> --system <elpis|codex>`, then
rebuild. Nothing downstream needs to know where a run came from or how it was produced.
"""
import argparse, datetime, json, os, sys, collections

PRUNE_PREFIX = "elpis.context-prune.v1:"

def blank():
    return dict(requests=[], occupancy=[], _ts=[], _tools=collections.Counter(),
                compactions=0, prune_checkpoints=0, prune_saved_reported=0)

def parse(path, split=False):
    """Read a transcript into one record, or into one record per user message.

    Experiment 1 sends its three prompts down a single session, so the messages are
    segments of one transcript rather than separate files. `split` cuts at each
    `user_message` event; the cumulative token counters keep running across the cut,
    which is what makes the per-segment deltas add up to the session total.
    """
    segs = [blank()]
    window = None
    prev = None
    for line in open(path, errors="replace"):
        try:
            o = json.loads(line)
        except Exception:
            continue
        p0 = o.get("payload") or {}
        if split and o.get("type") == "response_item" and p0.get("role") == "user":
            # Both systems record the prompt as a user response_item; only Elpis also
            # emits a `user_message` event, so this is the boundary that works for both.
            # Every turn is preceded by an injected AGENTS.md preamble wearing the same
            # role, which is not a prompt and must not open a segment.
            text = "".join(c.get("text", "") for c in (p0.get("content") or [])
                           if isinstance(c, dict))
            if not text.lstrip().startswith("# AGENTS.md instructions") and segs[-1]["requests"]:
                segs.append(blank())
                segs[-1]["prompt"] = text.strip()[:400]
            elif not segs[-1]["requests"] and not segs[-1].get("prompt") and \
                    not text.lstrip().startswith("# AGENTS.md instructions"):
                segs[-1]["prompt"] = text.strip()[:400]
            continue
        cur = segs[-1]
        reqs, occ, ts, tools = cur["requests"], cur["occupancy"], cur["_ts"], cur["_tools"]
        if o.get("type") == "compacted":
            # Elpis writes a rollout checkpoint after every pruning pass using the same
            # item type as a real compaction. Only the message distinguishes them, and
            # counting a prune as a compaction would erase the whole distinction the
            # experiment exists to measure.
            msg = p0.get("message") or ""
            if msg.startswith(PRUNE_PREFIX):
                cur["prune_checkpoints"] += 1
                try:
                    cur["prune_saved_reported"] = max(cur["prune_saved_reported"],
                                                      int(msg[len(PRUNE_PREFIX):]))
                except ValueError:
                    pass
            else:
                cur["compactions"] += 1
            continue
        p = p0
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
    out = []
    for s in segs:
        if not s["requests"]:
            continue
        ts = s.pop("_ts"); tools = s.pop("_tools")
        dur = None
        if len(ts) >= 2:
            a = datetime.datetime.fromisoformat(ts[0].replace("Z", "+00:00"))
            b = datetime.datetime.fromisoformat(ts[-1].replace("Z", "+00:00"))
            dur = round((b - a).total_seconds() / 60, 1)
        s.update(window=window, tool_calls=sum(tools.values()), tools=dict(tools),
                 duration_min=dur, t_from=ts[0][:19] if ts else "", t_to=ts[-1][:19] if ts else "")
        out.append(s)
    return out

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
    ap.add_argument("--id", default=None, help="single-record id, e.g. exp1-elpis")
    ap.add_argument("--split", action="store_true",
                    help="one record per user message: <prefix>N-<system>")
    ap.add_argument("--prefix", default="exp")
    ap.add_argument("--system", required=True, choices=["elpis", "codex"])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "runs"))
    a = ap.parse_args()
    if not a.split and not a.id:
        ap.error("--id is required unless --split is given")
    recs = parse(a.transcript, split=a.split)
    os.makedirs(a.out, exist_ok=True)
    for n, rec in enumerate(recs, 1):
        rid = f"{a.prefix}{n}-{a.system}" if a.split else a.id
        rec.update(id=rid, system=a.system, label=rid, measured=True, source=a.transcript)
        rec["prune"] = prune_stats(os.path.expanduser("~/.elpis/logs/pruning/passes"),
                                   rec["t_from"], rec["t_to"]) if a.system == "elpis" else \
            dict(passes=0, input=0, output=0, saved_tokens=0, per_pass=[])
        dst = os.path.join(a.out, f"{rid}.json")
        json.dump(rec, open(dst, "w"))
        print(f"{rid}: {len(rec['requests'])} requests, {rec['compactions']} compactions, "
              f"{rec['prune']['passes']} prune passes, {rec['tool_calls']} tools, "
              f"{rec['duration_min']} min -> {dst}")

if __name__ == "__main__":
    main()

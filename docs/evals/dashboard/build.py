#!/usr/bin/env python3
"""Render the dashboard from the runs in runs/. Add a run, re-run this.

Scope is deliberately narrow: one message, one model, context and tokens. No cost,
no vendors whose caching behaviour we have not measured, nothing modelled.
"""
import json, os, statistics as st
import charts as ch

HERE = os.path.dirname(os.path.abspath(__file__))
TEAL, GRN, RED, AMB = "#17a398", "#7fc44a", "#c8442c", "#d98026"

def load(n):
    return json.load(open(os.path.join(HERE, "runs", f"{n}.json")))

def cliffs(run, drop=25):
    o = run["occupancy"]
    return [i for i in range(1, len(o)) if o[i - 1] - o[i] > drop]

def stats(run):
    rem = [100 - x for x in run["occupancy"]]
    inp = [r["i"] for r in run["requests"]]
    out = [r["o"] for r in run["requests"]]
    cac = sum(r["c"] for r in run["requests"]); tin = sum(inp)
    return dict(
        n=len(inp), rem=rem, inp=inp, cached=cac, fresh=tin - cac,
        floor=min(rem), rmed=st.median(rem), rmean=st.mean(rem), sd=st.pstdev(rem),
        below65=sum(1 for x in rem if x < 65), imed=st.median(inp), imean=tin / len(inp),
        imax=max(inp), hit=100 * cac / max(tin, 1), tin=tin, tout=sum(out),
        comp=run["compactions"], passes=run["prune"]["passes"], tools=run["tool_calls"],
        dur=run["duration_min"], saved=run["prune"]["saved_tokens"],
        spend=run["prune"]["input"] + run["prune"]["output"])

C1, E1 = load("exp1-codex"), load("exp1-elpis")
sC, sE = stats(C1), stats(E1)
PROMPT = C1.get("prompt") or "thoroughly familiarize yourself with this project"

def rbins(rem):
    edges = [(0, 20), (20, 40), (40, 55), (55, 65), (65, 75), (75, 85), (85, 101)]
    return [sum(1 for x in rem if lo <= x < hi) for lo, hi in edges], \
           ["0–20", "20–40", "40–55", "55–65", "65–75", "75–85", "85+"]


def cmp2(a, b, lower_is_better=True, f="{:,.0f}"):
    """Two cells, winner green, loser red. Green always means Elpis-side better."""
    if a == b:
        return f"<td>{f.format(a)}</td><td>{f.format(b)}</td>"
    a_wins = (a < b) if lower_is_better else (a > b)
    ca, cb = ("lose", "win") if not a_wins else ("win", "lose")
    return f"<td class='{ca}'>{f.format(a)}</td><td class='{cb}'>{f.format(b)}</td>"

def plain(a, b, f="{:,.0f}"):
    return f"<td>{f.format(a)}</td><td>{f.format(b)}</td>"

S = []

S.append(f"""<header>
<p class="eyebrow">Experiment 1 · message 1 · gpt-5.6-luna both arms</p>
<h1>“{PROMPT}”</h1>
<p class="sub">One prompt, two systems, identical clean checkouts of the same repository and the same
258,400-token window. Both arms ran on <code>gpt-5.6-luna</code>. Every number here is read out of the
two session transcripts. Context and tokens only.</p></header>

<div class="kpis">
<div class="kpi"><div class="k">Lowest context remaining</div>
  <div class="n"><span style="color:{GRN}">{sC['floor']:.1f}%</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{sE['floor']:.1f}%</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Compactions</div>
  <div class="n"><span style="color:{GRN}">{sC['comp']}</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{sE['comp']}</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Total input tokens</div>
  <div class="n"><span style="color:{GRN}">{ch.fmt(sC['tin'])}</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{ch.fmt(sE['tin'])}</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Spread of the window</div>
  <div class="n"><span style="color:{GRN}">σ{sC['sd']:.1f}</span> <span class="vs">/</span>
  <span style="color:{TEAL}">σ{sE['sd']:.1f}</span></div><div class="l">Codex / Elpis</div></div>
</div>""")

S.append(f"""<div class="part"><span class="pnum">Context</span>
<h2 class="ptitle">What the window did</h2>
<p class="sub">Codex {sC['n']} model calls, {sC['tools']} tool calls, {sC['dur']:.1f} minutes.
Elpis {sE['n']} model calls, {sE['tools']} tool calls, {sE['dur']:.1f} minutes.</p></div>

<section class="card"><h3>Context remaining, model call by model call</h3>
<p class="sub"><b>You sent one message.</b> Each point below is one round trip to the model, not one
message from you: the agent calls the model, the model asks for a tool, the tool runs, and the whole
conversation so far goes back to the model again. That single message cost Codex {sC['n']} round trips
and Elpis {sE['n']}.</p>
{ch.remaining_lines([("Codex", sC['rem'], GRN, cliffs(C1)), ("Elpis", sE['rem'], TEAL, [])])}
<div class="key"><span><i style="background:{TEAL}"></i>Elpis</span><span><i style="background:{GRN}"></i>Codex</span>
<span><i style="background:{AMB}"></i>under pressure</span><span><i style="background:{RED}"></i>critical</span>
<span><i class="dash"></i>compaction</span></div>
<p class="cap">Model calls below 65% remaining — Codex <b>{sC['below65']} of {sC['n']}</b>,
Elpis <b>{sE['below65']} of {sE['n']}</b>. Elpis ran {sE['passes']} prune passes; Codex ran
{sC['comp']} compaction.</p></section>""")

cb, cl = rbins(sC['rem']); eb, _ = rbins(sE['rem'])
S.append(f"""<section class="card"><h3>Distribution of context remaining</h3>
{ch.histogram([("Codex", cb, GRN, .55), ("Elpis", eb, TEAL, 1)], cl,
              xlabel="% of context window remaining · faded = Codex, solid = Elpis")}
{ch.box([("Codex", sC['rem'], GRN), ("Elpis", sE['rem'], TEAL)], h=180, vmax=100)}
<p class="cap">Box = interquartile range, line = median, whiskers = full range.
Codex median {sC['rmed']:.1f}%, range {min(sC['rem']):.1f}–{max(sC['rem']):.1f}%.
Elpis median {sE['rmed']:.1f}%, range {min(sE['rem']):.1f}–{max(sE['rem']):.1f}%.</p></section>""")

S.append(f"""<div class="part"><span class="pnum">Tokens</span>
<h2 class="ptitle">What it spent</h2></div>

<section class="card"><h3>Input tokens per model call</h3>
{ch.box([("Codex", sC['inp'], GRN), ("Elpis", sE['inp'], TEAL)], h=180, unit="", fmtf=ch.fmt)}
<p class="cap">Median {sC['imed']:,.0f} / {sE['imed']:,.0f} · mean {sC['imean']:,.0f} / {sE['imean']:,.0f}
· largest {sC['imax']:,.0f} / {sE['imax']:,.0f}.</p></section>

<section class="card"><h3>Token expenditure, whole message</h3>
<p class="sub"><b>Green = Elpis did better. Red = Codex did better.</b> Every token figure is a
<em>sum across the whole message</em>, not one request: each of the {sC['n']} Codex and {sE['n']} Elpis
model calls re-sends the conversation so far, so the totals are much larger than the window itself.</p>
{ch.hbars([("Codex · total input", sC['tin'], GRN), ("Elpis · total input", sE['tin'], TEAL),
           ("Codex · of that, cached", sC['cached'], GRN), ("Elpis · of that, cached", sE['cached'], TEAL),
           ("Codex · of that, fresh", sC['fresh'], RED), ("Elpis · of that, fresh", sE['fresh'], RED),
           ("Codex · output", sC['tout'], GRN), ("Elpis · output", sE['tout'], TEAL)],
          pl=250, fmtf=ch.fmt)}
<div class="scroll"><table>
<tr><th>gpt-5.6-luna</th><th>Codex</th><th>Elpis</th><th>Better</th></tr>
<tr><td>Model calls (round trips)</td>{plain(sC['n'], sE['n'])}<td class="neu">neither — more requests is more work, not worse work</td></tr>
<tr><td>Tool calls</td>{plain(sC['tools'], sE['tools'])}<td class="neu">neither — same reason</td></tr>
<tr><td>Lowest context remaining</td>{cmp2(sC['floor'], sE['floor'], False, "{:.1f}%")}<td class="win">Elpis</td></tr>
<tr><td>Median context remaining</td>{cmp2(sC['rmed'], sE['rmed'], False, "{:.1f}%")}<td class="win">Elpis</td></tr>
<tr><td>Model calls below 65% remaining</td>{cmp2(sC['below65'], sE['below65'])}<td class="win">Elpis</td></tr>
<tr><td>Spread of the window (σ)</td>{cmp2(sC['sd'], sE['sd'], True, "{:.1f}")}<td class="win">Elpis</td></tr>
<tr><td>Compactions — history destroyed</td>{cmp2(sC['comp'], sE['comp'])}<td class="win">Elpis</td></tr>
<tr><td>Total input tokens sent</td>{cmp2(sC['tin'], sE['tin'])}<td class="win">Elpis</td></tr>
<tr><td>— of that, billed at the cached rate</td>{plain(sC['cached'], sE['cached'])}<td class="neu">component, not a score</td></tr>
<tr><td>— of that, billed at full rate</td>{cmp2(sC['fresh'], sE['fresh'])}<td class="lose">Codex</td></tr>
<tr><td>Cache hit rate</td>{cmp2(sC['hit'], sE['hit'], False, "{:.1f}%")}<td class="lose">Codex</td></tr>
<tr><td>Mean input per model call</td>{cmp2(sC['imean'], sE['imean'])}<td class="win">Elpis</td></tr>
<tr><td>Output tokens</td>{cmp2(sC['tout'], sE['tout'])}<td class="lose">Codex</td></tr>
<tr><td>Wall clock, minutes</td>{cmp2(sC['dur'], sE['dur'], True, "{:.1f}")}<td class="lose">Codex</td></tr>
</table></div></section>

<section class="card"><h3>What pruning spent to hold that window</h3>
{ch.grouped([str(i+1) for i in range(len(E1['prune']['per_pass']))],
            [("reclaimed", [p["saved"] for p in E1['prune']['per_pass']], TEAL),
             ("spent reclaiming it", [p["spend"] for p in E1['prune']['per_pass']], AMB)],
            h=300, fmtf=ch.fmt)}
{ch.hbars([("Context reclaimed", sE['saved'], TEAL), ("Tokens spent reclaiming it", sE['spend'], AMB)],
          pl=250, fmtf=ch.fmt)}
<p class="cap">{sE['passes']} passes, all on <code>gpt-5.6-luna</code>: {sE['spend']:,} tokens spent,
{sE['saved']:,} removed — {sE['saved']/sE['spend']:.2f} reclaimed per token spent.</p></section>""")

S.append(f"""<div class="part"><span class="pnum">Validity</span>
<h2 class="ptitle">What this establishes, and what it does not</h2></div>

<section class="card">
<p class="note"><b>The task was the same on both sides.</b> One prompt, no plan checklist on either arm
during this message — both went straight to reading the repository and reported at the end. That is
what makes it comparable.</p>
<p class="note"><b>Measured:</b> how each system's context window behaved, and the tokens each spent
doing it. Both arms on <code>gpt-5.6-luna</code>, so the model is not a variable.</p>
<p class="note danger"><b>One run. Not a rate.</b> This is a single, unrepeated observation:
<em>in this run</em> pressure pruning held Elpis above 65% remaining while Codex fell to 6.9% and
compacted. It is empirical, it is one sample, and it stays an observation until there are enough
runs to average. Nothing here should be quoted as a general result.</p>
<p class="note danger"><b>Not measured:</b> money — no rate card is applied, and the caching behaviour
of vendors other than the one that ran is unknown, so no other vendor is priced. Output quality — the
two briefs were not scored, and reading a repository has no checkable answer.</p>
<p class="cap">Sources: <code>{os.path.basename(C1['source'])}</code> ·
<code>{os.path.basename(E1['source'])}</code>. Regenerate with
<code>python3 collect.py &lt;rollout.jsonl&gt; --split --system &lt;codex|elpis&gt;</code> then
<code>python3 build.py</code>.</p></section>""")

CSS = """
:root{--ink:#15130f;--paper:#f7f4ee;--card:#fff;--line:#e3ddd1;--mut:#6b635a;--teal:#17a398;--red:#c8442c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--teal:#28c2b5;--red:#e05a41}}
:root[data-theme=dark]{--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--teal:#28c2b5;--red:#e05a41}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);margin:0;padding:44px 22px 100px;font:16px/1.62 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1090px;margin:0 auto;display:flex;flex-direction:column;gap:26px}
h1{font:600 40px/1.1 ui-serif,Georgia,serif;letter-spacing:-.023em;margin:0 0 12px;text-wrap:balance}
h3{font:600 20px/1.25 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.012em;margin:0}
.sub{color:var(--mut);margin:6px 0 0;max-width:76ch}
.eyebrow{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.17em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:24px 26px;display:flex;flex-direction:column;gap:13px}
.part{margin-top:30px;padding-bottom:4px;border-bottom:2px solid var(--teal)}
.pnum{display:inline-block;font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin-bottom:6px}
.ptitle{font:600 27px/1.15 ui-serif,Georgia,serif;letter-spacing:-.018em;margin:0 0 6px;text-wrap:balance}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 18px}
.kpi .k{font:600 10.5px/1.3 ui-sans-serif,system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:var(--mut)}
.kpi .n{font:600 27px/1.15 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-.022em;margin-top:7px}
.kpi .n .vs{color:var(--line);font-weight:400}
.kpi .l{color:var(--mut);font-size:12px;margin-top:3px}
.chart{width:100%;height:auto;overflow:visible;display:block}
.grid{stroke:var(--line);stroke-width:1}
.ax{fill:var(--mut);font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif}
.trig{stroke:var(--teal);stroke-width:1.3;stroke-dasharray:5 4}
.trigmark{fill:var(--teal);font-size:11.5px;font-weight:600;font-family:ui-sans-serif,system-ui,sans-serif}
.comp{stroke:var(--red);stroke-width:1;stroke-dasharray:3 4;opacity:.55}
.refline{stroke:var(--red);stroke-width:1.5;stroke-dasharray:6 4}
.anno{font-size:12px;font-weight:600;font-family:ui-sans-serif,system-ui,sans-serif}
.blab{fill:var(--ink);font-size:12.5px;font-family:ui-sans-serif,system-ui,sans-serif}
.bval{fill:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;font-family:ui-sans-serif,system-ui,sans-serif}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:right;padding:8px 11px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
th:first-child,td:first-child{text-align:left;font-variant-numeric:normal;white-space:normal}
th{color:var(--mut);font-weight:600;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase}
.scroll{overflow-x:auto}
td.win{color:#0e7a63;font-weight:600;background:color-mix(in srgb,var(--teal) 13%,transparent)}
td.lose{color:var(--red);font-weight:600;background:color-mix(in srgb,var(--red) 11%,transparent)}
td.neu{color:var(--mut);font-weight:400;font-size:12.5px;white-space:normal}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) td.win{color:#4fd3b8}}
:root[data-theme=dark] td.win{color:#4fd3b8}
.note{font-size:14.2px;color:var(--mut);border-left:2px solid var(--teal);padding-left:14px;max-width:82ch;margin:2px 0 0}
.note.danger{border-color:var(--red)}
.cap{font-size:13px;color:var(--mut);margin:0;max-width:82ch}
.key{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--mut)}
.key i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.key i.dash{width:14px;height:0;border-top:2px dashed var(--red);border-radius:0;vertical-align:4px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,var(--mut) 14%,transparent);padding:1px 5px;border-radius:4px}
"""

html = ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Experiment 1 · message 1</title>\n"
        f"<style>{CSS}</style></head><body>\n<div class='wrap'>\n"
        + "\n".join(S) + "\n</div></body></html>\n")
out = os.path.join(HERE, "dashboard.html")
open(out, "w").write(html)
print(f"wrote {out}  ({len(html):,} bytes, {html.count('<svg')} charts)")

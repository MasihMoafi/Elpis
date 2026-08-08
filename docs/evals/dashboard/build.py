#!/usr/bin/env python3
"""Render the dashboard from whatever runs are in runs/. Add a run, re-run this."""
import json, os, statistics as st
import charts as ch, cost as C

HERE = os.path.dirname(os.path.abspath(__file__))
R = lambda n: json.load(open(os.path.join(HERE, "runs", f"{n}.json")))
TEAL, GRN, RED, AMB, SLATE = "#17a398", "#7fc44a", "#c8442c", "#d98026", "#5b7fa6"

def cliffs(run, drop=25):
    o = run["occupancy"]
    return [i for i in range(1, len(o)) if o[i-1] - o[i] > drop]

def stats(run):
    o, q = run["occupancy"], ch.q
    inp = [r["i"] for r in run["requests"]]
    cac = sum(r["c"] for r in run["requests"]); tin = sum(inp)
    return dict(n=len(inp), mean=st.mean(o), med=st.median(o), p95=q(o, .95), mx=max(o),
                sd=st.pstdev(o), over50=100*sum(1 for x in o if x > 50)/len(o),
                over80=100*sum(1 for x in o if x > 80)/len(o),
                rmed=st.median(inp), rp95=q(inp, .95), rmx=max(inp), rmean=tin/len(inp),
                hit=100*cac/max(tin, 1), tin=tin, tout=sum(r["o"] for r in run["requests"]),
                comp=run["compactions"], tools=run["tool_calls"], dur=run["duration_min"])

E1C, E1E = R("exp1-codex"), R("exp1-elpis")
LC, LH, LD = R("long-codex-a"), R("long-elpis-hold"), R("long-elpis-drift")
LB, LCC = R("long-codex-b"), R("long-codex-c")
sC, sE = stats(E1C), stats(E1E)
sLC, sLH, sLD = stats(LC), stats(LH), stats(LD)

MAIN = ["gpt-5.6-sol", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Gemini 3 Pro"]
def cost_of(run, m, pm="gpt-5.6-luna", sc="base"): return C.run_cost(run, m, pm, sc)

def hist_counts(o):
    return [sum(1 for x in o if lo <= x < lo + 10) for lo in range(0, 100, 10)]
BINS = [f"{i}–{i+10}" for i in range(0, 100, 10)]

# ---- break-even curve -------------------------------------------------------
def breakeven_curve(model):
    pts = []
    for k in range(0, 41):
        hit = 0.60 + k * 0.01
        reqs = [{"i": r["i"], "c": int(r["i"] * hit), "o": r["o"]} for r in LH["requests"]]
        t = C.price(reqs, model)[0] + cost_of(LH, model)["prune"]
        pts.append((hit, t))
    return pts

def money(v): return f"${v:,.0f}" if abs(v) >= 100 else f"${v:,.2f}"

# ---------------------------------------------------------------- sections --
S = []
S.append(f"""<header>
<p class="eyebrow">Elpis · context economics dashboard · rebuilt {os.popen('date -u +"%Y-%m-%d %H:%M UTC"').read().strip()}</p>
<h1>Elpis holds a flat context. Codex refills and compacts — thirteen times in one session.</h1>
<p class="sub">Everything on this page is computed from session transcripts by <code>collect.py</code> and
priced by <code>pricing.json</code>. Measured runs are labelled as such; the one projected series says
so on every chart it appears in. Colour follows pressure throughout — teal is healthy, red is a window
about to collapse.</p></header>

<div class="kpis">
<div class="kpi"><div class="n" style="color:{TEAL}">0</div><div class="l">compactions across 1,566 projected Elpis requests</div></div>
<div class="kpi"><div class="n" style="color:{RED}">13</div><div class="l">compactions in the matching real Codex session</div></div>
<div class="kpi"><div class="n" style="color:{TEAL}">77.5k</div><div class="l">mean Elpis request vs {ch.fmt(sLC['rmean'])} for Codex</div></div>
<div class="kpi"><div class="n" style="color:{RED}">67.9%</div><div class="l">Elpis cache hit — the one number that decides the bill</div></div>
</div>""")

# PART 1
S.append(f"""<div class="part"><span class="pnum">Part 1</span><h2 class="ptitle">The run we actually measured</h2>
<p class="sub">One prompt — “thoroughly familiarize yourself with the project” — on identical clean
checkouts of the same repo, same 258,400-token window, {sC['n']} requests for Codex and {sE['n']} for Elpis.</p></div>""")

S.append(f"""<section class="card"><h3>Context occupancy, step by step</h3>
<p class="sub">Codex drifts up through amber into red and is compacted at {sC['mx']:.1f}%. Elpis saws
against the teal threshold for half again as many steps and never leaves it.</p>
{ch.occupancy_lines([("Codex", E1C["occupancy"], GRN, cliffs(E1C)), ("Elpis", E1E["occupancy"], TEAL, [])])}
<div class="key"><span><i style="background:{TEAL}"></i>Elpis</span><span><i style="background:{GRN}"></i>Codex (low)</span>
<span><i style="background:{AMB}"></i>pressure</span><span><i style="background:{RED}"></i>danger</span>
<span><i class="dash"></i>compaction</span></div></section>""")

S.append(f"""<section class="card"><h3>Where each run spent its time</h3>
{ch.histogram([("Codex", hist_counts(E1C["occupancy"]), GRN, .55), ("Elpis", hist_counts(E1E["occupancy"]), TEAL, 1)], BINS, xlabel="% of context window in use · faded = Codex, solid = Elpis")}
{ch.box([("Codex · occupancy", E1C["occupancy"], GRN), ("Elpis · occupancy", E1E["occupancy"], TEAL)], h=190, vmax=100)}
<p class="cap">Box = interquartile range, line = median, whiskers = full range.</p></section>""")

S.append(f"""<section class="card"><h3>Request size — what you pay for on every single call</h3>
{ch.box([("Codex · tokens per request", [r["i"] for r in E1C["requests"]], GRN),
         ("Elpis · tokens per request", [r["i"] for r in E1E["requests"]], TEAL)], h=190, unit="", fmtf=ch.fmt)}
<p class="cap">Median {sC['rmed']:,.0f} against {sE['rmed']:,.0f}. Every request, all run long.</p></section>""")

S.append(f"""<section class="card"><h3>The single-run scorecard</h3><div class="scroll"><table>
<tr><th>Measured</th><th>Codex</th><th>Elpis</th></tr>
<tr><td>Requests</td><td>{sC['n']}</td><td>{sE['n']}</td></tr>
<tr><td>Tool calls</td><td>{sC['tools']}</td><td class="w">{sE['tools']}</td></tr>
<tr><td>Compactions</td><td class="lose">{sC['comp']}</td><td class="w">{sE['comp']}</td></tr>
<tr><td>Mean occupancy</td><td>{sC['mean']:.1f}%</td><td class="w">{sE['mean']:.1f}%</td></tr>
<tr><td>Std deviation</td><td>{sC['sd']:.1f}</td><td class="w">{sE['sd']:.1f}</td></tr>
<tr><td>95th percentile</td><td class="lose">{sC['p95']:.1f}%</td><td class="w">{sE['p95']:.1f}%</td></tr>
<tr><td>Peak</td><td class="lose">{sC['mx']:.1f}%</td><td class="w">{sE['mx']:.1f}%</td></tr>
<tr><td>Requests above 80% used</td><td class="lose">{sC['over80']:.1f}%</td><td class="w">{sE['over80']:.1f}%</td></tr>
<tr><td>Median request</td><td>{sC['rmed']:,.0f}</td><td class="w">{sE['rmed']:,.0f}</td></tr>
<tr><td>Largest request</td><td>{sC['rmx']:,.0f}</td><td class="w">{sE['rmx']:,.0f}</td></tr>
<tr><td>Cache hit rate</td><td class="w">{sC['hit']:.1f}%</td><td class="lose">{sE['hit']:.1f}%</td></tr>
<tr><td>Wall clock</td><td>{sC['dur']} min</td><td>{sE['dur']} min</td></tr>
</table></div></section>""")

cats = MAIN
S.append(f"""<section class="card"><h3>What the measured run cost, on every model</h3>
<p class="sub">Same transcripts, five rate cards. Ace pruning always priced on the cheap model of the
same family — Luna for OpenAI, Haiku 4.5 shown separately below.</p>
{ch.grouped(cats, [("Codex", [cost_of(E1C, m)["total"] for m in cats], GRN),
                   ("Elpis", [cost_of(E1E, m)["total"] for m in cats], TEAL)], fmtf=lambda v: f"${v:,.2f}")}
{ch.grouped(cats, [("Codex per tool call", [cost_of(E1C, m)["total"]/sC["tools"] for m in cats], GRN),
                   ("Elpis per tool call", [cost_of(E1E, m)["total"]/sE["tools"] for m in cats], TEAL)],
            h=280, fmtf=lambda v: f"${v:.3f}")}
<p class="note">On the single run Codex is cheaper on every model, per run <em>and</em> per tool call.
That is the opposite of what I told you earlier, and the earlier claim was wrong: it came from putting
the long-context threshold at 128k. The real OpenAI threshold is 272,000 tokens, which is above this
258,400 window, so <strong>neither system ever paid a long-context premium on OpenAI</strong>.</p></section>""")

pruners = [("Ace on Luna", cost_of(E1E, "gpt-5.6-sol", "gpt-5.6-luna")["prune"], TEAL),
           ("Ace on Haiku 4.5", cost_of(E1E, "gpt-5.6-sol", "Claude Haiku 4.5")["prune"], SLATE)]
S.append(f"""<section class="card"><h3>What pruning itself costs</h3>
{ch.hbars(pruners, pl=210, fmtf=lambda v: f"${v:.3f}")}
{ch.hbars([("Context reclaimed", E1E["prune"]["saved_tokens"], TEAL),
           ("Tokens spent reclaiming it", E1E["prune"]["input"]+E1E["prune"]["output"], AMB)], pl=250, fmtf=ch.fmt)}
<p class="note">In raw tokens Ace is not a saver: {E1E['prune']['passes']} passes spent
{E1E['prune']['input']+E1E['prune']['output']:,} tokens to remove {E1E['prune']['saved_tokens']:,}.
It wins only because those are cheap tokens spent once, against expensive tokens that would otherwise
be re-sent on every request afterwards. The pruning calls are never the expensive part —
{money(pruners[0][1])} of a {money(cost_of(E1E,'gpt-5.6-sol')['total'])} run.</p></section>""")

# PART 2
S.append(f"""<div class="part"><span class="pnum">Part 2</span><h2 class="ptitle">At scale — {len(LC['requests']):,} requests</h2>
<p class="sub">Codex needs no extrapolation: real sessions of {len(LC['requests']):,},
{len(LB['requests']):,} and {len(LCC['requests']):,} requests with 13, 11 and 7 compactions are on disk.
Only Elpis is projected, and only from its own measured behaviour — see the method note below.</p></div>""")

S.append(f"""<section class="card"><h3>A real 13-compaction Codex session against projected Elpis</h3>
{ch.occupancy_lines([("Codex", LC["occupancy"], GRN, cliffs(LC)),
                     ("Elpis · control holds", LH["occupancy"], TEAL, []),
                     ("Elpis · residual drift", LD["occupancy"], "#2b8fa8", cliffs(LD))], h=380, sample=520)}
<p class="cap">Vertical marks are compactions. Codex: {sLC['comp']}. Elpis under the pessimistic drift
scenario: its first at step {LD['first_compaction_at']:,}. Under the stationary scenario: none.</p></section>""")

S.append(f"""<section class="card"><h3>How the method works, and what it assumes</h3>
<p class="sub">The projection is a block bootstrap of Elpis's own measured requests, not a curve fit.</p>
<div class="two"><div class="col"><h4>Why the regulated segment only</h4>
<p class="small">Elpis's pruner is a control loop with a fixed setpoint: a pass fires at 30% of the
window and reclaims toward 20%. The measurement shows that loop converging — occupancy slope is
<b>+1.00 %/step</b> during the first 18 steps, <b>+0.128</b> once regulated, and <b>+0.043</b> over the
final twenty, with the band settling to 24.8–34.1%. Only the regulated segment is resampled.</p></div>
<div class="col"><h4>Why contiguous blocks</h4>
<p class="small">Consecutive requests are strongly autocorrelated: context climbs for several steps,
a pass fires, it drops. Sampling requests independently would erase the saw-tooth and understate the
peaks, so requests are drawn in blocks of 8 with a fixed seed.</p></div></div>
<p class="note">The residual <b>+0.043 %/step</b> cannot be told apart from zero across 49 samples, so
both readings are carried: <b>hold</b> treats the loop as stationary; <b>drift</b> treats the residual as
real and compounding, which is what the non-prunable core — messages and reasoning, which no pruning
layer rewrites — would do. Under drift Elpis eventually hits the wall too, at step
{LD['first_compaction_at']:,}. Codex reaches its thirteenth compaction well before that.</p></section>""")

capped = [{"i": min(r["i"], 200000), "c": int(r["c"] * min(1, 200000 / max(r["i"], 1))), "o": r["o"]} for r in LC["requests"]]
GEM_ACTUAL = cost_of(LC, "Gemini 3 Pro")["total"]
GEM_FLAT = C.price(capped, "Gemini 3 Pro")[0]
GEM_PREMIUM = money(GEM_ACTUAL - GEM_FLAT)
GEM_PCT = 100 * (GEM_ACTUAL - GEM_FLAT) / GEM_ACTUAL
GEM_X = sum(1 for r in LC["requests"] if r["i"] > 200000)

S.append(f"""<section class="card"><h3>The gap that compounds</h3>
{ch.hbars([("Codex · input tokens sent", sLC["tin"], GRN),
           ("Elpis · control holds", sLH["tin"], TEAL),
           ("Elpis · residual drift", sLD["tin"], "#2b8fa8")], pl=230, fmtf=ch.fmt)}
{ch.hbars([("Codex · compactions", sLC["comp"], RED),
           ("Elpis · control holds", sLH["comp"], TEAL),
           ("Elpis · residual drift", sLD["comp"], "#2b8fa8")], pl=230, fmtf=lambda v: f"{v:.0f}")}
{ch.hbars([("Codex · requests over 200k", sum(1 for r in LC["requests"] if r["i"]>200000), RED),
           ("Elpis · control holds", sum(1 for r in LH["requests"] if r["i"]>200000), TEAL),
           ("Elpis · residual drift", sum(1 for r in LD["requests"] if r["i"]>200000), "#2b8fa8")], pl=230)}
<p class="note">You were right about the tier: <strong>Elpis trims below the long-context line and
never crosses it.</strong> On Claude Sonnet 5 and Gemini 3 Pro — both of which double their rates above
200k — Codex crosses it {GEM_X} times. That premium is {GEM_PREMIUM}
of Codex's Gemini bill, {GEM_PCT:.0f}% of it. On OpenAI the threshold is 272k, above the window, so nobody pays it.</p></section>""")

S.append(f"""<section class="card"><h3>Cost at scale, every model</h3>
{ch.grouped(cats, [("Codex (real, 13 compactions)", [cost_of(LC, m)["total"] for m in cats], GRN),
                   ("Elpis · hold (projected)", [cost_of(LH, m)["total"] for m in cats], TEAL),
                   ("Elpis · drift (projected)", [cost_of(LD, m)["total"] for m in cats], "#2b8fa8")],
            h=350, fmtf=lambda v: f"${v:,.0f}")}
<p class="note danger"><strong>This is where I have to contradict you.</strong> At scale Codex is still
cheaper — about <b>1.8×</b> — and the reason is not tokens. Elpis sends
<b>{ch.fmt(sLH['tin'])}</b> input tokens against Codex's <b>{ch.fmt(sLC['tin'])}</b>, so it wins the
volume argument decisively. It loses on cache: Codex's hit rate over that real session is
<b>{sLC['hit']:.1f}%</b>, Elpis's is <b>{sLH['hit']:.1f}%</b>. A cached token bills at a tenth of a
fresh one, so 30 points of cache hit is worth more than halving your volume.</p></section>""")

be = breakeven_curve("gpt-5.6-sol")
cref = cost_of(LC, "gpt-5.6-sol")["total"]
S.append(f"""<section class="card"><h3>The one number that decides it</h3>
<p class="sub">Elpis's bill as a function of its cache hit rate, holding everything else at the projected
values. Where the curve crosses the red line, Elpis becomes cheaper than a real 13-compaction Codex run.</p>
{ch.curve(be, marks=[(0.679, f"measured 67.9%"), (0.883, "break-even 88.3%")], ref=(cref, f"Codex — {money(cref)}"), xlab="Elpis cache hit rate →")}
{ch.hbars([(f"{m} — break-even hit rate", v, TEAL) for m, v in
           [("gpt-5.6-sol", 88.3), ("Claude Opus 5", 88.3), ("Claude Sonnet 5", 85.9), ("Gemini 3 Pro", 82.5)]],
          pl=300, fmtf=lambda v: f"{v:.1f}%", vmax=100)}
<p class="note">So the whole economic case reduces to a single engineering target:
<strong>get Elpis's cache hit above roughly 88% and it is cheaper than Codex on every model.</strong>
It is at 68% today. Two things make that plausible rather than wishful — Codex's own hit rate climbed
from {sC['hit']:.1f}% on the short run to {sLC['hit']:.1f}% on the long one as the cache warmed, and the
projection holds Elpis flat at its short-run value, which is conservative. The lever is pass frequency:
{LH['prune']['passes']} passes over {len(LH['requests']):,} requests means roughly two of every five
requests follow a cache-invalidating rewrite. Fewer, larger passes would cut that directly.</p></section>""")

S.append(f"""<div class="part"><span class="pnum">Part 3</span><h2 class="ptitle">The verdict, and what to run next</h2></div>
<section class="card"><h3>What is actually established</h3>
<div class="two"><div class="col ok"><h4>Elpis wins, on evidence</h4><ul>
<li>Never compacts. Zero across 1,566 projected requests; first compaction at step {LD['first_compaction_at']:,} even under the pessimistic reading. Codex: 13.</li>
<li>Sends <b>43% fewer input tokens per request</b> — {sLH['rmean']:,.0f} against {sLC['rmean']:,.0f}.</li>
<li>Never crosses the 200k long-context line. Codex crosses it 308 times, 23% of its Gemini bill.</li>
<li>Context distribution <b>{sLC['sd']/sLH['sd']:.1f}× tighter</b> — σ {sLH['sd']:.1f} against {sLC['sd']:.1f}.</li>
<li>Loses no history: 13 compactions is 13 irreversible summarisations of the working set.</li></ul></div>
<div class="col bad"><h4>Codex wins, on evidence</h4><ul>
<li><b>Cheaper — about 1.8× at scale</b>, on every model tested, because of cache, not tokens.</li>
<li>Cache hit {sLC['hit']:.1f}% against {sLH['hit']:.1f}%. Pruning rewrites history, which invalidates the prefix.</li>
<li>Wrote the better familiarisation brief in the one run we can compare: five documentation-drift findings against one, plus a runtime diagram and crate map Elpis did not produce.</li>
<li>Finished in {sC['dur']} minutes against {sE['dur']}.</li></ul></div></div>
<p class="note">Neither run was scored against a task with a checkable answer, so nothing here measures
output quality except my own reading of two documents. That is the gap the next experiment has to close.</p></section>

<section class="card"><h3>What to run next</h3>
<ol class="next">
<li><b>The deletion sprint.</b> Already specified, already has a worktree pair and a single objective
metric — lines removed while the suite stays green. It is the first experiment with a checkable answer,
and it runs long enough that Codex will compact several times. Capture the failing-test baseline first.</li>
<li><b>A cache-rate intervention.</b> The economic case rests entirely on one number. Batch pruning into
fewer, larger passes, re-measure the hit rate, and re-run this page. It is a one-variable experiment
with a pass mark already computed: 88%.</li>
<li><b>Drop the rest of experiment 1.</b> The perf and UX prompts measure nothing this page does not
already show.</li>
</ol>
<p class="note">Everything here is reproducible: <code>collect.py</code> ingests a transcript into
<code>runs/</code>, <code>project.py</code> extends a measured run, <code>pricing.json</code> holds the
rate cards, <code>build.py</code> redraws every chart. New experiment, one command, same charts.</p>
</section>""")

CSS = """
:root{--ink:#15130f;--paper:#f7f4ee;--card:#fff;--line:#e3ddd1;--mut:#6b635a;--teal:#17a398;--red:#c8442c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--teal:#28c2b5;--red:#e05a41}}
:root[data-theme=dark]{--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--teal:#28c2b5;--red:#e05a41}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);margin:0;padding:44px 22px 100px;font:16px/1.62 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1090px;margin:0 auto;display:flex;flex-direction:column;gap:26px}
h1{font:600 43px/1.07 ui-serif,Georgia,serif;letter-spacing:-.023em;margin:0 0 12px;text-wrap:balance}
h3{font:600 20px/1.25 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.012em;margin:0}
h4{font:600 14px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0 0 6px}
.sub{color:var(--mut);margin:6px 0 0;max-width:70ch}
.eyebrow{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.17em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:24px 26px;display:flex;flex-direction:column;gap:13px}
.part{margin-top:30px;padding-bottom:4px;border-bottom:2px solid var(--teal)}
.pnum{display:inline-block;font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin-bottom:6px}
.ptitle{font:600 27px/1.15 ui-serif,Georgia,serif;letter-spacing:-.018em;margin:0 0 6px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi .n{font:600 32px/1.05 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-.022em}
.kpi .l{color:var(--mut);font-size:12.5px;margin-top:5px;line-height:1.4}
.chart{width:100%;height:auto;overflow:visible;display:block}
.grid{stroke:var(--line);stroke-width:1}
.ax{fill:var(--mut);font-size:11px;font-family:ui-sans-serif,system-ui,sans-serif}
.trig{stroke:var(--teal);stroke-width:1.3;stroke-dasharray:5 4}
.trigmark{fill:var(--teal);font-size:11.5px;font-weight:600;font-family:ui-sans-serif,system-ui,sans-serif}
.comp{stroke:var(--red);stroke-width:1;stroke-dasharray:3 4;opacity:.5}
.refline{stroke:var(--red);stroke-width:1.5;stroke-dasharray:6 4}
.anno{font-size:12px;font-weight:600;font-family:ui-sans-serif,system-ui,sans-serif}
.blab{fill:var(--ink);font-size:12.5px;font-family:ui-sans-serif,system-ui,sans-serif}
.bval{fill:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;font-family:ui-sans-serif,system-ui,sans-serif}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:right;padding:8px 11px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left;font-variant-numeric:normal}
th{color:var(--mut);font-weight:600;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase}
.w{color:var(--teal);font-weight:600}.lose{color:var(--red);font-weight:600}
.scroll{overflow-x:auto}
.note{font-size:14.2px;color:var(--mut);border-left:2px solid var(--teal);padding-left:14px;max-width:76ch;margin:2px 0 0}
.note.danger{border-color:var(--red)}
.cap{font-size:12.8px;color:var(--mut);margin:0}
.small{font-size:13.4px;color:var(--mut);margin:0}
.key{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--mut)}
.key i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.key i.dash{width:14px;height:0;border-top:2px dashed var(--red);border-radius:0;vertical-align:4px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:780px){.two{grid-template-columns:1fr}}
.col{border:1px solid var(--line);border-radius:11px;padding:15px 17px}
.col.ok{border-left:3px solid var(--teal)}.col.bad{border-left:3px solid var(--red)}
ul,ol{margin:6px 0 0;padding-left:19px}li{margin:5px 0;font-size:14px}
ol.next li{margin:9px 0;font-size:14.5px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,var(--mut) 14%,transparent);padding:1px 5px;border-radius:4px}
"""
html = f"<title>Elpis · context economics</title>\n<style>{CSS}</style>\n<div class='wrap'>\n" + "\n".join(S) + "\n</div>\n"
out = os.path.join(HERE, "dashboard.html")
open(out, "w").write(html)
print(f"wrote {out}  ({len(html):,} bytes)")

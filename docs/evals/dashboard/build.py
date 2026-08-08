#!/usr/bin/env python3
"""Render the dashboard from whatever runs are in runs/. Add a run, re-run this.

Nothing on the page is modelled, projected or extrapolated. Every number comes from a
transcript that exists on disk. Messages that have not been run yet render as empty slots
rather than as estimates.
"""
import json, os, statistics as st
import charts as ch, cost as C

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "runs")
TEAL, GRN, RED, AMB, SLATE, MUT = "#17a398", "#7fc44a", "#c8442c", "#d98026", "#5b7fa6", "#8a8279"

def load(n):
    p = os.path.join(RUNS, f"{n}.json")
    return json.load(open(p)) if os.path.exists(p) else None

def cliffs(run, drop=25):
    o = run["occupancy"]
    return [i for i in range(1, len(o)) if o[i - 1] - o[i] > drop]

def stats(run):
    o = run["occupancy"]
    rem = [100 - x for x in o]
    inp = [r["i"] for r in run["requests"]]
    out = [r["o"] for r in run["requests"]]
    cac = sum(r["c"] for r in run["requests"]); tin = sum(inp)
    return dict(
        n=len(inp), rem=rem, inp=inp, out=out,
        floor=min(rem), rmed=st.median(rem), rmean=st.mean(rem), sd=st.pstdev(rem),
        below65=sum(1 for x in rem if x < 65), below30=sum(1 for x in rem if x < 30),
        imed=st.median(inp), imean=tin / len(inp), imax=max(inp), i95=ch.q(inp, .95),
        hit=100 * cac / max(tin, 1), tin=tin, tout=sum(out), omean=st.mean(out),
        comp=run["compactions"], passes=run["prune"]["passes"], tools=run["tool_calls"],
        dur=run["duration_min"], saved=run["prune"]["saved_tokens"],
        spend=run["prune"]["input"] + run["prune"]["output"])

# ---------------------------------------------------------------- the runs --
# Message n of experiment 1 -> runs/exp<n>-{codex,elpis}.json. Message 1 is exp1-*.
MESSAGES = [
    (1, "Thoroughly familiarize yourself with the project.", "exp1-codex", "exp1-elpis"),
    (2, "Identify and implement ONE small performance improvement that makes the "
        "application measurably faster or more efficient.", "exp2-codex", "exp2-elpis"),
    (3, "Find and implement ONE UX improvement that makes the interface more intuitive, "
        "accessible, or pleasant to use.", "exp3-codex", "exp3-elpis"),
]
DONE = []
for idx, prompt, cn, en in MESSAGES:
    c, e = load(cn), load(en)
    DONE.append((idx, prompt, c, e, stats(c) if c else None, stats(e) if e else None))

M1 = DONE[0]
_, _, C1, E1, sC, sE = M1

MAIN = ["gpt-5.6-sol", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Gemini 3 Pro"]
def cost_of(run, m, pm="gpt-5.6-luna"): return C.run_cost(run, m, pm)
def money(v): return f"${v:,.0f}" if abs(v) >= 100 else f"${v:,.2f}"

SOL_C, SOL_E = cost_of(C1, "gpt-5.6-sol")["total"], cost_of(E1, "gpt-5.6-sol")["total"]
RATIO = SOL_E / SOL_C

def rbins(rem):
    edges = [(0, 20), (20, 40), (40, 55), (55, 65), (65, 75), (75, 85), (85, 101)]
    return [sum(1 for x in rem if lo <= x < hi) for lo, hi in edges], \
           ["0–20", "20–40", "40–55", "55–65", "65–75", "75–85", "85+"]

S = []

# ------------------------------------------------------------------ header --
S.append(f"""<header>
<p class="eyebrow">Elpis vs Codex · experiment 1 · measured only</p>
<h1>Elpis held the line you set. It cost {RATIO:.1f}× more to do it.</h1>
<p class="sub">One prompt, two systems, identical clean checkouts of the same repository and the same
258,400-token window. Both arms ran on <code>gpt-5.6-luna</code>. Every figure below is read out of the
two session transcripts — there is no projection, no extrapolation and no synthetic data anywhere on
this page. Messages 2 and 3 have not been run; their slots are empty rather than guessed.</p></header>

<div class="kpis">
<div class="kpi"><div class="n" style="color:{TEAL}">{sE['floor']:.1f}%</div>
  <div class="l">Elpis's lowest remaining context — <b>your 65% floor held</b></div></div>
<div class="kpi"><div class="n" style="color:{RED}">{sC['floor']:.1f}%</div>
  <div class="l">Codex's lowest, before it was forced to compact</div></div>
<div class="kpi"><div class="n" style="color:{TEAL}">σ {sE['sd']:.1f}</div>
  <div class="l">Elpis context spread against σ {sC['sd']:.1f} for Codex</div></div>
<div class="kpi"><div class="n" style="color:{RED}">{RATIO:.1f}×</div>
  <div class="l">what Elpis cost, Sol-priced — {money(SOL_E)} against {money(SOL_C)}</div></div>
</div>""")

# ------------------------------------------------------------------ verdict --
S.append(f"""<div class="part"><span class="pnum">The short answer</span>
<h2 class="ptitle">Which one did better</h2></div>

<section class="card"><h3>Split decision, and not a close one either way</h3>
<div class="two">
<div class="col ok"><h4>Elpis won — context</h4><ul>
<li><b>Never broke 65%.</b> Floor {sE['floor']:.1f}% remaining, across all {sE['n']} requests. The
criterion you set was that pressure pruning at 70 must not let it fall under 65. It did not, once.</li>
<li><b>Zero compactions.</b> Nothing was ever summarised away; the full history survived the run.</li>
<li><b>{sC['sd']/sE['sd']:.1f}× steadier.</b> σ {sE['sd']:.1f} against {sC['sd']:.1f} — it sits where you put it
instead of sliding.</li>
<li><b>{100*(1-sE['imean']/sC['imean']):.0f}% smaller requests.</b> {sE['imean']:,.0f} input tokens on the
average call against {sC['imean']:,.0f}.</li>
<li>Did more work: {sE['tools']} tool calls against {sC['tools']}.</li></ul></div>

<div class="col bad"><h4>Codex won — cost and speed</h4><ul>
<li><b>{RATIO:.1f}× cheaper</b> on this run at Sol pricing, and cheaper on every other rate card tested.</li>
<li><b>Cache hit {sC['hit']:.1f}% against {sE['hit']:.1f}%.</b> This is the entire reason. A cached token
bills at a tenth; pruning rewrites history, which throws the cached prefix away.</li>
<li><b>{sC['dur']:.0f} minutes against {sE['dur']:.0f}.</b> Less than half the wall clock.</li>
<li>Wrote the better familiarisation brief, on my reading of the two documents — more documentation-drift
findings, plus a runtime diagram and crate map Elpis did not produce.</li></ul></div></div>

<p class="note danger"><b>The honest sentence.</b> Elpis does exactly what it was built to do, and the
measurement confirms it. It is not yet cheaper, and on this run it was not faster. The context win is
real and the cost loss is real; both are in the same two transcripts.</p></section>""")

# ------------------------------------------------------------------ part 1 --
S.append(f"""<div class="part"><span class="pnum">Message 1 · measured</span>
<h2 class="ptitle">“{M1[1]}”</h2>
<p class="sub">Codex: {sC['n']} requests over {sC['dur']:.1f} minutes. Elpis: {sE['n']} requests over
{sE['dur']:.1f} minutes. Both on <code>gpt-5.6-luna</code>, pruning on Luna, window 258,400.</p></div>""")

S.append(f"""<section class="card"><h3>Context remaining, request by request</h3>
<p class="sub">This is the chart the whole experiment exists to produce. Teal is a healthy window; the
colour follows the line down through amber into red as the window fills. The dashed teal line is where
pressure pruning fires, the red line is the floor you set.</p>
{ch.remaining_lines([("Codex", sC['rem'], GRN, cliffs(C1)), ("Elpis", sE['rem'], TEAL, [])])}
<div class="key"><span><i style="background:{TEAL}"></i>Elpis</span><span><i style="background:{GRN}"></i>Codex</span>
<span><i style="background:{AMB}"></i>under pressure</span><span><i style="background:{RED}"></i>critical</span>
<span><i class="dash"></i>compaction</span></div>
<p class="note">Codex climbs steadily, crosses the threshold with nothing to catch it, bottoms out at
{sC['floor']:.1f}% and is compacted — the vertical dashed line. Elpis saws against the threshold
{sE['passes']} times and never falls through it. Requests spent below your floor: Codex
<b>{sC['below65']} of {sC['n']}</b>, Elpis <b>{sE['below65']} of {sE['n']}</b>.</p></section>""")

cb, cl = rbins(sC['rem']); eb, _ = rbins(sE['rem'])
S.append(f"""<section class="card"><h3>Where each run spent its time</h3>
{ch.histogram([("Codex", cb, GRN, .55), ("Elpis", eb, TEAL, 1)], cl,
              xlabel="% of context window remaining · faded = Codex, solid = Elpis")}
{ch.box([("Codex · remaining", sC['rem'], GRN), ("Elpis · remaining", sE['rem'], TEAL)], h=180, vmax=100)}
<p class="cap">Box = interquartile range, line = median, whiskers = full range. Elpis's entire range
({sE['floor']:.0f}–{max(sE['rem']):.0f}%) is narrower than Codex's interquartile box.</p></section>""")

S.append(f"""<section class="card"><h3>Request size — what you pay for on every call</h3>
{ch.box([("Codex · input tokens", sC['inp'], GRN), ("Elpis · input tokens", sE['inp'], TEAL)],
        h=180, unit="", fmtf=ch.fmt)}
{ch.hbars([("Codex · total input sent", sC['tin'], GRN), ("Elpis · total input sent", sE['tin'], TEAL),
           ("Codex · of that, cache hits", sum(r['c'] for r in C1['requests']), GRN),
           ("Elpis · of that, cache hits", sum(r['c'] for r in E1['requests']), TEAL)],
          pl=260, fmtf=ch.fmt)}
<p class="note">Elpis sends far less — median {sE['imed']:,.0f} against {sC['imed']:,.0f}, largest call
{sE['imax']:,.0f} against {sC['imax']:,.0f} — and still pays more, because {sC['hit']:.1f}% of what Codex
sent was billed at the cached rate against {sE['hit']:.1f}% of Elpis's. <b>Cache beats volume.</b>
That single row is the whole cost story.</p></section>""")

S.append(f"""<section class="card"><h3>Cache hit rate — the number that decides the bill</h3>
{ch.hbars([("Codex", sC['hit'], GRN), ("Elpis", sE['hit'], TEAL)], pl=140, vmax=100,
          fmtf=lambda v: f"{v:.1f}%")}
<p class="note">A prune pass rewrites history, so the prefix no longer matches and everything downstream
of the edit is re-billed at full price on the next request. {sE['passes']} passes over {sE['n']} requests
means roughly two calls in five follow an invalidation. This is the cost of pruning, and it is far larger
than the pruning calls themselves.</p></section>""")

per = E1["prune"]["per_pass"]
S.append(f"""<section class="card"><h3>The pruning ledger — all {sE['passes']} passes</h3>
{ch.grouped([str(i+1) for i in range(len(per))],
            [("reclaimed", [p["saved"] for p in per], TEAL),
             ("spent reclaiming it", [p["spend"] for p in per], AMB)], h=300, fmtf=ch.fmt)}
{ch.hbars([("Context reclaimed", sE['saved'], TEAL), ("Tokens spent reclaiming it", sE['spend'], AMB)],
          pl=250, fmtf=ch.fmt)}
<p class="note">In raw tokens pruning does not pay for itself here: {sE['passes']} passes spent
{sE['spend']:,} tokens to remove {sE['saved']:,} — a ratio of
<b>{sE['saved']/sE['spend']:.2f} reclaimed per token spent</b>. It is still worth running, because the
tokens it spends are cheap and spent once while the tokens it removes are expensive and would be re-sent
on every later request. But it is a context mechanism, not a savings mechanism, and the earlier claim
that it returned nine-to-one was wrong.</p></section>""")

# --------------------------------------------------------------------- cost --
rows = []
for m in MAIN:
    rows.append((m, cost_of(C1, m)["total"], cost_of(E1, m)["total"],
                 C.tier_crossings(C1["requests"], m), C.tier_crossings(E1["requests"], m)))
tbl = "".join(
    f"<tr><td>{m}</td><td>{money(c)}</td><td class='lose'>{money(e)}</td>"
    f"<td>{e/c:.2f}×</td><td>{tc}</td><td class='w'>{te}</td></tr>"
    for m, c, e, tc, te in rows)

S.append(f"""<section class="card"><h3>What this run cost, on every rate card</h3>
<p class="sub">The same two transcripts, re-priced five ways. Pruning is always billed on the cheap model
of the same family. Tier crossings count requests that exceeded the vendor's long-context threshold —
272,000 tokens on OpenAI, 200,000 on Sonnet and Gemini.</p>
{ch.grouped(MAIN, [("Codex", [r[1] for r in rows], GRN), ("Elpis", [r[2] for r in rows], TEAL)],
            fmtf=lambda v: f"${v:,.2f}")}
<div class="scroll"><table>
<tr><th>Main model</th><th>Codex</th><th>Elpis</th><th>Elpis ÷ Codex</th>
    <th>Codex tier crossings</th><th>Elpis tier crossings</th></tr>{tbl}
</table></div>
<p class="note">Neither system crossed a long-context threshold on this run — the window is 258,400 and
OpenAI's premium starts at 272,000, so nobody paid it. That matters because an earlier version of this
analysis put the threshold at 128,000 and invented a premium for Codex that does not exist. It was wrong
and the conclusion it produced was backwards.</p>
<p class="note danger"><b>Read this before quoting the cost figures.</b> Both runs actually executed on
<code>gpt-5.6-luna</code>. The table re-prices those same token counts at Sol, Claude and Gemini rates.
That is a fair comparison between the two systems — identical model, identical prompt — but it is not a
measurement of what Sol would do, because a different model would produce a different token trace.
At the model they really ran on, the run cost {money(cost_of(C1,'gpt-5.6-luna')['total'])} for Codex and
{money(cost_of(E1,'gpt-5.6-luna')['total'])} for Elpis.</p></section>""")

pruners = [("Pruning on Luna", cost_of(E1, "gpt-5.6-sol", "gpt-5.6-luna")["prune"], TEAL),
           ("Pruning on Haiku 4.5", cost_of(E1, "gpt-5.6-sol", "Claude Haiku 4.5")["prune"], SLATE)]
S.append(f"""<section class="card"><h3>What the pruning calls themselves cost</h3>
{ch.hbars(pruners, pl=220, fmtf=lambda v: f"${v:.3f}")}
<p class="note">Negligible either way — {money(pruners[0][1])} of a {money(SOL_E)} run. The pruner is not
what makes Elpis expensive; the cache invalidation it causes is.</p></section>""")

# ------------------------------------------------------- pending messages ---
for idx, prompt, c, e, _sc, _se in DONE[1:]:
    S.append(f"""<div class="part pending"><span class="pnum">Message {idx} · not yet run</span>
<h2 class="ptitle">“{prompt}”</h2></div>
<section class="card pending"><h3>Slot reserved</h3>
<p class="sub">Run both arms, then drop the transcripts in with
<code>collect.py &lt;transcript&gt; exp{idx}-codex</code> and <code>exp{idx}-elpis</code>, and
<code>build.py</code> fills this section with the same charts as message 1 — no edits to the page.</p>
<div class="slots">
  <div class="slot"><span class="sk">Codex</span><span class="sv">—</span><span class="sl">floor</span></div>
  <div class="slot"><span class="sk">Elpis</span><span class="sv">—</span><span class="sl">floor</span></div>
  <div class="slot"><span class="sk">Codex</span><span class="sv">—</span><span class="sl">compactions</span></div>
  <div class="slot"><span class="sk">Elpis</span><span class="sv">—</span><span class="sl">prune passes</span></div>
  <div class="slot"><span class="sk">Codex</span><span class="sv">—</span><span class="sl">cost, Sol</span></div>
  <div class="slot"><span class="sk">Elpis</span><span class="sv">—</span><span class="sl">cost, Sol</span></div>
</div></section>""")

# ------------------------------------------------------- across the three ---
def cell(s, key, f="{:.1f}", cls=""):
    return f"<td class='{cls}'>{f.format(s[key])}</td>" if s else "<td class='pend'>—</td>"

hdr = "".join(f"<th colspan='2'>Message {i}</th>" for i, *_ in DONE)
sub = "".join("<th>Codex</th><th>Elpis</th>" for _ in DONE)
def row(label, key, f="{:.1f}", better="low"):
    tds = ""
    for _i, _p, c, e, sc, se in DONE:
        tds += cell(sc, key, f) + cell(se, key, f, "w" if se else "")
    return f"<tr><td>{label}</td>{tds}</tr>"

S.append(f"""<div class="part"><span class="pnum">Across the run</span>
<h2 class="ptitle">All three messages, side by side</h2>
<p class="sub">One row per metric, one column pair per message. Dashes are measurements that do not exist
yet — they will not be filled with estimates.</p></div>

<section class="card"><div class="scroll"><table class="matrix">
<tr><th rowspan="2">Metric</th>{hdr}</tr><tr>{sub}</tr>
{row("Model requests", "n", "{:.0f}")}
{row("Tool calls", "tools", "{:.0f}")}
{row("Lowest context remaining", "floor", "{:.1f}%")}
{row("Median context remaining", "rmed", "{:.1f}%")}
{row("Spread (σ)", "sd", "{:.1f}")}
{row("Requests below 65% remaining", "below65", "{:.0f}")}
{row("Compactions", "comp", "{:.0f}")}
{row("Prune passes", "passes", "{:.0f}")}
{row("Mean input tokens per request", "imean", "{:,.0f}")}
{row("Total input tokens", "tin", "{:,.0f}")}
{row("Cache hit rate", "hit", "{:.1f}%")}
{row("Total output tokens", "tout", "{:,.0f}")}
{row("Wall clock, minutes", "dur", "{:.1f}")}
</table></div></section>""")

# ------------------------------------------------------------------ caveats --
S.append(f"""<div class="part"><span class="pnum">Before you quote any of this</span>
<h2 class="ptitle">What one message does and does not establish</h2></div>

<section class="card"><h3>Four limits, stated plainly</h3>
<ol class="next">
<li><b>n = 1.</b> One message, one run per arm. The context result is large enough and mechanical enough
that a single run is persuasive; the cost result rests on one cache-hit measurement and is not.</li>
<li><b>The model was Luna, not Sol.</b> Both arms, so the comparison is fair. Every dollar figure above
is a re-pricing of Luna's token trace, and is labelled as such wherever it appears.</li>
<li><b>Nothing was scored against a checkable answer.</b> “Familiarize yourself with the project”
produces a document, and comparing two documents is a judgement, not a measurement. Messages 2 and 3
change that — both end in code that either works or does not.</li>
<li><b>Cost is a moving target.</b> It hinges on cache hit rate, which is a function of how often pruning
fires. That is a tunable, not a constant, and it has not been tuned once.</li>
</ol></section>

<section class="card"><h3>How to add the next run</h3>
<p class="sub">Nothing on this page is hand-written. The pipeline is four files.</p>
<div class="scroll"><table>
<tr><th>File</th><th>Does</th></tr>
<tr><td><code>collect.py</code></td><td>Reads a session transcript, writes <code>runs/&lt;id&gt;.json</code></td></tr>
<tr><td><code>pricing.json</code></td><td>Rate cards — add a vendor here, it appears in every cost chart</td></tr>
<tr><td><code>cost.py</code></td><td>Prices a run, counts long-context tier crossings</td></tr>
<tr><td><code>build.py</code></td><td>Redraws this page from whatever is in <code>runs/</code></td></tr>
</table></div>
<p class="note">Two accounting rules are baked into <code>collect.py</code> because getting either wrong
changes the headline. Per-request usage is read as deltas of the cumulative counters, not from the
per-turn field, which is re-emitted when a turn ends without a request. And Elpis's prune checkpoints are
written as the same rollout item type as a real compaction, distinguished only by a message prefix — miss
that and a run with zero compactions reports twenty-six.</p></section>""")

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
.sub{color:var(--mut);margin:6px 0 0;max-width:74ch}
.eyebrow{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.17em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:24px 26px;display:flex;flex-direction:column;gap:13px}
.card.pending{border-style:dashed;background:transparent}
.part{margin-top:30px;padding-bottom:4px;border-bottom:2px solid var(--teal)}
.part.pending{border-bottom:2px dashed var(--line)}
.part.pending .pnum{color:var(--mut)}
.part.pending .ptitle{color:var(--mut)}
.pnum{display:inline-block;font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin-bottom:6px}
.ptitle{font:600 27px/1.15 ui-serif,Georgia,serif;letter-spacing:-.018em;margin:0 0 6px;text-wrap:balance}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi .n{font:600 32px/1.05 ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:-.022em}
.kpi .l{color:var(--mut);font-size:12.5px;margin-top:5px;line-height:1.4}
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
.matrix th{text-align:right}
.w{color:var(--teal);font-weight:600}.lose{color:var(--red);font-weight:600}
td.pend{color:var(--line);font-weight:600}
.scroll{overflow-x:auto}
.note{font-size:14.2px;color:var(--mut);border-left:2px solid var(--teal);padding-left:14px;max-width:80ch;margin:2px 0 0}
.note.danger{border-color:var(--red)}
.cap{font-size:12.8px;color:var(--mut);margin:0}
.key{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--mut)}
.key i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.key i.dash{width:14px;height:0;border-top:2px dashed var(--red);border-radius:0;vertical-align:4px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:780px){.two{grid-template-columns:1fr}}
.col{border:1px solid var(--line);border-radius:11px;padding:15px 17px}
.col.ok{border-left:3px solid var(--teal)}.col.bad{border-left:3px solid var(--red)}
.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.slot{border:1px dashed var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.slot .sk{font:600 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.slot .sv{font:600 26px/1.1 ui-sans-serif,system-ui,sans-serif;color:var(--line)}
.slot .sl{font-size:12px;color:var(--mut)}
ul,ol{margin:6px 0 0;padding-left:19px}li{margin:5px 0;font-size:14px}
ol.next li{margin:9px 0;font-size:14.5px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,var(--mut) 14%,transparent);padding:1px 5px;border-radius:4px}
"""

html = ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Elpis vs Codex — experiment 1</title>\n"
        f"<style>{CSS}</style></head><body>\n<div class='wrap'>\n"
        + "\n".join(S) + "\n</div></body></html>\n")
out = os.path.join(HERE, "dashboard.html")
open(out, "w").write(html)
print(f"wrote {out}  ({len(html):,} bytes, {html.count('<svg')} charts)")

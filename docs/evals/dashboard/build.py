#!/usr/bin/env python3
"""Render the dashboard from whatever runs are in runs/. Add a run, re-run this.

Two standing rules for this file:
  - Nothing is modelled, projected or extrapolated. A message that has not been run
    renders as an empty slot, never as an estimate.
  - The page states what was measured. It does not rank the systems, declare a winner,
    or recommend what to do next.
"""
import json, os, statistics as st
import charts as ch, cost as C

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "runs")
TEAL, GRN, RED, AMB, SLATE = "#17a398", "#7fc44a", "#c8442c", "#d98026", "#5b7fa6"

def load(n):
    p = os.path.join(RUNS, f"{n}.json")
    return json.load(open(p)) if os.path.exists(p) else None

def cliffs(run, drop=25):
    o = run["occupancy"]
    return [i for i in range(1, len(o)) if o[i - 1] - o[i] > drop]

def stats(run):
    rem = [100 - x for x in run["occupancy"]]
    inp = [r["i"] for r in run["requests"]]
    out = [r["o"] for r in run["requests"]]
    cac = sum(r["c"] for r in run["requests"]); tin = sum(inp)
    return dict(
        n=len(inp), rem=rem, inp=inp, out=out, cached=cac, fresh=tin - cac,
        floor=min(rem), rmed=st.median(rem), rmean=st.mean(rem), sd=st.pstdev(rem),
        below65=sum(1 for x in rem if x < 65), imed=st.median(inp), imean=tin / len(inp),
        imax=max(inp), hit=100 * cac / max(tin, 1), tin=tin, tout=sum(out),
        comp=run["compactions"], passes=run["prune"]["passes"], tools=run["tool_calls"],
        dur=run["duration_min"], saved=run["prune"]["saved_tokens"],
        spend=run["prune"]["input"] + run["prune"]["output"])

# Message n of experiment 1 -> runs/exp<n>-{codex,elpis}.json.
MESSAGES = [
    (1, "Thoroughly familiarize yourself with the project.", "exp1-codex", "exp1-elpis"),
    (2, "Identify and implement ONE small performance improvement that makes the "
        "application measurably faster or more efficient.", "exp2-codex", "exp2-elpis"),
    (3, "Find and implement ONE UX improvement that makes the interface more intuitive, "
        "accessible, or pleasant to use.", "exp3-codex", "exp3-elpis"),
]
DONE = [(i, p, load(cn), load(en)) for i, p, cn, en in MESSAGES]
DONE = [(i, p, c, e, stats(c) if c else None, stats(e) if e else None) for i, p, c, e in DONE]
_, PROMPT1, C1, E1, sC, sE = DONE[0]

MAIN = ["gpt-5.6-sol", "gpt-5.6-terra", "Claude Fable 5", "Claude Opus 5", "Claude Sonnet 5", "Gemini 3 Pro"]
def cost_of(run, m, pm="gpt-5.6-luna"): return C.run_cost(run, m, pm)
def money(v): return f"${v:,.0f}" if abs(v) >= 100 else f"${v:,.2f}"
SOL_C, SOL_E = cost_of(C1, "gpt-5.6-sol")["total"], cost_of(E1, "gpt-5.6-sol")["total"]

def rbins(rem):
    edges = [(0, 20), (20, 40), (40, 55), (55, 65), (65, 75), (75, 85), (85, 101)]
    return [sum(1 for x in rem if lo <= x < hi) for lo, hi in edges], \
           ["0–20", "20–40", "40–55", "55–65", "65–75", "75–85", "85+"]

S = []

# ------------------------------------------------------------------ header --
S.append(f"""<header>
<p class="eyebrow">Elpis vs Codex · experiment 1 · measured data only</p>
<h1>One prompt, two systems, two transcripts.</h1>
<p class="sub">Identical clean checkouts of the same repository, the same 258,400-token window, the same
prompt. Both arms ran on <code>gpt-5.6-luna</code>. Every figure on this page is read out of the two
session rollouts on disk — nothing is projected, extrapolated or synthesised. Messages 2 and 3 have not
been run; their slots are empty rather than estimated.</p></header>

<div class="kpis">
<div class="kpi"><div class="k">Lowest context remaining</div>
  <div class="n"><span style="color:{GRN}">{sC['floor']:.1f}%</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{sE['floor']:.1f}%</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Compactions</div>
  <div class="n"><span style="color:{GRN}">{sC['comp']}</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{sE['comp']}</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Cache hit rate</div>
  <div class="n"><span style="color:{GRN}">{sC['hit']:.1f}%</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{sE['hit']:.1f}%</span></div><div class="l">Codex / Elpis</div></div>
<div class="kpi"><div class="k">Run cost, Sol-priced</div>
  <div class="n"><span style="color:{GRN}">{money(SOL_C)}</span> <span class="vs">/</span>
  <span style="color:{TEAL}">{money(SOL_E)}</span></div><div class="l">Codex / Elpis</div></div>
</div>""")

# ----------------------------------------------------------------- part 1 ---
S.append(f"""<div class="part"><span class="pnum">Message 1 · measured</span>
<h2 class="ptitle">“{PROMPT1}”</h2>
<p class="sub">Codex: {sC['n']} requests, {sC['tools']} tool calls, {sC['dur']:.1f} minutes.
Elpis: {sE['n']} requests, {sE['tools']} tool calls, {sE['dur']:.1f} minutes.</p></div>""")

S.append(f"""<section class="card"><h3>Context remaining, request by request</h3>
{ch.remaining_lines([("Codex", sC['rem'], GRN, cliffs(C1)), ("Elpis", sE['rem'], TEAL, [])])}
<div class="key"><span><i style="background:{TEAL}"></i>Elpis</span><span><i style="background:{GRN}"></i>Codex</span>
<span><i style="background:{AMB}"></i>under pressure</span><span><i style="background:{RED}"></i>critical</span>
<span><i class="dash"></i>compaction</span></div>
<p class="cap">Requests spent below 65% remaining — Codex {sC['below65']} of {sC['n']},
Elpis {sE['below65']} of {sE['n']}. Elpis ran {sE['passes']} prune passes; Codex ran
{sC['comp']} compaction.</p></section>""")

cb, cl = rbins(sC['rem']); eb, _ = rbins(sE['rem'])
S.append(f"""<section class="card"><h3>Distribution of context remaining</h3>
{ch.histogram([("Codex", cb, GRN, .55), ("Elpis", eb, TEAL, 1)], cl,
              xlabel="% of context window remaining · faded = Codex, solid = Elpis")}
{ch.box([("Codex", sC['rem'], GRN), ("Elpis", sE['rem'], TEAL)], h=180, vmax=100)}
<p class="cap">Box = interquartile range, line = median, whiskers = full range.
Codex σ {sC['sd']:.1f}, median {sC['rmed']:.1f}%. Elpis σ {sE['sd']:.1f}, median {sE['rmed']:.1f}%.</p>
</section>""")

S.append(f"""<section class="card"><h3>Input tokens per request</h3>
{ch.box([("Codex", sC['inp'], GRN), ("Elpis", sE['inp'], TEAL)], h=180, unit="", fmtf=ch.fmt)}
<p class="cap">Median {sC['imed']:,.0f} / {sE['imed']:,.0f}. Largest single request
{sC['imax']:,.0f} / {sE['imax']:,.0f}. Mean {sC['imean']:,.0f} / {sE['imean']:,.0f}.</p></section>""")

# ------------------------------------------------------- cost decomposition --
solt = C.PRICING["gpt-5.6-sol"]["tiers"][0]
bc = C.price(C1["requests"], "gpt-5.6-sol")[1]
be = C.price(E1["requests"], "gpt-5.6-sol")[1]
pce = cost_of(E1, "gpt-5.6-sol")["prune"]

S.append(f"""<section class="card"><h3>Where the money went — the arithmetic, Sol rates</h3>
<p class="sub">Three billed quantities. Fresh input is charged at <b>${solt['input']:.2f}</b> per million,
a cache hit at <b>${solt['hit']:.2f}</b> — one tenth — and output at <b>${solt['output']:.2f}</b>.</p>
{ch.hbars([("Codex · total input sent", sC['tin'], GRN), ("Elpis · total input sent", sE['tin'], TEAL),
           ("Codex · billed as cache hit", sC['cached'], GRN), ("Elpis · billed as cache hit", sE['cached'], TEAL),
           ("Codex · billed as FRESH", sC['fresh'], RED), ("Elpis · billed as FRESH", sE['fresh'], RED)],
          pl=270, fmtf=ch.fmt)}
<div class="scroll"><table>
<tr><th>Sol, per million</th><th>rate</th><th>Codex tokens</th><th>Codex $</th><th>Elpis tokens</th><th>Elpis $</th></tr>
<tr><td>Fresh input</td><td>${solt['input']:.2f}</td><td>{sC['fresh']:,}</td><td>{bc['fresh']:.2f}</td>
    <td class="lose">{sE['fresh']:,}</td><td class="lose">{be['fresh']:.2f}</td></tr>
<tr><td>Cached input</td><td>${solt['hit']:.2f}</td><td>{sC['cached']:,}</td><td>{bc['hit']:.2f}</td>
    <td>{sE['cached']:,}</td><td>{be['hit']:.2f}</td></tr>
<tr><td>Output</td><td>${solt['output']:.2f}</td><td>{sC['tout']:,}</td><td>{bc['output']:.2f}</td>
    <td>{sE['tout']:,}</td><td>{be['output']:.2f}</td></tr>
<tr><td>Pruning calls (Luna)</td><td>—</td><td>0</td><td>0.00</td>
    <td>{E1['prune']['input']+E1['prune']['output']:,}</td><td>{pce:.2f}</td></tr>
<tr class="tot"><td>Total</td><td></td><td>{sC['tin']:,}</td><td>{SOL_C:.2f}</td>
    <td>{sE['tin']:,}</td><td>{SOL_E:.2f}</td></tr>
</table></div>
<p class="cap">Elpis sent {sC['tin']-sE['tin']:,} <b>fewer</b> input tokens in total and
{sE['fresh']/sC['fresh']:.1f}× <b>more</b> fresh ones. The pruning calls are
{100*pce/SOL_E:.1f}% of Elpis's bill.</p></section>""")

rows = [(m, cost_of(C1, m)["total"], cost_of(E1, m)["total"],
         C.tier_crossings(C1["requests"], m), C.tier_crossings(E1["requests"], m)) for m in MAIN]
tbl = "".join(f"<tr><td>{m}</td><td>{money(c)}</td><td>{money(e)}</td><td>{e/c:.2f}×</td>"
              f"<td>{tc}</td><td>{te}</td></tr>" for m, c, e, tc, te in rows)
S.append(f"""<section class="card"><h3>The same two transcripts on six rate cards</h3>
{ch.grouped(MAIN, [("Codex", [r[1] for r in rows], GRN), ("Elpis", [r[2] for r in rows], TEAL)],
            fmtf=lambda v: f"${v:,.2f}")}
<div class="scroll"><table>
<tr><th>Main model</th><th>Codex</th><th>Elpis</th><th>Elpis ÷ Codex</th>
    <th>Codex tier crossings</th><th>Elpis tier crossings</th></tr>{tbl}</table></div>
{ch.hbars([(m, e/c, SLATE) for m, c, e, _, _ in rows], pl=200, fmtf=lambda v: f"{v:.2f}×")}
<p class="cap">Every rate card prices a cache hit at one tenth of fresh input, so the ratio barely moves
across vendors. Long-context tiers start at 272,000 tokens on OpenAI and 200,000 on Sonnet and Gemini;
the window here is 258,400, so no OpenAI request could cross one.</p>
<p class="note">Both arms actually executed on <code>gpt-5.6-luna</code>. Every figure above re-prices
that same token trace at other vendors' rates. At the model they really ran on the totals were
{money(cost_of(C1,'gpt-5.6-luna')['total'])} and {money(cost_of(E1,'gpt-5.6-luna')['total'])}.</p>
</section>""")

per = E1["prune"]["per_pass"]
S.append(f"""<section class="card"><h3>The pruning ledger — all {sE['passes']} passes</h3>
{ch.grouped([str(i+1) for i in range(len(per))],
            [("reclaimed", [p["saved"] for p in per], TEAL),
             ("spent reclaiming it", [p["spend"] for p in per], AMB)], h=300, fmtf=ch.fmt)}
{ch.hbars([("Context reclaimed", sE['saved'], TEAL), ("Tokens spent reclaiming it", sE['spend'], AMB),
           ("Pruning cost on Luna", cost_of(E1,'gpt-5.6-sol','gpt-5.6-luna')['prune']*1e6, TEAL),
           ("Pruning cost on Haiku 4.5", cost_of(E1,'gpt-5.6-sol','Claude Haiku 4.5')['prune']*1e6, SLATE)],
          pl=250, fmtf=ch.fmt)}
<p class="cap">{sE['passes']} passes spent {sE['spend']:,} tokens and removed {sE['saved']:,} —
{sE['saved']/sE['spend']:.2f} reclaimed per token spent. The last two bars are cost in millionths of a
dollar: {money(cost_of(E1,'gpt-5.6-sol','gpt-5.6-luna')['prune'])} on Luna,
{money(cost_of(E1,'gpt-5.6-sol','Claude Haiku 4.5')['prune'])} on Haiku 4.5.</p></section>""")

# ------------------------------------------------------- pending messages ---
for idx, prompt, c, e, _sc, _se in DONE[1:]:
    S.append(f"""<div class="part pending"><span class="pnum">Message {idx} · not yet run</span>
<h2 class="ptitle">“{prompt}”</h2></div>
<section class="card pending">
<p class="sub">Run both arms, then <code>python3 collect.py &lt;rollout.jsonl&gt; exp{idx}-codex</code> and
the same for <code>exp{idx}-elpis</code>, then <code>python3 build.py</code>. This section fills with the
same charts as message 1. No edits to the page.</p>
<div class="slots">""" + "".join(
        f'<div class="slot"><span class="sk">{who}</span><span class="sv">—</span>'
        f'<span class="sl">{lab}</span></div>'
        for lab in ("floor", "compactions / passes", "cache hit", "cost, Sol")
        for who in ("Codex", "Elpis")) + "</div></section>")

# ------------------------------------------------------- across the three ---
hdr = "".join(f"<th colspan='2'>Message {i}</th>" for i, *_ in DONE)
sub = "".join("<th>Codex</th><th>Elpis</th>" for _ in DONE)
def row(label, key, f="{:.1f}"):
    tds = ""
    for _i, _p, _c, _e, sc, se in DONE:
        for s in (sc, se):
            tds += f"<td>{f.format(s[key])}</td>" if s else "<td class='pend'>—</td>"
    return f"<tr><td>{label}</td>{tds}</tr>"

S.append(f"""<div class="part"><span class="pnum">Across the run</span>
<h2 class="ptitle">All three messages, side by side</h2>
<p class="sub">Dashes are measurements that do not exist yet. They will not be filled with estimates.</p></div>
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
{row("Mean input tokens / request", "imean", "{:,.0f}")}
{row("Total input tokens", "tin", "{:,.0f}")}
{row("Fresh (uncached) input tokens", "fresh", "{:,.0f}")}
{row("Cache hit rate", "hit", "{:.1f}%")}
{row("Total output tokens", "tout", "{:,.0f}")}
{row("Wall clock, minutes", "dur", "{:.1f}")}
</table></div></section>""")

# ------------------------------------------------------------- mechanism ----
S.append("""<div class="part"><span class="pnum">Mechanism</span>
<h2 class="ptitle">What sits between a tool's output and a full window</h2>
<p class="sub">Five layers, in the order they fire. Each sees only what the layer above let through.</p></div>

<section class="card"><div class="scroll"><table>
<tr><th>#</th><th>Layer</th><th>Where it acts</th><th>What it does to the text</th><th>Audit record</th></tr>
<tr><td>1</td><td><b>RTK</b></td><td>Outside the agent — wraps the command</td>
    <td>Filters output before a token reaches the context</td><td>external</td></tr>
<tr><td>2</td><td><b>Codex default</b></td><td>Inherited from upstream</td>
    <td>Blind truncation at a byte limit; the tail is gone</td><td class="lose">none</td></tr>
<tr><td>3</td><td><b>Ace</b> — automatic pruning</td><td>Between turns</td>
    <td>Reads each tool result, keeps the finding, replaces the noise with a pointer</td><td class="w">itemised</td></tr>
<tr><td>4</td><td><b>Forced pruning</b> — <code>/prune</code></td><td>On your trigger</td>
    <td>Same engine, your threshold</td><td class="w">itemised</td></tr>
<tr><td>5</td><td><b><code>/compact</code></b></td><td>Last resort</td>
    <td>Rewrites the whole conversation into a summary; detail does not survive</td><td class="lose">raw only</td></tr>
</table></div>
<p class="cap">Layer 5 is what fired once in the Codex arm above. Layers 3 and 4 are what fired 26 times
in the Elpis arm.</p></section>

<section class="card"><h3>One pruning decision, start to finish</h3>
<p class="sub">A single search command whose output ran to 18,930 characters.</p>
<div class="exhibit">
<div class="ex-head"><span>Before — what the model was carrying</span><b>18,930 chars</b></div>
<pre><span class="dim">Script completed · Wall time 0.1 seconds · Output:</span>

codex-rs/tui/src/external_agent_config_migration.rs:800:   item_type: …ItemType::AgentsMd,
codex-rs/tui/src/theme_picker.rs:283:fn theme_picker_subtitle(codex_home: …) -&gt; String
codex-rs/tui/src/theme_picker.rs:392:   subtitle: Some(theme_picker_subtitle(
codex-rs/tui/src/theme_picker.rs:605:   let subtitle = theme_picker_subtitle(…, Some(200));
codex-rs/tui/src/app_event.rs:152:   OpenAgentPicker,
<span class="dim">… roughly two hundred more lines of the same shape …</span></pre>
<div class="ex-head bt"><span>After — what the model carries now</span><b>1,290 chars</b></div>
<pre class="after"><span class="key2">[ELPIS CONTEXT UPDATE]</span>
kept=`/agent` and `/subagents` already open the agent picker
     — codex-rs/tui/src/chatwidget/slash_dispatch.rs:305
     — preserves the selected graph UX entry point
evidence=rollout://tool-call/call_0nK3lZKWgHXkqYoNy3Sux5Gj
original_chars=18199</pre>
</div>
<p class="cap"><code>evidence=</code> resolves to the untouched original, still in the session rollout.
Every pass records its decision, its replacement, and a pointer back to the live record.</p></section>""")

# --------------------------------------------------------------- provenance --
S.append(f"""<div class="part"><span class="pnum">Provenance</span>
<h2 class="ptitle">Where the numbers come from</h2></div>
<section class="card"><div class="scroll"><table>
<tr><th>Arm</th><th>Transcript</th><th>Working tree</th></tr>
<tr><td>Codex</td><td><code>{os.path.basename(C1['source'])}</code></td><td><code>Elpis-exp1-codex</code></td></tr>
<tr><td>Elpis</td><td><code>{os.path.basename(E1['source'])}</code></td><td><code>Elpis-exp1-elpis</code></td></tr>
</table></div>
<p class="sub">The pipeline is four files: <code>collect.py</code> turns a transcript into
<code>runs/&lt;id&gt;.json</code>, <code>pricing.json</code> holds the rate cards, <code>cost.py</code>
prices a run, <code>build.py</code> redraws this page.</p>
<p class="note">Three accounting rules are baked into <code>collect.py</code> because each one changes a
headline if you get it wrong. <b>One.</b> Per-request usage is read as deltas of the cumulative counters,
never from the per-turn field — that field is re-emitted when a turn ends without issuing a request, which
produced 211,106 phantom input tokens the first time this was measured. <b>Two.</b> Elpis writes prune
checkpoints as the same <code>compacted</code> rollout item as a real compaction, distinguished only by an
<code>elpis.context-prune.v1:</code> message prefix — miss it and a run with zero compactions reports 26.
<b>Three.</b> OpenAI's long-context threshold is 272,000 tokens, not 128,000.</p>
<p class="note danger">Everything on this page is experiment 1, message 1, run on 8 August 2026. Codex
sessions predating that date were deleted the same day without backup, so no whole-archive figure on any
earlier version of this page can be recomputed.</p></section>""")

CSS = """
:root{--ink:#15130f;--paper:#f7f4ee;--card:#fff;--line:#e3ddd1;--mut:#6b635a;--sunk:#f2eee6;--teal:#17a398;--red:#c8442c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--sunk:#141311;--teal:#28c2b5;--red:#e05a41}}
:root[data-theme=dark]{--ink:#efeae2;--paper:#100f0e;--card:#1a1816;--line:#2c2924;--mut:#9a9188;--sunk:#141311;--teal:#28c2b5;--red:#e05a41}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);margin:0;padding:44px 22px 100px;font:16px/1.62 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1090px;margin:0 auto;display:flex;flex-direction:column;gap:26px}
h1{font:600 43px/1.07 ui-serif,Georgia,serif;letter-spacing:-.023em;margin:0 0 12px;text-wrap:balance}
h3{font:600 20px/1.25 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.012em;margin:0}
.sub{color:var(--mut);margin:6px 0 0;max-width:76ch}
.eyebrow{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.17em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:24px 26px;display:flex;flex-direction:column;gap:13px}
.card.pending{border-style:dashed;background:transparent}
.part{margin-top:30px;padding-bottom:4px;border-bottom:2px solid var(--teal)}
.part.pending{border-bottom:2px dashed var(--line)}
.part.pending .pnum,.part.pending .ptitle{color:var(--mut)}
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
tr.tot td{border-top:2px solid var(--ink);border-bottom:none;font-weight:600}
.w{color:var(--teal);font-weight:600}.lose{color:var(--red);font-weight:600}
td.pend{color:var(--line);font-weight:600}
.scroll{overflow-x:auto}
.note{font-size:14.2px;color:var(--mut);border-left:2px solid var(--teal);padding-left:14px;max-width:82ch;margin:2px 0 0}
.note.danger{border-color:var(--red)}
.cap{font-size:13px;color:var(--mut);margin:0;max-width:82ch}
.key{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--mut)}
.key i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.key i.dash{width:14px;height:0;border-top:2px dashed var(--red);border-radius:0;vertical-align:4px}
.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.slot{border:1px dashed var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.slot .sk{font:600 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.slot .sv{font:600 26px/1.1 ui-sans-serif,system-ui,sans-serif;color:var(--line)}
.slot .sl{font-size:12px;color:var(--mut)}
.exhibit{border:1px solid var(--line);border-radius:11px;overflow:hidden}
.ex-head{display:flex;justify-content:space-between;align-items:center;padding:9px 15px;background:var(--sunk);font:600 12px/1 ui-sans-serif,system-ui,sans-serif;color:var(--mut)}
.ex-head.bt{border-top:1px solid var(--line)}
.exhibit pre{margin:0;padding:15px;overflow-x:auto;font:12.4px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
.exhibit pre.after{background:color-mix(in srgb,var(--teal) 7%,transparent)}
.exhibit .dim{color:var(--mut)}
.exhibit .key2{color:var(--teal);font-weight:600}
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

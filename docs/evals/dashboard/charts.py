"""Reusable SVG primitives. No external libraries: the dashboard must open from a file
with no network, and a chart that needs a CDN is a chart that renders blank."""
import statistics as st

def q(v, p):
    v = sorted(v); k = (len(v) - 1) * p; f = int(k)
    return v[f] if f + 1 >= len(v) else v[f] + (v[f + 1] - v[f]) * (k - f)

def fmt(n):
    n = float(n)
    for lim, suf in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(n) >= lim:
            return f"{n/lim:,.1f}{suf}"
    return f"{n:,.0f}"

def money(v):
    return f"${v:,.2f}" if abs(v) < 100 else f"${v:,.0f}"

RAMP = [(0.00, "#17a398"), (0.30, "#17a398"), (0.45, "#6fb03f"),
        (0.58, "#c9b03a"), (0.72, "#d98026"), (0.86, "#c8442c"), (1.00, "#96181c")]

def pressure_gradient(gid, y_at_0, y_at_100, low=None):
    stops = []
    for off, col in RAMP:
        stops.append(f'<stop offset="{off}" stop-color="{low if (low and off<=0.30) else col}"/>')
    return (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
            f'x1="0" y1="{y_at_0:.1f}" x2="0" y2="{y_at_100:.1f}">' + "".join(stops) + "</linearGradient>")

def occupancy_lines(series, w=1020, h=360, trigger=30, mark_compactions=True, sample=None):
    """series: list of (label, occupancy[], low_colour, compaction_steps[])"""
    pt, pr, pb, pl = 28, 24, 40, 56
    iw, ih = w - pl - pr, h - pt - pb
    Y = lambda p: pt + ih * (1 - min(p, 100) / 100)
    o = ['<defs>']
    for i, (lab, occ, low, comps) in enumerate(series):
        o.append(pressure_gradient(f"g{i}", Y(0), Y(100), low))
    o.append(f'<linearGradient id="gband" gradientUnits="userSpaceOnUse" x1="0" y1="{Y(0):.1f}" x2="0" y2="{Y(trigger):.1f}">'
             '<stop offset="0" stop-color="#17a398" stop-opacity=".15"/><stop offset="1" stop-color="#17a398" stop-opacity=".02"/></linearGradient></defs>')
    o.append(f'<rect x="{pl}" y="{Y(trigger):.1f}" width="{iw}" height="{Y(0)-Y(trigger):.1f}" fill="url(#gband)"/>')
    for p in (0, 25, 50, 75, 100):
        y = Y(p)
        o.append(f'<line x1="{pl}" y1="{y:.1f}" x2="{pl+iw}" y2="{y:.1f}" class="grid"/>')
        o.append(f'<text x="{pl-10}" y="{y+4:.1f}" class="ax" text-anchor="end">{p}%</text>')
    o.append(f'<line x1="{pl}" y1="{Y(trigger):.1f}" x2="{pl+iw}" y2="{Y(trigger):.1f}" class="trig"/>')
    o.append(f'<text x="{pl+8}" y="{Y(trigger)-8:.1f}" class="trigmark">pruning threshold — {trigger}% used</text>')
    for i, (lab, occ, low, comps) in enumerate(series):
        n = len(occ)
        step = max(1, n // (sample or n))
        pts = occ[::step]
        m = len(pts)
        X = lambda j: pl + iw * (j / (m - 1)) if m > 1 else pl
        d = " ".join(("M" if j == 0 else "L") + f"{X(j):.1f},{Y(v):.1f}" for j, v in enumerate(pts))
        o.append(f'<path d="{d}" fill="none" stroke="url(#g{i})" stroke-width="{2.4 if m<200 else 1.3}" '
                 f'stroke-linejoin="round" opacity="{1 if m<200 else .92}"/>')
        if mark_compactions:
            for c in comps:
                x = pl + iw * (c / max(n - 1, 1))
                o.append(f'<line x1="{x:.1f}" y1="{Y(100):.1f}" x2="{x:.1f}" y2="{Y(0):.1f}" class="comp"/>')
    o.append(f'<text x="{pl}" y="{h-8}" class="ax">turn step →</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

def box(groups, w=1020, h=300, unit="%", vmax=None, fmtf=None):
    """groups: list of (label, values[], colour)"""
    fmtf = fmtf or (lambda v: f"{v:.0f}")
    pt, pr, pb, pl = 22, 90, 46, 168
    iw, ih = w - pl - pr, h - pt - pb
    vmax = vmax or max(max(v) for _, v, _ in groups) * 1.06
    X = lambda v: pl + iw * v / vmax
    gap = ih / len(groups); bh = min(gap * 0.44, 30)
    o = []
    for gx in range(0, int(vmax) + 1, max(1, int(vmax // 5))):
        o.append(f'<line x1="{X(gx):.1f}" y1="{pt}" x2="{X(gx):.1f}" y2="{pt+ih:.1f}" class="grid"/>')
        o.append(f'<text x="{X(gx):.1f}" y="{pt+ih+18:.1f}" class="ax" text-anchor="middle">{fmtf(gx)}{unit}</text>')
    for i, (lab, v, col) in enumerate(groups):
        y = pt + i * gap + gap / 2
        lo, q1, med, q3, hi = min(v), q(v, .25), st.median(v), q(v, .75), max(v)
        o.append(f'<line x1="{X(lo):.1f}" y1="{y:.1f}" x2="{X(hi):.1f}" y2="{y:.1f}" stroke="{col}" stroke-width="1.4" opacity=".55"/>')
        for e in (lo, hi):
            o.append(f'<line x1="{X(e):.1f}" y1="{y-bh/3:.1f}" x2="{X(e):.1f}" y2="{y+bh/3:.1f}" stroke="{col}" stroke-width="1.4" opacity=".55"/>')
        o.append(f'<rect x="{X(q1):.1f}" y="{y-bh/2:.1f}" width="{max(X(q3)-X(q1),1.5):.1f}" height="{bh:.1f}" rx="3" fill="{col}" opacity=".30"/>')
        o.append(f'<line x1="{X(med):.1f}" y1="{y-bh/2:.1f}" x2="{X(med):.1f}" y2="{y+bh/2:.1f}" stroke="{col}" stroke-width="2.6"/>')
        o.append(f'<text x="{pl-14}" y="{y+4:.1f}" class="blab" text-anchor="end">{lab}</text>')
        o.append(f'<text x="{pl+iw+10}" y="{y+4:.1f}" class="bval">{fmtf(med)}{unit}</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

def grouped(cats, series, w=1020, h=330, fmtf=None, log=False):
    """cats: [label]; series: [(name, values[], colour)]"""
    import math
    fmtf = fmtf or (lambda v: f"{v:,.0f}")
    pt, pr, pb, pl = 26, 20, 58, 62
    iw, ih = w - pl - pr, h - pt - pb
    allv = [v for _, vals, _ in series for v in vals]
    vmax = max(allv) * 1.16 or 1
    def Y(v):
        if log:
            v = max(v, vmax / 1000)
            return pt + ih * (1 - math.log10(v / (vmax / 1000)) / math.log10(1000))
        return pt + ih * (1 - v / vmax)
    o = []
    for f in (0, .25, .5, .75, 1):
        yv = vmax * f
        o.append(f'<line x1="{pl}" y1="{Y(yv):.1f}" x2="{pl+iw}" y2="{Y(yv):.1f}" class="grid"/>')
        o.append(f'<text x="{pl-9}" y="{Y(yv)+4:.1f}" class="ax" text-anchor="end">{fmtf(yv)}</text>')
    cw = iw / len(cats); bw = cw * 0.74 / len(series)
    for ci, c in enumerate(cats):
        for si, (nm, vals, col) in enumerate(series):
            x = pl + ci * cw + cw * 0.13 + si * bw
            yv = Y(vals[ci]); hh = pt + ih - yv
            o.append(f'<rect x="{x:.1f}" y="{yv:.1f}" width="{bw*0.86:.1f}" height="{max(hh,1):.1f}" rx="3" fill="{col}"><title>{nm} · {c}: {fmtf(vals[ci])}</title></rect>')
            o.append(f'<text x="{x+bw*0.43:.1f}" y="{yv-6:.1f}" class="ax" text-anchor="middle">{fmtf(vals[ci])}</text>')
        o.append(f'<text x="{pl+ci*cw+cw/2:.1f}" y="{pt+ih+20:.1f}" class="blab" text-anchor="middle">{c}</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

def hbars(rows, w=1020, h=None, pl=250, fmtf=None, vmax=None):
    fmtf = fmtf or (lambda v: f"{v:,.0f}")
    h = h or (34 * len(rows) + 40)
    pt, pr, pb = 16, 96, 20
    iw, ih = w - pl - pr, h - pt - pb
    vmax = vmax or max(v for _, v, _ in rows) * 1.05 or 1
    gap = ih / len(rows); bh = min(gap * 0.6, 24)
    o = []
    for i, (lab, val, col) in enumerate(rows):
        y = pt + i * gap + (gap - bh) / 2
        bw = iw * val / vmax
        o.append(f'<rect x="{pl}" y="{y:.1f}" width="{max(bw,1):.1f}" height="{bh:.1f}" rx="3" fill="{col}"/>')
        o.append(f'<text x="{pl-12}" y="{y+bh/2+4:.1f}" class="blab" text-anchor="end">{lab}</text>')
        o.append(f'<text x="{pl+bw+9:.1f}" y="{y+bh/2+4:.1f}" class="bval">{fmtf(val)}</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

def histogram(series, bins, w=1020, h=260, xlabel=""):
    """series: [(name, counts[], colour, opacity)]"""
    pt, pr, pb, pl = 22, 20, 48, 56
    iw, ih = w - pl - pr, h - pt - pb
    mx = max(max(c) for _, c, _, _ in series) * 1.12 or 1
    bw = iw / len(bins)
    o = []
    for i, b in enumerate(bins):
        x = pl + i * bw
        for si, (nm, counts, col, op) in enumerate(series):
            sw = bw * 0.38
            bx = x + bw * (0.08 + si * 0.46)
            bh = ih * counts[i] / mx
            o.append(f'<rect x="{bx:.1f}" y="{pt+ih-bh:.1f}" width="{sw:.1f}" height="{max(bh,0):.1f}" rx="2" fill="{col}" opacity="{op}"><title>{nm} {b}: {counts[i]}</title></rect>')
            if counts[i]:
                o.append(f'<text x="{bx+sw/2:.1f}" y="{pt+ih-bh-5:.1f}" class="ax" text-anchor="middle">{counts[i]}</text>')
        o.append(f'<text x="{x+bw/2:.1f}" y="{pt+ih+17:.1f}" class="ax" text-anchor="middle">{b}</text>')
    o.append(f'<line x1="{pl}" y1="{pt+ih:.1f}" x2="{pl+iw}" y2="{pt+ih:.1f}" class="grid"/>')
    o.append(f'<text x="{pl}" y="{h-8}" class="ax">{xlabel}</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

def curve(points, w=1020, h=300, xlab="", ylab="", marks=(), col="#17a398", ref=None):
    """points: [(x,y)] ; ref: (y, label) horizontal reference line"""
    pt, pr, pb, pl = 26, 30, 46, 66
    iw, ih = w - pl - pr, h - pt - pb
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    x0, x1 = min(xs), max(xs); y0, y1 = 0, max(ys + ([ref[0]] if ref else [])) * 1.14
    X = lambda v: pl + iw * (v - x0) / max(x1 - x0, 1e-9)
    Y = lambda v: pt + ih * (1 - v / max(y1, 1e-9))
    o = []
    for f in (0, .25, .5, .75, 1):
        o.append(f'<line x1="{pl}" y1="{Y(y1*f):.1f}" x2="{pl+iw}" y2="{Y(y1*f):.1f}" class="grid"/>')
        o.append(f'<text x="{pl-9}" y="{Y(y1*f)+4:.1f}" class="ax" text-anchor="end">${y1*f:,.0f}</text>')
    if ref:
        o.append(f'<line x1="{pl}" y1="{Y(ref[0]):.1f}" x2="{pl+iw}" y2="{Y(ref[0]):.1f}" class="refline"/>')
        o.append(f'<text x="{pl+iw-6}" y="{Y(ref[0])-8:.1f}" class="anno" fill="#c8442c" text-anchor="end">{ref[1]}</text>')
    d = " ".join(("M" if i == 0 else "L") + f"{X(x):.1f},{Y(y):.1f}" for i, (x, y) in enumerate(points))
    o.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2.6"/>')
    for mx_, lab in marks:
        o.append(f'<line x1="{X(mx_):.1f}" y1="{pt}" x2="{X(mx_):.1f}" y2="{pt+ih:.1f}" class="comp"/>')
        o.append(f'<text x="{X(mx_)+7:.1f}" y="{pt+13}" class="anno" fill="#17a398">{lab}</text>')
    for f in (0, .25, .5, .75, 1):
        v = x0 + (x1 - x0) * f
        o.append(f'<text x="{X(v):.1f}" y="{pt+ih+19:.1f}" class="ax" text-anchor="middle">{v*100:.0f}%</text>')
    o.append(f'<text x="{pl}" y="{h-7}" class="ax">{xlab}</text>')
    return f'<svg viewBox="0 0 {w} {h}" class="chart">' + "".join(o) + "</svg>"

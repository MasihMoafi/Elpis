#!/usr/bin/env python3
"""Render the peak context utilisation chart from the RQ1 measurements.

The chart this replaces was hand-authored and had drifted from the results it
illustrates: it plotted an Elpis peak of 44.8% for a run whose measured peak was
32.5%, and its range (32.7-48.1%) contradicted the range stated in the README
paragraph directly above it (32.5-49.5%). It also named the three runs "Full
Task", "Compact Task" and "Validation Run", implying three different workloads,
where RESULTS.md records "three repetitions of *one* task, not three tasks".

Every number below is transcribed from the RQ1 table in docs/evals/RESULTS.md.
Peaks are absolute input tokens; percentages are derived here so the chart and
the prose cannot disagree again.

Run 1 is independently corroborated by the tracked dashboard capture
docs/evals/dashboard/runs/exp1-elpis.json, whose maximum request is 83,885
tokens (32.46% of the window) over 42 pruning checkpoints.

Usage:
    python3 docs/evals/charts/render_peak_context.py
"""

from pathlib import Path

WINDOW = 258_400
"""Model context window for both arms, in tokens (RESULTS.md, RQ1 preamble)."""

MODEL = "gpt-5.6-luna"

# (run label, Codex peak tokens, Elpis peak tokens, reduction as published)
RUNS = [
    ("Run 1", 243_012, 83_885, 65.5),
    ("Run 2", 242_057, 127_873, 47.2),
    ("Run 3", 238_141, 123_900, 48.0),
]

# The window fraction above which Codex was forced into emergency compaction.
# README describes ">90% window" as the critical zone, so the chart draws it.
DANGER_LINE = 90.0

BG = "#0d1117"
PANEL = "#161b22"
PANEL_EDGE = "#30363d"
TITLE = "#f8fafc"
SUBTLE = "#94a3b8"
LEGEND = "#cbd5e1"
CODEX = "#ef4444"
CODEX_LIGHT = "#f87171"
ELPIS = "#10b981"
ELPIS_LIGHT = "#34d399"
DANGER = "#fbbf24"
GRID = "#21262d"

FONT = (
    "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, "
    "Helvetica, Arial, sans-serif"
)

W, H = 1200, 560
PLOT_X, PLOT_Y = 50.0, 105.0
PLOT_W, PLOT_H = 1100.0, 415.0
# Inner drawing box for the bars themselves.
AXIS_X = PLOT_X + 70
AXIS_TOP = PLOT_Y + 70
AXIS_BOTTOM = PLOT_Y + PLOT_H - 60
AXIS_W = PLOT_W - 110


def pct(tokens: int) -> float:
    return tokens / WINDOW * 100.0


def text(x, y, s, size, weight, fill, anchor="start"):
    a = f' text-anchor="{anchor}"' if anchor != "start" else ""
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" '
        f'font-size="{size}px" font-weight="{weight}" fill="{fill}"{a}>{s}</text>'
    )


def render() -> str:
    groups = [(label, pct(c), pct(e), red) for label, c, e, red in RUNS]
    mean_codex = sum(g[1] for g in groups) / len(groups)
    mean_elpis = sum(g[2] for g in groups) / len(groups)
    mean_red = (mean_codex - mean_elpis) / mean_codex * 100.0
    groups.append(("Mean of three runs", mean_codex, mean_elpis, mean_red))

    def y_at(value: float) -> float:
        return AXIS_BOTTOM - (value / 100.0) * (AXIS_BOTTOM - AXIS_TOP)

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" style="background-color: {BG}; border-radius: 12px;">',
        # Painted rect, not just a CSS background: GitHub renders README images
        # as <img>, where a CSS background-color on the root is ignored.
        f'<rect x="0" y="0" width="{W}" height="{H}" fill="{BG}" rx="12" />',
        text(
            PLOT_X,
            44,
            "Peak Context Window Utilization (Elpis vs. Codex)",
            22,
            700,
            TITLE,
        ),
        text(
            PLOT_X,
            72,
            f"Share of the {WINDOW // 1000}k {MODEL} window held at peak · "
            "three repetitions of one task",
            14,
            "normal",
            SUBTLE,
        ),
        f'<rect x="{PLOT_X}" y="{PLOT_Y}" width="{PLOT_W}" height="{PLOT_H}" '
        f'fill="{PANEL}" stroke="{PANEL_EDGE}" stroke-width="1" rx="10" />',
    ]

    # Legend. Named for what each arm is, with no editorial gloss.
    lx = PLOT_X + 40
    ly = PLOT_Y + 27
    out.append(f'<rect x="{lx}" y="{ly}" width="16" height="16" fill="{CODEX}" rx="4" />')
    out.append(text(lx + 26, ly + 13, "Codex (no context management)", 13.5, 600, LEGEND))
    lx2 = lx + 330
    out.append(f'<rect x="{lx2}" y="{ly}" width="16" height="16" fill="{ELPIS}" rx="4" />')
    out.append(text(lx2 + 26, ly + 13, "Elpis (Ace pressure pruning)", 13.5, 600, LEGEND))
    lx3 = lx2 + 320
    out.append(
        f'<line x1="{lx3}" y1="{ly + 8}" x2="{lx3 + 22}" y2="{ly + 8}" '
        f'stroke="{DANGER}" stroke-width="2" stroke-dasharray="6 4" />'
    )
    out.append(
        text(lx3 + 32, ly + 13, f"{DANGER_LINE:.0f}% — emergency compaction", 13.5, 600, LEGEND)
    )

    # Y gridlines and labels.
    for v in (0, 25, 50, 75, 100):
        y = y_at(v)
        out.append(
            f'<line x1="{AXIS_X}" y1="{y:.1f}" x2="{AXIS_X + AXIS_W:.1f}" y2="{y:.1f}" '
            f'stroke="{GRID}" stroke-width="1" />'
        )
        out.append(text(AXIS_X - 12, y + 4, f"{v}%", 12.5, "normal", SUBTLE, "end"))

    # The threshold the prose calls the critical zone.
    dy = y_at(DANGER_LINE)
    out.append(
        f'<line x1="{AXIS_X}" y1="{dy:.1f}" x2="{AXIS_X + AXIS_W:.1f}" y2="{dy:.1f}" '
        f'stroke="{DANGER}" stroke-width="2" stroke-dasharray="6 4" />'
    )

    # Bars.
    n = len(groups)
    slot = AXIS_W / n
    bar_w = 62.0
    gap = 18.0
    for i, (label, cv, ev, red) in enumerate(groups):
        cx = AXIS_X + slot * i + slot / 2
        x_codex = cx - bar_w - gap / 2
        x_elpis = cx + gap / 2
        for x, v, fill, light in (
            (x_codex, cv, CODEX, CODEX_LIGHT),
            (x_elpis, ev, ELPIS, ELPIS_LIGHT),
        ):
            y = y_at(v)
            h = AXIS_BOTTOM - y
            out.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w}" height="{h:.1f}" '
                f'fill="{fill}" rx="5" />'
            )
            out.append(
                text(x + bar_w / 2, y - 9, f"{v:.1f}%", 14, 700, light, "middle")
            )
        out.append(
            text(cx, AXIS_BOTTOM + 26, label, 13.5, 600, TITLE, "middle")
        )
        out.append(
            text(cx, AXIS_BOTTOM + 45, f"\u2212{red:.1f}% peak", 12.5, "normal", SUBTLE, "middle")
        )

    out.append(
        text(
            PLOT_X,
            H - 14,
            "Source: docs/evals/RESULTS.md RQ1 \u00b7 regenerate with "
            "docs/evals/charts/render_peak_context.py",
            11.5,
            "normal",
            "#6b7688",
        )
    )
    out.append("</svg>")
    return "\n".join(out) + "\n"


def main() -> None:
    target = (
        Path(__file__).resolve().parents[2]
        / "assets"
        / "elpis_empirical_evaluation_bars.svg"
    )
    target.write_text(render(), encoding="utf-8")
    print(f"wrote {target}")
    for label, c, e, red in RUNS:
        derived = (pct(c) - pct(e)) / pct(c) * 100.0
        flag = "" if abs(derived - red) < 0.15 else "  <-- MISMATCH vs published"
        print(
            f"  {label}: codex {pct(c):.2f}%  elpis {pct(e):.2f}%  "
            f"reduction {derived:.1f}% (published {red}%){flag}"
        )


if __name__ == "__main__":
    main()

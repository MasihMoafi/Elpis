#!/usr/bin/env python3
"""Validate recorded usage, then regenerate the public September 2026 charts.

No provider calls. Inputs are the frozen cost study's recorded metrics, not the
current UI build. matplotlib is required for chart export.
"""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/evals/rq3/COST_EFFICIENCY_METRICS.json"
OUT = ROOT / "docs/assets"


def equal(actual, expected, label):
    if not math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-10):
        raise ValueError(f"{label}: recorded {actual}, recomputed {expected}")


def price(input_tokens, cached, output, rates):
    assert 0 <= cached <= input_tokens
    return ((input_tokens - cached) * rates["input"] + cached * rates["cached"]
            + output * rates["output"]) / 1_000_000


def validate(data):
    for batch in data["batches"]:
        for pair in batch["pairs"]:
            label = f"{Path(batch['batch']).name}/{pair['caseId']}"
            for arm, cost_key, token_key in [("off", "off", "off"), ("on", "onMain", "onMain")]:
                series = pair["series"][arm]
                assert len(series) == pair["requests"][arm], label
                for row in series:
                    equal(row["cost"], price(row["input"], row["cached"], row["output"], data["rates"]["main"]), label)
                equal(pair["cost"][cost_key], sum(row["cost"] for row in series), label)
                equal(pair["tokens"][token_key], sum(row["input"] + row["output"] for row in series), label)
            usage = pair["optimizer"]["usage"]
            assert usage["cache_write_tokens"] == 0, "unspecified cache-write rate"
            equal(pair["cost"]["optimizer"], price(usage["input_tokens"], usage["cached_input_tokens"], usage["output_tokens"], data["rates"]["optimizer"]), label)
            equal(pair["tokens"]["optimizer"], usage["input_tokens"] + usage["output_tokens"], label)
            for metric in ["cost", "tokens"]:
                values = pair[metric]
                equal(values["on"], values["onMain"] + values["optimizer"], label)
                equal(values["saved"], values["off"] - values["on"], label)
        assert batch["summary"]["pairs"] == len(batch["pairs"])
        for metric in ["cost", "tokens"]:
            for arm in ["off", "on"]:
                equal(batch["summary"][metric][arm], sum(p[metric][arm] for p in batch["pairs"]), batch["batch"])


def aggregate(data, ids, label):
    batches = {Path(b["batch"]).name: b for b in data["batches"]}
    selected = [batches[f"elpis-cost-{key}-20260908-01"] for key in ids]
    pairs = [p for b in selected for p in b["pairs"]]
    assert pairs and len({p["caseId"] for p in pairs}) == len(pairs), "duplicate case in descriptive group"
    result = {"label": label, "batches": [Path(b["batch"]).name for b in selected],
              "pairs": len(pairs), "requests_per_arm": sorted({p["requests"]["off"] for p in pairs}),
              "binary_sha256": selected[0]["binaryHash"]}
    assert len({b["binaryHash"] for b in selected}) == 1
    for metric in ["cost", "tokens"]:
        off = sum(p[metric]["off"] for p in pairs)
        on = sum(p[metric]["on"] for p in pairs)
        result[metric] = {"off": off, "on_including_optimizer": on,
                          "change_percent": (on / off - 1) * 100,
                          "cheaper_or_fewer_pairs": sum(p[metric]["on"] < p[metric]["off"] for p in pairs)}
    return result


def chart(rows, title, caption, name):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    matplotlib.rcParams.update({"svg.hashsalt": "elpis-evidence-20260909", "font.family": "DejaVu Sans",
                               "text.color": "#e5e4dc", "axes.labelcolor": "#e5e4dc",
                               "xtick.color": "#b9b8b0", "ytick.color": "#e5e4dc"})
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.5), sharey=True, facecolor="#111214")
    for ax, metric, color, heading in zip(axes, ["cost", "tokens"], ["#e7a33b", "#ebd56e"],
                                        ["Estimated cost change", "Total token change"]):
        ax.set_facecolor("#111214")
        values = [r[metric]["change_percent"] for r in rows]
        ax.barh(range(len(rows)), values, color=color, height=.5)
        ax.axvline(0, color="#8b8b83", linewidth=1)
        ax.set_title(heading, loc="left", color="#e5e4dc", fontsize=13, pad=15)
        ax.set_yticks(range(len(rows)), [f"{r['label']}  (n={r['pairs']})" for r in rows])
        ax.set_xlim(min(-45, min(values) - 18), max(25, max(values) + 35))
        for i, value in enumerate(values):
            ax.text(value + (2 if value >= 0 else -2), i, f"{value:+.1f}%", va="center",
                    ha="left" if value >= 0 else "right", fontsize=11)
        ax.grid(axis="x", color="#373832", alpha=.5)
        ax.set_axisbelow(True)
        ax.spines[["top", "right", "left", "bottom"]].set_visible(False)
        ax.tick_params(axis="y", length=0)
        ax.set_xlabel("ON versus OFF; negative means less", fontsize=10, labelpad=12)
    axes[0].invert_yaxis()
    fig.suptitle(title, x=.035, ha="left", fontsize=19, fontweight="bold")
    fig.text(.035, .10, caption, color="#b9b8b0", fontsize=9, linespacing=1.5)
    fig.subplots_adjust(left=.23, right=.97, top=.79, bottom=.27, wspace=.14)
    fig.savefig(OUT / f"{name}.svg", facecolor=fig.get_facecolor(), metadata={"Date": None})
    plt.close(fig)


def main():
    data = json.loads(SOURCE.read_text())
    validate(data)
    effort = [aggregate(data, [key], label) for key, label in [
        ("e1-max-b", "Max"), ("e1-medium-c", "Medium"), ("e1-low", "Low"), ("e1-none-b", "None")]]
    horizon = [aggregate(data, ids, label) for ids, label in [
        (["e1-low"], "Low · 3 requests"), (["e2-8b-low"], "Low · 11 requests"),
        (["e2-32b-low", "e2-32c-low"], "Low · 35 requests"), (["e2-32-none"], "None · 35 requests")]]
    document = {"as_of": "2026-09-09", "source": "docs/evals/rq3/COST_EFFICIENCY_METRICS.json",
                "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
                "calculator_sha256": data["calculatorSha256"], "verified_batches": len(data["batches"]),
                "verified_pairs": sum(len(b["pairs"]) for b in data["batches"]),
                "scope": "Synthetic fixtures; frozen experiment binary, not the current UI build. Descriptive totals; no pooled inference across batches.",
                "cost_basis": "Recorded 2026-09-08 rates: $0.20 input, $0.02 cached input, $1.20 output per million. Estimate, not invoice. Main + optimizer included.",
                "effort_at_three_requests": effort, "horizon": horizon}
    (OUT / "current-evidence-20260909.json").write_text(json.dumps(document, indent=2) + "\n")
    chart(effort, "Short sessions: pruning costs more", "Three requests per arm · 8–9 September 2026 synthetic study · main + optimizer included\nMedium: five complete pairs; other efforts: eight. Failed/incomplete cases remain in the study report.", "elpis-current-effort-20260909")
    chart(horizon, "Cost depends on the number of later requests", "Frozen binary d58e8c9b8861 · recorded-rate estimates, not invoices · main + optimizer included\nLow / 35 requests combines two disjoint batches descriptively. None had a citation-label failure in a separate multi-file test.", "elpis-current-horizon-20260909")
    print(f"Validated {document['verified_pairs']} pairs in {document['verified_batches']} batches; regenerated two charts and provenance JSON.")


if __name__ == "__main__":
    main()

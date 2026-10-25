"""Reproduce conditional planning numbers for a paired correctness study.

These are normal/RMLE-score planning approximations, not observed Elpis results.
Each pair is one distinct task attempted once with pruning ON and once OFF.
Assume a true pass-rate difference of zero, independent complete task pairs,
one-sided alpha .05, and a prespecified positive non-inferiority margin.
"""
import argparse
import json
import math
from statistics import NormalDist


SOURCE = "https://doi.org/10.1186/s12874-025-02497-2"


def pairs_needed(margin, discordance, power=.80, alpha=.05):
    """Expected constrained variance under the boundary d0=-margin.

    With equal true success rates, expected favorable and unfavorable
    discordances are q/2 each. Maximizing the boundary likelihood yields
    q0=(q+sqrt(q*q+4*(1-q)*margin*margin))/2. The boundary variance is
    q0-margin**2, and the alternative variance is q.
    """
    if not (0 < margin < 1 and 0 < discordance < 1
            and .5 < power < 1 and 0 < alpha < .5):
        raise ValueError("Invalid planning parameter")
    q0 = (discordance + math.sqrt(
        discordance**2 + 4*(1-discordance)*margin**2)) / 2
    z_alpha = NormalDist().inv_cdf(1-alpha)
    z_power = NormalDist().inv_cdf(power)
    raw = (z_alpha*math.sqrt(q0-margin**2)
           + z_power*math.sqrt(discordance))**2 / margin**2
    return math.ceil(raw)


def scenarios():
    # Independent published benchmark: 5-point margin, q=.20, alpha=.05,
    # 80% power, equal true rates => Nam sample-size calculation of 507.
    assert pairs_needed(.05, .20) == 507
    rows = []
    for margin in [.02, .05, .10]:
        for q in [.10, .20]:
            for power in [.80, .90]:
                n = pairs_needed(margin, q, power)
                rows.append({"margin_percentage_points":100*margin,
                             "assumed_discordance_fraction":q,
                             "power":power,"distinct_task_pairs":n,
                             "agent_executions":2*n})
    return {"kind":"Conditional sample-size planning, not experimental results",
            "source":SOURCE,"alpha_one_sided":.05,
            "assumed_true_pass_rate_difference":0,
            "published_507_pair_example_reproduced":True,
            "formula":"q0=(q+sqrt(q^2+4*(1-q)*delta^2))/2; "
                      "n=ceil((z_(1-alpha)*sqrt(q0-delta^2)+"
                      "z_power*sqrt(q))^2/delta^2)",
            "scenarios":rows,
            "limits":["The margin is a declared practical tolerance, not a universal standard.",
                      "Actual discordance is unknown; do not choose it from favorable pilot outcomes.",
                      "Repeated attempts of one task and different models are not independent task pairs.",
                      "Validate finite-sample operating characteristics before freezing the main study.",
                      "A nonsignificant difference test does not establish non-inferiority."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=argparse.FileType("x"))
    args = parser.parse_args()
    result = json.dumps(scenarios(), indent=2)+"\n"
    if args.output:
        with args.output as handle:
            handle.write(result)
    else:
        print(result, end="")

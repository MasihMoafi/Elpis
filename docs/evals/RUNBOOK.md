# What the paper still needs, and the runs that get it

The questions are the five in `paper/main.tex` §7.1. Nothing else is a question.
Status lives in `paper-research-questions.md`; this file is how to close what is open.

## Experiment 1 — withdrawn, 8 Aug 2026

Both arms got one identical open-ended prompt: *thoroughly familiarize yourself with this
project*. That is not a controlled task. An open prompt leaves **how much to read** free, so
each agent explored differently — 46 round trips against 67 — and every resulting number
mixes context management with exploration volume. The two are inseparable after the fact.

Its results and page are deleted. The pipeline that measured it is kept: `dashboard/collect.py`,
`charts.py`, `build.py`.

**The rule this establishes:** a prompt that names a *goal* is not a task. If either agent can
choose what work to do, the arms are not comparable — and that includes "read the repo" and
"delete as much as you can".

## Experiment 2 — one fixed checklist, both arms, run to completion

Neither system chooses what to do. That is the whole design.

| | |
| --- | --- |
| Arms | Codex, Elpis — separate clean checkouts of the same base commit |
| Model | `gpt-5.6-luna`, both arms, same reasoning effort |
| Input | One byte-identical checklist, pasted once |
| Interaction | None afterwards. No steering, no follow-ups, no answers. |
| Ends when | Every item is done, or the agent stops |
| Repeat | **3 runs per arm.** One run is an anecdote. |
| Order | One at a time — both compile Rust, and this machine kills a process past 80°C |

**Closes RQ1** (a floor and a σ across 6 runs instead of one point) and **RQ4** — but only if
task 33 lands in main *first*, otherwise pass cost is still unlogged during the run.

Each item must name its files and end in a command, and no item may depend on an earlier
item's design choice — otherwise the arms diverge at item 2 and the control is lost.

**Pass condition:** the suite is already red at HEAD, so pass is a *delta* — capture the failing
list before the run and require that **no test name moves from passing to failing**. Names,
never counts.

```bash
docs/evals/deletion-sprint/capture-baseline.sh   # in the main tree, before anything
```

### Running and scoring

```bash
cd "$ELPIS_EXP_ROOT/exp2-elpis" && elpis
cd "$ELPIS_EXP_ROOT/exp2-codex" && codex
```

```bash
cd docs/evals/dashboard
python3 collect.py <rollout.jsonl> --split --system <elpis|codex>
python3 build.py
```

Sessions file themselves by date under `~/.elpis/sessions/` and `~/.codex/sessions/`.

## Experiment 3 — data loss

`docs/evals/context-continuity/`, run as written: exact, paraphrase and negative-recall probes,
both systems, per its own publication gate. **Every probed fact must live only inside tool
output** — pruning never touches your messages, so a fact you typed proves nothing.

Closes RQ2.

## Standing caveat

Until there are three runs per arm, every figure is an observation about a particular
afternoon, not a property of either system.

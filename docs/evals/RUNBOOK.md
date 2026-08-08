# Runbook — how to run the experiments yourself

Everything below is run by hand. Nothing here starts automatically.

## Before anything

Capture the failing-test baseline, in the main tree only:

```bash
docs/evals/deletion-sprint/capture-baseline.sh
```

It writes timestamped logs and a list of currently-failing tests to
`docs/evals/deletion-sprint/baseline/`. Without this, a regression cannot be told apart
from breakage that was already there.

## Telling the runs apart afterwards

Nothing needs moving. Sessions are already filed by date:

- Elpis → `~/.elpis/sessions/<year>/<month>/<day>/`
- Codex → `~/.codex/sessions/<year>/<month>/<day>/`

Different roots, and today's folder is created fresh. Each filename carries the start time
to the second plus a unique id, so two runs on the same day are still distinguishable.

## Experiment 3 — deletion sprint (the headline)

Two hours per system. Set the model to Luna at max reasoning in both, then paste
`docs/evals/deletion-sprint/PROMPT.md` verbatim and do not speak to it again.

```bash
cd ~/Desktop/p/Elpis-exp3-elpis && elpis     # branch exp3/elpis
cd ~/Desktop/p/Elpis-exp3-codex && codex     # branch exp3/codex
```

**Run these one after the other, not at the same time.** Both compile Rust; two at once
means each is being timed while fighting the other for CPU, and this machine kills a
process that pushes past 80°C — a killed build takes the run with it.

## Experiment 1 — three prompts

Not timed, so this one is safe to run alongside something else.

```bash
cd ~/Desktop/p/Elpis-exp1-elpis && elpis     # branch exp1/elpis
cd ~/Desktop/p/Elpis-exp1-codex && codex     # branch exp1/codex
```

Three prompts, one at a time, waiting for each to finish:

1. Thoroughly familiarize yourself with this project.
2. Identify and implement ONE small performance improvement that makes the application
   measurably faster or more efficient.
3. Find and implement ONE UX improvement that makes the interface more intuitive,
   accessible, or pleasant to use.

## Experiment 2 — continuity questions

Protocol is in `docs/evals/context-continuity/`. It runs in a clean temporary workspace,
not in this repo, and its own publication gate asks for ten runs per system. It is the one
that does not fit in a single day.

## Scoring

None of it is scored live. Afterwards, every branch is still sitting there and every
transcript is on disk, so the whole thing can be scored from evidence rather than memory.

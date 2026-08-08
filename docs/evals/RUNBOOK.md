# Experiment 2 — identical checklist, run to completion

Everything here is run by hand.

## Why experiment 1 could not settle it

Experiment 1 sent three prompts to each system. Only the first was a real comparison.

- **Message 1** — "thoroughly familiarize yourself with this project" — one task, done twice.
  Neither arm produced a plan checklist; both read the repository and reported. **Comparable.**
- **Messages 2 and 3** — "find ONE performance improvement", "find ONE UX improvement" — name a
  *goal*, not a task. Each arm chose different work and different amounts of it: on message 3
  Codex ran 16 tool calls in 3.0 minutes, Elpis 83 in 30.2. **Not comparable, withdrawn.**

**The deletion sprint is rejected for the same reason.** "Delete as much as you can in two hours"
is a goal. Two runs of the *same* system on it diverge, so a difference between systems proves
nothing. Variance in the task swamps variance in the system.

## The fix: fix the task, not the prompt

Both systems get the **same numbered checklist**, written in advance, with a pass condition a
script can evaluate. Neither system chooses what to do. Both run until every item is done or they
give up. Then measure.

This does not make the run cheap or short — it makes it *the same run twice*, which is the only
thing that lets a difference be attributed to the system.

## What answers we are trying to get

Stated before the run, not after. If a question is not on this list, the run does not answer it.

| # | Question | Answer shape | Pass |
| --- | --- | --- | --- |
| Q1 | Does either system fail to finish the checklist? | items completed / total | both complete, or the gap is the result |
| Q2 | How low does the context window go? | lowest % remaining, per system | Elpis never below 65% |
| Q3 | How steady is the window? | σ of % remaining | — |
| Q4 | How many times is history destroyed? | compactions | Elpis 0 |
| Q5 | What does the same work cost in tokens? | total input, fresh input, output | — |
| Q6 | What does pruning spend to hold the window? | tokens spent vs reclaimed | — |

Not answered by this design, and not to be claimed from it: money (only the vendor that ran has
known caching behaviour), and output quality beyond the checklist's own pass condition.

## Design

| | |
| --- | --- |
| Arms | Codex, Elpis — separate clean checkouts, separate branches |
| Model | `gpt-5.6-luna`, both arms, same reasoning effort |
| Input | One numbered checklist, byte-identical, pasted once |
| Interaction | None after the paste. No steering, no follow-ups. |
| Ends when | Every item done, or the agent stops |
| Runs | One at a time — both compile Rust, and this machine kills a process past 80°C |

The checklist has to be long enough that Codex crosses its compaction boundary. Message 1 put
Codex at 6.9% remaining in 46 requests, so roughly two to three times that much work.

## The checklist

**Not yet written.** It is the whole experiment and it is the thing to get right. Requirements:

1. **Every item is a specific change to a specific file** — no "improve", no "find", no "choose".
2. **The pass condition is a command**, not a judgement. Because the suite is already red at HEAD,
   it must be a *delta*: capture the failing-test list first, and pass means no test name moves
   from passing to failing.
3. **Tool-output heavy**, so pruning has something to work on and the window actually fills.
4. **No item depends on an earlier item's design choice**, or the arms diverge again at item 2.

## Running it

```bash
git -C ~/Desktop/p/Elpis rev-parse HEAD          # pin the base commit in the manifest
docs/evals/deletion-sprint/capture-baseline.sh   # the failing-test baseline, in the main tree
```

Then, one after the other:

```bash
cd ~/Desktop/p/Elpis-exp2-elpis && elpis
cd ~/Desktop/p/Elpis-exp2-codex && codex
```

Sessions file themselves by date — Elpis under `~/.elpis/sessions/<y>/<m>/<d>/`, Codex under
`~/.codex/sessions/...` — so nothing needs moving afterwards.

## Scoring

```bash
cd docs/evals/dashboard
python3 collect.py <elpis-rollout.jsonl> --split --system elpis
python3 collect.py <codex-rollout.jsonl> --split --system codex
python3 build.py
```

Charts regenerate from the transcripts. Nothing is scored by hand except Q1, which is read off
the checklist.

## Standing caveat

One run per arm is one sample. Experiment 1's message 1 is empirical and unrepeated: it shows
that *in that run*, pressure pruning held Elpis's window above 65% while Codex fell to 6.9% and
compacted. That is an observation, not an established rate. It becomes a rate when there are
enough runs to average, and not before.

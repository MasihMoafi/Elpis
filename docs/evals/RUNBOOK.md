# What the paper still needs, and the run that gets it

The questions are the five in `paper/main.tex` §7.1. Nothing else is a question.

## Status — nothing is conclusively answered

| RQ | | State |
| --- | --- | --- |
| RQ1 | Context efficiency | **One run.** Message 1 of experiment 1: Elpis floor 65.9%, 0 compactions; Codex floor 6.9%, 1 compaction. Same task, same model, same window. It is a strong single observation, not a rate. |
| RQ2 | Retention | **Nothing.** `context-continuity/` specifies the protocol in full and has never been executed. |
| RQ3 | Task correctness | **Nothing.** No run has ended in a state a script could check. |
| RQ4 | Overhead | **Partial.** Pruning's visible tokens are measured for one run (337,968 spent, 303,953 reclaimed). Its *reasoning* tokens are billed and never logged — task 33 — so pass cost is still unknown. |
| RQ5 | Auditability | **Mechanism only.** 329 pass records exist with per-item decisions and evidence pointers. Nobody has walked one end to end and confirmed it reconstructs what was removed. |

## Why experiment 1 could not settle any of them

Message 1 asked both systems to read the repository — one task, done twice, and it stands.
Messages 2 and 3 asked them to *find* an improvement. That names a goal, not a task, so each
arm chose different work: on message 3 Codex ran 16 tool calls in 3.0 minutes, Elpis 83 in 30.2.
Nothing comparative survives that, and they were withdrawn.

**The deletion sprint fails the same test** and is dropped. "Delete as much as you can" is a
goal; two runs of the *same* system on it diverge, so a difference between systems proves
nothing. Task variance swamps system variance.

## Experiment 2 — one fixed checklist, both arms, run to completion

Fix the task, not the prompt. Neither system chooses what to do.

| | |
| --- | --- |
| Arms | Codex, Elpis — separate clean checkouts of the same base commit |
| Model | `gpt-5.6-luna`, both arms, same reasoning effort |
| Input | The checklist below, byte-identical, pasted once |
| Interaction | None afterwards. No steering, no follow-ups, no answers. |
| Ends when | Every item is done, or the agent stops |
| Repeat | **3 runs per arm.** One run is an anecdote; RQ1 needs a rate. |
| Order | One at a time — both compile Rust, and this machine kills a process past 80°C |

### What it closes

- **RQ1** — three runs per arm turns the floor and σ into a range instead of a point.
- **RQ3** — every item has a command that says done or not done. First evidence of correctness.
- **RQ4** — same work, both systems, so token totals are finally comparable. Land task 33 first
  and pass cost becomes measurable in the same run.

It does **not** close RQ2 or RQ5. Those need their own runs, below.

### The checklist

Drawn from `TASKS.md`, so the runs produce work worth keeping. Each item names files and ends in
a command. Nothing here depends on an earlier item's design choice, so the arms cannot diverge
at item 2.

1. **Task 35 — show the cached share of input in the session summary.** The line prints
   `input=N (+ M cached)` and a `total` that excludes cached entirely, so the ratio never
   appears. Print the percentage. *Done when:* a test asserts the rendered summary contains the
   ratio, and it passes.
2. **Task 33 — record token usage in the pruning pass archive.** Ace's usage is returned by the
   pass and dropped. Persist it into the pass record. *Done when:* a new pass directory contains
   input/output token counts, and a test asserts the field is written.
3. **Task 20 — rebrand user-visible "Codex" strings to Elpis.** User-facing text only: never a
   global replace, never protocol identifiers, never crate names. *Done when:* a listed set of
   user-visible strings reads Elpis and the suite shows no new failures.

**Pass condition, for every item:** the test suite is already red at HEAD, so pass is a *delta* —
capture the failing-test list before the run and require that **no test name moves from passing to
failing**. Count, never; names, always.

```bash
docs/evals/deletion-sprint/capture-baseline.sh   # in the main tree, before anything
```

### Running and scoring

```bash
cd ~/Desktop/p/Elpis-exp2-elpis && elpis
cd ~/Desktop/p/Elpis-exp2-codex && codex
```

```bash
cd docs/evals/dashboard
python3 collect.py <rollout.jsonl> --split --system <elpis|codex>
python3 build.py
```

Sessions file themselves by date under `~/.elpis/sessions/` and `~/.codex/sessions/`, so nothing
needs moving. Only Q "did it finish the checklist" is scored by hand.

## The two that need their own runs

- **RQ2 — retention.** Run `docs/evals/context-continuity/` as written: exact, paraphrase and
  negative-recall probes, both systems, per its own publication gate. The facts being probed must
  live **only inside tool output** — pruning never touches your messages, so anything typed
  directly proves nothing.
- **RQ5 — auditability.** No new run needed. Take one pass directory from an existing session,
  follow its evidence pointer back to the original tool output in the rollout, and confirm the
  removed text is recoverable and the replacement states what it kept. One walk, written down.

## Standing caveat

One run per arm is one sample. Until there are three, every figure is an observation about a
particular afternoon, not a property of either system.

# RQ2 v2 — Retention under pruning

Written 2026-08-12. Replaces the design that produced no data.

## The question

When Elpis's pruner **evaluates** a piece of tool output and acts on it, does the
information that mattered survive?

Not: does the agent finish the task. Not: does it answer correctly. Only: is the
information still there, and did the pruner's own judgement put it there.

## Why v1 produced nothing

Two independent faults, both fatal:

1. **The planted facts were unreachable.** They sat in the opening prompt and the first
   tool output — regions pruning never touches. The independent audit confirmed all six
   survived *"because they remained untouched (`kept`) in primary context history"*. The
   experiment could not have produced a number even on a perfect run.
2. **The result was defined as the model's final answer.** A provider capacity error
   therefore destroyed the run. Retention does not need a final answer.

## The distinction that makes this measurable

"Not deleted" collapses two completely different things. Separating them is the core of
this protocol.

| Outcome | What it shows |
|---|---|
| **Never eligible** | The item was outside pruning's jurisdiction — pruning only ever touches tool output, inside the eligible region. Nothing was spared by judgement; it was never a candidate. **Architecture, not evidence.** |
| **Evaluated → kept** | The pruner saw the item and chose to keep it. **A real positive.** |
| **Evaluated → deleted, information survived** in the replacement text | **A real positive.** |
| **Evaluated → deleted, information gone** | The failure mode this experiment exists to find. |

`Never eligible` is a property provable by reading `pressure_eligible_items` in
`core/src/context_pruner.rs`. It belongs in the paper as a design guarantee — *"Elpis
cannot delete the user's instructions, by construction"* — and it needs no experiment.
Reporting it as a retention result is what made v1 look like a finding when it was a
tautology.

**Headline metric:**

```
retention = (evaluated_kept + evaluated_deleted_but_preserved)
            / (evaluated_kept + evaluated_deleted_but_preserved + evaluated_deleted_lost)
```

Denominator counts only facts the pruner actually evaluated. **Always report the
never-eligible count beside it.** A high rate over a tiny denominator is the v1 result in
disguise.

## Baseline

Branch `eval/rq2-v2`, this worktree, based on `646c94a` — the commit RQ1 was measured on.

This matters. On `0b832c3` (current main) the steady pruning trigger was deleted, leaving
only pressure, capped at two passes per cycle followed by a cooling gate. Measured
behaviour there: ~6 passes, then nothing, then the window runs to 15% and errors. Most
planted facts would land in `never eligible` and v1 would repeat itself for a new reason.

This branch carries:
- `PruneTrigger::Steady` + `STEADY_PRUNE_FLOOR_PERCENT = 5` — pruning fires often (42/13/10
  passes across the RQ1 runs)
- the prune/compaction rollout split, so `kind` distinguishes them
- the 40%-remaining compaction backstop, so a run cannot die of context exhaustion

Record the binary hash before run 1 and do not rebuild between runs.

## Fixture

Generated, not a real repository — nothing memorised from pretraining, every fact
unambiguous.

`fixtures/corpus/svc-01.log` … `svc-50.log`, 400–600 lines each, ~2,500 tokens each.
Plausible service log lines with timestamps and IDs. Total ≈ 125,000 tokens against a
258,400 window — roughly 48%, comfortably past the 30% pressure trigger, so many passes
fire mid-run.

**14 planted facts**, each a single exact-matchable line:

| ID | Location | Purpose |
|---|---|---|
| P1, P2 | opening prompt | never-eligible controls. Confirm the design guarantee holds. |
| T1 … T12 | one each in files 04, 07, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47 | the measurement |

Spread deliberately: early files are certain to be evaluated, later ones fall inside the
protected recent 10%. That spread yields a retention curve by age, not one number.

Format — exact string match, no judge:

```
2026-03-14T09:22:07Z  svc-19  AUDIT  retention_token=T7:VIOLET-4471  checksum ok
```

Values random and non-guessable. A model that lost the line cannot reconstruct
`VIOLET-4471`.

## Prompt

Frozen, byte-identical across all 5 runs except the corpus seed.

```
You are cataloguing a service log corpus in this directory. Do not modify any file.
Do not run builds or tests. Do not use web search.

Two values to hold for the whole session:
  run_marker=P1:AMBER-8801
  audit_scope=P2:6 sections

Read every file in fixtures/corpus/ in order, svc-01.log through svc-50.log, one file
per tool call. Do not use grep, rg, head, tail, or any filtering — read each file in
full. After each file, state in one short line what service it covers.

Do not summarise or re-read earlier files. Work straight through.
```

The one-file-per-call, no-filtering constraint is load-bearing. Without it the agent greps,
no tool-output backlog accumulates, and the experiment measures nothing.

## Measurement — survives a crash

Read entirely from disk afterwards. **No final probe. No model answer required.** A run
that dies at file 38 still scores T1–T9.

Two sources, cross-checked:

**1. The pruning audit archive** — `~/.elpis/logs/pruning/passes/<pass_id>/`
- `items/*.json` gives each evaluated item's `decision` (`kept` / `deleted`), its full
  verbatim original, and its replacement text.
- This is what separates *evaluated → kept* from *never eligible*. It is the entire reason
  the metric means anything, and RQ5 already proved these records reconstruct.

**2. The session rollout** — `~/.elpis/sessions/.../rollout-*.jsonl`
- `select(.type=="compacted") | .payload.kind` distinguishes prune checkpoints from real
  compactions.
- The final prune checkpoint's `replacement_history` is the surviving context.

Per fact:
1. Locate the tool output that introduced it (exact match on the token).
2. Search every pass's `items/` for that item's `call_id`.
   - absent from all passes → **never eligible**
   - present with `decision: kept` → **evaluated → kept**
   - present with `decision: deleted` → search the replacement text for the token:
     found → **preserved**; absent → **lost**
3. Confirm every `lost` against the last checkpoint's `replacement_history`.

## Runs

5 runs, same protocol, a different corpus seed each time (different service names,
different random tokens, identical structure and sizes). ~10–15 minutes each.

**Interruption rule** — replacing the v1 stop rule that killed the experiment: a run that
dies partway is **kept and scored** for the facts it reached. Only a run that dies before
the first pruning pass is discarded. Record the interruption point. Never rerun silently.

`server_overloaded` is likely again — 22 of 167 recent pruning calls failed. This design
tolerates that instead of pretending it will not happen.

## Claims this supports

**Can:** whether pruning preserves information it chose to act on — 5 runs, up to 12
evaluated facts each, one synthetic corpus, one commit.

**Cannot:** anything about real repositories; whether the agent *uses* what it retained;
task correctness. Those are RQ3.

**Do not** tune the pruner to improve the numbers. `646c94a` is the commit the rest of the
corpus was measured on, and the result is meant to be honest either way.

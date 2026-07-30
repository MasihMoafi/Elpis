# Context-Continuity Comparison

Status: protocol and deterministic scorer implemented; provider runs not performed.
No comparative score is published until both systems have complete raw transcripts.

## Question

After the same long-session and restart sequence, can the system recover planted
working-state facts without inventing absent facts?

The protocol has three groups of ten:

- `exact`: direct recall of a planted token;
- `semantic`: the same facts asked through paraphrases;
- `negative`: absent-token checks that punish confident invention.

This isolates continuity from coding quality. It does not measure general intelligence,
latency, cost, or code correctness.

## Run contract

1. Pin an Elpis commit, an upstream Codex commit, model, provider, model settings,
   system instructions, and operating-system image in a run manifest.
2. Start each system in a clean temporary workspace with memory off.
3. Give it [fixture.md](fixture.md), create enough ordinary turns to trigger the
   system's real compaction path, then restart/resume through the supported product UI.
4. Ask all rows in [cases.tsv](cases.tsv) in order. Save one unedited transcript per
   system and a two-column `results.tsv` containing `id<TAB>answer`.
5. Run each setup ten times. A run is invalid if either system did not receive the same
   prompt sequence or did not traverse its real compaction and restart path.
6. Score exact string equality. Do not manually reinterpret an answer.

Compile the dependency-free scorer once:

```bash
rustc docs/evals/context-continuity/score.rs \
  -o /tmp/elpis-score-context-continuity
/tmp/elpis-score-context-continuity \
  docs/evals/context-continuity/cases.tsv \
  --self-test
/tmp/elpis-score-context-continuity \
  docs/evals/context-continuity/cases.tsv \
  path/to/results.tsv
```

## Publication gate

A README chart may be added only when the repository contains:

- the pinned manifest for every setup;
- 10 complete Elpis transcripts and 10 complete Codex transcripts;
- the 20 result files and scorer output;
- failures as well as successes;
- cost and latency reported separately from correctness.

The historical README screenshots do not satisfy this gate because they do not include
raw per-run data. They remain visual examples, not comparative evidence.

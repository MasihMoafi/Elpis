# Accountable Work-Graph Eval

This eval asks whether a work graph can report success while hiding work or bypassing
independent verification. It contains three negative checks:

1. A real worker changes a file but omits it from its report. The graph must fail.
2. A writable task has no directly dependent `verify` task. Graph creation must fail.
3. Two writable tasks target one environment. They must not become runnable together,
   even when their declared paths do not overlap.

The checks were added at commit `f77d53f` and run against the then-current engine. All
three failed. The production change at `750a0e8` makes all three pass. The raw values are
in [results.csv](results.csv); the chart is generated from that file, not edited by
hand.

## Reproduce

From the repository root:

```bash
export CODEX_SKIP_BWRAP_BUILD=1
export RUST_MIN_STACK=67108864

cargo test --manifest-path codex-rs/Cargo.toml -p codex-core \
  work_graph_rejects_a_real_change_omitted_from_the_worker_report -- --nocapture
cargo test --manifest-path codex-rs/Cargo.toml -p codex-core \
  one_environment_never_runs_two_writable_tasks_concurrently -- --nocapture
cargo test --manifest-path codex-rs/Cargo.toml -p codex-core \
  writable_graph_requires_an_independent_verification_task -- --nocapture

rustc docs/evals/accountable-work-graphs/render.rs \
  -o /tmp/elpis-render-work-graph-eval
/tmp/elpis-render-work-graph-eval \
  docs/evals/accountable-work-graphs/results.csv \
  docs/assets/accountable-work-graph-eval.svg
git diff --exit-code -- docs/assets/accountable-work-graph-eval.svg
```

The 64 MiB test-thread stack avoids the repository's known Tokio test-stack overflow.
It does not change product behavior.

## Boundary

This is a narrow regression eval, not a claim that arbitrary multi-agent work is
correct. It proves the three named gates. Worker reasoning, the quality of acceptance
criteria, coordinator review, and Masih's functional acceptance remain outside its
scope.

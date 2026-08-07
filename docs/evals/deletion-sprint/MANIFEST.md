# Run manifest

| | |
| --- | --- |
| Base commit | `679a244` |
| Rust source lines at base | 1,116,661 (`codex-rs/**/*.rs`, excluding `target/`) |
| Elpis worktree | `../Elpis-exp3-elpis`, branch `exp3/elpis` |
| Codex worktree | `../Elpis-exp3-codex`, branch `exp3/codex` |
| Model | Luna, max reasoning |
| Budget | 2 hours per system |
| Date | _fill at run time_ |
| Elpis version | _fill at run time_ |
| Codex version | _fill at run time_ |

All four worktrees verified identical at `679a244` before any run. That commit is
`main` with `docs/evals/` removed, so the code under test matches the tree the
failing-test baseline is captured from while the scoring rules stay out of reach.

## Failing-test baseline

Captured at `f2486d6` (same code as `679a244`) before either run. Any test outside
this list that fails afterwards is a regression.

_Not yet captured._

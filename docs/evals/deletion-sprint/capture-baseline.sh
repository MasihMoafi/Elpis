#!/usr/bin/env bash
# Records which tests fail at the base commit, so a regression can be told apart from
# breakage that was already there. Run this in the main tree, never in an experiment
# worktree. Safe to re-run; each run writes its own timestamped file.
set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 1
out="docs/evals/deletion-sprint/baseline"
mkdir -p "$out"
stamp=$(date +%Y-%m-%dT%H-%M-%S)
commit=$(git rev-parse --short HEAD)

export CODEX_SKIP_BWRAP_BUILD=1

for crate in codex-core codex-tui; do
  log="$out/${stamp}_${commit}_${crate}.log"
  echo "running $crate -> $log"
  (cd codex-rs && cargo test -p "$crate" --no-fail-fast) >"$log" 2>&1
  echo "  exit $?"
done

# Failing test names, one per line, for a straight diff after each run.
grep -h '^test .* FAILED$\|^    [a-z_:0-9]*$' "$out/${stamp}_${commit}"_*.log 2>/dev/null \
  | sed 's/^test //; s/ FAILED$//; s/^ *//' | sort -u \
  > "$out/${stamp}_${commit}_failing.txt"

echo
echo "failing tests: $(wc -l < "$out/${stamp}_${commit}_failing.txt")"
echo "written to $out/${stamp}_${commit}_failing.txt"

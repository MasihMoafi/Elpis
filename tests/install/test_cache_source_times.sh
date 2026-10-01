#!/usr/bin/env bash
set -euo pipefail
helper=$(realpath "${1:-scripts/restore-cargo-cache-source-times.sh}")
fixture=$(mktemp -d)
trap 'gio trash "$fixture"' EXIT
cd "$fixture"
git init -q
git config user.name 'Cache fixture'
git config user.email 'fixture@example.invalid'
mkdir codex-rs
printf original > codex-rs/source.rs
git add codex-rs
git commit -qm source
cached_sha=$(git rev-parse HEAD)
printf harness > harness
git add harness
git commit -qm harness
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 0
touch -d @123 codex-rs/source.rs
printf extra > codex-rs/untracked.rs
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 123
gio trash codex-rs/untracked.rs
printf dirty >> codex-rs/source.rs
touch -d @123 codex-rs/source.rs
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 123
git add codex-rs/source.rs
git commit -qm changed
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 123
bash "$helper" unknown
bash "$helper" cache-0000000000000000000000000000000000000000
test "$(stat -c %Y codex-rs/source.rs)" = 123
test "$(cat codex-rs/source.rs)" = originaldirty
printf 'PASS unchanged tree reused; changed, dirty, untracked and unknown trees stay fresh\n'

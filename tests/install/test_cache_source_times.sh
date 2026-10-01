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
mkdir -p .github/workflows
printf '      - name: Download and verify the pinned sandbox V8\n        checksum: original\n      - uses: actions/cache/restore@fixture\n' > .github/workflows/embedded-elpis-linux.yml
export RUSTY_V8_ARCHIVE="$fixture/archive"
export RUSTY_V8_SRC_BINDING_PATH="$fixture/bindings"
printf verified > "$RUSTY_V8_ARCHIVE"
printf verified > "$RUSTY_V8_SRC_BINDING_PATH"
git add codex-rs .github
git commit -qm source
cached_sha=$(git rev-parse HEAD)
printf harness > harness
git add harness
git commit -qm harness
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 0
test "$(stat -c %Y "$RUSTY_V8_ARCHIVE")" = 0
test "$(stat -c %Y "$RUSTY_V8_SRC_BINDING_PATH")" = 0
touch -d @123 "$RUSTY_V8_ARCHIVE" "$RUSTY_V8_SRC_BINDING_PATH"
sed -i s/original/changed/ .github/workflows/embedded-elpis-linux.yml
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y "$RUSTY_V8_ARCHIVE")" = 123
test "$(stat -c %Y "$RUSTY_V8_SRC_BINDING_PATH")" = 123
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

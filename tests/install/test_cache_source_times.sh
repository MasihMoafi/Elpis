#!/usr/bin/env bash
set -euo pipefail
helper=$(realpath "${1:-scripts/restore-cargo-cache-source-times.sh}")
fixture=$(mktemp -d)
# /tmp is cleared at boot; gio cannot trash on that mount.
trap 'gio trash "$fixture" 2>/dev/null || true' EXIT
cd "$fixture"
git init -q
git config user.name 'Cache fixture'
git config user.email 'fixture@example.invalid'
mkdir codex-rs
printf original > codex-rs/source.rs
printf unchanged > codex-rs/unchanged.rs
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
mv codex-rs/untracked.rs .git/untracked.rs
printf dirty >> codex-rs/source.rs
touch -d @123 codex-rs/source.rs
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 123
git add codex-rs/source.rs
git commit -qm changed
touch -d @123 codex-rs/unchanged.rs
bash "$helper" "cache-$cached_sha"
test "$(stat -c %Y codex-rs/source.rs)" = 123
test "$(stat -c %Y codex-rs/unchanged.rs)" = 0
# Added and renamed inputs stay fresh too; old paths in dep-info stay missing.
git mv codex-rs/unchanged.rs codex-rs/renamed.rs
printf added > codex-rs/added.rs
git add codex-rs/renamed.rs codex-rs/added.rs
git commit -qm moved
touch -d @456 codex-rs/renamed.rs codex-rs/added.rs
bash "$helper" "cache-$cached_sha"
test ! -e codex-rs/unchanged.rs
test "$(stat -c %Y codex-rs/renamed.rs)" = 456
test "$(stat -c %Y codex-rs/added.rs)" = 456
bash "$helper" unknown
bash "$helper" cache-0000000000000000000000000000000000000000
test "$(stat -c %Y codex-rs/source.rs)" = 123
test "$(cat codex-rs/source.rs)" = originaldirty
printf 'PASS unchanged inputs reused; changed, added, renamed, dirty, untracked and unknown inputs stay fresh\n'

#!/usr/bin/env bash
# A fresh checkout otherwise makes Cargo rebuild unchanged workspace sources.
# Restore times only for inputs whose path and contents match the cached commit.
set -euo pipefail
cached_sha=${1##*-}
if [[ ! $cached_sha =~ ^[0-9a-f]{40}$ ]] ||
   ! git cat-file -e "$cached_sha^{commit}" 2>/dev/null ||
   ! git diff --quiet HEAD -- codex-rs ||
   [[ -n $(git ls-files --others --exclude-standard -- codex-rs) ]]; then
    printf 'Source cache is dirty or unknown; keep normal Cargo freshness checks\n'
    exit 0
fi
# Changed manifests, sources, includes and added/renamed paths retain checkout times.
# Cargo sees those changes normally; a fresh checkout does not make it rebuild every
# unchanged workspace dependency. Disable rename detection so both paths stay fresh.
LC_ALL=C comm -z -23 \
    <(git ls-files -z codex-rs | LC_ALL=C sort -z) \
    <(git diff --no-renames --name-only -z "$cached_sha" HEAD -- codex-rs | LC_ALL=C sort -z) \
    | xargs -0 -r touch -h -d @0
workflow=.github/workflows/embedded-elpis-linux.yml
v8_inputs() {
    sed -n '/^      - name: Download and verify the pinned sandbox V8$/,/^      - uses: actions\/cache\//{ /^      - uses: actions\/cache\//d; p; }'
}
# Rust includes these downloaded bindings directly. Their checksum-verifying
# download step must also be identical before their times can be restored.
if [[ -f ${RUSTY_V8_ARCHIVE:-} && -f ${RUSTY_V8_SRC_BINDING_PATH:-} && -f $workflow ]] &&
   git cat-file -e "$cached_sha:$workflow" 2>/dev/null; then
    cached_v8=$(git show "$cached_sha:$workflow" | v8_inputs)
    current_v8=$(v8_inputs < "$workflow")
    if [[ -n $cached_v8 && $cached_v8 == "$current_v8" ]]; then
        touch -h -d @0 "$RUSTY_V8_ARCHIVE" "$RUSTY_V8_SRC_BINDING_PATH"
    fi
fi
printf 'Restored unchanged input times; Cargo still checks changed inputs and flags, and runs tests\n'

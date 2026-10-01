#!/usr/bin/env bash
# A fresh checkout otherwise makes Cargo rebuild unchanged workspace sources.
# Only restore their times when the cached commit proves the whole Rust tree equal.
set -euo pipefail
cached_sha=${1##*-}
if [[ ! $cached_sha =~ ^[0-9a-f]{40}$ ]] ||
   ! git cat-file -e "$cached_sha^{commit}" 2>/dev/null ||
   ! git diff --quiet HEAD -- codex-rs ||
   [[ -n $(git ls-files --others --exclude-standard -- codex-rs) ]] ||
   [[ $(git rev-parse "$cached_sha:codex-rs") != $(git rev-parse HEAD:codex-rs) ]]; then
    printf 'Source cache differs or is unknown; keep normal Cargo freshness checks\n'
    exit 0
fi
git ls-files -z codex-rs | xargs -0 -r touch -h -d @0
printf 'Unchanged Rust tree: restored source times; Cargo still checks flags and runs tests\n'

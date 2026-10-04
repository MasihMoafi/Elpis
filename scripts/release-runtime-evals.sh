#!/usr/bin/env bash
# Run the real multitool with loopback fixtures, then prove the controls fail.
set -euo pipefail
binary=$(realpath "${1:?usage: release-runtime-evals.sh BINARY}")
node scripts/elpis-next-identity.test.cjs "$binary"
positive() { node "scripts/$1-runtime.test.cjs" "$binary" "${@:2}"; }
negative() {
  if node "scripts/$1-runtime.test.cjs" "$binary" "${@:2}"; then
    printf 'FAIL negative control unexpectedly passed: %s\n' "$*" >&2
    exit 1
  fi
  printf 'PASS negative control failed as expected: %s\n' "$*"
}
ELPIS_BIN="$binary" node scripts/continuity-admission-runtime.test.cjs
positive pressure-compaction
negative pressure-compaction --drop-pressure
for mode in local token-budget remote-v2; do
  positive compact-instructions "$mode"
  negative compact-instructions "$mode" --drop-instructions
done
positive memory-agent-tool
positive smart-prune
negative smart-prune --drop-prune
positive reasoning-expiry
positive rtk-hook
positive provider-gateway
positive provider-gateway --drop-completion
positive code-mode-install
negative code-mode-install --missing-host
node scripts/elpis-next-privacy.test.cjs "$binary"

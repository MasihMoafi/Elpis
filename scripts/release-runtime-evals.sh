#!/usr/bin/env bash
# Run the real multitool with loopback fixtures, then prove the controls fail.
set -euo pipefail
binary=$(realpath "${1:?usage: release-runtime-evals.sh BINARY}")
node scripts/elpis-next-identity.test.cts "$binary"
positive() { node "scripts/$1-runtime.test.cts" "$binary" "${@:2}"; }
negative() {
  if node "scripts/$1-runtime.test.cts" "$binary" "${@:2}"; then
    printf 'FAIL negative control unexpectedly passed: %s\n' "$*" >&2
    exit 1
  fi
  printf 'PASS negative control failed as expected: %s\n' "$*"
}
ELPIS_BIN="$binary" node scripts/continuity-admission-runtime.test.cts
continuity_negative() {
  local mode=$1 expected=$2 output
  if output=$(ELPIS_BIN="$binary" ELPIS_CONTINUITY_NEGATIVE_CONTROL="$mode" node scripts/continuity-admission-runtime.test.cts 2>&1); then
    printf 'FAIL continuity negative control unexpectedly passed: %s\n' "$mode" >&2
    exit 1
  fi
  if [[ "$output" != *"AssertionError [ERR_ASSERTION]: $expected"* ]]; then
    printf 'FAIL continuity negative control %s failed for the wrong reason:\n%s\n' "$mode" "$output" >&2
    exit 1
  fi
  printf 'PASS continuity negative control failed as expected: %s\n' "$mode"
}
continuity_negative disable-memory-on-admission 'on request had the wrong MEMORY sentinel count'
continuity_negative disable-agents-on-admission 'on request had the wrong AGENTS withdrawal note count'
continuity_negative disable-dev-on-admission 'withdrawn request had the wrong dev-rule sentinel count'
continuity_negative disable-added-on-admission 'on request had the wrong added-file sentinel count'
continuity_negative disable-continuity-on-admission 'on request had the wrong GOAL sentinel count'
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
node scripts/elpis-next-privacy.test.cts "$binary"

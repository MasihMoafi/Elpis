#!/usr/bin/env bash
# shellcheck disable=SC2016 # Single-quoted lines intentionally generate the fake Cargo script.
set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/elpis-verify-test.XXXXXX")
trap 'rm -rf -- "$TMP_ROOT"' EXIT

FIXTURE=
FAKE_CARGO_LOG=
RUN_OUTPUT=
RUN_STATUS=0
declare -a SELECTOR_ENV=()

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

new_fixture() {
    local name=$1
    FIXTURE="$TMP_ROOT/$name"
    FAKE_CARGO_LOG="$FIXTURE/fake-cargo.log"
    mkdir -p \
        "$FIXTURE/bin" \
        "$FIXTURE/codex-rs" \
        "$FIXTURE/scripts" \
        "$FIXTURE/tools/verify-elpis"
    git -C "$FIXTURE" init -q
    cp "$SOURCE_ROOT/scripts/verify-elpis" "$FIXTURE/scripts/verify-elpis"
    cp "$SOURCE_ROOT/tools/verify-elpis/surfaces.toml" \
        "$FIXTURE/tools/verify-elpis/surfaces.toml"
    chmod +x "$FIXTURE/scripts/verify-elpis"
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'set -euo pipefail' \
        '{' \
        '    printf "BEGIN\\0%s\\0%s\\0%s\\0%s\\0" "$PWD" "${CODEX_SKIP_BWRAP_BUILD-}" "${CARGO_TARGET_DIR-}" "$#"' \
        '    printf "%s\\0" "$@"' \
        '    printf "END\\0"' \
        '} >> "$FAKE_CARGO_LOG"' \
        'if [[ ${1-} == test ]]; then' \
        '    printf "%s\\n" "${FAKE_CARGO_OUTPUT-test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out}"' \
        'fi' \
        'if [[ -z ${FAKE_CARGO_FAIL_SUBCOMMAND-} || ${FAKE_CARGO_FAIL_SUBCOMMAND} == "${1-}" ]]; then' \
        '    exit "${FAKE_CARGO_STATUS-0}"' \
        'fi' \
        'exit 0' \
        > "$FIXTURE/bin/cargo"
    chmod +x "$FIXTURE/bin/cargo"
    : > "$FAKE_CARGO_LOG"
    SELECTOR_ENV=()
}

run_selector() {
    local output_file="$FIXTURE/selector-output"
    : > "$FAKE_CARGO_LOG"
    set +e
    (
        cd "$FIXTURE"
        env \
            "${SELECTOR_ENV[@]}" \
            PATH="$FIXTURE/bin:$PATH" \
            FAKE_CARGO_LOG="$FAKE_CARGO_LOG" \
            scripts/verify-elpis "$@"
    ) > "$output_file" 2>&1
    RUN_STATUS=$?
    set -e
    RUN_OUTPUT=$(<"$output_file")
}

assert_status() {
    local expected=$1
    [[ $RUN_STATUS -eq $expected ]] ||
        fail "expected status $expected, got $RUN_STATUS; output: $RUN_OUTPUT"
}

assert_output() {
    local expected=$1
    [[ $RUN_OUTPUT == *"$expected"* ]] ||
        fail "missing output <$expected>; output: $RUN_OUTPUT"
}

assert_not_output() {
    local unexpected=$1
    [[ $RUN_OUTPUT != *"$unexpected"* ]] ||
        fail "unexpected output <$unexpected>; output: $RUN_OUTPUT"
}

output_header() {
    local name=$1
    printf '%s\n' "$RUN_OUTPUT" | sed -n "s/^Elpis verification: ${name}=//p" | head -n 1
}

replace_manifest() {
    local old=$1
    local new=$2
    python3 - "$FIXTURE/tools/verify-elpis/surfaces.toml" "$old" "$new" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
old = sys.argv[2].replace("\\n", "\n")
new = sys.argv[3].replace("\\n", "\n")
text = path.read_text()
if text.count(old) != 1:
    raise SystemExit(f"expected one manifest occurrence, found {text.count(old)}: {old!r}")
path.write_text(text.replace(old, new))
PY
}

assert_call_at() {
    local index=$1
    shift
    python3 - "$FAKE_CARGO_LOG" "$index" "$@" <<'PY'
import os
import sys

fields = open(sys.argv[1], "rb").read().split(b"\0")
if fields and not fields[-1]:
    fields.pop()
calls = []
cursor = 0
while cursor < len(fields):
    if fields[cursor] != b"BEGIN":
        raise SystemExit(f"bad fake-cargo record at field {cursor}")
    cursor += 1
    cwd, skip_bwrap, target = fields[cursor:cursor + 3]
    cursor += 3
    argc = int(fields[cursor])
    cursor += 1
    argv = fields[cursor:cursor + argc]
    cursor += argc
    if cursor >= len(fields) or fields[cursor] != b"END":
        raise SystemExit("unterminated fake-cargo record")
    cursor += 1
    calls.append((cwd, skip_bwrap, target, argv))
index = int(sys.argv[2])
expected = [os.fsencode(arg) for arg in sys.argv[3:]]
if index >= len(calls):
    raise SystemExit(f"missing call {index}; recorded {len(calls)}")
if calls[index][3] != expected:
    raise SystemExit(f"call {index}: expected {expected!r}, got {calls[index][3]!r}")
PY
}

assert_call_count() {
    local expected=$1
    python3 - "$FAKE_CARGO_LOG" "$expected" <<'PY'
import sys

fields = open(sys.argv[1], "rb").read().split(b"BEGIN\0")
actual = len(fields) - 1
expected = int(sys.argv[2])
if actual != expected:
    raise SystemExit(f"expected {expected} Cargo calls, got {actual}")
PY
}

assert_all_cargo_env() {
    local expected_target=${1:-"$FIXTURE/codex-rs/target"}
    python3 - "$FAKE_CARGO_LOG" "$FIXTURE/codex-rs" "$expected_target" <<'PY'
import os
import sys

fields = open(sys.argv[1], "rb").read().split(b"\0")
if fields and not fields[-1]:
    fields.pop()
cursor = 0
count = 0
while cursor < len(fields):
    assert fields[cursor] == b"BEGIN"
    cursor += 1
    cwd, skip_bwrap, target = fields[cursor:cursor + 3]
    cursor += 3
    argc = int(fields[cursor])
    cursor += 1 + argc
    assert fields[cursor] == b"END"
    cursor += 1
    if cwd != os.fsencode(sys.argv[2]):
        raise SystemExit(f"wrong Cargo cwd: {cwd!r}")
    if skip_bwrap != b"1":
        raise SystemExit(f"CODEX_SKIP_BWRAP_BUILD was {skip_bwrap!r}")
    if target != os.fsencode(sys.argv[3]):
        raise SystemExit(f"CARGO_TARGET_DIR was {target!r}")
    count += 1
if count == 0:
    raise SystemExit("no Cargo calls recorded")
PY
}

assert_failure_before_cargo() {
    [[ $RUN_STATUS -ne 0 ]] || fail "expected selector failure; output: $RUN_OUTPUT"
    assert_call_count 0
}

assert_argv_occurrences() {
    local expected=$1
    shift
    python3 - "$FAKE_CARGO_LOG" "$expected" "$@" <<'PY'
import os
import sys

fields = open(sys.argv[1], "rb").read().split(b"\0")
if fields and not fields[-1]:
    fields.pop()
cursor = 0
calls = []
while cursor < len(fields):
    assert fields[cursor] == b"BEGIN"
    cursor += 4
    argc = int(fields[cursor])
    cursor += 1
    calls.append(fields[cursor:cursor + argc])
    cursor += argc
    assert fields[cursor] == b"END"
    cursor += 1
expected_count = int(sys.argv[2])
expected_argv = [os.fsencode(arg) for arg in sys.argv[3:]]
actual = sum(argv == expected_argv for argv in calls)
if actual != expected_count:
    raise SystemExit(f"expected {expected_count} occurrences of {expected_argv!r}, got {actual}")
PY
}

assert_safe_cargo_log() {
    python3 - "$FAKE_CARGO_LOG" <<'PY'
import sys

fields = open(sys.argv[1], "rb").read().split(b"\0")
if fields and not fields[-1]:
    fields.pop()
cursor = 0
while cursor < len(fields):
    assert fields[cursor] == b"BEGIN"
    cursor += 4
    argc = int(fields[cursor])
    cursor += 1
    argv = fields[cursor:cursor + argc]
    cursor += argc
    assert fields[cursor] == b"END"
    cursor += 1
    if argv and argv[0] == b"fmt" and argv != [b"fmt", b"--all", b"--check"]:
        raise SystemExit(f"write-capable format command recorded: {argv!r}")
    forbidden = {b"clean", b"rm", b"install", b"build", b"--release"}
    if any(arg in forbidden or arg.startswith(b"--profile") or arg.startswith(b"--target-dir") for arg in argv):
        raise SystemExit(f"forbidden Cargo argv recorded: {argv!r}")
PY
}

new_fixture dashboard
run_selector --changed codex-rs/tui/src/dashboard_server.rs
assert_status 0
assert_output 'Elpis verification: surfaces=dashboard'
assert_output 'Elpis verification: commands=fmt-check,tui-dashboard,tui-context-usage'
assert_call_count 3
assert_call_at 0 fmt --all --check
assert_call_at 1 test -p codex-tui --lib --locked dashboard
assert_call_at 2 test -p codex-tui --lib --locked context_usage
assert_all_cargo_env

# Explicit surfaces are a stable manifest-order union; repetition and a changed
# path do not duplicate shared commands or trigger the mixed-path fallback.
new_fixture explicit-union
run_selector --surface tui --surface dashboard --surface tui
assert_status 0
assert_output 'Elpis verification: surfaces=dashboard,tui'
assert_not_output 'surfaces=full'
explicit_commands=$(output_header commands)
assert_argv_occurrences 1 fmt --all --check

run_selector --surface dashboard --surface tui
assert_status 0
[[ $(output_header commands) == "$explicit_commands" ]] ||
    fail "surface order changed the selected command union"

run_selector --changed codex-rs/tui/src/dashboard_server.rs --surface tui
assert_status 0
[[ $(output_header commands) == "$explicit_commands" ]] ||
    fail "path plus explicit surface did not match the explicit union"

run_selector \
    --changed codex-rs/tui/src/dashboard_server.rs \
    --changed codex-rs/tui/src/dashboard_server.rs
assert_status 0
assert_output 'Elpis verification: surfaces=dashboard'

# Unknown, safety-owned, and mixed focused paths conservatively choose full.
for full_path in \
    codex-rs/unclassified/source.rs \
    codex-rs/protocol/src/lib.rs \
    scripts/verify-elpis
do
    new_fixture "full-${full_path//\//-}"
    run_selector --changed "$full_path"
    assert_status 0
    assert_output 'Elpis verification: surfaces=full'
done

new_fixture mixed-focused
run_selector \
    --changed codex-rs/tui/src/dashboard_server.rs \
    --changed codex-rs/tui/src/app.rs
assert_status 0
assert_output 'Elpis verification: surfaces=full'

# Cross-cutting exceptions must beat each broad family, and each broad family
# must still classify an ordinary member in the other direction.
precedence_paths=(
    'codex-rs/tui/src/dashboard_server.rs|dashboard'
    'codex-rs/tui/src/chatwidget/context_ledger.rs|context-compaction'
    'codex-rs/tui/src/multi_agents.rs|agents-work-graph'
    'codex-rs/tui/src/app.rs|tui'
    'codex-rs/app-server/src/turn_cost_worker.rs|telemetry'
    'codex-rs/app-server/tests/suite/v2/memory_recall.rs|memory'
    'codex-rs/app-server/src/lib.rs|app-server'
    'docs/LOCAL_BUILD_RULES.md|full'
    'docs/notes.md|docs'
)
for entry in "${precedence_paths[@]}"; do
    path=${entry%%|*}
    surface=${entry#*|}
    new_fixture "precedence-${surface}-${path//\//-}"
    run_selector --changed "$path"
    assert_status 0
    assert_output "Elpis verification: surfaces=$surface"
done

# Path-list parsing preserves spaces and, in NUL mode, embedded newlines.
new_fixture newline-list
printf 'docs/a file with spaces.md\n' > "$FIXTURE/paths"
run_selector --paths-file "$FIXTURE/paths"
assert_status 0
assert_output 'Elpis verification: surfaces=docs'
assert_output 'Elpis verification: changed=docs/a file with spaces.md'

new_fixture nul-list
printf 'docs/line\nbreak.md\0' > "$FIXTURE/paths"
run_selector --paths-file "$FIXTURE/paths"
assert_status 0
assert_output 'Elpis verification: surfaces=docs'
assert_output $'Elpis verification: changed=docs/line\nbreak.md'

new_fixture empty-list
: > "$FIXTURE/paths"
run_selector --paths-file "$FIXTURE/paths"
assert_failure_before_cargo

new_fixture missing-list
run_selector --paths-file "$FIXTURE/missing"
assert_failure_before_cargo

new_fixture empty-record-list
printf 'docs/a.md\0\0docs/b.md\0' > "$FIXTURE/paths"
run_selector --paths-file "$FIXTURE/paths"
assert_failure_before_cargo

# Every test-mode manifest row must reject a zero-pass harness result. Point a
# tiny surface at each row so one failing row cannot hide the next one.
mapfile -t test_commands < <(
    python3 - "$SOURCE_ROOT/tools/verify-elpis/surfaces.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    manifest = tomllib.load(handle)
for name, row in manifest["commands"].items():
    if row["mode"] == "test":
        print(name)
PY
)
for command_name in "${test_commands[@]}"; do
    new_fixture "zero-pass-$command_name"
    replace_manifest \
        'name = "docs"\ncommands = ["diff-check"]' \
        "name = \"docs\"\ncommands = [\"$command_name\"]"
    SELECTOR_ENV=(
        'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out'
    )
    run_selector --surface docs
    [[ $RUN_STATUS -ne 0 ]] || fail "$command_name accepted a zero-pass summary"
    assert_output "test command $command_name produced no positive test result"
done

new_fixture multiple-summaries
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["tui-dashboard"]'
SELECTOR_ENV=(
    $'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed\ntest result: ok. 2 passed; 0 failed'
)
run_selector --surface docs
assert_status 0

new_fixture cargo-failure
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["tui-dashboard"]'
SELECTOR_ENV=('FAKE_CARGO_FAIL_SUBCOMMAND=test' 'FAKE_CARGO_STATUS=17')
run_selector --surface docs
[[ $RUN_STATUS -ne 0 ]] || fail "non-zero Cargo status was accepted"
assert_call_count 1

new_fixture no-run-check-mode
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["nightly-tui-compile"]'
SELECTOR_ENV=(
    'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out'
)
run_selector --surface docs
assert_status 0
assert_call_at 0 test -p codex-tui --lib --locked --no-run

# Target overrides are explicit, absolute, writable, and visible to every Cargo
# child. Invalid input and malformed manifests fail before any command runs.
new_fixture absolute-target
custom_target="$FIXTURE/shared target"
SELECTOR_ENV=("ELPIS_CARGO_TARGET_DIR=$custom_target")
run_selector --surface dashboard
assert_status 0
assert_output "Elpis verification: target=$custom_target"
assert_all_cargo_env "$custom_target"

new_fixture no-input
run_selector
assert_failure_before_cargo

new_fixture unknown-surface
run_selector --surface does-not-exist
assert_failure_before_cargo

new_fixture unknown-reference
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["not-a-command"]'
run_selector --surface docs
assert_failure_before_cargo

new_fixture malformed-toml
printf '\n[' >> "$FIXTURE/tools/verify-elpis/surfaces.toml"
run_selector --surface docs
assert_failure_before_cargo

new_fixture malformed-command-type
replace_manifest 'kind = "shell"' 'kind = []'
run_selector --surface docs
assert_failure_before_cargo
assert_output 'verify-elpis: invalid manifest:'
assert_not_output 'Traceback'

new_fixture relative-target
SELECTOR_ENV=('ELPIS_CARGO_TARGET_DIR=relative/target')
run_selector --surface dashboard
assert_failure_before_cargo

new_fixture unwritable-target
SELECTOR_ENV=('ELPIS_CARGO_TARGET_DIR=/proc/elpis-selector-unwritable')
run_selector --surface dashboard
assert_failure_before_cargo

new_fixture arbitrary-shell
replace_manifest \
    $'kind = "shell"\nmode = "check"\nargv = ["git", "diff", "--check"]' \
    $'kind = "shell"\nmode = "check"\nargv = ["touch", "selector-ran"]'
run_selector --surface docs
assert_failure_before_cargo
[[ ! -e "$FIXTURE/selector-ran" ]] || fail "arbitrary shell row executed"

invalid_cargo_rows=(
    'argv = ["clean"]'
    'argv = ["build"]'
    'argv = ["check", "--workspace", "--release"]'
    'argv = ["check", "--workspace", "--profile", "release"]'
    'argv = ["check", "--workspace", "--target-dir", "/tmp/elsewhere"]'
)
for replacement in "${invalid_cargo_rows[@]}"; do
    new_fixture "invalid-cargo-${RANDOM}"
    replace_manifest \
        'argv = ["check", "--workspace", "--all-targets", "--exclude", "codex-sandboxing"]' \
        "$replacement"
    run_selector --surface full
    assert_failure_before_cargo
done

new_fixture mislabeled-no-run
replace_manifest \
    $'[commands.nightly-tui-compile]\nkind = "cargo"\nmode = "check"\nargv = ["test", "-p", "codex-tui", "--lib", "--locked", "--no-run"]' \
    $'[commands.nightly-tui-compile]\nkind = "cargo"\nmode = "test"\nargv = ["test", "-p", "codex-tui", "--lib", "--locked", "--no-run"]'
run_selector --surface nightly-release
assert_failure_before_cargo

# A conservative full selection contains every ordinary row once and never
# emits a write-mode formatter, cleanup, install, release build, or launcher.
new_fixture safe-full
run_selector --surface full
assert_status 0
assert_argv_occurrences 1 fmt --all --check
assert_safe_cargo_log

printf 'PASS: verify-elpis fake-Cargo contract\n'

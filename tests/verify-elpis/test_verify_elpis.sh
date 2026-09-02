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
        '[[ ${CARGO_BUILD_JOBS-} == 2 ]] || { printf "unsafe CARGO_BUILD_JOBS=%s\n" "${CARGO_BUILD_JOBS-}" >&2; exit 91; }' \
        '[[ ${RUST_TEST_THREADS-} == 2 ]] || { printf "unsafe RUST_TEST_THREADS=%s\n" "${RUST_TEST_THREADS-}" >&2; exit 92; }' \
        '[[ ${FAKE_NICE_LEVEL-} == 10 ]] || { printf "unsafe nice level=%s\n" "${FAKE_NICE_LEVEL-}" >&2; exit 93; }' \
        '{' \
        '    printf "BEGIN\\0%s\\0%s\\0%s\\0%s\\0" "$PWD" "${CODEX_SKIP_BWRAP_BUILD-}" "${CARGO_TARGET_DIR-}" "$#"' \
        '    printf "%s\\0" "$@"' \
        '    printf "END\\0"' \
        '} >> "$FAKE_CARGO_LOG"' \
        'if [[ ${1-} == test ]]; then' \
        '    printf "%s\\n" "${FAKE_CARGO_OUTPUT-test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s}"' \
        'fi' \
        'if [[ -z ${FAKE_CARGO_FAIL_SUBCOMMAND-} || ${FAKE_CARGO_FAIL_SUBCOMMAND} == "${1-}" ]]; then' \
        '    exit "${FAKE_CARGO_STATUS-0}"' \
        'fi' \
        'exit 0' \
        > "$FIXTURE/bin/cargo"
    chmod +x "$FIXTURE/bin/cargo"
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'set -euo pipefail' \
        '[[ ${1-} == -n && ${2-} == 10 ]] || { printf "unsafe nice invocation: %q %q\n" "${1-}" "${2-}" >&2; exit 94; }' \
        'shift 2' \
        'export FAKE_NICE_LEVEL=10' \
        'exec "$@"' \
        > "$FIXTURE/bin/nice"
    chmod +x "$FIXTURE/bin/nice"
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
assert_output 'Elpis verification: surfaces=dashboard,memory'
assert_output 'Elpis verification: commands=fmt-check,tui-dashboard,tui-context-usage,core-elpis-context,tui-context-ledger,tui-manual-memory,app-server-memory-recall,core-memory-dir-bounds,core-memory-permission-profile'
assert_call_count 9
assert_call_at 0 fmt --all --check
assert_call_at 1 test -p codex-tui --lib --locked dashboard
assert_call_at 2 test -p codex-tui --lib --locked context_usage
assert_call_at 3 test -p codex-core --lib --locked elpis_context
assert_call_at 4 test -p codex-tui --lib context_ledger --locked
assert_call_at 5 test -p codex-tui --lib --locked manual_memory_
assert_call_at 6 test -p codex-app-server --test all --locked memory_recall
assert_call_at 7 test -p codex-core --lib --locked memory_dir_is_readable_without_creating_or_widening_writes
assert_call_at 8 test -p codex-core --lib --locked permission_profile_override_keeps_memories_root_out_of_legacy_projection
assert_all_cargo_env

new_fixture memory
run_selector --surface memory
assert_status 0
assert_output 'Elpis verification: surfaces=memory'
assert_output 'Elpis verification: commands=fmt-check,tui-dashboard,tui-context-usage,core-elpis-context,tui-context-ledger,tui-manual-memory,app-server-memory-recall,core-memory-dir-bounds,core-memory-permission-profile'
assert_call_count 9
assert_argv_occurrences 1 test -p codex-core --lib --locked elpis_context
assert_argv_occurrences 1 test -p codex-app-server --test all --locked memory_recall
assert_argv_occurrences 1 test -p codex-tui --lib --locked manual_memory_
assert_argv_occurrences 1 test -p codex-tui --lib context_ledger --locked
assert_argv_occurrences 1 test -p codex-tui --lib --locked dashboard
assert_argv_occurrences 1 test -p codex-tui --lib --locked context_usage

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

run_selector --changed codex-rs/tui/src/bottom_pane/mod.rs --surface dashboard
assert_status 0
[[ $(output_header commands) == "$explicit_commands" ]] ||
    fail "path plus explicit surface did not match the explicit union"

run_selector \
    --changed codex-rs/tui/src/dashboard_server.rs \
    --changed codex-rs/tui/src/dashboard_server.rs
assert_status 0
assert_output 'Elpis verification: surfaces=dashboard,memory'

# Unknown, safety-owned, and mixed focused paths conservatively choose full.
for full_path in \
    codex-rs/unclassified/source.rs \
    codex-rs/protocol/src/lib.rs \
    scripts/verify-elpis \
    tests/verify-elpis/test_verify_elpis.sh \
    tools/verify-elpis/surfaces.toml
do
    new_fixture "full-${full_path//\//-}"
    run_selector --changed "$full_path"
    assert_status 0
    assert_output 'Elpis verification: surfaces=full'
done

new_fixture same-memory-tui-signature
run_selector \
    --changed codex-rs/tui/src/app.rs \
    --changed codex-rs/tui/src/status/card.rs
assert_status 0
assert_output 'Elpis verification: surfaces=tui,memory'

new_fixture mixed-focused
run_selector \
    --changed codex-rs/tui/src/dashboard_server.rs \
    --changed codex-rs/tui/src/app.rs
assert_status 0
assert_output 'Elpis verification: surfaces=full'

new_fixture mixed-manual-memory
run_selector \
    --changed codex-rs/core/src/elpis_context.rs \
    --changed codex-rs/tui/src/app.rs
assert_status 0
assert_output 'Elpis verification: surfaces=full'

new_fixture complete-a4-selects-full
run_selector \
    --changed codex-rs/tui/src/chatwidget/context_ledger.rs \
    --changed codex-rs/tui/src/dashboard_server_tests.rs \
    --changed docs/context.md \
    --changed tools/verify-elpis/surfaces.toml \
    --changed tests/verify-elpis/test_verify_elpis.sh
assert_status 0
assert_output 'Elpis verification: surfaces=full'

# Cross-cutting exceptions must beat each broad family, and each broad family
# must still classify an ordinary member in the other direction.
precedence_paths=(
    'codex-rs/core/src/elpis_context.rs|context-compaction,memory'
    'codex-rs/core/src/agents_md_manager.rs|context-compaction,memory'
    'codex-rs/app-server/src/extensions.rs|app-server,memory'
    'codex-rs/tui/src/dashboard_server.rs|dashboard,memory'
    'codex-rs/tui/src/dashboard_server_tests.rs|dashboard,memory'
    'codex-rs/tui/src/dashboard_assets/index.html|dashboard,memory'
    'codex-rs/tui/src/chatwidget/context_usage.rs|dashboard,memory'
    'codex-rs/tui/src/chatwidget/context_ledger.rs|context-compaction,memory'
    'codex-rs/tui/src/chatwidget/tests/context_ledger.rs|context-compaction,memory'
    'codex-rs/tui/src/app.rs|tui,memory'
    'codex-rs/tui/src/app_event.rs|tui,memory'
    'codex-rs/tui/src/app/app_server_events.rs|tui,memory'
    'codex-rs/tui/src/app/background_requests.rs|tui,memory'
    'codex-rs/tui/src/app/event_dispatch.rs|tui,memory'
    'codex-rs/tui/src/app/session_lifecycle.rs|tui,memory'
    'codex-rs/tui/src/app/test_support.rs|tui,memory'
    'codex-rs/tui/src/app/tests.rs|tui,memory'
    'codex-rs/tui/src/app/tests/manual_memory.rs|tui,memory'
    'codex-rs/tui/src/app/thread_routing.rs|tui,memory'
    'codex-rs/tui/src/chatwidget.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/constructor.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/session_flow.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/input_flow.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/input_restore.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/input_submission.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/slash_dispatch.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/status_controls.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/tests.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/tests/composer_submission.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/tests/slash_commands.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/tests/status_command_tests.rs|tui,memory'
    'codex-rs/tui/src/chatwidget/user_messages.rs|tui,memory'
    'codex-rs/tui/src/status/card.rs|tui,memory'
    'codex-rs/tui/src/status/mod.rs|tui,memory'
    'codex-rs/tui/src/status/tests.rs|tui,memory'
    'codex-rs/tui/src/clipboard_copy.rs|tui,memory'
    'codex-rs/tui/src/multi_agents.rs|agents-work-graph'
    'codex-rs/tui/src/bottom_pane/mod.rs|tui'
    'codex-rs/app-server/src/turn_cost_worker.rs|telemetry'
    'codex-rs/app-server/tests/suite/v2/memory_recall.rs|memory'
    'codex-rs/app-server/src/lib.rs|app-server'
    'docs/LOCAL_BUILD_RULES.md|full'
    'docs/context.md|docs,memory'
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
        'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
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
    $'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'
)
run_selector --surface docs
assert_status 0

new_fixture spoofed-positive-summary
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["tui-dashboard"]'
SELECTOR_ENV=(
    $'FAKE_CARGO_OUTPUT=application output: test result: ok. 1 passed\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
)
run_selector --surface docs
[[ $RUN_STATUS -ne 0 ]] || fail "ordinary output spoofed a positive test-harness summary"
assert_output 'test command tui-dashboard produced no positive test result'

new_fixture suffix-spoofed-positive-summary
replace_manifest \
    'name = "docs"\ncommands = ["diff-check"]' \
    'name = "docs"\ncommands = ["tui-dashboard"]'
SELECTOR_ENV=(
    $'FAKE_CARGO_OUTPUT=test result: ok. 1 passed (application text, not a harness summary)\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
)
run_selector --surface docs
[[ $RUN_STATUS -ne 0 ]] || fail "line-start application output spoofed a positive test-harness summary"
assert_output 'test command tui-dashboard produced no positive test result'

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
    'FAKE_CARGO_OUTPUT=test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
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

new_fixture targetless-test-command
replace_manifest \
    'argv = ["test", "-p", "codex-tui", "--lib", "--locked", "dashboard"]' \
    'argv = ["test", "-p", "codex-tui", "--locked", "dashboard"]'
run_selector --surface dashboard
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

python3 - \
    "$SOURCE_ROOT/.github/workflows/embedded-elpis-linux.yml" \
    "$SOURCE_ROOT/.github/workflows/launcher-diagnostics.yml" <<'PY'
from pathlib import Path
import sys


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"workflow assertion failed: {message}")


main = Path(sys.argv[1]).read_text()
launcher = Path(sys.argv[2]).read_text()
linux, separator, macos_and_later = main.partition("\n  build-macos:")
require(bool(separator), "main workflow must retain the macOS job boundary")

for trigger_path in (
    ".github/workflows/launcher-diagnostics.yml",
    "scripts/verify-elpis",
    "tools/verify-elpis/surfaces.toml",
    "tests/verify-elpis/test_verify_elpis.sh",
    "docs/**",
):
    require(main.count(f"      - {trigger_path}\n") == 2, f"missing PR/push path {trigger_path}")

require(linux.count("fetch-depth: 0") >= 2, "both Linux checkouts must fetch exact diff endpoints")
require("bash tests/verify-elpis/test_verify_elpis.sh" in linux, "Linux must run the fake-Cargo harness")
require(
    'git diff --name-only -z "$base" "$head" > "$RUNNER_TEMP/elpis-changed-paths"' in linux,
    "Linux must write a NUL-delimited changed-path list",
)
for exact_endpoint in (
    'base="${{ github.event.pull_request.base.sha }}"',
    'head="${{ github.event.pull_request.head.sha }}"',
    'base="${{ github.event.before }}"',
    'head="${{ github.sha }}"',
):
    require(exact_endpoint in linux, f"missing exact diff endpoint {exact_endpoint}")

changed_call = 'scripts/verify-elpis --paths-file "$RUNNER_TEMP/elpis-changed-paths"'
require(linux.count(changed_call) == 1, "Linux must call the changed-path selector exactly once")
require(linux.count("scripts/verify-elpis --surface full") == 1, "Linux must call full exactly once")
require(
    linux.count("scripts/verify-elpis --surface nightly-release") == 1,
    "Linux must call nightly-release only in the exhaustive branch",
)
change_condition = (
    "        if: ${{ github.event_name == 'pull_request' || "
    "(github.event_name == 'push' && !startsWith(github.ref, 'refs/tags/')) }}\n"
)
require(linux.count(change_condition) == 2, "changed-path steps must share the PR/push condition")
require(
    "      - name: Verify conservative full Linux surface\n"
    "        if: ${{ github.event_name == 'schedule' || startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch' }}\n"
    "        run: scripts/verify-elpis --surface full\n"
    in linux,
    "schedule/tag/manual must select the full surface",
)
require(
    "      - name: Run exhaustive continuity regression\n"
    "        if: ${{ github.event_name == 'schedule' || startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.full_regression) }}\n"
    "        run: scripts/verify-elpis --surface nightly-release\n"
    in linux,
    "nightly-release must retain the existing exhaustive condition",
)
require(
    linux.index("bash tests/verify-elpis/test_verify_elpis.sh") < linux.index("scripts/verify-elpis --"),
    "fake-Cargo harness must run before selector use",
)
require("run_filter()" not in linux, "Linux must not retain a run_filter helper")
require("cargo test -p" not in linux, "Linux must not retain a copied focused Cargo list")
require(
    "    defaults:\n      run:\n        working-directory: codex-rs\n" not in linux,
    "Linux selector steps must be root-scoped",
)
require(
    linux.count('      CODEX_SKIP_BWRAP_BUILD: "1"\n') == 1,
    "Linux build job must export CODEX_SKIP_BWRAP_BUILD=1",
)
for root_step in (
    "Verify selector harness",
    "Verify changed Linux surfaces",
    "Verify conservative full Linux surface",
    "Run exhaustive continuity regression",
):
    require(
        f"      - name: {root_step}\n        working-directory:" not in linux,
        f"{root_step} must remain root-scoped",
    )

for retained in (
    "cargo build -p codex-tui --bin elpis --locked --timings --release",
    "target/release/elpis --help",
    "cargo install cargo-deb --locked",
    "cargo deb --no-build -p codex-tui",
    "name: elpis-linux-x86_64",
    "name: elpis-deb",
    "name: elpis-cargo-timings",
):
    require(retained in linux, f"Linux release behavior disappeared: {retained}")
require(
    "      - name: Build Elpis binary and Cargo timing report\n        working-directory: codex-rs\n" in linux,
    "release build must retain codex-rs working directory",
)
require(
    "      - name: Verify executable identity\n        working-directory: codex-rs\n" in linux,
    "identity check must retain codex-rs working directory",
)
require(
    "      - name: Reduce artifact size\n        working-directory: codex-rs\n" in linux,
    "strip step must retain codex-rs working directory",
)
require(
    "      - name: Package .deb\n        if: startsWith(github.ref, 'refs/tags/v')\n        working-directory: codex-rs\n" in linux,
    "package step must retain codex-rs working directory",
)
require("cargo test -p codex-tui --bin elpis --locked --target" in macos_and_later, "macOS checks changed")

require("scripts/verify-elpis --surface tui" in launcher, "launcher must reuse the TUI surface")
require("cargo test -p codex-tui --bin elpis" not in launcher, "launcher must not retain a Cargo list")
require("run_filter()" not in launcher, "launcher must not add a second test helper")
require(
    not any(line.strip() == "cargo fmt --all" for line in launcher.splitlines()),
    "launcher must not run write-mode formatting",
)
require(
    launcher.index("Materialize reviewed integration source") < launcher.index("scripts/verify-elpis --surface tui"),
    "launcher selector must run after materialization",
)
for retained in (
    "continue-on-error: true",
    "path: /tmp/elpis-launcher.log",
    "name: elpis-launcher-diagnostics",
    "if: steps.launcher.outcome == 'failure'",
):
    require(retained in launcher, f"launcher diagnostic behavior disappeared: {retained}")
PY

python3 - \
    "$SOURCE_ROOT/docs/LOCAL_BUILD_RULES.md" \
    "$SOURCE_ROOT/docs/SHIPPING_RULES.md" <<'PY'
from pathlib import Path
import re
import shlex
import sys


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"documentation assertion failed: {message}")


def section(document: str, heading: str) -> str:
    marker = f"{heading}\n"
    require(document.count(marker) == 1, f"missing section {heading}")
    body = document.split(marker, 1)[1]
    return body.split("\n## ", 1)[0].strip()


def squash(text: str) -> str:
    return " ".join(text.split())


local = Path(sys.argv[1]).read_text()
shipping = Path(sys.argv[2]).read_text()
local_selector = section(local, "## 7. Checked verification selector")
shipping_boundary = section(shipping, "## 7. Selector evidence is not shipping evidence")

expected_examples = [
    "CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --changed codex-rs/tui/src/dashboard_server.rs",
    "CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --surface full",
    "CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 ELPIS_CARGO_TARGET_DIR=/absolute/shared/target nice -n 10 scripts/verify-elpis --surface tui",
]
code_blocks = re.findall(r"```bash\n(.*?)\n```", local_selector, flags=re.DOTALL)
require(code_blocks == ["\n".join(expected_examples)], "local selector examples must be one exact Bash block")
require("from the repository root" in local_selector, "selector examples must state their working directory")
for index, example in enumerate(expected_examples):
    argv = shlex.split(example)
    selector_index = 6 if index == 2 else 5
    require(argv[selector_index] == "scripts/verify-elpis", f"example does not call the selector: {example}")

local_contract = squash(local_selector)
for clause in (
    "The selector itself forces `CARGO_BUILD_JOBS=2`, `RUST_TEST_THREADS=2`, `CODEX_SKIP_BWRAP_BUILD=1`, and `CARGO_TARGET_DIR=<selected target>` for every Cargo child, invoking it through `nice -n 10`.",
    "The wrapper in the examples keeps that hardware policy visible at the call site too.",
    "Without an override, it runs `git rev-parse --path-format=absolute --git-common-dir`, takes the common directory's parent, and uses `<parent>/codex-rs/target`.",
    "`ELPIS_CARGO_TARGET_DIR` is accepted only when the value is absolute and the target is writable.",
    "It may create the target directory, but it never deletes targets or caches and never runs `cargo clean`.",
    "`cargo fmt --all --check` is the one narrow check-only exception to section 6: it checks the whole workspace without rewriting source.",
    "Plain `cargo fmt --all` remains prohibited.",
):
    require(clause in local_contract, f"local selector contract missing: {clause}")

shipping_contract = squash(shipping_boundary)
for clause in (
    "`scripts/verify-elpis` is proportional local/Linux verification evidence, not shipping evidence.",
    "a release artifact build;",
    "installing or packaging that artifact, or launching the installed result;",
    "the tag-only workflow and confirmation that the release was published;",
    "verification on a clean machine or clean container;",
    "an authorized remote-CI run;",
    "Masih's manual acceptance.",
    "The selector does not build or prove a shippable release artifact; it does not install, package, launch, tag, publish, or grant acceptance.",
    "Its Cargo check and test rows may still compile code and consume CPU and disk.",
):
    require(clause in shipping_contract, f"shipping boundary missing: {clause}")
PY

printf 'PASS: verify-elpis fake-Cargo contract\n'

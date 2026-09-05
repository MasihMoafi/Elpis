#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
manifest="$repo_root/codex-rs/Cargo.toml"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/elpis-build-wrapper-test.XXXXXX")
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/bin" "$fixture/thermal/hwmon/hwmon0" "$fixture/thermal/thermal" \
    "$fixture/repo/scripts" "$fixture/repo/codex-rs/target/local-release"
cp "$repo_root/scripts/build-elpis-local" "$fixture/repo/scripts/"
build_script=${ELPIS_BUILD_SCRIPT_OVERRIDE:-"$fixture/repo/scripts/build-elpis-local"}
fake_log="$fixture/cargo.log"

cat >"$fixture/bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'jobs=%s\n' "${CARGO_BUILD_JOBS-}" >>"$ELPIS_FAKE_CARGO_LOG"
printf 'skip_bwrap=%s\n' "${CODEX_SKIP_BWRAP_BUILD-}" >>"$ELPIS_FAKE_CARGO_LOG"
printf 'rustc_bootstrap=%s\n' "${RUSTC_BOOTSTRAP-}" >>"$ELPIS_FAKE_CARGO_LOG"
printf 'rustflags=%s\n' "${RUSTFLAGS-}" >>"$ELPIS_FAKE_CARGO_LOG"
if [ -n "${ELPIS_FAKE_LEADER_PID_FILE-}" ]; then
    printf '%s\n' "$$" >"$ELPIS_FAKE_LEADER_PID_FILE"
fi
printf 'argv=' >>"$ELPIS_FAKE_CARGO_LOG"
printf '%q ' "$@" >>"$ELPIS_FAKE_CARGO_LOG"
printf '\n' >>"$ELPIS_FAKE_CARGO_LOG"
if [ "${ELPIS_FAKE_LOSE_SENSOR-0}" = 1 ]; then
    printf 'unreadable\n' >"$ELPIS_THERMAL_ROOT/hwmon/hwmon0/temp1_input"
fi
if [ -n "${ELPIS_FAKE_CHILD_PID_FILE-}" ]; then
    sleep 30 &
    child_pid=$!
    printf '%s\n' "$child_pid" >"$ELPIS_FAKE_CHILD_PID_FILE"
    trap 'kill -TERM "$child_pid" 2>/dev/null || true; wait "$child_pid" 2>/dev/null || true; exit 143' TERM INT
fi
sleep "${ELPIS_FAKE_CARGO_SLEEP-0}"
if [ -n "${ELPIS_FAKE_CHILD_PID_FILE-}" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
fi
printf 'completed=1\n' >>"$ELPIS_FAKE_CARGO_LOG"
exit "${ELPIS_FAKE_CARGO_EXIT-0}"
SH
chmod +x "$fixture/bin/cargo"

cat >"$fixture/bin/nice" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "${1-}" = -n
shift 2
exec "$@"
SH
chmod +x "$fixture/bin/nice"

cat >"$fixture/bin/getconf" <<'SH'
#!/usr/bin/env bash
printf '16\n'
SH
chmod +x "$fixture/bin/getconf"

cat >"$fixture/bin/rustc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$fixture/bin/rustc"

run_build() {
    env \
        PATH="$fixture/bin:$PATH" \
        ELPIS_FAKE_CARGO_LOG="$fake_log" \
        ELPIS_THERMAL_ROOT="$fixture/thermal" \
        ELPIS_MAX_TEMP_C="${ELPIS_MAX_TEMP_C:-80}" \
        ELPIS_TEMP_POLL_SECONDS=0.05 \
        "$build_script" "$@"
}

assert_not_running() {
    local pid=$1 state
    for _ in $(seq 1 20); do
        if [ ! -r "/proc/$pid/stat" ]; then return 0; fi
        state=$(awk '{print $3}' "/proc/$pid/stat")
        if [ "$state" = Z ]; then return 0; fi
        sleep 0.05
    done
    return 1
}
assert_stopped() {
    local pid=$1 state
    for _ in $(seq 1 40); do
        if [ -r "/proc/$pid/stat" ]; then
            state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)
            [ "$state" = T ] && return 0
        fi
        sleep 0.025
    done
    return 1
}

# Existing cases explicitly exercise the user-selected eight-job override.
export ELPIS_BUILD_JOBS=8
printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
run_build optimized >"$fixture/cool.out"
grep -q '^jobs=8$' "$fake_log"
grep -q '^skip_bwrap=1$' "$fake_log"
grep -q '^rustc_bootstrap=1$' "$fake_log"
grep -q 'rustflags=.*-Zthreads=8' "$fake_log"
grep -q 'rustflags=.*-Clinker-features=+lld' "$fake_log"
grep -q -- '--profile local-release' "$fake_log"
grep -q '^build_result status=ok mode=optimized profile=local-release jobs=8 ' "$fixture/cool.out"

# A warm build must pause and resume the same Cargo process instead of being
# allowed to cross the hard cutoff or being restarted after cooling.
: >"$fake_log"
cooling_child_file="$fixture/cooling-child.pid"
export ELPIS_FAKE_CHILD_PID_FILE="$cooling_child_file"
printf '70000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
ELPIS_FAKE_CARGO_SLEEP=0.8 run_build dev >"$fixture/cooling.out" 2>"$fixture/cooling.err" &
cooling_build_pid=$!
for _ in $(seq 1 40); do
    [ -f "$cooling_child_file" ] && break
    sleep 0.025
done
cooling_child=$(sed -n '1p' "$cooling_child_file")
printf '76000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
for _ in $(seq 1 40); do
    grep -q '^thermal_pause ' "$fixture/cooling.err" && break
    sleep 0.025
done
assert_stopped "$cooling_child"
printf '66000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
wait "$cooling_build_pid"
test "$(grep -c '^jobs=' "$fake_log")" -eq 1
test "$(grep -c '^completed=1$' "$fake_log")" -eq 1
grep -q '^thermal_pause current_c=76.0 pause_count=1$' "$fixture/cooling.err"
grep -q '^thermal_resume current_c=66.0 pause_count=1 ' "$fixture/cooling.err"
grep -q 'build_result status=ok .*pause_count=1 cooling_ms=[1-9]' "$fixture/cooling.out"
unset ELPIS_FAKE_CHILD_PID_FILE

# Temperatures below the pause threshold do not hold a build.
: >"$fake_log"
printf '74000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
ELPIS_FAKE_CARGO_SLEEP=0.15 run_build dev >"$fixture/no-hold.out" 2>"$fixture/no-hold.err"
! grep -q '^thermal_pause ' "$fixture/no-hold.err"
grep -q 'build_result status=ok .*pause_count=0 cooling_ms=0' "$fixture/no-hold.out"

# A hard cutoff while paused keeps the whole owned group stopped, including a
# descendant, until cooling, then resumes without restarting Cargo.
: >"$fake_log"
child_pid_file="$fixture/hard-cutoff-child.pid"
export ELPIS_FAKE_CHILD_PID_FILE="$child_pid_file"
printf '70000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
(
    while [ ! -f "$child_pid_file" ]; do sleep 0.01; done
    printf '76000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
    sleep 0.2
    printf '80000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
    sleep 0.25
    printf '66000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
) &
hard_cutoff_sensor_pid=$!
set +e
ELPIS_FAKE_CARGO_SLEEP=5 run_build dev >"$fixture/hard-cutoff.out" 2>"$fixture/hard-cutoff.err" &
hard_cutoff_build_pid=$!
set -e
for _ in $(seq 1 40); do
    [ -f "$child_pid_file" ] && break
    sleep 0.025
done
hard_cutoff_child=$(sed -n '1p' "$child_pid_file")
for _ in $(seq 1 80); do
    grep -q '^thermal_limit_hold ' "$fixture/hard-cutoff.err" && break
    sleep 0.025
done
grep -q '^thermal_limit_hold ' "$fixture/hard-cutoff.err"
assert_stopped "$hard_cutoff_child"
wait "$hard_cutoff_sensor_pid"
set +e
wait "$hard_cutoff_build_pid"
hard_cutoff_status=$?
set -e
test "$hard_cutoff_status" -eq 0
assert_not_running "$hard_cutoff_child"
grep -q '^completed=1$' "$fake_log"
grep -q '^thermal_pause ' "$fixture/hard-cutoff.err"
grep -q '^thermal_limit_hold current_c=80.0 limit_c=80 pause_count=1$' "$fixture/hard-cutoff.err"
grep -q 'build_result status=ok .*limit_hold_count=1' "$fixture/hard-cutoff.out"

# Losing sensors while paused also resumes and cleans up the descendant.
: >"$fake_log"
child_pid_file="$fixture/lost-while-paused-child.pid"
export ELPIS_FAKE_CHILD_PID_FILE="$child_pid_file"
printf '70000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
ELPIS_FAKE_CARGO_SLEEP=5 run_build dev >"$fixture/lost-while-paused.out" 2>"$fixture/lost-while-paused.err" &
lost_paused_wrapper_pid=$!
set -e
for _ in $(seq 1 40); do
    [ -f "$child_pid_file" ] && break
    sleep 0.05
done
printf '76000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
for _ in $(seq 1 40); do
    grep -q '^thermal_pause ' "$fixture/lost-while-paused.err" && break
    sleep 0.05
done
grep -q '^thermal_pause ' "$fixture/lost-while-paused.err"
mv "$fixture/thermal/hwmon/hwmon0/temp1_input" "$fixture/lost-while-paused-temperature"
set +e
wait "$lost_paused_wrapper_pid"
lost_paused_status=$?
set -e
test "$lost_paused_status" -eq 75
lost_paused_child=$(sed -n '1p' "$child_pid_file")
assert_not_running "$lost_paused_child"
! grep -q '^completed=1$' "$fake_log"
printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
unset ELPIS_FAKE_CHILD_PID_FILE

# If Cargo's process-group leader dies while paused, keep monitoring the
# owned group and clean up any surviving worker after resuming it.
: >"$fake_log"
child_pid_file="$fixture/leader-exit-child.pid"
leader_pid_file="$fixture/leader-exit-leader.pid"
export ELPIS_FAKE_CHILD_PID_FILE="$child_pid_file" ELPIS_FAKE_LEADER_PID_FILE="$leader_pid_file"
printf '70000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
ELPIS_FAKE_CARGO_SLEEP=5 run_build dev >"$fixture/leader-exit.out" 2>"$fixture/leader-exit.err" &
leader_exit_wrapper_pid=$!
set -e
for _ in $(seq 1 40); do
    [ -f "$child_pid_file" ] && [ -f "$leader_pid_file" ] && break
    sleep 0.05
done
printf '76000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
for _ in $(seq 1 40); do
    grep -q '^thermal_pause ' "$fixture/leader-exit.err" && break
    sleep 0.05
done
grep -q '^thermal_pause ' "$fixture/leader-exit.err"
leader_exit_child=$(sed -n '1p' "$child_pid_file")
leader_exit_leader=$(sed -n '1p' "$leader_pid_file")
kill -KILL "$leader_exit_leader"
set +e
wait "$leader_exit_wrapper_pid"
leader_exit_status=$?
set -e
test "$leader_exit_status" -eq 75
assert_not_running "$leader_exit_child"
! grep -q '^completed=1$' "$fake_log"
grep -q 'build leader exited while process group remained' "$fixture/leader-exit.err"
printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
unset ELPIS_FAKE_CHILD_PID_FILE ELPIS_FAKE_LEADER_PID_FILE

# Cancellation while paused must resume the group before TERM, so neither the
# fake Cargo process nor its descendant is left behind.
: >"$fake_log"
child_pid_file="$fixture/cancel-child.pid"
export ELPIS_FAKE_CHILD_PID_FILE="$child_pid_file"
printf '70000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
env PATH="$fixture/bin:$PATH" ELPIS_FAKE_CARGO_LOG="$fake_log" \
    ELPIS_THERMAL_ROOT="$fixture/thermal" ELPIS_MAX_TEMP_C=80 \
    ELPIS_TEMP_POLL_SECONDS=0.05 ELPIS_FAKE_CARGO_SLEEP=5 \
    ELPIS_FAKE_CHILD_PID_FILE="$child_pid_file" "$build_script" dev \
    >"$fixture/cancel.out" 2>"$fixture/cancel.err" &
cancel_wrapper_pid=$!
set -e
for _ in $(seq 1 40); do
    [ -f "$child_pid_file" ] && break
    sleep 0.05
done
printf '76000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
for _ in $(seq 1 40); do
    grep -q '^thermal_pause ' "$fixture/cancel.err" && break
    sleep 0.05
done
grep -q '^thermal_pause ' "$fixture/cancel.err"
kill -TERM "$cancel_wrapper_pid"
set +e
wait "$cancel_wrapper_pid"
cancel_status=$?
set -e
test "$cancel_status" -eq 130
cancel_child=$(sed -n '1p' "$child_pid_file")
sleep 0.1
assert_not_running "$cancel_child"
! grep -q '^completed=1$' "$fake_log"
unset ELPIS_FAKE_CHILD_PID_FILE
printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"

grep -q '^\[profile.local-release\]$' "$manifest"
profile_block=$(sed -n '/^\[profile.local-release\]$/,/^\[profile\./p' "$manifest")
grep -q '^inherits = "release"$' <<<"$profile_block"
grep -q '^lto = false$' <<<"$profile_block"
grep -q '^opt-level = 1$' <<<"$profile_block"
grep -q '^codegen-units = 256$' <<<"$profile_block"
grep -q '^incremental = true$' <<<"$profile_block"
grep -q '^debug = "none"$' <<<"$profile_block"

: >"$fake_log"
run_build shipping >"$fixture/shipping.out"
grep -q -- 'argv=build --release --locked --offline -p codex-tui --bin elpis ' "$fake_log"
grep -q '^rustc_bootstrap=1$' "$fake_log"
grep -q 'rustflags=.*-Zthreads=8' "$fake_log"
grep -q 'rustflags=.*-Clinker-features=+lld' "$fake_log"

: >"$fake_log"
printf '80000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
run_build check >"$fixture/hot-before.out" 2>&1
hot_before_status=$?
set -e
test "$hot_before_status" -eq 75
test ! -s "$fake_log"
grep -q 'temperature limit reached before build' "$fixture/hot-before.out"

: >"$fake_log"
printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
(sleep 0.2; printf '80000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input") &
set +e
ELPIS_FAKE_CARGO_SLEEP=0.8 run_build dev >"$fixture/hot-during.out" 2>"$fixture/hot-during.err" &
hot_during_pid=$!
set -e
for _ in $(seq 1 40); do
    grep -q '^thermal_limit_hold ' "$fixture/hot-during.err" && break
    sleep 0.05
done
grep -q '^thermal_limit_hold ' "$fixture/hot-during.err"
! grep -q '^completed=1$' "$fake_log"
printf '66000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
wait "$hot_during_pid"
hot_during_status=$?
set -e
test "$hot_during_status" -eq 0
grep -q '^thermal_resume current_c=66.0 ' "$fixture/hot-during.err"
grep -q '^completed=1$' "$fake_log"
grep -q '^build_result status=ok .*limit_hold_count=1' "$fixture/hot-during.out"

printf '65000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
set +e
ELPIS_BUILD_JOBS=zero run_build check >"$fixture/invalid.out" 2>&1
invalid_status=$?
set -e
test "$invalid_status" -eq 2
grep -q 'ELPIS_BUILD_JOBS must be a positive integer' "$fixture/invalid.out"

failures=0
expect_equal() {
    local label=$1 actual=$2 expected=$3
    if [ "$actual" != "$expected" ]; then
        printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
        failures=$((failures + 1))
    fi
}

unset ELPIS_BUILD_JOBS ELPIS_RUSTC_THREADS
for mode in dev optimized shipping; do
    : >"$fake_log"
    run_build "$mode" >"$fixture/default-$mode.out"
    expect_equal "$mode default jobs" "$(sed -n 's/^jobs=//p' "$fake_log")" 4
    expect_equal "$mode stable compiler threads" "$(sed -n 's/.*-Zthreads=\([0-9]*\).*/\1/p' "$fake_log")" 8
done

: >"$fake_log"
run_build check >"$fixture/default-check.out"
expect_equal 'short check default jobs' "$(sed -n 's/^jobs=//p' "$fake_log")" 8

: >"$fake_log"
ELPIS_BUILD_JOBS=3 run_build optimized >"$fixture/explicit-jobs.out"
expect_equal 'explicit Cargo jobs' "$(sed -n 's/^jobs=//p' "$fake_log")" 3
expect_equal 'Cargo jobs do not change compiler fingerprint' "$(sed -n 's/.*-Zthreads=\([0-9]*\).*/\1/p' "$fake_log")" 8

: >"$fake_log"
set +e
ELPIS_MAX_TEMP_C=81 run_build check >"$fixture/above-cap.out" 2>&1
above_cap_status=$?
set -e
expect_equal 'temperature cap cannot exceed 80 C' "$above_cap_status" 2
expect_equal 'invalid cap never starts Cargo' "$(wc -c <"$fake_log")" 0

: >"$fake_log"
mv "$fixture/thermal/hwmon/hwmon0/temp1_input" "$fixture/saved-temperature"
set +e
run_build check >"$fixture/no-sensors.out" 2>&1
no_sensors_status=$?
set -e
expect_equal 'absent sensors refuse build' "$no_sensors_status" 75
expect_equal 'absent sensors never start Cargo' "$(wc -c <"$fake_log")" 0
mv "$fixture/saved-temperature" "$fixture/thermal/hwmon/hwmon0/temp1_input"

set +e
ELPIS_FAKE_LOSE_SENSOR=1 ELPIS_FAKE_CARGO_SLEEP=0.2 run_build dev >"$fixture/lost-sensors.out" 2>&1
lost_sensors_status=$?
set -e
expect_equal 'lost sensors stop running build' "$lost_sensors_status" 75
expect_equal 'lost sensors terminate Cargo before completion' "$(sed -n 's/^completed=//p' "$fake_log")" ''

printf '60000\n' >"$fixture/thermal/hwmon/hwmon0/temp1_input"
run_build optimized >"$fixture/safe.out"
# A match early in a large strings stream must not be hidden by producer SIGPIPE.
awk -v remap_from="${ELPIS_REMAP_PATH_FROM:-$HOME}" 'BEGIN {print remap_from "/path-leak"; for (i=0;i<100000;i++) print "padding"}' \
    >"$fixture/repo/codex-rs/target/local-release/elpis"
set +e
run_build optimized >"$fixture/path-leak.out" 2>&1
path_leak_status=$?
set -e
expect_equal 'binary path leak rejects artifact' "$path_leak_status" 1

if [ "$failures" -ne 0 ]; then
    printf '%s build-wrapper regression assertions failed\n' "$failures" >&2
    exit 1
fi
printf 'build-elpis-local tests passed\n'

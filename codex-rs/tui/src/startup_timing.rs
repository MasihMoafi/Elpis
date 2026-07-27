//! Startup timing for Elpis.
//!
//! The tracing subscriber is not installed until late in `run_main`, long after the
//! expensive launch work (config load, auth/keyring, state databases, provider probes)
//! has already happened. Anything measured with `tracing` alone therefore misses the
//! part of startup users actually wait for.
//!
//! This module records phase timings from the very first instruction in `main` into a
//! process-global buffer, then flushes the whole record once at the point the terminal
//! is ready. The total is also exposed to the session header so a user can see the
//! launch cost without opening a log file.

use std::path::Path;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

/// Set once, from the first line of `main`, before argument parsing.
static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Time the kernel and dynamic loader spent before `main` ran at all: process creation,
/// mapping the executable, and relocation. For a large binary on a cold page cache this
/// can dominate everything measured after it, and a timer started in `main` cannot see
/// it. `None` on platforms without `/proc`.
static PRE_MAIN: OnceLock<Option<Duration>> = OnceLock::new();

/// Phase name paired with the elapsed time since `PROCESS_START` when it completed.
static PHASES: Mutex<Vec<(&'static str, Duration)>> = Mutex::new(Vec::new());

/// Total launch duration, published once the terminal is ready.
static TOTAL: OnceLock<Duration> = OnceLock::new();

/// Record the process start instant. Safe to call more than once; the first call wins.
pub fn mark_process_start() {
    let _ = PRE_MAIN.set(time_before_main());
    let _ = PROCESS_START.set(Instant::now());
}

/// Elapsed time between the kernel creating this process and `main` starting.
pub fn pre_main() -> Option<Duration> {
    PRE_MAIN.get().copied().flatten()
}

/// Extract the `starttime` field from the contents of `/proc/self/stat`.
///
/// The second field is the executable name in parentheses and may itself contain spaces
/// and parentheses, so fields are counted from after the final `)`.
fn parse_starttime_ticks(stat: &str) -> Option<f64> {
    let after_comm = stat.rsplit_once(')')?.1;
    // Fields resume at `state` (field 3), so `starttime` (field 22) is index 19 here.
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn time_before_main() -> Option<Duration> {
    // Near-universal on Linux; `getconf CLK_TCK` has been 100 on every supported target.
    const CLOCK_TICKS_PER_SEC: f64 = 100.0;
    let starttime_ticks = parse_starttime_ticks(&std::fs::read_to_string("/proc/self/stat").ok()?)?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime_secs: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    let elapsed = uptime_secs - (starttime_ticks / CLOCK_TICKS_PER_SEC);
    // Reject anything implausible rather than reporting a nonsense launch time.
    (elapsed.is_finite() && (0.0..60.0).contains(&elapsed)).then(|| Duration::from_secs_f64(elapsed))
}

#[cfg(not(target_os = "linux"))]
fn time_before_main() -> Option<Duration> {
    None
}

/// Time since process start, or `None` when `mark_process_start` was never called
/// (unit tests and any embedder that links the library directly).
pub fn since_start() -> Option<Duration> {
    PROCESS_START.get().map(Instant::elapsed)
}

/// Mark the completion of a named startup phase.
pub fn record(phase: &'static str) {
    let Some(elapsed) = since_start() else {
        return;
    };
    if let Ok(mut phases) = PHASES.lock() {
        phases.push((phase, elapsed));
    }
}

/// Total launch duration once known. `None` before the terminal is ready, which is what
/// keeps the timing line out of test snapshots.
pub fn total() -> Option<Duration> {
    TOTAL.get().copied()
}

/// Human-readable launch duration for the session header, e.g. `1.24s` or `840ms`.
pub fn total_display() -> Option<String> {
    total().map(format_duration)
}

fn format_duration(duration: Duration) -> String {
    let millis = duration.as_millis();
    if millis >= 1000 {
        format!("{:.2}s", duration.as_secs_f64())
    } else {
        format!("{millis}ms")
    }
}

/// Publish the total and append one JSON record per launch under
/// `<elpis_home>/logs/startup/`. Timing must never be able to fail a launch, so every
/// error here is discarded.
pub fn finish_and_log(elpis_home: &Path) {
    let Some(in_main) = since_start() else {
        return;
    };
    // What a user actually waits through: pressing enter to a usable Elpis.
    let total = in_main + pre_main().unwrap_or_default();
    let _ = TOTAL.set(total);

    let phases = match PHASES.lock() {
        Ok(phases) => phases.clone(),
        Err(_) => return,
    };

    let dir = elpis_home.join("logs").join("startup");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let mut record = String::from("{\"total_ms\":");
    record.push_str(&total.as_millis().to_string());
    record.push_str(",\"build\":\"");
    record.push_str(build_profile());
    record.push_str("\",\"before_main_ms\":");
    record.push_str(
        &pre_main()
            .map(|pre| pre.as_millis().to_string())
            .unwrap_or_else(|| "null".to_string()),
    );
    record.push_str(",\"in_main_ms\":");
    record.push_str(&in_main.as_millis().to_string());
    record.push_str(",\"version\":\"");
    record.push_str(env!("CARGO_PKG_VERSION"));
    record.push_str("\",\"phases\":{");
    for (index, (phase, elapsed)) in phases.iter().enumerate() {
        if index > 0 {
            record.push(',');
        }
        record.push('"');
        record.push_str(phase);
        record.push_str("\":");
        record.push_str(&elapsed.as_millis().to_string());
    }
    record.push_str("}}\n");

    let path = dir.join("startup.jsonl");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = file.write_all(record.as_bytes());
    }
}

/// Which build profile is running. Debug builds are far slower to start, so a timing
/// record without this label invites comparing numbers that are not comparable.
pub fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// True when this is an unoptimized build. Surfaced in the session header so a debug
/// binary can never be mistaken for a release one.
pub fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_below_a_second_render_as_milliseconds() {
        assert_eq!(format_duration(Duration::from_millis(840)), "840ms");
    }

    #[test]
    fn durations_of_a_second_or_more_render_as_seconds() {
        assert_eq!(format_duration(Duration::from_millis(1240)), "1.24s");
    }

    #[test]
    fn starttime_is_read_past_an_executable_name_containing_spaces() {
        let stat = "42 (my app (x)) S 1 42 42 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 987654 0";
        assert_eq!(parse_starttime_ticks(stat), Some(987654.0));
    }

    #[test]
    fn malformed_stat_yields_no_starttime_rather_than_a_wrong_one() {
        assert_eq!(parse_starttime_ticks("nonsense without parens"), None);
    }

    #[test]
    fn total_is_absent_until_a_launch_publishes_it() {
        // Unit tests never call `finish_and_log`, so the session header must not try to
        // render a timing line during snapshot tests.
        assert!(total().is_none());
    }
}

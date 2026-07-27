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

/// Phase name paired with the elapsed time since `PROCESS_START` when it completed.
static PHASES: Mutex<Vec<(&'static str, Duration)>> = Mutex::new(Vec::new());

/// Total launch duration, published once the terminal is ready.
static TOTAL: OnceLock<Duration> = OnceLock::new();

/// Record the process start instant. Safe to call more than once; the first call wins.
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
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
    let Some(total) = since_start() else {
        return;
    };
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
    record.push_str("\",\"version\":\"");
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
    fn total_is_absent_until_a_launch_publishes_it() {
        // Unit tests never call `finish_and_log`, so the session header must not try to
        // render a timing line during snapshot tests.
        assert!(total().is_none());
    }
}

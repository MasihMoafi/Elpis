//! Elpis: glibc keeps memory freed by worker threads inside its per-thread malloc arenas
//! (up to eight per core) and returns only the top of each one, so an idle engine kept about
//! 1.5 GB of them. A background thread hands their free pages back to the OS once a minute.

use std::sync::Once;
use std::time::Duration;

const TRIM_INTERVAL: Duration = Duration::from_secs(60);

pub(crate) fn start() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let spawned = std::thread::Builder::new()
            .name("malloc-trim".into())
            .spawn(trim_forever);
        if let Err(err) = spawned {
            tracing::warn!("failed to start the malloc trim thread: {err}");
        }
    });
}

fn trim_forever() {
    loop {
        std::thread::sleep(TRIM_INTERVAL);
        // SAFETY: malloc_trim takes each arena's own lock and releases only free pages.
        unsafe { libc::malloc_trim(0) };
    }
}

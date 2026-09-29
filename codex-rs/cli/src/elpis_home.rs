// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Elpis: the binary's home directory.
//!
//! Elpis keeps its state in its own home, never in Codex's. The home is
//! `ELPIS_HOME` when set (absolute, or relative to the current directory), and
//! `~/<ELPIS_HOME_DIR_NAME>` otherwise. An inherited `CODEX_HOME` is ignored.

use std::path::Path;
use std::path::PathBuf;

/// The default home directory name. The trial build lives beside the installed
/// v0.3.0 (`~/.elpis`) until the cutover swaps the directories.
const ELPIS_HOME_DIR_NAME: &str = ".elpis-next";

fn resolve_elpis_home() -> anyhow::Result<PathBuf> {
    let path = match std::env::var_os("ELPIS_HOME").filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("could not determine the home directory"))?
            .join(ELPIS_HOME_DIR_NAME),
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    std::fs::create_dir_all(&path)?;
    Ok(path.canonicalize()?)
}

/// Points every Codex home lookup at the Elpis home. Must run first in `main`.
pub(crate) fn prepare_elpis_environment() -> anyhow::Result<PathBuf> {
    let elpis_home = resolve_elpis_home()?;
    // This runs before arg0 dispatch creates a Tokio runtime or any threads.
    unsafe {
        // Exported so arg0 helper re-execs and nested elpis resolve the same home.
        std::env::set_var("ELPIS_HOME", &elpis_home);
        std::env::set_var("CODEX_HOME", &elpis_home);
        std::env::remove_var("CODEX_SQLITE_HOME");
        std::env::remove_var("CODEX_TUI_SESSION_LOG_PATH");
    }
    Ok(elpis_home)
}

/// v0.3.0's migration 41. The vendored upstream numbers a different migration
/// 41, so its state runtime cannot open a v0.3.0 state DB: it logs one warning
/// and then runs without any state at all.
const V030_MIGRATION_41: &str = "work graphs";

/// Refuses to run in a home that holds a v0.3.0 state DB.
pub(crate) async fn refuse_v030_state_db(elpis_home: &Path) -> anyhow::Result<()> {
    let state_db = elpis_home.join("state_5.sqlite");
    if !state_db.is_file() {
        return Ok(());
    }
    let sqlite = codex_state::SqliteConfig::from_sqlite_home(
        codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(elpis_home)?,
    );
    // Only a positive identification refuses; any other DB problem is left to
    // the state runtime's own recovery.
    let Ok(pool) = sqlite
        .open_read_only_pool(&state_db, /*busy_timeout*/ None)
        .await
    else {
        return Ok(());
    };
    let migration_41: Option<String> =
        sqlx::query_scalar("SELECT description FROM _sqlx_migrations WHERE version = 41")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
    pool.close().await;
    if migration_41.as_deref() == Some(V030_MIGRATION_41) {
        anyhow::bail!(
            "{} holds an Elpis v0.3.0 state database, which this build cannot read.\n\
             Run this build with another home (set ELPIS_HOME), or keep using v0.3.0 here.",
            elpis_home.display()
        );
    }
    Ok(())
}

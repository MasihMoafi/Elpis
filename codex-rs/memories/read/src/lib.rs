// Modified from OpenAI Codex (Apache-2.0) by the Elpis project.
//! Read-path helpers for Codex memories.
//!
//! This crate owns memory injection, memory citation parsing, and telemetry
//! classification for read access to the memory folder. It intentionally does
//! not depend on the memory write pipeline.

pub mod citations;
mod metrics;
pub mod usage;

use codex_utils_absolute_path::AbsolutePathBuf;

pub fn memory_root(
    memory_root: Option<&AbsolutePathBuf>,
    codex_home: &AbsolutePathBuf,
) -> AbsolutePathBuf {
    memory_root
        .cloned()
        .unwrap_or_else(|| codex_home.join("memories"))
}

//! Elpis product names for titles the TUI draws.
//!
//! Copied from Elpis v0.3.0 `branding.rs` (tag `stage0-stop-bleeding`), names only. The
//! runtime-identity status line there was never visible (v0.3.0 forced the footer status
//! line off) and is not carried.

pub(crate) const PRODUCT_NAME: &str = "Elpis";
pub(crate) const CODEX_RUNTIME_TITLE: &str = "Elpis";

/// The Elpis release, as `elpis --version` prints it. The vendored crates keep Codex's
/// version (0.158.0) because the model catalog keys on it.
pub(crate) const ELPIS_VERSION: &str = "0.4.1-dev";

/// The version a title shows: the Elpis release in place of the vendored Codex version.
pub(crate) fn title_version(version: &'static str) -> &'static str {
    if version == crate::version::CODEX_CLI_VERSION {
        ELPIS_VERSION
    } else {
        version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_show_the_elpis_release_the_cli_reports() {
        let cli_manifest = include_str!("../../cli/Cargo.toml");
        assert!(
            cli_manifest.contains(&format!("version = \"{ELPIS_VERSION}\"")),
            "ELPIS_VERSION must match codex-rs/cli/Cargo.toml"
        );
        assert_eq!(
            title_version(crate::version::CODEX_CLI_VERSION),
            ELPIS_VERSION
        );
        assert_eq!(title_version("test"), "test");
    }
}
